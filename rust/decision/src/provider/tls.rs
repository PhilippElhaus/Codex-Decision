//! Parse bounded public certificates for one user-managed connection.
use std::sync::Arc;
use ureq::rustls::pki_types::{pem::PemObject, CertificateDer};
use ureq::rustls::{ClientConfig, RootCertStore};

pub(super) fn config(pem: &str) -> Result<Option<Arc<ClientConfig>>, String> {
    if pem.is_empty() {
        return Ok(None);
    }
    let invalid = || "invalid custom provider CA certificate".to_owned();
    if pem.len() > 16_384
        || pem
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || b"+/=- \t\r\n".contains(&byte)))
    {
        return Err(invalid());
    }
    let mut roots = RootCertStore::empty();
    let mut remaining = pem.trim();
    while !remaining.is_empty() {
        if !remaining.starts_with("-----BEGIN CERTIFICATE-----") {
            return Err(invalid());
        }
        let end = remaining
            .find("-----END CERTIFICATE-----")
            .ok_or_else(invalid)?
            + "-----END CERTIFICATE-----".len();
        let (section, rest) = remaining.split_at(end);
        let certificate =
            CertificateDer::from_pem_slice(section.as_bytes()).map_err(|_| invalid())?;
        roots.add(certificate).map_err(|_| invalid())?;
        remaining = rest.trim();
    }
    if roots.is_empty() {
        return Err(invalid());
    }
    Ok(Some(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )))
}
