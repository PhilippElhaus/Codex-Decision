//! Resolve credentials only for the selected connection.
use super::*;
use codex_decision::provider::{CustomProvider, Provider};

pub(crate) struct Connection {
    pub(super) protocol: Provider,
    pub(super) endpoint: String,
    pub(super) model: String,
    pub(super) response_model: String,
    pub(super) tls_config: Option<std::sync::Arc<ureq::rustls::ClientConfig>>,
    pub(super) header: Option<(String, String)>,
    pub(super) custom: bool,
}

impl Connection {
    pub(crate) fn protocol(&self) -> Provider {
        self.protocol
    }
    pub(crate) fn load(data_dir: &Path, config: &Config) -> Result<Self, String> {
        if config.provider != Provider::Custom {
            return Self::builtin(
                config.provider,
                &config.model,
                &key(data_dir, config.provider)?,
            );
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
        Self::custom(custom, &api_key, &password)
    }

    pub(super) fn builtin(protocol: Provider, model: &str, key: &str) -> Result<Self, String> {
        Ok(Self {
            protocol,
            endpoint: endpoint::endpoint(protocol)?,
            model: model.into(),
            response_model: String::new(),
            tls_config: None,
            header: Some(("Authorization".into(), format!("Bearer {key}"))),
            custom: false,
        })
    }

    pub(super) fn custom(
        custom: &CustomProvider,
        api_key: &str,
        password: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            protocol: custom.protocol()?,
            endpoint: custom.endpoint.clone(),
            model: custom.model.clone(),
            response_model: custom.response_model.clone(),
            tls_config: custom.tls_config()?,
            header: custom.authorization(api_key, password)?,
            custom: true,
        })
    }

    pub(crate) fn agent(&self) -> ureq::Agent {
        let builder = ureq::AgentBuilder::new().redirects(0);
        match &self.tls_config {
            Some(config) => builder.tls_config(config.clone()).build(),
            None => builder.build(),
        }
    }

    pub(super) fn normalize(&self, request: &Value, response: Value) -> Result<Value, String> {
        if !self.custom {
            return codex_decision::provider::normalize_response(request, response);
        }
        let mut expected = std::borrow::Cow::Borrowed(request);
        if !self.response_model.is_empty() {
            expected.to_mut()["model"] = Value::from(self.response_model.as_str());
        }
        codex_decision::provider::normalize_custom_response(&expected, response, self.protocol)
    }
}
