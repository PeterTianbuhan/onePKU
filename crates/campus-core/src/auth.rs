use super::*;
use anyhow::Context;
use base64::Engine;
/// 每个服务向学校换票时用的应用标识与回调地址；树洞还要带设备号。
fn iaaa_config_for(service: &str, device: &str) -> pkuinfo_common::iaaa::IaaaConfig {
    match service {
        "course" => pku_course::login::iaaa_config(),
        "bdkj" => pku_bdkj::login::iaaa_config(),
        "campuscard" => pku_campuscard::login::iaaa_config(),
        "portal" => pku_portal::login::iaaa_config(),
        _ => pku_treehole::login::iaaa_config(device),
    }
}
#[derive(Clone)]
pub struct Attempt {
    client: reqwest::Client,
    service: String,
    app: String,
    redirect: String,
    device: String,
    expires: std::time::Instant,
}
impl Core {
    /// 账号密码登录：一次提交把四个服务依次换成各自的会话，与安卓端一致。
    /// 密码只在这一次调用里用到，不进缓存键，也不写进本机快照。
    /// 本机钥匙串里的统一认证账号；只报账号，绝不返回密码或令牌密钥。
    pub(crate) fn credentials_status() -> Value {
        let stored = pkuinfo_common::credential::keyring_username();
        json!({
            "stored": stored.is_some(),
            "username": stored.unwrap_or_default(),
            "otpStored": pkuinfo_common::credential::keyring_otp_secret().is_some(),
            "otpImport": otp_import_offer(),
        })
    }
    /// 记住就写进系统加密存储（macOS 钥匙串 / Windows 凭据管理器），不记就清掉。
    pub(crate) fn set_credentials(
        username: &str,
        password: &str,
        remember: bool,
    ) -> Result<Value> {
        if !remember {
            pkuinfo_common::credential::keyring_clear()?;
            return Ok(Self::credentials_status());
        }
        let username = username.trim();
        if username.is_empty() || password.is_empty() {
            bail!("要记住登录，请填写完整的校园账号与密码");
        }
        pkuinfo_common::credential::keyring_store(username, password)?;
        Ok(Self::credentials_status())
    }
    pub(crate) fn clear_credentials() -> Result<Value> {
        pkuinfo_common::credential::keyring_clear()?;
        pkuinfo_common::credential::keyring_clear_otp()?;
        Ok(Self::credentials_status())
    }
    pub(crate) async fn auth_password(
        &self,
        services: &[String],
        username: &str,
        password: &str,
        otp: Option<&str>,
        otp_secret: Option<&str>,
        remember: bool,
    ) -> Result<Value> {
        // 留空的账号或密码各自回落到钥匙串；新填的值只在登录成功后才写回去。
        let (username, password) = resolve_login_identity(username, password)?;
        let saved_otp = stored_otp_secret();
        otp_for_login(otp, otp_secret, saved_otp.as_deref())?;
        let wanted = password_services(services);
        if wanted.is_empty() {
            bail!("没有可登录的服务");
        }
        let mut done: Vec<String> = vec![];
        let mut failed: Vec<Value> = vec![];
        for service in &wanted {
            let otp_code = otp_for_login(otp, otp_secret, saved_otp.as_deref())?;
            match self
                .login_with_password(service, &username, &password, otp_code.as_deref())
                .await
            {
                Ok(()) => done.push(service.clone()),
                Err(error) => {
                    let p = problem(error);
                    failed.push(json!({
                        "service": service,
                        "code": p.code,
                        "message": p.message,
                    }));
                }
            }
        }
        if done.is_empty() {
            bail!(
                "{}",
                failed
                    .first()
                    .and_then(|f| f["message"].as_str())
                    .unwrap_or("统一身份认证失败")
            );
        }
        // 记住失败不影响这次登录，只如实说明。密钥也只在登录成功后才替换。
        let remembered = match Self::set_credentials(&username, &password, remember) {
            Ok(_) => {
                if remember { commit_otp_secret(otp_secret).is_ok() }
                else { pkuinfo_common::credential::keyring_clear_otp().is_ok() }
            }
            Err(_) => false,
        };
        Ok(json!({
            "state": "success",
            "done": done,
            "failed": failed,
            "remembered": remembered,
        }))
    }
    /// 会话过期时拿钥匙串里记住的账号换一张新票，对应安卓端 `AuthManager.relogin`。
    /// 这条路径绝不写也绝不删钥匙串：自动续期要是顺手清了凭据，下次过期就只剩人工登录。
    /// 钥匙串里有手机令牌密钥时，这里会生成当前口令。
    pub(crate) async fn relogin(&self, service: &str) -> Result<()> {
        let credential = pkuinfo_common::credential::keyring_credential()
            .ok_or_else(|| anyhow!("没有记住的账号，请手动登录"))?;
        let otp = otp_for_login(None, None, stored_otp_secret().as_deref())?;
        self.login_with_password(
            service,
            &credential.username,
            &credential.password,
            otp.as_deref(),
        )
        .await
    }
    /// 同一个服务同时只跑一次自动重登。失败之后停掉，直到用户手动登录成功。
    pub(crate) async fn relogin_once(&self, service: &str) -> bool {
        let seen = {
            let state = self.relogin.lock().unwrap();
            if state.stopped.contains(service) {
                return false;
            }
            state.epoch.get(service).copied().unwrap_or(0)
        };
        let lock = {
            let mut locks = self.relogin_locks.lock().unwrap();
            locks
                .entry(service.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        {
            let state = self.relogin.lock().unwrap();
            if state.stopped.contains(service) {
                return false;
            }
            if state.epoch.get(service).copied().unwrap_or(0) != seen {
                return true;
            }
        }
        match tokio::time::timeout(Duration::from_secs(65), self.relogin(service)).await {
            Ok(Ok(())) => {
                let mut state = self.relogin.lock().unwrap();
                *state.epoch.entry(service.to_string()).or_insert(0) += 1;
                true
            }
            _ => {
                self.relogin.lock().unwrap().stopped.insert(service.to_string());
                false
            }
        }
    }
    pub(crate) fn note_manual_login(&self, service: &str) {
        let mut state = self.relogin.lock().unwrap();
        state.stopped.remove(service);
        *state.epoch.entry(service.to_string()).or_insert(0) += 1;
    }
    pub(crate) fn stop_relogin(&self, service: &str) {
        self.relogin.lock().unwrap().stopped.insert(service.to_string());
    }
    pub(crate) fn import_otp(&self) -> Result<Value> {
        let Some(config) = find_pkucli_otp() else {
            bail!("这台机器上没有找到 pkucli 保存的手机令牌");
        };
        let secret = normalize_secret(&config.secret)?;
        pkuinfo_common::credential::keyring_store_otp(&secret)?;
        let _ = super::maintenance::write_preference("otpImportOffered", json!(true));
        Ok(Self::credentials_status())
    }
    pub(crate) fn dismiss_otp_import(&self) -> Result<Value> {
        super::maintenance::write_preference("otpImportOffered", json!(true))?;
        Ok(Self::credentials_status())
    }
    async fn login_with_password(
        &self,
        service: &str,
        username: &str,
        password: &str,
        otp: Option<&str>,
    ) -> Result<()> {
        let store = Store::new(service)?;
        let device = if service == "treehole" {
            pku_treehole::login::get_device_uuid(&store)
        } else {
            String::new()
        };
        let config = iaaa_config_for(service, &device);
        let client = pku_course::client::build_simple()?;
        let token = pkuinfo_common::iaaa::login_password(
            &client, &config, username, password, otp,
        )
        .await?
        .token;
        self.complete_service_login(service, &store, &token, &device)
            .await
    }
    /// 拿到 iaaa 票据后将各服务换成自己的会话；扫码与密码两条路共用。
    async fn complete_service_login(
        &self,
        service: &str,
        store: &Store,
        token: &str,
        device: &str,
    ) -> Result<()> {
        match service {
            "course" => pku_course::login::complete_bb_login(store, token).await?,
            "bdkj" => pku_bdkj::login::complete_bdkj_login(store, token, "").await?,
            "campuscard" => pku_campuscard::login::complete_login(store, token, "").await?,
            "portal" => pku_portal::login::complete_portal_login(store, token).await?,
            _ => pku_treehole::login::complete_gui_login(store, token, device).await?,
        }
        if service == "course" {
            let _ = self.subtitle_account(&fingerprint("course")).await;
        }
        self.note_manual_login(service);
        Ok(())
    }
    pub(crate) async fn auth_begin(&self, service: &str) -> Result<Value> {
        let store = Store::new(match service {
            "course" | "treehole" | "campuscard" | "bdkj" | "portal" => service,
            _ => bail!("invalid service"),
        })?;
        let device = if service == "treehole" {
            pku_treehole::login::get_device_uuid(&store)
        } else {
            String::new()
        };
        let config = iaaa_config_for(service, &device);
        let client = pku_course::client::build_simple()?;
        client
            .get("https://iaaa.pku.edu.cn/iaaa/oauth.jsp")
            .query(&[
                ("appID", &config.app_id),
                ("redirectUrl", &config.redirect_url),
            ])
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let bytes = client
            .get("https://iaaa.pku.edu.cn/iaaa/genQRCode.do")
            .query(&[
                ("userName", ""),
                ("appId", &config.app_id),
                ("_rand", &rand::random::<f64>().to_string()),
            ])
            .header("referer", "https://iaaa.pku.edu.cn/iaaa/oauth.jsp")
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let mime = qr_mime(&bytes)?;
        let id = format!("{:032x}", rand::random::<u128>());
        let mut attempts = self.auth.lock().unwrap();
        attempts.retain(|_, a| a.expires > std::time::Instant::now() && a.service != service);
        if attempts.len() > 3 {
            attempts.clear()
        }
        attempts.insert(
            id.clone(),
            Attempt {
                client,
                service: service.into(),
                app: config.app_id,
                redirect: config.redirect_url,
                device,
                expires: std::time::Instant::now() + Duration::from_secs(180),
            },
        );
        Ok(
            json!({"id":id,"qr":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)),"state":"pending"}),
        )
    }
    pub(crate) async fn auth_poll(&self, id: &str) -> Result<Value> {
        let a = self
            .auth
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("二维码已过期"))?;
        if a.expires < std::time::Instant::now() {
            self.auth.lock().unwrap().remove(id);
            return Ok(json!({"state":"expired"}));
        }
        let v: Value = a
            .client
            .post("https://iaaa.pku.edu.cn/iaaa/oauthlogin4QRCode.do")
            .header("x-requested-with", "XMLHttpRequest")
            .header("referer", "https://iaaa.pku.edu.cn/iaaa/oauth.jsp")
            .form(&[
                ("appId", "PKUApp"),
                ("issuerAppId", "iaaa"),
                ("targetAppId", &a.app),
                ("redirectUrl", &a.redirect),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if v["success"] == true {
            if self.auth.lock().unwrap().remove(id).is_none() {
                return Ok(json!({"state":"cancelled"}));
            }
            let token = v["token"].as_str().ok_or_else(|| anyhow!("empty token"))?;
            let store = Store::new(&a.service)?;
            self.complete_service_login(&a.service, &store, &token, &a.device)
                .await?;
            Ok(json!({"state":"success"}))
        } else {
            let code = v["errors"]["code"].as_str().unwrap_or("");
            Ok(
                json!({"state":if code=="E99"{"expired"}else if code=="E10"{"pending"}else{"failed"}}),
            )
        }
    }
    pub(crate) async fn sms(&self, scope: &str, code: Option<&String>) -> Result<Value> {
        if !matches!(scope, "treehole" | "timetable") {
            bail!("invalid scope")
        }
        if let Some(c) = code {
            if !(4..=8).contains(&c.len()) || !c.chars().all(|c| c.is_ascii_digit()) {
                bail!("invalid code")
            }
        }
        let store = Store::new("treehole")?;
        let session = store.load_session()?.ok_or_else(|| anyhow!("未登录"))?;
        let path = match (scope, code.is_some()) {
            ("treehole", false) => "jwt_send_msg",
            ("treehole", true) => "jwt_msg_verify",
            (_, false) => "course/send_get_token_message",
            (_, true) => "course/mobile_message_get_token",
        };
        let client = pku_treehole::client::build(store.load_cookie_store()?)?;
        let body = match code {
            None => json!({}),
            Some(c) => {
                if scope == "treehole" {
                    json!({"valid_code":c})
                } else {
                    json!({"code":c})
                }
            }
        };
        let v: Value = client
            .post(format!("https://treehole.pku.edu.cn/chapi/api/{path}"))
            .header("authorization", format!("Bearer {}", session.token))
            .header("uuid", session.extra["full_uuid"].as_str().unwrap_or(""))
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if v["success"] != true {
            if code.is_none() && v["message"].as_str().unwrap_or("").contains("未过期") {
                return Ok(json!({"state":"sent"}));
            }
            bail!("sms failed")
        }
        Ok(json!({"state":if code.is_some(){"success"}else{"sent"}}))
    }
}

/// 一次登录要换票的服务。空列表就是全部，含校内门户；课堂实录不走这条路。
pub(crate) fn password_services(requested: &[String]) -> Vec<String> {
    const ALL: &[&str] = &["course", "treehole", "campuscard", "bdkj", "portal"];
    if requested.is_empty() {
        return ALL.iter().map(|service| (*service).to_string()).collect();
    }
    let mut out = vec![];
    for service in requested {
        if ALL.contains(&service.as_str()) && !out.iter().any(|kept: &String| kept == service) {
            out.push(service.clone());
        }
    }
    out
}

fn resolve_login_identity(username: &str, password: &str) -> Result<(String, String)> {
    let stored = pkuinfo_common::credential::keyring_credential();
    let username = if username.trim().is_empty() {
        stored
            .as_ref()
            .map(|credential| credential.username.clone())
            .unwrap_or_default()
    } else {
        username.trim().to_string()
    };
    let password = if password.is_empty() {
        stored
            .as_ref()
            .map(|credential| credential.password.clone())
            .unwrap_or_default()
    } else {
        password.to_string()
    };
    if username.is_empty() || password.is_empty() {
        bail!("请填写校园账号与密码");
    }
    Ok((username, password))
}

fn stored_otp_secret() -> Option<String> {
    pkuinfo_common::credential::keyring_otp_secret()
}

pub(crate) fn stored_otp_present() -> bool {
    stored_otp_secret().is_some()
}

/// 显式口令优先。`replacement` 为 Some("") 表示这次不用密钥；Some(secret) 用新密钥；None 用已保存的。
pub(crate) fn otp_for_login(
    explicit: Option<&str>,
    replacement: Option<&str>,
    stored: Option<&str>,
) -> Result<Option<String>> {
    if let Some(code) = explicit.map(str::trim).filter(|code| !code.is_empty()) {
        return Ok(Some(code.to_string()));
    }
    let secret = match replacement {
        Some(value) if value.trim().is_empty() => return Ok(None),
        Some(value) => normalize_secret(value)?,
        None => match stored.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => normalize_secret(value)?,
            None => return Ok(None),
        },
    };
    Ok(Some(pkuinfo_common::otp::generate_totp(&secret)?))
}

fn normalize_secret(secret: &str) -> Result<String> {
    let compact: String = secret.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        bail!("手机令牌密钥是空的");
    }
    pkuinfo_common::otp::generate_totp(&compact).context("手机令牌密钥无法使用，请检查是不是 Base32 密钥")?;
    Ok(compact)
}

/// 登录已经成功之后才改钥匙串里的密钥。None 表示不动已保存的。
fn commit_otp_secret(replacement: Option<&str>) -> Result<()> {
    match replacement {
        None => Ok(()),
        Some(value) if value.trim().is_empty() => pkuinfo_common::credential::keyring_clear_otp(),
        Some(value) => {
            let secret = normalize_secret(value)?;
            pkuinfo_common::credential::keyring_store_otp(&secret)
        }
    }
}

pub(crate) fn logged_out_prompt(otp_saved: bool) -> &'static str {
    if otp_saved {
        "自动重新登录没有成功，请重新登录"
    } else {
        "登录已失效。若学校要求手机令牌，请先在设置里保存密钥，再重新登录"
    }
}

#[derive(Default)]
pub(crate) struct ReloginState {
    pub(crate) stopped: std::collections::HashSet<String>,
    pub(crate) epoch: std::collections::HashMap<String, u64>,
}

fn otp_import_offer() -> Value {
    if stored_otp_secret().is_some() || otp_import_offered() {
        return Value::Null;
    }
    match find_pkucli_otp() {
        Some(config) => json!({
            "userId": config.user_id,
            "userName": config.user_name,
        }),
        None => Value::Null,
    }
}

fn otp_import_offered() -> bool {
    super::maintenance::read_preferences()
        .get("otpImportOffered")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn find_pkucli_otp() -> Option<pkuinfo_common::otp::OtpConfig> {
    let dirs = directories::ProjectDirs::from("", "", "info")?;
    for name in ["course", "treehole", "campuscard", "bdkj", "elective", "cwfw"] {
        let dir = dirs.config_dir().join(name);
        let Ok(Some(config)) = pkuinfo_common::otp::load_otp_config(&dir) else {
            continue;
        };
        if normalize_secret(&config.secret).is_ok() {
            return Some(config);
        }
    }
    None
}

fn qr_mime(bytes: &[u8]) -> Result<&'static str> {
    if bytes.len() > 2_000_000 {
        bail!("invalid qr");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok("image/jpeg")
    } else {
        bail!("invalid qr")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qr_uses_image_signature_not_server_content_type() {
        assert_eq!(qr_mime(b"\xff\xd8\xff\xe0test").unwrap(), "image/jpeg");
        assert_eq!(qr_mime(b"\x89PNG\r\n\x1a\ntest").unwrap(), "image/png");
        assert!(qr_mime(b"<html>error</html>").is_err());
    }
    #[test]
    fn one_click_login_includes_portal_and_skips_haoxue() {
        let all = password_services(&[]);
        assert_eq!(
            all,
            vec!["course", "treehole", "campuscard", "bdkj", "portal"]
        );
        let picked = password_services(&["portal".into(), "haoxue".into(), "portal".into()]);
        assert_eq!(picked, vec!["portal"]);
    }
    #[test]
    fn explicit_otp_wins_and_a_new_secret_is_checked_before_use() {
        assert_eq!(
            otp_for_login(Some("123456"), Some(""), None).unwrap().as_deref(),
            Some("123456")
        );
        // 空的新密钥表示这次登录不带口令，也不去读已保存的密钥。
        assert_eq!(otp_for_login(None, Some("  "), Some("GEZDGNBVGY3TQOJQ")).unwrap(), None);
        assert!(otp_for_login(None, Some("not-a-secret"), None).is_err());
        let code = otp_for_login(None, None, Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"))
            .unwrap()
            .unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
    }
    #[test]
    fn totp_matches_the_rfc6238_sha1_vector() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(
            pkuinfo_common::otp::generate_totp_at(secret, 59).unwrap(),
            "287082"
        );
        assert_eq!(
            pkuinfo_common::otp::generate_totp_at(secret, 1111111109).unwrap(),
            "081804"
        );
    }
    #[test]
    fn failed_relogin_stops_until_manual_login() {
        let mut state = ReloginState::default();
        assert!(!state.stopped.contains("course"));
        state.stopped.insert("course".into());
        assert!(state.stopped.contains("course"));
        state.stopped.remove("course");
        *state.epoch.entry("course".into()).or_insert(0) += 1;
        assert!(!state.stopped.contains("course"));
        assert_eq!(state.epoch["course"], 1);
        // 别人已经把这个服务的代际往前拨过，后来的请求就不必再登一次。
        let seen = 0;
        assert_ne!(state.epoch["course"], seen);
    }
    #[test]
    fn logged_out_prompt_mentions_the_token_when_it_is_missing() {
        assert!(logged_out_prompt(false).contains("手机令牌"));
        assert!(logged_out_prompt(true).contains("重新登录"));
        assert!(!logged_out_prompt(true).contains("手机令牌"));
    }
}
