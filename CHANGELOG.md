# Changelog

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

[2026.9.15]: https://github.com/blazejpawlak/ksefctl/compare/v2026.7.9...v2026.9.15
