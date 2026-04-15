# ksefctl

CLI background service for KSeF API 2.0 inbox synchronization (macOS + Linux). No GUI. No Windows.

## What it does

- Authenticates to KSeF API 2.0 (KSeF token).
- Incrementally downloads incoming invoices using export packages and HWM.
- Stores invoices idempotently with a local SQLite state DB (sql.js).
- Sends macOS Notification Center alerts and optional SMTP email summaries.
- Runs once or continuously (`sync --watch`); provides launchd and systemd installers.

## Features

- Cross-platform CLI (macOS + Linux)
- Incremental sync with HWM + deduplication
- Idempotent storage + SQLite state
- Optional PDF visualization output (default on)
- Notifications (macOS + SMTP)
- launchd/systemd installers

## Prerequisites

- Node.js >= 22 (nvm recommended)
- macOS or Linux (x64/arm64)
- For keychain storage on Linux: libsecret (keytar backend)

## Source-of-truth docs used

- OpenAPI contract: `open-api.json` from https://github.com/CIRFMF/ksef-docs
- Auth: `uwierzytelnianie.md`
- Token management: `tokeny-ksef.md`
- Invoice download: `pobieranie-faktur/pobieranie-faktur.md`
- Incremental download: `pobieranie-faktur/przyrostowe-pobieranie-faktur.md`
- Environments: `srodowiska.md`
- Rate limits: `limity/limity.md`

## Install

```bash
npm ci
npm run build
npm link
```

`npm ci` runs the repo `postinstall` hook, which prepares the pinned `@akmf/ksef-fe-invoice-converter` dependency for local use.

Or global:

```bash
npm install -g .
```

Node requirement: `>= 22`.

## Quick start

```bash
ksefctl system init
ksefctl system verify
ksefctl sync
```

`system init` is interactive and stores tokens in keychain.

### Bootstrap (interactive)

1. Run `ksefctl system init` and select the environment.
2. Enter NIP(s) and tokens as prompted.
3. Use `ksefctl system verify` to validate credentials.

The environment prompt shows full names with the API URLs for clarity.

## Commands

- `ksefctl sync [-n <nip>] [--redownload-all] [--flat-sync] [--output-path <path>] [--json]` – run sync.
- `ksefctl sync -n <nip> --redownload <ksefNumber>` – re-download a single invoice (`-n`/`--nip` is required with `--redownload`).
- `ksefctl sync --watch` – run continuously in foreground.
- `ksefctl status [--json]` – show last sync status.
- `ksefctl system init [--force] [--yes]` – create config template and storage directories.
- `ksefctl system verify [-n <nip>]` – validate authentication against the configured environment.
- `ksefctl system service install` – install + enable launchd/systemd.
- `ksefctl system service uninstall` – remove launchd/systemd.
- `ksefctl system config` – show sanitized config.
- `ksefctl system secret set [-n <nip>] [--token-stdin]` – store KSeF token in keychain.
- `ksefctl system secret show` – show which NIPs have keychain secrets.
- `ksefctl system secret clear -n <nip>` – remove keychain secret for a NIP.
- `ksefctl system completion <bash|zsh|fish>` – generate shell completion script.
- `ksefctl system pin <host> [-p <port>]` – print the SPKI SHA-256 TLS pin for a host (ready to paste into `security.tls.pins`).

Global options:

- `-c, --config <path>` – override config path.
- `-v, --verbose` – enable detailed logs.
- `-V, --version` – print the application version and latest short commit.

All commands except `system init` require a config file and keychain tokens for each configured NIP.

### system init

- Requires an interactive terminal for the full bootstrap (NIP entry, token prompts).
- Without a TTY (CI/pipe): writes the config template and creates storage directories, then exits with a hint to run interactively.
- `--force` removes the config file and keychain tokens for all NIPs and re-runs bootstrap. Use `--yes` to skip the confirmation prompt.

### system verify

Performs the authentication flow only — does not download invoices.

### sync

Progress messages go to stderr; use `-v`/`--verbose` for detailed logs. If an invoice directory is missing on disk, sync re-downloads it even if the DB marks it as already downloaded.

| Flag | Description |
|---|---|
| `--redownload <ksefNumber>` | Re-download a single invoice. Requires `-n`/`--nip`. |
| `--redownload-all` | Reset cursors to `sync.initialSyncFrom` (or `2026-02-01`) and re-download all invoices. Mutually exclusive with `--redownload`. |
| `--flat-sync` | Store invoices in monthly folders (`invoices/<NIP>/YYYY/MM/`) using `Seller - InvoiceNumber` filenames. Colliding filenames get ` - <ksefNumber>` appended. |
| `--output-path <path>` | Override the invoice output root for this run. Requires `-n`/`--nip` when multiple orgs are configured. |
| `--watch` | Run continuously, polling every `pollingIntervalSeconds` (default: 300 s). Cannot be combined with `--redownload` or `--redownload-all`. |
| `--json` | Output results as JSON instead of formatted text. |

Config equivalents:

- `sync.flatSync: true` enables flat sync by default.
- `organizations[].outputPath` sets a custom invoice output root per NIP.
- CLI options take precedence over config for the current run.

If you see a Node warning about `--localstorage-file`, make sure you run the `ksefctl` binary (not `node dist/cli.js`) so the wrapper can sanitize `NODE_OPTIONS`.

Exit codes:

- `0` success
- `2` auth failure
- `3` network failure
- `4` config invalid
- `5` unknown fatal

## Usage examples

Run a single sync cycle:

```bash
ksefctl sync
```

Set a KSeF token for a NIP (interactive — prompts for NIP and token):

```bash
ksefctl system secret set
```

Non-interactive (CI/scripts) — requires both `--nip` and `--token-stdin`:

```bash
cat token.txt | ksefctl system secret set --nip 1234567890 --token-stdin
```

Without `--token-stdin`, running in a non-TTY will produce an error. Without `--nip`, the command cannot determine which NIP to store the token for in non-interactive mode.

Sync a single NIP:

```bash
ksefctl sync --nip 1234567890
```

Re-download a specific invoice by KSeF number (`--nip` is required):

```bash
ksefctl sync --nip 1234567890 --redownload 1234567890-20260101-ABC123
```

Run a sync cycle with flat monthly storage:

```bash
ksefctl sync --flat-sync
```

Run a sync cycle for one NIP with a custom output root:

```bash
ksefctl sync --nip 1234567890 --output-path ~/Exports/org-a --flat-sync
```

Configure flat sync and a per-NIP output root:

```yaml
storage:
  root: /var/lib/ksefctl

organizations:
  - nip: "1234567890"
    label: "Org A"
    outputPath: /path/to/custom-output/org-a
  - nip: "9876543210"
    label: "Org B"
    outputPath: /path/to/custom-output/org-b

sync:
  flatSync: true
```

Example: keep the default storage root for one organization and override another:

```yaml
storage:
  root: /var/lib/ksefctl

organizations:
  - nip: "1234567890"
    label: "Default root"
  - nip: "9876543210"
    label: "Separate export root"
    outputPath: /srv/ksef/org-b

sync:
  flatSync: true
```

In that setup:

- NIP `1234567890` writes to `/var/lib/ksefctl/invoices/1234567890/...`
- NIP `9876543210` writes to `/srv/ksef/org-b/...`
- `ksefctl sync --nip 9876543210 --output-path ~/Exports/manual-run` overrides the config path just for that run

Run continuously in foreground:

```bash
ksefctl sync --watch
```

Enable SMTP notifications:

```yaml
notifications:
  email:
    enabled: true
    smtp:
      host: smtp.example.com
      port: 587
      user: user@example.com
      pass: ${SMTP_PASS}
      from: ksefctl@example.com
    to:
      - you@example.com
```

## Shell completion

On first run (when the ksefctl data directory does not exist), and only when running `ksefctl` with no subcommand in an interactive TTY, ksefctl will offer to install completion for the detected shell and prompt to bootstrap initialization. Running `ksefctl --help` or any subcommand skips the prompt. You can disable the no-args prompt with `--no-first-run` or `KSEFCTL_NO_FIRST_RUN=1`.

Bash (current session):

```bash
source <(ksefctl system completion bash)
```

Zsh:

```bash
mkdir -p ~/.zfunc
ksefctl system completion zsh > ~/.zfunc/_ksefctl
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

Fish:

```bash
mkdir -p ~/.config/fish/completions
ksefctl system completion fish > ~/.config/fish/completions/ksefctl.fish
```

Auto-install details (first run):

- Bash:
  - macOS: writes `~/.ksefctl/completions/ksefctl.bash` and adds a block to `~/.bashrc` (or existing `~/.bash_profile`/`~/.profile`)
  - Linux: writes `${XDG_DATA_HOME:-~/.local/share}/ksefctl/completions/ksefctl.bash` and adds a block to `~/.bashrc` (or existing `~/.bash_profile`/`~/.profile`)
- Zsh:
  - macOS: writes `~/.ksefctl/completions/_ksefctl` and adds a block to `~/.zshrc`
  - Linux: writes `${XDG_DATA_HOME:-~/.local/share}/ksefctl/completions/_ksefctl` and adds a block to `~/.zshrc`
- Fish:
  - writes `${XDG_CONFIG_HOME:-~/.config}/fish/completions/ksefctl.fish`

Auto-install is skipped when running as root or when rc files are symlinked (you'll get a message explaining why; use `ksefctl system completion <shell>` for manual setup).

If completion is installed, ksefctl prints a short "activate now" command (for example, `source ~/.zshrc`).

## Configuration

Default config paths:

- Linux: `${XDG_CONFIG_HOME:-~/.config}/ksefctl/config.yaml`
- macOS: `~/.ksefctl/config.yaml`

Override config path (highest precedence first):

1. CLI `--config <path>`
2. `KSEFCTL_CONFIG` environment variable
3. Platform default path (see above)

Default storage path:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/ksefctl`
- macOS: `~/.ksefctl`

Key config fields:

- `environment`: `test | prod`
- `apiBaseUrl`: optional override for local testing or proxies
- `auth.method`: `ksefToken` (token-only)
- `auth.keychainServiceName`: optional override for keychain service name
- `organizations`: list of NIPs to sync
- `pollingIntervalSeconds`
- `storage.root`
- `notifications` (macos + email)
- `logging` (level, file, pretty)
- `operational` (retry, timeouts, poll, exportCooldownSeconds, allowInsecureHttp)
- `security.tls` (pinning)
- `security.allowedHosts`: allowed hosts for package downloads (schema default: `[]`; if empty at runtime the API host is allowed automatically)
- `sync` (subject types, HWM, generatePdf, initialSyncFrom)

Minimal config example: `docs/minimal-config.yaml`

Run `ksefctl system config` after `system init` to see the resolved configuration.

### Config defaults

| Field | Default |
|---|---|
| `environment` | `prod` |
| `pollingIntervalSeconds` | `300` (5 min) |
| `notifications.macosNotification` | `true` |
| `notifications.email.enabled` | `false` |
| `logging.level` | `info` |
| `logging.pretty` | `false` |
| `operational.maxConcurrency` | `2` |
| `operational.timeoutSeconds` | `60` |
| `operational.pollIntervalSeconds` | `10` |
| `operational.authPollMaxAttempts` | `60` |
| `operational.exportPollMaxAttempts` | `120` |
| `operational.exportCooldownSeconds` | `2` |
| `operational.allowInsecureHttp` | `false` |
| `operational.retry.maxAttempts` | `5` |
| `operational.retry.baseDelayMs` | `500` |
| `operational.retry.maxDelayMs` | `10000` |
| `operational.retry.jitter` | `0.2` |
| `sync.subjectTypes` | all four subject types |
| `sync.includeMetadataHeader` | `true` |
| `sync.generatePdf` | `true` |
| `sync.flatSync` | `false` |
| `sync.maxConcurrentNips` | `1` |
| `security.tls.enablePinning` | `false` |
| `security.allowedHosts` | `[]` (API host allowed by default) |

Use `ksefctl system secret set` to store a token in keychain; add the NIP to `organizations` in config.

Each NIP in `organizations` is synced every cycle (use `--nip` for ad-hoc runs).

### Environments

- Production (https://api.ksef.mf.gov.pl/v2)
- Test (https://api-test.ksef.mf.gov.pl/v2)

Tokens are environment-scoped. Store a token for each environment you use.
`apiBaseUrl` is for local testing or proxies; it is normalized to include `/v2` and must not point to `/docs`.

### Auth: KSeF token

Flow per docs (`uwierzytelnianie.md`):

1. `POST /auth/challenge`
2. Encrypt `token|timestampMs` using KSeF public key (`/security/public-key-certificates`, RSA-OAEP SHA-256).
3. `POST /auth/ksef-token`
4. Poll `GET /auth/{referenceNumber}` until success.
5. `POST /auth/token/redeem`
6. Refresh via `POST /auth/token/refresh` when needed.

The `contextIdentifier` is always `Nip` and comes from the configured `organizations` list.

### How to obtain a KSeF token

Token generation is described in `tokeny-ksef.md` and requires a one-time XAdES authentication outside this CLI.

### Environment variables

| Variable | Effect |
|---|---|
| `KSEFCTL_CONFIG` | Override config file path (lower precedence than `--config`) |
| `KSEFCTL_SMTP_USER` | Override `notifications.email.smtp.user` |
| `KSEFCTL_SMTP_PASS` | Override `notifications.email.smtp.pass` |
| `KSEFCTL_NO_FIRST_RUN=1` | Disable first-run prompts |

Config path resolution order: `--config` CLI flag → `KSEFCTL_CONFIG` → platform default.

## Incremental sync behavior

Implementation follows `przyrostowe-pobieranie-faktur.md`:

- `dateType = PermanentStorage`
- `restrictToPermanentStorageHwmDate = true`
- `subjectType` iterates through configured subject types
- `dateRange.to` is set to the window end to honor the 3-month export limit
- Cursor is updated using `LastPermanentStorageDate` if truncated, otherwise `PermanentStorageHwmDate`

First-time sync default: `initialSyncFrom` is set to ~3 months ago to satisfy the KSeF date range limit. Override in config if needed.
The CLI chunks older ranges into 3-month windows automatically.
Sync never requests dates earlier than KSeF production start (`2026-02-01`). Old cursors are fast-forwarded to this floor.

PDF visualization is generated by default via `ksef-pdf-generator` and can be disabled with `sync.generatePdf: false`.

## Rate limiting & retries

KSeF limits are enforced per `limity/limity.md`. The client retries 429/5xx with exponential backoff and jitter and respects `Retry-After`.
To be a good citizen, `operational.exportCooldownSeconds` adds a short pause between export requests (default: 2s).

## Security & data handling

- TLS verification is always enabled; optional SPKI pinning is supported.
- Invoices and state DB are written with `0600` permissions.
- Tokens are stored in the OS keychain (macOS Keychain / libsecret).

## Storage layout

Default layout:

```
storageRoot/
  db/state.sqlite
  invoices/<NIP>/YYYY/MM/DD/<ksefNumber>/
    Faktura nr <nr_faktury>.xml (fallback: <ksefNumber>.xml)
    metadata.json
    Faktura nr <nr_faktury>.pdf (fallback: <ksefNumber>.pdf)
  logs/ksefctl.log
```

Flat sync layout (`ksefctl sync --flat-sync`):

```text
storageRoot/
  db/state.sqlite
  invoices/<NIP>/YYYY/MM/
    <Seller> - <invoice_number>.xml
    <Seller> - <invoice_number>.metadata.json
    <Seller> - <invoice_number>.pdf
  logs/ksefctl.log
```

If two invoices would produce the same flat filename, ksefctl keeps the first name and appends ` - <ksefNumber>` only for the conflicting invoice.

If `organizations[].outputPath` is set, or `--output-path` is passed on the CLI, that path becomes the invoice root for that NIP instead of `storageRoot/invoices/<NIP>/`.

## Notifications

- macOS Notification Center via `node-notifier`.
- SMTP summaries via `nodemailer` (one email per sync cycle).

## Services

### macOS launchd (user agent)

`ksefctl system service install` creates:

- `~/Library/LaunchAgents/com.ksefctl.plist`

### Linux systemd

`ksefctl system service install` creates:

- User service: `~/.config/systemd/user/ksefctl.service`
- System service (if run as root): `/etc/systemd/system/ksefctl.service`

The install command automatically runs `systemctl --user daemon-reload` (or the system equivalent). If you edit the unit file manually afterwards, reload the daemon yourself:

```bash
systemctl --user daemon-reload
```

For user services that should run after logout:

```bash
loginctl enable-linger $USER
```

## TLS + pinning

TLS verification is always on. Optional SPKI pinning:

```
security:
  tls:
    enablePinning: true
    pins:
      - "<base64-sha256-spki>"
    pinningHosts:
      - "api-test.ksef.mf.gov.pl"
```

To obtain the pin value for a host:

```bash
ksefctl system pin api.ksef.mf.gov.pl
```

This prints the SHA-256 hash of the server certificate's raw public key (as returned by Node.js `getPeerCertificate().pubkey`), formatted as base64, plus a ready-to-paste config snippet. Use this command rather than manual `openssl` pipelines, which produce a different (SPKI DER wrapper) hash.

If invoice package parts are served from a different host, add it to `pinningHosts`.

## Secrets & keychain

- Keychain service name: `ksefctl`
- Account name defaults to `<environment>:nip:<nip>` (one entry per NIP)
- Override via `auth.keychainServiceName`
- Watch mode (`sync --watch`) is non-interactive; make sure tokens exist via `ksefctl system secret set`
- `ksefctl system secret show` only reports presence, never the token value
- Interactive commands will prompt for missing tokens and store them in keychain

## Tests

```bash
npm test
npm run test:integration
```

## Lint

```bash
npm run lint
npm run lint:fix
```

## Verification checklist

1. `ksefctl system init` → config + storage directories created
2. `ksefctl system verify` → auth succeeds or returns exit code 2
3. `ksefctl sync` → invoices written, DB updated
4. `ksefctl status` → last sync time + counts
5. `npm test` and `npm run test:integration` → pass

## Assumptions

- Token generation requires one-time XAdES authentication using external tooling.
- Export package encryption uses AES-256-CBC + PKCS#7 (per OpenAPI description).
- Public key certificates are retrieved from `/security/public-key-certificates`.

## Regenerate OpenAPI types

```bash
npm run generate:openapi
```

## API reference

KSeF API contract: https://github.com/CIRFMF/ksef-docs/blob/main/open-api.json

## Contributing

```bash
npm ci
npm run lint:fix
npm run build
npm test
```

All-in-one:

```bash
npm run solution
```

## License

Apache-2.0
