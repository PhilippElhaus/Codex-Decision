//! Install one verified local Decision payload in the selected Codex runtime.
use super::*;
use std::ffi::OsStr;

#[path = "install/cache.rs"]
mod cache;
#[path = "install/codex.rs"]
mod codex;
#[path = "install/fs.rs"]
mod storage;
#[cfg(test)]
#[path = "install/tests.rs"]
mod tests;

const PLUGIN: &str = "codex-decision";
const MARKETPLACE: &str = "codex-decision-integrated";
const MANIFEST: &str = ".codex-plugin/plugin.json";
const MARKETPLACE_FILE: &str = ".agents/plugins/marketplace.json";
const FILE_LIMIT: u64 = 32 * 1024 * 1024;
pub(super) const FILES: &[&str] = &[
    MANIFEST,
    "skills/decision-output/SKILL.md",
    "hooks/hooks.json",
    "hooks/bin/linux-x86_64/decision-hook",
    "hooks/bin/linux-x86_64/decisionctl",
    "hooks/bin/windows-x86_64/decision-hook.exe",
    "hooks/bin/windows-x86_64/decisionctl.exe",
    "assets/logo.png",
    "assets/icon.png",
    "config.example.json",
    "LICENSE",
];

struct Package {
    version: String,
    bytes: BTreeMap<&'static str, Vec<u8>>,
}

struct SourceChange {
    name: &'static str,
    previous: Option<Vec<u8>>,
}

impl Package {
    fn load(root: &Path) -> Result<Self, String> {
        let bytes = FILES
            .iter()
            .map(|&name| {
                let limit = if name == MANIFEST {
                    128_000
                } else {
                    FILE_LIMIT
                };
                storage::read(&root.join(name), limit).map(|bytes| (name, bytes))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let manifest = codex_decision::strict_json::parse(&bytes[MANIFEST])
            .map_err(|_| "Invalid Decision package metadata")?;
        if manifest["name"] != PLUGIN {
            return Err("Invalid Decision hook payload".into());
        }
        let version = manifest["version"]
            .as_str()
            .ok_or("Invalid Decision package version")?;
        parse_version(version)?;
        Ok(Self {
            version: version.to_owned(),
            bytes,
        })
    }

    fn changes(&self, root: &Path) -> Result<Vec<SourceChange>, String> {
        let mut changes = Vec::new();
        for (&name, expected) in &self.bytes {
            let path = root.join(name);
            let info = storage::info(&path)?;
            let bytes = info
                .as_ref()
                .map(|_| storage::read(&path, FILE_LIMIT))
                .transpose()?;
            if bytes.as_ref() != Some(expected)
                || cfg!(unix)
                    && name.starts_with("hooks/bin/")
                    && info.is_some_and(|info| storage::mode(&info) & 0o111 == 0)
            {
                changes.push(SourceChange {
                    name,
                    previous: bytes,
                });
            }
        }
        Ok(changes)
    }
}

fn parse_version(text: &str) -> Result<[u64; 3], String> {
    let (base, extra) = text
        .split_once('+')
        .map_or((text, None), |(base, extra)| (base, Some(extra)));
    let invalid = || "Invalid Decision package version".to_owned();
    if extra.is_some_and(|value| {
        value.is_empty()
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    }) {
        return Err(invalid());
    }
    let mut parts = base.split('.');
    let mut result = [0; 3];
    for value in &mut result {
        let part = parts.next().ok_or_else(invalid)?;
        if !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        *value = part.parse().map_err(|_| invalid())?;
    }
    if parts.next().is_some() {
        return Err(invalid());
    }
    Ok(result)
}

fn key(path: &Path) -> String {
    let name = path.to_string_lossy();
    if cfg!(windows) {
        name.replace('/', "\\").to_lowercase()
    } else {
        name.into_owned()
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

fn under(path: &Path, root: &Path) -> bool {
    path.ancestors()
        .skip(1)
        .any(|parent| same_path(parent, root))
}

fn package_mode(name: &str) -> u32 {
    if name.starts_with("hooks/bin/") {
        0o755
    } else {
        0o644
    }
}

fn validate_source(source: &Path) -> Result<(), String> {
    storage::off_workspace(source)?;
    if storage::info(source)?.is_some_and(|info| !info.is_dir()) {
        return Err("Invalid Decision package destination".into());
    }
    for ancestor in source.ancestors() {
        if fs::symlink_metadata(ancestor.join(".git")).is_ok() {
            return Err("Decision cannot overwrite a development repository".into());
        }
    }
    Ok(())
}

fn update_source(
    package: &Package,
    source: &Path,
    changed: Vec<SourceChange>,
    rollback_root: &Path,
) -> Result<Option<PathBuf>, String> {
    let mut rollback = None;
    // Save the previous images before publishing the first new image.
    for SourceChange { name, previous } in &changed {
        if let Some(bytes) = previous {
            let root = rollback
                .get_or_insert_with(|| rollback_root.join(uuid::Uuid::new_v4().to_string()));
            storage::write(&root.join(name), bytes, package_mode(name), true)?;
        }
    }
    if let Some(root) = &rollback {
        storage::write(
            &root.join("source.json"),
            json!({"source": source}).to_string().as_bytes(),
            0o600,
            true,
        )?;
    }
    for SourceChange { name, .. } in changed {
        storage::write(
            &source.join(name),
            &package.bytes[name],
            package_mode(name),
            true,
        )?;
    }
    Ok(rollback)
}

fn install(
    payload: &Path,
    home: &Path,
    codex_home: &Path,
    configured: Option<&Path>,
    mut run: impl FnMut(&[&OsStr]) -> Result<Value, String>,
) -> Result<Value, String> {
    let home = storage::safe(home)?;
    let codex_home = storage::safe(codex_home)?;
    storage::off_workspace(&home)?;
    storage::off_workspace(&codex_home)?;
    let _lock = storage::lock(&codex_home.join("plugins"))?;
    let state = home.join(".local/state/codex-decision");
    storage::secure_directory(&state, true)?;
    let package = Package::load(payload)?;
    let selection = codex::discover(&mut run, &home, &codex_home, &package.version)?;
    let data = codex_home
        .join("plugins/data")
        .join(format!("{PLUGIN}-{}", selection.marketplace));
    if let Some(configured) = configured {
        if !same_path(&storage::safe(configured)?, &data) {
            return Err("Decision dataDirectory does not match the active Codex plugin; correct it before repair".into());
        }
    }
    storage::secure_directory(&data, true)?;
    validate_source(&selection.source)?;
    let cache_root = codex_home
        .join("plugins/cache")
        .join(&selection.marketplace)
        .join(PLUGIN);
    let installed = cache_root.join(&package.version);
    let binary = if cfg!(windows) {
        "hooks/bin/windows-x86_64/decisionctl.exe"
    } else {
        "hooks/bin/linux-x86_64/decisionctl"
    };
    let mut result = json!({"pluginId": selection.id, "version": package.version, "pluginRoot": installed,
        "dataDirectory": data, "decisionctl": installed.join(binary), "marketplacePath": selection.marketplace_path,
        "status": "ready", "rollback": null, "cacheRollback": null});
    let changed = package.changes(&selection.source)?;
    if selection.current && changed.is_empty() && package.changes(&installed)?.is_empty() {
        return Ok(result);
    }
    let snapshots = cache::snapshot(&cache_root)?;
    let rollback_root = state.join("integrated-rollbacks");
    let cache_rollback = cache::save(&cache_root, &snapshots, &rollback_root, &selection.source)?;
    let rollback = update_source(&package, &selection.source, changed, &rollback_root)?;
    let verified: Result<(), String> = (|| {
        selection.register(&mut run)?;
        if !package.changes(&installed)?.is_empty() {
            return Err("Codex cached Decision package differs from the VSIX".into());
        }
        Ok(())
    })();
    cache::restore(
        &cache_root,
        &snapshots,
        verified.is_ok().then_some(package.version.as_str()),
    )?;
    verified?;
    result["status"] = json!("installed");
    result["cacheRollback"] = json!(cache_rollback);
    result["rollback"] = json!(rollback.or(cache_rollback));
    Ok(result)
}

pub(super) fn run(args: &[String]) -> Result<(), String> {
    let result = (|| {
        let [_, _, first, payload, second, binary, rest @ ..] = args else {
            return Err("Invalid Decision installation arguments".into());
        };
        if first != "--payload" || second != "--codex" {
            return Err("Invalid Decision installation arguments".into());
        }
        let mut configured = None;
        let mut home = std::env::home_dir().ok_or("Decision user directory is unavailable")?;
        // An explicit home is used by isolated profiles. Production uses the
        // account's actual home and the current runtime's CODEX_HOME.
        for pair in rest.chunks(2) {
            match pair {
                [flag, value] if flag == "--data-directory" && configured.is_none() => {
                    configured = Some(Path::new(value))
                }
                [flag, value] if flag == "--home" => home = PathBuf::from(value),
                _ => return Err("Invalid Decision installation arguments".into()),
            }
        }
        let codex_home =
            std::env::var_os("CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from);
        let codex_home = storage::safe(&codex_home)?;
        let binary = storage::safe(Path::new(binary))?;
        install(Path::new(payload), &home, &codex_home, configured, |args| {
            codex::run(&binary, &codex_home, args)
        })
    })();
    match result {
        Ok(result) => {
            println!("{result}");
            Ok(())
        }
        Err(error) => {
            let retryable = error.contains("timed out") || error.contains("busy; retry");
            println!(
                "{}",
                json!({"status": "error", "error": error, "retryable": retryable})
            );
            Err("Decision installation failed".into())
        }
    }
}
