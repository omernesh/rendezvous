# Security policy

Rendezvous is **alpha software**. The protocol and wire format may still change, and the project has **not been independently security-audited**. Don't rely on it for anything sensitive yet.

## Supported versions

Only `main` (the latest commit) is supported. There are no maintained release branches; fixes land on `main`.

## Reporting a vulnerability

Please report privately, not in a public issue or discussion.

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting): https://github.com/omernesh/rendezvous/security/advisories/new

Include, as far as you can:

- what is affected (spec section, package, plugin, installer) and the commit you tested
- steps or a minimal script that reproduces it
- the impact you expect (for example consent bypass, content readable by a relay, injection through peer text)
- any suggested fix

Response is best effort: expect an acknowledgement within 7 days. Please allow time for a fix before disclosing publicly; we will credit you in the advisory if you wish.

## Scope

In scope:

- the protocol specification (`SPEC.md`)
- the reference implementation in `impl/` (core, a2a, CLI, MCP server)
- the Claude Code plugin in `plugins/`
- the installer scripts (`site/install.sh`, `site/install.ps1`)

Out of scope:

- third-party public relays (what they log or drop is up to their operators; the protocol assumes relays are untrusted)
- vulnerabilities in dependencies with no impact on Rendezvous (report those upstream)

## Known limitations

- The consent guard hook in the plugin is best-effort against obfuscated shell commands. The real boundary is the MCP consent gate plus the signed owner files, not the hook. Tracked in [issue #51](https://github.com/omernesh/rendezvous/issues/51).
- A model with a shell running as your own OS user can go around local checks; the hard boundary is running the assistant as a different OS user.
- First-contact discovery probes are cleartext on a discovery topic.
- Key recovery is not available, and signed key rotation is specified but not implemented.
