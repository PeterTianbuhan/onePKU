//! Manual grade scope is private to the authenticated treehole account.
use super::*;

fn account_key(generation: &str) -> Result<String> {
    anyhow::ensure!(
        generation == fingerprint("treehole"),
        "账号已变化，请刷新后重试"
    );
    let session = Store::new("treehole")?
        .load_session()?
        .ok_or_else(|| anyhow!("未登录"))?;
    let uid = session
        .uid
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("未登录：无法确认成绩账号"))?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("treehole-grade-scope:{uid}"))
    ))
}

fn normalized(included: &[String], excluded: &[String]) -> Result<Value> {
    anyhow::ensure!(included.len() + excluded.len() <= 5000, "成绩范围过大");
    anyhow::ensure!(
        included
            .iter()
            .chain(excluded)
            .all(|s| !s.is_empty() && s.len() <= 1024),
        "成绩范围格式不正确"
    );
    let excluded: std::collections::BTreeSet<_> = excluded.iter().cloned().collect();
    let included: std::collections::BTreeSet<_> = included
        .iter()
        .filter(|s| !excluded.contains(*s))
        .cloned()
        .collect();
    Ok(json!({ "included": included, "excluded": excluded }))
}

pub(crate) fn read(generation: &str) -> Result<Value> {
    let key = account_key(generation)?;
    Ok(maintenance::read_preferences()
        .get("gradeScopes")
        .and_then(|scopes| scopes.get(&key))
        .cloned()
        .unwrap_or_else(|| json!({"included": [], "excluded": []})))
}

pub(crate) fn save(generation: &str, included: &[String], excluded: &[String]) -> Result<Value> {
    let key = account_key(generation)?;
    let value = normalized(included, excluded)?;
    let mut scopes = maintenance::read_preferences()
        .get("gradeScopes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    scopes.insert(key, value.clone());
    anyhow::ensure!(
        generation == fingerprint("treehole"),
        "账号已变化，请刷新后重试"
    );
    maintenance::write_preference("gradeScopes", Value::Object(scopes))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_scope_is_bounded_deduplicated_and_exclusion_wins() {
        let value = normalized(&["a".into(), "a".into(), "b".into()], &["b".into()]).unwrap();
        assert_eq!(value, json!({"included":["a"], "excluded":["b"]}));
        assert!(normalized(&["".into()], &[]).is_err());
        assert!(normalized(&vec!["a".into(); 5001], &[]).is_err());
    }
}
