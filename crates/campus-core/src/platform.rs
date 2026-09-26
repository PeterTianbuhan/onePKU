//! macOS file and process operations used by the campus core.
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata, OpenOptions},
    io,
    path::Path,
    process::{Command, Stdio},
};

pub(crate) trait PrivateOpenOptions {
    fn private_mode(&mut self) -> &mut Self;
}

impl PrivateOpenOptions for OpenOptions {
    fn private_mode(&mut self) -> &mut Self {
        use std::os::unix::fs::OpenOptionsExt;
        self.mode(0o600)
    }
}

pub(crate) fn private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

pub(crate) fn is_link(metadata: &Metadata) -> bool {
    metadata.is_symlink()
}

pub(crate) fn open_regular_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(io::Error::other("not a regular file"));
    }
    Ok(file)
}

pub(crate) fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

pub(crate) fn replace_durable(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    File::open(
        destination
            .parent()
            .ok_or_else(|| io::Error::other("missing parent directory"))?,
    )?
    .sync_all()
}

pub(crate) fn open(target: &OsStr) -> anyhow::Result<()> {
    anyhow::ensure!(
        Command::new("/usr/bin/open")
            .arg(target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success(),
        "无法用默认应用打开"
    );
    Ok(())
}
