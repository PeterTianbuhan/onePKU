//! Local HLS playback: an opaque loopback URL serves authorized, persistent
//! segments. The player never receives school cookies, signed URLs, or keys.
use crate::platform::PrivateOpenOptions;
use super::*;
use pku_course::api::{CourseApi, PlaybackMedia};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

const MAX_PART: u64 = 32 * 1024 * 1024;
const MAX_VIDEO: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct PlaybackStore {
    port: Option<u16>,
    sessions: HashMap<String, Arc<Session>>,
}
#[derive(Clone, Serialize, Deserialize)]
struct PartMeta {
    duration: f64,
    discontinuity: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    course: String,
    video: String,
    title: String,
    signature: String,
    parts: Vec<PartMeta>,
}
struct Progress {
    sizes: Vec<u64>,
    error: String,
}
pub(crate) struct Session {
    pub(crate) generation: String,
    pub(crate) subtitle_account: String,
    directory: PathBuf,
    manifest: Manifest,
    remote: Option<(CourseApi, PlaybackMedia)>,
    progress: Mutex<Progress>,
    locks: Vec<tokio::sync::Mutex<()>>,
    focus: AtomicUsize,
    closed: AtomicBool,
    downloading: AtomicBool,
    worker: AtomicBool,
    pub(crate) subtitle_active: AtomicBool,
}
fn cache_dir(generation: &str, course: &str, video: &str) -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位回放缓存"))?
        .cache_dir()
        .join("playback-v1")
        .join(generation)
        .join(format!("{:x}", Sha256::digest(format!("{course}|{video}")))))
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("{:016x}.part", rand::random::<u64>()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .private_mode()
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
fn part_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("{index:05}.ts"))
}
fn saved_manifest(directory: &Path, course: &str, video: &str) -> Option<Manifest> {
    let path = directory.join("manifest.json");
    if path.is_symlink() || fs::metadata(&path).ok()?.len() > 2 * 1024 * 1024 {
        return None;
    }
    let m: Manifest = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (m.version == 1
        && m.course == course
        && m.video == video
        && !m.parts.is_empty()
        && m.parts.len() <= 10000
        && m.parts
            .iter()
            .all(|p| p.duration.is_finite() && p.duration > 0.0 && p.duration <= 3600.0))
    .then_some(m)
}
fn cache_sizes(directory: &Path, count: usize) -> Vec<u64> {
    (0..count)
        .map(|i| {
            let path = part_path(directory, i);
            if path.is_symlink() {
                return 0;
            }
            fs::metadata(path)
                .ok()
                .filter(|m| m.is_file() && m.len() > 0 && m.len() <= MAX_PART)
                .map_or(0, |m| m.len())
        })
        .collect()
}
fn playlist(manifest: &Manifest) -> String {
    let target = manifest
        .parts
        .iter()
        .map(|p| p.duration.ceil() as u64)
        .max()
        .unwrap_or(1);
    let mut out = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n");
    for (i, p) in manifest.parts.iter().enumerate() {
        if p.discontinuity {
            out.push_str("#EXT-X-DISCONTINUITY\n");
        }
        out.push_str(&format!("#EXTINF:{:.6},\n{i}.ts\n", p.duration));
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}
impl Session {
    pub(crate) fn subtitle_identity(&self) -> (&str, &str, &str) {
        (
            &self.manifest.course,
            &self.manifest.video,
            &self.manifest.signature,
        )
    }
    pub(crate) fn duration(&self) -> f64 {
        self.manifest.parts.iter().map(|p| p.duration).sum()
    }
    /// Fetch only the HLS parts overlapping a recognition window. The returned
    /// origin is on the original recording timeline, including discontinuities.
    pub(crate) async fn subtitle_media_range(
        &self,
        directory: &Path,
        start: f64,
        end: f64,
        cancelled: &AtomicBool,
    ) -> Result<(PathBuf, f64)> {
        let mut origin = 0.0;
        let mut first = None;
        let mut parts = Vec::new();
        for (index, part) in self.manifest.parts.iter().enumerate() {
            let stop = origin + part.duration;
            if origin < end && stop > start {
                if cancelled.load(Ordering::Relaxed) {
                    bail!("已停止生成，已完成的字幕已保存");
                }
                first.get_or_insert(origin);
                let bytes = self.part(index).await?;
                write_private(&directory.join(format!("{}.ts", parts.len())), &bytes)?;
                parts.push(part.clone());
            }
            origin = stop;
            if origin >= end {
                break;
            }
        }
        let first = first.ok_or_else(|| anyhow!("字幕片段超出回放范围"))?;
        let manifest = Manifest {
            parts,
            ..self.manifest.clone()
        };
        let path = directory.join("audio-source.m3u8");
        write_private(&path, playlist(&manifest).as_bytes())?;
        Ok((path, first))
    }
    fn valid(&self) -> bool {
        (!self.closed.load(Ordering::Relaxed) || self.subtitle_active.load(Ordering::Relaxed))
            && self.generation == fingerprint("course")
    }
    fn status(&self) -> Value {
        let p = self.progress.lock().unwrap();
        let completed = p.sizes.iter().filter(|n| **n > 0).count();
        json!({"completed":completed,"segments":p.sizes.len(),"bytes":p.sizes.iter().sum::<u64>(),
            "complete":completed==p.sizes.len(),"downloading":self.downloading.load(Ordering::Relaxed),
            "message":p.error,"offline":self.remote.is_none()})
    }
    async fn part(&self, index: usize) -> Result<Vec<u8>> {
        let _lock = self
            .locks
            .get(index)
            .ok_or_else(|| anyhow!("invalid segment"))?
            .lock()
            .await;
        if !self.valid() {
            bail!("播放会话已关闭，请重新打开回放");
        }
        let path = part_path(&self.directory, index);
        if !path.is_symlink() {
            if let Ok(bytes) = fs::read(&path) {
                if !bytes.is_empty() && bytes.len() as u64 <= MAX_PART {
                    self.progress.lock().unwrap().sizes[index] = bytes.len() as u64;
                    return Ok(bytes);
                }
            }
        }
        let (api, media) = self
            .remote
            .as_ref()
            .ok_or_else(|| anyhow!("这个片段尚未缓存，请联网后重试"))?;
        let mut bytes = None;
        for attempt in 0..3 {
            if !self.valid() {
                bail!("播放已关闭");
            }
            match api.playback_part(&media.parts[index]).await {
                Ok(value) => {
                    bytes = Some(value);
                    break;
                }
                Err(_) if attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await
                }
                Err(_) => {}
            }
        }
        let bytes =
            bytes.ok_or_else(|| anyhow!("网络暂时中断，已下载的片段仍可播放；可重试连接"))?;
        let mut progress = self.progress.lock().unwrap();
        if !self.valid() {
            bail!("播放已关闭");
        }
        if progress.sizes.iter().sum::<u64>() + bytes.len() as u64 > MAX_VIDEO {
            bail!("本节回放缓存已达 8 GB");
        }
        write_private(&path, &bytes)?;
        progress.sizes[index] = bytes.len() as u64;
        progress.error.clear();
        Ok(bytes)
    }
    fn start_download(self: &Arc<Self>) {
        self.downloading.store(true, Ordering::Relaxed);
        if self.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let session = self.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                while session.valid() {
                    if !session.downloading.load(Ordering::Relaxed) {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                    let next = {
                        let p = session.progress.lock().unwrap();
                        let focus = session.focus.load(Ordering::Relaxed).min(p.sizes.len() - 1);
                        (focus..p.sizes.len())
                            .chain(0..focus)
                            .find(|i| p.sizes[*i] == 0)
                    };
                    let Some(index) = next else {
                        break;
                    };
                    if let Err(error) = session.part(index).await {
                        session.progress.lock().unwrap().error = if session.valid() {
                            error.to_string()
                        } else {
                            "".into()
                        };
                        session.downloading.store(false, Ordering::Relaxed);
                    }
                }
            });
            session.downloading.store(false, Ordering::Relaxed);
            session.worker.store(false, Ordering::SeqCst);
        });
    }
}

fn allowed_origin(origin: Option<&str>) -> bool {
    origin.is_none_or(|o| {
        matches!(
            o,
            "tauri://localhost"
                | "http://tauri.localhost"
                | "http://127.0.0.1:1421"
                | "http://127.0.0.1:1420"
        )
    })
}
fn byte_range(value: &str, length: usize) -> Option<(usize, usize)> {
    let (a, b) = value.strip_prefix("bytes=")?.split_once('-')?;
    if length == 0 || b.contains(',') {
        return None;
    }
    if a.is_empty() {
        let size = b.parse::<usize>().ok()?;
        return (size > 0).then_some((length.saturating_sub(size), length - 1));
    }
    let start = a.parse::<usize>().ok()?;
    let end = if b.is_empty() {
        length - 1
    } else {
        b.parse::<usize>().ok()?.min(length - 1)
    };
    (start <= end && start < length).then_some((start, end))
}
fn serve(core: &Core, req: &tiny_http::Request, port: u16) -> Result<(Vec<u8>, &'static str)> {
    let header = |name: &str| {
        req.headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    };
    if header("host") != Some(format!("127.0.0.1:{port}").as_str())
        || !allowed_origin(header("origin"))
    {
        bail!("forbidden");
    }
    let fields = req
        .url()
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if fields.len() != 3 || fields[0] != "media" {
        bail!("invalid resource");
    }
    let session = core
        .playback
        .lock()
        .unwrap()
        .sessions
        .get(fields[1])
        .cloned()
        .ok_or_else(|| anyhow!("invalid session"))?;
    if !session.valid() {
        bail!("closed session");
    }
    if fields[2] == "index.m3u8" {
        return Ok((
            playlist(&session.manifest).into_bytes(),
            "application/vnd.apple.mpegurl",
        ));
    }
    let index = fields[2]
        .strip_suffix(".ts")
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|i| *i < session.manifest.parts.len())
        .ok_or_else(|| anyhow!("invalid segment"))?;
    session.focus.store(index, Ordering::Relaxed);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let bytes = runtime.block_on(session.part(index))?;
    Ok((bytes, "video/mp2t"))
}
impl Core {
    fn playback_port(self: &Arc<Self>) -> Result<u16> {
        let mut store = self.playback.lock().unwrap();
        if let Some(port) = store.port {
            return Ok(port);
        }
        let server =
            tiny_http::Server::http("127.0.0.1:0").map_err(|_| anyhow!("无法启动本地播放器"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| anyhow!("本地播放器地址无效"))?
            .port();
        let weak = Arc::downgrade(self);
        let pending = Arc::new(AtomicUsize::new(0));
        std::thread::spawn(move || loop {
            let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(1)) else {
                if weak.strong_count() == 0 {
                    break;
                }
                continue;
            };
            let Some(core) = weak.upgrade() else {
                break;
            };
            if pending.fetch_add(1, Ordering::SeqCst) >= 12 {
                pending.fetch_sub(1, Ordering::SeqCst);
                let _ = req.respond(tiny_http::Response::empty(503));
                continue;
            }
            let pending = pending.clone();
            std::thread::spawn(move || {
                let header = |name: &str| {
                    req.headers()
                        .iter()
                        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
                        .map(|h| h.value.as_str().to_string())
                };
                let origin = header("origin");
                let method = req.method().as_str();
                let mut response = if !matches!(method, "GET" | "HEAD") {
                    tiny_http::Response::from_data(vec![]).with_status_code(405)
                } else {
                    match serve(&core, &req, port) {
                        Ok((bytes, mime)) => {
                            let length = bytes.len();
                            let mut response = if let Some(range) = header("range") {
                                if let Some((start, end)) = byte_range(&range, length) {
                                    tiny_http::Response::from_data(if method == "HEAD" {
                                        vec![]
                                    } else {
                                        bytes[start..=end].to_vec()
                                    })
                                    .with_status_code(206)
                                    .with_header(
                                        tiny_http::Header::from_bytes(
                                            "Content-Range",
                                            format!("bytes {start}-{end}/{length}"),
                                        )
                                        .unwrap(),
                                    )
                                } else {
                                    tiny_http::Response::from_data(vec![]).with_status_code(416)
                                }
                            } else {
                                tiny_http::Response::from_data(if method == "HEAD" {
                                    vec![]
                                } else {
                                    bytes
                                })
                            };
                            response.add_header(
                                tiny_http::Header::from_bytes("Content-Type", mime).unwrap(),
                            );
                            response.add_header(
                                tiny_http::Header::from_bytes("Accept-Ranges", "bytes").unwrap(),
                            );
                            response
                        }
                        Err(_) => tiny_http::Response::from_data(
                            b"Playback temporarily unavailable".to_vec(),
                        )
                        .with_status_code(503),
                    }
                };
                if let Some(origin) = origin.filter(|o| allowed_origin(Some(o))) {
                    response.add_header(
                        tiny_http::Header::from_bytes("Access-Control-Allow-Origin", origin)
                            .unwrap(),
                    );
                }
                response.add_header(
                    tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap(),
                );
                response.add_header(
                    tiny_http::Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap(),
                );
                let _ = req.respond(response);
                pending.fetch_sub(1, Ordering::SeqCst);
            });
        });
        store.port = Some(port);
        Ok(port)
    }
    pub(crate) async fn playback_prepare(
        self: &Arc<Self>,
        course: &str,
        video_id: &str,
        refresh: bool,
    ) -> Result<Value> {
        let _prepare = self.playback_prepare_lock.lock().await;
        valid_id(course)?;
        valid_id(video_id)?;
        let generation = fingerprint("course");
        if Store::new("course")?.load_session()?.is_none() {
            bail!("未登录教学网");
        }
        let port = self.playback_port()?;
        if !refresh {
            let store = self.playback.lock().unwrap();
            if let Some((token, s)) = store.sessions.iter().find(|(_, s)| {
                s.valid() && s.manifest.course == course && s.manifest.video == video_id
            }) {
                return Ok(
                    json!({"id":token,"url":format!("http://127.0.0.1:{port}/media/{token}/index.m3u8"),"title":s.manifest.title,
                    "duration":s.manifest.parts.iter().map(|p|p.duration).sum::<f64>(),"status":s.status()}),
                );
            }
        }
        // Identity lookup failure must not prevent cached video playback. Retry on next open.
        let subtitle_account = self
            .subtitle_account(&generation)
            .await
            .unwrap_or_else(|_| generation.clone());
        let directory = cache_dir(&generation, course, video_id)?;
        let saved = saved_manifest(&directory, course, video_id);
        let complete = saved.as_ref().is_some_and(|m| {
            cache_sizes(&directory, m.parts.len())
                .iter()
                .all(|n| *n > 0)
        });
        let mut remote = None;
        let manifest = if complete && !refresh {
            saved.clone().unwrap()
        } else {
            let resolved = async {
                let api = self.course_api()?;
                let c = self.find_course(course).await?;
                let video = api
                    .list_videos(course, c["name"].as_str().unwrap_or("课程"))
                    .await?
                    .into_iter()
                    .find(|v| v.hash_id == video_id)
                    .ok_or_else(|| anyhow!("回放已变化，请刷新课程列表"))?;
                let media = api.playback_media(&video).await?;
                let signature = format!(
                    "{:x}",
                    Sha256::digest(
                        media
                            .parts
                            .iter()
                            .map(|p| format!("{}|{}|{}", p.url.path(), p.duration, p.discontinuity))
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                );
                let manifest = Manifest {
                    version: 1,
                    course: course.into(),
                    video: video_id.into(),
                    title: format!("{} · {}", video.title, video.time),
                    signature,
                    parts: media
                        .parts
                        .iter()
                        .map(|p| PartMeta {
                            duration: p.duration,
                            discontinuity: p.discontinuity,
                        })
                        .collect(),
                };
                Ok::<_, anyhow::Error>((api, media, manifest))
            }
            .await;
            match resolved {
                Ok((api, media, manifest)) => {
                    remote = Some((api, media));
                    manifest
                }
                Err(error) => match saved.clone() {
                    Some(m)
                        if cache_sizes(&directory, m.parts.len())
                            .iter()
                            .any(|n| *n > 0) =>
                    {
                        m
                    }
                    _ => return Err(error),
                },
            }
        };
        if generation != fingerprint("course") {
            bail!("账号已更新，请重试");
        }
        {
            let store = self.playback.lock().unwrap();
            for old in store
                .sessions
                .values()
                .filter(|s| s.manifest.course == course && s.manifest.video == video_id)
            {
                old.closed.store(true, Ordering::Relaxed);
                let _disk = old.progress.lock().unwrap();
            }
        }
        if saved
            .as_ref()
            .is_some_and(|m| m.signature != manifest.signature)
        {
            let _claim = self.ensure_subtitle_key_idle(&subtitle_account, course, video_id)?;
            if directory.is_symlink() {
                bail!("回放缓存目录无效");
            }
            fs::remove_dir_all(&directory)?;
        }
        fs::create_dir_all(&directory)?;
        platform::private_directory(&directory)?;
        write_private(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
        let session = Arc::new(Session {
            generation,
            subtitle_account,
            directory: directory.clone(),
            remote,
            progress: Mutex::new(Progress {
                sizes: cache_sizes(&directory, manifest.parts.len()),
                error: String::new(),
            }),
            locks: (0..manifest.parts.len())
                .map(|_| tokio::sync::Mutex::new(()))
                .collect(),
            manifest,
            focus: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
            worker: AtomicBool::new(false),
            subtitle_active: AtomicBool::new(false),
        });
        let token = format!("{:032x}", rand::random::<u128>());
        let out = json!({"id":token,"url":format!("http://127.0.0.1:{port}/media/{token}/index.m3u8"),"title":session.manifest.title,
            "duration":session.manifest.parts.iter().map(|p|p.duration).sum::<f64>(),"status":session.status()});
        {
            let mut store = self.playback.lock().unwrap();
            for old in store
                .sessions
                .values()
                .filter(|s| s.manifest.course == course && s.manifest.video == video_id)
            {
                old.closed.store(true, Ordering::Relaxed);
            }
            store.sessions.retain(|_, s| s.valid());
            if store.sessions.len() >= 8 {
                bail!("播放窗口过多，请关闭后再试");
            }
            store.sessions.insert(token, session);
        }
        Ok(out)
    }
    pub(crate) fn subtitle_session(&self, id: &str) -> Result<Arc<Session>> {
        self.playback
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .filter(|s| s.valid())
            .cloned()
            .ok_or_else(|| anyhow!("播放会话已关闭，请重新打开回放"))
    }
    pub(crate) fn playback_status(&self, id: &str) -> Result<Value> {
        let store = self.playback.lock().unwrap();
        let s = store
            .sessions
            .get(id)
            .filter(|s| s.valid())
            .ok_or_else(|| anyhow!("播放会话已关闭"))?;
        Ok(s.status())
    }
    pub(crate) fn playback_control(&self, id: &str, downloading: bool) -> Result<Value> {
        let store = self.playback.lock().unwrap();
        let s = store
            .sessions
            .get(id)
            .filter(|s| s.valid())
            .ok_or_else(|| anyhow!("播放会话已关闭"))?;
        if downloading {
            s.start_download();
        } else {
            s.downloading.store(false, Ordering::Relaxed);
        }
        Ok(s.status())
    }
    pub(crate) fn playback_close(&self, id: &str, clear: bool) -> Result<Value> {
        let _claim = if clear {
            let session = self.subtitle_session(id)?;
            Some(self.ensure_subtitle_idle(&session)?)
        } else {
            None
        };
        let mut store = self.playback.lock().unwrap();
        if let Some(s) = store.sessions.remove(id) {
            s.closed.store(true, Ordering::Relaxed);
            s.downloading.store(false, Ordering::Relaxed);
            let _disk = s.progress.lock().unwrap();
            if clear && s.directory.is_dir() && !s.directory.is_symlink() {
                fs::remove_dir_all(&s.directory)?;
            }
        }
        Ok(json!({"closed":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cached_playback_survives_an_unavailable_source_and_rejects_other_origins() {
        let directory = tempfile::tempdir().unwrap();
        write_private(&part_path(directory.path(), 0), b"cached-video").unwrap();
        let core = Arc::new(Core::default());
        let port = core.playback_port().unwrap();
        let session = Arc::new(Session {
            generation: fingerprint("course"),
            subtitle_account: "test-account".into(),
            directory: directory.path().into(),
            remote: None,
            manifest: Manifest {
                version: 1,
                course: "test".into(),
                video: "lecture".into(),
                title: "Lecture".into(),
                signature: "fixture".into(),
                parts: vec![
                    PartMeta {
                        duration: 10.0,
                        discontinuity: false,
                    },
                    PartMeta {
                        duration: 10.0,
                        discontinuity: false,
                    },
                ],
            },
            progress: Mutex::new(Progress {
                sizes: vec![0, 0],
                error: String::new(),
            }),
            locks: vec![tokio::sync::Mutex::new(()), tokio::sync::Mutex::new(())],
            focus: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
            worker: AtomicBool::new(false),
            subtitle_active: AtomicBool::new(false),
        });
        core.playback
            .lock()
            .unwrap()
            .sessions
            .insert("test-token".into(), session.clone());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let root = format!("http://127.0.0.1:{port}/media/test-token");
        let hit = client
            .get(format!("{root}/0.ts"))
            .header("Origin", "http://127.0.0.1:1421")
            .header("Range", "bytes=0-5")
            .send()
            .await
            .unwrap();
        assert_eq!(hit.status(), 206);
        assert_eq!(hit.headers()["Content-Range"], "bytes 0-5/12");
        assert_eq!(hit.bytes().await.unwrap().as_ref(), b"cached");
        assert_eq!(core.playback_status("test-token").unwrap()["completed"], 1);
        assert_eq!(
            client
                .get(format!("{root}/1.ts"))
                .send()
                .await
                .unwrap()
                .status(),
            503
        );
        assert_eq!(
            client
                .get(format!("{root}/0.ts"))
                .header("Origin", "https://evil.test")
                .send()
                .await
                .unwrap()
                .status(),
            503
        );
        assert_eq!(
            client
                .get(format!("{root}/0.ts"))
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
                .as_ref(),
            b"cached-video"
        );
        let slice = tempfile::tempdir().unwrap();
        let (list, origin) = session
            .subtitle_media_range(slice.path(), 2.0, 8.0, &AtomicBool::new(false))
            .await
            .unwrap();
        assert_eq!(origin, 0.0);
        assert_eq!(
            fs::read(slice.path().join("0.ts")).unwrap(),
            b"cached-video"
        );
        assert!(!slice.path().join("1.ts").exists());
        assert_eq!(
            fs::read_to_string(list).unwrap().matches("#EXTINF").count(),
            1
        );
        session.subtitle_active.store(true, Ordering::Relaxed);
        core.playback_close("test-token", false).unwrap();
        assert_eq!(session.part(0).await.unwrap(), b"cached-video");
        session.subtitle_active.store(false, Ordering::Relaxed);
        assert!(session.part(0).await.is_err());
        assert_eq!(
            client
                .get(format!("{root}/0.ts"))
                .send()
                .await
                .unwrap()
                .status(),
            503
        );
        assert!(part_path(directory.path(), 0).exists());
    }
    #[test]
    fn ranges_and_origins_are_bounded() {
        assert_eq!(byte_range("bytes=0-1", 10), Some((0, 1)));
        assert_eq!(byte_range("bytes=3-", 10), Some((3, 9)));
        assert_eq!(byte_range("bytes=-4", 10), Some((6, 9)));
        for r in ["bytes=10-20", "bytes=0-1,4-5", "bytes=-0", "oops"] {
            assert!(byte_range(r, 10).is_none());
        }
        assert!(allowed_origin(Some("tauri://localhost")));
        assert!(allowed_origin(None));
        assert!(!allowed_origin(Some("https://evil.test")));
    }
    #[test]
    fn vod_playlist_preserves_timing_without_upstream_credentials() {
        let m = Manifest {
            version: 1,
            course: "c".into(),
            video: "v".into(),
            title: "课".into(),
            signature: "s".into(),
            parts: vec![
                PartMeta {
                    duration: 5.5,
                    discontinuity: false,
                },
                PartMeta {
                    duration: 6.1,
                    discontinuity: true,
                },
            ],
        };
        let hls = playlist(&m);
        assert!(hls.contains("#EXT-X-TARGETDURATION:7\n"));
        assert!(hls.contains("#EXT-X-DISCONTINUITY\n#EXTINF:6.100000,\n1.ts\n"));
        assert!(hls.ends_with("#EXT-X-ENDLIST\n"));
        assert!(!hls.contains("https://"));
        assert!(!hls.contains("KEY"));
        let dir = tempfile::tempdir().unwrap();
        write_private(
            &dir.path().join("manifest.json"),
            &serde_json::to_vec(&m).unwrap(),
        )
        .unwrap();
        write_private(&part_path(dir.path(), 0), b"segment").unwrap();
        assert!(saved_manifest(dir.path(), "c", "v").is_some());
        assert!(saved_manifest(dir.path(), "other", "v").is_none());
        assert_eq!(cache_sizes(dir.path(), 2), vec![7, 0]);
        fs::write(part_path(dir.path(), 1), b"").unwrap();
        assert_eq!(cache_sizes(dir.path(), 2), vec![7, 0]);
    }
}
