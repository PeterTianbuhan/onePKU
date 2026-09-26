//! Optional, service-scoped passwords. Never use the resource cache or PKU CLI's
//! shared keyring entry; a QR/account change invalidates this generation binding.
use super::*;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct SavedLogin {
    pub username: String,
    pub password: String,
    pub generation: String,
}

fn entry(service: &str) -> Result<keyring::Entry> {
    if !matches!(service, "course" | "treehole" | "campuscard" | "bdkj") {
        bail!("invalid service");
    }
    Ok(keyring::Entry::new("me.petertian.onepku.login", service)?)
}

pub(crate) fn load(service: &str) -> Result<Option<SavedLogin>> {
    load_entry(&entry(service)?)
}
fn load_entry(entry: &keyring::Entry) -> Result<Option<SavedLogin>> {
    match entry.get_password() {
        Ok(raw) => Ok(Some(serde_json::from_str(&Zeroizing::new(raw))?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn save(service: &str, login: &SavedLogin) -> Result<()> {
    save_entry(&entry(service)?, login)
}
fn save_entry(entry: &keyring::Entry, login: &SavedLogin) -> Result<()> {
    let raw = Zeroizing::new(serde_json::to_string(login)?);
    entry.set_password(&raw)?;
    let check = Zeroizing::new(entry.get_password()?);
    if *check != *raw {
        bail!("keyring verification failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "uses a unique disposable OS keychain entry; run explicitly on the target desktop"]
    fn os_keychain_roundtrip() {
        let name = format!("onepku-login-qa-{:032x}", rand::random::<u128>());
        let entry = keyring::Entry::new("me.petertian.onepku.qa", &name).unwrap();
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let cleanup = Cleanup(entry);
        assert!(load_entry(&cleanup.0).unwrap().is_none());
        let saved = SavedLogin {
            username: "synthetic-account".into(),
            password: "synthetic-password".into(),
            generation: "synthetic-generation".into(),
        };
        save_entry(&cleanup.0, &saved).unwrap();
        let reopened = keyring::Entry::new("me.petertian.onepku.qa", &name).unwrap();
        let loaded = load_entry(&reopened).unwrap().unwrap();
        assert_eq!(loaded.username, saved.username);
        assert_eq!(loaded.password, saved.password);
        assert_eq!(loaded.generation, saved.generation);
        reopened.delete_credential().unwrap();
        assert!(load_entry(&reopened).unwrap().is_none());
    }
}

pub(crate) fn clear(service: &str) -> Result<()> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

impl Core {
    pub fn forget_passwords(&self) -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "服务暂不可用")?;
        runtime.block_on(async {
            let _guard = self.login_lock.lock().await;
            let mut failed = false;
            for service in ["course", "treehole", "campuscard", "bdkj"] {
                failed |= clear(service).is_err();
            }
            if failed {
                Err("部分密码未能从系统钥匙串删除，请解锁后重试".into())
            } else {
                Ok(())
            }
        })
    }
}
