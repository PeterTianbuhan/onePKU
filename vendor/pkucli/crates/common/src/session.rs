use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use cookie_store::CookieStore;
use directories::ProjectDirs;
use reqwest_cookie_store::CookieStoreMutex;
use serde::{Deserialize, Serialize};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs,
    io::{BufReader, BufWriter},
    path::{Path, PathBuf},
    sync::Arc,
};

/// 通用会话信息 — 各子项目可选择性使用字段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// JWT token 或其他鉴权 token
    pub token: String,
    /// token 过期时间戳
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// 用户标识
    #[serde(default)]
    pub uid: Option<String>,
    /// 登录时间
    pub created_at: DateTime<Utc>,
    /// 额外字段
    #[serde(default)]
    pub extra: serde_json::Value,
}

impl Session {
    pub fn new(token: String) -> Self {
        Self {
            token,
            expires_at: None,
            uid: None,
            created_at: Utc::now(),
            extra: serde_json::Value::Null,
        }
    }

    pub fn is_expired(&self) -> bool {
        if let Some(exp) = self.expires_at {
            Utc::now().timestamp() >= exp
        } else {
            false
        }
    }
}

/// 本地配置/会话存储
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// 创建存储实例。
    ///
    /// 未设置环境变量时，目录仍是系统配置目录下的 `info/<sub_name>/`
    /// （Linux `~/.config/info/<sub_name>/`，Windows `%APPDATA%\info\<sub_name>\`）。
    /// `PKUINFO_SESSION_DIR_<SERVICE>` 为绝对路径时，只改该服务的目录，
    /// 例如 `PKUINFO_SESSION_DIR_COURSE`。否则 `PKUINFO_SESSION_ROOT` 为绝对路径时，
    /// 使用 `$PKUINFO_SESSION_ROOT/<sub_name>/`。
    pub fn new(sub_name: &str) -> Result<Self> {
        let root = resolve_config_root(
            sub_name,
            std::env::var_os(session_dir_env(sub_name)),
            std::env::var_os("PKUINFO_SESSION_ROOT"),
        )?;
        fs::create_dir_all(&root)
            .with_context(|| format!("创建配置目录失败: {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn config_dir(&self) -> &Path {
        &self.root
    }

    pub fn session_path(&self) -> PathBuf {
        self.root.join("session.json")
    }

    pub fn cookies_path(&self) -> PathBuf {
        self.root.join("cookies.json")
    }

    pub fn load_session(&self) -> Result<Option<Session>> {
        let path = self.session_path();
        if !path.exists() {
            return Ok(None);
        }
        let bytes =
            fs::read(&path).with_context(|| format!("读取 session 失败: {}", path.display()))?;
        let sess: Session = serde_json::from_slice(&bytes)
            .with_context(|| format!("解析 session 失败: {}", path.display()))?;
        Ok(Some(sess))
    }

    pub fn save_session(&self, session: &Session) -> Result<()> {
        let path = self.session_path();
        let data = serde_json::to_vec_pretty(session)?;
        let temp = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut f = options.open(&temp)?;
        f.write_all(&data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(temp, &path)?;
        Ok(())
    }

    pub fn load_cookie_store(&self) -> Result<Arc<CookieStoreMutex>> {
        let path = self.cookies_path();
        let store = if path.exists() {
            let file = fs::File::open(&path)
                .with_context(|| format!("打开 cookie 文件失败: {}", path.display()))?;
            cookie_store::serde::json::load(BufReader::new(file))
                .map_err(|e| anyhow::anyhow!("解析 cookie 文件失败: {e}"))?
        } else {
            CookieStore::default()
        };
        Ok(Arc::new(CookieStoreMutex::new(store)))
    }

    pub fn save_cookie_store(&self, store: &Arc<CookieStoreMutex>) -> Result<()> {
        let path = self.cookies_path();
        let temp = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
        let result = (|| -> Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let file = options.open(&temp)?;
            let guard = store
                .lock()
                .map_err(|_| anyhow::anyhow!("锁定 cookie store 失败"))?;
            let mut writer = BufWriter::new(file);
            cookie_store::serde::json::save_incl_expired_and_nonpersistent(&guard, &mut writer)
                .map_err(|_| anyhow::anyhow!("序列化 cookie 文件失败"))?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
            drop(writer);
            fs::rename(&temp, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        for p in [self.session_path(), self.cookies_path()] {
            if p.exists() {
                fs::remove_file(&p).with_context(|| format!("删除 {} 失败", p.display()))?;
            }
        }
        Ok(())
    }
}

fn session_dir_env(sub_name: &str) -> String {
    format!(
        "PKUINFO_SESSION_DIR_{}",
        sub_name.replace('-', "_").to_ascii_uppercase()
    )
}

fn valid_service_name(sub_name: &str) -> bool {
    !sub_name.is_empty()
        && sub_name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn resolve_config_root(
    sub_name: &str,
    service_override: Option<std::ffi::OsString>,
    shared_root: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    if let Some(value) = service_override {
        let root = PathBuf::from(value);
        anyhow::ensure!(
            root.is_absolute(),
            "{} 必须是绝对路径",
            session_dir_env(sub_name)
        );
        return Ok(root);
    }
    if let Some(value) = shared_root {
        let base = PathBuf::from(value);
        anyhow::ensure!(base.is_absolute(), "PKUINFO_SESSION_ROOT 必须是绝对路径");
        anyhow::ensure!(valid_service_name(sub_name), "会话服务名无效");
        return Ok(base.join(sub_name));
    }
    let dirs = ProjectDirs::from("", "", "info").context("无法定位用户配置目录")?;
    Ok(dirs.config_dir().join(sub_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_directory_overrides_one_service_and_keeps_the_default() {
        let directory = tempfile::tempdir().unwrap();
        let shared = directory.path().join("school");
        let course = directory.path().join("course-only");
        assert_eq!(
            resolve_config_root(
                "course",
                Some(course.as_os_str().to_owned()),
                Some(shared.as_os_str().to_owned())
            )
            .unwrap(),
            course
        );
        assert_eq!(
            resolve_config_root("treehole", None, Some(shared.as_os_str().to_owned())).unwrap(),
            shared.join("treehole")
        );
        let dirs = ProjectDirs::from("", "", "info").unwrap();
        assert_eq!(
            resolve_config_root("course", None, None).unwrap(),
            dirs.config_dir().join("course")
        );
        assert!(
            resolve_config_root("course", Some(std::ffi::OsString::from("relative")), None)
                .is_err()
        );
        assert!(
            resolve_config_root("course", None, Some(std::ffi::OsString::from("relative")))
                .is_err()
        );
        assert!(
            resolve_config_root("../course", None, Some(shared.as_os_str().to_owned())).is_err()
        );
    }

    #[test]
    fn session_updates_replace_the_file_and_leave_no_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            root: dir.path().to_path_buf(),
        };
        store
            .save_session(&Session::new("synthetic-first-token".into()))
            .unwrap();
        store
            .save_session(&Session::new("synthetic-second-token".into()))
            .unwrap();
        assert_eq!(
            store.load_session().unwrap().unwrap().token,
            "synthetic-second-token"
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.session_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn cookie_updates_can_replace_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            root: dir.path().to_path_buf(),
        };
        let cookies = Arc::new(CookieStoreMutex::new(CookieStore::default()));
        store.save_cookie_store(&cookies).unwrap();
        store.save_cookie_store(&cookies).unwrap();
        assert!(store.load_cookie_store().is_ok());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
