use std::sync::LazyLock;

/// Error chains may contain OAuth tokens in request URLs. Keep the cause, never the URL.
pub fn safe_error_message(error: &anyhow::Error) -> String {
    static URL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)https?://[^\s<>\"')\]]+"#).expect("static URL pattern")
    });
    URL.replace_all(&format!("{error:#}"), "[URL已隐藏]")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_in_nested_urls_are_removed_but_tls_cause_is_kept() {
        let error = anyhow::anyhow!(
            "error sending request for url (https://user:pass@course.pku.edu.cn/campusLogin?token=example_secret#fragment_secret): unexpected EOF during handshake"
        )
        .context("SSO 回调请求失败");
        let result = safe_error_message(&error);
        assert!(result.contains("SSO 回调请求失败"));
        assert!(result.contains("unexpected EOF during handshake"));
        for secret in ["user:pass", "example_secret", "fragment_secret", "https://"] {
            assert!(!result.contains(secret), "{result}");
        }
    }

    #[test]
    fn multiple_and_uppercase_urls_are_removed() {
        let error = anyhow::anyhow!(
            "HTTPS://example.test/?token=first_secret\nhttp://example.test/?code=second_secret"
        );
        assert_eq!(safe_error_message(&error), "[URL已隐藏]\n[URL已隐藏]");
    }

    #[test]
    fn ordinary_errors_remain_readable() {
        let error = anyhow::anyhow!("connection refused").context("访问教学网失败");
        assert_eq!(
            safe_error_message(&error),
            "访问教学网失败: connection refused"
        );
    }
}
