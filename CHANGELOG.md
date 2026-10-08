# Changelog

## [Unreleased]

## [2026.10.8] - 2026-10-08

### Fixed

- `npm run solution` no longer ends with npm 11's `install-scripts ... not yet covered by allowScripts` warning for ksefctl's own `prepare` script: its final `npm link` now uses `--ignore-scripts`, since `npm ci` has already run `prepare` and the build is done. The README source install does the same.
- `npm ci` in a development checkout no longer fails with `EALLOWGIT` on npm 11 releases that reject the converter's git lockfile entry as non-root under `allow-git=root` (seen with npm 11.12.1). The repo `.npmrc` now sets `allow-git=all`. The converter is the only git dependency, and the published package has none.

## [2026.10.7] - 2026-10-07

### Changed

- The pinned PDF converter (`@akmf/ksef-fe-invoice-converter`) now ships prebuilt inside the published package (`vendor/ksef-pdf-generator/`: its ESM bundle, upstream MIT `LICENSE`, a `THIRD_PARTY_NOTICES.txt` and a `metadata.json` with its version and source commit) instead of being fetched from git and built when ksefctl is installed. It moved from `dependencies` to `devDependencies` (same commit-pinned git spec) and is built at development time by the `prepare` script, which replaces `postinstall`; consumers no longer run any ksefctl install script or the converter's ~260-package dev install and build. `ksefctl --version` reads the converter version and commit from the shipped metadata. `THIRD_PARTY_NOTICES.txt` is generated from what the bundle really contains: the converter is built with a hidden source map, every module in it is attributed to a package, and pdfmake's prebuilt `build/pdfmake.js` is expanded from its own map (PDFKit, core-js, FileSaver, SVG-to-PDFKit, browser polyfills, ... 76 components with their license texts, from the installed package or from reviewed copies checked in under `scripts/third-party/`), plus the fonts and color profile it embeds (Roboto under the SIL OFL 1.1, the ICC sRGB2014 profile). The same pass reads each bundled module's own license headers, so notices carried only in source files are shipped too (Google's Apache-2.0 headers in brotli's decoder with the Apache-2.0 text, the Node/narwhal/buffer MIT headers in assert and stream-browserify, and the `String.fromCodePoint` polyfill banner in sax). Headers are read from the comments of a real parser (never from string literals), matched case-insensitively, and SPDX expressions are parsed in full. The vendored metadata records a notices-generator version, so a vendor directory produced by an older generator is rebuilt by `prepare` and rejected by the prepack guard, and the notices are sorted so they do not depend on the order modules are listed. The build and the guard fail closed on a module that cannot be attributed, a prebuilt input without its own source map, a component, asset or converter license that is blank, a license header nothing reviewed accounts for, and a font, profile or image embedded as a data: URL or base64 string that no reviewed asset matches. The build also refuses to label its output with the pinned commit unless the installed converter really is that commit (run `npm ci` after changing the pin). A `prepack` guard refuses to pack or publish when the vendored files, including the notices, are missing or no longer match the pin. PDF output is unchanged: the extracted text of FA(1), FA(2) and FA(3) test invoices is identical. The build's upstream output stays quiet on success and goes to `node_modules/@akmf/ksef-fe-invoice-converter/ksefctl-prepare.log`.
- The README install command is now `npm install --global @blazejpawlak/ksefctl --registry=https://npm.pkg.github.com --allow-scripts=keytar`: `@blazejpawlak/ksefctl` no longer needs an `--allow-scripts` entry because it has no install script. The repo `.npmrc` sets `allow-git=root` so `npm ci` keeps working for development on npm 12.
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

- `npm install --global @blazejpawlak/ksefctl` no longer fails on npm 12 with `EALLOWGIT: Refusing to fetch "@akmf/ksef-fe-invoice-converter@github:CIRFMF/ksef-pdf-generator#..."`: npm 12 refuses git dependencies by default, and the converter was one. The converter now ships inside the package, so installing ksefctl fetches nothing from git.
- A global install on npm 11 no longer leaves `<prefix>/lib/node_modules/@akmf/ksef-fe-invoice-converter`, a symlink into npm's cache (`_cacache/tmp/git-clone*`) that was already dangling when the install finished. A global install no longer creates the `@akmf/ksef-fe-invoice-converter` link (or any `@akmf` sibling) next to `@blazejpawlak/ksefctl`.
- A saved continuation point is no longer moved forward to the rolling 3-month default start when `sync.initialSyncFrom` is not set. The rolling floor kept advancing while a cursor was held (for example after a failed invoice write) or during an outage, so the next cycle started past the unsynced invoices and skipped them silently. Without `initialSyncFrom`, a saved cursor is now kept and floored only at the KSeF start date (`2026-02-01`); the 3-month default applies only to a first sync with no cursor. A lagging cursor catches up in windows of at most 3 months. An explicit `initialSyncFrom`, `--redownload-all` and `--time-window` behave as before. A `--output-path` export follows the same rule, so with `initialSyncFrom` unset it also starts at the saved cursor rather than the rolling 3-month floor and can cover older invoices and more windows; it still never writes the canonical cursor.
- An invalid `config.yaml` now prints its complete list of violations, one per line, instead of a single run-on line cut off at 500 characters that hid the later violations. Terminal escapes and other control characters are still stripped, and secrets are redacted as before, including values that start on or span a following line; a redacted value never swallows the next diagnostic line. Config diagnostics are capped at 100 lines or 5000 characters, with a note on how many lines were omitted; every other error keeps the single-line 500-character form. The exit code stays `4`.
- The converter's nested install and build (run by `prepare`) now always run as a local project with its dev dependencies, whatever the outer install mode. During `npm install --global` the inherited `npm_config_global`/`npm_config_prefix` made the nested `npm install` link the converter into the global prefix and skip its `.npmrc` allow-scripts list; `--omit=dev`, `NODE_ENV=production` or `npm_config_production` made the build fail because its dev dependencies were missing; and the README's `--allow-scripts=...` would be rejected by npm 11 as not allowed in a project-scoped install (`EALLOWSCRIPTS`), so the install-mode variables and `allow-scripts` are no longer passed on and the converter's own `.npmrc` allowlist governs. Registry, auth, proxy and cache settings are still inherited. A failed `npm install-scripts` probe no longer deletes the converter's `.npmrc` unless npm reports the command as unknown.
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

[2026.10.8]: https://github.com/blazejpawlak/ksefctl/compare/v2026.10.7...v2026.10.8
[2026.10.7]: https://github.com/blazejpawlak/ksefctl/compare/v2026.9.21...v2026.10.7
[2026.9.21]: https://github.com/blazejpawlak/ksefctl/compare/v2026.9.15...v2026.9.21
[2026.9.15]: https://github.com/blazejpawlak/ksefctl/compare/v2026.7.9...v2026.9.15
