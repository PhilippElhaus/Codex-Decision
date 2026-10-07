//! Bounded session log retention.
use super::*;

pub(super) fn prune(logs: &Path, budget: u64) {
    let index = logs.join("events.jsonl");
    if !index.is_symlink() {
        if let Ok(metadata) = fs::metadata(&index) {
            if metadata.is_file() && metadata.len() > 1_048_576 {
                use std::io::{Seek, SeekFrom};
                if let Ok(mut file) = File::open(&index) {
                    if file.seek(SeekFrom::End(-1_048_576)).is_ok() {
                        let mut tail = Vec::new();
                        if file.read_to_end(&mut tail).is_ok() {
                            if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
                                let _ = write_private(&index, &tail[newline + 1..], true);
                            }
                        }
                    }
                }
            }
        }
    }
    let Ok(entries) = fs::read_dir(logs) else {
        return;
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            if let Ok(children) = fs::read_dir(path) {
                for child in children.flatten() {
                    let item = child.path();
                    if item.is_file()
                        && !item.is_symlink()
                        && (item
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .starts_with("receipt-")
                            || item
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .starts_with("batch-"))
                    {
                        if let Ok(meta) = item.metadata() {
                            files.push((meta.modified().ok(), item, meta.len()));
                        }
                    }
                }
            }
        }
    }
    let mut total: u64 = files.iter().map(|(_, _, size)| size).sum();
    files.sort_by_key(|(time, path, _)| (*time, path.clone()));
    for (_, path, size) in files {
        if total <= budget {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}
