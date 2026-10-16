//! Exercise provider switching through the real fail-open hook process.
use super::*;

#[path = "fallback/support.rs"]
mod support;
use support::*;

#[test]
fn unavailable_providers_fallback_in_both_directions_with_actual_receipts_and_attempts() {
    for (provider, primary, alternate) in [
        ("openai", "gpt-6-luna", "jev-latest"),
        ("typesafe", "jev-latest", "gpt-6-luna"),
    ] {
        for failure in [Failure::Http, Failure::Protocol, Failure::Transport] {
            let (_root, data, event) = fixture(provider, true, BOTH_KEYS, 120);
            let (endpoint, stop, server) = server(primary, failure, 0, false);
            assert_replacement(&data, &endpoint, &event);
            stop.store(true, Ordering::Relaxed);
            let models = server.join().unwrap();
            assert_eq!(models[0], primary);
            assert!(models[1..].iter().all(|model| model == alternate));
            assert_eq!(health(&data)["api_requests"], models.len());
            assert_eq!(health(&data)["request_failures"], 1);
            let manifest = &receipt(&data)["manifest"];
            assert_eq!(manifest["model"], alternate);
            assert_eq!(
                manifest["provider"],
                if provider == "openai" {
                    "typesafe"
                } else {
                    "openai"
                }
            );
            assert_eq!(manifest["configured_provider"], provider);
            assert_eq!(manifest["configured_model"], primary);
            assert_eq!(manifest["fallback_used"], true);
            assert_eq!(
                manifest["requests"].as_u64().unwrap() + 1,
                models.len() as u64
            );
        }
    }
}

#[test]
fn missing_primary_key_uses_saved_alternate_without_an_unsent_attempt() {
    for (provider, keys, alternate) in [
        ("openai", "JEV_API_KEY=synthetic-jev-key\n", "jev-latest"),
        (
            "typesafe",
            "OPENAI_API_KEY=synthetic-openai-key\n",
            "gpt-6-luna",
        ),
    ] {
        let (_root, data, event) = fixture(provider, true, keys, 120);
        let (endpoint, stop, server) = server("unused", Failure::None, 0, false);
        assert_replacement(&data, &endpoint, &event);
        stop.store(true, Ordering::Relaxed);
        let models = server.join().unwrap();
        assert!(!models.is_empty());
        assert!(models.iter().all(|model| model == alternate));
        assert_eq!(health(&data)["api_requests"], models.len());
        assert_eq!(receipt(&data)["manifest"]["fallback_used"], true);
    }
}

#[test]
fn two_maximum_length_saved_keys_remain_usable_by_the_hook() {
    let keys = format!(
        "OPENAI_API_KEY={}\nJEV_API_KEY={}\n",
        "a".repeat(4096),
        "j".repeat(4096)
    );
    let (_root, data, event) = fixture("openai", true, &keys, 120);
    let (endpoint, stop, server) = server("gpt-6-luna", Failure::Http, 0, false);
    assert_replacement(&data, &endpoint, &event);
    stop.store(true, Ordering::Relaxed);
    let models = server.join().unwrap();
    assert_eq!(models[0], "gpt-6-luna");
    assert!(models[1..].iter().all(|model| model == "jev-latest"));
}

#[test]
fn disabled_or_exhausted_fallback_keeps_full_output_without_partial_publication() {
    for enabled in [false, true] {
        let (_root, data, event) = fixture("openai", enabled, BOTH_KEYS, 120);
        let (endpoint, stop, server) = server("gpt-6-luna", Failure::Protocol, 0, true);
        assert_eq!(invoke(&data, &endpoint, &event), json!({}));
        stop.store(true, Ordering::Relaxed);
        let models = server.join().unwrap();
        assert_eq!(models.len(), if enabled { 2 } else { 1 });
        assert_eq!(health(&data)["api_requests"], models.len());
        assert!(!data.join("outputs").exists());
        assert!(!scoped(&data, "fallback")
            .join("logs/latest-decision.json")
            .exists());
        let stats: Value = serde_json::from_slice(
            &fs::read(scoped(&data, "fallback").join("stats.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stats["completed"], 0);
    }
}

#[test]
fn late_provider_failure_rolls_back_progress_before_alternate_publication() {
    let (_root, data, event) = fixture("openai", true, BOTH_KEYS, 500);
    let (endpoint, stop, server) = server("gpt-6-luna", Failure::Protocol, 1, false);
    assert_replacement(&data, &endpoint, &event);
    stop.store(true, Ordering::Relaxed);
    let models = server.join().unwrap();
    assert_eq!(&models[..2], ["gpt-6-luna", "gpt-6-luna"]);
    assert!(models[2..].iter().all(|model| model == "jev-latest"));
    assert_eq!(health(&data)["api_requests"], models.len());
    assert_eq!(receipt(&data)["manifest"]["model"], "jev-latest");
    let stats: Value =
        serde_json::from_slice(&fs::read(scoped(&data, "fallback").join("stats.json")).unwrap())
            .unwrap();
    assert_eq!(stats["completed"], 1);
}

#[test]
fn fallback_never_crosses_local_guards_or_unsafe_credentials() {
    for scenario in ["privacy", "exact", "permissions", "link", "duplicate"] {
        let (_root, data, mut event) = fixture("openai", true, BOTH_KEYS, 120);
        match scenario {
            "privacy" => {
                event["tool_response"] = json!(format!(
                    "{}\npassword=synthetic-private-value",
                    event["tool_response"].as_str().unwrap()
                ))
            }
            "exact" => event["tool_input"]["command"] = json!("cat source.rs"),
            "permissions" => {
                fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o644)).unwrap()
            }
            "link" => {
                fs::remove_file(data.join(".env")).unwrap();
                std::os::unix::fs::symlink("absent", data.join(".env")).unwrap();
            }
            "duplicate" => fs::write(
                data.join(".env"),
                format!("{BOTH_KEYS}OPENAI_API_KEY=synthetic-duplicate-key\n"),
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let (endpoint, stop, server) = server("gpt-6-luna", Failure::None, 0, false);
        assert_eq!(invoke(&data, &endpoint, &event), json!({}));
        stop.store(true, Ordering::Relaxed);
        assert!(
            server.join().unwrap().is_empty(),
            "unexpected provider request for {scenario}"
        );
        assert_eq!(health(&data)["api_requests"], 0);
    }
}
