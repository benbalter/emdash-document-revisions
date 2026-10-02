# EmDash Document Revisions

A port of [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions) to [EmDash](https://github.com/emdash-cms/emdash): a document is a series of uploaded files with a revision log, stored privately and served through permission-checked permalinks.

**Status:** the core document behavior has parity with the WordPress plugin (see below). The rest of the WordPress feature set is tracked in [ROADMAP.md](ROADMAP.md). It's a rewrite: none of the PHP code carries over.

## Layout

- [`plugin/`](plugin/) — the `emdash-document-revisions` package, which has two halves because a native EmDash plugin can't inject site routes:
  - [`src/index.ts`](plugin/src/index.ts):
    - `documentRevisions()` is the EmDash plugin: the admin UI, plus lifecycle hooks for slug sync, cleanup on permanent delete, and uninstall.
    - `documentRevisionsRoutes()` is an Astro integration that injects the three routes below.
  - [`src/routes/document.ts`](plugin/src/routes/document.ts) — the permalinks (`/documents/…`), streamed from R2 with Range support, the password form, and revision feeds (`/documents/:slug/feed`).
  - [`src/routes/files.ts`](plugin/src/routes/files.ts) — per-document API under core's content namespace: `/_emdash/api/content/documents/:id/files` (log, upload), `…/uploads/*` (multipart), `…/text`, `…/restore`, `…/visibility`, `…/import`.
  - [`src/routes/api.ts`](plugin/src/routes/api.ts) — site-wide API: `/_emdash/api/document-revisions/{me,settings,columns,feed-key,storage,purge-orphans,purge-all}`.
  - [`src/visibility.ts`](plugin/src/visibility.ts) — `filterPublicDocuments()` for site templates that list documents.
  - [`src/blocks.ts`](plugin/src/blocks.ts) and [`src/astro/`](plugin/src/astro/) — the front-end blocks: viewer-aware data plus their Astro renderers (`emdash-document-revisions/astro`, wired through the descriptor's `componentsEntry`).
  - [`src/processing/`](plugin/src/processing/) and [`src/worker.ts`](plugin/src/worker.ts) — the text-extraction queue consumer (`emdash-document-revisions/worker`) and its processors.
  - [`src/access.ts`](plugin/src/access.ts) — access rules, the core edit-lock check, and password hashing and cookies.
  - [`src/store.ts`](plugin/src/store.ts) — the private R2 store: file objects plus one JSON manifest per document, updated with an etag compare-and-swap.
  - [`src/admin.tsx`](plugin/src/admin.tsx) — the editor sidebar panel, plus the **Upload document** and **Document settings** admin pages.
- [`site/`](site/) — EmDash's Cloudflare **blog** template (styled; the starter template has no CSS by design), wired to the plugin. It adds:
  - a `documents` collection and a `workflow_state` taxonomy, in [`seed/seed.json`](site/seed/seed.json);
  - a `DOCUMENTS` R2 binding, in [`wrangler.jsonc`](site/wrangler.jsonc);
  - a public `/documents` library page ([`src/pages/documents/index.astro`](site/src/pages/documents/index.astro)) built from the Document list block, plus a **Documents** menu link.
- [`scripts/wpdr-export.php`](scripts/wpdr-export.php) and [`scripts/import-wpdr.mjs`](scripts/import-wpdr.mjs) — migrate from WP Document Revisions; see [Import from WordPress](#import-from-wordpress).
- [`scripts/verify.sh`](scripts/verify.sh) — end-to-end checks (151) against a local dev server. [`scripts/verify-import.sh`](scripts/verify-import.sh) checks the importer (36) against a real WordPress in [Playground](https://wordpress.org/playground/).

## Run it

```sh
pnpm install
pnpm dev             # astro dev; open the dev-bypass URL it prints
scripts/verify.sh    # in another terminal
```

To add a document, either use **Upload document** in the admin sidebar, or create a Document and use the **Document revisions** panel in the editor sidebar.

**Offline.** After `pnpm install`, local development needs no network. `astro dev` runs the site in Cloudflare's own runtime (workerd, via Miniflare), with D1, R2, Queues and the rate limiter emulated on disk under `site/.wrangler/`. No Cloudflare account or login is needed. `scripts/verify.sh` passes all its checks with outbound network blocked. The exceptions:
- the blog theme's Google Fonts are downloaded once into `site/.astro/fonts`; with an empty cache and no network the site still works, using system fonts;
- `scripts/verify-import.sh` downloads WordPress through Playground;
- the optional Workers AI binding is remote by nature.

## Install into an EmDash site

1. Add the package and register both halves in `astro.config.mjs`:
   ```js
   import { documentRevisions, documentRevisionsRoutes } from "emdash-document-revisions";
   // ...
   integrations: [
     emdash({ /* ... */ plugins: [documentRevisions()] }),
     documentRevisionsRoutes(),
   ],
   ```
2. Add a `DOCUMENTS` R2 bucket binding to `wrangler.jsonc`. It must be a **different bucket** from the media bucket; see constraint 1 below.
3. Add the `documents` collection to your seed. Copy it from [`site/seed/seed.json`](site/seed/seed.json). Leave `search` out of its `supports`; see "Private titles" below.
4. Set `EMDASH_ENCRYPTION_KEY`. EmDash already requires it, and it also signs the cookies for password-protected documents.
5. If your site lists documents, filter the list through `filterPublicDocuments()` (see the [example page](site/src/pages/documents/index.astro)).
6. **Optional but recommended:**
   - **Text extraction.** Add a `DOC_JOBS` queue (producer and consumer) to `wrangler.jsonc`, and export the consumer from your Worker entry: `queue: documentRevisionsQueue` from `emdash-document-revisions/worker` (see [`site/src/worker.ts`](site/src/worker.ts)). Plain-text formats are extracted as-is. For PDF, Office documents and images (OCR plus a description), also bind Workers AI as `AI`; extraction then uses [Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/).
   - **Password brute-force protection.** Add a `DOC_PASSWORD_LIMIT` [rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (the example allows 5 attempts per minute per visitor and document). Cloudflare counts per location and approximately, so treat it as throttling, not an exact cap.

   Both are in [`site/wrangler.jsonc`](site/wrangler.jsonc). Without them, those features quietly turn off.

## Import from WordPress

The importer moves documents with their full history: every revision keeps its WP Document Revisions number, author, date and note. Old links like `/documents/2011/08/tps-report-revision-3.pdf` keep working.

1. **Export on the WordPress server**, where the document files are readable:
   ```sh
   wp eval-file wpdr-export.php ./wpdr-bundle
   ```
   This writes `wpdr-bundle/export.json` and `wpdr-bundle/files/`. Add `--include-trash` to bring trashed documents too. If any document file is missing on disk, the export stops and lists them; `--allow-missing` exports without those revisions. Tested with WP Document Revisions 5.7, including a document upload directory outside the web root.

   > **The bundle is sensitive.** `export.json` holds WordPress's plaintext post passwords and users' emails, and `files/` holds every private document. Keep it off shared storage, never commit it, and delete it once the import is done. WordPress's own export (WXR) can't do this: it leaves out post revisions, which are the revision log, and its attachment URLs point at files the plugin keeps private.
2. **Create an API token** in EmDash (**Settings → API tokens**) with the `admin` scope, as an Administrator. Imports set authors and dates, and look users up by email.
3. **Import:**
   ```sh
   EMDASH_TOKEN=ec_pat_… node scripts/import-wpdr.mjs ./wpdr-bundle --site https://your-site.example --dry-run
   EMDASH_TOKEN=ec_pat_… node scripts/import-wpdr.mjs ./wpdr-bundle --site https://your-site.example
   ```

What carries over:

| WordPress | EmDash |
|---|---|
| Title, slug, description, created and published dates | Entry title, slug, summary, `createdAt` / `publishedAt` |
| Document author | Entry owner, when an EmDash user has the same email; otherwise you are the owner and the WordPress name stays on the revisions |
| Every revision: number, author, date, excerpt (the log note) | One revision each, numbered the same. Revisions that only changed the title or note share the previous file, which is stored once. |
| Published / private / password-protected / draft / scheduled / trashed | Published / published + private / published + password (the plaintext WordPress password is hashed on import) / draft / scheduled / trashed |
| Workflow states | `workflow_state` terms, created if missing |

Documents with a file over the upload limit (100 MB) are reported and skipped before anything is created. Re-running is safe: documents already imported (matched by WordPress ID) are skipped. A slug already used by another EmDash document is reported and left alone. File names become `slug.ext`, as WP Document Revisions serves them, because WordPress renamed uploads to an MD5 and the original names are gone.

## Parity with WP Document Revisions

| WP Document Revisions | Here |
|---|---|
| `document` post type | `documents` collection in the seed (plugins can't create collections) |
| File per revision, revision log | An R2 object per upload. The manifest records number, author, note, size and time. The panel's log also shows EmDash's own revisions of the document's fields. |
| Restore a revision | Appends the old file as a new revision ("Restored revision N"), as WordPress does |
| `/documents/2011/08/tps-report.pdf`, `tps-report-revision-3.pdf` | Same URL shapes. The extensionless and date-prefixed forms also resolve, and a wrong extension still resolves. |
| Files hashed and stored outside the web root | Random object keys in a separate, private R2 bucket |
| Private / password-protected / public | Set per document in the panel. Private: Editors, Admins and the document's author. Password: PBKDF2-hashed, 10-day HttpOnly cookie, invalidated when the password changes. One rule covers every file surface (downloads, revision log, extracted text, feeds, list columns), so a password-protected document's notes and text don't leak to users who can't open it. Titles stay out of public search and listings too; see "Private titles" below. Inside the admin, Contributors still see every document's title and summary through EmDash's own content screens. |
| Drafts and past revisions | Contributor and up (core's `content:read_drafts`), and never more open than the current file. Everything else 404s, so slugs don't leak. |
| Authors edit only their own | Author: own documents; Editor and up: any (core's `edit_own` / `edit_any`) |
| Check-out lock | Core's entry edit lock, which the editor already acquires, renews and lets users take over. Uploads, restores and visibility changes are refused (409) while someone else holds it, which is the same rule core applies to saves. |
| Upload limit | Up to 95 MB in one request. Larger files go to R2 in 50 MB parts (multipart upload, with progress and retries), up to 5 GB by default (`DOCUMENT_MAX_FILE_BYTES`). The importer does the same. |
| New documents private by default | **Document settings** page (Admins): "New documents are private", the default as in WP Document Revisions, or public. |
| Revision RSS feed with feed key | `/documents/:slug/feed?key=…` (Atom). Each user gets a secret key from the panel (shown once, revocable, stored hashed); the feed checks the user's current role and the document's visibility on every request. EmDash's plugin user lookup doesn't expose disabled accounts, so revoke a departing user's key (or everyone's, on the Document settings page). |
| Admin list columns | **File** (type, size, revisions) and **Access** (visibility, who's editing) in the Documents list. |
| Text extraction | A queue extracts text from every upload. The panel shows its status, and `GET …/files/text?n=` returns it. Plain-text formats are extracted locally (the first 25 MB of a larger file, marked truncated). PDF, Office and images need a Workers AI binding; files over 25 MB are skipped there, so a huge upload never exhausts a Worker's memory. |
| Shortcodes, blocks and widget | Four Portable Text blocks in the editor's slash menu: **Document list** (`[documents]`: workflow-state filter, order, summaries, type and size, new tab, Edit links for editors), **Latest documents** (the widget; also works in a sidebar as a content widget), **Document revisions** (`[document_revisions]`) and **Document preview** (`[document_preview]`: PDFs and images inline, password prompt or "no access" otherwise). Each block applies the permalink rules for whoever is viewing the page. They ship small, zero-specificity default styles that any theme overrides. |
| Streaming | Range requests (`206`, used by PDF viewers and media players) and `304` for an unchanged file, straight from R2. |
| Workflow states | A taxonomy |
| Migration | [Import from WordPress](#import-from-wordpress): full revision history, original numbering, authors, dates, notes, visibility and workflow states |
| Trash / delete / uninstall | Trashed documents 404 but keep their files. Permanent delete removes the files, manifest and slug index. The **Document settings** page (Admins) shows usage, deletes files whose documents are gone, and can delete everything before you remove the plugin. |
| Slug change | A hook re-indexes the slug, and core adds a 301 from the old URL |

## Platform constraints

These are how EmDash 1.1 shapes the design. [docs/upstream-requests.md](docs/upstream-requests.md) drafts the changes that would remove the workarounds.

1. **The media library is public by key.** `GET /_emdash/api/media/file/:key` serves any key in the media bucket without auth, and plugins can't hook it. That's why documents live in their own bucket, and why the seed's `file` field type isn't used.
2. **Plugin routes can't do this job.**
   - Private plugin routes require the `X-EmDash-Request: 1` header even on GET, so a plain `<a href>` gets a 403. Public plugin routes see no user.
   - Plugin request and response bodies are buffered and capped at 8 MiB.
   - Plugin contexts can't read core's edit lock.

   So the package injects ordinary Astro routes instead. The permalink is a site route, where EmDash's soft-auth middleware sets `locals.user`. The per-document API lives under core's own `/_emdash/api/content/` namespace, where core's middleware authenticates every request, requires the CSRF header on cookie writes, and maps API-token scopes by path. So `content:read` tokens can read revision logs and `content:write` tokens can upload, exactly as on core content routes. The site-wide storage actions live outside that namespace, so they need an `admin`-scoped token (core fails closed on paths it has no rule for).
3. **Anonymous requests get no content handlers.** On EmDash's anonymous fast path, `locals.emdash` has no database or handlers. That's deliberate on EmDash's part (it keeps public pages fast), so this isn't worked around. Anonymous permalinks resolve through `getEmDashEntry()`, which only returns published entries, and that's all an anonymous visitor may see anyway.
4. **Private titles.** Visibility lives in the plugin's private manifest, so a password hash can never leak through EmDash's content APIs, and core has no per-entry read policy. Two consequences, both handled:
   - **Search:** the `documents` collection doesn't enable `search`, so public search and suggestions never return documents, public or not. Admin search in the content list still works: it falls back to a plain match when search is off.
   - **Listings:** `getEmDashCollection("documents")` returns every published document. Filter through `filterPublicDocuments()` before rendering, as the [example page](site/src/pages/documents/index.astro) does.

   The sitemap isn't affected: core only builds sitemaps for collections with SEO enabled, and `documents` doesn't have it.
5. **The lock check reads core's table directly.** Core exposes no lock handler outside its own routes, so [`access.ts`](plugin/src/access.ts) queries `_emdash_entry_locks` the same way `EntryLockRepository.findEnforceable` does. If a future EmDash renames or removes that table, writes **fail closed** with a 503 rather than skipping the check. The revision log stays readable.
6. **Native plugins never get `plugin:uninstall`.** EmDash only runs it for marketplace and registry installs. The **Document settings** admin page covers the same ground. The hook is still registered in case the plugin ships through the registry.
7. **Permissions are fixed.** Roles are fixed (Subscriber through Admin) and plugins can't define permissions. WordPress capabilities like `read_private_documents` become rules in [`access.ts`](plugin/src/access.ts).
8. **Editor panels only mount on saved entries.** That's why there's a separate **Upload document** page.
9. **Native plugin code doesn't hot-reload** under `astro dev`. Restart with `npx astro dev stop && npx astro dev`.
10. **Cloudflare only, for now.** EmDash itself runs on Node too (SQLite or Postgres, local or S3 storage). This plugin doesn't yet, because it talks to Cloudflare bindings directly:
    - the `DOCUMENTS` R2 bucket via `cloudflare:workers`, including R2 conditional writes and multipart uploads;
    - `FixedLengthStream`;
    - the `DOC_JOBS` queue;
    - the rate limiter.

    Porting means a small storage interface with R2, S3 (MinIO, AWS) and local-disk implementations, an in-process fallback for the queue, and an in-memory rate limiter. See [ROADMAP](ROADMAP.md#migration-and-quality). It also opens doors: see [Cloudflare integrations](ROADMAP.md#cloudflare-integrations).
11. **Password hashing is sized for the Free plan.** WebCrypto counts toward the Worker's CPU budget (about 10 ms on Free), so passwords default to 20k PBKDF2 iterations (about 1.4 ms on an M-series Mac). These are shared access codes, not account passwords; WordPress stores post passwords in plaintext. On Workers Paid, raise the count with the `DOCUMENT_PASSWORD_ITERATIONS` variable (10k–100k). The count is stored with each hash, so existing passwords keep working.
12. **SSO for private documents.** EmDash supports [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) as a login method. Because every rule here uses EmDash's own roles, private documents work behind your SSO with no changes.
13. **Revision feeds need plugin context.** Feed readers send no session, and anonymous site requests get no database. So the feed's permission check runs in a public plugin route (`feed-data`, which has the users and content APIs), called in-process; the site route renders the Atom, since plugin raw responses can't serve XML.

## Verification

[`scripts/verify.sh`](scripts/verify.sh) runs 151 checks against `pnpm dev`, using miniflare D1 and R2, on EmDash 1.1.0. They cover:

- permalink shapes;
- draft, private and password access for each role;
- cache headers;
- 30 MiB round-trips and the 100 MiB limit;
- restore;
- core-lock refusals, including with locking switched off;
- ownership;
- trash, restore and permanent-delete cleanup;
- recycled slugs;
- CSRF;
- API-token scopes (`content:read`, `content:write`, `admin`);
- core field edits in the log;
- documents kept out of public search, and listings filtered by visibility;
- storage admin: role gating, orphan cleanup, the purge confirmation;
- the lock check failing closed when core's table is missing;
- Range, `416` and `304`; 150 MiB multipart uploads, aborts and lock/ownership refusals; the password rate limit; queue-driven text extraction; the default-visibility setting; list columns; revision feeds and their keys.

In Chrome I also tested, by hand:
- the Upload document page;
- the panel's upload while the editor holds its own lock;
- restore and the password setting;
- publishing;
- a visitor unlocking the PDF.

Chrome's PDF viewer renders blank under `Content-Security-Policy: sandbox`, so PDFs are the one inline type served without it. `nosniff` stays on for everything.
