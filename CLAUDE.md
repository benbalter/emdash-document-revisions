# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A port of [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions) to [EmDash](https://github.com/emdash-cms/emdash) on Cloudflare Workers: versioned files in a private R2 bucket, served through permission-checked permalinks. The [README](README.md) is the source of truth for user-facing behavior and the permission matrix; [docs/architecture.md](docs/architecture.md) holds the code layout, the API table and the platform constraints. Read its "Platform constraints" section before changing how routing, storage or access works, since most odd-looking design choices are explained there.

## Layout

A pnpm workspace with two packages:

- [`plugin/`](plugin/) is the `emdash-document-revisions` package. It ships TypeScript source directly (`main` is `src/index.ts`), so there's no build step.
- [`site/`](site/) is a demo EmDash site (EmDash's blog template) that consumes the plugin as `workspace:*`. Its [`AGENTS.md`](site/AGENTS.md) and [`.agents/skills/`](site/.agents/skills/) are EmDash template docs (generic to EmDash sites and plugins, not this project). The `creating-plugins` skill's `references/` is useful for EmDash plugin APIs. [`site/.mcp.json`](site/.mcp.json) configures the EmDash docs MCP server; verify EmDash APIs against it rather than from memory.

## Commands

```sh
pnpm install
pnpm dev                       # astro dev in site/ (default port 4321)
pnpm typecheck                 # tsc --noEmit on the plugin
pnpm --filter site typecheck   # astro check on the demo site
pnpm test                      # unit + integration (Vitest); starts its own dev server
pnpm test:unit                 # plugin modules in workerd (@cloudflare/vitest-plugin), ~1s
pnpm test:integration          # HTTP tests against astro dev on port 4330
pnpm test:import               # WordPress importer; needs network (WordPress Playground), port 4331
pnpm vitest run tests/integration/feeds.test.ts -t "feed with the key"   # one file / one test
```

- Tests live in [`tests/`](tests/), configured in [`vitest.config.ts`](vitest.config.ts) as three projects. CI is [`.github/workflows/test.yml`](.github/workflows/test.yml).
- `unit` tests run inside workerd with a local `DOCUMENTS` R2 bucket; import plugin modules directly. `astro:middleware` is shimmed in [`tests/unit/shims/`](tests/unit/shims/).
- `integration` and `import` start their own `astro dev` from [`tests/support/dev-server.ts`](tests/support/dev-server.ts), with `--ignore-lock` (so astro stays in the foreground and doesn't touch a running `pnpm dev`) and separate Miniflare state under `site/.wrangler-test/` (via `EDR_STATE_DIR`, read in [`site/astro.config.mjs`](site/astro.config.mjs)). Setup generates a throwaway `EMDASH_ENCRYPTION_KEY` in `site/.dev.vars` if you have none, and removes it afterwards. Set `EDR_DEV_LOG=1` to see the server's output.
- Each role is a real user (`t-admin`, `t-editor`, `t-author`, `t-contributor`, `t-subscriber`, plus `t-other` as another owner/lock holder and `t-mutable` whose role the feed tests change) with its own session: dev-bypass signs in whoever has the `dev@emdash.local` email, so setup hands that email to each user in turn. Use `as("editor")` / `anon()` from [`tests/support/client.ts`](tests/support/client.ts); `makeDocument()` creates, uploads, sets visibility (public unless given) and publishes.
- Tests reach into the dev server's local D1 (`node:sqlite`) for owners, lock rows, roles and the like, and count R2 objects from Miniflare's sqlite index. Integration files run serially because some change site-wide state (edit locking, the lock table, default visibility, feed keys); restore it in `afterAll`.
- **Plugin code doesn't hot-reload, but the dev server restarts itself.** EmDash loads native plugin code once, so the plugin's integration watches `plugin/src` and restarts `astro dev` on changes (about 2s; watch `npx astro dev logs` for "restarting to reload the plugin"). If that ever misses a change, restart by hand: `npx astro dev stop && npx astro dev` from `site/`. A dev server can outlive its terminal; if a port is stuck, find it with `lsof -nP -iTCP:4329 -sTCP:LISTEN`.
- Local dev is fully offline: D1, R2, Queues and the rate limiter are emulated by Miniflare under `site/.wrangler/`. Delete that directory to reset local data.

## Architecture

The package has **two halves that must both be registered** in `astro.config.mjs` (see [`site/astro.config.mjs`](site/astro.config.mjs)):

1. `documentRevisions()` is the native EmDash plugin: admin UI ([`admin.tsx`](plugin/src/admin.tsx)), Portable Text blocks, lifecycle hooks, and the plugin-context routes (such as `feed-data`).
2. `documentRevisionsRoutes()` is an Astro integration. EmDash plugins can't inject site routes, buffer bodies at 8 MiB, require a CSRF header even on GET, and can't read the edit lock, so the real work happens in ordinary injected Astro routes:
   - `/documents/[...path]` → [`routes/document.ts`](plugin/src/routes/document.ts): permalinks (streamed from R2, Range/304), password form, Atom feeds. It's a site route so EmDash's soft-auth middleware identifies the user.
   - `/_emdash/api/content/documents/[id]/files/[...action]` → [`routes/files.ts`](plugin/src/routes/files.ts): the per-document API. It lives under EmDash's content namespace on purpose, so EmDash enforces auth, CSRF and `content:read`/`content:write` token scopes by path.
   - `/_emdash/api/document-revisions/[...action]` → [`routes/api.ts`](plugin/src/routes/api.ts): site-wide API. Outside the content namespace, EmDash fails closed to the `admin` token scope.
   - [`middleware.ts`](plugin/src/middleware.ts) (order `post`) filters document hits out of EmDash's public search results when the caller couldn't open them.

Each injected route's entrypoint must also appear in `plugin/package.json` `exports`, since routes are injected by package specifier.

Key modules:

- [`store.ts`](plugin/src/store.ts): the private `DOCUMENTS` R2 bucket. Each document has random-keyed file objects plus **one JSON manifest** (revision log, visibility, password hash). Writes are compare-and-swap on the manifest's etag. Visibility lives in this manifest, not in EmDash content, so password hashes can't leak through EmDash's content APIs.
- [`access.ts`](plugin/src/access.ts): every permission rule (WordPress capabilities mapped onto EmDash's fixed roles), password hashing and cookies, and the edit-lock check. The lock check reads EmDash's `_emdash_entry_locks` table directly and must **fail closed** (503) if that table changes.
- Anything a viewer can't open returns **404, not 403**, so slugs don't leak. The same rules cover permalinks, the revision log, extracted text, feeds, list columns, blocks and search.
- Anonymous requests have no database (EmDash's anonymous fast path), so anonymous permalinks resolve through `getEmDashEntry()`, which only returns published entries.
- [`blocks.ts`](plugin/src/blocks.ts) and [`astro/`](plugin/src/astro/): front-end blocks with viewer-aware data. [`visibility.ts`](plugin/src/visibility.ts) exports `filterPublicDocuments()` for site templates that list documents.
- [`worker.ts`](plugin/src/worker.ts) and [`processing/`](plugin/src/processing/): the `DOC_JOBS` queue consumer that extracts text (locally for plain text, via Workers AI for PDF, Office and images). Optional bindings (`DOC_JOBS`, `AI`, `DOC_PASSWORD_LIMIT`) switch their features off quietly when absent.
- The `documents` collection and `workflow_state` taxonomy are defined in [`site/seed/seed.json`](site/seed/seed.json), because plugins can't create collections. Sites copy them into their own seed.

WordPress import: [`scripts/wpdr-export.php`](scripts/wpdr-export.php) runs on the WordPress server (`wp eval-file`) and writes a bundle. [`scripts/import-wpdr.mjs`](scripts/import-wpdr.mjs) posts it to the `files/import` and `files/source` endpoints with an admin-scoped API token. Run `pnpm test:import` after touching either.

## Conventions

- `DOCUMENTS` must never be the EmDash media bucket: EmDash serves every media-bucket key publicly.
- Where a workaround exists only because of an EmDash limitation, record the upstream change that would remove it in [`docs/upstream-requests.md`](docs/upstream-requests.md), and keep the platform constraints in [docs/architecture.md](docs/architecture.md) in sync.
- Add tests for new behavior, and run `pnpm typecheck` plus `pnpm test` before a PR. Planned work and estimates are in [`ROADMAP.md`](ROADMAP.md).
