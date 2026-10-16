//! Serialize private key updates so simultaneous windows preserve both providers.
use super::*;
use std::time::{Duration, Instant};

const MAX_CREDENTIAL_BYTES: usize = 16_384;

struct WriteLock {
    path: PathBuf,
    metadata: fs::Metadata,
}

impl Drop for WriteLock {
    fn drop(&mut self) {
        let Ok(current) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if !current.is_dir() || current.file_type().is_symlink() {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if current.dev() != self.metadata.dev() || current.ino() != self.metadata.ino() {
                return;
            }
        }
        #[cfg(not(unix))]
        if current.created().ok() != self.metadata.created().ok() {
            return;
        }
        let _ = fs::remove_dir(&self.path);
    }
}

fn lock(data_dir: &Path) -> Result<WriteLock, String> {
    codex_decision::check_ancestors(data_dir)?;
    let path = data_dir.join(".decision-write.lock");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // Match the extension's directory protocol. A crashed owner's lock is never stolen.
    loop {
        match builder.create(&path) {
            Ok(()) => {
                let metadata =
                    fs::symlink_metadata(&path).map_err(|_| "credential lock stat failed")?;
                return Ok(WriteLock { path, metadata });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                match fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    _ => return Err("unsafe credential write lock".into()),
                }
            }
            Err(_) => return Err("credential lock failed".into()),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("credential store busy; retry later".into());
        }
        std::thread::sleep(remaining.min(Duration::from_millis(20)));
    }
}

pub(super) fn save(
    data_dir: &Path,
    provider: codex_decision::provider::Provider,
    key: &str,
) -> Result<(), String> {
    let _lock = lock(data_dir)?;
    let path = data_dir.join(".env");
    let name = provider.key_name();
    let old = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("credential stat failed".into()),
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_CREDENTIAL_BYTES as u64
            {
                return Err("unsafe credential".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err("unsafe credential permissions".into());
                }
            }
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let file = options.open(&path).map_err(|_| "credential read failed")?;
            if !file
                .metadata()
                .map_err(|_| "credential stat failed")?
                .is_file()
            {
                return Err("unsafe credential".into());
            }
            let mut bytes = Vec::new();
            file.take(MAX_CREDENTIAL_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "credential read failed")?;
            if bytes.len() > MAX_CREDENTIAL_BYTES {
                return Err("credential too large".into());
            }
            String::from_utf8(bytes).map_err(|_| "invalid credential encoding")?
        }
    };
    let mut lines: Vec<_> = old
        .lines()
        .filter(|line| !line.trim().starts_with(&format!("{name}=")))
        .map(str::to_owned)
        .collect();
    lines.push(format!("{name}={key}"));
    let content = lines.join("\n") + "\n";
    if content.len() > MAX_CREDENTIAL_BYTES {
        return Err("credential too large".into());
    }
    write_private(&path, content.as_bytes())
}
