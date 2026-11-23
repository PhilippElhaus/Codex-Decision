//! Codex owns plugin registration. The installer verifies its returned identity.
use super::*;
use std::process::Stdio;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

pub(super) struct Selection {
    pub marketplace: String,
    pub id: String,
    pub source: PathBuf,
    pub marketplace_path: Option<PathBuf>,
    pub current: bool,
    fresh: Option<(PathBuf, Value)>,
    version: String,
}

fn call(
    run: &mut impl FnMut(&[&OsStr]) -> Result<Value, String>,
    args: &[&str],
) -> Result<Value, String> {
    run(&args.iter().map(OsStr::new).collect::<Vec<_>>())
}

fn existing(reply: &Value) -> Result<Option<&Value>, String> {
    let entries = reply
        .get("installed")
        .and_then(Value::as_array)
        .ok_or("Invalid Codex plugin metadata")?;
    let installed: Vec<_> = entries
        .iter()
        .filter(|item| item["name"] == PLUGIN && item["installed"] == true)
        .collect();
    let enabled: Vec<_> = installed
        .iter()
        .copied()
        .filter(|item| item["enabled"] == true)
        .collect();
    match (enabled.as_slice(), installed.as_slice()) {
        ([item], _) | ([], [item]) => Ok(Some(item)),
        ([], []) => Ok(None),
        _ => Err("Multiple Decision registrations need an explicit selection".into()),
    }
}

pub(super) fn discover(
    run: &mut impl FnMut(&[&OsStr]) -> Result<Value, String>,
    home: &Path,
    codex_home: &Path,
    version: &str,
) -> Result<Selection, String> {
    let listed = call(run, &["list"])?;
    let installed = existing(&listed)?;
    let metadata = call(run, &["marketplace", "list"])?;
    let roots = metadata["marketplaces"]
        .as_array()
        .ok_or("Invalid Codex marketplace metadata")?;
    let marketplace = installed
        .map_or(Some(MARKETPLACE), |item| item["marketplaceName"].as_str())
        .filter(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        })
        .ok_or("Invalid Decision marketplace identity")?;
    let id = format!("{PLUGIN}@{marketplace}");
    let registered: Vec<_> = roots
        .iter()
        .filter(|item| item["name"] == marketplace)
        .collect();
    let (source, marketplace_path, current, fresh) = if let Some(item) = installed {
        if item["enabled"] != true {
            return Err(
                "Decision is disabled in Codex; enable its existing registration before repair"
                    .into(),
            );
        }
        let actual = item["version"]
            .as_str()
            .ok_or("Invalid Decision package version")?;
        if parse_version(actual)? > parse_version(version)? {
            return Err("Installed Decision hook is newer than this VSIX".into());
        }
        let source = item["source"]["path"]
            .as_str()
            .filter(|_| item["source"]["source"] == "local")
            .ok_or("This Decision registration needs a local marketplace for integrated updates")?;
        let source = storage::safe(Path::new(source))?;
        if !under(&source, home) || same_path(&source, codex_home) {
            return Err(
                "Decision needs a dedicated local package directory under the user home".into(),
            );
        }
        if storage::json_file(&source.join(MANIFEST))?["name"] != PLUGIN {
            return Err("The registered Decision source is not a Decision package".into());
        }
        if item["pluginId"] != id {
            return Err("Invalid Decision plugin identity".into());
        }
        let marketplace_path = match registered.as_slice() {
            [item] => item["root"]
                .as_str()
                .map(|root| storage::safe(&Path::new(root).join(MARKETPLACE_FILE)))
                .transpose()?,
            _ => None,
        };
        (source, marketplace_path, actual == version, None)
    } else {
        let root = storage::safe(&home.join(".local/share/codex-decision"))?;
        match registered.as_slice() {
            [] => {}
            [item]
                if item["root"]
                    .as_str()
                    .and_then(|path| storage::safe(Path::new(path)).ok())
                    .is_some_and(|actual| same_path(&actual, &root)) => {}
            _ => return Err(
                "Decision integrated marketplace name is already registered at another directory"
                    .into(),
            ),
        }
        let marketplace_path = storage::safe(&root.join(MARKETPLACE_FILE))?;
        let content = json!({"name": marketplace, "interface": {"displayName": "Codex Decision"},
            "plugins": [{"name": PLUGIN, "source": {"source": "local", "path": "./plugins/codex-decision"},
                "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity"}]});
        if storage::info(&marketplace_path)?.is_some()
            && storage::json_file(&marketplace_path)? != content
        {
            return Err("Decision integrated marketplace contains unknown configuration".into());
        }
        (
            root.join("plugins/codex-decision"),
            Some(marketplace_path),
            false,
            Some((root, content)),
        )
    };
    Ok(Selection {
        marketplace: marketplace.into(),
        id,
        source,
        marketplace_path,
        current,
        fresh,
        version: version.into(),
    })
}

impl Selection {
    pub(super) fn register(
        &self,
        run: &mut impl FnMut(&[&OsStr]) -> Result<Value, String>,
    ) -> Result<(), String> {
        if let Some((root, metadata)) = &self.fresh {
            let text = format!("{metadata:#}\n");
            storage::write(&root.join(MARKETPLACE_FILE), text.as_bytes(), 0o644, true)?;
            run(&[
                OsStr::new("marketplace"),
                OsStr::new("add"),
                root.as_os_str(),
            ])?;
        }
        call(run, &["add", &self.id])?;
        let listed = call(run, &["list"])?;
        if !existing(&listed)?.is_some_and(|item| {
            item["pluginId"] == self.id
                && item["version"] == self.version
                && item["enabled"] == true
        }) {
            return Err("Codex did not activate the packaged Decision version".into());
        }
        Ok(())
    }
}

pub(super) fn run(binary: &Path, codex_home: &Path, args: &[&OsStr]) -> Result<Value, String> {
    let mut command = Command::new(binary);
    command
        // Local updates only need local marketplace state. Remote discovery
        // must not delay reading or refreshing the local registration.
        .args(["-c", "features.remote_plugin=false"])
        .arg("plugin")
        .args(args)
        .arg("--json")
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Codex plugin command could not start")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Codex plugin metadata is unavailable")?;
    let (output, incoming) = channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout
            .take(2_000_001)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = output.send(read);
    });
    let started = Instant::now();
    let timeout = Duration::from_secs(90);
    let read = (|| -> Result<Value, String> {
        let output = match incoming.recv_timeout(timeout) {
            Ok(Ok(bytes)) if bytes.len() <= 2_000_000 => bytes,
            Err(RecvTimeoutError::Timeout) => return Err("Codex plugin command timed out".into()),
            _ => {
                return Err(
                    "Codex plugin metadata exceeds the installation limit or could not be read"
                        .into(),
                )
            }
        };
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Codex plugin command could not complete")?
            {
                if !status.success() {
                    return Err("Codex plugin command failed during installation".into());
                }
                return codex_decision::strict_json::parse(&output)
                    .map_err(|_| "Invalid Codex plugin metadata".into());
            }
            if started.elapsed() >= timeout {
                return Err("Codex plugin command timed out".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    })();
    if read.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    read
}
