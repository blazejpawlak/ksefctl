# ksefctl

[![CI](https://github.com/blazejpawlak/ksefctl/actions/workflows/ci.yml/badge.svg)](https://github.com/blazejpawlak/ksefctl/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/blazejpawlak/ksefctl)](https://github.com/blazejpawlak/ksefctl/releases)
[![License](https://img.shields.io/github/license/blazejpawlak/ksefctl)](LICENSE)

CLI background service for KSeF API 2.0 inbox synchronization (macOS + Linux). No GUI. No Windows.

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Services](#services) · [Security](#security--data-handling) · [Development](#development-and-release-checks)

## What it does

- Authenticates to KSeF API 2.0 (KSeF token).
- Incrementally downloads incoming invoices using export packages and HWM.
- Stores invoices idempotently with a local SQLite state DB (sql.js).
- Generates local PDF visualizations by default.
- Sends macOS Notification Center alerts and optional SMTP email summaries.
- Runs once or continuously (`sync --watch`); provides launchd and systemd installers.

## Prerequisites

- Node.js >= 22 (nvm recommended)
- macOS or Linux (x64/arm64)
- For keychain storage on Linux: libsecret (keytar backend)
- Git, when building from source

## Install

### GitHub Packages

Releases are published as `@blazejpawlak/ksefctl` on GitHub Packages. GitHub's npm registry requires authentication even for public packages. Create a classic personal access token with `read:packages`, then use it as the password when prompted:

```bash
npm login --scope=@blazejpawlak --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @blazejpawlak/ksefctl --registry=https://npm.pkg.github.com
```

Do not put the token in this repository or commit it to an `.npmrc` file.

### Build from source

```bash
git clone https://github.com/blazejpawlak/ksefctl.git
cd ksefctl
npm ci
npm run build
npm link
```

`npm ci` runs the repo `postinstall` hook, which prepares the pinned `@akmf/ksef-fe-invoice-converter` dependency for local use. Use `ksefctl --version` to see the app version and the pinned upstream PDF builder version/commit; compare it with the upstream `CIRFMF/ksef-pdf-generator` releases when troubleshooting PDF rendering.

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

- `ksefctl sync [-n <nip>] [--redownload-all] [--flat-sync] [--time-window <from:to>] [--output-path <path>] [--json]` – run sync.
- `ksefctl sync -n <nip> --redownload <ksefNumber>` – re-download a single invoice (`-n`/`--nip` is required with `--redownload`).
- `ksefctl sync --repair-missing-pdfs [--nip <nip>] [--json]` – generate PDFs for local XML invoices that are missing PDF files without contacting KSeF.
- `ksefctl sync --watch` – run continuously in foreground.
- `ksefctl status [--json]` – show last sync status.
- `ksefctl system init [--force] [--yes]` – create config template and storage directories.
- `ksefctl system verify [-n <nip>]` – validate authentication against the configured environment.
- `ksefctl system service install` – install + enable launchd/systemd.
- `ksefctl system service uninstall` – remove launchd/systemd.
- `ksefctl system service status` – show service state and last sync details.
- `ksefctl system service restart` – restart the background service.
- `ksefctl system service logs [-f] [-n <lines>] [--error]` – show or follow service logs.
- `ksefctl system config` – show sanitized config.
- `ksefctl system secret set [-n <nip>] [--token-stdin]` – store KSeF token in keychain.
- `ksefctl system secret show` – show which NIPs have keychain secrets.
- `ksefctl system secret clear -n <nip>` – remove keychain secret for a NIP.
- `ksefctl system notifications backfill [--dry-run] [--yes]` – mark existing invoices as notification-handled without sending anything.
- `ksefctl system completion <bash|zsh|fish>` – generate shell completion script.
- `ksefctl system pin <host> [-p <port>]` – print the SPKI SHA-256 TLS pin for a host (ready to paste into `security.tls.pins`).

Global options:

- `-c, --config <path>` – override config path.
- `-v, --verbose` – enable detailed logs.
- `-V, --version` – print the application version, latest short commit, and pinned upstream PDF builder version/commit.

Commands that sync, verify, inspect state, or manage the background service require completed initialization: a valid config plus a keychain token for every configured NIP. Help/version output, `system completion`, `system pin`, and creation of the initial config template do not require KSeF credentials.

### system init

- Requires an interactive terminal for the full bootstrap (NIP entry, token prompts).
- Without a TTY (CI/pipe): writes the config template and creates storage directories, then exits with a hint to run interactively.
- `--force` removes the config file and keychain tokens for all NIPs and re-runs bootstrap. Use `--yes` to skip the confirmation prompt.

### system verify

Performs the authentication flow only — does not download invoices.

### sync

Progress messages go to stderr; use `-v`/`--verbose` for detailed logs. If an invoice directory is missing on disk, sync re-downloads it even if the DB marks it as already downloaded.

| Flag                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-n`, `--nip <nip>`         | Sync or re-download for a single NIP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--redownload <ksefNumber>` | Re-download a single invoice. Requires `-n`/`--nip`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--redownload-all`          | Reset cursors to `sync.initialSyncFrom` (or `2026-02-01`) and re-download all invoices. Optionally filter by `--nip`. Mutually exclusive with `--redownload`.                                                                                                                                                                                                                                                                                                                                                |
| `--flat-sync`               | Store invoices in monthly folders (`invoices/<NIP>/YYYY/MM/`) using `Seller - InvoiceNumber` filenames. Colliding filenames get ` - <ksefNumber>` appended.                                                                                                                                                                                                                                                                                                                                                  |
| `--time-window <from:to>`   | Explicit date range as `DD-MM-YYYY:DD-MM-YYYY`. Overrides cursor/config-derived bounds. Requires `--redownload`, `--redownload-all`, or `--flat-sync`. Mutually exclusive with `--watch`.                                                                                                                                                                                                                                                                                                                    |
| `--output-path <path>`      | Override the invoice output root for this run. Requires `-n`/`--nip` when multiple orgs are configured.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--watch`                   | Run in the **foreground** continuously, polling every `pollingIntervalSeconds` (default: 300 s). The process occupies the terminal and must be kept alive manually (e.g. in a `tmux` session). Cannot be combined with `--redownload`, `--redownload-all`, or `--time-window`. For unattended background operation, use `ksefctl system service install` instead — it registers a launchd agent (macOS) or systemd unit (Linux) that starts automatically and restarts on failure. Windows is not supported. |
| `--repair-missing-pdfs`     | Scan locally stored XML invoices and generate missing same-base PDF files without contacting KSeF. Optionally combine with `--nip` to repair one organization. Mutually exclusive with sync/redownload/watch/time-window modes.                                                                                                                                                                                                                                                                              |
| `--json`                    | Output results as JSON instead of formatted text.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

Re-download all invoices for a specific NIP within an explicit date range:

```bash
ksefctl sync --nip 1234567890 --redownload-all --time-window 01-02-2026:30-04-2026
```

Run a flat sync for Q1 2026:

```bash
ksefctl sync --flat-sync --time-window 01-01-2026:31-03-2026
```

Repair local invoices that have XML/metadata but no PDF:

```bash
ksefctl sync --repair-missing-pdfs
```

Repair missing PDFs for one NIP and emit machine-readable output:

```bash
ksefctl sync --nip 1234567890 --repair-missing-pdfs --json
```

Re-download a specific invoice and scan for additional invoices in a date window:

```bash
ksefctl sync --nip 1234567890 --redownload 1234567890-20260101-ABC123 --time-window 01-01-2026:28-02-2026
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
  unpaidInvoiceCatchUp: false # default: only notify invoices found in the current sync run
  email:
    enabled: true
    smtp:
      host: smtp.example.com
      port: 587
      user: user@example.com
      pass: secret
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
- `notifications` (macOS + email with optional unpaid invoice catch-up and `smtpProfiles` for per-NIP routing)
- `logging` (level, file, console pretty-printing)
- `operational` (retry, timeouts, poll, exportCooldownSeconds, allowInsecureHttp)
- `security.tls` (pinning)
- `security.allowedHosts`: allowed hosts for package downloads (schema default: `[]`; if empty at runtime the API host is allowed automatically)
- `sync` (subject types, HWM, generatePdf, initialSyncFrom)

Minimal config example: `docs/minimal-config.yaml`

Run `ksefctl system config` after `system init` to see the resolved configuration.

### Config defaults

| Field                                | Default                            |
| ------------------------------------ | ---------------------------------- |
| `environment`                        | `prod`                             |
| `pollingIntervalSeconds`             | `300` (5 min)                      |
| `notifications.macosNotification`    | `true`                             |
| `notifications.unpaidInvoiceCatchUp` | `false`                            |
| `notifications.unpaidCatchUpLookbackDays` | `30`                          |
| `notifications.email.enabled`        | `false`                            |
| `logging.level`                      | `info`                             |
| `logging.pretty`                     | `true`                             |
| `logging.rotation.enabled`           | `true`                             |
| `logging.rotation.maxFileMegabytes`  | `16`                               |
| `logging.rotation.maxFiles`          | `5`                                |
| `logging.rotation.maxAgeDays`        | `30`                               |
| `operational.maxConcurrency`         | `2`                                |
| `operational.timeoutSeconds`         | `60`                               |
| `operational.pollIntervalSeconds`    | `10`                               |
| `operational.authPollMaxAttempts`    | `60`                               |
| `operational.exportPollMaxAttempts`  | `120`                              |
| `operational.exportCooldownSeconds`  | `2`                                |
| `operational.allowInsecureHttp`      | `false`                            |
| `operational.retry.maxAttempts`      | `5`                                |
| `operational.retry.baseDelayMs`      | `500`                              |
| `operational.retry.maxDelayMs`       | `10000`                            |
| `operational.retry.jitter`           | `0.2`                              |
| `sync.subjectTypes`                  | all four subject types             |
| `sync.includeMetadataHeader`         | `true`                             |
| `sync.generatePdf`                   | `true`                             |
| `sync.pdfGenerationTimeoutMs`        | `30000`                            |
| `sync.pdfMaxConsecutiveTimeouts`     | `3`                                |
| `sync.flatSync`                      | `false`                            |
| `sync.maxConcurrentNips`             | `1`                                |
| `sync.minExportWindowSeconds`        | `300`                              |
| `sync.adaptivePolling.enabled`       | `true`                             |
| `sync.adaptivePolling.minIntervalSeconds` | `300`                         |
| `sync.adaptivePolling.maxIntervalSeconds` | `3600`                        |
| `sync.adaptivePolling.growthFactor`  | `2`                                |
| `sync.adaptivePolling.decayFactor`   | `0.8`                              |
| `sync.adaptivePolling.respectRetryAfter` | `true`                         |
| `security.tls.enablePinning`         | `false`                            |
| `security.allowedHosts`              | `[]` (API host allowed by default) |

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

| Variable                 | Effect                                                                     |
| ------------------------ | -------------------------------------------------------------------------- |
| `KSEFCTL_CONFIG`         | Override config file path (lower precedence than `--config`)               |
| `KSEFCTL_SMTP_USER`      | Override `notifications.email.smtp.user` (default SMTP only, not profiles) |
| `KSEFCTL_SMTP_PASS`      | Override `notifications.email.smtp.pass` (default SMTP only, not profiles) |
| `KSEFCTL_NO_FIRST_RUN=1` | Disable first-run prompts                                                  |

Config path resolution order: `--config` CLI flag → `KSEFCTL_CONFIG` → platform default.

## Incremental sync behavior

Implementation follows `przyrostowe-pobieranie-faktur.md`:

- `dateType = PermanentStorage`
- `restrictToPermanentStorageHwmDate = true`
- `subjectType` iterates through configured subject types
- `dateRange.to` is set to the window end to honor the 3-month export limit
- Cursor is updated using `LastPermanentStorageDate` if truncated, otherwise `PermanentStorageHwmDate`
- Windows narrower than `sync.minExportWindowSeconds` are skipped without contacting KSeF, and a window KSeF rejects as out of range leaves the cursor untouched (see [Rate limiting & retries](#rate-limiting--retries))

First-time sync default: `initialSyncFrom` is set to ~3 months ago to satisfy the KSeF date range limit. Override in config if needed.
The CLI chunks older ranges into 3-month windows automatically.
Sync never requests dates earlier than KSeF production start (`2026-02-01`). Old cursors are fast-forwarded to this floor.

### Explicit time window (`--time-window`)

When `--time-window DD-MM-YYYY:DD-MM-YYYY` is provided (requires `--redownload`, `--redownload-all`, or `--flat-sync`):

- The date range overrides cursor and config-derived bounds entirely.
- The range is still chunked into 3-month windows to satisfy the KSeF API limit.
- Continuation points in the DB are **not** updated — the explicit window is a one-shot scan.
- With `--redownload <ksefNumber>`: the specific invoice is downloaded first, then the export scan uses the explicit window.
- With `--redownload-all`: cursors are reset to the `from` date, and the scan covers `from` → `to`.
- With `--flat-sync`: the scan covers `from` → `to` using flat storage layout.

PDF visualization is generated locally by default via `ksef-pdf-generator` and can be disabled with `sync.generatePdf: false`.
If the local renderer hangs repeatedly, `sync.pdfMaxConsecutiveTimeouts` disables PDF generation for the rest of that sync run after repeated `sync.pdfGenerationTimeoutMs` timeouts, while XML/metadata sync continues.
Run `ksefctl sync --repair-missing-pdfs` after upgrading the PDF builder or fixing local renderer issues to backfill PDFs for invoices that were previously saved as XML/metadata only.

### PDF builder version

PDF visualization is produced locally by the pinned upstream `CIRFMF/ksef-pdf-generator` package (`@akmf/ksef-fe-invoice-converter`). `ksefctl --version` prints both the ksefctl build and the pinned PDF builder version/commit, for example:

```text
2026.6.9 (06fa00c)
pdf-builder: @akmf/ksef-fe-invoice-converter 1.1.39 (CIRFMF/ksef-pdf-generator@fb12569a; check upstream releases for newer versions)
```

If PDF rendering starts timing out or failing for newly issued invoices, check whether upstream has published a newer `CIRFMF/ksef-pdf-generator` release and update the pinned dependency after testing.

## Rate limiting & retries

KSeF limits are enforced per `limity/limity.md`. The client retries 429/5xx with exponential backoff and jitter and respects `Retry-After`.
To be a good citizen, `operational.exportCooldownSeconds` adds a short pause between export requests (default: 2s).

### Why a fixed poll interval is not enough

Every cycle issues one `POST /invoices/exports` per organization per subject type.
With four NIPs and the four default subject types that is 16 export requests per
cycle; at `pollingIntervalSeconds: 300` it works out to roughly 192 export
requests an hour, which is well above what KSeF permits. When the limit is hit
KSeF replies `429` with a `Retry-After` header, and that header is authoritative:
observed values range from seconds to 50 minutes, with a median around 12 minutes.

### Adaptive polling

`sync.adaptivePolling` (enabled by default) lets the watch loop tune its own
interval instead of polling blindly:

- after a cycle that hit a rate limit, the interval grows by `growthFactor`;
- after a clean cycle it decays by `decayFactor`;
- the result is clamped between `minIntervalSeconds` and `maxIntervalSeconds`;
- with `respectRetryAfter` (default `true`) the next cycle is never scheduled
  before the newest `Retry-After` deadline has passed, whatever the maths says.

The effective interval is persisted under `<storage.root>/state/` so a restart
does not reset to the floor and immediately re-trip the limiter. `ksefctl status`
reports `effectiveIntervalSeconds` and `nextRunAt`. Set
`sync.adaptivePolling.enabled: false` to restore the previous fixed-interval
behaviour exactly.

### Minimum export window

KSeF rejects export requests whose range ends inside the lag between wall clock
and its permanent-storage high-water mark, with
`Zakres filtrowania wykracza poza dostepny zakres danych`. Once a cursor has
caught up to near-now, the next window is only seconds wide and is certain to be
rejected while still consuming a rate-limited request.

`sync.minExportWindowSeconds` (default `300`) skips the request entirely when the
candidate window is narrower than that, leaving the cursor untouched so the next
cycle retries once enough time has accumulated.

A rejected window never advances the continuation point. KSeF returned no data,
so moving the cursor to a locally derived timestamp could strand invoices that
are later assigned a `permanentStorageDate` inside the skipped range; the
successful path continues to take the cursor from KSeF's own high-water mark.

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
- SMTP email notifications via `nodemailer`.

Notifications are dispatched after each organization finishes rather than once
at the end of the whole cycle. A cycle can block for a long time on rate-limit
backoff, and stopping the service in that gap previously lost the notification
permanently: the invoice was already on disk and in the database, but no
notification row had been written. The service also drains the in-flight
notification on `SIGTERM`/`SIGINT` before exiting.

### Catch-up and backfill

`notifications.unpaidInvoiceCatchUp` re-checks stored invoices that never got a
notification. It is bounded by `notifications.unpaidCatchUpLookbackDays`
(default `30`) so it does not rescan the entire archive on every cycle.

Enabling catch-up on an install that already has a backlog would email every
unpaid invoice it finds, with PDF attachments, in one burst. Seed the state
first:

```bash
ksefctl system notifications backfill --dry-run   # report how many would be marked
ksefctl system notifications backfill --yes       # mark them, sending nothing
```

Only then set `notifications.unpaidInvoiceCatchUp: true`.

### Email notification content

Each notification email includes the following details for every unpaid invoice:

- **Organization** — the NIP being synced, with the friendly `label` from config when set (e.g. `Acme Sp. z o.o. (NIP 5541346379)`)
- **Seller** — company name of the invoice issuer, extracted from the invoice XML (`Podmiot1`)
- **Buyer** — company name of the recipient, extracted from the invoice XML (`Podmiot2`)
- **Invoice number** — human-readable invoice number from the XML
- **Amount** — gross amount and currency from the XML (`Fa/P_15`, `Fa/Waluta`)
- **Bank account** — recipient bank account from the XML payment section when present (`Fa/Platnosc/RachunekBankowy/NrRB`)
- **Due date**
- **KSeF number**
- **Folder** — local path where the invoice was stored
- **PDF attachment** — the generated PDF is attached when available (`sync.generatePdf: true`)

### Email routing

By default, unpaid invoice notifications are sent only for eligible invoices found in the current sync run. Set `notifications.unpaidInvoiceCatchUp: true` to also scan already-downloaded invoices that have not been marked as notified yet.

By default all notifications go through the single `smtp` configuration. Use `smtpProfiles` to route different NIPs through different SMTP accounts:

```yaml
notifications:
  email:
    enabled: true
    smtp: # fallback for NIPs not matched by any profile
      host: smtp.example.com
      port: 587
      user: user@example.com
      pass: secret
      from: ksefctl@example.com
      to:
        - you@example.com
    smtpProfiles:
      - label: company-a
        host: smtp-a.example.com
        port: 587
        user: user@smtp-a.example.com
        pass: secret-a
        from: ksefctl@company-a.example.com
        to:
          - accounting@company-a.example.com
        nips:
          - "5541346379"
      - label: company-b
        host: smtp-b.example.com
        port: 587
        user: user@smtp-b.example.com
        pass: secret-b
        from: ksefctl@company-b.example.com
        to:
          - team@company-b.example.com
        nips:
          - "1234567890"
```

Each invoice is matched against profiles in order; the first profile whose `nips` list contains the invoice's NIP is used. Invoices not matched by any profile fall back to the top-level `smtp` config. If neither matches, a warning is logged and no email is sent for that invoice. Multiple profiles may trigger separate emails in the same sync cycle.

## Services

Manage the installed service with:

```bash
ksefctl system service status
ksefctl system service restart
ksefctl system service logs --lines 100
ksefctl system service logs --follow
```

### Log rotation

The application log is rotated by size and pruned by age and count, configured
under `logging.rotation`: files larger than `maxFileMegabytes` (default 16) are
rotated aside, at most `maxFiles` (default 5) rotated files are retained, and
anything older than `maxAgeDays` (default 30) is removed. Rotated files keep
`0600` permissions, since logs can carry business data. Rotation failures are
warned about and never take the service down.

Rotation applies to the log named by `logging.file`. The service manager's own
stdout/stderr capture is separate: on Linux the unit sends both to journald,
which applies its own retention, and `ksefctl system service logs --error` reads
from `journalctl`. launchd offers no size cap for its `StandardOutPath` /
`StandardErrorPath` files, so on macOS those remain uncapped by the platform.

After upgrading, restart the service so it reopens the rotated log:

```bash
ksefctl system service restart
```

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

## Development and release checks

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:integration
npm audit
```

All six commands must pass before a release. Use `npm run lint:fix` only when you intend to modify formatting or lint findings.

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

## KSeF references

The implementation follows the official [`CIRFMF/ksef-docs`](https://github.com/CIRFMF/ksef-docs) documentation:

- [OpenAPI contract](https://github.com/CIRFMF/ksef-docs/blob/main/open-api.json)
- `uwierzytelnianie.md` for authentication
- `tokeny-ksef.md` for token management
- `pobieranie-faktur/pobieranie-faktur.md` for invoice downloads
- `pobieranie-faktur/przyrostowe-pobieranie-faktur.md` for incremental downloads
- `srodowiska.md` for environments
- `limity/limity.md` for rate limits

## Contributing

Run the complete [development and release checks](#development-and-release-checks) before opening a pull request. See [`AGENTS.md`](AGENTS.md) for repository conventions and generated-file boundaries.

For local development, the convenience script installs dependencies, applies lint fixes, builds, runs both test suites, and links the CLI:

```bash
npm run solution
```

## License

Apache-2.0
