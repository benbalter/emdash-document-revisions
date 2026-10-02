# EmDash Document Revisions (spike)

A feasibility spike: can [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions) work as an [EmDash](https://github.com/emdash-cms/emdash) plugin? Short answer: **yes, as a native plugin plus a site route.** It's a rewrite, and two WordPress guarantees need workarounds (below).

## Layout

- [`plugin/`](plugin/) — the `emdash-document-revisions` package
  - [`src/index.ts`](plugin/src/index.ts) — native plugin with `revisions`, `upload` and `lock` routes, and a slug-sync hook; also exports a small Astro integration that injects the permalink route
  - [`src/routes/document.ts`](plugin/src/routes/document.ts) — `/documents/:slug` and `/documents/:slug/revisions/:n`, permission-checked and streamed from R2
  - [`src/store.ts`](plugin/src/store.ts) — private R2 store: file objects plus a JSON revision manifest per entry, updated with etag compare-and-swap
  - [`src/admin.tsx`](plugin/src/admin.tsx) — editor sidebar panel to upload, check out/in, and list revisions
- [`site/`](site/) — EmDash Cloudflare starter wired to the plugin. It adds a `documents` collection and a `workflow_state` taxonomy in [`seed/seed.json`](site/seed/seed.json), and a `DOCUMENTS` R2 binding in [`wrangler.jsonc`](site/wrangler.jsonc).

## Run it

```sh
pnpm install
pnpm dev   # astro dev on the site; open the dev-bypass URL it prints
```

Create a Document, save it once, then use the **Document revisions** panel in the editor sidebar.

## What maps cleanly

| WP Document Revisions | Here |
|---|---|
| `document` post type | `documents` collection in the seed. Plugins can't create collections. |
| File per revision | R2 object per upload, plus a manifest with number, author, note and time |
| `/documents/slug` permalink, private files | Site route that streams from a **separate** R2 bucket |
| Draft/private gating | Published latest file: public. Drafts and past revisions: Contributor and up (core's `content:read_drafts`). Otherwise 404, so slugs don't leak. |
| Authors edit only their own | Enforced in the plugin routes (Author: own documents; Editor and up: any) |
| Workflow states | A taxonomy |
| Check-out lock | 15-minute lock in the manifest. Uploads by others get a 409. |
| Slug change | Hook re-indexes the slug, and core adds a 301 from the old one |

## Platform constraints found

1. **The media library is public by key.** `GET /_emdash/api/media/file/:key` serves any key in the media bucket without auth, and plugins can't hook it. Documents therefore go in their own bucket. The seed's `file` field type can't be used.
2. **Private plugin routes can't back a download link.** They require an `X-EmDash-Request: 1` header even on GET, so an `<a href>` returns 403. Public plugin routes see no user. The permalink is a site route instead, where EmDash's soft-auth middleware sets `locals.user`. Native plugin descriptors can't inject routes, hence the separate `documentRevisionsRoutes()` integration.
3. **Uploads are capped at 8 MiB.** Plugin route bodies are buffered with a hard 8 MiB cap (`PLUGIN_HTTP_MAX_REQUEST_BYTES`); a 9 MiB upload gets a 413. Lifting the cap needs presigned direct-to-R2 uploads or a site-level upload route. Downloads aren't affected because the site route streams.
4. **Permissions are fixed.** Roles are fixed (Subscriber through Admin) and plugins can't define permissions, so there's no `edit_documents` or `read_private_documents`. Finer rules live in plugin code.
5. **The panel needs a saved entry.** Editor panels only mount on saved entries, so the first upload happens after the first save.
6. **Native plugin code doesn't hot-reload** under `astro dev`. Restart with `npx astro dev stop && npx astro dev`.
7. **Cloudflare only.** The store reads the R2 binding via `cloudflare:workers`. A Node deployment would need an S3 adapter.

## Not in the spike

Text extraction and diffs, email notifications, a front-end block or list, WXR/WordPress import of revision files (EmDash's importer would put them in the public media bucket), deleting files when an entry is permanently deleted, and tests.

## Verified locally

The following was checked with curl and in the browser against `astro dev` (miniflare R2/D1), EmDash 1.1.0:

- Two-revision upload and log.
- Draft permalink: anonymous gets 404, admin gets 200.
- After publish: anonymous gets the latest file, but past revisions 404.
- The media route can't reach document keys.
- The 9 MiB upload gets a 413.
- Author uploading or locking someone else's document gets a 403.
- Missing parameter gets a 400.
- Slug rename: the new slug gets 200 and the old one 301.
- Browser: the panel upload of a PDF downloads back byte-identical and inline, and check-out/check-in works.
