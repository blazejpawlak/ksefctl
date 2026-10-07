# Changelog

## [Unreleased]

### Changed

- The install step that builds the pinned PDF converter is quiet on success: its upstream build output goes to `node_modules/@akmf/ksef-fe-invoice-converter/ksefctl-prepare.log`, and is printed only if the build fails. npm versions without `allowScripts` support no longer warn about an unknown `allow-scripts` config.
- Upgrade zod to 4.x. Config defaults are unchanged: a `config.yaml` that omits optional sections or fields parses to the same values as before.
- An invalid `config.yaml` now fails with a readable list of every violation and its path (for example `✖ NIP must be exactly 10 digits → at organizations[0].nip`) instead of a raw JSON dump that was cut off at 500 characters. Schema violations now exit with code `4` (config invalid), as documented, instead of `5`.
- Upgrade `undici` from 6 to 8 (requires Node.js 22.19+). The KSeF HTTP client keeps its previous transport behaviour: requests stay on HTTP/1.1 (undici 8 would otherwise negotiate HTTP/2), and the dispatcher is wrapped so Node's built-in `fetch` can use it on every supported Node.js release. TLS options, certificate pinning, timeouts and retries are unchanged and are now covered by tests against a real local TLS server.
- Upgrade `pino` to 10.4.0 and `pino-pretty` to 13.2.0. The only breaking changes upstream are dropped support for Node.js 18 (pino) and Node.js 14/16 (pino-pretty), which the Node.js 22 baseline already covers. pino now redacts through `@pinojs/redact` instead of `fast-redact`; the log file format, redaction, `0600` permissions, rotation and pretty console output are unchanged, and a unit test now pins the redacted JSON-line output.
- Node.js 26 is now the minimum supported runtime (`engines.node`, CI, publish workflow, `.nvmrc`, `@types/node` 26). Node.js 22 and 24 are no longer supported.
- The package is now an ES module (`"type": "module"`, TypeScript `module`/`moduleResolution` `NodeNext`), and `dist/` is emitted as ESM. The `ksefctl` command, its configuration, and installed launchd/systemd services (which run `node dist/cli.js`) work as before. Anyone importing `dist/` modules programmatically must switch from `require()` to `import` / `import()`. The PDF converter is now loaded through its ESM build instead of its UMD build. Both builds produce the same PDF output.
- Upgrade `ora` from 5 to 9 and `cli-spinners` from 2 to 3 (both ESM-only; they require Node.js 20 and 18.20, which the Node.js 26 baseline covers). The progress spinner keeps the same `dots` style and text updates, and is still shown only when stderr is a terminal: non-terminal output, such as the launchd/systemd service logs, stays plain lines with no escape codes, and `--json` output is unchanged. While the spinner is active, other terminal output now clears the spinner line first and redraws it underneath instead of mixing with it. A unit test now drives the renderer against the real packages.
- Upgrade `commander` from 12 to 15 (ESM-only, requires Node.js 22.12+). Command and option names, defaults, option conflicts, error messages, exit codes and the generated bash/zsh/fish completion scripts are unchanged. Commander 13+ rejects unexpected extra arguments by default; ksefctl keeps ignoring them, as before. Help text may now wrap one column later, because commander fills the full terminal width.
- Upgrade the pinned PDF converter (`CIRFMF/ksef-pdf-generator`) from 1.1.39 to 1.1.40. Rendered invoices gain a space after the "Numer KSeF:" label and the generator stamp reads 1.1.40; all 430 locally stored invoices otherwise render the same text with the same page counts. The upgrade also removes the TypeScript errors and a deprecation warning the converter printed during `npm ci`, and adds support for UTF-16 encoded invoice XML.

### Fixed

- A saved continuation point is no longer moved forward to the rolling 3-month default start when `sync.initialSyncFrom` is not set. The rolling floor kept advancing while a cursor was held (for example after a failed invoice write) or during an outage, so the next cycle started past the unsynced invoices and skipped them silently. Without `initialSyncFrom`, a saved cursor is now kept and floored only at the KSeF start date (`2026-02-01`); the 3-month default applies only to a first sync with no cursor. A lagging cursor catches up in windows of at most 3 months. An explicit `initialSyncFrom`, `--redownload-all` and `--time-window` behave as before. A `--output-path` export follows the same rule, so with `initialSyncFrom` unset it also starts at the saved cursor rather than the rolling 3-month floor and can cover older invoices and more windows; it still never writes the canonical cursor.
- Installing the published package (`npm install --global`) no longer fails in `postinstall`: the converter preparation script is now shipped in the package and finds the converter even when npm hoists it to a parent `node_modules`.
- An export that returned no package parts advanced the continuation point to the requested `to` instead of KSeF's `permanentStorageHwmDate`. With `restrictToPermanentStorageHwmDate` the HWM can lag `to` by minutes, so invoices committed inside that gap were never downloaded. Empty and non-empty exports now share one rule: `lastPermanentStorageDate` for a truncated package, otherwise the HWM, never beyond `to`.
- A missing, invalid or non-advancing HWM no longer falls back silently to `to`; the continuation point is kept and the window is retried in the next cycle.
- An empty export for an explicit `--time-window` no longer moves the regular continuation point.
- The continuation point is no longer advanced past a window in which an invoice failed to be written, so the failed invoice is retried in the next cycle instead of being lost.
- `sync --output-path` (including `--redownload`) no longer writes to the canonical sync state. It used to record the exported copy as the invoice's `file_path`, move continuation points, update the sync status and mark notifications, so deleting a scratch export directory made the next regular sync treat the invoice as missing, and a plain `sync --output-path` could advance the cursor past invoices that never reached the store. Exports now leave invoice records, continuation points, sync status and notification markers untouched, and deduplicate against the export directory instead.
- Stopping the service (`sync --watch` or the daemon) with `SIGINT`/`SIGTERM` no longer loses its final log lines, such as "Service stop signal received". The log file is now drained and closed, with a 2-second upper bound, before the signal is re-raised; previously the process could exit while the line was still buffered, for example when the signal arrived before the log file had been opened.
- `sync --output-path` (including `--redownload` and `--redownload-all`) now reads the cursor through a new read-only database accessor (`SqliteStore.readDb`) and no longer touches `state.sqlite` at all. Reads used to open the canonical database for append, run migrations and rewrite the whole file, which contradicted the isolation promise above and made exports fail on read-only storage. The accessor never creates the file, directory or lock, and never writes: a missing database means "no data" and legacy schemas are migrated in memory only. Because writes are now atomic (below), lock-free reads always see a complete file and no longer contend with a running watch service. `status` reads use it too.
- Writes to `state.sqlite` are now atomic: the database is written to a `0600` temp file in the same directory, fsynced and renamed over `state.sqlite`, and the temp file is removed on failure. Previously the file was truncated and rewritten in place, so a crash or kill mid-write could corrupt it and lose invoice records, cursors, sync status and notification markers. A failed read of an existing `state.sqlite` (for example `EIO`) now aborts the operation instead of starting from an empty database and persisting it over the stored state.

### Security

- Upgrade `nodemailer` to 10.0.15 (with `@types/nodemailer` 8), fixing GHSA-6vj9-mwq6-2f5v (SMTP credential disclosure through the process-global DNS cache) and several address-parser denial-of-service advisories. nodemailer 10 requires Node.js 20+, which the existing Node.js 22 baseline already satisfies.
- Refresh vulnerable transitive dependencies: `brace-expansion`, `fast-copy`, `fast-uri` and `source-map-js`.
- Override `i18next-http-backend` to `^4.0.2` under `@akmf/ksef-fe-invoice-converter` (GHSA-xvq9-wjp8-hwqf). The converter declares the package but its built bundle never loads it, so PDF rendering is unaffected.

## [2026.9.21] - 2026-09-21

### Added

- Adaptive polling: the watch loop now tunes its own interval from KSeF's `Retry-After` responses, between `sync.adaptivePolling.minIntervalSeconds` and `maxIntervalSeconds`, and never polls before the newest rate-limit deadline expires. The effective interval is persisted across restarts and reported by `ksefctl status`.
- Log rotation by size and age under `logging.rotation`, with `0600` permissions on rotated files and graceful degradation when rotation fails.
- `ksefctl system notifications backfill` marks existing invoices as notification-handled without sending, so `notifications.unpaidInvoiceCatchUp` can be enabled safely on an install with a backlog.

### Fixed

- Export requests are no longer issued for windows narrower than `sync.minExportWindowSeconds`; KSeF always rejects them, and each rejection consumed a rate-limited request.
- A window KSeF rejects as out of range no longer advances the continuation point to a locally derived timestamp, which could strand invoices later assigned a `permanentStorageDate` inside the skipped range.
- Unpaid-invoice notifications are dispatched per organization instead of once per cycle, and are drained on `SIGTERM`, so stopping the service mid-cycle no longer loses them permanently.
- Notification catch-up is bounded by `notifications.unpaidCatchUpLookbackDays` instead of rescanning every stored invoice on every cycle.
- `ksefctl system service logs --error` reads from `journalctl` on systemd, where unit stdout/stderr now goes to journald instead of unbounded files.

### Changed

- systemd units send stdout/stderr to journald rather than appending to uncapped files.

## [2026.9.15] - 2026-09-15

### Changed

- Updated the bundled KSeF PDF converter and refreshed dependency resolutions.
- Email notifications now identify invoice PDFs as attachments instead of using unsupported inline `cid:` links.

### Fixed

- Escaped fish completion descriptions against shell expansion and embedded control characters.

### Security

- Updated `adm-zip`, Nodemailer, Undici, Vitest, and affected transitive dependencies to patched versions.
- Added integration-test and dependency-audit gates to CI and package publishing.
- Added weekly grouped Dependabot updates for npm and GitHub Actions while keeping major upgrades manual.

[2026.9.21]: https://github.com/blazejpawlak/ksefctl/compare/v2026.9.15...v2026.9.21
[2026.9.15]: https://github.com/blazejpawlak/ksefctl/compare/v2026.7.9...v2026.9.15
