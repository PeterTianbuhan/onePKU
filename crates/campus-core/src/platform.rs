//! Small OS boundary. Callers still validate URLs, account scope and archive paths.
//! On Windows, files inherit the ACL of the current user's profile/Downloads;
//! POSIX mode bits are not an ACL and must not be simulated as one.
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata, OpenOptions},
    io,
    path::Path,
    process::Command,
};

pub(crate) trait PrivateOpenOptions {
    fn private_mode(&mut self) -> &mut Self;
}
impl PrivateOpenOptions for OpenOptions {
    fn private_mode(&mut self) -> &mut Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            self.mode(0o600);
        }
        self
    }
}

pub(crate) fn private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    if !path.is_dir() {
        return Err(io::Error::other("private directory does not exist"));
    }
    Ok(())
}

pub(crate) fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes directory junctions, not just symbolic links.
        meta.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        meta.is_symlink()
    }
}

pub(crate) fn open_regular_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || is_link(&meta) {
        return Err(io::Error::other("not a regular file"));
    }
    Ok(file)
}

pub(crate) fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata()?;
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: file owns a live handle; the OS initializes info only on success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        Ok((
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }
}

/// Replace a journal only after its temporary file has been flushed and closed.
/// Never remove the destination first: failures must retain the last durable state.
pub(crate) fn replace_durable(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let wide = |path: &Path| -> io::Result<Vec<u16>> {
            let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
            if value.contains(&0) {
                return Err(io::Error::other("invalid file path"));
            }
            value.push(0);
            Ok(value)
        };
        let source = wide(source)?;
        let destination = wide(destination)?;
        // SAFETY: both paths are valid NUL-terminated strings alive for this call.
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(unix)]
    {
        fs::rename(source, destination)?;
        File::open(
            destination
                .parent()
                .ok_or_else(|| io::Error::other("missing parent directory"))?,
        )?
        .sync_all()?;
    }
    Ok(())
}

pub(crate) fn executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(crate) fn quiet_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

pub(crate) fn open(target: &OsStr) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let mut target: Vec<u16> = target.encode_wide().collect();
        anyhow::ensure!(!target.contains(&0), "invalid open target");
        target.push(0);
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        // SAFETY: all strings are NUL-terminated and remain live for the call.
        // The target is passed as a single value, never interpolated into cmd.exe.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        anyhow::ensure!(
            result as isize > 32,
            "无法用默认应用打开（系统错误 {}）",
            result as isize
        );
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "xdg-open"
        };
        anyhow::ensure!(
            Command::new(program).arg(target).status()?.success(),
            "无法用默认应用打开"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_tracks_files_not_names_and_survives_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("课程 100% & notes.txt");
        fs::write(&path, "one").unwrap();
        let original = open_regular_file(&path).unwrap();
        let alias = dir.path().join("alias.txt");
        fs::hard_link(&path, &alias).unwrap();
        assert_eq!(
            file_identity(&original).unwrap(),
            file_identity(&open_regular_file(&alias).unwrap()).unwrap()
        );
        fs::remove_file(&path).unwrap();
        fs::write(&path, "one").unwrap();
        assert_ne!(
            file_identity(&original).unwrap(),
            file_identity(&open_regular_file(&path).unwrap()).unwrap()
        );
        assert!(open_regular_file(dir.path()).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn directory_junctions_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("junction");
        fs::create_dir(&target).unwrap();
        let status = Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(is_link(&fs::symlink_metadata(&link).unwrap()));
        assert!(open_regular_file(&link).is_err());
        assert!(crate::downloads::validate_download_root(&link).is_err());
        // Remove the junction itself, never recurse into its destination.
        fs::remove_dir(&link).unwrap();
        assert!(target.is_dir());
    }
}
