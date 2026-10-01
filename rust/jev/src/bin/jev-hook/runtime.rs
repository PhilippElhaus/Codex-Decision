//! Invocation budgets and shared limits.
use super::*;

pub(super) const PANEL_SNAPSHOT_MAX_BYTES: usize = 256 * 1024;
pub(super) const MAX_SOURCE_LINES: usize = 10_000;
pub(super) const MAX_RECEIPT_BYTES: usize = 8 * 1024 * 1024;
thread_local! { pub(super) static HOOK_STARTED: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) }; }
pub(super) fn remaining() -> Result<Duration, String> {
    HOOK_STARTED
        .with(|started| {
            Duration::from_secs(45)
                .checked_sub(started.get().map_or(Duration::ZERO, |time| time.elapsed()))
        })
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "hook deadline".into())
}
