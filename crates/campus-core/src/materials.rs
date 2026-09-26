//! Course-local files: OS-selected imports and ID-scoped open/trash operations.
use super::*;
use crate::platform::PrivateOpenOptions;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_BATCH: usize = 100;

fn checked_name(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| anyhow!("LOCAL_MATERIAL: 文件名无法识别"))?;
    let name = downloads::safe_filename(name)
        .map_err(|_| anyhow!("LOCAL_MATERIAL: 文件名不适合归档，请先重命名"))?;
    if name.starts_with('.') || name.ends_with(".source.json") {
        bail!("LOCAL_MATERIAL: 隐藏文件或来源记录不能作为课程资料添加");
    }
    Ok(name)
}

fn checked_directory(path: &Path) -> Result<()> {
    // Refuse linked archive directories; file operations never escape the course folder.
    for parent in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        match fs::symlink_metadata(parent) {
            Ok(meta) if meta.is_dir() && !platform::is_link(&meta) => {}
            Ok(_) => bail!("LOCAL_MATERIAL: 资料目录已变化，请在文件管理器检查文件夹"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir(parent)?,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn sidecar(path: &Path) -> PathBuf {
    path.with_file_name(format!(
        "{}.source.json",
        path.file_name().unwrap().to_string_lossy()
    ))
}
fn source_label(path: &Path) -> &'static str {
    let meta = sidecar(path);
    if fs::symlink_metadata(&meta)
        .is_ok_and(|m| m.is_file() && !platform::is_link(&m) && m.len() <= 65536)
    {
        if let Ok(value) = fs::read(&meta)
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(std::io::Error::other))
        {
            if value["source"] == "local" {
                return "本地添加";
            }
            if value["source"].as_str().is_some_and(|s| {
                s.starts_with("https://course.pku.edu.cn/webapps/assignment/download?")
            }) {
                return "已交作业";
            }
            if value["source"]
                .as_str()
                .is_some_and(|s| s.starts_with("https://course.pku.edu.cn/bbcswebdav/"))
            {
                return "教学网下载";
            }
        }
    }
    "本机文件"
}

// Match provenance, never filenames. Only return the current account's opaque
// attachment identity; school URLs and source metadata stay on this machine.
#[cfg(test)]
fn source_attachment(path: &Path, generation: &str, course: Option<&Value>) -> Option<String> {
    source_attachments(path, generation, course)
        .into_iter()
        .next()
}
fn source_attachments(path: &Path, generation: &str, course: Option<&Value>) -> Vec<String> {
    source_identities(path, generation, course).unwrap_or_default()
}
fn source_identities(path: &Path, generation: &str, course: Option<&Value>) -> Option<Vec<String>> {
    let meta = sidecar(path);
    let stat = fs::symlink_metadata(&meta).ok()?;
    if !stat.is_file() || platform::is_link(&stat) || stat.len() > 65536 {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(meta).ok()?).ok()?;
    let source = value["source"].as_str()?;
    if !downloads::allowed_url(source) {
        return None;
    }
    let recorded_course = value["course"].as_str()?;
    let recorded_semester = value["semester"].as_str()?;
    let scoped_course;
    let mut identities = vec![];
    if let Some(course) = course {
        let name = course["name"].as_str()?;
        let id = course["id"].as_str()?;
        scoped_course = format!("{} {}", name, id);
        // Older downloads recorded the name only. Their containing directory
        // has already been resolved through this account's course index.
        // A scoped course ID survives corrected semester labels and course names.
        // Name-only legacy provenance is accepted only in the matching term.
        if !recorded_course.ends_with(&format!(" {id}"))
            && (recorded_course != name || course["semester"].as_str()? != recorded_semester)
        {
            return None;
        }
        identities.push(downloads::attachment_id(
            generation,
            source,
            &scoped_course,
            course["semester"].as_str()?,
        ));
        identities.push(downloads::attachment_id(
            generation,
            source,
            &scoped_course,
            recorded_semester,
        ));
    }
    identities.push(downloads::attachment_id(
        generation,
        source,
        recorded_course,
        recorded_semester,
    ));
    identities.dedup();
    Some(identities)
}

fn file_id(path: &Path, generation: &str) -> Result<String> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || platform::is_link(&meta) {
        bail!("LOCAL_MATERIAL: 资料已变化，请刷新后重试");
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{}|{}|{:?}|{}|{:?}",
            generation,
            path.display(),
            platform::file_identity(&platform::open_regular_file(path)?)?,
            meta.len(),
            meta.modified()?
        ))
    ))
}
fn scan(dir: &Path, generation: &str, course: Option<&Value>) -> Result<Vec<Value>> {
    checked_directory(dir)?;
    let mut rows = vec![];
    for entry in fs::read_dir(dir)?.take(10001) {
        let entry = entry?;
        let path = entry.path();
        let Ok(name) = checked_name(&path) else {
            continue;
        };
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file() || platform::is_link(&meta) {
            continue;
        }
        let identities = source_attachments(&path, generation, course);
        rows.push(json!({"id":file_id(&path, generation)?, "name":name, "bytes":meta.len(), "modified":meta.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_secs(), "source":source_label(&path), "downloadId":identities.first(), "downloadIds":identities}));
    }
    rows.sort_by(|a, b| {
        b["modified"]
            .as_i64()
            .cmp(&a["modified"].as_i64())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(rows)
}

// New writes use the current course label. Reads also include older folders for
// the same Blackboard course ID; no files are moved when metadata is corrected.
fn course_directories(root: &Path, course: &Value) -> Result<Vec<PathBuf>> {
    let id = course["id"]
        .as_str()
        .ok_or_else(|| anyhow!("invalid course"))?;
    valid_id(id)?;
    let name = course["name"].as_str().unwrap_or("课程");
    let semester = course["semester"].as_str().unwrap_or("未标注学期");
    let canonical = downloads::archive_directory_at(root, semester, &format!("{name} {id}"));
    checked_directory(&canonical)?;
    let mut dirs = vec![canonical];
    for term in fs::read_dir(root)?.take(1000) {
        let term = term?;
        let meta = fs::symlink_metadata(term.path())?;
        if !meta.is_dir() || platform::is_link(&meta) {
            continue;
        }
        for entry in fs::read_dir(term.path())?.take(10000) {
            let entry = entry?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_dir() || platform::is_link(&meta) || dirs.contains(&path) {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().into_owned();
            let name_only = term.file_name()
                == std::ffi::OsStr::new(&downloads::folder_component(semester))
                && folder == downloads::folder_component(name);
            if folder.ends_with(&format!(" {id}")) || name_only {
                dirs.push(path);
            }
        }
    }
    Ok(dirs)
}
fn resolve_in_directories(dirs: &[PathBuf], generation: &str, id: &str) -> Result<PathBuf> {
    for dir in dirs {
        if let Ok(path) = resolve(dir, generation, id) {
            return Ok(path);
        }
    }
    bail!("LOCAL_MATERIAL: 资料已移动或变化，请刷新后重试")
}
fn resolve(dir: &Path, generation: &str, id: &str) -> Result<PathBuf> {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("LOCAL_MATERIAL: 资料标识无效，请刷新后重试");
    }
    let item = scan(dir, generation, None)?
        .into_iter()
        .find(|r| r["id"] == id)
        .ok_or_else(|| anyhow!("LOCAL_MATERIAL: 资料已移动或变化，请刷新后重试"))?;
    let path = dir.join(item["name"].as_str().unwrap());
    if file_id(&path, generation)? != id {
        bail!("LOCAL_MATERIAL: 资料已变化，请刷新后重试");
    }
    Ok(path)
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn import_file(dir: &Path, source: &Path, course: &Value) -> Result<(Value, bool)> {
    checked_directory(dir)?;
    let name = checked_name(source)?;
    let original = fs::symlink_metadata(source)?;
    if !original.is_file() || platform::is_link(&original) {
        bail!("LOCAL_MATERIAL: 请选择普通文件，暂不支持文件夹或替身");
    }
    if original.len() > MAX_FILE {
        bail!("LOCAL_MATERIAL: 单份资料不能超过 2 GB");
    }
    let mut input = platform::open_regular_file(source)?;
    let opened = input.metadata()?;
    if platform::file_identity(&input)?
        != platform::file_identity(&platform::open_regular_file(source)?)?
    {
        bail!("LOCAL_MATERIAL: 文件已变化，请重新选择");
    }
    let temp = Temporary(dir.join(format!(
        ".onepku-import-{:032x}.part",
        rand::random::<u128>()
    )));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .private_mode()
        .open(&temp.0)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > MAX_FILE {
            bail!("LOCAL_MATERIAL: 单份资料不能超过 2 GB");
        }
        hash.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    let after = input.metadata()?;
    if size != opened.len()
        || after.len() != opened.len()
        || after.modified()? != opened.modified()?
    {
        bail!("LOCAL_MATERIAL: 文件在添加过程中发生变化，请保存后重新添加");
    }
    output.sync_all()?;
    let digest = format!("{:x}", hash.finalize());
    let path = downloads::finish_archive(&temp.0, dir, &name, &digest)?;
    let reused = platform::file_identity(&platform::open_regular_file(&path)?)?
        != platform::file_identity(&output)?;
    // Keep existing provenance when an identical teaching download is reused.
    let metadata = json!({"name":path.file_name().unwrap().to_string_lossy(),"course":course["name"],"courseId":course["id"],"semester":course["semester"],"source":"local","sha256":digest,"size":size,"addedAt":chrono::Utc::now().to_rfc3339()});
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .private_mode()
        .open(sidecar(&path))
    {
        Ok(mut f) => {
            f.write_all(&serde_json::to_vec_pretty(&metadata)?)?;
            f.sync_all()?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    Ok((
        json!({"name":path.file_name().unwrap().to_string_lossy(),"bytes":size}),
        reused,
    ))
}

impl Core {
    async fn material_course(&self, course: &str) -> Result<Value> {
        valid_id(course)?;
        let generation = fingerprint("course");
        let key = format!(
            "{}:{}",
            generation,
            serde_json::to_string(&Request::AllCourses)?
        );
        let cached = self
            .cache
            .lock()
            .unwrap()
            .get(&key)
            .and_then(|env| env.data.as_ref())
            .and_then(Value::as_array)
            .and_then(|rows| rows.iter().find(|c| c["id"] == course))
            .cloned();
        // Local files remain usable from the current account's already-read course index.
        if let Some(value) = cached {
            return Ok(value);
        }
        self.find_course(course).await
    }
    pub(crate) async fn material_directory(&self, course: &str) -> Result<PathBuf> {
        let c = self.material_course(course).await?;
        let dir = downloads::archive_directory(
            c["semester"].as_str().unwrap_or("未标注学期"),
            &format!("{} {}", c["name"].as_str().unwrap_or("课程"), course),
        )?;
        checked_directory(&dir)?;
        Ok(dir)
    }
    pub(crate) async fn local_materials(&self, course: &str) -> Result<Value> {
        let metadata = self.material_course(course).await?;
        let dirs = course_directories(&downloads::download_root()?, &metadata)?;
        let _guard = self.materials_lock.lock().unwrap();
        let mut rows = vec![];
        for dir in dirs {
            rows.extend(scan(&dir, &fingerprint("course"), Some(&metadata))?);
        }
        Ok(json!(rows))
    }
    async fn material_directories(&self, course: &str) -> Result<Vec<PathBuf>> {
        course_directories(
            &downloads::download_root()?,
            &self.material_course(course).await?,
        )
    }
    pub fn import_course_files(
        self: &Arc<Self>,
        course: &str,
        expected_generation: &str,
        paths: &[PathBuf],
    ) -> Result<Value> {
        if paths.len() > MAX_BATCH {
            bail!("LOCAL_MATERIAL: 每次最多添加 100 份资料");
        }
        if expected_generation != fingerprint("course") {
            bail!("LOCAL_MATERIAL: 账号已变化，请重新添加资料");
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let c = runtime.block_on(self.material_course(course))?;
        let dir = runtime.block_on(self.material_directory(course))?;
        let _guard = self.materials_lock.lock().unwrap();
        let mut added = vec![];
        let mut reused = 0;
        let mut failed = vec![];
        for path in paths {
            if expected_generation != fingerprint("course") {
                bail!("LOCAL_MATERIAL: 账号已变化，请重新打开课程资料");
            }
            match import_file(&dir, path, &c) {
                Ok((value, existing)) => { added.push(value); if existing { reused += 1; } }
                Err(error) => failed.push(json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"message":error.to_string().strip_prefix("LOCAL_MATERIAL:").map(str::trim).unwrap_or("无法读取或保存这个文件，请检查文件是否可用")})),
            }
        }
        Ok(json!({"added":added,"reused":reused,"failed":failed}))
    }
    pub(crate) async fn open_local_material(&self, course: &str, id: &str) -> Result<Value> {
        let generation = fingerprint("course");
        let dirs = self.material_directories(course).await?;
        let _guard = self.materials_lock.lock().unwrap();
        if generation != fingerprint("course") {
            bail!("LOCAL_MATERIAL: 账号已变化，请刷新课程");
        }
        let path = resolve_in_directories(&dirs, &generation, id)?;
        platform::open(path.as_os_str())
            .map_err(|_| anyhow!("LOCAL_MATERIAL: 无法打开这份资料，请在文件夹中查看"))?;
        Ok(json!({"opened":true}))
    }
    pub(crate) async fn read_local_material(&self, course: &str, id: &str) -> Result<Value> {
        use base64::Engine;
        let generation = fingerprint("course");
        let dirs = self.material_directories(course).await?;
        let _guard = self.materials_lock.lock().unwrap();
        if generation != fingerprint("course") {
            bail!("LOCAL_MATERIAL: 账号已变化，请刷新课程");
        }
        let path = resolve_in_directories(&dirs, &generation, id)?;
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let mime = match ext.as_str() {
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "txt" | "md" | "csv" | "srt" | "vtt" => "text/plain",
            _ => bail!("LOCAL_MATERIAL: 此格式请用默认应用打开"),
        };
        const LIMIT: u64 = 32 * 1024 * 1024;
        let file = platform::open_regular_file(&path)?;
        if file.metadata()?.len() > LIMIT {
            bail!("LOCAL_MATERIAL: 超过 32 MB，请用默认应用打开");
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > LIMIT
            || resolve_in_directories(&dirs, &generation, id)? != path
            || generation != fingerprint("course")
        {
            bail!("LOCAL_MATERIAL: 文件或账号已变化，请刷新后重试");
        }
        Ok(json!({"mime":mime,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}))
    }
    pub(crate) async fn trash_local_material(&self, course: &str, id: &str) -> Result<Value> {
        let generation = fingerprint("course");
        let dirs = self.material_directories(course).await?;
        let _guard = self.materials_lock.lock().unwrap();
        if generation != fingerprint("course") {
            bail!("LOCAL_MATERIAL: 账号已变化，请刷新课程");
        }
        let path = resolve_in_directories(&dirs, &generation, id)?;
        #[cfg(target_os = "macos")]
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let trash = trash::TrashContext::default();
        #[cfg(target_os = "macos")]
        let mut trash = trash;
        #[cfg(target_os = "macos")]
        trash.set_delete_method(DeleteMethod::NsFileManager);
        trash
            .delete(&path)
            .map_err(|_| anyhow!("LOCAL_MATERIAL: 未能移到回收站，文件仍保留，请重试"))?;
        // Retain provenance if the user restores this file from the Trash.
        Ok(json!({"trashed":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrected_semester_reads_existing_download_with_old_and_new_attachment_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let generation = fingerprint("course");
        let core = Core::default();
        let source = "https://course.pku.edu.cn/bbcswebdav/courses/_1_1/HW1.md";
        let metadata = json!({"id":"_1_1","name":"测试课 (A)","semester":"26-27学年第1学期"});
        let mut old = vec![
            json!({"course_id":"_1_1","course_name":"测试课","attachments":[{"name":"HW1.md","url":source}]}),
        ];
        let mut current = old.clone();
        study::apply_course_metadata(&mut current[0], &metadata);
        core.register_files(&mut old);
        core.register_files(&mut current);
        let old_id = old[0]["attachments"][0]["downloadId"].as_str().unwrap();
        let current_id = current[0]["attachments"][0]["downloadId"].as_str().unwrap();
        assert_ne!(old_id, current_id);

        let old_dir = downloads::archive_directory_at(&root, "未标注学期", "测试课 _1_1");
        fs::create_dir_all(&old_dir).unwrap();
        let file = old_dir.join("HW1.md");
        fs::write(&file, "# homework\nexisting download").unwrap();
        fs::write(
            sidecar(&file),
            serde_json::to_vec(&json!({
                "source":source,"course":"测试课 _1_1","semester":"未标注学期"
            }))
            .unwrap(),
        )
        .unwrap();
        let dirs = course_directories(&root, &metadata).unwrap();
        assert_eq!(
            dirs[0],
            downloads::archive_directory_at(&root, "26-27学年第1学期", "测试课 (A) _1_1")
        );
        let rows = dirs
            .iter()
            .flat_map(|dir| scan(dir, &generation, Some(&metadata)).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["downloadId"], current_id);
        assert!(rows[0]["downloadIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == old_id));
        let local_id = rows[0]["id"].as_str().unwrap();
        let resolved = resolve_in_directories(&dirs, &generation, local_id).unwrap();
        assert_eq!(resolved, file);
        assert_eq!(
            fs::read_to_string(&resolved).unwrap(),
            "# homework\nexisting download"
        );
        assert!(resolve_in_directories(&dirs, "different-account", local_id).is_err());
        let foreign = json!({"id":"_2_1","name":"测试课 (A)","semester":"26-27学年第1学期"});
        let other_dirs = course_directories(&root, &foreign).unwrap();
        assert!(!other_dirs.contains(&old_dir));
        assert!(resolve_in_directories(&other_dirs, &generation, local_id).is_err());
        assert!(file.exists()); // Compatibility reads never move the original.
        assert!(!serde_json::to_string(&rows).unwrap().contains(source));
    }
    #[test]
    fn downloaded_copies_match_provenance_not_names_and_scope_the_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let file = root.join("renamed-lecture.pdf");
        fs::write(&file, "local copy").unwrap();
        let source = "https://course.pku.edu.cn/bbcswebdav/courses/_1_1/lecture.pdf";
        let metadata = json!({"source":source,"course":"测试课 _1_1","semester":"26-27-1"});
        fs::write(sidecar(&file), serde_json::to_vec(&metadata).unwrap()).unwrap();
        let identity = downloads::attachment_id("account-a", source, "测试课 _1_1", "26-27-1");
        let rows = scan(&root, "account-a", None).unwrap();
        assert_eq!(rows[0]["downloadId"], identity);
        assert!(!serde_json::to_string(&rows).unwrap().contains(source));
        assert_ne!(
            scan(&root, "account-b", None).unwrap()[0]["downloadId"],
            identity
        );
        assert_ne!(
            downloads::attachment_id("account-a", source, "测试课 _2_1", "26-27-1"),
            identity
        );
        let scope = json!({"name":"测试课","id":"_1_1","semester":"26-27-1"});
        let legacy = json!({"source":source,"course":"测试课","semester":"26-27-1"});
        fs::write(sidecar(&file), serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(
            source_attachment(&file, "account-a", Some(&scope)).unwrap(),
            identity
        );
        let foreign = json!({"name":"其他课","id":"_2_1","semester":"26-27-1"});
        assert!(source_attachment(&file, "account-a", Some(&foreign)).is_none());
        fs::write(sidecar(&file), br#"{"source":"local"}"#).unwrap();
        assert!(scan(&root, "account-a", None).unwrap()[0]["downloadId"].is_null());
        fs::write(sidecar(&file), r#"{"source":"https://example.com/lecture.pdf","course":"测试课 _1_1","semester":"26-27-1"}"#.as_bytes()).unwrap();
        assert!(source_attachment(&file, "account-a", None).is_none());
    }
    #[test]
    fn custom_download_root_supports_nested_unicode_archives() {
        let temp = tempfile::tempdir().unwrap();
        let chosen = temp.path().join("自选目录 & 100%");
        fs::create_dir(&chosen).unwrap();
        let validated = downloads::validate_download_root(&chosen).unwrap();
        let archive = validated.join("26-27-1").join("中文课");
        checked_directory(&archive).unwrap();
        let source = temp.path().join("讲义.txt");
        fs::write(&source, "内容").unwrap();
        import_file(&archive, &source, &json!({})).unwrap();
        assert_eq!(scan(&archive, "account", None).unwrap().len(), 1);
    }
    #[test]
    fn imports_copy_deduplicate_and_preserve_conflicting_names_and_originals() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("微信群讲义.txt");
        let archive = root.join("course");
        let c = json!({"name":"测试课","id":"_1_1","semester":"本学期"});
        fs::write(&source, "第一版").unwrap();
        let (first, reused) = import_file(&archive, &source, &c).unwrap();
        assert!(!reused);
        assert_eq!(first["name"], "微信群讲义.txt");
        assert!(import_file(&archive, &source, &c).unwrap().1);
        fs::write(&source, "第二版").unwrap();
        let (second, reused) = import_file(&archive, &source, &c).unwrap();
        assert!(!reused);
        assert_ne!(first["name"], second["name"]);
        assert_eq!(
            fs::read_to_string(archive.join("微信群讲义.txt")).unwrap(),
            "第一版"
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), "第二版");
        assert_eq!(scan(&archive, "account", None).unwrap().len(), 2);
        assert!(scan(&archive, "account", None)
            .unwrap()
            .iter()
            .all(|r| r["source"] == "本地添加"));
    }
    #[test]
    fn material_ids_reject_foreign_courses_changed_files_and_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        let file = a.join("笔记.txt");
        fs::write(&file, "notes").unwrap();
        let id = file_id(&file, "account").unwrap();
        assert_eq!(resolve(&a, "account", &id).unwrap(), file);
        assert!(resolve(&b, "account", &id).is_err());
        assert!(resolve(&a, "other", &id).is_err());
        assert!(resolve(&a, "account", "../../outside").is_err());
        fs::write(&file, "changed notes").unwrap();
        assert!(resolve(&a, "account", &id).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&file, b.join("link.txt")).unwrap();
            assert!(scan(&b, "account", None).unwrap().is_empty());
            assert!(import_file(&b, &b.join("link.txt"), &json!({})).is_err());
            let linked = root.join("linked");
            std::os::unix::fs::symlink(&a, &linked).unwrap();
            assert!(scan(&linked, "account", None).is_err());
        }
    }
}
