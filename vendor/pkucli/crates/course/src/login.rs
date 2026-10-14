//! 教学网登录流程
//!
//! 完整流程：
//! 1. IAAA 登录（密码 or 扫码）→ 获得 iaaa_token
//! 2. 用 iaaa_token 回调 course.pku.edu.cn SSO → 建立 Blackboard 会话

use crate::client::{self, SSO_LOGIN};
use anyhow::{anyhow, Context, Result};
use colored::Colorize;
use pkuinfo_common::{
    credential,
    iaaa::{self, IaaaConfig},
    session::{Session, Store},
};

const APP_NAME: &str = "course";

/// IAAA OAuth redirect URL（与 pku3b 一致）
const OAUTH_REDIR: &str =
    "http://course.pku.edu.cn/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin";

pub fn iaaa_config() -> IaaaConfig {
    IaaaConfig {
        app_id: "blackboard".to_string(),
        redirect_url: OAUTH_REDIR.to_string(),
    }
}

/// 用户名密码登录
pub async fn login_with_password(username: Option<&str>) -> Result<()> {
    let store = Store::new(APP_NAME)?;
    check_existing_session(&store)?;

    let cred = credential::resolve_credential(username)?;

    let simple_client = client::build_simple()?;
    let config = iaaa_config();

    let otp_code = pkuinfo_common::otp::get_current_otp(store.config_dir())?;
    if otp_code.is_some() {
        println!("{} 已自动填入手机令牌", "[otp]".cyan());
    }
    let iaaa_token = iaaa::login_password(
        &simple_client,
        &config,
        &cred.username,
        &cred.password,
        otp_code.as_deref(),
    )
    .await?;

    complete_bb_login(&store, &iaaa_token.token).await
}

/// 扫码登录
pub async fn login_with_qrcode(qr_mode: pkuinfo_common::qr::QrDisplayMode) -> Result<()> {
    let store = Store::new(APP_NAME)?;
    check_existing_session(&store)?;

    let simple_client = client::build_simple()?;
    let config = iaaa_config();

    let iaaa_token =
        iaaa::login_qrcode(&simple_client, &config, store.config_dir(), qr_mode).await?;

    complete_bb_login(&store, &iaaa_token.token).await
}

/// IAAA 认证成功后，完成 Blackboard SSO 登录
pub async fn complete_bb_login(store: &Store, iaaa_token: &str) -> Result<()> {
    complete_bb_login_for_user(store, iaaa_token, None).await
}

/// Start a fresh cookie jar and verify the authenticated user before replacing
/// an existing session. Failed SSO must not appear successful via old cookies.
pub async fn complete_bb_login_for_user(
    store: &Store,
    iaaa_token: &str,
    username: Option<&str>,
) -> Result<()> {
    println!("{} 完成教学网登录...", "[+]".green());

    let cookie_store = std::sync::Arc::new(reqwest_cookie_store::CookieStoreMutex::new(
        cookie_store::CookieStore::default(),
    ));
    let client = client::build(cookie_store.clone())?;

    // 用 IAAA token 访问 SSO 回调 URL，建立 Blackboard 会话
    let rand_val: f64 = rand::random();
    let sso_url = format!("{SSO_LOGIN}?_rand={rand_val:.20}&token={iaaa_token}");

    let resp = client
        .get(&sso_url)
        .send()
        .await
        .context("SSO 回调请求失败")?;

    if !resp.status().is_success() && !resp.status().is_redirection() {
        return Err(anyhow!("SSO 登录失败: HTTP {}", resp.status()));
    }
    // 消费 body，确保 cookies 被存储
    let _ = resp.bytes().await?;

    // A login page can also return HTTP 200. Require the actual account identity.
    let identity_response = client
        .get(format!(
            "{}/learn/api/public/v1/users/me",
            client::COURSE_BASE
        ))
        .send()
        .await
        .context("验证教学网账号失败")?
        .error_for_status()?;
    if identity_response.url().host_str() != Some("course.pku.edu.cn") {
        return Err(anyhow!("教学网登录验证失败"));
    }
    let identity: serde_json::Value = identity_response.json().await?;
    verify_identity(&identity, username)?;

    // 保存会话（cookie-based session，默认 24 小时过期）
    let mut session = Session::new(iaaa_token.to_string());
    session.uid = identity["userName"].as_str().map(str::to_owned);
    session.expires_at = Some(chrono::Utc::now().timestamp() + 24 * 3600);
    store.save_session(&session)?;
    store.save_cookie_store(&cookie_store)?;

    println!();
    println!("{} 教学网登录成功！", "[done]".green().bold());
    println!("  配置目录 = {}", store.config_dir().display());
    Ok(())
}

fn verify_identity(identity: &serde_json::Value, expected: Option<&str>) -> Result<()> {
    let id = identity["id"].as_str().filter(|s| !s.is_empty());
    let user = identity["userName"].as_str().filter(|s| !s.is_empty());
    if id.is_none() || user.is_none() || expected.is_some_and(|expected| user != Some(expected)) {
        return Err(anyhow!("教学网未确认当前登录账号"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_requires_the_expected_authenticated_identity() {
        let user = serde_json::json!({"id":"_1_1", "userName":"20260001"});
        assert!(verify_identity(&user, Some("20260001")).is_ok());
        assert!(verify_identity(&user, None).is_ok());
        assert!(verify_identity(&user, Some("20260002")).is_err());
        assert!(verify_identity(&serde_json::json!({"status":200}), None).is_err());
    }
}

fn check_existing_session(store: &Store) -> Result<()> {
    if let Some(old) = store.load_session()? {
        if !old.is_expired() {
            println!("{} 检测到已有登录会话，继续将覆盖。", "[info]".cyan(),);
        }
    }
    Ok(())
}

/// 查看当前登录状态
pub fn status() -> Result<()> {
    let store = Store::new(APP_NAME)?;
    match store.load_session()? {
        Some(s) => {
            println!("{} 已登录", "●".green());
            println!(
                "  created_at = {}",
                s.created_at.format("%Y-%m-%d %H:%M:%S UTC")
            );
            println!("  config dir = {}", store.config_dir().display());
        }
        None => {
            println!(
                "{} 未登录。运行 `course login` 开始扫码登录，或 `course login -p` 密码登录。",
                "○".red()
            );
        }
    }
    Ok(())
}

/// 退出登录
pub fn logout() -> Result<()> {
    let store = Store::new(APP_NAME)?;
    store.clear()?;
    println!("{} 已清除本地会话", "✓".green());
    Ok(())
}
