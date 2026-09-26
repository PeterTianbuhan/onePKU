//! Local resource snapshots. Cache-first/TTL/stale conventions follow PkuClaw's
//! pku3b cache contract; credentials remain in PKU CLI, never in this snapshot.
use super::*;
use crate::platform::PrivateOpenOptions;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    version: u32,
    entries: HashMap<String, Envelope>,
    files: HashMap<String, downloads::FileRef>,
}
fn path() -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位缓存目录"))?
        .cache_dir()
        .join("resources-v1.json"))
}
pub(crate) fn cacheable(req: &Request) -> bool {
    matches!(
        req,
        Request::Courses
            | Request::AllCourses
            | Request::Videos { .. }
            | Request::Scores
            | Request::Exams
            | Request::CardStats { .. }
            | Request::Recordings { .. }
            | Request::RecordingSessions { .. }
            | Request::LearningGrades { .. }
            | Request::CourseAssignments { .. }
            | Request::Assignments
            | Request::Notices
            | Request::CourseNotices { .. }
            | Request::AssignmentFeedback { .. }
            | Request::Card
            | Request::Transactions { .. }
            | Request::Content { .. }
            | Request::Holes { .. }
            | Request::Hole { .. }
            | Request::CalendarPdf { .. }
            | Request::FacultyNews { .. }
            | Request::News { .. }
            | Request::NewsDetail { .. }
    )
}
fn request_from_key(key: &str) -> Option<Request> {
    serde_json::from_str(key.split_once(':')?.1).ok()
}
fn recent(env: &Envelope, now: i64) -> bool {
    env.data.is_some()
        && env
            .updated_at
            .as_ref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|d| now - d.timestamp() < 30 * 86400 && d.timestamp() <= now + 60)
}
fn current(key: &str, env: &Envelope) -> bool {
    let Some(req) = request_from_key(key) else {
        return false;
    };
    if !cacheable(&req) || env.generation != fingerprint(owner(&req)) {
        return false;
    }
    if owner(&req) == "treehole" {
        if Store::new("treehole")
            .ok()
            .and_then(|s| s.load_session().ok().flatten())
            .is_none_or(|s| s.is_expired())
        {
            return false;
        }
    }
    true
}
fn atomic_write(p: &Path, data: &[u8]) -> Result<()> {
    let dir = p
        .parent()
        .ok_or_else(|| anyhow!("invalid cache directory"))?;
    fs::create_dir_all(dir)?;
    platform::private_directory(dir)?;
    let temp = dir.join(format!(
        ".cache-{}-{}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| -> Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .private_mode()
            .open(&temp)?;
        f.write_all(data)?;
        f.sync_all()?;
        fs::rename(&temp, p)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
impl Core {
    pub(crate) fn restore_cache(&self) {
        let Some(saved) = path().ok().and_then(|p| {
            if fs::metadata(&p).ok()?.len() > 32 * 1024 * 1024 {
                return None;
            }
            serde_json::from_slice::<Saved>(&fs::read(p).ok()?).ok()
        }) else {
            return;
        };
        if saved.version != 1 {
            return;
        }
        let now = chrono::Utc::now().timestamp();
        *self.cache.lock().unwrap() = saved
            .entries
            .into_iter()
            .filter(|(k, v)| current(k, v) && recent(v, now))
            .take(96)
            .collect();
        *self.files.lock().unwrap() = saved
            .files
            .into_iter()
            .filter(|(_, f)| f.valid_for_current_account())
            .take(10000)
            .collect();
    }
    pub(crate) fn persist_cache(&self) -> Result<()> {
        let _guard = self.persist_lock.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        let entries: HashMap<_, _> = self
            .cache
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, v)| current(k, v) && recent(v, now))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let files = self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, f)| f.valid_for_current_account())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let bytes = serde_json::to_vec(&Saved {
            version: 1,
            entries,
            files,
        })?;
        if bytes.len() > 32 * 1024 * 1024 {
            bail!("缓存达到容量上限")
        }
        atomic_write(&path()?, &bytes)
    }
    pub(crate) fn snapshot(&self) -> Value {
        let now = chrono::Utc::now().timestamp();
        json!(self
            .cache
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, v)| current(k, v) && recent(v, now))
            .filter_map(|(k, v)| request_from_key(k).map(|req| json!({"request":req,"envelope":v})))
            .collect::<Vec<_>>())
    }
    pub(crate) fn clear_cache(&self) -> Result<()> {
        let _guard = self.persist_lock.lock().unwrap();
        self.cache.lock().unwrap().clear();
        self.files.lock().unwrap().clear();
        let p = path()?;
        if p.exists() {
            fs::remove_file(p)?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_private_and_replace_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("cache.json");
        atomic_write(&p, b"old").unwrap();
        atomic_write(&p, b"new").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        #[cfg(unix)]
        assert_eq!(fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o600);
    }
    #[test]
    fn mutations_and_relative_room_days_are_never_persisted() {
        assert!(!cacheable(&Request::AuthBegin {
            service: "course".into()
        }));
        assert!(!cacheable(&Request::Rooms {
            building: "一教".into(),
            day: "today".into()
        }));
        assert!(cacheable(&Request::News {
            source: "school".into(),
            page: 1
        }));
    }
    #[test]
    fn old_or_account_mismatched_snapshots_are_rejected() {
        let env = Envelope {
            data: Some(json!([])),
            updated_at: Some("2020-01-01T00:00:00Z".into()),
            stale: false,
            error: None,
            warnings: vec![],
            generation: "other-account".into(),
        };
        assert!(!recent(&env, chrono::Utc::now().timestamp()));
        assert!(!current("other-account:{\"kind\":\"courses\"}", &env));
    }
}
