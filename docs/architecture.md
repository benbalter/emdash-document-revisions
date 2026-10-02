# How it works

Internals for contributors and for anyone deciding whether to trust this plugin on their site. For installing and using it, see the [README](../README.md).

## Code layout

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

## API

All endpoints use EmDash's authentication, CSRF and API-token rules. Responses use EmDash's `{ success, data | error }` envelope.

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

These are how EmDash 1.1 shapes the design. [upstream-requests.md](upstream-requests.md) drafts the EmDash changes that would remove the workarounds.

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
   - **Search:** the plugin injects an Astro middleware (`order: "post"`, after EmDash's own). It removes, from EmDash's public search and suggestion responses, every document the viewer couldn't open. Visitors find public documents, and authors and editors find the restricted ones they may open. If EmDash changes the response shape so documents can't be recognized, the filter returns no results rather than pass them through.
   - **Template listings:** in-process queries such as `getEmDashCollection("documents")` can't be intercepted, so templates that list documents must filter them (see [install step 5](../README.md#install-into-an-emdash-site)).
   - **Sitemaps** aren't affected: EmDash only builds them for collections with SEO enabled.
5. **The lock check calls EmDash's lock route internally.** EmDash exposes no lock API to plugins, so the plugin calls the handler behind `GET /_emdash/api/content/:collection/:id/lock` in-process, as the caller, using an internal package export. EmDash itself then decides whether locking is on, whether the lease has expired and who holds it. If a future EmDash moves that route, writes **fail closed** with a 503.
6. **Native plugins never get `plugin:uninstall`.** EmDash only runs it for marketplace installs. The Document settings page covers cleanup instead.
7. **Permissions are fixed.** EmDash's roles are fixed, and plugins can't define new permissions. WordPress capabilities like `read_private_documents` become rules in [`access.ts`](../plugin/src/access.ts).
8. **Revision feeds need plugin context.** Feed readers send no session, and anonymous site requests have no database. So the feed's permission check runs in a public plugin route (`feed-data`) called in-process, and the site route renders the Atom, because plugin raw responses can't serve XML.
9. **Feed keys and disabled users.** EmDash's plugin user API doesn't say whether an account is disabled. So the feed route reads `users.disabled` from the site's D1 binding (`DOCUMENT_D1_BINDING`, default `DB`), and refuses the feed if it can't tell. Revoking keys at offboarding is still good hygiene; Document settings can revoke everyone's.
10. **Password hashing is sized for Workers Free.** WebCrypto counts toward the Worker's CPU budget (about 10 ms on Free). These are shared access codes, not account passwords (WordPress stores post passwords in plaintext). Raise the cost on Workers Paid with `DOCUMENT_PASSWORD_ITERATIONS`. Existing hashes keep their own count.
11. **Native plugin code doesn't hot-reload** under `astro dev`, because EmDash loads it once. When the package is a linked checkout (as in this workspace), its integration watches its own source and restarts the dev server on changes, which takes about two seconds.

## Why a native plugin, not a sandboxed one

EmDash can run plugins in a sandbox: an isolated Worker that reaches the outside only through capabilities it declares, installable in one click from EmDash's registry. This plugin can't work that way today. A sandboxed plugin:
- has no private file storage: only EmDash's media library, which serves every file publicly by key;
- can't add site routes, so there are no plain-link downloads (private plugin routes need a CSRF header even on GET, and public ones don't know the visitor);
- is limited to 8 MiB bodies;
- can't render front-end blocks;
- can't read EmDash's edit lock or use Queues, rate limiting or Workers AI.

Moving only the declarative parts (hooks, settings, a Block Kit panel) into a sandbox would still need a trusted companion package for storage, permalinks and blocks, which keeps the security cost of native code.

| | Native (this plugin) | Sandboxed |
|---|---|---|
| Private storage, streaming, 5 GB uploads, permalinks, blocks | ✓ | ✗ |
| Install | npm + `astro.config` + redeploy | One click from the registry |
| Trust | Full access to the site, its database and secrets | Isolated; declared capabilities need the site owner's consent |
| EmDash upgrades | Relies on some EmDash internals (see constraints 4, 5, 8 and 9) | Stable plugin API only |
| Plan | Any Workers plan | Workers Paid (Worker Loader) |

So install it only from a source you trust, as with any native EmDash plugin. The EmDash changes that would make a sandboxed version possible are drafted in [upstream-requests.md](upstream-requests.md#6-what-a-sandboxed-version-would-need).

## Running outside Cloudflare

EmDash itself runs on Node (SQLite or Postgres, local or S3 storage). This plugin doesn't yet, because it uses Cloudflare bindings directly:
- the R2 bucket, through `cloudflare:workers`, including conditional writes and multipart uploads;
- `FixedLengthStream`;
- Queues;
- the rate limiter.

A Node version needs:
- a storage interface with R2, S3 and local-disk implementations;
- an in-process queue fallback;
- an in-memory rate limiter.

It's on the [roadmap](../ROADMAP.md#migration-and-quality).
