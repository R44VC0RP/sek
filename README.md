# sek

API keys encrypted by your Mac's Secure Enclave. Reference them from `.env` files as `sek://NAME`, unlock once with Touch ID, and let coding agents use keys without ever seeing them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/sek-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/sek-light.svg">
  <img alt="A safe-deposit bench: the Secure Enclave as a vault block, sealed envelope cards for each secret, a Touch ID reader wired to it, a one-hour time-lock dial, a log tape and a tray holding the opened envelope for the process." src="docs/sek-light.svg">
</picture>

Each secret is sealed into its own envelope with the enclave's public key. Opening one needs the enclave, and the enclave needs your finger: one Touch ID per session, relocked by the timer, screen lock or sleep, with every read logged.

## Install

Requires an Apple silicon Mac (or a Mac with a T2 chip) and Swift 5.9+.

```sh
git clone https://github.com/R44VC0RP/sek && cd sek
swift build -c release
ln -s "$PWD/.build/release/sek" ~/.local/bin/sek   # any directory on your PATH
sek init
```

## Use

```sh
sek set OPENAI_API_KEY          # paste the value (hidden), or pipe it in
sek get OPENAI_API_KEY          # Touch ID, then prints it
sek list                        # names only
sek rm OPENAI_API_KEY
```

Put references in `.env` instead of values. The file is safe to commit:

```sh
OPENAI_API_KEY=sek://OPENAI_API_KEY
DATABASE_URL=sek://prod-db
```

Then run any command with the real values in its environment. One Touch ID covers every secret:

```sh
sek run -e .env -- npm run dev
```

Tools that load `.env` themselves (Next.js, Bun, dotenv) don't overwrite variables that are already set, so they see the real values.

### Sessions

```sh
sek unlock --ttl 4h     # one Touch ID, then no prompts until it locks
sek status
sek lock
```

During a session, `get` and `run` don't prompt. The session ends at the TTL (24h max), when the screen locks or the Mac sleeps, or with `sek lock`. Each read is logged to `~/.sek/agent.log` with the process that asked, for example `get OPENAI_API_KEY by sek ← node`.

## OpenCode plugin

[`opencode/`](opencode) lets agents request keys without the values entering the conversation:

| Tool | What it does |
| --- | --- |
| `sek_list` | Key names, session status, and what this session has been granted |
| `sek_request` | Reads keys (Touch ID, or nothing during a `sek unlock` session) and grants them to the session |
| `sek_revoke` | Stops injecting keys into the session |

Granted keys are set as environment variables in that session's shell commands, so the agent writes `curl -H "Authorization: Bearer $OPENAI_API_KEY" …`. Any copy of a value in tool output, and in anything sent to the model, is replaced with `[sek:NAME]`. Grants last 60 minutes by default.

### Approving requests in the TUI

When an agent calls `sek_request`, the TUI asks before any key is read:

```
Agent wants OPENAI_API_KEY
  Deny
  Allow once               agent says: run the OpenAI eval script
  Allow for this session   Fix eval flakiness · ~/dev/app
```

- **Deny** is preselected, and Escape or closing the dialog also denies. **Allow once** approves this request. **Allow for this session** approves these keys for the rest of the session, so later requests for them skip the dialog.
- After you allow, sek still asks for Touch ID unless a `sek unlock` session is active.
- With several TUIs open, the first answer wins and the other dialogs close.
- With no TUI attached (for example `opencode run`), Touch ID is the only gate. Set `requireApproval: true` to refuse instead.

### Install

Create `.opencode/plugins/sek/` in a project, or `~/.config/opencode/plugins/sek/` for every project, with two files:

```ts
// index.ts
export { default } from "/path/to/sek/opencode/src/index.ts"
```

```ts
// tui.ts
export { default } from "/path/to/sek/opencode/src/tui.ts"
```

Then run `bun install` in `opencode/`. Options (`bin`, `ttlMinutes`, `requireApproval`) can be passed with the `plugins` entry in `opencode.json`.

## How it works

- `sek init` creates a P-256 key inside the Secure Enclave with `.privateKeyUsage` and `.userPresence`. The private key never leaves the chip; `~/.sek/enclave.key` holds only an encrypted handle that works on this Mac alone.
- Each secret is sealed separately: an ephemeral P-256 key agrees a shared secret with the enclave's public key, HKDF-SHA256 derives an AES-256-GCM key, and the secret's name is bound as associated data, so renaming or swapping files fails to decrypt. Sealing needs only the public key and never prompts.
- `sek unlock` starts a background agent that authenticates once and serves reads over a `0600` Unix socket to processes running as you.

## Limits

- **Same-user trust.** Like `ssh-agent`, an unlocked session serves any process running as your user, and a secret handed to a program's environment can be read by other processes of yours. sek protects secrets at rest and makes you approve access; it doesn't sandbox your own processes.
- **Device-bound.** Keys can't be exported or backed up. A wiped or new Mac can't open old secrets, so keep originals in a password manager.
- **Plugin redaction is best effort.** It catches exact copies of a value. Encoded or transformed copies are not caught: base64 (`Authorization: Basic`), URL or JSON escaping, hex, slices like `${KEY:0:8}`, values split across lines or cut by output truncation. Full shell output saved to disk for long commands contains the raw value. An agent with a key can also send it anywhere (`curl -d "$KEY" …`); the tool description asks it not to, but nothing enforces that. Treat redaction as a guard against accidents, not against a hostile agent.
- **The approval dialog is consent, not a sandbox.** Anything running as you, including an agent's shell, can call OpenCode's API and answer the dialog itself, or run `sek get` directly. Against a hostile agent, the control is Touch ID: avoid `sek unlock` while such an agent is running.
- **Grants are per OpenCode session.** Subagents and your own `!` shell commands don't receive them.
- Touch ID doesn't work over SSH.

## License

MIT. The figure in `docs/` is built with the [anatomy](docs/figure) kit (MIT, see `docs/figure/LICENSE-kit`).
