use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const VERSION: &str = "26.917.62051";
const HOST: &str = "out/extension.js";
const INDEX: &str = "webview/index.html";
const IMAGE: &str = "webview/assets/app-initial-de4359f78ed1.js";
const ROUTE: &str = "webview/assets/app-initial-113eb9b2c1a2.js";
const CONTROL: &str = "webview/assets/jev-control.js";
const SETTINGS: &str = "webview/assets/jev-settings.js";
const ICON: &str = "webview/assets/jev-icon.png";
const HOST_ANCHOR: &str =
    "let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),u.type===\"chunked-message-ack\")";
const INDEX_ANCHOR: &str =
    "<script type=\"module\" crossorigin src=\"./assets/index-78f8e71b3851.js\"></script>";
const IMAGE_ANCHOR: &str = "let i=SS(e);if(i==null)return null;try{let e={path:i,hostId:t}";
const ROUTE_ANCHOR: &str = "function BV(){return kV(zV(),`useLocation() may be used only in the context of a <Router> component.`),tH.useContext(vH).location}";
const ORIGINAL: [(&str, &str); 4] = [
    (
        HOST,
        "7ba6208c447c393e050a8ba46893e9e1aa4abd718cb4a8610fa87b12942633bc",
    ),
    (
        INDEX,
        "d91ea97a8bd9e9d67dd048f5496614af4e9eeb33a0dd4b412a6293e06bb3fc02",
    ),
    (
        IMAGE,
        "ffdf480c63b5c99009ae0b618cad846ac5f33af42af4cec900f633586370a9dc",
    ),
    (
        ROUTE,
        "acf372e1e1c64679915cad75014f766a1604004955eb8068c718e6e1f62d0b9e",
    ),
];

#[derive(Clone)]
struct Spec(BTreeMap<&'static str, String>);

impl Spec {
    fn production() -> Self {
        Self(
            ORIGINAL
                .into_iter()
                .map(|(path, hash)| (path, hash.to_owned()))
                .collect(),
        )
    }
    fn hash(&self, path: &'static str) -> &str {
        &self.0[path]
    }
    fn manifest_original(&self) -> Value {
        json!({HOST:self.hash(HOST),INDEX:self.hash(INDEX)})
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn exact(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = root.join(relative);
    if path.is_symlink() || !path.is_file() {
        return Err(format!("missing or linked file: {relative}"));
    }
    fs::read(path).map_err(|error| error.to_string())
}

fn write_exact(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(
        "{}.jev-temporary",
        path.file_name().unwrap().to_string_lossy()
    ));
    if temp.exists() || temp.is_symlink() {
        return Err("Jev patch temporary file already exists".into());
    }
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    let result = fs::rename(&temp, path).map_err(|error| error.to_string());
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn replace_once(source: &str, from: &str, to: &str) -> Result<String, String> {
    if source.matches(from).count() != 1 {
        return Err("Codex insertion point changed".into());
    }
    Ok(source.replacen(from, to, 1))
}

fn as_text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes).map_err(|_| "Codex asset is not UTF-8".into())
}

#[path = "patch/bridge.rs"]
mod bridge;
#[path = "patch/lifecycle.rs"]
mod lifecycle;
#[cfg(test)]
#[path = "patch/tests.rs"]
mod tests;

use bridge::changed;
pub use lifecycle::run;
