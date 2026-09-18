//! Durable subtitles, independent of the video cache and replaceable ASR engines.
use crate::platform::PrivateOpenOptions;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use super::*;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const CHUNK_SECONDS: f64 = 60.0;
const MAX_TEXT: u64 = 10 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize, Debug)]
struct Cue {
    start: f64,
    end: f64,
    text: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Document {
    version: u32,
    signature: String,
    source: String,
    cues: Vec<Cue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    progress: Option<Coverage>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Coverage {
    completed: f64,
    total: f64,
    provider: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Provider {
    label: String,
    #[serde(default = "default_engine")]
    engine: String,
    python: PathBuf,
    model: String,
    ffmpeg: PathBuf,
    #[serde(default)]
    adapter: Option<PathBuf>,
}
struct Job {
    state: Mutex<Value>,
    cancel: AtomicBool,
    active: AtomicBool,
}
#[derive(Default)]
pub(crate) struct SubtitleStore {
    jobs: HashMap<String, Arc<Job>>,
}
fn root() -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位字幕目录"))?
        .data_local_dir()
        .to_path_buf())
}
fn default_engine() -> String {
    "mlx-whisper".into()
}
fn provider() -> Result<Provider> {
    let root = root()?;
    let path = root.join("subtitles-provider.json");
    if path.exists() {
        return Ok(serde_json::from_slice(&fs::read(path)?)?);
    }
    Ok(Provider {
        label: "Whisper Small · 本机".into(),
        engine: default_engine(),
        python: root.join("subtitles-runtime/bin/python"),
        model: "mlx-community/whisper-small-mlx".into(),
        ffmpeg: PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        adapter: None,
    })
}
struct ModelSpec {
    id: &'static str,
    label: &'static str,
    repo: &'static str,
    engine: &'static str,
    weight: &'static str,
    hint: &'static str,
}
const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "belle-zh",
        label: "Belle Whisper 中文 · 本机",
        repo: "mlx-community/belle-whisper-large-v3-turbo-zh-8bit",
        engine: "mlx-audio",
        weight: "model.safetensors",
        hint: "中文课程模型",
    },
    ModelSpec {
        id: "whisper-small",
        label: "Whisper Small · 本机",
        repo: "mlx-community/whisper-small-mlx",
        engine: "mlx-whisper",
        weight: "weights.npz",
        hint: "通用多语言模型",
    },
    ModelSpec {
        id: "whisper-tiny",
        label: "Whisper Tiny · 本机",
        repo: "mlx-community/whisper-tiny",
        engine: "mlx-whisper",
        weight: "weights.npz",
        hint: "较小的多语言模型",
    },
];
fn model_hub() -> Result<PathBuf> {
    Ok(directories::BaseDirs::new()
        .ok_or_else(|| anyhow!("无法定位本机模型"))?
        .home_dir()
        .join(".cache/huggingface/hub"))
}
fn cached_model(hub: &Path, spec: &ModelSpec) -> Option<PathBuf> {
    let repository = hub.join(format!("models--{}", spec.repo.replace('/', "--")));
    let snapshots = repository.join("snapshots");
    let mut candidates = vec![];
    if let Ok(revision) = fs::read_to_string(repository.join("refs/main")) {
        let revision = revision.trim();
        if !revision.is_empty() && revision.chars().all(|c| c.is_ascii_hexdigit()) {
            candidates.push(snapshots.join(revision));
        }
    }
    let mut others: Vec<_> = fs::read_dir(&snapshots)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    others.sort();
    candidates.extend(others);
    candidates
        .into_iter()
        .find(|p| p.join("config.json").is_file() && p.join(spec.weight).is_file())
}
fn selected_model(p: &Provider, hub: &Path) -> String {
    MODELS
        .iter()
        .find(|spec| {
            p.adapter.is_none()
                && p.engine == spec.engine
                && (p.model == spec.repo
                    || cached_model(hub, spec)
                        .is_some_and(|path| path == Path::new(&p.model)))
        })
        .map_or_else(|| "custom".into(), |spec| spec.id.into())
}
fn native_install_supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}
fn provider_problem(p: &Provider) -> Option<&'static str> {
    if p.adapter.is_none() && !native_install_supported() {
        return Some("此平台暂不提供内置字幕识别模型；仍可导入 SRT / VTT、播放和保存字幕。");
    }
    if [&p.python, &p.ffmpeg].iter().any(|path| {
        !platform::executable(path)
    }) {
        return Some("本机字幕组件尚未安装，仍可导入 SRT / VTT。可在设置中查看安装步骤。");
    }
    if let Some(adapter) = &p.adapter {
        return (!adapter.is_file()).then_some("字幕适配器文件不存在，请检查本机配置。");
    }
    let model = Path::new(&p.model);
    let present = if model.is_absolute() {
        model.join("config.json").is_file()
            && match p.engine.as_str() {
                "mlx-audio" => model.join("model.safetensors").is_file(),
                "mlx-whisper" => model.join("weights.npz").is_file(),
                _ => false,
            }
    } else {
        model_hub().ok().is_some_and(|hub| {
            MODELS.iter().any(|spec| {
                p.model == spec.repo
                    && p.engine == spec.engine
                    && cached_model(&hub, spec).is_some()
            })
        })
    };
    (!present).then_some("字幕模型尚未安装完整，请按设置中的安装步骤修复；已有字幕仍可使用。")
}
fn model_settings(p: &Provider, hub: &Path) -> Value {
    let current = selected_model(p, hub);
    let mut models: Vec<Value> = MODELS
        .iter()
        .filter(|spec| cached_model(hub, spec).is_some())
        .map(|spec| json!({"id":spec.id,"label":spec.label,"hint":spec.hint}))
        .collect();
    if !models.iter().any(|m| m["id"] == current) {
        models.insert(0, json!({"id":current,"label":p.label,"hint":"当前配置"}));
    }
    json!({"model":current,"models":models,"available":provider_problem(p).is_none(),"custom":p.adapter.is_some(),"nativeInstallSupported":native_install_supported(),"setupMessage":provider_problem(p)})
}
fn select_model(mut p: Provider, id: &str, hub: &Path) -> Result<Provider> {
    if id == selected_model(&p, hub) {
        return Ok(p);
    }
    let spec = MODELS
        .iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| anyhow!("请选择已安装的字幕模型"))?;
    let path = cached_model(hub, spec).ok_or_else(|| anyhow!("模型文件不完整，请先安装该模型"))?;
    p.label = spec.label.into();
    p.model = path.to_string_lossy().into_owned();
    p.engine = spec.engine.into();
    p.adapter = None;
    Ok(p)
}
fn key(account: &str, course: &str, video: &str) -> String {
    format!(
        "{account}/{:x}",
        Sha256::digest(format!("{course}|{video}"))
    )
}
fn disk_claim(name: &str) -> Result<fs::File> {
    let directory = root()?.join("subtitle-locks");
    fs::create_dir_all(&directory)?;
    platform::private_directory(&directory)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .private_mode()
        .open(directory.join(format!("{:x}.lock", Sha256::digest(name))))?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| anyhow!("已有字幕正在处理，请稍后重试"))?;
    Ok(file)
}
fn session_key(session: &playback::Session) -> String {
    let (course, video, _) = session.subtitle_identity();
    key(&session.subtitle_account, course, video)
}
fn document_path(session: &playback::Session) -> Result<PathBuf> {
    Ok(root()?
        .join(if session.subtitle_account == session.generation {
            "subtitles-v1"
        } else {
            "subtitles-v2"
        })
        .join(session_key(session))
        .join("subtitles.json"))
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("字幕目录无效"))?;
    fs::create_dir_all(parent)?;
    platform::private_directory(parent)?;
    let temporary = path.with_extension(format!("{:016x}.part", rand::random::<u64>()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .private_mode()
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn validate(cues: &mut Vec<Cue>, duration: f64) -> Result<()> {
    if cues.is_empty() {
        bail!("没有识别到可用字幕；原有字幕已保留");
    }
    if cues.len() > 50000 {
        bail!("字幕条目过多");
    }
    for cue in cues.iter_mut() {
        if !cue.start.is_finite()
            || !cue.end.is_finite()
            || cue.start < 0.0
            || cue.end <= cue.start
            || cue.end > duration + 60.0
            || cue.text.len() > 12000
        {
            bail!("字幕时间轴或文本无效，请检查文件");
        }
        cue.text = ammonia::Builder::default()
            .tags(std::collections::HashSet::new())
            .clean(&cue.text)
            .to_string();
        cue.text = cue
            .text
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .trim()
            .to_string();
    }
    cues.retain(|cue| !cue.text.is_empty());
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    if cues.is_empty() {
        bail!("字幕没有可显示的文本");
    }
    Ok(())
}
fn timestamp(input: &str) -> Result<f64> {
    let fields = input
        .trim()
        .replace(',', ".")
        .split(':')
        .map(str::parse::<f64>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let (h, m, s) = match fields.as_slice() {
        [m, s] => (0.0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => bail!("字幕时间格式无效"),
    };
    if h < 0.0 || m < 0.0 || m >= 60.0 || s < 0.0 || s >= 60.0 {
        bail!("字幕时间格式无效");
    }
    Ok(h * 3600.0 + m * 60.0 + s)
}
fn parse_subtitles(text: &str, duration: f64) -> Result<Vec<Cue>> {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut cues = Vec::new();
    for block in normalized.split("\n\n") {
        let lines: Vec<_> = block.lines().collect();
        if lines
            .first()
            .is_some_and(|line| line.starts_with("NOTE") || *line == "STYLE" || *line == "REGION")
        {
            continue;
        }
        let Some(index) = lines.iter().position(|line| line.contains("-->")) else {
            continue;
        };
        let (start, end) = lines[index].split_once("-->").unwrap();
        cues.push(Cue {
            start: timestamp(start)?,
            end: timestamp(end.split_whitespace().next().unwrap_or(""))?,
            text: lines[index + 1..].join("\n"),
        });
    }
    validate(&mut cues, duration)?;
    Ok(cues)
}
fn partial_path(session: &playback::Session) -> Result<PathBuf> {
    Ok(document_path(session)?.with_file_name("subtitles.partial.json"))
}
fn merge_partial(original: Option<Document>, partial: Option<Document>) -> Option<Document> {
    let Some(mut partial) = partial else {
        return original;
    };
    let covered = partial.progress.as_ref()?.completed;
    if let Some(original) = original {
        partial.cues.extend(
            original
                .cues
                .into_iter()
                .filter(|cue| (cue.start + cue.end) / 2.0 >= covered)
                .map(|mut cue| {
                    cue.start = cue.start.max(covered);
                    cue
                }),
        );
        partial.cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    }
    Some(partial)
}
fn saved(session: &playback::Session) -> Result<Option<Document>> {
    let signature = session.subtitle_identity().2;
    let duration = session.duration();
    Ok(merge_partial(
        read_document(&document_path(session)?, signature, duration)?,
        read_document(&partial_path(session)?, signature, duration)?,
    ))
}
fn read_document(path: &Path, signature: &str, duration: f64) -> Result<Option<Document>> {
    if !path.exists() {
        return Ok(None);
    }
    if path.is_symlink() || fs::metadata(&path)?.len() > MAX_TEXT {
        bail!("字幕文件无效");
    }
    let mut doc: Document = serde_json::from_slice(&fs::read(path)?)?;
    if doc.version != 1 || doc.signature != signature {
        return Ok(None);
    }
    if let Some(progress) = &doc.progress {
        if !progress.completed.is_finite()
            || !progress.total.is_finite()
            || progress.completed <= 0.0
            || progress.completed > progress.total
            || (progress.total - duration).abs() > 0.1
        {
            bail!("字幕进度无效");
        }
        // A completed silent chunk is valid coverage, not a failed recognition.
        if !doc.cues.is_empty() {
            validate(&mut doc.cues, duration)?;
        }
    } else {
        validate(&mut doc.cues, duration)?;
    }
    Ok(Some(doc))
}
fn run_child(mut command: Command, job: &Job, generation: &str, log: &Path) -> Result<()> {
    platform::quiet_command(&mut command);
    let output = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .private_mode()
        .open(log)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(output));
    let mut child = command
        .spawn()
        .map_err(|_| anyhow!("本机识别程序未能启动，请检查字幕运行环境"))?;
    let started = Instant::now();
    loop {
        if job.cancel.load(Ordering::Relaxed)
            || generation != fingerprint("course")
            || started.elapsed() > Duration::from_secs(4 * 3600)
        {
            let _ = child.kill();
            let _ = child.wait();
            bail!("已停止生成，已完成的字幕已保存；可继续生成");
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("本段识别未完成，请检查模型或重试；已完成的字幕已保存");
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
fn provider_key(provider: &Provider) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(provider)?);
    if let Some(path) = &provider.adapter {
        hash.update(fs::read(path)?);
    } else {
        hash.update(include_bytes!("../../../scripts/subtitles/mlx_provider.py"));
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn checkpoint_chunk(
    doc: &mut Document,
    mut cues: Vec<Cue>,
    start: f64,
    end: f64,
    audio_start: f64,
) -> Result<()> {
    let progress = doc
        .progress
        .as_mut()
        .ok_or_else(|| anyhow!("缺少分段进度"))?;
    if (progress.completed - start).abs() > 0.01 || end <= start || end > progress.total {
        bail!("字幕分段进度不连续");
    }
    if !cues.is_empty() {
        validate(&mut cues, end - audio_start)?;
    }
    for mut cue in cues {
        cue.start += audio_start;
        cue.end += audio_start;
        if !(start..end).contains(&((cue.start + cue.end) / 2.0)) {
            continue;
        }
        cue.start = cue.start.max(start);
        cue.end = cue.end.min(end);
        if cue.end > cue.start {
            doc.cues.push(cue);
        }
    }
    if doc.cues.len() > 50000 {
        bail!("字幕条目过多");
    }
    doc.cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    progress.completed = end;
    Ok(())
}
fn generate(
    session: &Arc<playback::Session>,
    job: &Job,
    provider: &Provider,
    directory: &Path,
) -> Result<()> {
    fs::create_dir_all(directory)?;
    platform::private_directory(directory)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let total = session.duration();
    let signature = session.subtitle_identity().2;
    let provider_id = provider_key(provider)?;
    let mut doc = read_document(&partial_path(session)?, signature, total)?
        .filter(|doc| {
            doc.progress.as_ref().is_some_and(|p| {
                p.provider == provider_id && (p.completed < total || !doc.cues.is_empty())
            })
        })
        .unwrap_or_else(|| Document {
            version: 1,
            signature: signature.into(),
            source: provider.label.clone(),
            cues: vec![],
            progress: Some(Coverage {
                completed: 0.0,
                total,
                provider: provider_id,
            }),
        });
    let adapter = if let Some(path) = &provider.adapter {
        path.clone()
    } else {
        let path = directory.join("provider.py");
        write_private(
            &path,
            include_bytes!("../../../scripts/subtitles/mlx_provider.py"),
        )?;
        path
    };
    while doc.progress.as_ref().unwrap().completed < total {
        if job.cancel.load(Ordering::Relaxed) || session.generation != fingerprint("course") {
            bail!("已停止生成，已完成的字幕已保存；可继续生成");
        }
        let start = doc.progress.as_ref().unwrap().completed;
        let end = (start + CHUNK_SECONDS).min(total);
        let audio_start = (start - 1.0).max(0.0);
        let audio_end = (end + 1.0).min(total);
        let piece = directory.join("piece");
        fs::create_dir_all(&piece)?;
        platform::private_directory(&piece)?;
        *job.state.lock().unwrap() = json!({"state":"preparing","message":"正在下载下一段音频，已完成的字幕可观看","completed":start,"total":total});
        let (media, origin) = runtime.block_on(session.subtitle_media_range(
            &piece,
            audio_start,
            audio_end,
            &job.cancel,
        ))?;
        let audio = piece.join("audio.wav");
        let mut ffmpeg = Command::new(&provider.ffmpeg);
        ffmpeg
            .args([
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-protocol_whitelist",
                "file,crypto,data",
                "-i",
            ])
            .arg(media)
            .args([
                "-ss",
                &format!("{:.6}", audio_start - origin),
                "-t",
                &format!("{:.6}", audio_end - audio_start),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&audio);
        run_child(ffmpeg, job, &session.generation, &piece.join("audio.log"))?;
        let output = piece.join("result.json");
        let request = piece.join("request.json");
        write_private(
            &request,
            &serde_json::to_vec(
                &json!({"version":1,"audio":audio,"output":output,"model":provider.model,"engine":provider.engine,"language":"zh","trim_start":start-audio_start,"trim_end":end-audio_start}),
            )?,
        )?;
        *job.state.lock().unwrap() = json!({"state":"transcribing","message":"正在识别下一段，完成后立即显示","completed":start,"total":total});
        let mut command = Command::new(&provider.python);
        command
            .arg(&adapter)
            .arg(request)
            .env("HF_HUB_OFFLINE", "1")
            .env("TOKENIZERS_PARALLELISM", "false");
        #[cfg(target_os = "macos")]
        command.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
        run_child(
            command,
            job,
            &session.generation,
            &piece.join("recognition.log"),
        )?;
        #[derive(Deserialize)]
        struct Output {
            version: u32,
            cues: Vec<Cue>,
        }
        if fs::metadata(&output)?.len() > MAX_TEXT {
            bail!("识别结果过大");
        }
        let result: Output = serde_json::from_slice(&fs::read(output)?)?;
        if result.version != 1 {
            bail!("识别引擎输出版本不兼容");
        }
        if job.cancel.load(Ordering::Relaxed) || session.generation != fingerprint("course") {
            bail!("已停止生成，已完成的字幕已保存；可继续生成");
        }
        checkpoint_chunk(&mut doc, result.cues, start, end, audio_start)?;
        let bytes = serde_json::to_vec(&doc)?;
        if bytes.len() as u64 > MAX_TEXT {
            bail!("字幕文件过大");
        }
        write_private(&partial_path(session)?, &bytes)?;
        *job.state.lock().unwrap() = json!({"state":"transcribing","message":"本段字幕已保存并装载，正在继续","completed":end,"total":total});
        fs::remove_dir_all(&piece)?;
    }
    // Keep the prior complete track until every piece succeeds. A silent recording
    // must never replace an existing track with an unexplained empty document.
    validate(&mut doc.cues, total)?;
    doc.progress = None;
    write_private(&document_path(session)?, &serde_json::to_vec(&doc)?)?;
    fs::remove_file(partial_path(session)?)?;
    Ok(())
}
fn account_key(id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("course.pku.edu.cn/blackboard-user/{id}"))
    )
}
fn migrate_legacy(root: &Path, generation: &str, account: &str) -> Result<usize> {
    let old = root.join("subtitles-v1").join(generation);
    if !old.is_dir() || old.is_symlink() {
        return Ok(0);
    }
    let mut migrated = 0;
    for entry in fs::read_dir(old)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.len() != 64
            || !name.chars().all(|c| c.is_ascii_hexdigit())
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        let source = entry.path().join("subtitles.json");
        if !source.is_file() || source.is_symlink() || fs::metadata(&source)?.len() > MAX_TEXT {
            continue;
        }
        let target = root
            .join("subtitles-v2")
            .join(account)
            .join(&name)
            .join("subtitles.json");
        let _claim = disk_claim(&format!("{account}/{name}"))?;
        if target.exists() {
            continue;
        }
        let bytes = fs::read(&source)?;
        let mut doc: Document = serde_json::from_slice(&bytes)?;
        if doc.version != 1 {
            continue;
        }
        validate(&mut doc.cues, f64::MAX)?;
        // Preserve the original as a recovery copy; never replace newer account subtitles.
        write_private(&target, &bytes)?;
        migrated += 1;
    }
    Ok(migrated)
}
impl Core {
    pub(crate) fn subtitle_settings(&self) -> Result<Value> {
        Ok(model_settings(&provider()?, &model_hub()?))
    }
    pub(crate) fn set_subtitle_model(&self, model: &str) -> Result<Value> {
        let _claim = disk_claim("subtitle-provider-settings")?;
        let p = select_model(provider()?, model, &model_hub()?)?;
        write_private(
            &root()?.join("subtitles-provider.json"),
            &serde_json::to_vec_pretty(&p)?,
        )?;
        Ok(model_settings(&p, &model_hub()?))
    }

    pub(crate) async fn subtitle_account(&self, generation: &str) -> Result<String> {
        let _guard = self.subtitle_account_lock.lock().await;
        let root = root()?;
        let binding = root
            .join("subtitle-accounts")
            .join(format!("{generation}.json"));
        let saved = fs::read(&binding)
            .ok()
            .and_then(|b| serde_json::from_slice::<String>(&b).ok())
            .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
        let account = match saved {
            Some(account) => account,
            None => account_key(&self.course_api()?.account_id().await?),
        };
        if generation != fingerprint("course") {
            bail!("账号已更新，请重试");
        }
        // Serialize migration with imports/generation from other app instances.
        let _claim = disk_claim("account-subtitle-migration")?;
        let account_dir = root.join("subtitles-v2").join(&account);
        fs::create_dir_all(&account_dir)?;
        platform::private_directory(&account_dir)?;
        migrate_legacy(&root, generation, &account)?;
        write_private(&binding, &serde_json::to_vec(&account)?)?;
        Ok(account)
    }
    pub(crate) fn ensure_subtitle_key_idle(
        &self,
        generation: &str,
        course: &str,
        video: &str,
    ) -> Result<fs::File> {
        if self
            .subtitles
            .lock()
            .unwrap()
            .jobs
            .get(&key(generation, course, video))
            .is_some_and(|job| job.active.load(Ordering::Relaxed))
        {
            bail!("请先取消这节回放的字幕生成");
        }
        disk_claim(&key(generation, course, video))
    }
    pub(crate) fn ensure_subtitle_idle(&self, session: &playback::Session) -> Result<fs::File> {
        let (course, video, _) = session.subtitle_identity();
        self.ensure_subtitle_key_idle(&session.subtitle_account, course, video)
    }
    pub(crate) fn subtitle_status(&self, id: &str) -> Result<Value> {
        let session = self.subtitle_session(id)?;
        let doc = saved(&session)?;
        let p = provider().ok();
        let can_resume = doc
            .as_ref()
            .and_then(|d| d.progress.as_ref())
            .is_none_or(|progress| {
                p.as_ref()
                    .and_then(|p| provider_key(p).ok())
                    .is_some_and(|key| key == progress.provider)
            });
        let state = self
            .subtitles
            .lock()
            .unwrap()
            .jobs
            .get(&session_key(&session))
            .map(|job| job.state.lock().unwrap().clone())
            .unwrap_or_else(|| json!({"state":if doc.as_ref().is_some_and(|d| d.progress.is_some()){ "partial" } else if doc.is_some(){"ready"}else{"idle"}}));
        Ok(
            json!({"job":state,"document":doc,"canResume":can_resume,"provider":p.as_ref().map(|p|p.label.as_str()).unwrap_or("本机识别"),"available":p.as_ref().is_some_and(|p|provider_problem(p).is_none()),"setupMessage":p.as_ref().and_then(provider_problem).unwrap_or("字幕配置暂不可用，可在设置中查看安装步骤；仍可导入 SRT / VTT。")}),
        )
    }
    pub(crate) fn subtitle_start(self: &Arc<Self>, id: &str) -> Result<Value> {
        let session = self.subtitle_session(id)?;
        let p = provider()?;
        if let Some(problem) = provider_problem(&p) {
            bail!(problem);
        }
        let global_claim = disk_claim("recognition-runtime")?;
        let video_claim = disk_claim(&session_key(&session))?;
        let mut store = self.subtitles.lock().unwrap();
        if store
            .jobs
            .values()
            .any(|job| job.active.load(Ordering::Relaxed))
        {
            bail!("已有字幕正在生成，请完成或取消后再试");
        }
        let job = Arc::new(Job {
            state: Mutex::new(json!({"state":"preparing","message":"正在准备音频"})),
            cancel: AtomicBool::new(false),
            active: AtomicBool::new(true),
        });
        store.jobs.insert(session_key(&session), job.clone());
        session.subtitle_active.store(true, Ordering::Relaxed);
        let directory = root()?
            .join("subtitle-jobs")
            .join(format!("{:032x}", rand::random::<u128>()));
        std::thread::spawn(move || {
            let _claims = (global_claim, video_claim);
            let result = generate(&session, &job, &p, &directory);
            *job.state.lock().unwrap() = match result {
                Ok(()) => json!({"state":"ready","message":"字幕已保存"}),
                Err(error) => {
                    json!({"state":if job.cancel.load(Ordering::Relaxed){"cancelled"}else{"error"},"message":error.to_string()})
                }
            };
            session.subtitle_active.store(false, Ordering::Relaxed);
            job.active.store(false, Ordering::Relaxed);
            let _ = fs::remove_dir_all(directory);
        });
        drop(store);
        self.subtitle_status(id)
    }
    pub(crate) fn subtitle_cancel(&self, id: &str) -> Result<Value> {
        let session = self.subtitle_session(id)?;
        if let Some(job) = self
            .subtitles
            .lock()
            .unwrap()
            .jobs
            .get(&session_key(&session))
        {
            job.cancel.store(true, Ordering::Relaxed);
        }
        self.subtitle_status(id)
    }
    /// Called only with a path selected by the native file picker, never IPC path input.
    pub fn import_subtitle(&self, id: &str, path: &Path) -> Result<Value> {
        let session = self.subtitle_session(id)?;
        let _claim = self.ensure_subtitle_idle(&session)?;
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() || metadata.len() > MAX_TEXT {
            bail!("请选择小于 10 MB 的字幕文件");
        }
        if !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("srt") || s.eq_ignore_ascii_case("vtt"))
        {
            bail!("请选择 SRT 或 VTT 文件");
        }
        let text = fs::read_to_string(path).map_err(|_| anyhow!("请使用 UTF-8 编码的字幕文件"))?;
        let cues = parse_subtitles(&text, session.duration())?;
        if session.generation != fingerprint("course") {
            bail!("账号已变化，请重新选择字幕");
        }
        let doc = Document {
            version: 1,
            signature: session.subtitle_identity().2.into(),
            progress: None,
            source: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            cues,
        };
        write_private(&document_path(&session)?, &serde_json::to_vec(&doc)?)?;
        let _ = fs::remove_file(partial_path(&session)?);
        self.subtitles
            .lock()
            .unwrap()
            .jobs
            .remove(&session_key(&session));
        self.subtitle_status(id)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_selection_requires_complete_local_files_and_preserves_the_runtime() {
        let hub = tempfile::tempdir().unwrap();
        let model = hub
            .path()
            .join("models--mlx-community--whisper-tiny/snapshots/abc");
        fs::create_dir_all(&model).unwrap();
        fs::write(model.join("config.json"), "{}").unwrap();
        let original = Provider {
            label: "current".into(),
            engine: "mlx-audio".into(),
            model: "/models/current".into(),
            python: "/runtime/python".into(),
            ffmpeg: "/runtime/ffmpeg".into(),
            adapter: None,
        };
        assert!(select_model(original.clone(), "whisper-tiny", hub.path()).is_err());
        fs::write(model.join("weights.npz"), "weights").unwrap();
        let next = select_model(original.clone(), "whisper-tiny", hub.path()).unwrap();
        assert_eq!(next.python, original.python);
        assert_eq!(next.ffmpeg, original.ffmpeg);
        assert_eq!(next.engine, "mlx-whisper");
        assert_eq!(Path::new(&next.model), model.as_path());
        assert_eq!(model_settings(&next, hub.path())["model"], "whisper-tiny");
        for id in ["../../adapter.py", "/tmp/model", "unknown"] {
            assert!(select_model(original.clone(), id, hub.path()).is_err());
        }
    }
    #[test]
    fn missing_model_disables_generation_without_removing_saved_subtitles() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("python");
        fs::write(&binary, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let model = directory.path().join("model");
        fs::create_dir(&model).unwrap();
        fs::write(model.join("config.json"), "{}").unwrap();
        let saved = directory.path().join("subtitles.json");
        fs::write(&saved, "saved captions").unwrap();
        let p = Provider {
            label: "test".into(),
            engine: "mlx-audio".into(),
            python: binary.clone(),
            ffmpeg: binary,
            model: model.to_string_lossy().into_owned(),
            adapter: None,
        };
        assert!(provider_problem(&p).unwrap().contains("模型"));
        fs::write(model.join("model.safetensors"), "weights").unwrap();
        assert_eq!(provider_problem(&p).is_none(), native_install_supported());
        fs::remove_file(model.join("model.safetensors")).unwrap();
        assert!(provider_problem(&p).is_some());
        assert_eq!(fs::read_to_string(saved).unwrap(), "saved captions");
    }
    #[test]
    fn partial_chunks_survive_restart_silence_and_preserve_the_remaining_old_track() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("partial.json");
        let mut doc = Document {
            version: 1,
            signature: "lecture".into(),
            source: "model".into(),
            cues: vec![],
            progress: Some(Coverage {
                completed: 0.0,
                total: 180.0,
                provider: "model-version".into(),
            }),
        };
        checkpoint_chunk(&mut doc, vec![], 0.0, 60.0, 0.0).unwrap();
        write_private(&path, &serde_json::to_vec(&doc).unwrap()).unwrap();
        let mut resumed = read_document(&path, "lecture", 180.0).unwrap().unwrap();
        assert_eq!(resumed.progress.as_ref().unwrap().completed, 60.0);
        assert!(resumed.cues.is_empty());
        let words = vec![
            Cue {
                start: 0.0,
                end: 0.5,
                text: "context-only".into(),
            },
            Cue {
                start: 0.9,
                end: 4.0,
                text: "新字幕".into(),
            },
        ];
        checkpoint_chunk(&mut resumed, words, 60.0, 120.0, 59.0).unwrap();
        assert_eq!(resumed.cues.len(), 1);
        assert_eq!(resumed.cues[0].start, 60.0);
        assert_eq!(resumed.cues[0].end, 63.0);
        assert!(checkpoint_chunk(&mut resumed, vec![], 60.0, 120.0, 59.0).is_err());
        write_private(&path, &serde_json::to_vec(&resumed).unwrap()).unwrap();
        let reopened = read_document(&path, "lecture", 180.0).unwrap().unwrap();
        let old = Document {
            version: 1,
            signature: "lecture".into(),
            source: "old".into(),
            progress: None,
            cues: vec![
                Cue {
                    start: 61.0,
                    end: 64.0,
                    text: "old prefix".into(),
                },
                Cue {
                    start: 130.0,
                    end: 133.0,
                    text: "保留后半段".into(),
                },
            ],
        };
        let visible = merge_partial(Some(old), Some(reopened)).unwrap();
        assert_eq!(
            visible
                .cues
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>(),
            vec!["新字幕", "保留后半段"]
        );
        assert_eq!(visible.progress.unwrap().completed, 120.0);
        assert!(read_document(&path, "different-recording", 180.0)
            .unwrap()
            .is_none());
    }
    #[test]
    fn login_rotation_keeps_subtitles_and_migration_never_crosses_accounts() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let owner = account_key("_123_1");
        let other = account_key("_456_1");
        let old = root
            .join("subtitles-v1")
            .join(key("old-login", "course", "video"))
            .join("subtitles.json");
        let doc = Document {
            version: 1,
            signature: "same-video".into(),
            progress: None,
            source: "existing.srt".into(),
            cues: vec![Cue {
                start: 1.0,
                end: 3.0,
                text: "已有字幕".into(),
            }],
        };
        write_private(&old, &serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(migrate_legacy(root, "old-login", &owner).unwrap(), 1);
        let destination = root
            .join("subtitles-v2")
            .join(key(&account_key("_123_1"), "course", "video"))
            .join("subtitles.json");
        // A different credential generation of the same server account reads the same document.
        assert_eq!(migrate_legacy(root, "new-login", &owner).unwrap(), 0);
        assert_eq!(
            read_document(&destination, "same-video", 10.0)
                .unwrap()
                .unwrap()
                .cues[0]
                .text,
            "已有字幕"
        );
        // A new login for a different account cannot claim old-login's legacy partition.
        assert_eq!(migrate_legacy(root, "other-login", &other).unwrap(), 0);
        assert!(!root
            .join("subtitles-v2")
            .join(key(&other, "course", "video"))
            .exists());
        let mut updated = doc.clone();
        updated.source = "new-generation".into();
        write_private(&destination, &serde_json::to_vec(&updated).unwrap()).unwrap();
        assert_eq!(migrate_legacy(root, "old-login", &owner).unwrap(), 0);
        assert_eq!(
            read_document(&destination, "same-video", 10.0)
                .unwrap()
                .unwrap()
                .source,
            "new-generation"
        );
        assert!(old.exists());
        assert!(read_document(&destination, "replaced-video", 10.0)
            .unwrap()
            .is_none());
    }
    #[test]
    fn srt_vtt_multiline_markup_and_bad_timeline() {
        let a = parse_subtitles(
            "\u{feff}1\r\n00:00:01,200 --> 00:00:03,400\r\n<b>中文</b>\r\n第二行\r\n",
            10.0,
        )
        .unwrap();
        assert_eq!(a[0].start, 1.2);
        assert_eq!(a[0].text, "中文\n第二行");
        let b = parse_subtitles(
            "WEBVTT\n\nNOTE skip\nnot a cue\n\nlabel\n00:01.000 --> 00:03.000 align:start\n你好",
            10.0,
        )
        .unwrap();
        assert_eq!(b.len(), 1);
        for text in [
            "1\n00:04,000 --> 00:03,000\nno",
            "1\n00:01,000 --> 10:03,000\nno",
            "empty",
        ] {
            assert!(parse_subtitles(text, 10.0).is_err());
        }
    }
    #[test]
    fn cancelling_a_running_adapter_terminates_it_promptly() {
        let directory = tempfile::tempdir().unwrap();
        let job = Job {
            state: Mutex::new(json!({})),
            cancel: AtomicBool::new(true),
            active: AtomicBool::new(true),
        };
        #[cfg(unix)]
        let mut command = { let mut command = Command::new("/bin/sleep"); command.arg("30"); command };
        #[cfg(windows)]
        let mut command = { let mut command = Command::new("ping.exe"); command.args(["-n", "30", "127.0.0.1"]); command };
        platform::quiet_command(&mut command);
        let start = Instant::now();
        assert!(run_child(
            command,
            &job,
            &fingerprint("course"),
            &directory.path().join("test.log")
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn saved_subtitles_survive_reload_but_not_a_changed_video() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("subtitles.json");
        let doc = Document {
            version: 1,
            signature: "recording-a".into(),
            progress: None,
            source: "import.srt".into(),
            cues: vec![Cue {
                start: 1.0,
                end: 3.0,
                text: "课堂字幕".into(),
            }],
        };
        write_private(&path, &serde_json::to_vec(&doc).unwrap()).unwrap();
        assert_eq!(
            read_document(&path, "recording-a", 10.0)
                .unwrap()
                .unwrap()
                .cues[0]
                .text,
            "课堂字幕"
        );
        assert!(read_document(&path, "recording-b", 10.0).unwrap().is_none());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    #[test]
    fn account_course_video_and_signature_bind_subtitles() {
        assert_ne!(key("one", "a", "b"), key("two", "a", "b"));
        assert_ne!(key("one", "a", "b"), key("one", "b", "a"));
        let mut invalid = vec![Cue {
            start: f64::NAN,
            end: 10.0,
            text: "bad".into(),
        }];
        assert!(validate(&mut invalid, 20.0).is_err());
    }
}
