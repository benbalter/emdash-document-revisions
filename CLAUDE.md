# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A port of [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions) to [EmDash](https://github.com/emdash-cms/emdash) on Cloudflare Workers: versioned files in a private R2 bucket, served through permission-checked permalinks. The [README](README.md) is the source of truth for behavior, the permission matrix, the API table and the platform constraints; read its "Platform constraints" section before changing how routing, storage or access works, since most odd-looking design choices are explained there.

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
scripts/verify.sh              # ~150 end-to-end checks against the running dev site
scripts/verify-import.sh       # WordPress importer checks; needs network (WordPress Playground)
```

- Both verify scripts default to `http://localhost:4329`, not Astro's default 4321. Run `pnpm dev --port 4329`, or set `BASE_URL`.
- There's no unit-test runner and no way to run a single check. The verify scripts are bash with a `check name expected actual` helper; to focus on one area, comment out sections or copy the relevant block.
- The verify scripts mutate the local dev state directly: they change the dev user's role, insert users and lock rows with `sqlite3` on the Miniflare D1 file, and count R2 objects under `site/.wrangler/state/v3/`. They need `sqlite3` and `curl`, log in via EmDash's dev-bypass, and must never point at a real deployment.
- **Plugin code doesn't hot-reload.** After editing `plugin/src`, restart the dev server: `npx astro dev stop && npx astro dev` from `site/`. A dev server can outlive its terminal; if a port is stuck, find it with `lsof -nP -iTCP:4329 -sTCP:LISTEN`.
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

WordPress import: [`scripts/wpdr-export.php`](scripts/wpdr-export.php) runs on the WordPress server (`wp eval-file`) and writes a bundle. [`scripts/import-wpdr.mjs`](scripts/import-wpdr.mjs) posts it to the `files/import` and `files/source` endpoints with an admin-scoped API token. Run `scripts/verify-import.sh` after touching either.

## Conventions

- `DOCUMENTS` must never be the EmDash media bucket: EmDash serves every media-bucket key publicly.
- Where a workaround exists only because of an EmDash limitation, record the upstream change that would remove it in [`docs/upstream-requests.md`](docs/upstream-requests.md), and keep the README's platform constraints in sync.
- Add verify checks for new behavior, and run `pnpm typecheck` plus `scripts/verify.sh` before a PR. Planned work and estimates are in [`ROADMAP.md`](ROADMAP.md).
