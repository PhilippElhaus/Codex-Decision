# Custom connections and raw skipped output

Version 0.14.0 adds custom decision endpoints and local inspection of skipped tool calls.

## Connection forms

Connect Decision and Decision settings now use the same connection fields. Built-in OpenAI and TypeSafe connections retain their saved keys. A custom connection specifies a display name, JSON schema, complete endpoint URL, model ID, and authentication method. The forms show only the fields required by the selected method. Both forms can test a draft before saving it. A failed draft test leaves the installed connection intact.

Custom endpoints support the OpenAI Decisions or TypeSafe Jev request and response schema. Schema selection is independent of the model ID. Authentication supports a bearer key, Basic username and password, a named API-key header, or none. HTTPS is required except for numeric loopback HTTP endpoints. URLs cannot contain user information, a query, or a fragment. Redirects are disabled.

Settings contain connection metadata. Secrets remain in the private `.env`. Reads return only saved-secret status. A SHA-256 identity binds saved custom credentials to the endpoint, authentication method, username, and header name. Changing that identity requires fresh credentials. A custom connection never uses automatic provider fallback. Existing built-in fallback remains opt-in.

The hook uses the existing classification and relevance logic with the selected wire schema. It verifies the actual custom model before normalizing typed answers for existing checks. Receipts record the actual provider, schema, and model. Request bounds, deadlines, protected lines, and full-output failure behavior remain in force. The effectiveness audit recognizes custom providers without exporting their connection metadata or tool text.

## Raw skip inspector

The thread panel includes **Show raw skipped outputs** beside the request and skip counts. It enables capture for future skips in that thread. Each entry shows the time, tool, skip reason, tool input, and original response. Old skips do not acquire invented payloads. The checkbox does not change filtering or send the captured data to a provider.

Capture uses separate private session files and retains at most 20 entries within 4 MiB. An encoded payload over 512 KiB produces an explicit unavailable record. JSON strings preserve large integer tokens through the JavaScript renderer. Raw data uses text nodes, so HTML inside a tool result stays inert. Disabling capture hides the inspector and stops new capture; an in-flight capture can finish. Existing records remain bounded. A stale checkbox event cannot enable capture in a newly selected thread.

Captured data can include sensitive content that local provider guards rejected. It stays in the selected thread's private storage. Ordinary activity records still contain no raw payload. Capture failures do not change the original response or ordinary skip accounting.

## Verification

The regression suite covers both schemas and all authentication methods through the real hook process. It checks credential identity changes, strict response validation, exact originals on failure, private storage, bounded raw capture, thread changes, and safe rendering. Host-bridge regressions carry custom fields and passwords through the actual patch fragment to the extension. Browser fixtures use synthetic data and no real credentials or chats.

Final source validation passed 298 Rust tests, formatting, Clippy, 180 Node tests with three expected platform skips, 16 Python checks, native Edge smoke tests, and 16 Chromium reports. Both production archives passed exact-content, source-byte, version, and Linux ELF checks. A production-binary smoke check preserved the original response and captured exact synthetic input and output, including a large integer, without an API request.
