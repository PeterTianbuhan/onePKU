//! 桌面端把播放进度同步到 Peter 自己的边车。
//! 令牌只从 `~/.config/onepku/progress-sync.json` 读取，不进前端，也不写进请求地址。

use crate::platform::{self, PrivateOpenOptions};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Record {
    pub course_id: String,
    pub episode_id: String,
    pub position_seconds: f64,
    pub completed: bool,
    pub updated_at: String,
    pub device_id: String,
}

struct Config {
    base: String,
    token: String,
}

#[derive(Deserialize)]
struct FileConfig {
    url: String,
    token: String,
}

#[derive(Deserialize)]
struct RemoteBody {
    records: Vec<Record>,
}

fn config_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".config").join("onepku"))
}

fn config_path() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("progress-sync.json"))
}

fn device_path() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("progress-device-id"))
}

fn normalize_base(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return None;
    }
    let mut base = parsed.as_str().trim_end_matches('/').to_string();
    if base.ends_with('/') {
        base.pop();
    }
    Some(base)
}

fn acceptable_token(token: &str) -> bool {
    let token = token.trim();
    token.len() >= 24 && token.chars().all(|ch| !ch.is_whitespace())
}

fn load_config_from(path: &Path) -> Option<Config> {
    let file = platform::open_regular_file(path).ok()?;
    let mut buf = String::new();
    file.take(64 * 1024).read_to_string(&mut buf).ok()?;
    let parsed: FileConfig = serde_json::from_str(&buf).ok()?;
    let base = normalize_base(&parsed.url)?;
    if !acceptable_token(&parsed.token) {
        return None;
    }
    Some(Config {
        base,
        token: parsed.token.trim().to_string(),
    })
}

fn load_config() -> Option<Config> {
    load_config_from(&config_path()?)
}

fn endpoint(base: &str, path: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(&format!("{base}{path}"))?;
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        bail!("progress url rejected");
    }
    Ok(url)
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        platform::private_directory(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    options.private_mode();
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

fn device_id_from(path: &Path) -> Result<String> {
    if let Ok(file) = platform::open_regular_file(path) {
        let mut text = String::new();
        file.take(128).read_to_string(&mut text).ok();
        let text = text.trim();
        if text.len() == 32 && text.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Ok(text.to_string());
        }
    }
    let id = format!("{:032x}", rand::random::<u128>());
    write_private(path, id.as_bytes())?;
    Ok(id)
}

fn device_id() -> Result<String> {
    device_id_from(&device_path().ok_or_else(|| anyhow!("无法定位配置目录"))?)
}

fn disabled() -> Value {
    json!({"enabled": false, "ok": true, "records": []})
}

fn failed() -> Value {
    json!({"enabled": true, "ok": false, "records": []})
}

fn ready(records: Vec<Record>) -> Value {
    json!({
        "enabled": true,
        "ok": true,
        "records": records.iter().map(|record| json!({
            "courseId": record.course_id,
            "episodeId": record.episode_id,
            "positionSeconds": record.position_seconds,
            "completed": record.completed,
            "updatedAt": record.updated_at,
        })).collect::<Vec<_>>()
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.chars().all(|ch| !ch.is_control() && ch != ' ')
}

fn normalize_record(record: &Record, device: &str) -> Option<Record> {
    if !valid_id(&record.course_id) || !valid_id(&record.episode_id) {
        return None;
    }
    if !record.position_seconds.is_finite()
        || record.position_seconds < 0.0
        || record.position_seconds > 14.0 * 24.0 * 3600.0
    {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(&record.updated_at).ok()?;
    Some(Record {
        course_id: record.course_id.clone(),
        episode_id: record.episode_id.clone(),
        position_seconds: record.position_seconds,
        completed: record.completed,
        updated_at: record.updated_at.clone(),
        device_id: device.to_string(),
    })
}

async fn exchange(
    config: &Config,
    method: reqwest::Method,
    body: Option<Vec<Record>>,
) -> Result<Vec<Record>> {
    let url = endpoint(&config.base, "/v1/progress")?;
    let request = client()?
        .request(method, url)
        .header("Authorization", format!("Bearer {}", config.token));
    let response = match body {
        Some(records) => request.json(&json!({"records": records})).send().await?,
        None => request.send().await?,
    };
    if !response.status().is_success() {
        bail!("progress sync {}", response.status());
    }
    let parsed: RemoteBody = response.json().await?;
    Ok(parsed.records)
}

pub(crate) fn status() -> Value {
    match load_config() {
        Some(config) => json!({"enabled": true, "url": config.base}),
        None => json!({"enabled": false, "url": ""}),
    }
}

pub(crate) async fn pull() -> Value {
    let Some(config) = load_config() else {
        return disabled();
    };
    match exchange(&config, reqwest::Method::GET, None).await {
        Ok(records) => ready(records),
        Err(_) => failed(),
    }
}

pub(crate) async fn push(record: Record) -> Value {
    let Some(config) = load_config() else {
        return disabled();
    };
    let Ok(device) = device_id() else {
        return failed();
    };
    let Some(record) = normalize_record(&record, &device) else {
        return failed();
    };
    match exchange(&config, reqwest::Method::PUT, Some(vec![record])).await {
        Ok(records) => ready(records),
        Err(_) => failed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn short_token_and_query_url_stay_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("progress-sync.json");
        fs::write(
            &path,
            r#"{"url":"https://example.test/onepku-progress","token":"too-short"}"#,
        )
        .unwrap();
        assert!(load_config_from(&path).is_none());
        fs::write(
            &path,
            format!(
                r#"{{"url":"https://example.test/onepku-progress?token={}","token":"{}"}}"#,
                "b".repeat(32),
                "c".repeat(32)
            ),
        )
        .unwrap();
        assert!(load_config_from(&path).is_none());
        fs::write(
            &path,
            format!(
                r#"{{"url":"https://user:{}@example.test/onepku-progress","token":"{}"}}"#,
                "d".repeat(32),
                "e".repeat(32)
            ),
        )
        .unwrap();
        assert!(load_config_from(&path).is_none());
    }

    #[test]
    fn config_accepts_a_long_token_and_status_omits_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("progress-sync.json");
        let token = "f".repeat(32);
        fs::write(
            &path,
            format!(
                r#"{{"url":"https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress/","token":"{token}"}}"#
            ),
        )
        .unwrap();
        let config = load_config_from(&path).unwrap();
        assert_eq!(
            config.base,
            "https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress"
        );
        let url = endpoint(&config.base, "/v1/progress").unwrap();
        assert!(url.query().is_none());
        assert!(!url.as_str().contains(&token));
        let header = format!("Bearer {}", config.token);
        assert!(header.starts_with("Bearer "));
        assert!(!url.as_str().contains("Bearer"));
    }

    #[test]
    fn device_id_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("progress-device-id");
        let first = device_id_from(&path).unwrap();
        let second = device_id_from(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
    }

    #[tokio::test]
    async fn push_puts_the_token_in_the_header_only() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "a".repeat(32);
        let seen = Arc::new(Mutex::new(String::new()));
        let captured = seen.clone();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 2048];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match std::io::Read::read(&mut sock, &mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                }
            }
            *captured.lock().unwrap() = String::from_utf8_lossy(&buf).into_owned();
            let body = br#"{"records":[]}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = std::io::Write::write_all(&mut sock, resp.as_bytes());
            let _ = std::io::Write::write_all(&mut sock, body);
        });
        let config = Config {
            base: format!("http://127.0.0.1:{port}"),
            token: token.clone(),
        };
        let record = Record {
            course_id: "course".into(),
            episode_id: "episode".into(),
            position_seconds: 3.0,
            completed: false,
            updated_at: "2026-11-10T00:00:00Z".into(),
            device_id: "ignored".into(),
        };
        let value = match exchange(&config, reqwest::Method::PUT, Some(vec![record])).await {
            Ok(records) => ready(records),
            Err(_) => failed(),
        };
        assert_eq!(value["ok"], json!(true));
        let got = seen.lock().unwrap().clone();
        let head = got.split("\r\n\r\n").next().unwrap_or("");
        let request_line = head.lines().next().unwrap_or("");
        assert!(request_line.starts_with("PUT /v1/progress HTTP/"), "{head}");
        assert!(!request_line.contains('?'), "{head}");
        assert!(!request_line.contains(&token), "{head}");
        assert!(
            head.to_ascii_lowercase()
                .contains(&format!("authorization: bearer {token}")),
            "{head}"
        );
    }
}
