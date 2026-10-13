use super::*;
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
    /// 本机钥匙串里的统一认证账号；只报账号，绝不返回密码。
    pub(crate) fn credentials_status() -> Value {
        let stored = pkuinfo_common::credential::keyring_username();
        json!({ "stored": stored.is_some(), "username": stored.unwrap_or_default() })
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
        Ok(json!({ "stored": false, "username": "" }))
    }
    pub(crate) async fn auth_password(
        &self,
        services: &[String],
        username: &str,
        password: &str,
        otp: Option<&str>,
        remember: bool,
    ) -> Result<Value> {
        // 表单留空就是用已记住的账号；安卓端也是拿存下的凭据静默换票。
        let (username, password) =
            if username.trim().is_empty() || password.is_empty() {
                match pkuinfo_common::credential::keyring_credential() {
                    Some(credential) => (credential.username, credential.password),
                    None => bail!("请填写校园账号与密码"),
                }
            } else {
                (username.trim().to_string(), password.to_string())
            };
        let username = username.as_str();
        let password = password.as_str();
        let wanted: Vec<&str> = if services.is_empty() {
            vec!["course", "treehole", "campuscard", "bdkj"]
        } else {
            services
                .iter()
                .map(|service| service.as_str())
                .filter(|service| {
                    matches!(
                        *service,
                        "course" | "treehole" | "campuscard" | "bdkj"
                    )
                })
                .collect()
        };
        if wanted.is_empty() {
            bail!("没有可登录的服务");
        }
        let mut done: Vec<String> = vec![];
        let mut failed: Vec<Value> = vec![];
        for service in wanted {
            match self.login_with_password(service, username, password, otp).await {
                Ok(()) => done.push(service.to_string()),
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
        // 记住失败不影响这次登录，只如实说明。
        let remembered = match Self::set_credentials(username, password, remember) {
            Ok(_) => true,
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
    pub(crate) async fn relogin(&self, service: &str) -> Result<()> {
        let credential = pkuinfo_common::credential::keyring_credential()
            .ok_or_else(|| anyhow!("没有记住的账号，请手动登录"))?;
        self.login_with_password(service, &credential.username, &credential.password, None)
            .await
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
}
