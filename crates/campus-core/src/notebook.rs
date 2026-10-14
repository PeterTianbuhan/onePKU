//! Per-course notebook: one plain Markdown file in the course's archive folder,
//! owned by the user (and any editor or AI they point at it). Remote imports are
//! merged by the frontend and saved here; nothing refreshes or overwrites it.
use super::*;
use crate::platform::PrivateOpenOptions;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const NOTEBOOK_FILE: &str = "课程笔记.md";
const MAX_NOTEBOOK: u64 = 4 * 1024 * 1024;

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn course_value(course: &str, name: &str, semester: &str) -> Result<Value> {
    valid_id(course)?;
    Ok(json!({
        "id": course,
        "name": if name.trim().is_empty() { "课程" } else { name.trim() },
        "semester": if semester.trim().is_empty() { "未标注学期" } else { semester.trim() },
    }))
}

/// The notebook in the first course folder that already has one, else the
/// current canonical folder. Older folders of the same course are honoured so a
/// corrected semester label never hides earlier notes.
fn locate(root: &Path, course: &Value) -> Result<PathBuf> {
    let dirs = materials::course_directories(root, course)?;
    for dir in &dirs {
        let path = dir.join(NOTEBOOK_FILE);
        if fs::symlink_metadata(&path).is_ok() {
            return Ok(path);
        }
    }
    Ok(dirs[0].join(NOTEBOOK_FILE))
}

fn read(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !platform::is_link(&meta) => {
            if meta.len() > MAX_NOTEBOOK {
                bail!("LOCAL_MATERIAL: 课程笔记文件超过 4 MB，请在编辑器中精简后再打开");
            }
            let mut bytes = Vec::new();
            platform::open_regular_file(path)?.take(MAX_NOTEBOOK + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_NOTEBOOK {
                bail!("LOCAL_MATERIAL: 课程笔记文件超过 4 MB");
            }
            Ok(Some(String::from_utf8(bytes).map_err(|_| {
                anyhow!("LOCAL_MATERIAL: 课程笔记不是 UTF-8 文本，请在编辑器中另存为 UTF-8")
            })?))
        }
        Ok(_) => bail!("LOCAL_MATERIAL: 课程笔记位置被其他类型的文件占用，请在访达中检查"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("无效的课程目录"))?;
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!(
        ".课程笔记-{}-{}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| -> Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .private_mode()
            .open(&temp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        platform::replace_durable(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn snapshot(path: &Path, text: Option<String>) -> Value {
    let exists = text.is_some();
    let text = text.unwrap_or_default();
    json!({
        "path": path.display().to_string(),
        "exists": exists,
        "text": text,
        "hash": digest(&text),
    })
}

pub(crate) fn load_at(root: &Path, course: &str, name: &str, semester: &str) -> Result<Value> {
    let path = locate(root, &course_value(course, name, semester)?)?;
    let text = read(&path)?;
    Ok(snapshot(&path, text))
}

/// Saves only when the file still matches what the editor last loaded, so an
/// edit made meanwhile in another editor (or by an AI) is never silently lost.
pub(crate) fn save_at(
    root: &Path,
    course: &str,
    name: &str,
    semester: &str,
    text: &str,
    base: &str,
) -> Result<Value> {
    if text.len() as u64 > MAX_NOTEBOOK {
        bail!("LOCAL_MATERIAL: 课程笔记超过 4 MB，未保存");
    }
    let path = locate(root, &course_value(course, name, semester)?)?;
    let current = read(&path)?;
    let current_hash = digest(current.as_deref().unwrap_or(""));
    if current_hash != base && current_hash != digest(text) {
        let mut v = snapshot(&path, current);
        v["saved"] = json!(false);
        v["conflict"] = json!(true);
        return Ok(v);
    }
    write_atomic(&path, text)?;
    let mut v = snapshot(&path, Some(text.to_string()));
    v["saved"] = json!(true);
    v["conflict"] = json!(false);
    Ok(v)
}

impl Core {
    pub(crate) fn course_notebook(
        &self,
        course: &str,
        name: &str,
        semester: &str,
    ) -> Result<Value> {
        load_at(&downloads::download_root()?, course, name, semester)
    }
    pub(crate) fn save_course_notebook(
        &self,
        course: &str,
        name: &str,
        semester: &str,
        text: &str,
        base: &str,
    ) -> Result<Value> {
        let _guard = self.materials_lock.lock().unwrap();
        save_at(
            &downloads::download_root()?,
            course,
            name,
            semester,
            text,
            base,
        )
    }
    pub(crate) fn reveal_course_notebook(
        &self,
        course: &str,
        name: &str,
        semester: &str,
    ) -> Result<Value> {
        let path = locate(
            &downloads::download_root()?,
            &course_value(course, name, semester)?,
        )?;
        #[cfg(target_os = "macos")]
        if path.exists() {
            std::process::Command::new("/usr/bin/open").arg("-R").arg(&path).spawn()?;
        } else {
            platform::open(path.parent().unwrap().as_os_str())?;
        }
        #[cfg(not(target_os = "macos"))]
        platform::open(path.parent().unwrap().as_os_str())?;
        Ok(json!({"opened": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
use crate::platform::PrivateOpenOptions;

    #[test]
    fn creates_reads_and_refuses_to_overwrite_outside_edits() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        let root = canonical.as_path();
        let empty = load_at(root, "_1_1", "课", "26-27学年第1学期").unwrap();
        assert_eq!(empty["exists"], false);
        let base = empty["hash"].as_str().unwrap().to_string();
        let saved = save_at(root, "_1_1", "课", "26-27学年第1学期", "# 课\n", &base).unwrap();
        assert_eq!(saved["saved"], true);
        let path = PathBuf::from(saved["path"].as_str().unwrap());
        assert!(path.ends_with("26-27学年第1学期/课 _1_1/课程笔记.md"));
        // Someone edits the file outside the app; a stale save must not clobber it.
        fs::write(&path, "# 课\n外部修改\n").unwrap();
        let stale = save_at(
            root,
            "_1_1",
            "课",
            "26-27学年第1学期",
            "# 课\n应用内\n",
            saved["hash"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(stale["saved"], false);
        assert_eq!(stale["text"], "# 课\n外部修改\n");
        let fresh = save_at(
            root,
            "_1_1",
            "课",
            "26-27学年第1学期",
            "# 课\n合并\n",
            stale["hash"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fresh["saved"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 课\n合并\n");
    }

    #[test]
    fn finds_notes_in_an_older_folder_for_the_same_course() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let old = root.join("未标注学期").join("旧名 _2_1");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(NOTEBOOK_FILE), "旧笔记").unwrap();
        let v = load_at(&root, "_2_1", "新名", "26-27学年第1学期").unwrap();
        assert_eq!(v["text"], "旧笔记");
    }
}
