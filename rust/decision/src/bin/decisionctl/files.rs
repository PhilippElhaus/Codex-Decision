//! Bound CLI inputs on the opened regular file, including files that grow.
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

pub(super) fn read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    codex_decision::check_ancestors(path.parent().ok_or("missing file parent")?)?;
    if path.is_symlink() {
        return Err(format!("linked input: {}", path.display()));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || codex_decision::is_link(&metadata) || metadata.len() > limit {
        return Err("invalid input size".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit.checked_add(1).ok_or("invalid input size")?)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("invalid input size".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn regular_input_limits_preserve_exact_bytes_and_reject_sparse_oversize() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("asset");
        fs::write(&path, b"binary\0\xff").unwrap();
        assert_eq!(read(&path, 8).unwrap(), b"binary\0\xff");
        assert_eq!(read(&path, 7).unwrap_err(), "invalid input size");
        fs::File::create(&path)
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();
        assert_eq!(
            read(&path, 32 * 1024 * 1024).unwrap_err(),
            "invalid input size"
        );
        assert!(read(directory.path(), 32).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_and_nonregular_inputs_never_follow_or_wait_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("original");
        fs::write(&source, b"unchanged").unwrap();
        let linked = directory.path().join("linked");
        symlink(&source, &linked).unwrap();
        assert!(read(&linked, 32).is_err());
        let fifo = directory.path().join("fifo");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a NUL-terminated path inside this test's owned directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(read(&fifo, 32).unwrap_err(), "invalid input size");
        assert_eq!(fs::read(source).unwrap(), b"unchanged");
    }
}
