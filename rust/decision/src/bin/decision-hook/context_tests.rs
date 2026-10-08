use super::*;

#[test]
fn credential_prefixes_do_not_match_ordinary_identifier_suffixes() {
    for text in [
        "INFO task-state refreshed",
        "INFO disk-cache hit",
        "INFO risk-check completed",
        "INFO ask-service responded",
        "INFO example_ghp_count=12",
        "process.env.RETRY_COUNT=3",
        "const settings = process.env;",
        "process.env['OPENAI_API_KEY']",
        "settings.environment=development",
    ] {
        assert!(!sensitive(text), "{text}");
        assert!(
            !sensitive_input(&json!({"tool_input":{"cmd":text}})),
            "serialized input: {text}"
        );
    }
}

#[test]
fn credential_and_environment_file_markers_stay_guarded() {
    for text in [
        "sk-synthetic-sentinel",
        "value: sk-synthetic-sentinel",
        "Bearer sk-synthetic-sentinel",
        r#"{"value":"ghp_synthetic_sentinel"}"#,
        "ghp_synthetic_sentinel",
        "cat .env",
        "cat .env.local",
        "cat /home/example/.env.production",
        r#"type C:\example\.env"#,
        "cat .envrc",
        "cat .env_vars",
        "cat .envproduction",
        "cat .environment",
        "cat config.env",
        "cat process.env",
        "cat process.env.local",
        "cat /home/example/process.env",
        r#"type C:\example\process.env"#,
        "password: synthetic-sentinel",
        "PASSWORD   = synthetic-sentinel",
        r#"{"password":"synthetic-sentinel"}"#,
        r#"{"api_key" : "synthetic-sentinel"}"#,
        r#"{"token":"synthetic-sentinel"}"#,
        "<password>synthetic-sentinel</password>",
        "Authorization : Basic synthetic-sentinel",
        "api key setup",
        "private key setup",
        "-----BEGIN PRIVATE KEY-----",
    ] {
        assert!(sensitive(text), "{text}");
        assert!(
            sensitive_input(&json!({"tool_input":{"cmd":text}})),
            "serialized input: {text}"
        );
    }
}

#[test]
fn environment_path_fields_keep_file_guards_even_for_identifier_spellings() {
    for field in ["path", "file_path", "filePath", "cwd", "workdir"] {
        for path in [
            ".env",
            ".env.local",
            ".env_vars",
            ".envproduction",
            ".environment",
            "process.env",
            "process.env.local",
            "settings.environment",
        ] {
            assert!(
                sensitive_input(&json!({"tool_input":{field:path}})),
                "{field}: {path}"
            );
        }
    }
    assert!(sensitive_input(
        &json!({"tool_input":{"paths":["safe.txt","process.env.local"]}})
    ));
    assert!(sensitive_input(
        &json!({"tool_input":{"path":{"value":"process.env.local"}}})
    ));
    assert!(sensitive_input(
        &json!({"tool_input":{"paths":[{"value":"settings.environment"}]}})
    ));
    assert!(!sensitive_input(
        &json!({"tool_input":{"cmd":"const env = process.env; settings.environment=development"}})
    ));
    assert!(!sensitive_input(
        &json!({"tool_input":{"cmd":"process.env['RETRY_COUNT']"}})
    ));
}

#[test]
fn identifier_reference_does_not_override_a_credential_value() {
    for text in [
        "process.env.password = synthetic-sentinel",
        "process.env.OPENAI_API_KEY=synthetic-sentinel",
        "process.env.CLIENT_SECRET=synthetic-sentinel",
        "process.env.TOKEN: synthetic-sentinel",
    ] {
        assert!(sensitive(text), "{text}");
    }
}
