//! 校内门户登录：用 iaaa 票据换门户 SESSION cookie，再读账号的「单位」用来识别学院。
//!
//! 门户自身没有对外文档化的 API，这里沿用安卓端的做法：单点登录种 cookie，
//! 然后用 `account/getBasicInfo.do` 读姓名与院系；返回不是 JSON 就当作会话已失效。
use anyhow::{anyhow, Context, Result};
use pkuinfo_common::iaaa::IaaaConfig;
use pkuinfo_common::session::{Session, Store};
use serde_json::{json, Value};
use std::time::Duration;

const PORTAL_APP_ID: &str = "portal2017";
const PORTAL_BASE: &str = "https://portal.pku.edu.cn/portal2017/";
const PORTAL_SSO: &str = "https://portal.pku.edu.cn/portal2017/ssoLogin.do";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

pub fn iaaa_config() -> IaaaConfig {
    IaaaConfig {
        app_id: PORTAL_APP_ID.to_string(),
        redirect_url: PORTAL_SSO.to_string(),
    }
}

fn text_of(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}
pub fn department_of(info: &Value) -> String {
    text_of(info, "department")
}
pub fn name_of(info: &Value) -> String {
    text_of(info, "name")
}

fn client(store: &Store) -> Result<(reqwest::Client, std::sync::Arc<reqwest_cookie_store::CookieStoreMutex>)> {
    let jar = store.load_cookie_store()?;
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .cookie_provider(jar.clone())
        .timeout(Duration::from_secs(20))
        .build()?;
    Ok((client, jar))
}

/// 门户基本资料：姓名与「单位」。返回不是 JSON 一律按会话失效处理。
async fn basic_info_with(client: &reqwest::Client) -> Result<Value> {
    let response = client
        .post(format!("{PORTAL_BASE}account/getBasicInfo.do"))
        .header("content-type", "application/json; charset=UTF-8")
        .header("x-requested-with", "XMLHttpRequest")
        .header("referer", PORTAL_BASE)
        .body("{}")
        .send()
        .await
        .context("门户基本资料请求失败")?;
    let text = response.text().await.context("门户基本资料读取失败")?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| anyhow!("校内门户会话已失效，请重新连接"))?;
    if value.get("success").and_then(Value::as_str).is_some_and(|flag| flag != "true") {
        return Err(anyhow!("校内门户会话已失效，请重新连接"));
    }
    Ok(value)
}

/// 用 iaaa 票据登录门户：单点登录种下门户 SESSION cookie，随后回读基本资料确认这次真的连上了。
pub async fn complete_portal_login(store: &Store, token: &str) -> Result<()> {
    let (client, jar) = client(store)?;
    let rand: f64 = rand::random();
    let url = format!("{PORTAL_SSO}?_rand={rand:.20}&token={token}");
    let response = client.get(&url).send().await.context("门户单点登录请求失败")?;
    let status = response.status();
    let _ = response.text().await;
    store.save_cookie_store(&jar)?;
    if !status.is_success() {
        return Err(anyhow!("门户单点登录失败: HTTP {status}"));
    }
    let info = basic_info_with(&client).await?;
    if name_of(&info).is_empty() && department_of(&info).is_empty() {
        return Err(anyhow!("门户没有返回账号信息，请重新连接"));
    }
    // 会话文件只用来标记「已连接」并给指纹用；真正的凭据是门户 cookie。
    let mut session = Session::new(token.to_string());
    session.extra = json!({ "department": department_of(&info) });
    store.save_session(&session)?;
    Ok(())
}

/// 基本资料（需要已连接的门户会话）。
pub async fn basic_info(store: &Store) -> Result<Value> {
    let (client, _) = client(store)?;
    basic_info_with(&client).await
}

/// 连接状态与识别到的院系；读不到就报未连接，不猜。
pub async fn status(store: &Store) -> Value {
    match basic_info(store).await {
        Ok(info) => json!({
            "connected": true,
            "name": name_of(&info),
            "department": department_of(&info),
        }),
        Err(_) => json!({ "connected": false, "name": "", "department": "" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_sso_target_is_the_portal_itself() {
        let config = iaaa_config();
        assert_eq!(config.app_id, "portal2017");
        assert_eq!(config.redirect_url, PORTAL_SSO);
    }
    #[test]
    fn basic_info_fields_are_trimmed_and_tolerant() {
        let info = json!({"success": "true", "name": " 张三 ", "department": "数学科学学院"});
        assert_eq!(name_of(&info), "张三");
        assert_eq!(department_of(&info), "数学科学学院");
        // 学校有时把数字字段返回成数字类型，不能因此当成没有院系。
        assert_eq!(department_of(&json!({"department": 12})), "12");
        assert_eq!(department_of(&json!({"success": "true"})), "");
        assert_eq!(department_of(&json!({"department": null})), "");
    }
}
