use crate::platform::PrivateOpenOptions;
use super::*;
use std::{collections::HashSet, fs, io::Write,  path::PathBuf};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    enabled: bool,
    baselines: HashMap<String, Vec<String>>,
    sent: HashSet<String>,
    events: Vec<Value>,
}
fn path() -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("设置目录不可用"))?
        .config_dir()
        .join("reminders-v1.json"))
}
fn load() -> Result<Saved> {
    match fs::read(path()?) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
        Err(e) => Err(e.into()),
    }
}
fn save(s: &Saved) -> Result<()> {
    let path = path()?;
    fs::create_dir_all(path.parent().unwrap())?;
    let temp = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .private_mode()
        .open(&temp)?;
    f.write_all(&serde_json::to_vec(s)?)?;
    f.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}
fn delta(s: &mut Saved, key: &str, ids: Vec<String>) -> Vec<String> {
    let previous = s.baselines.insert(key.into(), ids.clone());
    previous
        .map(|old| ids.into_iter().filter(|id| !old.contains(id)).collect())
        .unwrap_or_default()
}
fn deadline_seconds(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|v| v.timestamp())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
                .ok()
                .map(|d| d.and_utc().timestamp() - 8 * 3600)
        })
}
fn add(
    s: &mut Saved,
    key: String,
    title: String,
    body: String,
    page: &str,
    service: &str,
    now: i64,
) -> Option<Value> {
    if !s.sent.insert(key.clone()) {
        return None;
    }
    let v = json!({"id":key,"title":title,"body":body,"page":page,"service":service,"generation":fingerprint(service),"created":now,"read":false});
    s.events.push(v.clone());
    Some(v)
}
impl Core {
    pub(crate) fn reminders(&self) -> Result<Value> {
        let _lock = self.reminder_lock.lock().unwrap();
        let s = load()?;
        let events = s
            .events
            .into_iter()
            .rev()
            .filter(|e| {
                e["generation"].as_str()
                    == Some(&fingerprint(e["service"].as_str().unwrap_or("public")))
            })
            .collect::<Vec<_>>();
        Ok(json!({"enabled":s.enabled,"events":events}))
    }
    pub(crate) fn set_reminders(&self, enabled: bool) -> Result<Value> {
        let _lock = self.reminder_lock.lock().unwrap();
        let mut s = load()?;
        if s.enabled != enabled {
            s.baselines.clear();
        }
        s.enabled = enabled;
        save(&s)?;
        Ok(json!({"enabled":enabled}))
    }
    pub(crate) fn read_reminders(&self) -> Result<Value> {
        let _lock = self.reminder_lock.lock().unwrap();
        let mut s = load()?;
        for e in &mut s.events {
            e["read"] = json!(true);
        }
        save(&s)?;
        Ok(json!({"read":true}))
    }
    /// Called by the native process every five minutes, including while minimized.
    /// Failed/partial sources never replace a baseline or produce a false delta.
    pub fn reminder_tick(self: &Arc<Self>) -> Result<Vec<Value>> {
        if !load()?.enabled {
            return Ok(vec![]);
        }
        let mut snapshots = Vec::new();
        for request in [Request::Assignments, Request::Notices, Request::Scores] {
            let service = owner(&request);
            if Store::new(service)?.load_session()?.is_none() {
                continue;
            }
            let out = self.call(request.clone());
            if out.error.is_none()
                && out.warnings.is_empty()
                && !out.stale
                && out.generation == fingerprint(service)
            {
                snapshots.push((request, out));
            }
        }
        let _lock = self.reminder_lock.lock().unwrap();
        let mut s = load()?;
        if !s.enabled {
            return Ok(vec![]);
        }
        let now = chrono::Utc::now().timestamp();
        let mut notifications = Vec::new();
        for (req, out) in snapshots {
            let service = owner(&req);
            let gen = &out.generation;
            if gen != &fingerprint(service) {
                continue;
            }
            let Some(data) = out.data else { continue };
            match req {
                Request::Assignments => {
                    let Some(rows) = data.as_array() else {
                        continue;
                    };
                    let ids = rows
                        .iter()
                        .filter_map(|r| r["hash_id"].as_str().map(str::to_owned))
                        .collect();
                    let fresh = delta(&mut s, &format!("assignments:{gen}"), ids);
                    for r in rows {
                        let id = r["hash_id"].as_str().unwrap_or("");
                        if id.is_empty() {
                            continue;
                        }
                        let title = r["title"].as_str().unwrap_or("作业");
                        let course = r["course_name"].as_str().unwrap_or("课程");
                        if fresh.iter().any(|v| v == id) {
                            if let Some(e) = add(
                                &mut s,
                                format!("new:{gen}:{id}"),
                                "新作业".into(),
                                format!("{course} · {title}"),
                                "作业",
                                service,
                                now,
                            ) {
                                notifications.push(e);
                            }
                        }
                        if r["detail_error"] == true
                            || r["last_attempt"].as_str().is_some_and(|v| !v.is_empty())
                        {
                            continue;
                        }
                        let Some(deadline) = r["deadline"].as_str().and_then(deadline_seconds)
                        else {
                            continue;
                        };
                        let left = deadline - now;
                        let stage = if left > 0 && left <= 3600 {
                            Some("1h")
                        } else if left > 3600 && left <= 86400 {
                            Some("24h")
                        } else {
                            None
                        };
                        if let Some(stage) = stage {
                            if let Some(e) = add(
                                &mut s,
                                format!("due:{gen}:{id}:{deadline}:{stage}"),
                                if stage == "1h" {
                                    "作业将在 1 小时内截止"
                                } else {
                                    "作业将在 24 小时内截止"
                                }
                                .into(),
                                format!("{course} · {title}"),
                                "作业",
                                service,
                                now,
                            ) {
                                notifications.push(e);
                            }
                        }
                    }
                }
                Request::Notices => {
                    let Some(rows) = data.as_array() else {
                        continue;
                    };
                    let ids = rows
                        .iter()
                        .map(|r| format!("{:x}", Sha256::digest(r.to_string())))
                        .collect::<Vec<_>>();
                    let fresh = delta(&mut s, &format!("notices:{gen}"), ids.clone());
                    for (r, id) in rows.iter().zip(ids) {
                        if fresh.contains(&id) {
                            if let Some(e) = add(
                                &mut s,
                                format!("notice:{gen}:{id}"),
                                "课程通知更新".into(),
                                format!(
                                    "{} · {}",
                                    r["course_name"].as_str().unwrap_or("课程"),
                                    r["announcement"]["title"].as_str().unwrap_or("通知")
                                ),
                                "通知",
                                service,
                                now,
                            ) {
                                notifications.push(e);
                            }
                        }
                    }
                }
                Request::Scores => {
                    if !data["courses"].is_array() {
                        continue;
                    }
                    let hash = format!("{:x}", Sha256::digest(data.to_string()));
                    let fresh = delta(&mut s, &format!("scores:{gen}"), vec![hash.clone()]);
                    if !fresh.is_empty() {
                        if let Some(e) = add(
                            &mut s,
                            format!("scores:{gen}:{hash}"),
                            "成绩查询有更新".into(),
                            "打开成绩与考试查看学校返回的最新结果".into(),
                            "成绩与考试",
                            service,
                            now,
                        ) {
                            notifications.push(e);
                        }
                    }
                }
                _ => {}
            }
        }
        if s.events.len() > 300 {
            s.events.drain(..s.events.len() - 300);
        }
        // Bound only obsolete account baselines; current-source history must retain dedup keys.
        s.baselines.retain(|k, _| {
            k.contains(&fingerprint("course")) || k.contains(&fingerprint("treehole"))
        });
        s.sent
            .retain(|k| k.contains(&fingerprint("course")) || k.contains(&fingerprint("treehole")));
        save(&s)?;
        Ok(notifications)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_snapshot_is_quiet_and_changes_are_deduplicated() {
        let mut s = Saved::default();
        assert!(delta(&mut s, "a", vec!["one".into()]).is_empty());
        assert_eq!(
            delta(&mut s, "a", vec!["one".into(), "two".into()]),
            vec!["two"]
        );
        assert!(delta(&mut s, "b", vec!["new account".into()]).is_empty());
    }
    #[test]
    fn naive_school_deadlines_are_beijing_time() {
        assert_eq!(
            deadline_seconds("2026-09-09T23:59:00"),
            deadline_seconds("2026-09-09T23:59:00+08:00")
        );
        assert_eq!(deadline_seconds("unavailable"), None);
    }
}
