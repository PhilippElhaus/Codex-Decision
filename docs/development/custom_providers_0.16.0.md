# Custom provider aliases and private HTTPS

Version 0.16.0 adds two optional fields to custom connections:

- `response_model` sets the exact model ID that the service must return. The
  request continues to use the configured `model` value.
- `ca_certificate` stores public PEM certificates for a private HTTPS service.
  Certificate trust applies only to that connection.

See [provider setup](../setup/setup_credentials.md#model-aliases-and-private-https)
for an example with synthetic endpoint and model names.

## Behavior

An empty response model requires the service to return the request model.
An explicit response model supports services that resolve request aliases.
Successful custom receipts record the validated response model and preserve
the request alias as the configured model.

An empty CA field keeps normal public certificate trust. A supplied certificate
replaces trust roots for the custom connection. Server certificate and hostname
verification remain enabled. Redirects remain disabled. The field accepts only
public certificate blocks, up to 16 KiB, and requires an HTTPS endpoint.

Changing the CA invalidates saved custom credentials. Existing credential
identities remain unchanged when the CA field is empty. Both connection forms
save the optional fields. Embedded PEM text works across Windows and WSL
without a runtime-specific file path.

Public examples use synthetic endpoint and model names. Package verification
rejects embedded internal deployment URLs in release text. This check does not
restrict the endpoint that a user enters in provider settings.

Both existing decision schemas remain supported. A standard chat-completions
endpoint still needs an adapter for the selected decision schema. Custom
connections do not use automatic fallback. Model, TLS, and answer-validation
failures keep the complete output.

## Verification

The source checks passed 313 Rust tests, with one ignored, and Clippy with
warnings denied. Node passed 244 tests, with four skipped. The six focused
custom TLS tests also passed under native Windows Node. Python passed 18 tests.
Chromium passed 16 harness reports, including the connection forms at widths
360, 720, 1200, and 2800.

The regressions cover both decision schemas, exact response-model matching,
unchanged default behavior, credential identity changes, malformed certificate
data, private-key rejection, unknown certificate roots, hostname mismatches,
redirect rejection, bounded responses, cancellation, and deadlines.

Production-hook checks on native Windows and Linux verified successful custom
evaluation, retained diagnostics and completion evidence, and exact saved
originals. Incorrect response models and untrusted certificates kept the full
output and published no replacement receipt.

Package verification checked the source allowlist and both native runtimes.
The native background installation check passed with Codex `26.1021.22027` in
isolated state. It covered repeated and concurrent installation, hook execution
under PowerShell 7 and 5.1, panel records, and exact restoration of copied host
assets. It opened no editor windows.

These checks establish compatibility for the reviewed cases. They do not
establish model quality for future user output. The checks used isolated data
and preserved installed connections, credentials, certificate stores, and chats.
