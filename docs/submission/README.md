# Public Plugins Directory submission

Prepare a **Skills only** ZIP for the [OpenAI submission portal](https://platform.openai.com/plugins). This package contains one Jev setup and evidence-review skill plus the Codex local hook. It has no MCP server or custom MCP UI. The optional VS Code extension and version-pinned composer patch remain separate downloads. A directory listing does not make local hooks run on a hosted web surface; Codex must have the scripts available, and the user must trust the hook definition.

Build the upload from this checkout:

```bash
python3 scripts/build_submission.py
```

The command writes the ZIP under the ignored `.local/submission/` directory and reports its SHA-256. It uses an explicit file list; private plugin data, credentials, benchmarks, VSIX files, test outputs, and files outside that list do not enter the archive. Upload the ZIP through **Create plugin → Skills only**. The portal may normalize the compatibility manifest; compare its displayed metadata with the fields below before continuing. The upload must pass OpenAI's scan before submission.

## Portal fields

| Field | Prepared value |
| --- | --- |
| Package name | `codex-jev` |
| Version | `0.3.3` |
| Plugin name | Codex Jev |
| Short description | Trim repetitive tool output |
| Category | Developer Tools |
| Developer identity | Philipp Elhaus, individual; select the matching verified Platform identity |
| Website | `https://github.com/PhilippElhaus/Codex-Jev` |
| Support | `https://github.com/PhilippElhaus/Codex-Jev/issues` |
| Availability | All eligible regions, subject to the publisher's final review |
| Logo | `assets/logo.png` from the archive |
| Starter prompts | The two prompts below |

**Long description:** Codex Jev adds three optional local PostToolUse filters for repetitive command output, routine test/build logs, and broad search or file listings. It sends bounded portions of eligible results to TypeSafe AI's Jev API for decisions. Uncertain results remain intact, and every shortened result points to an exact local original. Filters start disabled and require a TypeSafe API key and trust in the bundled hook. The included skill helps configure Jev and verify shortened evidence. The optional VS Code control and version-pinned composer patch are installed separately from the plugin package. Local hook execution is unavailable on surfaces without its scripts and runtime.

**Starter prompts:**

1. Help me set up Codex Jev for test logs.
2. Check whether this Jev-shortened result kept the evidence I need.

The ZIP path allows website, privacy-policy, terms, and support URLs to be optional. The repository's [data-handling guide](../architecture/design_data.md) explains the external Jev request and local storage. It is technical documentation, not a formal privacy policy. Do not label it as one. The publisher must review any optional legal URLs before adding them.

Use the five positive and three negative [review cases](test-cases.md). Use the [release notes](release-notes.md) for the Submit tab. The public hook workflow needs a TypeSafe AI API key supplied by each user. No key is in the archive. If reviewers require a demo key, the publisher must provide a dedicated credential privately through the portal; do not place it in Git, the ZIP, a prompt, or a public test case.

The publisher must confirm Platform **Apps Management: Write**, verified identity, region coverage, and policy attestations. Submit for review only after the portal scan and listing preview match this package. OpenAI review and a separate publisher action are required before the listing appears in the public directory. See the [submission guide](https://developers.openai.com/plugins/deploy/submission) and [submission errors](https://developers.openai.com/plugins/deploy/submission-errors).
