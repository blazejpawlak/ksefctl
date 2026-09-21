# AGENTS.md

This file guides agentic coding tools working in this repository.
Keep changes consistent with existing patterns and conventions.

## Repo overview

- Project: KSeFctl inbox sync CLI (macOS + Linux)
- Language: TypeScript (CommonJS output)
- Node requirement: >= 22
- OS support: darwin, linux
- API: KSeF API v2 (base URL includes /v2)
- Versioning: yyyy-MM-dd (e.g., 2026.02.17)

## Rules sources

- Cursor rules: none found (.cursor/rules/ or .cursorrules)
- Copilot rules: none found (.github/copilot-instructions.md)

## Common commands

Install dependencies:

```bash
npm ci
```

Notes:

- `npm ci` runs the repo `postinstall` hook, which prepares the pinned `@akmf/ksef-fe-invoice-converter` dependency for local use.

Build:

```bash
npm run build
```

Clean build output:

```bash
npm run clean
```

Unit tests:

```bash
npm test
```

Integration tests:

```bash
npm run test:integration
```

Single test file:

```bash
npx vitest run tests/unit/backoff.test.ts
```

Single test by name:

```bash
npx vitest run -t "respects max delay"
```

Single integration test file:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/sync.test.ts
```

OpenAPI types generation:

```bash
npm run generate:openapi
```

Lint/format:

- ESLint is configured via `eslint.config.js`.
- Use `npm run lint` and `npm run lint:fix` for linting.
- Do not introduce additional formatting/lint tooling without discussion.
- Do run the @linter agent to lint.

Dependency audit:

```bash
npm audit
```

Notes:

- Run `npm audit` before every release.
- Fix actionable vulnerabilities before tagging or publishing a release.
- If `npm audit` requires a semver-major dependency update, report the finding and get approval before applying it.

## Release and GitHub Packages publishing

This package is published to GitHub Packages, not the public npm registry. The registry is configured in `package.json` as `https://npm.pkg.github.com`.

Publishing is automated. `.github/workflows/publish.yml` runs on every pushed `v*` tag and, after re-running the full validation sequence, publishes using the workflow's own `packages: write` permission and `GITHUB_TOKEN`. Pushing the tag is what releases the package; no local registry credential is involved.

### Release steps

Validate locally before releasing:

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:integration
npm audit
```

All checks must pass, and `npm audit` must report zero vulnerabilities. If a fix requires a semver-major dependency update, get approval before changing dependencies. After dependency or version changes, rerun the complete validation sequence.

Use a new unused date-based package version and update both `package.json` and `package-lock.json`:

```bash
npm version YYYY.M.D --no-git-tag-version
```

Move the `CHANGELOG.md` `[Unreleased]` section under the new version with its release date, and add the corresponding compare link reference, newest first.

Rerun the complete validation sequence, then commit, tag, and push. Commits and tags are signed, and tags are annotated:

```bash
git commit -S -m "chore(release): prepare YYYY.M.D"
git tag -s vYYYY.M.D -m "vYYYY.M.D"
git push origin main
git push origin vYYYY.M.D
```

`main` is protected: changes are expected to arrive through a pull request with the `quality` check passing. Administrators may bypass this, in which case the push is recorded as a bypassed rule violation. Prefer a pull request unless an administrator is deliberately driving the release directly.

The tag push triggers `publish.yml`. Create the GitHub release from the new changelog section:

```bash
gh release create vYYYY.M.D --title "vYYYY.M.D" --notes-file <notes-file> --verify-tag
```

Confirm the publish succeeded:

```bash
gh run list --workflow=publish.yml --limit 1
```

The publish step logs `+ @blazejpawlak/ksefctl@VERSION` on success.

The tag push also triggers `ci.yml`, duplicating checks that `publish.yml` already runs. If that duplicate run hangs, cancel it; the `Publish` run is authoritative.

Published package versions cannot be overwritten. If publishing reports that a version already exists, bump to the next unused date-based version, rerun validation, commit and push the version change, and tag again.

### Manual publish (fallback only)

Only needed when the workflow is unavailable. This path requires the `write:packages` scope, which the local credential does not carry by default:

```bash
gh auth status --hostname github.com
gh auth refresh --hostname github.com --scopes write:packages
```

Do not commit tokens or add registry credentials to repository files. Publish with the GitHub CLI token only for the current command:

```bash
env "npm_config_//npm.pkg.github.com/:_authToken=$(gh auth token --hostname github.com)" \
  npm publish --registry=https://npm.pkg.github.com
```

Verify the published version. This read requires the `read:packages` scope:

```bash
env "npm_config_//npm.pkg.github.com/:_authToken=$(gh auth token --hostname github.com)" \
  npm view @blazejpawlak/ksefctl@VERSION version --registry=https://npm.pkg.github.com
```

After publishing manually, remove the `write:packages` scope from the local credential if it is no longer needed.

## Key paths

- CLI entry: `src/cli.ts`
- Config: `src/config/*`
- Auth: `src/auth/*`
- API client: `src/api/ksefClient.ts`
- HTTP: `src/utils/http.ts`
- Rate limiting / adaptive polling: `src/utils/rateLimit.ts`
- Logging and rotation: `src/utils/logger.ts`
- Sync: `src/core/syncService.ts`, `src/core/syncSubjectRunner.ts`, `src/core/window.ts`
- Notifications: `src/notifications/*`
- Storage: `src/core/storage.ts`
- DB: `src/db/*`
- Tests: `tests/unit`, `tests/integration`

## Generated or vendor files

- `src/api/types.ts` is generated from OpenAPI. Do not edit manually.
- `vendor/open-api.json` is source for codegen. Do not edit manually.
- `dist/` is build output.

## Code style guidelines

General:

- Use TypeScript with strict typing.
- Prefer readability over cleverness.
- Use double quotes for strings and semicolons.
- Indentation: 2 spaces.
- Use trailing commas in multi-line lists and arguments.

Imports:

- Use `node:` prefix for built-in modules (e.g., `node:path`).
- Order imports as:
  1. type-only imports
  2. external packages
  3. Node built-ins
  4. internal/relative modules

Types and schemas:

- Use `type` aliases instead of `interface`.
- Use Zod schemas for runtime validation and `z.infer` for types.
- Avoid `any`. Use `unknown` when necessary.

Naming:

- Functions/variables: `camelCase`
- Types/classes: `PascalCase`
- Zod schemas: `PascalCase` with `Schema` suffix
- DB columns: `snake_case`

Exports:

- Use named exports only. No default exports.
- Export classes, functions, and types explicitly (`export class`, `export const`, `export type`).

Error handling:

- Use custom error types from `src/utils/errors.ts`.
- CLI commands should `try/catch` and set `process.exitCode` via `exitCodeFromError`.
- Do not call `process.exit()`.
- Preserve original error context; avoid swallowing exceptions.

Security and secrets:

- Never log tokens or sensitive data.
- Tokens are stored in OS keychain only; config does not contain secrets.
- Redact Authorization headers and signed URLs in logs.

HTTP and API:

- Base URL includes `/v2` (prod: `https://api.ksef.mf.gov.pl/v2`, test: `https://api-test.ksef.mf.gov.pl/v2`).
- Use `HttpClient` for requests and let it resolve relative paths.
- Preserve retry/backoff handling in `HttpClient`.

CLI behavior:

- `init` is the only command that bootstraps config and tokens.
- Other commands must require initialization (config + keychain tokens).
- `sync --force-redownload-all` resets cursors to `sync.initialSyncFrom` (or `2026-02-01`) and re-downloads available invoices.
- Missing invoice directories trigger a re-download even if DB marks them as downloaded.
- Progress spinner uses `ora` with `cli-spinners` (`dots`).

Storage:

- Storage is per NIP: `invoices/<NIP>/...`
- SQLite state is in `db/state.sqlite` under the storage root.

Testing:

- Use Vitest with `describe`/`it`.
- Unit tests should be self-contained and avoid shared state.
- Integration tests use MSW and `beforeAll`/`afterAll` for server lifecycle.
- Prefer temporary directories via `fs.mkdtemp` + `os.tmpdir`.

## Commit and review expectations

- Ensure `npm run build` passes for TypeScript changes.
- Before release, ensure `npm audit` reports zero vulnerabilities.
- Add or update tests for non-trivial logic changes.
- Keep README and docs consistent with behavior changes.
- This repository is hosted on GitHub.com; when using `gh`, set `GH_HOST=github.com` if the shell environment points to another GitHub host.
