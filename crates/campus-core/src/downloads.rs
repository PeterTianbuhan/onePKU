use super::*;
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
#[derive(Clone, Serialize, Deserialize)]
pub struct FileRef {
    url: String,
    name: String,
    generation: String,
    #[serde(default)]
    course: String,
    #[serde(default)]
    semester: String,
}
impl FileRef {
    pub(crate) fn valid_for_current_account(&self) -> bool {
        self.generation == fingerprint("course")
            && allowed_url(&self.url)
            && safe_filename(&self.name).is_ok()
    }
}
#[derive(Clone)]
pub struct Job {
    pub state: Value,
    name: String,
    created: i64,
    generation: String,
    cancel: Arc<AtomicBool>,
    source: String,
}
pub(crate) enum DownloadSource {
    File(FileRef),
    Video {
        course: String,
        semester: String,
        video: pku_course::api::VideoInfo,
    },
}
pub(crate) struct Task {
    id: String,
    generation: String,
    cancel: Arc<AtomicBool>,
    source: DownloadSource,
}
pub fn safe_filename(s: &str) -> Result<String> {
    if s.chars().any(|c| c.is_control()) {
        bail!("invalid filename")
    }
    let s = s.trim();
    if s.is_empty()
        || s == "."
        || s == ".."
        || s.len() > 220
        || s.chars().any(|c| "/\\:".contains(c))
    {
        bail!("invalid filename")
    }
    Ok(s.into())
}
pub(crate) fn allowed_url(s: &str) -> bool {
    url::Url::parse(s).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("course.pku.edu.cn")
            && (u.path().starts_with("/bbcswebdav/")
                || (u.path() == "/webapps/assignment/download"
                    && ["course_id", "attempt_id", "file_id"].iter().all(|key| {
                        u.query_pairs()
                            .any(|(k, v)| k == *key && valid_id(&v).is_ok())
                    })
                    && u.query_pairs().all(|(k, _)| {
                        ["course_id", "attempt_id", "file_id", "fileName"].contains(&k.as_ref())
                    })))
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
    })
}
pub(crate) fn attachment_id(generation: &str, url: &str, course: &str, semester: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{generation}{url}{course}{semester}"))
    )
}
fn response_filename(header: Option<&str>, fallback: &str, mime: &str) -> Result<String> {
    if let Some(h) = header {
        for part in h.split(';').map(str::trim) {
            if let Some(raw) = part.strip_prefix("filename*=").and_then(|v| {
                v.strip_prefix("UTF-8''")
                    .or_else(|| v.strip_prefix("utf-8''"))
            }) {
                let name =
                    percent_encoding::percent_decode_str(raw.trim_matches('"')).decode_utf8()?;
                return safe_filename(&name);
            }
        }
        for part in h.split(';').map(str::trim) {
            if let Some(raw) = part.strip_prefix("filename=") {
                return safe_filename(raw.trim_matches('"'));
            }
        }
    }
    let mut name = safe_filename(fallback)?;
    if Path::new(&name).extension().is_none() {
        if mime.contains("application/pdf") {
            name.push_str(".pdf")
        } else if mime.contains("presentationml") {
            name.push_str(".pptx")
        } else if mime.contains("wordprocessingml") {
            name.push_str(".docx")
        }
    }
    safe_filename(&name)
}
fn finish_file(temp: &Path, dir: &Path, name: &str) -> Result<PathBuf> {
    let name = safe_filename(name)?;
    for n in 0..100 {
        let final_path = dir.join(if n == 0 {
            name.clone()
        } else {
            format!("({n}) {name}")
        });
        match std::fs::hard_link(temp, &final_path) {
            Ok(_) => return Ok(final_path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("too many duplicate files")
}
/// 默认保存目录：~/Downloads/OnePKU。
pub(crate) fn default_download_root() -> Result<PathBuf> {
    directories::UserDirs::new()
        .and_then(|d| d.download_dir().map(|p| p.join("OnePKU")))
        .ok_or_else(|| anyhow!("Downloads unavailable"))
}
/// 用户在设置里选的目录必须是已存在、可写的绝对路径目录。
pub(crate) fn validate_download_root(path: &std::path::Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("请选择一个完整路径的文件夹");
    }
    let meta = std::fs::metadata(path).map_err(|_| anyhow!("文件夹不存在或无法访问"))?;
    if !meta.is_dir() {
        bail!("所选位置不是文件夹");
    }
    let probe = path.join(format!(".onepku-write-test-{}", rand::random::<u64>()));
    std::fs::write(&probe, b"").map_err(|_| anyhow!("这个文件夹不可写"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(path.canonicalize()?)
}
/// 当前生效的保存目录：偏好里有合法值就用它，否则回到默认。
pub(crate) fn download_root() -> Result<PathBuf> {
    if let Some(p) = crate::maintenance::read_preferences()
        .get("downloadRoot")
        .and_then(|v| v.as_str())
    {
        let path = PathBuf::from(p);
        if path.is_absolute() && path.is_dir() {
            return Ok(path);
        }
    }
    default_download_root()
}
pub(crate) fn download_root_info() -> Value {
    let effective = download_root().ok();
    let default = default_download_root().ok();
    json!({
        "downloadRoot": effective.as_ref().map(|p| p.to_string_lossy().to_string()),
        "downloadRootIsDefault": effective.is_some() && effective == default,
    })
}
pub(crate) fn set_download_root(path: Option<&std::path::Path>) -> Result<Value> {
    match path {
        Some(p) => {
            let canon = validate_download_root(p)?;
            crate::maintenance::write_preference(
                "downloadRoot",
                Value::String(canon.to_string_lossy().to_string()),
            )?;
        }
        None => crate::maintenance::write_preference("downloadRoot", Value::Null)?,
    }
    Ok(download_root_info())
}
pub(crate) fn archive_directory(semester: &str, course: &str) -> Result<PathBuf> {
    Ok(archive_directory_at(&download_root()?, semester, course))
}
pub(crate) fn archive_directory_at(root: &Path, semester: &str, course: &str) -> PathBuf {
    root.join(folder_component(semester))
        .join(folder_component(course))
}
pub(crate) fn folder_component(s: &str) -> String {
    let v: String = s
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(65)
        .collect();
    let v = v.trim().trim_matches('.');
    if v.is_empty() {
        "课程".into()
    } else {
        v.into()
    }
}
fn file_digest(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub(crate) fn finish_archive(temp: &Path, dir: &Path, name: &str, hash: &str) -> Result<PathBuf> {
    for n in 0..100 {
        let path = dir.join(if n == 0 {
            name.to_string()
        } else {
            format!("({n}) {name}")
        });
        if path.is_file() && !path.is_symlink() && file_digest(&path)? == hash {
            return Ok(path);
        }
    }
    finish_file(temp, dir, name)
}
async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await
    }
}
impl Core {
    pub(crate) fn replay_download_active(&self, course: &str, video: &str) -> bool {
        let source = format!("video:{course}:{video}");
        self.jobs.lock().unwrap().values().any(|j| {
            j.source == source && matches!(j.state["state"].as_str(), Some("queued" | "running"))
        })
    }
    pub(crate) fn register_files(&self, rows: &mut Vec<Value>) {
        let generation = fingerprint("course");
        for r in rows {
            let course = if let Some(id) = r["course_id"].as_str() {
                format!("{} {}", r["course_name"].as_str().unwrap_or("课程"), id)
            } else {
                String::new()
            };
            let semester = r["semester"].as_str().unwrap_or("未标注学期").to_string();
            if let Some(a) = r.get_mut("attachments").and_then(Value::as_array_mut) {
                for f in a {
                    let raw = f["url"].as_str().unwrap_or("");
                    let url = if raw.starts_with('/') {
                        format!("https://course.pku.edu.cn{raw}")
                    } else {
                        raw.into()
                    };
                    let matching_course = url::Url::parse(&url).is_ok_and(|u| {
                        u.path() != "/webapps/assignment/download"
                            || u.query_pairs().any(|(k, v)| {
                                k == "course_id" && course.ends_with(&format!(" {v}"))
                            })
                    });
                    if !allowed_url(&url) || !matching_course {
                        f.as_object_mut().unwrap().remove("url");
                        continue;
                    }
                    let id = attachment_id(&generation, &url, &course, &semester);
                    let mut files = self.files.lock().unwrap();
                    if files.len() > 10000 {
                        files.clear()
                    }
                    files.insert(
                        id.clone(),
                        FileRef {
                            url,
                            name: f["name"].as_str().unwrap_or("附件").into(),
                            generation: generation.clone(),
                            course: course.clone(),
                            semester: semester.clone(),
                        },
                    );
                    f["downloadId"] = json!(id);
                    f.as_object_mut().unwrap().remove("url");
                }
            }
        }
    }
    fn download_queue(self: &Arc<Self>) -> std::sync::mpsc::SyncSender<Task> {
        let mut slot = self.download_queue.lock().unwrap();
        if let Some(queue) = slot.as_ref() {
            return queue.clone();
        }
        let (send, recv) = std::sync::mpsc::sync_channel::<Task>(200);
        let recv = Arc::new(Mutex::new(recv));
        for _ in 0..3 {
            let recv = recv.clone();
            let weak = Arc::downgrade(self);
            std::thread::spawn(move || loop {
                let task = { recv.lock().unwrap().recv() };
                let (Ok(task), Some(core)) = (task, weak.upgrade()) else {
                    break;
                };
                core.run_download(task);
            });
        }
        *slot = Some(send.clone());
        send
    }
    fn enqueue_download(
        self: &Arc<Self>,
        source_key: String,
        name: String,
        source: DownloadSource,
    ) -> Result<Value> {
        let generation = fingerprint("course");
        let queue = self.download_queue();
        let mut jobs = self.jobs.lock().unwrap();
        if let Some((id, _)) = jobs.iter().find(|(_, j)| {
            j.generation == generation
                && j.source == source_key
                && matches!(j.state["state"].as_str(), Some("queued" | "running"))
        }) {
            return Ok(json!({"id":id,"existing":true}));
        }
        if jobs
            .values()
            .filter(|j| matches!(j.state["state"].as_str(), Some("queued" | "running")))
            .count()
            >= 200
        {
            bail!("下载队列已满，请等待或取消部分任务")
        }
        if jobs.len() >= 250 {
            let oldest = jobs
                .iter()
                .filter(|(_, j)| !matches!(j.state["state"].as_str(), Some("queued" | "running")))
                .min_by_key(|(_, j)| j.created)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                jobs.remove(&id);
            }
        }
        let id = format!("{:032x}", rand::random::<u128>());
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id.clone(),
            Job {
                state: json!({"state":"queued","bytes":0}),
                name,
                created: chrono::Utc::now().timestamp_millis(),
                generation: generation.clone(),
                cancel: cancel.clone(),
                source: source_key,
            },
        );
        if queue
            .try_send(Task {
                id: id.clone(),
                generation,
                cancel,
                source,
            })
            .is_err()
        {
            jobs.remove(&id);
            bail!("下载队列已满，请稍后重试")
        }
        Ok(json!({"id":id}))
    }
    fn run_download(self: &Arc<Self>, task: Task) {
        if task.cancel.load(Ordering::Relaxed) || task.generation != fingerprint("course") {
            if let Some(j) = self.jobs.lock().unwrap().get_mut(&task.id) {
                j.state = json!({"state":"cancelled"});
            }
            return;
        }
        if let Some(j) = self.jobs.lock().unwrap().get_mut(&task.id) {
            j.state = json!({"state":"running","phase":"preparing","bytes":0});
        }
        let id = &task.id;
        let cancel = task.cancel.clone();
        let seconds = if matches!(&task.source, DownloadSource::Video { .. }) {
            7200
        } else {
            300
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result=rt.block_on(async {tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(seconds),async {
                match task.source {
                    DownloadSource::File(f)=>self.save_file(id,f,cancel.clone()).await,
                    DownloadSource::Video{course,semester,video}=>self.save_video(id,&course,&semester,&video,&task.generation,cancel.clone()).await,
                }
            })=>r.map_err(|_|anyhow!("下载超时，请重试")).and_then(|v|v),
            _=cancelled(&cancel)=>Err(anyhow!("cancelled"))
        }});
        let state = match result {
            Ok(path) => json!({"state":"done","path":path}),
            Err(_)
                if cancel.load(Ordering::Relaxed) || task.generation != fingerprint("course") =>
            {
                json!({"state":"cancelled"})
            }
            Err(e) => {
                let raw = e.to_string();
                let message = if raw.contains("会话已过期")
                    || raw.contains("登录已失效")
                    || raw.contains("未登录")
                {
                    "登录已失效，请重新登录教学网后重试"
                } else if raw.starts_with("无法启动 ffmpeg") {
                    "视频转换需要 ffmpeg，请安装后重试"
                } else if e
                    .downcast_ref::<reqwest::Error>()
                    .is_some_and(|e| e.is_timeout())
                {
                    "下载请求超时，请稍后重试"
                } else if e.downcast_ref::<reqwest::Error>().is_some() {
                    "下载服务连接失败，请检查网络后重试"
                } else if e.downcast_ref::<std::io::Error>().is_some() {
                    "本地文件写入失败，请检查保存目录权限和磁盘空间后重试"
                } else if raw.starts_with("视频")
                    || raw.starts_with("回放")
                    || raw.starts_with("当前不是")
                    || raw.starts_with("此回放")
                    || raw.starts_with("下载超时")
                {
                    raw.as_str()
                } else if raw.contains("file too large") {
                    "文件超过 100 MB，请在教学网下载"
                } else {
                    "下载未完成，请刷新来源后重试"
                };
                let previous = self
                    .jobs
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|j| j.state.clone())
                    .unwrap_or_default();
                json!({"state":"failed","message":message,"bytes":previous["bytes"],"completed":previous["completed"],"segments":previous["segments"]})
            }
        };
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            j.state = state;
        }
    }
    pub(crate) fn download(self: &Arc<Self>, id: &str) -> Result<Value> {
        let f = self
            .files
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("请刷新课程"))?;
        if !f.valid_for_current_account() {
            bail!("账号已过期，请刷新课程")
        }
        self.enqueue_download(
            format!("file:{id}"),
            f.name.clone(),
            DownloadSource::File(f),
        )
    }
    pub(crate) fn download_batch(self: &Arc<Self>, ids: &[String]) -> Result<Value> {
        if ids.is_empty() || ids.len() > 200 {
            bail!("请选择 1 至 200 个文件")
        }
        let mut accepted = Vec::new();
        let mut failures = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if !seen.insert(id) {
                continue;
            }
            match self.download(id) {
                Ok(job) => accepted.push(job),
                Err(_) => failures.push(id),
            }
        }
        Ok(json!({"accepted":accepted,"failed":failures}))
    }
    pub(crate) async fn download_video(
        self: &Arc<Self>,
        course: &str,
        video_id: &str,
    ) -> Result<Value> {
        let c = self.find_course(course).await?;
        let video = self
            .course_api()?
            .list_videos(course, c["name"].as_str().unwrap_or("课程"))
            .await?
            .into_iter()
            .find(|v| v.hash_id == video_id)
            .ok_or_else(|| anyhow!("回放已变化，请刷新列表"))?;
        let semester = c["semester"].as_str().unwrap_or("未标注学期").to_string();
        self.enqueue_download(
            format!("video:{course}:{video_id}"),
            format!("{} · {}", video.course_name, video.time),
            DownloadSource::Video {
                course: course.into(),
                semester,
                video,
            },
        )
    }
    async fn save_video(
        &self,
        id: &str,
        course: &str,
        semester: &str,
        video: &pku_course::api::VideoInfo,
        generation: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<String> {
        let api = self.course_api()?;
        let dir = archive_directory(semester, &format!("{} {}", video.course_name, course))?
            .join("课程回放");
        std::fs::create_dir_all(&dir)?;
        let temp = dir.join(format!(".onepku-{id}.mp4"));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(temp.clone());
        let account = self
            .course_account(generation)
            .await
            .unwrap_or_else(|_| generation.into());
        let resume = playback::shared_cache_root(&account, course, &video.hash_id)?;
        let dirs = directories::ProjectDirs::from("me", "petertian", "OnePKU")
            .ok_or_else(|| anyhow!("无法定位回放缓存"))?;
        let playback_cache = playback::adopt_account_cache(
            &dirs.cache_dir().join("playback-v1"),
            &accounts::root()?,
            &account,
            course,
            &video.hash_id,
        )?;
        let ffmpeg = [
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/usr/bin/ffmpeg",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"));
        api.download_video_to(video,&temp,&resume,&ffmpeg,&cancel,|p| {if generation!=fingerprint("course") {cancel.store(true,Ordering::Relaxed);}if let Some(j)=self.jobs.lock().unwrap().get_mut(id) {j.state=json!({"state":"running","phase":p.phase,"bytes":p.bytes,"completed":p.completed,"segments":p.total});}},
            |signature, legacy, count, shared| playback::reuse_playback_parts(&playback_cache,shared,course,&video.hash_id,signature,legacy,count)).await?;
        if cancel.load(Ordering::Relaxed) || generation != fingerprint("course") {
            bail!("cancelled")
        }
        let filename = format!(
            "{} {}.mp4",
            folder_component(&video.title),
            folder_component(&video.time)
        );
        let hash = file_digest(&temp)?;
        if cancel.load(Ordering::Relaxed) || generation != fingerprint("course") {
            bail!("cancelled")
        }
        let path = finish_archive(&temp, &dir, &filename, &hash)?;
        let meta = json!({"title":video.title,"time":video.time,"course":course,"semester":semester,"source":"教学网课堂实录","recordingId":video.hash_id,"sha256":hash,"downloadedAt":chrono::Utc::now().to_rfc3339()});
        let sidecar = path.with_file_name(format!(
            "{}.source.json",
            path.file_name().unwrap().to_string_lossy()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(sidecar)
        {
            Ok(mut f) => {
                f.write_all(&serde_json::to_vec_pretty(&meta)?)?;
                f.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        Ok(path.display().to_string())
    }
    async fn save_file(&self, id: &str, f: FileRef, cancel: Arc<AtomicBool>) -> Result<String> {
        let store = Store::new("course")?;
        let builder = reqwest::Client::builder()
            .cookie_provider(store.load_cookie_store()?)
            .timeout(Duration::from_secs(240))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() < 8 && allowed_url(a.url().as_str()) {
                    a.follow()
                } else {
                    a.stop()
                }
            }));
        let client = pkuinfo_common::tls::apply_extra_roots(builder)?.build()?;
        let mut res = client.get(&f.url).send().await?.error_for_status()?;
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if !allowed_url(res.url().as_str())
            || res.status().is_redirection()
            || mime.contains("text/html")
        {
            bail!("invalid response")
        }
        let total = res.content_length();
        if total.unwrap_or(0) > 100 * 1024 * 1024 {
            bail!("file too large")
        }
        let filename = response_filename(
            res.headers()
                .get("content-disposition")
                .and_then(|v| v.to_str().ok()),
            &f.name,
            mime,
        )?;
        let dir = if f.course.is_empty() {
            download_root()?
        } else {
            archive_directory(&f.semester, &f.course)?
        };
        std::fs::create_dir_all(&dir)?;
        let temp = dir.join(format!(".onepku-{id}.part"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(temp.clone());
        let mut bytes = 0;
        while let Some(chunk) = res.chunk().await? {
            if cancel.load(Ordering::Relaxed) {
                bail!("cancelled")
            }
            bytes += chunk.len();
            if bytes > 100 * 1024 * 1024 {
                bail!("file too large")
            }
            file.write_all(&chunk)?;
            if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
                j.state = json!({"state":"running","bytes":bytes,"total":total});
            }
        }
        file.sync_all()?;
        if cancel.load(Ordering::Relaxed) || f.generation != fingerprint("course") {
            bail!("cancelled")
        }
        let digest = file_digest(&temp)?;
        if cancel.load(Ordering::Relaxed) || f.generation != fingerprint("course") {
            bail!("cancelled")
        }
        let path = finish_archive(&temp, &dir, &filename, &digest)?;
        let metadata = json!({"name":filename,"course":f.course,"semester":f.semester,"source":f.url,"sha256":digest,"size":bytes,"downloadedAt":chrono::Utc::now().to_rfc3339()});
        let sidecar = path.with_file_name(format!(
            "{}.source.json",
            path.file_name().unwrap().to_string_lossy()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(sidecar)
        {
            Ok(mut out) => {
                out.write_all(&serde_json::to_vec_pretty(&metadata)?)?;
                out.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        Ok(path.display().to_string())
    }
    pub(crate) fn download_status(&self, id: &str) -> Result<Value> {
        Ok(self
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .filter(|job| job.generation == fingerprint("course"))
            .ok_or_else(|| anyhow!("missing job"))?
            .state
            .clone())
    }
    pub(crate) async fn download_retry(self: &Arc<Self>, id: &str) -> Result<Value> {
        let source = {
            let jobs = self.jobs.lock().unwrap();
            let job = jobs
                .get(id)
                .filter(|j| j.generation == fingerprint("course"))
                .ok_or_else(|| anyhow!("下载记录已过期，请从课程重新下载"))?;
            if !matches!(job.state["state"].as_str(), Some("failed" | "cancelled")) {
                bail!("此下载无需重试");
            }
            job.source.clone()
        };
        if let Some(id) = source.strip_prefix("file:") {
            return self.download(id);
        }
        if let Some((course, video)) = source
            .strip_prefix("video:")
            .and_then(|s| s.split_once(':'))
        {
            return self.download_video(course, video).await;
        }
        bail!("下载来源已失效，请刷新课程")
    }
    pub(crate) fn downloads(&self) -> Value {
        let jobs = self.jobs.lock().unwrap();
        let generation = fingerprint("course");
        let mut rows = jobs
            .iter()
            .filter(|(_, j)| j.generation == generation)
            .map(|(id, j)| {
                let mut v = j.state.clone();
                v["id"] = json!(id);
                v["name"] = json!(j.name);
                v["created"] = json!(j.created);
                v
            })
            .collect::<Vec<_>>();
        rows.sort_by_key(|v| -v["created"].as_i64().unwrap_or(0));
        json!(rows)
    }
    pub(crate) fn download_cancel(&self, id: &str) -> Result<Value> {
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            if matches!(j.state["state"].as_str(), Some("running" | "queued")) {
                j.cancel.store(true, Ordering::Relaxed);
                if j.state["state"] == "queued" {
                    j.state = json!({"state":"cancelled"});
                }
            }
        }
        Ok(json!({"cancelled":true}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_root_validation_rejects_relative_missing_and_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_download_root(std::path::Path::new("relative/dir")).is_err());
        assert!(validate_download_root(&dir.path().join("missing")).is_err());
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_download_root(&file).is_err());
        let ok = validate_download_root(dir.path()).unwrap();
        assert!(ok.is_absolute() && ok.is_dir());
        assert!(!std::fs::read_dir(dir.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".onepku-write-test")));
    }
    #[test]
    fn download_only_accepts_authenticated_file_paths() {
        assert!(allowed_url("https://course.pku.edu.cn/bbcswebdav/xid-1"));
        assert!(allowed_url("https://course.pku.edu.cn/webapps/assignment/download?course_id=_1_1&attempt_id=_2_1&file_id=_3_1&fileName=a.zip"));
        for u in [
            "https://course.pku.edu.cn/webapps/assignment/download?course_id=_1_1&attempt_id=_2_1&file_id=_3_1&action=delete",
            "https://course.pku.edu.cn/webapps/assignment/download?course_id=_1_1",
            "http://course.pku.edu.cn/bbcswebdav/xid-1",
            "https://course.pku.edu.cn/logout",
            "https://evil.test/bbcswebdav/xid-1",
            "https://course.pku.edu.cn.evil.test/bbcswebdav/xid-1",
        ] {
            assert!(!allowed_url(u));
        }
    }
    #[test]
    fn header_names_keep_unicode_and_reject_traversal() {
        assert_eq!(
            response_filename(
                Some("attachment; filename*=UTF-8''%E8%AE%B2%E4%B9%89.pdf"),
                "fallback",
                ""
            )
            .unwrap(),
            "讲义.pdf"
        );
        assert!(response_filename(Some("attachment; filename=../x"), "fallback", "").is_err());
        assert_eq!(
            response_filename(None, "lecture", "application/pdf").unwrap(),
            "lecture.pdf"
        );
    }
    #[test]
    fn archive_deduplicates_content_but_preserves_versions() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join(".part");
        std::fs::write(&temp, b"same").unwrap();
        let hash = file_digest(&temp).unwrap();
        let one = finish_archive(&temp, dir.path(), "讲义.pdf", &hash).unwrap();
        assert_eq!(
            finish_archive(&temp, dir.path(), "讲义.pdf", &hash).unwrap(),
            one
        );
        std::fs::remove_file(&temp).unwrap();
        std::fs::write(&temp, b"revised").unwrap();
        let two =
            finish_archive(&temp, dir.path(), "讲义.pdf", &file_digest(&temp).unwrap()).unwrap();
        assert_ne!(one, two);
        assert_eq!(std::fs::read(one).unwrap(), b"same");
        assert!(!folder_component("../../测试/目录").contains('/'));
    }
    #[test]
    fn completing_download_never_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join(".part");
        std::fs::write(&temp, b"new").unwrap();
        std::fs::write(dir.path().join("lecture.pdf"), b"original").unwrap();
        let path = finish_file(&temp, dir.path(), "lecture.pdf").unwrap();
        assert_eq!(path.file_name().unwrap(), "(1) lecture.pdf");
        assert_eq!(
            std::fs::read(dir.path().join("lecture.pdf")).unwrap(),
            b"original"
        );
        assert_eq!(std::fs::read(path).unwrap(), b"new");
    }
}
