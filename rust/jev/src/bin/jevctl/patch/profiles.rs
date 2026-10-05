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

const LATEST: Profile = Profile {
    version: "26.930.31730",
    image: "webview/assets/app-initial-7d34126aa1b5.js",
    route: "webview/assets/app-initial-ef6113854c2e.js",
    index_anchor: "<script type=\"module\" crossorigin src=\"./assets/index-8f335a4dc3d3.js\"></script>",
    image_anchor: "let o=WC(e);if(o==null)return null;try{let e={path:o,hostId:t,conversationId:i,environmentId:a}",
    route_anchor: "function JG(){return bG(qG(),`useLocation() may be used only in the context of a <Router> component.`),tK.useContext(DK).location}",
};

const OCTOBER_4: Profile = Profile {
    version: "26.930.41038",
    image: "webview/assets/app-initial-5df504dce500.js",
    route: "webview/assets/app-initial-ba53a9935f6c.js",
    index_anchor: "<script type=\"module\" crossorigin src=\"./assets/index-64239a0fdf31.js\"></script>",
    image_anchor: "let o=HC(e);if(o==null)return null;try{let e={path:o,hostId:t,conversationId:i,environmentId:a}",
    route_anchor: LATEST.route_anchor,
};

const OCTOBER_5: Profile = Profile {
    version: "26.930.51102",
    image: "webview/assets/app-initial-e8b5abd35a8c.js",
    route: "webview/assets/app-initial-6a7c0476c16a.js",
    index_anchor: "<script type=\"module\" crossorigin src=\"./assets/index-832f192578ec.js\"></script>",
    image_anchor: "let o=VC(e);if(o==null)return null;try{let e={path:o,hostId:t,conversationId:i,environmentId:a}",
    route_anchor: "function nq(){return OK(tq(),`useLocation() may be used only in the context of a <Router> component.`),lq.useContext(Fq).location}",
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
        "26.930.31730" => (
            LATEST,
            [
                (
                    HOST,
                    "5eb050f6c72ffdd60114e1e5f5800b8368353b6922e49abe19adde4782a03e9f",
                ),
                (
                    INDEX,
                    "b04c322b98347fe2c95fd9d21bde8943f842c8442c9b836213670b115cbf2e3e",
                ),
                (
                    IMAGE,
                    "e3c95feeed53805e5a7fbbac95c9d51747d74c270f407c1edb9b689f756bc7f2",
                ),
                (
                    ROUTE,
                    "68274a169d7cf58b09222494545353519818783239a769b7b7987e670415dbf7",
                ),
            ],
        ),
        "26.930.41038" => (
            OCTOBER_4,
            [
                (
                    HOST,
                    "3c914f0363ebd7f69c4bb6b888960220d43cdd15752f56d81b6645502bf1cf95",
                ),
                (
                    INDEX,
                    "cffa5e49fa5c642c64fef93fe02493589a45751b78941a3c814c63208e99dde4",
                ),
                (
                    IMAGE,
                    "0cc4e2c158dd9ebdd16501c821e00a68af2cbacf63cd2bf420beb23650a27443",
                ),
                (
                    ROUTE,
                    "05b1b959c54b0a489830f28a8dc86e0b217c346a93170e54221b73e2c17f5198",
                ),
            ],
        ),
        "26.930.51102" => (
            OCTOBER_5,
            [
                (
                    HOST,
                    "1f051b97e1388816133ba9a5070832bf77ccd3e47b47fbda88f7a3d0be809e40",
                ),
                (
                    INDEX,
                    "25f7fd9ff60dcf2434fbbc24ac9bad6ac8326824b1a85d6ddaefbd990de15b10",
                ),
                (
                    IMAGE,
                    "eec8f8b4ca288791c710c232fcc856c668def0d52e4d38627d6a6278015817b3",
                ),
                (
                    ROUTE,
                    "e20b37ac8135d4f08a11787db86f1a798536537f75ca6de69821709e1d9a12e9",
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
    let (router, assert, in_router, react, context) = if profile.version == OCTOBER_5.version {
        ("nq", "OK", "tq", "lq", "Fq")
    } else if [LATEST.version, OCTOBER_4.version].contains(&profile.version) {
        ("JG", "bG", "qG", "tK", "DK")
    } else {
        ("KG", "vG", "GG", "$G", "TK")
    };
    source
        .replace("vK", router)
        .replace("WG", assert)
        .replace("_K", in_router)
        .replace("TK", react)
        .replace("ZK", context)
}
