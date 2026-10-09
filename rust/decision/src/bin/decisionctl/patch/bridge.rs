use super::*;

pub(super) fn wslpath(path: &Path) -> Result<String, String> {
    let output = Command::new("wslpath")
        .arg("-w")
        .arg(path)
        .output()
        .map_err(|error| format!("wslpath failed: {error}"))?;
    if !output.status.success() {
        return Err("wslpath failed".into());
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_owned())
        .map_err(|_| "invalid Windows path".into())
}

pub(super) struct Bridges {
    pub(super) image: String,
    pub(super) marketplace: String,
}

pub(super) fn image_bridge(home: &str, windows_root: &str) -> Result<String, String> {
    let root = windows_root.trim_end_matches('\\');
    if !root.to_ascii_lowercase().starts_with("\\\\wsl.localhost\\")
        && !root.to_ascii_lowercase().starts_with("\\\\wsl$\\")
    {
        return Err("WSL image path is unavailable".into());
    }
    let local = format!("{home}/plugins/codex-decision/");
    let cache = format!("{home}/.codex/plugins/cache/personal");
    let integrated =
        format!("{home}/.codex/plugins/cache/codex-decision-integrated/codex-decision/");
    let source = format!("{home}/.local/share/codex-decision/plugins/codex-decision/");
    Ok(format!("if(o.startsWith({})||o.startsWith({})||o.startsWith({})||o.startsWith({})||o.startsWith({}))o={}+o.replaceAll(\"/\",\"\\\\\");",
        json!(local), json!(format!("{cache}/codex-decision/")),
        json!(format!("{cache}/codex-chime/")), json!(integrated), json!(source), json!(root)))
}

pub(super) fn marketplace_bridge(
    chosen: &Path,
    bytes: &[u8],
    converted: &str,
    distro: Option<&str>,
) -> String {
    if !chosen.is_absolute() || bytes.len() > 64_000 {
        return String::new();
    }
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return String::new();
    };
    let names: Vec<&str> = value["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["name"].as_str())
        .filter(|name| ["codex-decision", "codex-chime"].contains(name))
        .collect();
    if names.is_empty() {
        return String::new();
    }
    let lower = converted.to_ascii_lowercase();
    if !(lower.starts_with("\\\\wsl.localhost\\")
        || lower.starts_with("\\\\wsl$\\")
        || lower.as_bytes().get(1..3) == Some(b":\\"))
    {
        return String::new();
    }
    let mut aliases = vec![lower];
    if let Some(distro) = distro {
        if distro.len() <= 64
            && distro
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            && distro
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            aliases.push(
                format!(
                    "\\\\wsl.localhost\\{distro}{}",
                    chosen.display().to_string().replace('/', "\\")
                )
                .to_ascii_lowercase(),
            );
        }
    }
    format!("if(u&&u.type===\"mcp-request\"&&u.request&&u.request.method===\"plugin/read\"&&u.request.params&&typeof u.request.params.marketplacePath===\"string\"){{let p=u.request.params.marketplacePath.toLowerCase().replaceAll(\"/\",\"\\\\\");if(({}.includes(p)||(p===\".agents\\\\plugins\\\\marketplace.json\"||p===\".\\\\.agents\\\\plugins\\\\marketplace.json\"))&&{}.includes(u.request.params.pluginName))u.request.params.marketplacePath={};}}",
        json!(aliases), json!(names), json!(chosen.display().to_string()))
}

pub(super) fn bridges(repo: &Path) -> Result<Bridges, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is unavailable")?;
    let personal = PathBuf::from(&home).join(".agents/plugins/marketplace.json");
    let chosen = std::env::var_os("CODEX_DECISION_MARKETPLACE_PATH")
        .map(PathBuf::from)
        .or_else(|| personal.is_file().then_some(personal))
        .unwrap_or_else(|| repo.join(".agents/plugins/marketplace.json"));
    let marketplace = if chosen.is_absolute() && chosen.is_file() && !chosen.is_symlink() {
        fs::metadata(&chosen)
            .ok()
            .filter(|details| details.len() <= 64_000)
            .and_then(|_| fs::read(&chosen).ok())
            .zip(wslpath(&chosen).ok())
            .map(|(bytes, converted)| {
                marketplace_bridge(
                    &chosen,
                    &bytes,
                    &converted,
                    std::env::var("WSL_DISTRO_NAME").ok().as_deref(),
                )
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok(Bridges {
        image: image_bridge(&home, &wslpath(Path::new("/"))?)?,
        marketplace,
    })
}

pub(super) fn changed(
    repo: &Path,
    originals: &BTreeMap<&'static str, Vec<u8>>,
    spec: &Spec,
    bridges: &Bridges,
) -> Result<BTreeMap<&'static str, Vec<u8>>, String> {
    let assets = if repo.join("vscode-control").is_dir() {
        repo.join("vscode-control")
    } else {
        repo.to_path_buf()
    };
    for (path, bytes) in originals {
        if hash(bytes) != spec.hash(path) {
            return Err(format!("Codex extension file changed: {path}"));
        }
    }
    let host = as_text(&originals[HOST])?;
    let index = as_text(&originals[INDEX])?;
    let image = as_text(&originals[IMAGE])?;
    let route = as_text(&originals[ROUTE])?;
    let fragment = as_text(&exact(&assets, "patch-assets/host-bridge.jsfrag")?)?.to_owned();
    let fragment = replace_once(
        &fragment,
        "if(s.markMessageReceived()",
        &format!("{}if(s.markMessageReceived()", bridges.marketplace),
    )?;
    let route_fragment = profiles::route_fragment(
        as_text(&exact(&assets, "patch-assets/route-bridge.jsfrag")?)?.to_owned(),
        spec.1,
    );
    let mut result = BTreeMap::new();
    result.insert(
        HOST,
        replace_once(host, HOST_ANCHOR, &fragment)?.into_bytes(),
    );
    result.insert(INDEX, replace_once(index, spec.1.index_anchor,
        &format!("<script src=\"./assets/decision-control.js\"></script>\n<script src=\"./assets/decision-settings.js\"></script>\n{}", spec.1.index_anchor))?.into_bytes());
    result.insert(
        spec.physical(IMAGE),
        replace_once(
            image,
            spec.1.image_anchor,
            &spec
                .1
                .image_anchor
                .replacen("try{", &format!("{}try{{", bridges.image), 1),
        )?
        .into_bytes(),
    );
    result.insert(
        spec.physical(ROUTE),
        replace_once(route, spec.1.route_anchor, &route_fragment)?.into_bytes(),
    );
    result.insert(CONTROL, exact(&assets, "webview/decision-control.js")?);
    result.insert(SETTINGS, exact(&assets, "webview/decision-settings.js")?);
    result.insert(ICON, exact(&assets, "icon.png")?);
    Ok(result)
}
