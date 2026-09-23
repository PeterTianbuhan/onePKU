//! Local HLS playback: an opaque loopback URL serves authorized, persistent
//! segments. The player never receives school cookies, signed URLs, or keys.
use super::*;
use crate::platform::PrivateOpenOptions;
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
    #[serde(default)]
    cache_signature: Option<String>,
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
    shared_root: PathBuf,
    shared_directory: std::sync::OnceLock<PathBuf>,
    manifest: Manifest,
    remote: tokio::sync::OnceCell<std::result::Result<(CourseApi, PlaybackMedia), String>>,
    core: std::sync::Weak<Core>,
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
fn plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !platform::is_link(&m))
}
fn clear_marker(directory: &Path) -> PathBuf {
    directory.with_extension("cleared")
}
/// Adopt complete parts only from login generations previously bound to this
/// verified account. Leave all originals in place and reject changed media.
pub(crate) fn adopt_account_cache(
    cache: &Path,
    data: &Path,
    account: &str,
    course: &str,
    video: &str,
) -> Result<PathBuf> {
    let key = format!("{:x}", Sha256::digest(format!("{course}|{video}")));
    let destination = cache.join(account).join(&key);
    // Keep legacy originals, but never undo an explicit clear by adopting them again.
    // This marker is outside the removable video directory and survives relogin.
    if clear_marker(&destination).exists() {
        return Ok(destination);
    }
    let mut sources = accounts::bound_generations(data, account)
        .into_iter()
        .map(|g| cache.join(g).join(&key))
        .filter(|p| {
            *p != destination
                && !clear_marker(p).exists()
                && plain_directory(p)
                && p.parent().is_some_and(plain_directory)
        })
        .filter_map(|p| saved_manifest(&p, course, video).map(|m| (p, m)))
        .collect::<Vec<_>>();
    sources.sort_by_key(|(p, _)| {
        std::cmp::Reverse(
            fs::metadata(p.join("manifest.json"))
                .and_then(|m| m.modified())
                .ok(),
        )
    });
    let selected = saved_manifest(&destination, course, video)
        .or_else(|| sources.first().map(|(_, m)| m.clone()));
    let Some(manifest) = selected else {
        return Ok(destination);
    };
    fs::create_dir_all(&destination)?;
    if !plain_directory(&destination) || !destination.parent().is_some_and(plain_directory) {
        bail!("回放缓存目录无效");
    }
    platform::private_directory(&destination)?;
    if saved_manifest(&destination, course, video).is_none() {
        write_private(
            &destination.join("manifest.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
    }
    for (source, old) in sources {
        if old.signature != manifest.signature
            || old.parts.len() != manifest.parts.len()
            || matches!((&old.cache_signature,&manifest.cache_signature),(Some(a),Some(b)) if a != b)
        {
            continue;
        }
        let sizes = cache_sizes(&source, old.parts.len());
        for (index, size) in sizes.into_iter().enumerate() {
            if size == 0 {
                continue;
            }
            let from = part_path(&source, index);
            let to = part_path(&destination, index);
            if to.exists()
                || !fs::symlink_metadata(&from).is_ok_and(|m| m.is_file() && !platform::is_link(&m))
            {
                continue;
            }
            // Immutable parts can be shared without duplicating large videos.
            // If the filesystem cannot link, keep the source for a later retry.
            let _ = fs::hard_link(from, to);
        }
    }
    Ok(destination)
}
pub(crate) fn shared_cache_root(account: &str, course: &str, video: &str) -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位回放缓存"))?
        .cache_dir()
        .join("video-downloads-v1")
        .join(account)
        .join(format!("{:x}", Sha256::digest(format!("{course}|{video}")))))
}
pub(crate) fn reuse_playback_parts(
    directory: &Path,
    shared: &Path,
    course: &str,
    video: &str,
    signature: &str,
    legacy_signature: &str,
    count: usize,
) -> Result<()> {
    let Some(old) = saved_manifest(directory, course, video) else {
        return Ok(());
    };
    if old.signature != legacy_signature
        || old.parts.len() != count
        || old
            .cache_signature
            .as_deref()
            .is_some_and(|s| s != signature)
    {
        return Ok(());
    }
    if !plain_directory(directory) || !directory.parent().is_some_and(plain_directory) {
        return Ok(());
    }
    for index in 0..count {
        pku_course::api::reuse_media_part(&part_path(directory, index), &part_path(shared, index))?;
    }
    promote_manifest(directory, &old, signature)?;
    Ok(())
}
fn promote_manifest(directory: &Path, manifest: &Manifest, signature: &str) -> Result<()> {
    if manifest.cache_signature.is_none() {
        if let Some(current) = saved_manifest(directory, &manifest.course, &manifest.video) {
            if current.signature != manifest.signature
                || current.parts.len() != manifest.parts.len()
                || current
                    .cache_signature
                    .as_deref()
                    .is_some_and(|s| s != signature)
            {
                bail!("回放版本已变化，请清除本节旧缓存后重新打开");
            }
            if current.cache_signature.is_some() {
                return Ok(());
            }
        }
        let mut upgraded = manifest.clone();
        upgraded.cache_signature = Some(signature.into());
        write_private(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&upgraded)?,
        )?;
    }
    Ok(())
}
fn shared_directory(account: &str, manifest: &Manifest) -> Result<Option<PathBuf>> {
    Ok(shared_directory_at(
        &shared_cache_root(account, &manifest.course, &manifest.video)?,
        manifest,
    ))
}
fn shared_directory_at(root: &Path, manifest: &Manifest) -> Option<PathBuf> {
    // A saved manifest is local data, not permission to choose an arbitrary path.
    match manifest.cache_signature.as_deref() {
        Some(s) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) => Some(root.join(s)),
        _ => None,
    }
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
fn matches_media(manifest: &Manifest, media: &PlaybackMedia) -> bool {
    manifest.signature == media.legacy_signature
        && manifest.parts.len() == media.parts.len()
        && manifest
            .cache_signature
            .as_ref()
            .is_none_or(|s| *s == media.cache_signature)
}
fn focus_at(manifest: &Manifest, position: f64) -> usize {
    let duration: f64 = manifest.parts.iter().map(|p| p.duration).sum();
    if !position.is_finite() || position <= 0.0 || position >= duration - 5.0 {
        return 0;
    }
    let mut end = 0.0;
    manifest
        .parts
        .iter()
        .position(|p| {
            end += p.duration;
            position < end
        })
        .unwrap_or(0)
}
impl Session {
    fn shared_directory(&self) -> Option<&PathBuf> {
        if self.shared_directory.get().is_none() {
            // An MP4 export may have verified and upgraded this legacy manifest
            // after the player opened. Discover it without a network request.
            if let Some(saved) =
                saved_manifest(&self.directory, &self.manifest.course, &self.manifest.video)
            {
                if saved.signature == self.manifest.signature
                    && saved.parts.len() == self.manifest.parts.len()
                    && self
                        .manifest
                        .cache_signature
                        .as_ref()
                        .is_none_or(|s| saved.cache_signature.as_ref() == Some(s))
                {
                    if let Some(path) = shared_directory_at(&self.shared_root, &saved) {
                        let _ = self.shared_directory.set(path);
                    }
                }
            }
        }
        self.shared_directory.get()
    }
    async fn remote_media(&self) -> Result<&(CourseApi, PlaybackMedia)> {
        // Only a missing part waits for school authorization. Cached parts and
        // the local playlist never acquire this initialization lock.
        let result = self
            .remote
            .get_or_init(|| async {
                let resolved = async {
                    let core = self
                        .core
                        .upgrade()
                        .ok_or_else(|| anyhow!("这个片段尚未缓存，请联网后重试"))?;
                    let (api, media, _) = tokio::time::timeout(
                        Duration::from_secs(60),
                        core.resolve_playback(&self.manifest.course, &self.manifest.video),
                    )
                    .await
                    .map_err(|_| anyhow!("回放连接超时，已缓存的内容仍可播放；可重试连接"))?
                    .map_err(|e| anyhow!("{}", problem(e).message))?;
                    if !self.valid() {
                        bail!("播放会话已关闭，请重新打开回放");
                    }
                    if !matches_media(&self.manifest, &media) {
                        bail!("回放版本已变化，请清除本节旧缓存后重新打开；旧缓存仍可播放");
                    }
                    // A missing legacy part has now forced an authorized lookup.
                    // Persist its verified signature so playback and exports write
                    // to the same cache, while existing local parts remain usable.
                    let _disk = self.progress.lock().unwrap();
                    if !self.valid() {
                        bail!("播放会话已关闭，请重新打开回放");
                    }
                    let shared = self.shared_root.join(&media.cache_signature);
                    fs::create_dir_all(&shared)?;
                    platform::private_directory(&shared)?;
                    promote_manifest(&self.directory, &self.manifest, &media.cache_signature)?;
                    let _ = self.shared_directory.set(shared);
                    Ok((api, media))
                }
                .await;
                resolved.map_err(|e: anyhow::Error| e.to_string())
            })
            .await;
        result.as_ref().map_err(|e| anyhow!("{e}"))
    }
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
        let mut p = self.progress.lock().unwrap();
        if let Some(directory) = self.shared_directory() {
            for (i, size) in cache_sizes(directory, p.sizes.len())
                .into_iter()
                .enumerate()
            {
                if size > 0 {
                    p.sizes[i] = size;
                }
            }
        }
        let completed = p.sizes.iter().filter(|n| **n > 0).count();
        if completed == p.sizes.len() {
            p.error.clear();
        }
        json!({"completed":completed,"segments":p.sizes.len(),"bytes":p.sizes.iter().sum::<u64>(),
            "complete":completed==p.sizes.len(),"downloading":self.downloading.load(Ordering::Relaxed),
            "message":p.error,"offline":self.remote.get().is_some_and(|r| r.is_err())
                || (self.remote.get().is_none() && self.core.strong_count() == 0)})
    }
    fn cached_part(&self, index: usize) -> Option<Vec<u8>> {
        let path = part_path(&self.directory, index);
        if let Some(shared) = self.shared_directory() {
            if let Some(bytes) = pku_course::api::cached_media_part(&part_path(shared, index)) {
                self.progress.lock().unwrap().sizes[index] = bytes.len() as u64;
                return Some(bytes);
            }
        }
        if !path.is_symlink() {
            if let Ok(bytes) = fs::read(&path) {
                if !bytes.is_empty() && bytes.len() as u64 <= MAX_PART {
                    self.progress.lock().unwrap().sizes[index] = bytes.len() as u64;
                    return Some(bytes);
                }
            }
        }
        None
    }
    async fn part(&self, index: usize) -> Result<Vec<u8>> {
        let lock = self
            .locks
            .get(index)
            .ok_or_else(|| anyhow!("invalid segment"))?;
        if !self.valid() {
            bail!("播放会话已关闭，请重新打开回放");
        }
        if let Some(bytes) = self.cached_part(index) {
            return Ok(bytes);
        }
        let _lock = lock.lock().await;
        if !self.valid() {
            bail!("播放会话已关闭，请重新打开回放");
        }
        if let Some(bytes) = self.cached_part(index) {
            return Ok(bytes);
        }
        let (api, media) = self.remote_media().await?;
        // The media client retries transient errors. Keep its safe, specific
        // failure so authorization errors are not disguised as network outages.
        let bytes = if let Some(shared) = self.shared_directory() {
            api.cached_playback_part(&media.parts[index], &part_path(shared, index))
                .await?
        } else {
            api.playback_part(&media.parts[index]).await?
        };
        let mut progress = self.progress.lock().unwrap();
        if !self.valid() {
            bail!("播放已关闭");
        }
        if progress.sizes.iter().sum::<u64>() - progress.sizes[index] + bytes.len() as u64
            > MAX_VIDEO
        {
            bail!("本节回放缓存已达 8 GB");
        }
        if self.shared_directory().is_none() {
            write_private(&part_path(&self.directory, index), &bytes)?;
        }
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
    async fn resolve_playback(
        &self,
        course: &str,
        video_id: &str,
    ) -> Result<(CourseApi, PlaybackMedia, Manifest)> {
        let api = self.course_api()?;
        let c = self.find_course(course).await?;
        let video = api
            .list_videos(course, c["name"].as_str().unwrap_or("课程"))
            .await?
            .into_iter()
            .find(|v| v.hash_id == video_id)
            .ok_or_else(|| anyhow!("回放已变化，请刷新课程列表"))?;
        let media = api.playback_media(&video).await?;
        let manifest = Manifest {
            version: 1,
            course: course.into(),
            video: video_id.into(),
            title: format!("{} · {}", video.title, video.time),
            signature: media.legacy_signature.clone(),
            cache_signature: Some(media.cache_signature.clone()),
            parts: media
                .parts
                .iter()
                .map(|p| PartMeta {
                    duration: p.duration,
                    discontinuity: p.discontinuity,
                })
                .collect(),
        };
        Ok((api, media, manifest))
    }
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
        position: f64,
    ) -> Result<Value> {
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
        let subtitle_account =
            if let Some(account) = accounts::binding(&accounts::root()?, &generation) {
                self.prepare_subtitle_account(&generation, &account)?;
                account
            } else if saved_manifest(&cache_dir(&generation, course, video_id)?, course, video_id)
                .is_some()
            {
                generation.clone()
            } else {
                self.subtitle_account(&generation)
                    .await
                    .unwrap_or_else(|_| generation.clone())
            };
        let directory = if subtitle_account != generation {
            let dirs = directories::ProjectDirs::from("me", "petertian", "OnePKU")
                .ok_or_else(|| anyhow!("无法定位回放缓存"))?;
            adopt_account_cache(
                &dirs.cache_dir().join("playback-v1"),
                &accounts::root()?,
                &subtitle_account,
                course,
                video_id,
            )?
        } else {
            cache_dir(&generation, course, video_id)?
        };
        let saved = saved_manifest(&directory, course, video_id);
        let mut remote = None;
        // A partial cache is immediately playable too. Reopening/retrying only
        // renews the downloader; it must not put remote I/O before local playback.
        let manifest = if let Some(manifest) = &saved {
            manifest.clone()
        } else {
            let (api, media, manifest) = self.resolve_playback(course, video_id).await?;
            remote = Some((api, media));
            manifest
        };
        // Do not let a cold video's slow remote lookup block cached opens.
        let _prepare = self.playback_prepare_lock.lock().await;
        if generation != fingerprint("course") {
            bail!("账号已更新，请重试");
        }
        {
            let store = self.playback.lock().unwrap();
            if !refresh {
                if let Some((token, s)) = store.sessions.iter().find(|(_, s)| {
                    s.valid() && s.manifest.course == course && s.manifest.video == video_id
                }) {
                    return Ok(
                        json!({"id":token,"url":format!("http://127.0.0.1:{port}/media/{token}/index.m3u8"),
                        "title":s.manifest.title,"duration":s.duration(),"status":s.status()}),
                    );
                }
            }
            for old in store
                .sessions
                .values()
                .filter(|s| s.manifest.course == course && s.manifest.video == video_id)
            {
                old.closed.store(true, Ordering::Relaxed);
                let _disk = old.progress.lock().unwrap();
            }
        }
        fs::create_dir_all(&directory)?;
        platform::private_directory(&directory)?;
        let shared = shared_directory(&subtitle_account, &manifest)?;
        if let Some(path) = &shared {
            fs::create_dir_all(path)?;
            platform::private_directory(path)?;
            // Read legacy parts on demand. Revalidating/linking an entire video
            // here makes startup proportional to all previously downloaded bytes.
        }
        // An export may have promoted a legacy manifest while we prepared this
        // session. Do not overwrite its verified signature with our old snapshot.
        if saved_manifest(&directory, course, video_id).is_none() {
            write_private(
                &directory.join("manifest.json"),
                &serde_json::to_vec(&manifest)?,
            )?;
        }
        let session = Arc::new(Session {
            generation,
            shared_root: shared_cache_root(&subtitle_account, course, video_id)?,
            subtitle_account,
            directory: directory.clone(),
            shared_directory: shared
                .map_or_else(std::sync::OnceLock::new, std::sync::OnceLock::from),
            remote: tokio::sync::OnceCell::new_with(remote.map(Ok)),
            core: Arc::downgrade(self),
            progress: Mutex::new(Progress {
                sizes: cache_sizes(&directory, manifest.parts.len()),
                error: String::new(),
            }),
            locks: (0..manifest.parts.len())
                .map(|_| tokio::sync::Mutex::new(()))
                .collect(),
            focus: AtomicUsize::new(focus_at(&manifest, position)),
            manifest,
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
            if self.replay_download_active(&session.manifest.course, &session.manifest.video) {
                bail!("该回放正在下载，请先取消下载再清除缓存");
            }
            Some(self.ensure_subtitle_idle(&session)?)
        } else {
            None
        };
        let mut store = self.playback.lock().unwrap();
        if let Some(s) = store.sessions.remove(id) {
            s.closed.store(true, Ordering::Relaxed);
            s.downloading.store(false, Ordering::Relaxed);
            let _disk = s.progress.lock().unwrap();
            if clear {
                write_private(&clear_marker(&s.directory), b"1")?;
                let shared = s.shared_directory().cloned();
                if plain_directory(&s.directory) {
                    fs::remove_dir_all(&s.directory)?;
                }
                if let Some(shared) = &shared {
                    if plain_directory(shared) {
                        fs::remove_dir_all(shared)?;
                    }
                }
            }
        }
        Ok(json!({"closed":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resumed_download_starts_at_the_watching_position() {
        let manifest = Manifest {
            version: 1,
            course: "course".into(),
            video: "video".into(),
            title: "lesson".into(),
            signature: "media".into(),
            cache_signature: None,
            parts: vec![
                PartMeta {
                    duration: 10.0,
                    discontinuity: false
                };
                10
            ],
        };
        assert_eq!(focus_at(&manifest, 42.0), 4);
        assert_eq!(focus_at(&manifest, 50.0), 5);
        for position in [0.0, -1.0, f64::NAN, f64::INFINITY, 95.0, 100.0] {
            assert_eq!(focus_at(&manifest, position), 0);
        }
    }
    #[tokio::test]
    async fn export_parts_are_playable_without_network_and_legacy_playback_seeds_exports() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("playback");
        let shared = root.path().join("shared");
        fs::create_dir(&local).unwrap();
        fs::create_dir(&shared).unwrap();
        let signature = "a".repeat(64);
        let manifest = Manifest {
            version: 1,
            course: "course".into(),
            video: "video".into(),
            title: "lesson".into(),
            signature: "legacy".into(),
            cache_signature: None,
            parts: vec![
                PartMeta {
                    duration: 10.0,
                    discontinuity: false
                };
                3
            ],
        };
        write_private(
            &local.join("manifest.json"),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut bytes = vec![0; 188 * 3];
        for i in [0, 188, 376] {
            bytes[i] = 0x47;
        }
        write_private(&part_path(&local, 0), &bytes).unwrap();
        write_private(&part_path(&local, 1), b"incomplete").unwrap();
        reuse_playback_parts(
            &local,
            &shared,
            "wrong-account-course",
            "video",
            &signature,
            "legacy",
            3,
        )
        .unwrap();
        assert!(!part_path(&shared, 0).exists());
        reuse_playback_parts(
            &local,
            &shared,
            "course",
            "video",
            &signature,
            "different-version",
            3,
        )
        .unwrap();
        assert!(!part_path(&shared, 0).exists());
        reuse_playback_parts(&local, &shared, "course", "video", &signature, "legacy", 3).unwrap();
        assert_eq!(
            pku_course::api::cached_media_part(&part_path(&shared, 0)).unwrap(),
            bytes
        );
        assert!(!part_path(&shared, 1).exists());
        assert!(part_path(&local, 0).exists());
        let session = Session {
            generation: fingerprint("course"),
            subtitle_account: "test-account".into(),
            directory: local.clone(),
            shared_root: root.path().join("unused"),
            shared_directory: std::sync::OnceLock::from(shared.clone()),
            manifest,
            remote: tokio::sync::OnceCell::new(),
            core: std::sync::Weak::new(),
            progress: Mutex::new(Progress {
                sizes: vec![0; 3],
                error: String::new(),
            }),
            locks: (0..3).map(|_| tokio::sync::Mutex::new(())).collect(),
            focus: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
            worker: AtomicBool::new(false),
            subtitle_active: AtomicBool::new(false),
        };
        assert_eq!(session.status()["completed"], 1);
        // Simulate export completing a part after the player has opened. The
        // existing player reports and serves it without any remote API/client.
        write_private(&part_path(&shared, 2), &bytes).unwrap();
        assert_eq!(session.status()["completed"], 2);
        assert_eq!(session.part(2).await.unwrap(), bytes);
        assert!(!part_path(&local, 2).exists());
        let mut newer = session.manifest.clone();
        newer.cache_signature = Some("b".repeat(64));
        write_private(
            &local.join("manifest.json"),
            &serde_json::to_vec(&newer).unwrap(),
        )
        .unwrap();
        let incompatible = root.path().join("incompatible");
        fs::create_dir(&incompatible).unwrap();
        reuse_playback_parts(
            &local,
            &incompatible,
            "course",
            "video",
            &signature,
            "legacy",
            3,
        )
        .unwrap();
        assert!(!part_path(&incompatible, 0).exists());
    }
    #[test]
    fn replay_cache_unites_verified_logins_without_crossing_accounts_or_media() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let data = temp.path().join("data");
        fs::create_dir_all(data.join("subtitle-accounts")).unwrap();
        let account = "a".repeat(64);
        let other = "b".repeat(64);
        let key = format!("{:x}", Sha256::digest("course|video"));
        let manifest = Manifest {
            version: 1,
            course: "course".into(),
            video: "video".into(),
            title: "lesson".into(),
            signature: "same-media".into(),
            cache_signature: None,
            parts: vec![
                PartMeta {
                    duration: 10.0,
                    discontinuity: false
                };
                3
            ],
        };
        for (letter, owner, index, signature) in [
            ('1', &account, 0, "same-media"),
            ('2', &account, 1, "same-media"),
            ('3', &other, 2, "same-media"),
            ('4', &account, 2, "different-media"),
        ] {
            let generation = letter.to_string().repeat(64);
            fs::write(
                data.join("subtitle-accounts")
                    .join(format!("{generation}.json")),
                serde_json::to_vec(owner).unwrap(),
            )
            .unwrap();
            let dir = cache.join(generation).join(&key);
            fs::create_dir_all(&dir).unwrap();
            let m = Manifest {
                signature: signature.into(),
                ..manifest.clone()
            };
            write_private(&dir.join("manifest.json"), &serde_json::to_vec(&m).unwrap()).unwrap();
            write_private(&part_path(&dir, index), b"complete-cached-part").unwrap();
        }
        // An existing manifest determines which recording version is compatible.
        let dest = cache.join(&account).join(&key);
        fs::create_dir_all(&dest).unwrap();
        write_private(
            &dest.join("manifest.json"),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(
            adopt_account_cache(&cache, &data, &account, "course", "video").unwrap(),
            dest
        );
        assert!(part_path(&dest, 0).is_file());
        assert!(part_path(&dest, 1).is_file());
        assert!(!part_path(&dest, 2).exists());
        assert!(part_path(&cache.join("1".repeat(64)).join(&key), 0).exists());
        assert!(
            adopt_account_cache(&cache, &data, &"f".repeat(64), "course", "video")
                .unwrap()
                .read_dir()
                .is_err()
        );
    }
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
            shared_root: directory.path().join("unused"),
            shared_directory: std::sync::OnceLock::new(),
            remote: tokio::sync::OnceCell::new(),
            core: std::sync::Weak::new(),
            manifest: Manifest {
                version: 1,
                course: "test".into(),
                video: "lecture".into(),
                title: "Lecture".into(),
                signature: "fixture".into(),
                cache_signature: None,
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
        {
            // A downloader may still be resolving the school connection, or
            // waiting on a part that another writer has now published. Neither
            // condition may block serving an already complete local part.
            let mut connecting = Box::pin(session.remote.get_or_init(|| std::future::pending()));
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut connecting)
                    .await
                    .is_err()
            );
            let _downloader = session.locks[0].lock().await;
            let local = tokio::time::timeout(Duration::from_secs(2), async {
                let playlist = client
                    .get(format!("{root}/index.m3u8"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(playlist.status(), 200);
                assert!(playlist.text().await.unwrap().contains("#EXT-X-ENDLIST"));
                client
                    .get(format!("{root}/0.ts"))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap()
            })
            .await
            .expect("local playback must not wait for the downloader");
            assert_eq!(local.as_ref(), b"cached-video");
            assert!(session.remote.get().is_none());
        }
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
            cache_signature: None,
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

#[cfg(test)]
mod migration_regressions {
    use super::*;
    fn old_manifest() -> Manifest {
        Manifest {
            version: 1,
            course: "course".into(),
            video: "video".into(),
            title: "lesson".into(),
            signature: "old-media".into(),
            cache_signature: None,
            parts: vec![
                PartMeta {
                    duration: 10.0,
                    discontinuity: false
                };
                2
            ],
        }
    }
    fn session(directory: PathBuf, manifest: Manifest) -> Arc<Session> {
        Arc::new(Session {
            generation: fingerprint("course"),
            subtitle_account: "a".repeat(64),
            shared_root: directory.parent().unwrap().join("shared"),
            directory,
            shared_directory: std::sync::OnceLock::new(),
            remote: tokio::sync::OnceCell::new(),
            core: std::sync::Weak::new(),
            progress: Mutex::new(Progress {
                sizes: vec![0; 2],
                error: String::new(),
            }),
            locks: vec![tokio::sync::Mutex::new(()), tokio::sync::Mutex::new(())],
            focus: AtomicUsize::new(0),
            manifest,
            closed: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
            worker: AtomicBool::new(false),
            subtitle_active: AtomicBool::new(false),
        })
    }
    #[test]
    fn clear_of_adopted_cache_should_survive_reopening() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let data = temp.path().join("data");
        let account = "a".repeat(64);
        let generation = "b".repeat(64);
        fs::create_dir_all(data.join("course-sessions")).unwrap();
        fs::write(
            data.join("course-sessions")
                .join(format!("{generation}.json")),
            serde_json::to_vec(&account).unwrap(),
        )
        .unwrap();
        let key = format!("{:x}", Sha256::digest("course|video"));
        let legacy = cache.join(generation).join(key);
        fs::create_dir_all(&legacy).unwrap();
        write_private(
            &legacy.join("manifest.json"),
            &serde_json::to_vec(&old_manifest()).unwrap(),
        )
        .unwrap();
        write_private(&part_path(&legacy, 0), b"old-video-segment").unwrap();
        let adopted = adopt_account_cache(&cache, &data, &account, "course", "video").unwrap();
        assert!(part_path(&adopted, 0).exists());
        let core = Core::default();
        core.playback
            .lock()
            .unwrap()
            .sessions
            .insert("review".into(), session(adopted.clone(), old_manifest()));
        core.playback_close("review", true).unwrap();
        assert!(!adopted.exists());
        let reopened = adopt_account_cache(&cache, &data, &account, "course", "video").unwrap();
        assert!(
            !part_path(&reopened, 0).exists(),
            "clear was undone: legacy segment was imported again"
        );
        assert!(part_path(&legacy, 0).exists()); // Migration never destroys originals.
        fs::create_dir_all(&reopened).unwrap();
        let mut newer = old_manifest();
        newer.signature = "new-recording".into();
        write_private(
            &reopened.join("manifest.json"),
            &serde_json::to_vec(&newer).unwrap(),
        )
        .unwrap();
        adopt_account_cache(&cache, &data, &account, "course", "video").unwrap();
        assert!(!part_path(&reopened, 0).exists());
        assert_eq!(
            saved_manifest(&reopened, "course", "video")
                .unwrap()
                .signature,
            "new-recording"
        );
    }
    #[tokio::test]
    async fn legacy_player_sees_newly_exported_parts_without_redownload() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("local");
        let shared = tmp.path().join("shared").join("c".repeat(64));
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&shared).unwrap();
        let manifest = old_manifest();
        let signature = "c".repeat(64);
        let mut bytes = vec![0u8; 188 * 3];
        for i in [0, 188, 376] {
            bytes[i] = 0x47;
        }
        write_private(
            &local.join("manifest.json"),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        write_private(&part_path(&local, 0), &bytes).unwrap();
        let mut player = session(local.clone(), manifest.clone());
        reuse_playback_parts(
            &local,
            &shared,
            "course",
            "video",
            &signature,
            "old-media",
            2,
        )
        .unwrap();
        let downloaded = tmp.path().join("downloaded.ts");
        write_private(&downloaded, &bytes).unwrap();
        pku_course::api::reuse_media_part(&downloaded, &part_path(&shared, 1)).unwrap();
        assert_eq!(
            saved_manifest(&local, "course", "video")
                .unwrap()
                .cache_signature,
            Some(signature.clone())
        );
        let mutable = Arc::get_mut(&mut player).unwrap();
        // Leave the live player on the legacy manifest; discover the export upgrade on demand.
        mutable.progress.lock().unwrap().sizes = cache_sizes(&local, 2);
        assert!(player.cached_part(0).is_some());
        assert!(pku_course::api::cached_media_part(&part_path(&shared, 1)).is_some());
        assert_eq!(player.part(1).await.unwrap(), bytes);
        assert_eq!(player.status()["completed"], 2);
        let reopened = session(
            local.clone(),
            saved_manifest(&local, "course", "video").unwrap(),
        );
        assert_eq!(reopened.part(1).await.unwrap(), bytes);
        // A delayed lookup with an obsolete media identity must not replace an
        // export's newer verified signature or mix its parts with another video.
        assert!(promote_manifest(&local, &manifest, &"d".repeat(64)).is_err());
        assert_eq!(
            saved_manifest(&local, "course", "video")
                .unwrap()
                .cache_signature,
            Some(signature)
        );
    }
}
