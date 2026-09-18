//! Reusable, cancellable recording download. No shell, no overwrite, and no
//! playlist URLs are passed to ffmpeg: it only reads a local merged stream.
use super::*;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncWriteExt;

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
        Ok(PlaybackMedia { parts })
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
    async fn bounded_media_bytes(&self, url: &url::Url, limit: usize) -> Result<Vec<u8>> {
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
    pub async fn download_video_to<F>(
        &self,
        video: &VideoInfo,
        output: &Path,
        ffmpeg: &Path,
        cancel: &AtomicBool,
        progress: F,
    ) -> Result<()>
    where
        F: Fn(MediaProgress),
    {
        if output.exists() {
            return Err(anyhow!("目标文件已存在"));
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
            .map(|(i, source, encryption)| async move {
                if cancel.load(Ordering::Relaxed) {
                    return Err(anyhow!("cancelled"));
                }
                let mut data = self.bounded_media_bytes(&source, 32 * 1024 * 1024).await?;
                if let Some((key, iv)) = encryption {
                    data = decrypt_segment(&key, &iv, &data)?;
                }
                Ok::<_, anyhow::Error>((i, data))
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
            progress(MediaProgress {
                phase: "downloading",
                bytes,
                completed: i + 1,
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
        let mut child = command.args([
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
