use super::*;
use std::fs::{File, Metadata};
use std::time::{Duration, Instant};

pub(super) fn safe(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
        || path
            .to_str()
            .is_none_or(|name| name.contains(['\r', '\n', '\0']))
    {
        return Err("Decision installation requires absolute local paths".into());
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err("Decision installation requires absolute local paths".into());
    }
    let linked = || "Decision installation paths must not contain links or junctions";
    if let Some(parent) = path.parent() {
        codex_decision::check_ancestors(parent).map_err(|_| linked())?;
    }
    match fs::symlink_metadata(path) {
        Ok(info) if codex_decision::is_link(&info) => return Err(linked().into()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("Decision installation file inspection failed".into()),
    }
    Ok(path.components().collect())
}

pub(super) fn info(path: &Path) -> Result<Option<Metadata>, String> {
    safe(path)?;
    match fs::symlink_metadata(path) {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Decision installation file inspection failed".into()),
    }
}

pub(super) fn mkdir(path: &Path) -> Result<(), String> {
    safe(path)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "Decision installation directory creation failed")?;
    safe(path)?;
    Ok(())
}

pub(super) fn secure_directory(path: &Path, tree: bool) -> Result<(), String> {
    mkdir(path)?;
    #[cfg(windows)]
    if tree {
        codex_decision::windows::secure_tree(path)?;
    } else {
        codex_decision::windows::secure_directory(path)?;
    }
    #[cfg(not(windows))]
    let _ = tree;
    Ok(())
}

pub(super) fn off_workspace(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy().to_ascii_lowercase();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    if text == "/mnt/d"
        || text.starts_with("/mnt/d/")
        || text.starts_with("d:\\")
        || text.starts_with("d:/")
    {
        return Err("Decision installation state must remain outside D:".into());
    }
    Ok(())
}

pub(super) fn read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    safe(path)?;
    files::read(path, limit)
        .map_err(|_| "Decision package file is invalid or exceeds its size limit".into())
}

pub(super) fn json_file(path: &Path) -> Result<Value, String> {
    codex_decision::strict_json::parse(&read(path, 128_000)?)
        .map_err(|_| "Invalid Decision package metadata".into())
}

pub(super) fn mode(info: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        info.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if info.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

pub(super) fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(safe(path)?, fs::Permissions::from_mode(mode))
            .map_err(|_| "Decision installation could not restore file permissions".into())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

pub(super) fn write(path: &Path, data: &[u8], mode: u32, replace: bool) -> Result<(), String> {
    safe(path)?;
    let parent = path
        .parent()
        .ok_or("Invalid Decision package destination")?;
    mkdir(parent)?;
    if info(path)?.is_some_and(|info| !info.is_file()) {
        return Err("Invalid Decision package destination".into());
    }
    let temp = parent.join(format!(".decision-install-{}", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|_| "Decision installation staging failed")?;
    let result = (|| -> Result<(), String> {
        file.write_all(data)
            .map_err(|_| "Decision installation write failed")?;
        set_mode(&temp, mode)?;
        file.sync_all()
            .map_err(|_| "Decision installation sync failed")?;
        drop(file);
        safe(path)?;
        if replace {
            fs::rename(&temp, path)
        } else {
            // Publish a complete file exclusively. Preserve an entry a concurrent
            // Codex process may have recreated after the cache was inspected.
            fs::hard_link(&temp, path)
        }
        .map_err(|_| "Decision installation publish failed".into())
    })();
    if info(&temp)?.is_some() {
        fs::remove_file(&temp).map_err(|_| "Decision installation staging cleanup failed")?;
    }
    result
}

pub(super) fn lock(root: &Path) -> Result<File, String> {
    secure_directory(root, false)?;
    let path = safe(&root.join(".companion-install.lock"))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options
        .open(path)
        .map_err(|_| "Decision installation lock is unavailable")?;
    let info = file
        .metadata()
        .map_err(|_| "Decision installation lock is unavailable")?;
    if !info.is_file() || codex_decision::is_link(&info) {
        return Err("Decision installation lock must be a regular file".into());
    }
    let deadline = Instant::now() + Duration::from_secs(660);
    loop {
        // On Linux this is flock. On Windows the locked range overlaps the
        // one-byte range used by existing companion installers.
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Decision installation is busy; retry repair".into())
            }
            Err(_) => return Err("Decision installation lock is unavailable".into()),
        }
    }
}
