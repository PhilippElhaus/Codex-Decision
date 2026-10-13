use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Instant;

const FIXTURE: &str = "CODEX_DECISION_PATCH_LOCK_FIXTURE";

struct Holder {
    child: Child,
    output: BufReader<ChildStdout>,
}

impl Holder {
    fn start(backup: &Path) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "patch::locking::tests::lock_holder_process",
                "--ignored",
                "--nocapture",
            ])
            .env(FIXTURE, backup)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut holder = Self { child, output };
        loop {
            let mut line = String::new();
            assert_ne!(
                holder.output.read_line(&mut line).unwrap(),
                0,
                "child must acquire the directory lock before the test continues"
            );
            if line.trim_end().ends_with("lock acquired") {
                break;
            }
        }
        holder
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "subprocess fixture used by the patch locking tests"]
fn lock_holder_process() {
    let Some(backup) = std::env::var_os(FIXTURE) else {
        return;
    };
    let _lock = acquire(Path::new(&backup)).unwrap();
    println!("lock acquired");
    std::io::stdout().flush().unwrap();
    // EOF releases the lock normally. Killing this process releases it in the kernel.
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
}

#[test]
fn patch_lock_waits_for_another_process_without_writing_state() {
    let directory = tempfile::tempdir().unwrap();
    let backup = directory.path().join("rollback");
    let before = fs::metadata(directory.path()).unwrap().modified().unwrap();
    let mut holder = Holder::start(&backup);
    let input = holder.child.stdin.take().unwrap();
    let started = Instant::now();
    let release = std::thread::spawn(move || {
        // Exceed the former 250/500/1000-ms extension retry window.
        std::thread::sleep(Duration::from_secs(2));
        drop(input);
    });
    let lock = acquire(&backup).unwrap();
    assert!(started.elapsed() >= Duration::from_secs(2));
    release.join().unwrap();
    assert!(holder.child.wait().unwrap().success());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    assert_eq!(
        fs::metadata(directory.path()).unwrap().modified().unwrap(),
        before
    );
    assert_eq!(
        acquire_with_timeout(&backup, Duration::ZERO).unwrap_err(),
        "Decision patch is busy; retry later"
    );
    drop(lock);
    assert!(acquire_with_timeout(&backup, Duration::ZERO).is_ok());
}

#[test]
fn patch_lock_times_out_and_recovers_after_the_owner_is_killed() {
    let directory = tempfile::tempdir().unwrap();
    let backup = directory.path().join("rollback");
    let mut holder = Holder::start(&backup);
    let timeout = Duration::from_millis(150);
    let started = Instant::now();
    assert_eq!(
        acquire_with_timeout(&backup, timeout).unwrap_err(),
        "Decision patch is busy; retry later"
    );
    assert!(started.elapsed() >= timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
    holder.child.kill().unwrap();
    assert!(!holder.child.wait().unwrap().success());
    assert!(acquire_with_timeout(&backup, Duration::ZERO).is_ok());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}
