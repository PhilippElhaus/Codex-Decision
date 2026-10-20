//! Resolve credentials only for the selected connection.
use super::*;
use codex_decision::provider::Provider;

pub(crate) struct Connection {
    pub(super) protocol: Provider,
    pub(super) endpoint: String,
    pub(super) model: String,
    pub(super) header: Option<(String, String)>,
    pub(super) custom: bool,
}

impl Connection {
    pub(crate) fn load(data_dir: &Path, config: &Config) -> Result<Self, String> {
        if config.provider != Provider::Custom {
            return Ok(Self {
                protocol: config.provider,
                endpoint: endpoint::endpoint(config.provider)?,
                model: config.model.clone(),
                header: Some((
                    "Authorization".into(),
                    format!("Bearer {}", key(data_dir, config.provider)?),
                )),
                custom: false,
            });
        }
        let custom = config
            .custom_provider
            .as_ref()
            .ok_or("missing custom provider")?;
        custom.validate()?;
        if config.fallback_enabled {
            return Err("custom providers do not support automatic fallback".into());
        }
        let mut api_key = String::new();
        let mut password = String::new();
        if custom.auth != "none" {
            let secret_name = if custom.auth == "basic" {
                "CUSTOM_PASSWORD"
            } else {
                "CUSTOM_API_KEY"
            };
            // Read identity and secret from one private-file snapshot. Separate
            // reads could cross an atomic configuration update from another window.
            let credentials =
                credential_values(data_dir, &["CUSTOM_CREDENTIAL_IDENTITY", secret_name])?;
            if credentials[0] != custom.credential_identity() {
                return Err("custom credential does not match this connection".into());
            }
            if custom.auth == "basic" {
                password = credentials[1].clone();
            } else {
                api_key = credentials[1].clone();
            }
        }
        Ok(Self {
            protocol: custom.protocol()?,
            endpoint: custom.endpoint.clone(),
            model: custom.model.clone(),
            header: custom.authorization(&api_key, &password)?,
            custom: true,
        })
    }
}
