//! Explicit protocol and credential boundaries for user-managed endpoints.
use super::Provider;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CustomProvider {
    pub name: String,
    pub protocol: String,
    pub endpoint: String,
    pub model: String,
    pub auth: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub header_name: String,
}

pub fn valid_custom_model(model: &str) -> bool {
    (1..=128).contains(&model.len()) && model.bytes().all(|byte| byte.is_ascii_graphic())
}

impl CustomProvider {
    pub fn protocol(&self) -> Result<Provider, String> {
        match self.protocol.as_str() {
            "openai" => Ok(Provider::OpenAi),
            "jev" => Ok(Provider::TypeSafe),
            _ => Err("invalid custom provider protocol".into()),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        self.protocol()?;
        if self.name.trim().is_empty()
            || self.name.len() > 80
            || self.name.chars().any(char::is_control)
            || !valid_custom_model(&self.model)
        {
            return Err("invalid custom provider name or model".into());
        }
        validate_endpoint(&self.endpoint)?;
        if self.username.len() > 256
            || self.username.chars().any(char::is_control)
            || self.username.contains(':')
        {
            return Err("invalid custom provider username".into());
        }
        if self.header_name.len() > 128 {
            return Err("invalid custom provider authentication".into());
        }
        match self.auth.as_str() {
            "none" | "bearer" => {}
            "basic" if !self.username.is_empty() => {}
            "header" if valid_header(&self.header_name) => {}
            _ => return Err("invalid custom provider authentication".into()),
        }
        Ok(())
    }

    /// Bind persisted secrets to their intended endpoint and authentication.
    pub fn credential_identity(&self) -> String {
        let identity =
            serde_json::json!([self.endpoint, self.auth, self.username, self.header_name]);
        format!("{:x}", Sha256::digest(identity.to_string().as_bytes()))
    }

    pub fn authorization(
        &self,
        key: &str,
        password: &str,
    ) -> Result<Option<(String, String)>, String> {
        self.validate()?;
        let safe_header_value = |value: &str| {
            (1..=4096).contains(&value.len())
                && value.bytes().all(|byte| (32..=126).contains(&byte))
        };
        match self.auth.as_str() {
            "none" => Ok(None),
            "bearer" if safe_header_value(key) => {
                Ok(Some(("Authorization".into(), format!("Bearer {key}"))))
            }
            "header" if safe_header_value(key) => Ok(Some((self.header_name.clone(), key.into()))),
            "basic"
                if (1..=4096).contains(&password.len())
                    && !password.chars().any(char::is_control) =>
            {
                let encoded = base64(format!("{}:{password}", self.username).as_bytes());
                Ok(Some(("Authorization".into(), format!("Basic {encoded}"))))
            }
            _ => Err("invalid custom credential".into()),
        }
    }
}

fn valid_header(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        && ![
            "authorization",
            "proxy-authorization",
            "host",
            "content-type",
            "content-length",
            "connection",
            "transfer-encoding",
            "accept-encoding",
            "cookie",
            "set-cookie",
            "te",
            "trailer",
            "upgrade",
            "expect",
            "user-agent",
        ]
        .contains(&name.to_ascii_lowercase().as_str())
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let invalid = || "invalid custom provider endpoint".to_owned();
    if endpoint.len() > 2048
        || endpoint
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
        || endpoint.contains(['\\', '?', '#'])
    {
        return Err(invalid());
    }
    let parsed = ureq::get(endpoint).request_url().map_err(|_| invalid())?;
    let url = parsed.as_url();
    let authority = endpoint
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""));
    if authority.is_some_and(|authority| authority.contains('@'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return Err(invalid());
    }
    let loopback = authority.is_some_and(|authority| {
        ["127.0.0.1", "[::1]"].iter().any(|host| {
            authority == *host
                || authority
                    .strip_prefix(host)
                    .and_then(|rest| rest.strip_prefix(':'))
                    .is_some_and(|port| {
                        !port.is_empty()
                            && port.bytes().all(|byte| byte.is_ascii_digit())
                            && port.parse::<u16>().is_ok_and(|port| port != 0)
                    })
        })
    });
    if !(endpoint.starts_with("https://") && url.scheme() == "https"
        || loopback
            && endpoint.starts_with("http://")
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1")))
    {
        return Err(invalid());
    }
    Ok(())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(TABLE[(word >> 18) as usize] as char);
        encoded.push(TABLE[((word >> 12) & 63) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[((word >> 6) & 63) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(word & 63) as usize] as char
        } else {
            '='
        });
    }
    encoded
}
