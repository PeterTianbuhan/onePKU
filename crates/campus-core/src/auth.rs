use super::*;
use base64::Engine;
use zeroize::Zeroizing;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordLoginResult {
    pub service: String,
    pub success: bool,
    pub message: Option<String>,
    pub warning: Option<String>,
}

pub(crate) struct ReloginAttempt {
    generation: String,
    at: std::time::Instant,
}
fn recovery_allowed(saved: &str, current: &str, previous: Option<&ReloginAttempt>) -> bool {
    saved == current
        && previous
            .is_none_or(|p| p.generation != current && p.at.elapsed() >= Duration::from_secs(60))
}

fn login_config(service: &str, device: &str) -> Result<pkuinfo_common::iaaa::IaaaConfig> {
    Ok(match service {
        "course" => pku_course::login::iaaa_config(),
        "treehole" => pku_treehole::login::iaaa_config(device),
        "campuscard" => pku_campuscard::login::iaaa_config(),
        "bdkj" => pku_bdkj::login::iaaa_config(),
        _ => bail!("不支持的登录服务"),
    })
}

fn validate_password_input(username: &str, password: &str, otp: &str) -> Result<()> {
    if username.is_empty() || username.len() > 128 || username.chars().any(char::is_whitespace) {
        bail!("请输入正确的学号或职工号");
    }
    if password.is_empty() || password.len() > 512 {
        bail!("请输入统一身份认证密码");
    }
    if !otp.is_empty()
        && (!(4..=8).contains(&otp.len()) || !otp.bytes().all(|b| b.is_ascii_digit()))
    {
        bail!("动态口令应为 4–8 位数字");
    }
    Ok(())
}

// Never send upstream errors/URLs back to JS: callbacks may include tokens.
fn password_error(error: &anyhow::Error) -> &'static str {
    let text = format!("{error:#}");
    if text.contains("otp")
        || text.contains("OTP")
        || text.contains("令牌")
        || text.contains("动态口令")
    {
        "请填写当前动态口令后重试，也可以切换扫码登录"
    } else if text.contains("IAAA 登录失败") {
        "身份认证未通过，请检查学号、密码和动态口令；需要额外验证时可使用扫码登录"
    } else if text.contains("timed out") || text.contains("超时") {
        "连接学校超时，请稍后重试"
    } else {
        "未能连接学校服务，请检查网络后重试，或使用扫码登录"
    }
}

pub(crate) fn recoverable_read(request: &Request) -> bool {
    matches!(
        request,
        Request::Courses
            | Request::AllCourses
            | Request::Scores
            | Request::Exams
            | Request::Card
            | Request::Transactions { .. }
            | Request::CardStats { .. }
            | Request::Assignments
            | Request::CourseAssignments { .. }
            | Request::Notices
            | Request::CourseNotices { .. }
            | Request::Content { .. }
            | Request::Videos { .. }
            | Request::LearningGrades { .. }
            | Request::AssignmentFeedback { .. }
    )
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
    /// Dedicated native IPC, deliberately absent from serializable Request/cache keys.
    pub fn login_password(
        &self,
        service: &str,
        username: String,
        password: String,
        otp: String,
        remember: bool,
    ) -> PasswordLoginResult {
        let username = Zeroizing::new(username.trim().to_owned());
        let password = Zeroizing::new(password);
        let otp = Zeroizing::new(otp);
        let mut out = PasswordLoginResult {
            service: service.into(),
            success: false,
            message: None,
            warning: None,
        };
        if let Err(e) = login_config(service, "")
            .and_then(|_| validate_password_input(&username, &password, &otp))
        {
            out.message = Some(e.to_string());
            return out;
        }
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            out.message = Some("服务暂不可用".into());
            return out;
        };
        runtime.block_on(async {
            let _guard = self.login_lock.lock().await;
            self.auth
                .lock()
                .unwrap()
                .retain(|_, a| a.service != service);
            match self
                .password_session(service, &username, &password, &otp)
                .await
            {
                Ok(()) => {
                    out.success = true;
                    self.relogins.lock().unwrap().remove(service);
                    let saved = if remember {
                        credentials::save(
                            service,
                            &credentials::SavedLogin {
                                username: username.to_string(),
                                password: password.to_string(),
                                generation: fingerprint(service),
                            },
                        )
                    } else {
                        credentials::clear(service)
                    };
                    if saved.is_err() {
                        out.warning = Some(
                            if remember {
                                "登录成功，但系统钥匙串未能保存密码；下次需要手动登录"
                            } else {
                                "登录成功，但钥匙串中的旧密码未能删除；请在设置中重试删除"
                            }
                            .into(),
                        );
                    }
                }
                Err(e) => out.message = Some(password_error(&e).into()),
            }
        });
        out
    }

    async fn password_session(
        &self,
        service: &str,
        username: &str,
        password: &str,
        otp: &str,
    ) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(65), async {
            let store = Store::new(service)?;
            let device = if service == "treehole" {
                pku_treehole::login::get_device_uuid(&store)
            } else {
                String::new()
            };
            let config = login_config(service, &device)?;
            let client = if service == "campuscard" {
                pku_campuscard::client::build_simple()?
            } else {
                pku_course::client::build_simple()?
            };
            let token = pkuinfo_common::iaaa::login_password(
                &client,
                &config,
                username,
                password,
                (!otp.is_empty()).then_some(otp),
            )
            .await?;
            match service {
                "course" => {
                    pku_course::login::complete_bb_login_for_user(
                        &store,
                        &token.token,
                        Some(username),
                    )
                    .await?
                }
                "treehole" => {
                    pku_treehole::login::complete_gui_login(&store, &token.token, &device).await?
                }
                "campuscard" => {
                    pku_campuscard::login::complete_login(&store, &token.token, username).await?
                }
                "bdkj" => {
                    pku_bdkj::login::complete_bdkj_login(&store, &token.token, username).await?
                }
                _ => bail!("invalid service"),
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(|_| anyhow!("超时"))??;
        self.cache.lock().unwrap().retain(|key, _| {
            key.split_once(':')
                .and_then(|(_, raw)| serde_json::from_str::<Request>(raw).ok())
                .is_none_or(|r| owner(&r) != service)
        });
        self.health.lock().unwrap().remove(service);
        // Account-bound caches are adopted lazily after the new service session is verified.
        if service == "course" {
            *self.course.lock().unwrap() = None;
        }
        Ok(())
    }

    pub(crate) async fn try_relogin(&self, service: &str, generation: &str) -> bool {
        if !self.keep_alive.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        let _guard = self.login_lock.lock().await;
        // Do not let a late read restore a different account after manual/QR login.
        if fingerprint(service) != generation {
            return false;
        }
        {
            let mut attempts = self.relogins.lock().unwrap();
            if !recovery_allowed(generation, generation, attempts.get(service)) {
                return false;
            }
            attempts.insert(
                service.into(),
                ReloginAttempt {
                    generation: generation.into(),
                    at: std::time::Instant::now(),
                },
            );
        }
        let Ok(Some(mut saved)) = credentials::load(service) else {
            return false;
        };
        if !recovery_allowed(&saved.generation, generation, None) {
            return false;
        }
        // No stored OTP and no automatic SMS. A challenge ends this recovery attempt.
        if self
            .password_session(service, &saved.username, &saved.password, "")
            .await
            .is_err()
        {
            return false;
        }
        saved.generation = fingerprint(service);
        if credentials::save(service, &saved).is_err() {
            let _ = credentials::clear(service);
        }
        true
    }

    pub(crate) fn block_relogin(&self, service: &str, generation: &str) {
        self.relogins.lock().unwrap().insert(
            service.into(),
            ReloginAttempt {
                generation: generation.into(),
                at: std::time::Instant::now(),
            },
        );
    }

    pub(crate) async fn auth_begin(&self, service: &str) -> Result<Value> {
        let store = Store::new(match service {
            "course" | "treehole" | "campuscard" | "bdkj" => service,
            _ => bail!("invalid service"),
        })?;
        let device = if service == "treehole" {
            pku_treehole::login::get_device_uuid(&store)
        } else {
            String::new()
        };
        let config = match service {
            "course" => pku_course::login::iaaa_config(),
            "bdkj" => pku_bdkj::login::iaaa_config(),
            "treehole" => pku_treehole::login::iaaa_config(&device),
            _ => pku_campuscard::login::iaaa_config(),
        };
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
            let _guard = self.login_lock.lock().await;
            if self.auth.lock().unwrap().remove(id).is_none() {
                return Ok(json!({"state":"cancelled"}));
            }
            let token = v["token"].as_str().ok_or_else(|| anyhow!("empty token"))?;
            let store = Store::new(&a.service)?;
            match a.service.as_str() {
                "course" => pku_course::login::complete_bb_login(&store, token).await?,
                "bdkj" => pku_bdkj::login::complete_bdkj_login(&store, token, "").await?,
                "campuscard" => pku_campuscard::login::complete_login(&store, token, "").await?,
                _ => pku_treehole::login::complete_gui_login(&store, token, &a.device).await?,
            }
            if a.service == "course" {
                let _ = self.subtitle_account(&fingerprint("course")).await;
            }
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
    fn recovery_is_bound_to_the_saved_account_and_does_not_loop() {
        assert!(!recovery_allowed("old-account", "new-account", None));
        assert!(recovery_allowed("same", "same", None));
        let failed = ReloginAttempt {
            generation: "same".into(),
            at: std::time::Instant::now() - Duration::from_secs(3600),
        };
        assert!(!recovery_allowed("same", "same", Some(&failed)));
        let recent = ReloginAttempt {
            generation: "old".into(),
            at: std::time::Instant::now(),
        };
        assert!(!recovery_allowed("new", "new", Some(&recent)));
    }
    #[test]
    fn passwords_cannot_enter_the_serializable_resource_api() {
        assert!(serde_json::from_value::<Request>(
            json!({"kind":"loginPassword", "password":"synthetic-secret"})
        )
        .is_err());
        assert!(recoverable_read(&Request::Courses));
        for request in [
            Request::SmsSend {
                scope: "treehole".into(),
            },
            Request::CommitSubmission { id: "test".into() },
            Request::Download { id: "test".into() },
            Request::AuthBegin {
                service: "course".into(),
            },
        ] {
            assert!(!recoverable_read(&request));
        }
        let message = password_error(&anyhow!(
            "callback failed: https://school/?token=synthetic-secret"
        ));
        assert!(!message.contains("synthetic-secret"));
        assert!(!message.contains("https://"));
    }
    #[test]
    fn password_input_requires_credentials_and_valid_optional_otp() {
        assert!(validate_password_input("20260001", "secret", "").is_ok());
        assert!(validate_password_input("20260001", "secret", "123456").is_ok());
        assert!(validate_password_input("", "secret", "").is_err());
        assert!(validate_password_input("20260001", "", "").is_err());
        assert!(validate_password_input("20260001", "secret", "abc123").is_err());
        assert!(login_config("https://foreign.example", "").is_err());
    }
    #[test]
    fn qr_uses_image_signature_not_server_content_type() {
        assert_eq!(qr_mime(b"\xff\xd8\xff\xe0test").unwrap(), "image/jpeg");
        assert_eq!(qr_mime(b"\x89PNG\r\n\x1a\ntest").unwrap(), "image/png");
        assert!(qr_mime(b"<html>error</html>").is_err());
    }
}
