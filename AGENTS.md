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

- No ESLint/Prettier/Biome configured. Do not introduce new tooling without discussion.

## Key paths

- CLI entry: `src/cli.ts`
- Config: `src/config/*`
- Auth: `src/auth/*`
- API client: `src/api/ksefClient.ts`
- HTTP: `src/utils/http.ts`
- Sync: `src/core/syncService.ts`
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
- Add or update tests for non-trivial logic changes.
- Keep README and docs consistent with behavior changes.
