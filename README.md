# EmDash Document Revisions

Document management for [EmDash](https://github.com/emdash-cms/emdash): each document is a series of uploaded files with a revision log. Files are stored privately and served only through permission-checked permalinks.

It's a port of [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions), the WordPress plugin, rewritten in TypeScript for EmDash on Cloudflare Workers. None of the PHP code carries over. A [WordPress importer](#import-from-wordpress) moves existing libraries over, history included.

> **Status: early.** Built and tested against EmDash 1.1 on Cloudflare Workers. It isn't published to npm yet, and APIs may change before 1.0. Not affiliated with EmDash or Cloudflare.

## Features

- **Versioned documents.** Every upload becomes a numbered revision with author, date and note. Restore any earlier revision.
- **Private storage.** Files live in their own R2 bucket and are only reachable through `/documents/…` permalinks, which check permissions on every request. This includes Range requests for PDF viewers and media players.
- **Visibility per document:** public, private (Editors, Admins and the author) or password-protected. New documents are private by default, as in WP Document Revisions.
- **WordPress-style permalinks.** `/documents/tps-report.pdf`, `/documents/tps-report-revision-3.pdf`, and the dated `/documents/2011/08/…` form.
- **Check-out locking** through EmDash's own edit lock. Nobody uploads over someone who's editing.
- **Large files.** Uploads up to 5 GB in resumable parts, with progress.
- **Revision feeds.** An Atom feed per document, authenticated with a per-user feed key.
- **Text extraction.** A queue extracts text from each upload: plain-text formats locally, and PDF, Office and images through [Workers AI](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) when bound.
- **Front-end blocks:** Document list, Latest documents (also a sidebar widget), Document revisions and Document preview.
- **Admin tools.** An editor panel, an Upload document page, File and Access columns in the documents list, and a Document settings page (default visibility, feed keys, storage cleanup).
- **WordPress importer** that keeps revision numbers, authors, dates, notes, visibility and workflow states, so old links keep working.

## Requirements

- Node.js 22.16 or later, and pnpm.
- An EmDash 1.1 site on **Cloudflare Workers** with R2. The plugin uses Cloudflare bindings directly; see [Running outside Cloudflare](#running-outside-cloudflare).
- Optional: Cloudflare Queues (text extraction), the Workers rate-limit binding (password throttling), and Workers AI (PDF/Office/image text).

## Quick start

This repository is a pnpm workspace: the plugin in [`plugin/`](plugin/), and a demo site in [`site/`](site/) built on EmDash's blog template.

```sh
pnpm install
pnpm dev             # starts astro dev; open the dev-bypass URL it prints to sign in
scripts/verify.sh    # end-to-end checks, in another terminal
```

To add a document, use **Upload document** in the admin sidebar, or create a Document and use the **Document revisions** panel in the editor's sidebar.

**No network needed.** After `pnpm install`, local development works offline. `astro dev` runs the site in Cloudflare's own runtime (workerd, via Miniflare), and D1, R2, Queues and the rate limiter are emulated on disk under `site/.wrangler/`. No Cloudflare account or login is needed. The exceptions:
- the blog theme's Google Fonts download once into `site/.astro/fonts` (offline with an empty cache, the site falls back to system fonts);
- `scripts/verify-import.sh` downloads WordPress through Playground;
- a Workers AI binding, if you add one, is remote.

## Install into an EmDash site

Until it's on npm, add the package from a local checkout, e.g. `pnpm add ../emdash-document-revisions/plugin`, or as a workspace package.

1. **Register both halves** in `astro.config.mjs`. A native EmDash plugin can't inject site routes, so the permalink and API routes come from a separate Astro integration.
   ```js
   import { documentRevisions, documentRevisionsRoutes } from "emdash-document-revisions";
   // ...
   integrations: [
     emdash({ /* database, storage, … */ plugins: [documentRevisions()] }),
     documentRevisionsRoutes(),
   ],
   ```
2. **Add a `DOCUMENTS` R2 bucket** in `wrangler.jsonc`. It must be a **different bucket** from EmDash's media bucket, because EmDash serves every media-bucket key publicly (see [constraint 1](#platform-constraints)).
3. **Add the `documents` collection** (and, if you want them, the `workflow_state` taxonomy) to your seed. Copy them from [`site/seed/seed.json`](site/seed/seed.json). Leave `search` out of the collection's `supports`; see [constraint 4](#platform-constraints).
4. **Set `EMDASH_ENCRYPTION_KEY`.** EmDash already requires it, and this plugin also signs password-protected documents' cookies with it.
5. **Listing documents in your own templates:** use the Document list component (as [`site/src/pages/documents/index.astro`](site/src/pages/documents/index.astro) does), or filter `getEmDashCollection("documents")` through `filterPublicDocuments()` from `emdash-document-revisions/visibility`. Otherwise private and password-protected titles appear in public listings.
6. **Optional, recommended:**
   - **Text extraction.** Add a `DOC_JOBS` queue (producer and consumer) to `wrangler.jsonc`, and add the consumer to your Worker entry:
     ```ts
     import { documentRevisionsQueue } from "emdash-document-revisions/worker";
     export default { ...handler, scheduled: createScheduledHandler(), queue: documentRevisionsQueue };
     ```
     To extract PDF, Office and images too, bind Workers AI as `AI`.
   - **Password throttling.** Add a `DOC_PASSWORD_LIMIT` [rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

   [`site/wrangler.jsonc`](site/wrangler.jsonc) and [`site/src/worker.ts`](site/src/worker.ts) show both. Without them, those features switch off quietly.

### Configuration reference

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `DOCUMENTS` | R2 bucket binding | Yes | Document files, revision manifests, settings and feed keys. Must not be the media bucket. |
| `EMDASH_ENCRYPTION_KEY` | Secret | Yes | Already required by EmDash; also signs password cookies. |
| `DOC_JOBS` | Queue (producer + consumer) | No | Text extraction after each upload. |
| `AI` | Workers AI binding | No | PDF, Office and image extraction (Markdown Conversion). Remote; incurs Workers AI usage. |
| `DOC_PASSWORD_LIMIT` | Rate-limit binding | No | Throttles password attempts per visitor and document (the demo allows 5 a minute). Cloudflare counts per location and approximately. |
| `DOCUMENT_MAX_FILE_BYTES` | Variable | No | Largest upload, default 5 GB. |
| `DOCUMENT_PASSWORD_ITERATIONS` | Variable | No | PBKDF2 cost for document passwords, default 20,000 (sized for Workers Free); 10,000–100,000. |

## Using it

- **Upload.** Use **Upload document** for a new document, or the **Document revisions** panel in the editor for a new version. EmDash only shows editor panels on saved entries. Files over 95 MB upload in parts automatically.
- **Revision log and restore.** The panel lists every file revision, plus EmDash's own edits to the title and other fields. **Restore** re-instates an older file as a new revision.
- **Visibility.** Set it per document in the panel. Admins set the default for new documents on **Document settings**.
- **Locking.** While someone has a document open in the editor, others can't upload, restore or change visibility. EmDash's editor shows who holds the lock and lets users take it over.
- **Feeds.** **Get feed link** in the panel creates your personal feed key. It's shown once, and you can replace or revoke it.
- **Blocks.** Type `/` in any rich-text field and choose **Document list**, **Latest documents**, **Document revisions** or **Document preview**. Latest documents also works in a sidebar widget area (as a content widget).
- **Document settings** (Admins):
  - the default visibility;
  - "Revoke all feed keys";
  - storage usage;
  - cleanup of files whose documents are gone;
  - "Delete all document files" before you remove the plugin.

### Who can do what

| | Visitor | Subscriber | Contributor | Author | Editor / Admin |
|---|---|---|---|---|---|
| Open a published, public document | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open a password-protected document | with password | with password | with password | own: ✓, others: with password | ✓ |
| Open a private document | — | own | own | own | ✓ |
| Open drafts and past revisions | — | — | ✓¹ | ✓¹ | ✓ |
| Upload, restore, change visibility | — | — | — | own | ✓ |
| Create documents with files (Upload document page)² | — | — | — | ✓ | ✓ |
| Get a revision-feed key | — | — | ✓ | ✓ | ✓ |
| Document settings, storage cleanup, WordPress import | — | — | — | — | Admin |

¹ Never more than the document's own visibility allows. Past revisions of a private document still need Editor or authorship, and of a password-protected one, the password or edit rights.
² Contributors can create document entries through EmDash's own screens (core's `content:create`), but attaching files takes Author.

Anything a viewer can't open returns a 404, so slugs don't leak. The same rules apply to the revision log, extracted text, feeds, list columns and front-end blocks.

## Import from WordPress

The importer moves documents with their full history. Every revision keeps its WP Document Revisions number, author, date and note, so old links like `/documents/2011/08/tps-report-revision-3.pdf` keep working.

1. **Export on the WordPress server**, where the document files are readable:
   ```sh
   wp eval-file scripts/wpdr-export.php ./wpdr-bundle
   ```
   - The export writes `wpdr-bundle/export.json` and `wpdr-bundle/files/`.
   - Add `--include-trash` to include trashed documents.
   - If a document file is missing on disk, the export stops and lists it; `--allow-missing` exports without those revisions.
   - Tested with WP Document Revisions 5.7, including a document upload directory outside the web root.

   WordPress's own export (WXR) can't do this: it leaves out post revisions, which are the revision log, and its attachment URLs point at files the plugin keeps private.

   > **The bundle is sensitive.** `export.json` holds WordPress's plaintext post passwords and users' emails, and `files/` holds every private document. Keep it off shared storage, never commit it, and delete it after importing.
2. **Create an API token** in EmDash (**Settings → API tokens**) with the `admin` scope, as an Administrator. Imports set authors and dates and look users up by email.
3. **Import:**
   ```sh
   EMDASH_TOKEN=ec_pat_… node scripts/import-wpdr.mjs ./wpdr-bundle --site https://your-site.example --dry-run
   EMDASH_TOKEN=ec_pat_… node scripts/import-wpdr.mjs ./wpdr-bundle --site https://your-site.example
   ```

| WordPress | EmDash |
|---|---|
| Title, slug, description, created and published dates | Entry title, slug, summary, `createdAt` / `publishedAt` |
| Document author | Entry owner, when an EmDash user has the same email; otherwise the importing Admin, with the WordPress name kept on each revision |
| Every revision: number, author, date, excerpt (the log note) | One revision each, numbered the same. Revisions that only changed the title or note share the previous file, stored once. |
| Published / private / password-protected / draft / scheduled / trashed | Published + public / published + private / published + password (the plaintext WordPress password is hashed on import) / draft / scheduled / trashed |
| Workflow states | `workflow_state` terms, created if missing |

Files over 95 MB are imported in parts. Documents with a file over the size limit (5 GB by default) are reported and skipped before anything is created. Re-running is safe:
- documents already imported (matched by WordPress ID) are skipped;
- a slug already used by another EmDash document is reported and left alone.

File names become `slug.ext`, as WP Document Revisions serves them, because WordPress renamed uploads to an MD5 hash and the original names are gone.

## Parity with WP Document Revisions

| WP Document Revisions | Here |
|---|---|
| `document` post type | `documents` collection in the seed (plugins can't create collections) |
| File per revision, revision log | An R2 object per upload, with a manifest of number, author, note, size and time |
| Restore a revision | Appends the old file as a new revision ("Restored revision N"), as WordPress does |
| Permalinks, including `-revision-N` and dated forms | Same URL shapes; extensionless links and wrong extensions also resolve |
| Files hashed and stored outside the web root | Random object keys in a separate, private R2 bucket |
| Public / private / password-protected, private by default | Same, per document; PBKDF2-hashed passwords with a 10-day HttpOnly cookie, invalidated when the password changes |
| Check-out lock and takeover | EmDash's entry edit lock (no takeover email yet: EmDash has no takeover hook) |
| Revision RSS feed with per-user key | Atom feed, key stored hashed, role checked on every request |
| `[documents]`, `[document_revisions]`, `[document_preview]`, Latest Documents widget | Portable Text blocks; Latest documents also works as a content widget |
| Admin list columns | File and Access columns |
| Text extraction | Queue-driven; Workers AI for PDF, Office and images |
| Workflow states | A taxonomy |
| Trash, delete, uninstall cleanup | Trash keeps files, permanent delete removes them, Document settings handles the rest |

Still to come: email notifications, configurable permalink base, diffs and AI summaries, and more. See [ROADMAP.md](ROADMAP.md).

## How it works

```
plugin/src/
  index.ts           documentRevisions() — the EmDash plugin: admin UI, Portable Text blocks, lifecycle hooks
                     documentRevisionsRoutes() — Astro integration that injects the three routes below
  routes/document.ts /documents/… permalinks (streamed from R2, Range/304), password form, Atom feeds
  routes/files.ts    per-document API under EmDash's content namespace
  routes/api.ts      site-wide API
  access.ts          access rules, EmDash edit-lock check, password hashing and cookies
  store.ts           private R2 store: files + one JSON manifest per document (etag compare-and-swap)
  blocks.ts, astro/  front-end blocks: viewer-aware data and Astro renderers
  processing/, worker.ts   text-extraction queue consumer and processors
  visibility.ts      filterPublicDocuments() for site templates
  admin.tsx          editor panel, Upload document and Document settings pages, list columns
```

**API.** All endpoints use EmDash's authentication, CSRF and API-token rules. Responses use EmDash's `{ success, data | error }` envelope.

| Endpoint | Purpose |
|---|---|
| `GET /_emdash/api/content/documents/:id/files` | Revision log, visibility, lock state |
| `POST …/files?filename=…&note=…` | Upload a revision (raw body, up to 95 MB) |
| `POST …/files/uploads`, `PUT …/uploads/:id/parts/:n`, `POST …/uploads/:id/complete`, `DELETE …/uploads/:id` | Multipart upload |
| `GET …/files/text?n=` | A revision's extracted text |
| `POST …/files/restore` | Restore revision `n` |
| `POST …/files/visibility` | Set public, private or password |
| `POST …/files/import`, `POST …/files/source` | WordPress import (Admins) |
| `GET /_emdash/api/document-revisions/me` | Caller's capabilities |
| `GET\|POST …/document-revisions/settings` | Site settings (Admins) |
| `GET …/document-revisions/columns?ids=` | List-column data |
| `GET\|POST\|DELETE …/document-revisions/feed-key`, `POST …/revoke-feed-keys` | Feed keys |
| `GET …/document-revisions/storage`, `POST …/purge-orphans`, `POST …/purge-all` | Storage maintenance (Admins) |

Per-document endpoints accept `content:read` / `content:write` API tokens. Site-wide ones need `admin`-scoped tokens.

## Platform constraints

These are how EmDash 1.1 shapes the design. [docs/upstream-requests.md](docs/upstream-requests.md) drafts the EmDash changes that would remove the workarounds.

1. **The media library is public by key.** `GET /_emdash/api/media/file/:key` serves any key in the media bucket without auth, and plugins can't hook it. That's why documents live in their own bucket, and why EmDash's `file` field type isn't used.
2. **Plugin routes can't do this job.** There are three reasons:
   - private plugin routes require the `X-EmDash-Request: 1` header even on GET, so a plain `<a href>` gets a 403, and public plugin routes see no user;
   - plugin bodies are buffered and capped at 8 MiB;
   - plugin contexts can't read EmDash's edit lock.

   So the package injects ordinary Astro routes:
   - **The permalink** is a site route, where EmDash's soft-auth middleware identifies the user.
   - **The per-document API** lives under EmDash's `/_emdash/api/content/` namespace. There, EmDash authenticates every request, requires the CSRF header on cookie writes, and maps token scopes by path.
   - **Site-wide actions** sit outside that namespace, where EmDash fails closed to the `admin` scope.
3. **Anonymous requests get no content handlers.** EmDash's anonymous fast path carries no database, to keep public pages fast. Anonymous permalinks resolve through `getEmDashEntry()`, which only returns published entries, and that's all an anonymous visitor may see anyway.
4. **Private titles.** Visibility lives in the plugin's private manifest, so a password hash can never leak through EmDash's content APIs, and EmDash has no per-entry read policy. So:
   - The `documents` collection doesn't enable `search`. Public search never returns documents; admin search still works through its plain-match fallback.
   - Templates that list documents must filter them (see [install step 5](#install-into-an-emdash-site)).
   - Sitemaps aren't affected: EmDash only builds them for collections with SEO enabled.
5. **The lock check reads EmDash's table directly** (`_emdash_entry_locks`), because EmDash exposes no lock API. If a future EmDash changes that table, writes **fail closed** with a 503.
6. **Native plugins never get `plugin:uninstall`.** EmDash only runs it for marketplace installs. The Document settings page covers cleanup instead.
7. **Permissions are fixed.** EmDash's roles are fixed, and plugins can't define new permissions. WordPress capabilities like `read_private_documents` become rules in [`access.ts`](plugin/src/access.ts).
8. **Revision feeds need plugin context.** Feed readers send no session, and anonymous site requests have no database. So the feed's permission check runs in a public plugin route (`feed-data`) called in-process, and the site route renders the Atom, because plugin raw responses can't serve XML.
9. **Feed keys and disabled users.** EmDash's plugin user API doesn't expose whether an account is disabled, so revoke a departing user's feed key, or everyone's on Document settings.
10. **Password hashing is sized for Workers Free.** WebCrypto counts toward the Worker's CPU budget (about 10 ms on Free). These are shared access codes, not account passwords (WordPress stores post passwords in plaintext). Raise the cost on Workers Paid with `DOCUMENT_PASSWORD_ITERATIONS`. Existing hashes keep their own count.
11. **SSO.** EmDash supports [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) as a login method, and every rule here uses EmDash's roles. So private documents work behind SSO with no changes.
12. **Native plugin code doesn't hot-reload** under `astro dev`. Restart it with `npx astro dev stop && npx astro dev`.

### Running outside Cloudflare

EmDash itself runs on Node (SQLite or Postgres, local or S3 storage). This plugin doesn't yet, because it uses Cloudflare bindings directly:
- the R2 bucket, through `cloudflare:workers`, including conditional writes and multipart uploads;
- `FixedLengthStream`;
- Queues;
- the rate limiter.

A Node version needs:
- a storage interface with R2, S3 and local-disk implementations;
- an in-process queue fallback;
- an in-memory rate limiter.

It's on the [roadmap](ROADMAP.md#migration-and-quality).

## Testing

Both suites run against a local `pnpm dev`. They change the local dev database (roles, lock rows), so never point them at a real site.

- [`scripts/verify.sh`](scripts/verify.sh) runs 151 end-to-end checks:
  - permalinks, plus Range and conditional requests;
  - public, private, password and draft access for every role;
  - cache headers;
  - single and multipart uploads, including 150 MiB round trips;
  - restore;
  - EmDash edit-lock refusals and the lock check failing closed;
  - ownership;
  - trash and permanent delete;
  - recycled slugs;
  - CSRF;
  - API-token scopes;
  - password throttling;
  - text extraction;
  - default visibility;
  - list columns;
  - revision feeds and keys;
  - storage cleanup;
  - the front-end blocks, as a visitor, a subscriber and an admin.
- [`scripts/verify-import.sh`](scripts/verify-import.sh) runs 36 checks:
  - It seeds a real WordPress with the released WP Document Revisions in [Playground](https://wordpress.org/playground/), using a document directory outside the web root.
  - It exports, imports twice, and checks files, revision numbers, authors, notes, visibility, status, workflow states, oversize handling and idempotency.
- `pnpm typecheck` type-checks the plugin.

## Contributing

Issues and pull requests are welcome. Before opening a PR:
- run `pnpm typecheck` and `scripts/verify.sh`, and `scripts/verify-import.sh` if you touched the importer;
- add checks for new behavior.

Explain *why* in commit messages and PR descriptions. [ROADMAP.md](ROADMAP.md) lists what's planned, with estimates.

## Security

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability**, not in a public issue.

## License

[MIT](LICENSE). WP Document Revisions, the WordPress plugin this ports, is GPL-licensed; no code from it is included here.
