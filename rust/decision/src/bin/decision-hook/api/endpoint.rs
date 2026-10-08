//! Debug overrides must be explicit numeric loopback addresses.
use codex_decision::provider::Provider;

pub(super) fn endpoint(provider: Provider) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        select(provider, std::env::var("CODEX_DECISION_TEST_ENDPOINT"))
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(provider.endpoint().to_owned())
    }
}

#[cfg(debug_assertions)]
fn select(
    provider: Provider,
    entered: Result<String, std::env::VarError>,
) -> Result<String, String> {
    let value = match entered {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return Ok(provider.endpoint().to_owned()),
        Err(_) => return Err("invalid Decision test endpoint".into()),
    };
    let invalid = || "invalid Decision test endpoint".to_owned();
    if value
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
        || value.contains(['#', '\\'])
    {
        return Err(invalid());
    }
    let address = value
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(invalid)?;
    let port = &address[..address.find(['/', '?']).unwrap_or(address.len())];
    if port.is_empty()
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || !port.parse::<u16>().is_ok_and(|port| port != 0)
    {
        return Err(invalid());
    }
    Ok(value)
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;

    #[test]
    fn debug_override_rejects_userinfo_controls_and_invalid_values_without_fallback() {
        for value in [
            "",
            "https://127.0.0.1:443/",
            "http://localhost:80/",
            "http://127.0.0.1:0/",
            "http://127.0.0.1:65536/",
            "http://127.0.0.1:/",
            "http://127.0.0.1:80@service.invalid/",
            "http://127.0.0.1:80\\@service.invalid/",
            "http://127.0.0.1:80/#fragment",
            "http://127.0.0.1:80/\npath",
            "http://127.0.0.1:80/\u{85}path",
            "http://127.0.0.1:80/path with spaces",
            "http://127.0.0.1:80suffix/",
        ] {
            assert_eq!(
                select(Provider::OpenAi, Ok(value.into())).unwrap_err(),
                "invalid Decision test endpoint"
            );
        }
        assert!(select(
            Provider::OpenAi,
            Err(std::env::VarError::NotUnicode(
                "synthetic-invalid-value".into()
            ))
        )
        .is_err());
        assert_eq!(
            select(Provider::OpenAi, Err(std::env::VarError::NotPresent)).unwrap(),
            Provider::OpenAi.endpoint()
        );
        for value in [
            "http://127.0.0.1:1",
            "http://127.0.0.1:65535/",
            "http://127.0.0.1:8042/path?x=1",
        ] {
            assert_eq!(select(Provider::OpenAi, Ok(value.into())).unwrap(), value);
        }
    }
}
