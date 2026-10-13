//! Explicit user-triggered writes. Durable records prevent automatic resends.
use crate::platform::PrivateOpenOptions;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use super::*;
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_FILE: u64 = 25 * 1024 * 1024;
#[derive(Default)]
pub(crate) struct WriteState {
    staged: HashMap<String, Staged>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Staged {
    id: String,
    name: String,
    bytes: u64,
    sha256: String,
    generation: String,
    created: i64,
}
impl Staged {
    fn view(&self) -> Value {
        json!({"id":self.id,"name":self.name,"bytes":self.bytes,"sha256":self.sha256})
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Operation {
    id: String,
    course: String,
    content: String,
    title: String,
    course_name: String,
    file: Staged,
    state: String,
    message: String,
    created: i64,
    receipt: Option<String>,
    #[serde(default)]
    started: Option<i64>,
}
impl Operation {
    fn view(&self) -> Value {
        json!({"id":self.id,"course":self.course,"content":self.content,"title":self.title,"courseName":self.course_name,"file":self.file.view(),"state":self.state,"message":self.message,"created":self.created,"receipt":self.receipt})
    }
}
fn root() -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位操作目录"))?
        .data_local_dir()
        .join("writes-v1"))
}
fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    platform::private_directory(path)?;
    Ok(())
}
struct Journal {
    root: PathBuf,
    _lock: File,
    rows: HashMap<String, Operation>,
}
impl Journal {
    fn open(root: PathBuf) -> Result<Self> {
        private_dir(&root)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .private_mode()
            .open(root.join("journal.lock"))?;
        lock.lock_exclusive()?;
        let path = root.join("operations.json");
        let rows = if path.exists() {
            let mut bytes = vec![];
            File::open(&path)?
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            anyhow::ensure!(bytes.len() <= 2 * 1024 * 1024, "操作记录过大");
            serde_json::from_slice(&bytes)?
        } else {
            HashMap::new()
        };
        Ok(Self {
            root,
            _lock: lock,
            rows,
        })
    }
    fn save(&self) -> Result<()> {
        let path = self
            .root
            .join(format!(".journal-{:032x}.tmp", rand::random::<u128>()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .private_mode()
            .open(&path)?;
        f.write_all(&serde_json::to_vec(&self.rows)?)?;
        f.sync_all()?;
        drop(f);
        platform::replace_durable(&path, &self.root.join("operations.json"))?;
        Ok(())
    }
    fn prune(&mut self) -> bool {
        let now = chrono::Utc::now().timestamp();
        let mut changed = false;
        for o in self.rows.values_mut() {
            if o.state == "prepared" && now - o.created > 900 {
                o.state = "cancelled".into();
                o.message = "准备已过期，未发送".into();
                remove_stage(&o.file);
                changed = true;
            }
            if o.state == "sending" && now - o.started.unwrap_or(o.created) > 90 {
                o.state = "unknown".into();
                o.message = "发送过程已中断，请核对学校记录".into();
                changed = true;
            }
        }
        let before = self.rows.len();
        self.rows.retain(|_, o| {
            now - o.created < 90 * 86400 || matches!(o.state.as_str(), "sending" | "unknown")
        });
        changed || before != self.rows.len()
    }
}
fn staged_path(s: &Staged) -> Result<PathBuf> {
    safe_filename(&s.name)?;
    valid_id(&s.id)?;
    Ok(root()?.join("staging").join(&s.id).join(&s.name))
}
fn remove_stage(s: &Staged) {
    if let Ok(path) = staged_path(s) {
        let _ = fs::remove_file(&path);
        if let Some(dir) = path.parent() {
            let _ = fs::remove_dir(dir);
        }
    }
}
fn digest_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut hash = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        hash.update(&b[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn require_owner(o: &Operation) -> Result<()> {
    anyhow::ensure!(
        o.file.generation == fingerprint("course"),
        "登录已更新，请重新打开作业"
    );
    Ok(())
}
fn pending(o: &Operation) -> bool {
    matches!(o.state.as_str(), "prepared" | "sending" | "unknown")
}
fn begin_send(o: &mut Operation, now: i64) -> bool {
    if o.state != "prepared" {
        return false;
    }
    o.state = "sending".into();
    o.started = Some(now);
    o.message = "正在提交并核对学校记录，请勿重复发送".into();
    true
}
fn receipt_matches(file: &Staged, name: &str, bytes: &[u8]) -> bool {
    name == file.name && format!("{:x}", Sha256::digest(bytes)) == file.sha256
}
impl Core {
    pub fn stage_assignment_file(&self, path: &Path) -> Result<Value> {
        anyhow::ensure!(
            self.write_runtime.lock().unwrap().is_some(),
            "请在 OnePKU 主实例中选择文件"
        );
        let generation = fingerprint("course");
        self.course_api()?;
        let mut source = File::open(path)?;
        let meta = source.metadata()?;
        anyhow::ensure!(
            meta.is_file() && meta.len() > 0 && meta.len() <= MAX_FILE,
            "请选择不超过 25 MB 的非空文件"
        );
        let name = safe_filename(
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| anyhow!("文件名无效"))?,
        )?;
        anyhow::ensure!(!name.contains('"'), "文件名包含不支持的引号，请更名后选择");
        let now = chrono::Utc::now().timestamp();
        let mut state = self.writes.lock().unwrap();
        state.staged.retain(|_, s| {
            let keep = now - s.created < 1800 && s.generation == generation;
            if !keep {
                remove_stage(s)
            }
            keep
        });
        anyhow::ensure!(
            state.staged.len() < 8,
            "待提交文件过多，请关闭未完成的提交窗口"
        );
        let mut s = Staged {
            id: format!("{:032x}", rand::random::<u128>()),
            name,
            bytes: 0,
            sha256: String::new(),
            generation,
            created: now,
        };
        let dest = staged_path(&s)?;
        private_dir(dest.parent().unwrap())?;
        let result = (|| -> Result<()> {
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .private_mode()
                .open(&dest)?;
            let mut b = [0u8; 65536];
            let mut hash = Sha256::new();
            loop {
                let n = source.read(&mut b)?;
                if n == 0 {
                    break;
                }
                s.bytes += n as u64;
                anyhow::ensure!(s.bytes <= MAX_FILE, "文件超出 25 MB");
                out.write_all(&b[..n])?;
                hash.update(&b[..n]);
            }
            out.sync_all()?;
            s.sha256 = format!("{:x}", hash.finalize());
            Ok(())
        })();
        if let Err(e) = result {
            remove_stage(&s);
            return Err(e);
        }
        let view = s.view();
        state.staged.insert(s.id.clone(), s);
        Ok(view)
    }
    pub(crate) fn discard_stage(&self, id: &str) -> Result<Value> {
        if let Some(s) = self.writes.lock().unwrap().staged.remove(id) {
            remove_stage(&s)
        }
        Ok(json!({"discarded":true}))
    }
    fn assignment_for_write(&self, course: &str, content: &str) -> Result<Value> {
        valid_id(course)?;
        valid_id(content)?;
        let generation = fingerprint("course");
        for env in self.cache.lock().unwrap().values() {
            if env.generation != generation {
                continue;
            }
            if let Some(rows) = env.data.as_ref().and_then(Value::as_array) {
                for row in rows {
                    if row["course_id"] == course
                        && row["content_id"] == content
                        && row.get("hash_id").is_some()
                    {
                        return Ok(row.clone());
                    }
                }
            }
        }
        bail!("请刷新今日作业后再提交")
    }
    pub(crate) async fn prepare_submission(
        &self,
        course: &str,
        content: &str,
        file: &str,
    ) -> Result<Value> {
        let a = self.assignment_for_write(course, content)?;
        if a["descriptions"].as_array().is_some_and(|rows| {
            rows.iter().filter_map(Value::as_str).any(|s| {
                s.contains("无需提交任何文件")
                    || s.contains("不需要提交文件")
                    || s.contains("无需提交文件")
            })
        }) {
            bail!("教师说明本作业无需提交文件，请在教学网核对");
        }
        let staged = self
            .writes
            .lock()
            .unwrap()
            .staged
            .get(file)
            .cloned()
            .ok_or_else(|| anyhow!("请重新选择文件"))?;
        anyhow::ensure!(
            staged.generation == fingerprint("course")
                && chrono::Utc::now().timestamp() - staged.created < 1800,
            "登录已更新或文件已超时，请重新选择"
        );
        let snapshot = self
            .course_api()?
            .submission_snapshot(course, content)
            .await?;
        anyhow::ensure!(
            snapshot.label.is_none() && snapshot.files.is_empty(),
            "已有提交记录，请到教学网追加或重新提交"
        );
        let mut journal = Journal::open(root()?)?;
        journal.prune();
        anyhow::ensure!(
            !journal
                .rows
                .values()
                .any(|o| o.file.generation == staged.generation
                    && o.course == course
                    && o.content == content
                    && pending(o)),
            "此作业有待处理的操作，请先在操作记录中核对"
        );
        anyhow::ensure!(journal.rows.len() < 300, "操作记录已满，请先完成待核对操作");
        let op = Operation {
            id: format!("{:032x}", rand::random::<u128>()),
            course: course.into(),
            content: content.into(),
            title: a["title"].as_str().unwrap_or("作业").into(),
            course_name: a["course_name"].as_str().unwrap_or("课程").into(),
            file: staged,
            state: "prepared".into(),
            message: "请核对作业与附件，点击确认提交后才发送".into(),
            created: chrono::Utc::now().timestamp(),
            receipt: None,
            started: None,
        };
        journal.rows.insert(op.id.clone(), op.clone());
        journal.save()?;
        Ok(op.view())
    }
    pub(crate) async fn commit_submission(&self, id: &str) -> Result<Value> {
        let op = {
            let mut j = Journal::open(root()?)?;
            let o = j
                .rows
                .get_mut(id)
                .ok_or_else(|| anyhow!("操作记录不存在"))?;
            require_owner(o)?;
            if o.state != "prepared" {
                return Ok(o.view());
            }
            if chrono::Utc::now().timestamp() - o.created > 900 {
                o.state = "cancelled".into();
                o.message = "准备已过期，未发送，请重新选择文件".into();
                let v = o.view();
                j.save()?;
                return Ok(v);
            }
            anyhow::ensure!(
                digest_file(&staged_path(&o.file)?)? == o.file.sha256,
                "暂存文件已变化，请重新选择"
            );
            begin_send(o, chrono::Utc::now().timestamp());
            let copy = o.clone();
            j.save()?;
            copy
        };
        let result = tokio::time::timeout(Duration::from_secs(65), self.send_and_verify(&op)).await;
        let (state, message, receipt) = match result {
            Ok(Ok(receipt)) => ("confirmed", "学校提交记录与附件内容已核对", Some(receipt)),
            Ok(Err(e)) if e.to_string().contains("BEFORE_SEND_CHANGED") => (
                "blocked",
                "提交前发现学校已有记录，未上传文件；请到教学网核对",
                None,
            ),
            _ => ("unknown", "结果待确认。请核对学校记录，不要重复提交", None),
        };
        let mut j = Journal::open(root()?)?;
        let o = j
            .rows
            .get_mut(id)
            .ok_or_else(|| anyhow!("操作记录不存在"))?;
        o.state = state.into();
        o.message = message.into();
        o.receipt = receipt;
        let out = o.view();
        j.save()?;
        drop(j);
        self.writes.lock().unwrap().staged.remove(&op.file.id);
        remove_stage(&op.file);
        self.cache
            .lock()
            .unwrap()
            .retain(|_, e| e.generation != op.file.generation);
        let _ = self.persist_cache();
        Ok(out)
    }
    async fn send_and_verify(&self, op: &Operation) -> Result<String> {
        let api = self.course_api()?;
        let before = api.submission_snapshot(&op.course, &op.content).await?;
        if before.label.is_some() || !before.files.is_empty() {
            bail!("BEFORE_SEND_CHANGED")
        }
        require_owner(op)?;
        // Explicitly creates a new attempt and sends the immutable staged file only here.
        let _response = api
            .submit_assignment(&op.course, &op.content, &staged_path(&op.file)?)
            .await;
        self.verify_submission(op).await
    }
    async fn verify_submission(&self, op: &Operation) -> Result<String> {
        require_owner(op)?;
        let api = self.course_api()?;
        let snapshot = api.submission_snapshot(&op.course, &op.content).await?;
        let label = snapshot.label.ok_or_else(|| anyhow!("尚未发现提交记录"))?;
        for f in snapshot.files {
            if f.name == op.file.name {
                let data = api.submitted_file_bytes(&f.url, &op.course).await?;
                if receipt_matches(&op.file, &f.name, &data) {
                    return Ok(label);
                }
            }
        }
        bail!("尚未核对到本次附件")
    }
    pub(crate) async fn recheck_submission(&self, id: &str) -> Result<Value> {
        let op = {
            let j = Journal::open(root()?)?;
            let o = j.rows.get(id).ok_or_else(|| anyhow!("操作记录不存在"))?;
            require_owner(o)?;
            if o.state != "unknown" {
                return Ok(o.view());
            }
            o.clone()
        };
        if let Ok(receipt) = self.verify_submission(&op).await {
            let mut j = Journal::open(root()?)?;
            let o = j.rows.get_mut(id).unwrap();
            o.state = "confirmed".into();
            o.message = "学校提交记录与附件内容已核对".into();
            o.receipt = Some(receipt);
            let out = o.view();
            j.save()?;
            return Ok(out);
        }
        Ok(op.view())
    }
    pub(crate) fn end_submission(&self, id: &str) -> Result<Value> {
        let mut j = Journal::open(root()?)?;
        let o = j
            .rows
            .get_mut(id)
            .ok_or_else(|| anyhow!("操作记录不存在"))?;
        require_owner(o)?;
        anyhow::ensure!(o.state != "sending", "提交仍在进行，请稍后核对");
        if o.state == "prepared" {
            o.state = "cancelled".into();
            o.message = "已取消，未发送".into();
            self.writes.lock().unwrap().staged.remove(&o.file.id);
            remove_stage(&o.file)
        } else if o.state == "unknown" {
            o.state = "closed".into();
            o.message = "用户已在教学网核对并结束本地记录；本应用未确认提交结果".into();
        }
        let out = o.view();
        j.save()?;
        Ok(out)
    }
    pub(crate) fn write_operations(&self) -> Result<Value> {
        let mut j = Journal::open(root()?)?;
        if j.prune() {
            j.save()?;
        }
        let mut rows = j
            .rows
            .values()
            .filter(|o| o.file.generation == fingerprint("course"))
            .collect::<Vec<_>>();
        rows.sort_by_key(|o| -o.created);
        Ok(json!(rows
            .into_iter()
            .map(Operation::view)
            .collect::<Vec<_>>()))
    }
    pub(crate) fn recover_writes(&self) {
        let lock = (|| -> Result<File> {
            let r = root()?;
            private_dir(&r)?;
            let f = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .private_mode()
                .open(r.join("runtime.lock"))?;
            f.try_lock_exclusive()?;
            Ok(f)
        })();
        let Ok(lock) = lock else { return };
        *self.write_runtime.lock().unwrap() = Some(lock);
        if let Ok(mut j) = root().and_then(Journal::open) {
            for o in j.rows.values_mut() {
                if o.state == "sending" {
                    o.state = "unknown".into();
                    o.message = "上次发送中断，结果待确认，请核对学校记录".into();
                } else if o.state == "prepared" {
                    o.state = "cancelled".into();
                    o.message = "应用已重新启动，尚未发送，请重新选择文件".into();
                }
                remove_stage(&o.file);
            }
            j.prune();
            let _ = j.save();
        }
        // Staged files have no purpose after restart; delete only this app-owned staging directory.
        if let Ok(r) = root() {
            let _ = fs::remove_dir_all(r.join("staging"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Operation {
        Operation {
            id: "fixture".into(),
            course: "_1_1".into(),
            content: "_2_1".into(),
            title: "示例作业".into(),
            course_name: "示例课程".into(),
            file: Staged {
                id: "fixture_file".into(),
                name: "answer.txt".into(),
                bytes: 6,
                sha256: format!("{:x}", Sha256::digest(b"answer")),
                generation: "test-account".into(),
                created: chrono::Utc::now().timestamp(),
            },
            state: "prepared".into(),
            message: String::new(),
            created: chrono::Utc::now().timestamp(),
            receipt: None,
            started: None,
        }
    }
    #[test]
    fn durable_claim_prevents_same_operation_resend() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut j = Journal::open(dir.path().to_path_buf()).unwrap();
            let o = fixture();
            j.rows.insert(o.id.clone(), o);
            j.save().unwrap();
        }
        {
            let mut j = Journal::open(dir.path().to_path_buf()).unwrap();
            assert!(begin_send(
                j.rows.get_mut("fixture").unwrap(),
                chrono::Utc::now().timestamp()
            ));
            j.save().unwrap();
        }
        {
            let mut j = Journal::open(dir.path().to_path_buf()).unwrap();
            assert!(!begin_send(
                j.rows.get_mut("fixture").unwrap(),
                chrono::Utc::now().timestamp()
            ));
            assert_eq!(j.rows["fixture"].state, "sending");
        }
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(dir.path().join("operations.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[test]
    fn stalled_send_is_unknown_and_not_resendable() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = Journal::open(dir.path().to_path_buf()).unwrap();
        let mut o = fixture();
        begin_send(&mut o, chrono::Utc::now().timestamp() - 100);
        j.rows.insert(o.id.clone(), o);
        assert!(j.prune());
        assert_eq!(j.rows["fixture"].state, "unknown");
        assert!(!begin_send(
            j.rows.get_mut("fixture").unwrap(),
            chrono::Utc::now().timestamp()
        ));
    }
    #[test]
    fn receipt_requires_both_name_and_content() {
        let f = fixture().file;
        assert!(receipt_matches(&f, "answer.txt", b"answer"));
        assert!(!receipt_matches(&f, "answer.txt", b"different"));
        assert!(!receipt_matches(&f, "other.txt", b"answer"));
    }
    #[test]
    fn corrupted_journal_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("operations.json"), b"broken").unwrap();
        assert!(Journal::open(dir.path().to_path_buf()).is_err());
    }
    #[test]
    fn prepared_operations_do_not_expose_account_fingerprint() {
        let o = fixture();
        assert!(!o.view().to_string().contains("test-account"));
        assert_eq!(o.view()["state"], "prepared");
    }
}
