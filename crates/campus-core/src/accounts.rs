//! Verified account ownership is stable across cookie/session rotation. The
//! session fingerprint is still used to cancel work and reject stale requests.
use super::*;
use crate::platform::PrivateOpenOptions;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn root() -> Result<PathBuf> {
    Ok(directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位账号目录"))?
        .data_local_dir()
        .to_owned())
}
pub(crate) fn account_key(id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("course.pku.edu.cn/blackboard-user/{id}"))
    )
}
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let mut file = platform::open_regular_file(path).ok()?;
    if file.metadata().ok()?.len() > 16384 {
        return None;
    }
    let mut bytes = vec![];
    std::io::Read::read_to_end(&mut file, &mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let dir = path.parent().ok_or_else(|| anyhow!("账号目录无效"))?;
    fs::create_dir_all(dir)?;
    platform::private_directory(dir)?;
    let temp = path.with_extension(format!("{:016x}.tmp", rand::random::<u64>()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .private_mode()
            .open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        drop(file);
        platform::replace_durable(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
pub(crate) fn binding(root: &Path, generation: &str) -> Option<String> {
    ["course-sessions", "subtitle-accounts"]
        .iter()
        .find_map(|folder| {
            read_json::<String>(&root.join(folder).join(format!("{generation}.json")))
                .filter(|v| digest(v))
        })
}
fn save_verified(
    root: &Path,
    generation: &str,
    identity: &pku_course::api::CourseIdentity,
) -> Result<String> {
    let account = account_key(&identity.id);
    if binding(root, generation).is_some_and(|old| old != account) {
        bail!("教学网账号身份发生变化，请重新登录后重试");
    }
    write_json(
        &root.join("course-accounts").join(format!("{account}.json")),
        &json!({
            "version":1,"provider":"course.pku.edu.cn","providerUserId":identity.id,
            "studentNumber":identity.user_name,"account":account,"verifiedAt":chrono::Utc::now().to_rfc3339()
        }),
    )?;
    write_json(
        &root
            .join("course-sessions")
            .join(format!("{generation}.json")),
        &account,
    )?;
    Ok(account)
}
pub(crate) fn bound_generations(root: &Path, account: &str) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    for folder in ["course-sessions", "subtitle-accounts"] {
        let dir = root.join(folder);
        if fs::symlink_metadata(&dir).is_ok_and(|m| platform::is_link(&m)) {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry
                .path()
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_owned();
            if digest(&name) && binding(root, &name).as_deref() == Some(account) {
                out.insert(name);
            }
        }
    }
    out.into_iter().collect()
}
impl Core {
    pub(crate) async fn course_account(&self, generation: &str) -> Result<String> {
        let _guard = self.course_account_lock.lock().await;
        let root = root()?;
        let saved = binding(&root, generation);
        if let Some(account) = &saved {
            let metadata: Option<Value> =
                read_json(&root.join("course-accounts").join(format!("{account}.json")));
            if metadata.is_some_and(|v| {
                v["version"] == 1
                    && v["account"] == *account
                    && v["provider"] == "course.pku.edu.cn"
                    && v["providerUserId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty() && account_key(id) == *account)
            }) {
                if generation != fingerprint("course") {
                    bail!("账号已更新，请重试");
                }
                return Ok(account.clone());
            }
        }
        let identity = self.course_api()?.account_identity().await;
        if generation != fingerprint("course") {
            bail!("账号已更新，请重试");
        }
        match identity {
            Ok(identity) => save_verified(&root, generation, &identity),
            // A previously verified binding still permits offline use. Never
            // associate an unverified session with another account by guessing.
            Err(_) if saved.is_some() => Ok(saved.unwrap()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_rotation_groups_only_verified_same_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let identity = pku_course::api::CourseIdentity {
            id: "_10_1".into(),
            user_name: "20260001".into(),
        };
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        let third = "c".repeat(64);
        let account = save_verified(dir.path(), &first, &identity).unwrap();
        assert_eq!(
            save_verified(dir.path(), &second, &identity).unwrap(),
            account
        );
        let other = pku_course::api::CourseIdentity {
            id: "_11_1".into(),
            user_name: "20260002".into(),
        };
        assert_ne!(save_verified(dir.path(), &third, &other).unwrap(), account);
        assert_eq!(
            bound_generations(dir.path(), &account),
            vec![first.clone(), second]
        );
        assert!(save_verified(dir.path(), &first, &other).is_err());
        assert_eq!(binding(dir.path(), &first), Some(account));
    }
}
