# Changelog

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
