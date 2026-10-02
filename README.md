# EmDash Document Revisions

A port of [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions) to [EmDash](https://github.com/emdash-cms/emdash): a document is a series of uploaded files with a revision log, stored privately and served through permission-checked permalinks.

**Status:** the core document behavior has parity with the WordPress plugin (see below). The rest of the WordPress feature set is tracked in [ROADMAP.md](ROADMAP.md). It's a rewrite: none of the PHP code carries over.

## Layout

- [`plugin/`](plugin/) — the `emdash-document-revisions` package, which has two halves because a native EmDash plugin can't inject site routes:
  - [`src/index.ts`](plugin/src/index.ts):
    - `documentRevisions()` is the EmDash plugin: the admin UI, plus lifecycle hooks for slug sync, cleanup on permanent delete, and uninstall.
    - `documentRevisionsRoutes()` is an Astro integration that injects the two routes below.
  - [`src/routes/document.ts`](plugin/src/routes/document.ts) — the permalinks (`/documents/…`), streamed from R2, and the password form.
  - [`src/routes/api.ts`](plugin/src/routes/api.ts) — `/_emdash/api/document-revisions/{revisions,upload,restore,visibility,me}`.
  - [`src/access.ts`](plugin/src/access.ts) — access rules, the core edit-lock check, and password hashing and cookies.
  - [`src/store.ts`](plugin/src/store.ts) — the private R2 store: file objects plus one JSON manifest per document, updated with an etag compare-and-swap.
  - [`src/admin.tsx`](plugin/src/admin.tsx) — the editor sidebar panel and the **Upload document** admin page.
- [`site/`](site/) — the EmDash Cloudflare starter, wired to the plugin. It adds:
  - a `documents` collection and a `workflow_state` taxonomy, in [`seed/seed.json`](site/seed/seed.json);
  - a `DOCUMENTS` R2 binding, in [`wrangler.jsonc`](site/wrangler.jsonc).
- [`scripts/verify.sh`](scripts/verify.sh) — end-to-end checks (77) against a local dev server.

## Run it

```sh
pnpm install
pnpm dev             # astro dev; open the dev-bypass URL it prints
scripts/verify.sh    # in another terminal
```

To add a document, either use **Upload document** in the admin sidebar, or create a Document and use the **Document revisions** panel in the editor sidebar.

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
3. Add the `documents` collection to your seed. Copy it from [`site/seed/seed.json`](site/seed/seed.json).
4. Set `EMDASH_ENCRYPTION_KEY`. EmDash already requires it, and it also signs the cookies for password-protected documents.

## Parity with WP Document Revisions

| WP Document Revisions | Here |
|---|---|
| `document` post type | `documents` collection in the seed (plugins can't create collections) |
| File per revision, revision log | An R2 object per upload. The manifest records number, author, note, size and time. The panel's log also shows EmDash's own revisions of the document's fields. |
| Restore a revision | Appends the old file as a new revision ("Restored revision N"), as WordPress does |
| `/documents/2011/08/tps-report.pdf`, `tps-report-revision-3.pdf` | Same URL shapes. The extensionless and date-prefixed forms also resolve, and a wrong extension still resolves. |
| Files hashed and stored outside the web root | Random object keys in a separate, private R2 bucket |
| Private / password-protected / public | Set per document in the panel. Private: Editors, Admins and the document's author. Password: PBKDF2-hashed, 10-day HttpOnly cookie, invalidated when the password changes. **Only the file is gated:** the title and summary of a published private document still show in EmDash's public search and listings ([ROADMAP](ROADMAP.md#gaps-found-while-building-core-parity)). |
| Drafts and past revisions | Contributor and up (core's `content:read_drafts`), and never more open than the current file. Everything else 404s, so slugs don't leak. |
| Authors edit only their own | Author: own documents; Editor and up: any (core's `edit_own` / `edit_any`) |
| Check-out lock | Core's entry edit lock, which the editor already acquires, renews and lets users take over. Uploads, restores and visibility changes are refused (409) while someone else holds it, which is the same rule core applies to saves. |
| Upload limit | Streamed to R2; 100 MB per file, about Cloudflare's request-body limit on Free and Pro |
| Workflow states | A taxonomy |
| Trash / delete | Trashed documents 404 but keep their files. Permanent delete removes the files, manifest and slug index. (Uninstall cleanup: see [ROADMAP.md](ROADMAP.md).) |
| Slug change | A hook re-indexes the slug, and core adds a 301 from the old URL |

## Platform constraints

1. **The media library is public by key.** `GET /_emdash/api/media/file/:key` serves any key in the media bucket without auth, and plugins can't hook it. That's why documents live in their own bucket, and why the seed's `file` field type isn't used.
2. **Plugin routes can't do this job.**
   - Private plugin routes require the `X-EmDash-Request: 1` header even on GET, so a plain `<a href>` gets a 403. Public plugin routes see no user.
   - Plugin request and response bodies are buffered and capped at 8 MiB.
   - Plugin contexts can't read core's edit lock.

   So the plugin injects ordinary Astro routes instead. The permalink is a site route, where EmDash's soft-auth middleware sets `locals.user`. The API lives under `/_emdash/api/`, where core's middleware authenticates every request and requires the CSRF header on writes.
3. **Anonymous requests get no content handlers.** On EmDash's anonymous fast path, `locals.emdash` has no database or handlers. Anonymous permalinks therefore resolve through `getEmDashEntry()`, which only returns published entries; that's all an anonymous visitor may see anyway.
4. **API tokens need the `admin` scope.** Core's middleware fails closed: an `/_emdash/api` path with no scope rule, like this plugin's, requires `admin`. A `content:read` or `content:write` token gets a 403, even for reads.
5. **The lock check reads core's table directly.** Core exposes no lock handler outside its own routes, so [`access.ts`](plugin/src/access.ts) queries `_emdash_entry_locks` the same way `EntryLockRepository.findEnforceable` does. If core changes that table, this check needs updating.
6. **Permissions are fixed.** Roles are fixed (Subscriber through Admin) and plugins can't define permissions. WordPress capabilities like `read_private_documents` become rules in [`access.ts`](plugin/src/access.ts).
7. **Editor panels only mount on saved entries.** That's why there's a separate **Upload document** page.
8. **Native plugin code doesn't hot-reload** under `astro dev`. Restart with `npx astro dev stop && npx astro dev`.
9. **Cloudflare only.** The R2 binding comes from `cloudflare:workers`. A Node deployment would need an S3 adapter.
10. **Password hashing is sized for the Free plan.** WebCrypto counts toward the Worker's CPU budget (about 10 ms on Free), so passwords use 20k PBKDF2 iterations (about 1.4 ms on an M-series Mac). These are shared access codes, not account passwords; WordPress stores post passwords in plaintext. The count is stored with each hash, so it can be raised later.

## Verification

[`scripts/verify.sh`](scripts/verify.sh) runs 77 checks against `pnpm dev`, using miniflare D1 and R2, on EmDash 1.1.0. They cover:

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
- API-token scopes;
- core field edits in the log.

In Chrome I also tested, by hand:
- the Upload document page;
- the panel's upload while the editor holds its own lock;
- restore and the password setting;
- publishing;
- a visitor unlocking the PDF.

Chrome's PDF viewer renders blank under `Content-Security-Policy: sandbox`, so PDFs are the one inline type served without it. `nosniff` stays on for everything.
