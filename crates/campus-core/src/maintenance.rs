use super::*;
use std::sync::atomic::Ordering;

const INTERVAL: i64 = 15 * 60;
#[derive(Default, Clone)]
pub(crate) struct Health {
    generation: String,
    attempted: i64,
    verified: Option<String>,
    blocked: bool,
    error: Option<String>,
}
fn hard_expired(service: &str, session: &pkuinfo_common::session::Session) -> bool {
    service == "treehole" && session.is_expired()
}
fn due(h: Option<&Health>, generation: &str, now: i64) -> bool {
    h.is_none_or(|h| h.generation != generation || (!h.blocked && now - h.attempted >= INTERVAL))
}
pub(crate) fn card_token() -> Result<String> {
    Ok(Store::new("campuscard")?
        .load_session()?
        .ok_or_else(|| anyhow!("未登录"))?
        .token)
}
fn pref_path() -> Result<std::path::PathBuf> {
    let dirs = directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位设置目录"))?;
    Ok(dirs.config_dir().join("preferences.json"))
}
impl Core {
    pub fn new() -> Arc<Self> {
        let core = Arc::new(Self::default());
        core.restore_cache();
        core.recover_writes();
        // Bind existing subtitles before the user next changes login credentials.
        let initial = core.clone();
        std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Runtime::new() {
                let generation = fingerprint("course");
                let _ = runtime.block_on(initial.subtitle_account(&generation));
            }
        });
        let enabled = pref_path()
            .ok()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["keepAlive"].as_bool())
            .unwrap_or(true);
        core.keep_alive.store(enabled, Ordering::Relaxed);
        let weak = Arc::downgrade(&core);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            let Some(core) = weak.upgrade() else { break };
            if !core.keep_alive.load(Ordering::Relaxed) {
                continue;
            }
            for service in ["course", "treehole", "campuscard"] {
                let Ok(Some(session)) = Store::new(service).and_then(|s| s.load_session()) else {
                    continue;
                };
                if hard_expired(service, &session) {
                    continue;
                }
                let generation = fingerprint(service);
                let now = chrono::Utc::now().timestamp();
                {
                    let mut health = core.health.lock().unwrap();
                    if !due(health.get(service), &generation, now) {
                        continue;
                    }
                    let h = health.entry(service.into()).or_default();
                    if h.generation != generation {
                        *h = Health {
                            generation,
                            ..Default::default()
                        };
                    }
                    h.attempted = now;
                }
                let core = core.clone();
                std::thread::spawn(move || {
                    core.maintain(service);
                });
            }
        });
        core
    }
    pub(crate) fn course_api(&self) -> Result<pku_course::api::CourseApi> {
        let generation = fingerprint("course");
        let mut slot = self.course.lock().unwrap();
        if slot.as_ref().is_none_or(|(g, _)| g != &generation) {
            *slot = Some((
                generation,
                pku_course::api::CourseApi::from_session_persistent()?,
            ));
        }
        slot.as_ref().unwrap().1.fresh_client()
    }
    pub(crate) fn record_health(&self, service: &str, out: &Envelope) {
        if out.generation != fingerprint(service) {
            return;
        }
        let mut health = self.health.lock().unwrap();
        let h = health.entry(service.into()).or_default();
        if h.generation != out.generation {
            *h = Health {
                generation: out.generation.clone(),
                ..Default::default()
            };
        }
        h.attempted = chrono::Utc::now().timestamp();
        if let Some(e) = &out.error {
            h.error = Some(e.message.clone());
            // A course-specific challenge must not disable ordinary treehole access.
            if e.code == "auth" {
                h.blocked = true;
            }
        } else {
            h.verified = out.updated_at.clone();
            h.blocked = false;
            h.error = None;
            if service == "course" {
                if let Some((g, api)) = self.course.lock().unwrap().as_ref() {
                    if g == &out.generation && api.persist_cookies().is_err() {
                        h.error = Some("会话可用，但更新后的 Cookie 未能保存".into());
                    }
                }
            }
        }
    }
    fn maintain(self: &Arc<Self>, service: &'static str) {
        if service != "treehole" {
            self.call(if service == "course" {
                Request::Courses
            } else {
                Request::Card
            });
            return;
        }
        let generation = fingerprint(service);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(30), async {
                pku_treehole::api::TreeholeApi::from_session_noninteractive()
                    .await?
                    .unread_count()
                    .await?;
                Ok::<_, anyhow::Error>(())
            })
            .await
            .map_err(|_| anyhow!("超时"))?
        });
        let out = Envelope {
            data: None,
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            stale: false,
            error: result.err().map(problem),
            warnings: vec![],
            generation,
        };
        self.record_health(service, &out);
    }
    pub(crate) fn sessions(&self) -> Value {
        let health = self.health.lock().unwrap();
        json!(["course","treehole","campuscard","bdkj"].map(|name| {
            let generation = fingerprint(name);
            let h = health.get(name).filter(|h| h.generation == generation);
            let s = Store::new(name).and_then(|s| s.load_session());
            let state = match s {
                Ok(Some(s)) if hard_expired(name,&s) || h.is_some_and(|h|h.blocked) => "expired",
                Ok(Some(_)) if h.is_some_and(|h|h.verified.is_some()) => "verified",
                Ok(Some(_)) => "saved", Ok(None) => "missing", Err(_) => "error",
            };
            json!({"service":name,"state":state,"generation":generation,"verifiedAt":h.and_then(|h|h.verified.clone()),"message":h.and_then(|h|h.error.clone())})
        }))
    }
    pub(crate) fn save_preference(&self, enabled: bool) -> Result<()> {
        write_preference("keepAlive", json!(enabled))?;
        self.keep_alive.store(enabled, Ordering::Relaxed);
        Ok(())
    }
    /// 用户资料（年级、院系、专业、培养方案与待确认归类）。只存本机，不含凭证。
    pub(crate) fn profile(&self) -> Result<Value> {
        Ok(read_preferences()
            .get("profile")
            .cloned()
            .unwrap_or(Value::Null))
    }
    pub(crate) fn save_profile(&self, profile: &Value) -> Result<Value> {
        if !profile.is_object() && !profile.is_null() {
            bail!("资料格式不正确");
        }
        if serde_json::to_vec(profile)?.len() > 256 * 1024 {
            bail!("资料过大，请清理待确认归类");
        }
        write_preference("profile", profile.clone())?;
        Ok(profile.clone())
    }
}
pub(crate) fn read_preferences() -> serde_json::Map<String, Value> {
    pref_path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}
/// 读改写整个 preferences.json，原子替换，其他键保持不变。
pub(crate) fn write_preference(key: &str, value: Value) -> Result<()> {
    let path = pref_path()?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    let mut prefs = read_preferences();
    prefs.insert(key.to_string(), value);
    let temp = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
    std::fs::write(&temp, serde_json::to_vec(&Value::Object(prefs))?)?;
    std::fs::rename(temp, path)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synthetic_deadlines_do_not_force_desktop_logout() {
        let mut session = pkuinfo_common::session::Session::new("synthetic-test-token".into());
        session.expires_at = Some(1);
        assert!(!hard_expired("course", &session));
        assert!(!hard_expired("campuscard", &session));
        assert!(hard_expired("treehole", &session));
    }
    #[test]
    fn maintenance_backs_off_and_restarts_on_account_change() {
        let mut h = Health {
            generation: "a".into(),
            attempted: 100,
            ..Default::default()
        };
        assert!(!due(Some(&h), "a", 999));
        assert!(due(Some(&h), "a", 1000));
        h.blocked = true;
        assert!(!due(Some(&h), "a", 10000));
        assert!(due(Some(&h), "b", 10000));
    }
}
