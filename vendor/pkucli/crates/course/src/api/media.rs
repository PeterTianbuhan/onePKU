//! Reusable, cancellable recording download. No shell, no overwrite, and no
//! playlist URLs are passed to ffmpeg: it only reads a local merged stream.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncWriteExt;

fn retryable_media_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<reqwest::Error>().is_some_and(|e| {
        e.is_timeout()
            || e.is_connect()
            || e.is_body()
            || e.status()
                .is_some_and(|s| s.as_u16() == 429 || s.is_server_error())
    })
}

fn media_failure(error: &anyhow::Error) -> anyhow::Error {
    if let Some(e) = error.downcast_ref::<reqwest::Error>() {
        if matches!(e.status().map(|s| s.as_u16()), Some(401 | 403)) {
            return anyhow!(
                "回放服务拒绝访问（HTTP {}），请重试连接或重新登录；已下载分片已保留",
                e.status().unwrap().as_u16()
            );
        }
        if e.is_timeout() {
            return anyhow!("视频片段下载超时，已自动重试；已下载分片已保留");
        }
        if let Some(status) = e.status() {
            return anyhow!(
                "视频服务返回 HTTP {}；已下载分片已保留，请稍后重试",
                status.as_u16()
            );
        }
        return anyhow!("视频网络连接失败，已自动重试；已下载分片已保留");
    }
    anyhow!("视频片段读取失败：{}", error)
}

fn regular_cache_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    meta.is_file() && !meta.is_symlink() && meta.len() <= 32 * 1024 * 1024
}

pub fn cached_media_part(path: &Path) -> Option<Vec<u8>> {
    if !regular_cache_file(path) {
        return None;
    }
    std::fs::read(path).ok().filter(|b| transport_stream(b))
}

/// Publish a verified legacy part without changing its original file.
pub fn reuse_media_part(source: &Path, destination: &Path) -> Result<()> {
    if cached_media_part(destination).is_some() { return Ok(()); }
    let Some(bytes) = cached_media_part(source) else { return Ok(()); };
    if std::fs::hard_link(source, destination).is_err() {
        cache_segment(destination, &bytes)?;
    }
    Ok(())
}

fn cache_segment(path: &Path, data: &[u8]) -> Result<()> {
    // Only a complete, validated part is committed. A cancelled write is never reusable.
    if !transport_stream(data) {
        return Err(anyhow!("视频片段不完整，请稍后重试"));
    }
    let temp = path.with_extension(format!("{:032x}.part", rand::random::<u128>()));
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temp);
    result
}

async fn resume_part<F, Fut>(path: &Path, fetch: F) -> Result<Vec<u8>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>>>,
{
    // Playback and exports run on different runtimes. Share one asynchronous
    // lock per absolute cache path, and recheck disk after the owner completes.
    type Locks = std::sync::Mutex<HashMap<PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>>;
    static LOCKS: std::sync::OnceLock<Locks> = std::sync::OnceLock::new();
    let lock = {
        let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(path).and_then(std::sync::Weak::upgrade) { lock }
        else {
            let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            locks.insert(path.to_owned(), std::sync::Arc::downgrade(&lock));
            lock
        }
    };
    let _guard = lock.lock().await;
    if let Some(data) = cached_media_part(path) {
        return Ok(data);
    }
    let data = fetch().await?;
    cache_segment(path, &data)?;
    Ok(data)
}

fn resume_signature(base: &url::Url, playlist: &m3u8_rs::MediaPlaylist) -> Result<String> {
    let stable_url = |value: &str| -> Result<String> {
        let mut url = base.join(value)?;
        // Keep content-selecting query parameters; only discard known signing
        // fields so different recordings cannot collide merely by URL path.
        let params: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| {
                !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "token"
                        | "auth_key"
                        | "auth_data"
                        | "signature"
                        | "sign"
                        | "expires"
                        | "expire"
                        | "timestamp"
                )
            })
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params);
        }
        url.set_fragment(None);
        Ok(url.to_string())
    };
    let mut identity = playlist.clone();
    for segment in &mut identity.segments {
        segment.uri = stable_url(&segment.uri)?;
        if let Some(key) = &mut segment.key {
            if let Some(uri) = &key.uri {
                key.uri = Some(stable_url(uri)?);
            }
        }
    }
    Ok(format!("{:x}", Sha256::digest(format!("{:?}", identity))))
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MediaProgress {
    pub phase: &'static str,
    pub bytes: u64,
    pub completed: usize,
    pub total: usize,
}

pub struct PlaybackPart {
    pub duration: f64,
    pub discontinuity: bool,
    pub url: url::Url,
    encryption: Option<([u8; 16], [u8; 16])>,
}
pub struct PlaybackMedia {
    pub parts: Vec<PlaybackPart>,
    pub cache_signature: String,
    pub legacy_signature: String,
}

fn legacy_playback_signature(detail: &VideoDetail) -> Result<String> {
    let rows = detail.playlist.segments.iter().map(|s| {
        Ok(format!("{}|{}|{}", detail.base_url.join(&s.uri)?.path(), f64::from(s.duration), s.discontinuity))
    }).collect::<Result<Vec<_>>>()?;
    Ok(format!("{:x}", Sha256::digest(rows.join("\n"))))
}
fn transport_stream(bytes: &[u8]) -> bool {
    bytes.len() >= 188 && bytes.len() % 188 == 0 && bytes.iter().step_by(188).all(|b| *b == 0x47)
}

fn media_url(url: &url::Url) -> Result<()> {
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|h| h == "pku.edu.cn" || h.ends_with(".pku.edu.cn"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(anyhow!("视频资源地址不受支持，请在原站下载"));
    }
    Ok(())
}
struct TemporaryDirectory(PathBuf);
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
impl CourseApi {
    /// Resolve one authorized replay. Signing URLs and AES keys stay in memory.
    pub async fn playback_media(&self, video: &VideoInfo) -> Result<PlaybackMedia> {
        let detail = self.get_video_detail(video).await?;
        media_url(&detail.base_url)?;
        if !detail.playlist.end_list
            || detail.playlist.segments.is_empty()
            || detail.playlist.segments.len() > 10000
        {
            return Err(anyhow!("回放尚未生成完整视频"));
        }
        let mut parts = vec![];
        let mut key: Option<m3u8_rs::Key> = None;
        let mut keys = HashMap::new();
        for (i, segment) in detail.playlist.segments.iter().enumerate() {
            if segment.byte_range.is_some()
                || segment.map.is_some()
                || !segment.duration.is_finite()
                || segment.duration <= 0.0
            {
                return Err(anyhow!("此回放分段格式暂不支持本地播放"));
            }
            if let Some(k) = &segment.key {
                key = Some(k.clone());
            }
            let url = detail.base_url.join(&segment.uri)?;
            media_url(&url)?;
            let mut encryption = None;
            if let Some(k) = &key {
                match k.method {
                    m3u8_rs::KeyMethod::None => {}
                    m3u8_rs::KeyMethod::AES128 => {
                        let address = detail
                            .base_url
                            .join(k.uri.as_ref().context("视频密钥地址缺失")?)?;
                        let value = if let Some(value) = keys.get(address.as_str()) {
                            *value
                        } else {
                            let value: [u8; 16] = self
                                .bounded_media_bytes(&address, 16)
                                .await?
                                .try_into()
                                .map_err(|_| anyhow!("视频密钥长度无效"))?;
                            keys.insert(address.to_string(), value);
                            value
                        };
                        encryption = Some((value, build_iv(k, detail.playlist.media_sequence, i)));
                    }
                    _ => return Err(anyhow!("此回放加密格式暂不支持本地播放")),
                }
            }
            parts.push(PlaybackPart {
                duration: f64::from(segment.duration),
                discontinuity: segment.discontinuity,
                url,
                encryption,
            });
        }
        Ok(PlaybackMedia { parts, cache_signature: resume_signature(&detail.base_url, &detail.playlist)?,
            legacy_signature: legacy_playback_signature(&detail)? })
    }
    pub async fn cached_playback_part(&self, part: &PlaybackPart, path: &Path) -> Result<Vec<u8>> {
        resume_part(path, || self.playback_part(part)).await
    }
    pub async fn playback_part(&self, part: &PlaybackPart) -> Result<Vec<u8>> {
        let mut bytes = self
            .bounded_media_bytes(&part.url, 32 * 1024 * 1024)
            .await?;
        if let Some((key, iv)) = &part.encryption {
            bytes = decrypt_segment(key, iv, &bytes)?;
        }
        if !transport_stream(&bytes) {
            return Err(anyhow!("学校未返回完整视频片段，请重试"));
        }
        Ok(bytes)
    }
    pub(super) async fn bounded_media_bytes(&self, url: &url::Url, limit: usize) -> Result<Vec<u8>> {
        for attempt in 0..3 {
            match self.bounded_media_bytes_once(url, limit).await {
                Ok(bytes) => return Ok(bytes),
                Err(error) if attempt < 2 && retryable_media_error(&error) => {
                    tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt + 1))).await;
                }
                Err(error) => return Err(media_failure(&error)),
            }
        }
        unreachable!()
    }
    async fn bounded_media_bytes_once(&self, url: &url::Url, limit: usize) -> Result<Vec<u8>> {
        media_url(url)?;
        let mut response = self
            .client
            .get(url.clone())
            .timeout(std::time::Duration::from_secs(45))
            .send()
            .await?
            .error_for_status()?;
        media_url(response.url())?;
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(anyhow!("视频片段超出大小限制"));
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if data.len() + chunk.len() > limit {
                return Err(anyhow!("视频片段超出大小限制"));
            }
            data.extend_from_slice(&chunk);
        }
        Ok(data)
    }
    pub async fn download_video_to<F, R>(
        &self,
        video: &VideoInfo,
        output: &Path,
        resume_root: &Path,
        ffmpeg: &Path,
        cancel: &AtomicBool,
        progress: F,
        reuse: R,
    ) -> Result<()>
    where
        F: Fn(MediaProgress),
        R: Fn(&str, &str, usize, &Path) -> Result<()>,
    {
        if output.exists() {
            return Err(anyhow!("目标文件已存在"));
        }
        // Detect a missing desktop dependency before transferring a whole lesson.
        let mut probe = tokio::process::Command::new(ffmpeg);
        #[cfg(windows)]
        probe.creation_flags(0x08000000);
        let status = probe
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status()
            .await
            .context("无法启动 ffmpeg，请先安装 ffmpeg")?;
        if !status.success() {
            return Err(anyhow!("视频转换工具 ffmpeg 无法运行，请检查安装"));
        }
        progress(MediaProgress {
            phase: "preparing",
            bytes: 0,
            completed: 0,
            total: 0,
        });
        let detail = self.get_video_detail(video).await?;
        media_url(&detail.base_url)?;
        if detail.playlist.segments.is_empty() || !detail.playlist.end_list {
            return Err(anyhow!("当前不是完整回放，请稍后下载"));
        }
        if detail.playlist.segments.len() > 10000 {
            return Err(anyhow!("回放过长，请在原站下载"));
        }
        // Ignore expiring URL query tokens, but invalidate data when the actual
        // playlist, timeline, encryption or segment paths change.
        let signature = resume_signature(&detail.base_url, &detail.playlist)?;
        let resume = resume_root.join(&signature);
        std::fs::create_dir_all(&resume)?;
        reuse(&signature, &legacy_playback_signature(&detail)?, detail.playlist.segments.len(), &resume)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&resume, std::fs::Permissions::from_mode(0o700))?;
        }
        let parent = output.parent().context("下载目录无效")?;
        std::fs::create_dir_all(parent)?;
        let dir = parent.join(format!(".onepku-media-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let _cleanup = TemporaryDirectory(dir.clone());
        let merged = dir.join("merged.ts");
        let mut file = tokio::fs::File::create(&merged).await?;
        let mut bytes = 0u64;
        let mut available: Vec<u64> = (0..detail.playlist.segments.len()).map(|i|
            cached_media_part(&resume.join(format!("{i:05}.ts"))).map_or(0,|b|b.len() as u64)).collect();
        progress(MediaProgress {phase:"downloading",bytes:available.iter().sum(),
            completed:available.iter().filter(|n|**n>0).count(),total:available.len()});
        let mut key: Option<m3u8_rs::Key> = None;
        let mut key_cache: HashMap<String, [u8; 16]> = HashMap::new();
        let mut parts = Vec::new();
        for (i, seg) in detail.playlist.segments.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("cancelled"));
            }
            if seg.byte_range.is_some() || seg.map.is_some() {
                return Err(anyhow!("此回放分段格式暂不支持，请在原站下载"));
            }
            if let Some(k) = &seg.key {
                key = Some(k.clone());
            }
            // Resolve encryption even for currently cached parts: a concurrent
            // eviction must not make a cache miss fetch undecipherable bytes.
            let source = detail.base_url.join(&seg.uri)?;
            let mut encryption = None;
            if let Some(k) = &key {
                match k.method {
                    m3u8_rs::KeyMethod::None => {}
                    m3u8_rs::KeyMethod::AES128 => {
                        let key_url = detail
                            .base_url
                            .join(k.uri.as_ref().context("密钥地址缺失")?)?;
                        let aes_key = if let Some(cached) = key_cache.get(key_url.as_str()) {
                            *cached
                        } else {
                            let data = self.bounded_media_bytes(&key_url, 16).await?;
                            let value: [u8; 16] =
                                data.try_into().map_err(|_| anyhow!("视频密钥长度无效"))?;
                            key_cache.insert(key_url.to_string(), value);
                            value
                        };
                        encryption =
                            Some((aes_key, build_iv(k, detail.playlist.media_sequence, i)));
                    }
                    _ => return Err(anyhow!("此回放加密格式暂不支持，请在原站播放")),
                }
            }
            parts.push((i, source, encryption));
        }
        use futures::{stream, StreamExt};
        let mut chunks = stream::iter(parts)
            .map(|(i, source, encryption)| {
                let cache = resume.join(format!("{i:05}.ts"));
                async move {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(anyhow!("cancelled"));
                    }
                    let data = resume_part(&cache, || async {
                        let mut data = self
                            .bounded_media_bytes(&source, 32 * 1024 * 1024)
                            .await
                            .map_err(|e| anyhow!("视频第 {} 个分片下载失败：{}", i + 1, e))?;
                        if let Some((key, iv)) = encryption {
                            data = decrypt_segment(&key, &iv, &data)?;
                        }
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("cancelled"));
                        }
                        Ok(data)
                    })
                    .await?;
                    Ok::<_, anyhow::Error>((i, data))
                }
            })
            .buffered(4);
        while let Some(part) = chunks.next().await {
            let (i, data) = part?;
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("cancelled"));
            }
            bytes += data.len() as u64;
            if bytes > 8 * 1024 * 1024 * 1024 {
                return Err(anyhow!("视频超过 8 GB，请在原站下载"));
            }
            file.write_all(&data).await?;
            available[i] = data.len() as u64;
            progress(MediaProgress {
                phase: "downloading",
                bytes: available.iter().sum(),
                completed: available.iter().filter(|n| **n > 0).count(),
                total: detail.playlist.segments.len(),
            });
        }
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("cancelled"));
        }
        progress(MediaProgress {
            phase: "converting",
            bytes,
            completed: detail.playlist.segments.len(),
            total: detail.playlist.segments.len(),
        });
        let rendered = dir.join("rendered.mp4");
        let mut command = tokio::process::Command::new(ffmpeg);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command
            .args([
                "-nostdin",
                "-n",
                "-hide_banner",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(&merged)
            .args(["-c", "copy", "-movflags", "+faststart"])
            .arg(&rendered)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("无法启动 ffmpeg，请先安装 ffmpeg")?;
        let cancelled = async {
            while !cancel.load(Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        };
        let status = tokio::select! {s=child.wait()=>s?,_=cancelled=>{child.kill().await?;return Err(anyhow!("cancelled"));}};
        if !status.success() || !rendered.is_file() || std::fs::metadata(&rendered)?.len() == 0 {
            return Err(anyhow!("视频合并失败，请重试"));
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("cancelled"));
        }
        std::fs::hard_link(&rendered, output).context("无法保存视频，目标可能已存在")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn playback_and_export_share_one_inflight_part_and_resume_after_cancellation() {
        use std::sync::{Arc, atomic::AtomicUsize};
        let dir = std::env::temp_dir().join(format!("onepku-shared-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&dir).unwrap();
        let _cleanup = TemporaryDirectory(dir.clone());
        let path = dir.join("00000.ts");
        let mut bytes = vec![0u8; 188 * 3];
        for i in [0,188,376] { bytes[i] = 0x47; }
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1,Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            Ok(bytes.clone())
        };
        let (playback, export) = tokio::join!(resume_part(&path,fetch),resume_part(&path,fetch));
        assert_eq!(playback.unwrap(),bytes);
        assert_eq!(export.unwrap(),bytes);
        assert_eq!(calls.load(Ordering::SeqCst),1);
        assert_eq!(resume_part(&path,|| async { panic!("completed part must remain reusable") }).await.unwrap(),bytes);

        let second = dir.join("00001.ts");
        let started = Arc::new(tokio::sync::Notify::new());
        let owner = tokio::spawn({let path=second.clone();let started=started.clone();async move {
            resume_part(&path,|| async { started.notify_one(); std::future::pending::<Result<Vec<u8>>>().await }).await
        }});
        started.notified().await;
        owner.abort(); let _ = owner.await;
        assert!(!second.exists());
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(1),resume_part(&second,|| async { Ok(bytes.clone()) })).await.unwrap().unwrap(),bytes);
    }
    #[tokio::test]
    async fn interrupted_download_reuses_only_complete_segments() {
        let dir = std::env::temp_dir().join(format!(
            "onepku-resume-test-{:032x}",
            rand::random::<u128>()
        ));
        std::fs::create_dir(&dir).unwrap();
        let _cleanup = TemporaryDirectory(dir.clone());
        let first = dir.join("00000.ts");
        let second = dir.join("00001.ts");
        let mut data = vec![0; 188 * 3];
        for i in [0, 188, 376] {
            data[i] = 0x47;
        }
        resume_part(&first, || async { Ok(data.clone()) })
            .await
            .unwrap();
        assert!(
            resume_part(&second, || async { Err(anyhow!("network interrupted")) })
                .await
                .is_err()
        );
        assert!(!second.exists());
        let reused = resume_part(&first, || async {
            panic!("must not request completed segment again")
        })
        .await
        .unwrap();
        assert_eq!(reused, data);
        assert!(
            resume_part(&second, || async { Ok(b"<html>login</html>".to_vec()) })
                .await
                .is_err()
        );
        assert!(!second.exists());
        std::fs::write(&second, &data[..200]).unwrap();
        assert_eq!(
            resume_part(&second, || async { Ok(data.clone()) })
                .await
                .unwrap(),
            data
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    }
    #[test]
    fn resumed_cache_survives_new_signatures_but_not_a_changed_recording() {
        let base =
            url::Url::parse("https://resourcese.pku.edu.cn/course/index.m3u8?token=old").unwrap();
        let playlist = |token: &str, path: &str| {
            m3u8_rs::parse_media_playlist(format!("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?token={token}\"\n#EXTINF:10,\n{path}?token={token}\n#EXT-X-ENDLIST\n").as_bytes()).unwrap().1
        };
        let a = resume_signature(&base, &playlist("old", "0.ts")).unwrap();
        assert_eq!(
            a,
            resume_signature(&base, &playlist("renewed", "0.ts")).unwrap()
        );
        assert_ne!(
            a,
            resume_signature(&base, &playlist("renewed", "changed.ts")).unwrap()
        );
        let mut changed_query = playlist("renewed", "0.ts");
        changed_query.segments[0].uri.push_str("&recording=other");
        assert_ne!(a, resume_signature(&base, &changed_query).unwrap());
    }
    #[tokio::test]
    async fn http_failures_are_classified_without_exposing_signed_urls() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for code in [403, 503, 429] {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0; 2048];
                socket.read(&mut request).unwrap();
                write!(
                    socket,
                    "HTTP/1.1 {code} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (code, retry) in [(403, false), (503, true), (429, true)] {
            let error: anyhow::Error = client
                .get(format!("http://{addr}/part?token=private-secret"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap_err()
                .into();
            assert_eq!(retryable_media_error(&error), retry);
            let message = media_failure(&error).to_string();
            assert!(message.contains(&code.to_string()));
            assert!(!message.contains("private-secret"));
            assert!(!message.contains("http://"));
        }
        server.join().unwrap();
    }
    #[test]
    fn playback_does_not_cache_html_or_truncated_video() {
        let mut bytes = vec![0; 188 * 3];
        for i in [0, 188, 376] {
            bytes[i] = 0x47;
        }
        assert!(transport_stream(&bytes));
        assert!(!transport_stream(b"<html>Login</html>"));
        assert!(!transport_stream(&bytes[..bytes.len() - 1]));
        bytes[188] = 0;
        assert!(!transport_stream(&bytes));
    }
    #[test]
    fn media_domains_do_not_accept_lookalikes_or_local_targets() {
        for value in [
            "https://resourcese.pku.edu.cn/v/a.ts",
            "https://yjapise.pku.edu.cn/key",
        ] {
            assert!(media_url(&url::Url::parse(value).unwrap()).is_ok());
        }
        for value in [
            "https://pku.edu.cn.attacker.test/a",
            "file:///tmp/a",
            "http://resourcese.pku.edu.cn/a",
            "https://a:b@resourcese.pku.edu.cn/a",
        ] {
            assert!(media_url(&url::Url::parse(value).unwrap()).is_err());
        }
    }
}
