use super::*;

#[test]
fn builtin_credentials_match_the_control_for_bom_quotes_spacing_and_duplicates() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/builtin-credentials.json"
    ))
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    for provider in [
        codex_decision::provider::Provider::OpenAi,
        codex_decision::provider::Provider::TypeSafe,
    ] {
        for fixture in fixtures.as_array().unwrap() {
            let source = fixture["env"]
                .as_str()
                .unwrap()
                .replace("OPENAI_API_KEY", provider.key_name());
            write_private(&directory.path().join(".env"), source.as_bytes(), true).unwrap();
            let result = key(directory.path(), provider);
            if let Some(expected) = fixture["key"].as_str() {
                assert_eq!(result.unwrap(), expected);
            } else {
                assert!(result.is_err());
            }
        }
    }
}

#[test]
fn custom_password_whitespace_is_preserved() {
    let directory = tempfile::tempdir().unwrap();
    write_private(
        &directory.path().join(".env"),
        b"CUSTOM_PASSWORD= leading and trailing \n",
        true,
    )
    .unwrap();
    assert_eq!(
        credential_value(directory.path(), "CUSTOM_PASSWORD").unwrap(),
        " leading and trailing "
    );
}
