# Synthetic custom-provider TLS certificates

The `custom-provider-server-key.pem` key is public test data. It has no service
identity or deployment use. Use it only with the adjacent synthetic server
certificates in isolated loopback tests.

`custom-provider-server.pem` covers `127.0.0.1`.
`custom-provider-wrong-name.pem` covers `wrong.example.invalid`.
Both certificates are self-signed so tests can explicitly select a trust root.
`custom-provider-ca.pem` is a separate synthetic CA for unknown-root checks.

These fixtures contain no production credentials or LAN certificate material.
