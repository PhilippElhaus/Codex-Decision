//! Version-pinned Codex assets. Keep each supported build's rollback separate.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct Profile {
    pub(super) version: &'static str,
    pub(super) image: &'static str,
    pub(super) route: &'static str,
    pub(super) index_anchor: &'static str,
    pub(super) image_anchor: &'static str,
    pub(super) route_anchor: &'static str,
}

pub(super) const LEGACY: Profile = Profile {
    version: VERSION,
    image: IMAGE,
    route: ROUTE,
    index_anchor: INDEX_ANCHOR,
    image_anchor: IMAGE_ANCHOR,
    route_anchor: ROUTE_ANCHOR,
};

const CURRENT: Profile = Profile {
    version: "26.930.21537",
    image: "webview/assets/app-initial-4a6aff8486cb.js",
    route: "webview/assets/app-initial-3a8f7fe2e714.js",
    index_anchor: "<script type=\"module\" crossorigin src=\"./assets/index-ecd0e676f54b.js\"></script>",
    image_anchor: "let o=KC(e);if(o==null)return null;try{let e={path:o,hostId:t,conversationId:i,environmentId:a}",
    route_anchor: "function KG(){return vG(GG(),`useLocation() may be used only in the context of a <Router> component.`),$G.useContext(TK).location}",
};

pub(super) fn spec(version: &str) -> Result<Spec, String> {
    let (profile, hashes) = match version {
        VERSION => (LEGACY, ORIGINAL),
        "26.930.21537" => (
            CURRENT,
            [
                (
                    HOST,
                    "241516830f7a2fa29ae50c7f5a3a4011f4964697f8d883631ab69ef40f683bab",
                ),
                (
                    INDEX,
                    "eafc05117680285d043b9563da23f60b4ee193dfd5791e775ea7551dca537a49",
                ),
                (
                    IMAGE,
                    "7b0f063dd4536543d7108a16c85e93a9a1d36dccf9cb20acc14c8f7749a17aee",
                ),
                (
                    ROUTE,
                    "80719bd99e56ddba2e832a53feb86292598078be9913ce344a592adc408ba135",
                ),
            ],
        ),
        _ => {
            return Err("unsupported Codex extension version; revalidate the composer patch".into())
        }
    };
    Ok(Spec(
        hashes
            .into_iter()
            .map(|(path, digest)| (path, digest.to_owned()))
            .collect(),
        profile,
    ))
}

pub(super) fn route_fragment(source: String, profile: Profile) -> String {
    if profile.version == VERSION {
        return source;
    }
    // Rebind only the pinned fragment, never search and replace Codex source.
    source
        .replace("vK", "KG")
        .replace("WG", "vG")
        .replace("_K", "GG")
        .replace("TK", "$G")
        .replace("ZK", "TK")
}
