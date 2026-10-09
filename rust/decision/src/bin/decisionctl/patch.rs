use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const VERSION: &str = "26.928.31416";
const HOST: &str = "out/extension.js";
const INDEX: &str = "webview/index.html";
const IMAGE: &str = "webview/assets/app-initial-4bd9e54bcd58.js";
const ROUTE: &str = "webview/assets/app-initial-9f7d97690e9b.js";
const CONTROL: &str = "webview/assets/decision-control.js";
const SETTINGS: &str = "webview/assets/decision-settings.js";
const ICON: &str = "webview/assets/decision-icon.png";
const HOST_ANCHOR: &str =
    "let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),u.type===\"chunked-message-ack\")";
const INDEX_ANCHOR: &str =
    "<script type=\"module\" crossorigin src=\"./assets/index-125259e22935.js\"></script>";
const IMAGE_ANCHOR: &str = "let o=JC(e);if(o==null)return null;try{let e={path:o,hostId:t,conversationId:i,environmentId:a}";
const ROUTE_ANCHOR: &str = "function vK(){return WG(_K(),`useLocation() may be used only in the context of a <Router> component.`),TK.useContext(ZK).location}";
const ORIGINAL: [(&str, &str); 4] = [
    (
        HOST,
        "550b03e76ac5a83cb25788aa3240ba445d0e7c7d4e76af8331442687529617ef",
    ),
    (
        INDEX,
        "29ac12b60870294814cdcf3916d5171053d930c49f2c030fbde50200039e42bc",
    ),
    (
        IMAGE,
        "48e766bf42c5642cca7b8c9f9b3906d840d5e7c9378039882500e9d3b6ebb8f6",
    ),
    (
        ROUTE,
        "9fbb5f7d948509655dfe6898088365fcfaa44e11af7698add930411d78f0a5c5",
    ),
];

#[derive(Clone)]
struct Spec(BTreeMap<&'static str, String>, profiles::Profile);

#[path = "patch/profiles.rs"]
mod profiles;

impl Spec {
    fn production(version: &str) -> Result<Self, String> {
        profiles::spec(version)
    }
    fn physical(&self, path: &'static str) -> &'static str {
        match path {
            IMAGE => self.1.image,
            ROUTE => self.1.route,
            _ => path,
        }
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
    locking::reject_links(&path)?;
    if path.is_symlink() || !path.is_file() {
        return Err(format!("missing or linked file: {relative}"));
    }
    fs::read(path).map_err(|error| error.to_string())
}

fn write_exact(path: &Path, bytes: &[u8]) -> Result<(), String> {
    locking::reject_links(path)?;
    let temp = path.with_file_name(format!(
        "{}.decision-temporary",
        path.file_name().unwrap().to_string_lossy()
    ));
    if temp.exists() || temp.is_symlink() {
        return Err("Decision patch temporary file already exists".into());
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
#[path = "patch/locking.rs"]
mod locking;
#[path = "patch/status.rs"]
mod status;
#[cfg(test)]
#[path = "patch/status_tests.rs"]
mod status_tests;
#[cfg(test)]
#[path = "patch/tests.rs"]
mod tests;

use bridge::changed;
pub use lifecycle::run;
