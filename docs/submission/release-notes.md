# Codex Jev 0.6.0 release notes

The Rust hook now observes supported local PostToolUse results through a wildcard matcher. It routes direct test/build and search/listing commands, their corresponding local tool actions, and other plain-text local results to the three existing exclusive switches. Quoted search patterns, a leading `cd`, environment prefixes, and simple shell wrappers no longer prevent classification. Command objects with an `output` field can be judged in Monitor mode without replacing their metadata.

The default eligibility floor is 256 bytes for newly created settings. Existing selections, policies, keys, and logs remain intact. A missing transcript task permits a preview using a bounded tool-input cue, but never replacement. Structured, mixed-media, mutating, ambiguous shell, and sensitive-looking results remain untouched. The line-level Noul policy and saved-original contract are unchanged.

The companion VS Code control is 0.5.0. Install the plugin and VSIX together, update the version-pinned Codex composer patch, then reload VS Code manually. A new thread picks up the updated hook definition after Codex trust review.
