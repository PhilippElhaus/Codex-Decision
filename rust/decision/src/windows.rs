//! Native Windows private files and bounded kernel locks.
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::path::Path;
use std::ptr::null_mut;
use std::time::{Duration, Instant};

type Handle = *mut c_void;

#[repr(C)]
#[derive(Default)]
struct FileInfo {
    attributes: u32,
    times: [u32; 6],
    volume: u32,
    size: [u32; 2],
    links: u32,
    index_high: u32,
    index_low: u32,
}

#[repr(C)]
struct Acl {
    revision: u8,
    reserved: u8,
    size: u16,
    count: u16,
    reserved2: u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn LocalFree(memory: Handle) -> Handle;
    fn GetFileInformationByHandle(handle: Handle, info: *mut FileInfo) -> i32;
}
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        info: Handle,
        size: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, string: *mut *mut u16) -> i32;
    fn GetSecurityInfo(
        handle: Handle,
        kind: u32,
        info: u32,
        owner: *mut Handle,
        group: *mut Handle,
        dacl: *mut *mut Acl,
        sacl: *mut Handle,
        descriptor: *mut Handle,
    ) -> u32;
    fn GetAce(acl: *mut Acl, index: u32, ace: *mut Handle) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut Handle,
        size: *mut u32,
    ) -> i32;
    fn SetKernelObjectSecurity(handle: Handle, info: u32, descriptor: Handle) -> i32;
}

struct Memory(Handle);
impl Drop for Memory {
    fn drop(&mut self) {
        // SAFETY: these allocations come from APIs documented to use LocalFree.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn sid_string(sid: Handle) -> Result<String, String> {
    let mut text = null_mut();
    // SAFETY: the security/token descriptor keeps sid alive during conversion.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err("Windows security identity unavailable".into());
    }
    let _memory = Memory(text.cast());
    let mut length = 0;
    // SAFETY: successful conversion returns a NUL-terminated UTF-16 allocation.
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
        String::from_utf16(std::slice::from_raw_parts(text, length))
            .map_err(|_| "Windows security identity unavailable".into())
    }
}

fn token_sid(class: u32) -> Result<String, String> {
    let mut token = null_mut();
    // SAFETY: token is an output handle, TOKEN_QUERY grants read-only access.
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
        return Err("Windows user identity unavailable".into());
    }
    let result = (|| {
        let mut needed = 0;
        // SAFETY: the first call obtains the required TOKEN_USER or TOKEN_OWNER size.
        unsafe {
            GetTokenInformation(token, class, null_mut(), 0, &mut needed);
        }
        if needed == 0 || needed > 4096 {
            return Err("Windows user identity unavailable".into());
        }
        let mut bytes = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        // SAFETY: aligned buffer holds the complete requested structure and SID.
        if unsafe {
            GetTokenInformation(token, class, bytes.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err("Windows user identity unavailable".into());
        }
        // SAFETY: TOKEN_USER and TOKEN_OWNER both start with a PSID member.
        sid_string(unsafe { *(bytes.as_ptr().cast::<Handle>()) })
    })();
    // SAFETY: OpenProcessToken returned this owned handle.
    unsafe {
        CloseHandle(token);
    }
    result
}

fn current_sid() -> Result<String, String> {
    token_sid(1)
}

fn accepts_owner(owner: &str, user: &str, default_owner: &str) -> bool {
    // Elevated Windows tokens can create files owned by Administrators. Accept
    // that group only when Windows selected it as this token's default owner.
    owner == user || owner == "S-1-5-32-544" && owner == default_owner
}

fn owned_by_current_token(owner: Handle, user: &str) -> Result<bool, String> {
    if owner.is_null() {
        return Ok(false);
    }
    let owner = sid_string(owner)?;
    if owner == user {
        return Ok(true);
    }
    Ok(accepts_owner(&owner, user, &token_sid(4)?))
}

pub fn identity(file: &File) -> Result<(u32, u64, u32), String> {
    let mut info = FileInfo::default();
    // SAFETY: file owns the handle and info is a correctly sized output structure.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.attributes & 0x400 != 0
    {
        return Err("unsafe Windows file".into());
    }
    Ok((
        info.volume,
        (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        info.links,
    ))
}

pub fn path_identity(path: &Path) -> Result<(u32, u64, u32), String> {
    crate::check_ancestors(path.parent().ok_or("invalid private path")?)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0x0020_0000)
        .open(path)
        .map_err(|_| "Windows file stat failed")?;
    identity(&file)
}

pub fn private(file: &File, max_links: u32) -> Result<(), String> {
    let (_, _, links) = identity(file)?;
    if links == 0 || links > max_links {
        return Err("unsafe Windows file links".into());
    }
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: output pointers are valid and FILE_OBJECT/OWNER|DACL are read-only.
    if unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            1,
            5,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    } != 0
    {
        return Err("Windows private permissions unavailable".into());
    }
    let _memory = Memory(descriptor);
    let user = current_sid()?;
    if dacl.is_null() || !owned_by_current_token(owner, &user)? {
        return Err("unsafe Windows file owner or permissions".into());
    }
    // SAFETY: GetSecurityInfo returns a validated ACL in the owned descriptor.
    for index in 0..u32::from(unsafe { (*dacl).count }) {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err("unsafe Windows permissions".into());
        }
        // SAFETY: every ACE starts with ACE_HEADER; allowed ACE SID begins at byte 8.
        let kind = unsafe { *ace.cast::<u8>() };
        if kind == 1 {
            continue;
        } // Deny ACEs cannot grant access.
        if kind != 0 {
            return Err("unsupported Windows permissions".into());
        }
        let sid = sid_string(unsafe { ace.cast::<u8>().add(8).cast() })?;
        if sid != user && sid != "S-1-5-18" && sid != "S-1-5-32-544" {
            return Err("Windows private file is accessible to another account".into());
        }
    }
    Ok(())
}

pub fn secure(path: &Path, directory: bool) -> Result<(), String> {
    crate::check_ancestors(path.parent().ok_or("invalid private path")?)?;
    let file = OpenOptions::new()
        .access_mode(0x0002_0000 | 0x0004_0000)
        .custom_flags(0x0020_0000 | if directory { 0x0200_0000 } else { 0 })
        .open(path)
        .map_err(|_| "Windows private permissions unavailable")?;
    if identity(&file)?.2 != 1 {
        return Err("Windows private state must not contain hard links".into());
    }
    let user = current_sid()?;
    let mut owner = null_mut();
    let mut previous = null_mut();
    // SAFETY: owner is read from this opened object, without following a replacement path.
    if unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            1,
            1,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut previous,
        )
    } != 0
    {
        return Err("Windows private permissions unavailable".into());
    }
    let _previous = Memory(previous);
    if !owned_by_current_token(owner, &user)? {
        return Err("Windows Decision state belongs to another account".into());
    }
    let text: Vec<u16> = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = null_mut();
    // SAFETY: text is NUL-terminated and the returned descriptor is owned here.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err("Windows private permissions unavailable".into());
    }
    let _memory = Memory(descriptor);
    // SAFETY: file grants WRITE_DAC; only this owned object's DACL is replaced.
    if unsafe { SetKernelObjectSecurity(file.as_raw_handle(), 0x8000_0004, descriptor) } == 0 {
        return Err("Could not secure Windows Decision state".into());
    }
    private(&file, 1)
}

pub fn secure_tree(root: &Path) -> Result<(), String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("private directory must be an existing absolute path".into());
    }
    let lower = root.to_string_lossy().to_ascii_lowercase();
    let lower = lower.strip_prefix("\\\\?\\").unwrap_or(&lower);
    if lower.starts_with("d:\\") || lower.starts_with("\\\\") {
        return Err("Windows Decision state must use a local path off D:".into());
    }
    crate::check_ancestors(root)?;
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    while let Some((path, depth)) = pending.pop() {
        count += 1;
        if count > 20_000 || depth > 64 {
            return Err("private state exceeds the security scan limit".into());
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "private state stat failed")?;
        if crate::is_link(&metadata) || !metadata.is_file() && !metadata.is_dir() {
            return Err("private state contains a linked or special file".into());
        }
        secure(&path, metadata.is_dir())?;
        if metadata.is_dir() {
            for child in std::fs::read_dir(path).map_err(|_| "private state scan failed")? {
                pending.push((
                    child.map_err(|_| "private state scan failed")?.path(),
                    depth + 1,
                ));
            }
        }
    }
    Ok(())
}

pub fn lock(file: &File, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Windows file is busy; retry later".into())
            }
            Err(_) => return Err("Windows file lock failed".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_default_owner_accepts_elevated_administrators_but_rejects_foreign_owners() {
        let actual_user = current_sid().unwrap();
        assert!(accepts_owner(
            &actual_user,
            &actual_user,
            &token_sid(4).unwrap()
        ));
        let user = "S-1-5-21-7-8-9-1001";
        assert!(accepts_owner("S-1-5-32-544", user, "S-1-5-32-544"));
        assert!(!accepts_owner("S-1-5-32-544", user, user));
        for foreign in ["S-1-5-18", "S-1-5-21-1-2-3-999", "S-1-5-32-545"] {
            assert!(!accepts_owner(foreign, user, "S-1-5-32-544"));
            assert!(!accepts_owner(foreign, user, foreign));
        }
    }

    #[test]
    fn private_tree_restricts_existing_files_and_locks_contend() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("private.json");
        std::fs::write(&path, b"synthetic").unwrap();
        secure_tree(fixture.path()).unwrap();
        let first = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let second = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        private(&first, 1).unwrap();
        assert_eq!(identity(&first).unwrap(), path_identity(&path).unwrap());
        lock(&first, Duration::ZERO).unwrap();
        assert!(lock(&second, Duration::from_millis(20)).is_err());
        drop(first);
        lock(&second, Duration::ZERO).unwrap();
    }

    #[test]
    fn private_files_reject_hard_links() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("original");
        std::fs::write(&path, b"synthetic").unwrap();
        secure_tree(fixture.path()).unwrap();
        std::fs::hard_link(&path, fixture.path().join("alias")).unwrap();
        assert!(private(&File::open(path).unwrap(), 1).is_err());
    }
}
