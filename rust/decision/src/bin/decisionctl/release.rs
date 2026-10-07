use chrono::Utc;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;

fn manifest_version(root: &Path) -> Result<String, String> {
    let manifest = super::read_json(&root.join(".codex-plugin/plugin.json"), 64_000)?;
    if manifest.get("name").and_then(Value::as_str) != Some("codex-decision") {
        return Err("invalid Decision plugin manifest".into());
    }
    manifest
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or("missing plugin version".into())
}

pub fn check_versions(root: &Path) -> Result<(), String> {
    let manifest = root.join("rust/decision/Cargo.toml");
    let metadata = Command::new("cargo")
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
        ])
        .arg(&manifest)
        .output()
        .map_err(|error| format!("cargo metadata failed: {error}"))?;
    if !metadata.status.success() {
        return Err("cargo metadata failed".into());
    }
    let cargo: Value =
        serde_json::from_slice(&metadata.stdout).map_err(|_| "invalid cargo metadata")?;
    let hook = cargo["packages"]
        .as_array()
        .and_then(|packages| {
            packages
                .iter()
                .find(|package| package["name"] == "codex-decision")
        })
        .and_then(|package| package["version"].as_str())
        .ok_or("missing Rust hook version")?;
    let plugin = manifest_version(root)?;
    let control = super::read_json(&root.join("vscode-control/package.json"), 64_000)?;
    let control_version = control["codexDecisionHookVersion"]
        .as_str()
        .ok_or("missing control hook version")?;
    if plugin.split('+').next() != Some(hook)
        || control_version != hook
        || hook != env!("CARGO_PKG_VERSION")
    {
        return Err("hook, plugin, and VS Code control versions differ".into());
    }
    println!("Codex Decision hook version {hook} is consistent.");
    Ok(())
}

pub fn check_binary(path: &Path, name: &str, version: &str) -> Result<(), String> {
    let mut header = [0u8; 64];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| format!("invalid {name} binary"))?;
    if &header[..6] != b"\x7fELF\x02\x01" || header[18..20] != [62, 0] {
        return Err(format!("{name} must be a Linux x86_64 ELF binary"));
    }
    let result = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|error| error.to_string())?;
    if !result.status.success() || result.stdout != format!("{name} {version}\n").as_bytes() {
        return Err(format!("{name} binary version differs from package"));
    }
    Ok(())
}

pub fn cachebust(root: &Path) -> Result<(), String> {
    let path = root.join(".codex-plugin/plugin.json");
    if root.is_symlink() || path.is_symlink() {
        return Err("linked plugin path".into());
    }
    let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if original.len() > 64_000 {
        return Err("plugin manifest too large".into());
    }
    let version = manifest_version(root)?;
    let old = format!("\"version\": \"{version}\"");
    if original.matches(&old).count() != 1 {
        return Err("plugin version field changed".into());
    }
    let prefix = version.split('+').next().ok_or("missing plugin version")?;
    let next = format!("{prefix}+codex.{}", Utc::now().format("%Y%m%d%H%M%S"));
    if next == version {
        return Err("cachebuster has not advanced".into());
    }
    let updated = original.replacen(&old, &format!("\"version\": \"{next}\""), 1);
    super::write_private(&path, updated.as_bytes())?;
    println!("Updated plugin version: {version} -> {next}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_versions_match_checkout() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        check_versions(&root).unwrap();
    }

    #[test]
    fn cachebuster_replaces_only_the_suffix() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".codex-plugin")).unwrap();
        let path = root.path().join(".codex-plugin/plugin.json");
        fs::write(&path, "{\n  \"name\": \"codex-decision\",\n  \"version\": \"0.8.0+codex.old\",\n  \"description\": \"fixture\"\n}\n").unwrap();
        cachebust(root.path()).unwrap();
        let updated = fs::read_to_string(path).unwrap();
        assert!(updated.contains("\"version\": \"0.8.0+codex."));
        assert!(!updated.contains("codex.old"));
        assert!(updated.contains("\"description\": \"fixture\""));
    }
}
