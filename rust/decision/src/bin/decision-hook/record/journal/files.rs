//! Open bounded private regular files without following replacement paths.
use super::*;
use std::io::{Seek, SeekFrom};

thread_local! { static DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) }; }
pub(super) struct Budget(Option<Instant>);
impl Budget {
    pub(super) fn new() -> Self {
        Self(DEADLINE.with(|cell| cell.replace(Some(Instant::now() + Duration::from_secs(2)))))
    }
}
impl Drop for Budget {
    fn drop(&mut self) {
        DEADLINE.with(|cell| cell.set(self.0));
    }
}
fn within_budget() -> Result<(), String> {
    if DEADLINE.with(|cell| cell.get().is_some_and(|end| Instant::now() >= end)) {
        return Err("publication recovery deadline".into());
    }
    Ok(())
}

pub(super) struct Lease {
    path: PathBuf,
    file: File,
    links: u64,
    fingerprint: std::cell::Cell<Option<(u64, std::time::SystemTime)>>,
}

impl Lease {
    pub(super) fn open(path: &Path, writable: bool, links: u64) -> Result<Option<Self>, String> {
        within_budget()?;
        check_ancestors(path.parent().ok_or("invalid publication file")?)?;
        let initial = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("publication file stat".into()),
        };
        private(&initial, links)?;
        let mut options = OpenOptions::new();
        options.read(true).write(writable);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(path).map_err(|_| "publication file open")?;
        let opened = file.metadata().map_err(|_| "publication file stat")?;
        private(&opened, links)?;
        if !same(&initial, &opened) {
            return Err("publication file changed".into());
        }
        Ok(Some(Self {
            path: path.to_owned(),
            file,
            links,
            fingerprint: std::cell::Cell::new(None),
        }))
    }

    pub(super) fn verify(&self) -> Result<(), String> {
        within_budget()?;
        let current = fs::symlink_metadata(&self.path).map_err(|_| "publication file changed")?;
        let opened = self.file.metadata().map_err(|_| "publication file stat")?;
        private(&current, self.links)?;
        private(&opened, self.links)?;
        if !same(&current, &opened) {
            return Err("publication file changed".into());
        }
        if self
            .fingerprint
            .get()
            .is_some_and(|before| signature(&opened).ok() != Some(before))
        {
            return Err("publication file changed".into());
        }
        Ok(())
    }

    pub(super) fn bytes(&mut self, limit: usize) -> Result<Vec<u8>, String> {
        self.verify()?;
        self.fingerprint.set(Some(signature(
            &self.file.metadata().map_err(|_| "publication file stat")?,
        )?));
        if self
            .file
            .metadata()
            .map_err(|_| "publication file stat")?
            .len()
            > limit as u64
        {
            return Err("publication file too large".into());
        }
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| "publication file seek")?;
        let mut bytes = Vec::with_capacity(
            self.file
                .metadata()
                .map_err(|_| "publication file stat")?
                .len() as usize,
        );
        Read::by_ref(&mut self.file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "publication file read")?;
        self.verify()?;
        if bytes.len() > limit {
            return Err("publication file too large".into());
        }
        Ok(bytes)
    }

    pub(super) fn matches(&mut self, image: &Image) -> Result<bool, String> {
        self.verify()?;
        self.fingerprint.set(Some(signature(
            &self.file.metadata().map_err(|_| "publication file stat")?,
        )?));
        if self
            .file
            .metadata()
            .map_err(|_| "publication file stat")?
            .len()
            != image.bytes as u64
        {
            return Ok(false);
        }
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| "publication file seek")?;
        let mut digest = Sha256::new();
        let mut reader = Read::by_ref(&mut self.file).take(image.bytes as u64 + 1);
        let mut buffer = [0; 8192];
        let mut total = 0;
        loop {
            within_budget()?;
            let count = reader
                .read(&mut buffer)
                .map_err(|_| "publication file read")?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            total += count;
        }
        self.verify()?;
        Ok(total == image.bytes && format!("{:x}", digest.finalize()) == image.sha256)
    }

    pub(super) fn same_inode(&self, other: &Self) -> Result<bool, String> {
        Ok(same(
            &self.file.metadata().map_err(|_| "publication file stat")?,
            &other.file.metadata().map_err(|_| "publication file stat")?,
        ))
    }

    pub(super) fn links(&self) -> Result<u64, String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(self
                .file
                .metadata()
                .map_err(|_| "publication file stat")?
                .nlink())
        }
        #[cfg(not(unix))]
        {
            Ok(1)
        }
    }

    pub(super) fn remove(&self) -> Result<(), String> {
        self.verify()?;
        fs::remove_file(&self.path).map_err(|_| "publication file remove".into())
    }

    pub(super) fn event_tail(&mut self, offset: u64, event: &[u8]) -> Result<bool, String> {
        self.verify()?;
        let size = self
            .file
            .metadata()
            .map_err(|_| "publication event stat")?
            .len();
        let tail = size
            .checked_sub(offset)
            .ok_or("publication event changed")?;
        if tail > event.len() as u64 {
            return Err("publication event changed".into());
        }
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| "publication event seek")?;
        let mut bytes = Vec::with_capacity(event.len());
        Read::by_ref(&mut self.file)
            .take(event.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "publication event read")?;
        self.verify()?;
        if !event.starts_with(&bytes) || bytes.len() as u64 != tail {
            return Err("publication event changed".into());
        }
        Ok(bytes.len() == event.len())
    }

    pub(super) fn truncate(&self, size: u64) -> Result<(), String> {
        self.verify()?;
        self.file
            .set_len(size)
            .map_err(|_| "publication event truncate")?;
        self.fingerprint.set(Some(signature(
            &self.file.metadata().map_err(|_| "publication file stat")?,
        )?));
        self.file
            .sync_all()
            .map_err(|_| "publication event sync".into())
    }

    pub(super) fn sync(&self) -> Result<(), String> {
        self.verify()?;
        self.file
            .sync_all()
            .map_err(|_| "publication event sync".into())
    }

    pub(super) fn size(&self) -> Result<u64, String> {
        self.verify()?;
        Ok(self
            .file
            .metadata()
            .map_err(|_| "publication file stat")?
            .len())
    }
}

fn signature(metadata: &fs::Metadata) -> Result<(u64, std::time::SystemTime), String> {
    Ok((
        metadata.len(),
        metadata.modified().map_err(|_| "publication file stat")?,
    ))
}

fn private(metadata: &fs::Metadata, links: u64) -> Result<(), String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("unsafe publication file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid reads the effective user ID without arguments.
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.nlink() == 0
            || metadata.nlink() > links
        {
            return Err("unsafe publication file".into());
        }
    }
    Ok(())
}

fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}
