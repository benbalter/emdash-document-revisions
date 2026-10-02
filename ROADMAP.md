# Roadmap

This lists what's left between this port and [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions)' [feature list](https://github.com/wp-document-revisions/wp-document-revisions/blob/main/docs/features.md). The core document behavior is done; see the [README](README.md#parity-with-wp-document-revisions). Estimates assume Claude doing the work with a human reviewing.

## Gaps found while building core parity

Addressed so far: private titles kept out of public search and listings, uninstall cleanup (the **Document storage** page), the lock check failing closed, and `content:*` API tokens. See the README's [platform constraints](README.md#platform-constraints). The upstream changes that would remove the workarounds are drafted in [docs/upstream-requests.md](docs/upstream-requests.md).

| Gap | Why | Proposed fix | Est. |
|---|---|---|---|
| **No email when someone takes over your lock** | WordPress emails the previous holder on a lock takeover. Core's takeover fires no hook. | Upstream request #2. Until then, the panel could poll and warn in-app. | 1h after the hook exists |
| **Files over 100 MB** | Cloudflare rejects request bodies over the plan limit before the Worker runs (about 100 MB on Free and Pro, more on Business and Enterprise). | R2 multipart uploads: create, upload parts in ~50 MB chunks from the panel, complete. Or presigned S3-API URLs straight to R2. | 2–3h |
| **First-write race on a new manifest** | The first manifest write is unconditional, so two simultaneous first uploads can drop one. | Use R2's `onlyIf: { etagDoesNotMatch: "*" }`, if R2 supports it, or write a sentinel object first. | 30m |
| **Visibility isn't versioned** | Visibility lives in the manifest, not in the entry's fields, so a password can't leak through content APIs. As a result, EmDash's revisions don't record visibility changes. | Log visibility changes as timeline events in the manifest. | 30m |
| **Public documents aren't in site search** | The collection's `search` is off so that private titles can't leak. That also leaves public documents out of public search. | Upstream request #4, or a plugin-owned public search route that filters by visibility. | 2h |

## Front end and integration

| Gap | WP Document Revisions | Proposed approach | Est. |
|---|---|---|---|
| Revision RSS feed | Per-document feed of revisions, authenticated | `/documents/:slug/feed` site route, reusing `fileAccess()` for the same access rules | 1h |
| Shortcodes, blocks, widget | `[documents]`, `[document_revisions]`, Recently Revised Documents widget | Portable Text blocks plus Astro components (native plugin `portableTextBlocks` / `componentsEntry`) | 3–4h |
| `[document_preview]` | Inline document preview | Portable Text block that embeds the permalink (PDF inline, others as a download card) | 1–2h |
| Email notifications | New revision or workflow-state change, configurable recipients | `content:afterSave` / upload handler → `ctx.email.send()`. Needs an email-provider plugin on the site. | 2h |
| Settings page | Options screen | `admin.settingsSchema`: notification recipients, allowed file types, upload cap | 1h |
| MCP and AI-agent access | Abilities API, read-only over MCP | Plugin `mcp.tools` backed by read-only routes (list documents, list revisions, fetch metadata) | 1h |

## Text extraction and AI

| Gap | Proposed approach | Est. |
|---|---|---|
| PDF/DOCX/ODT text extraction with a cache | JS extractors (pdf.js, mammoth, an ODT XML reader) run from `cron` or a Queue consumer, cached in R2 next to each revision. Large PDFs may exceed Worker CPU limits; fall back to a Container. | 3–5h |
| Unified diff between revisions | Diff the extracted text and render it in the panel | 1h |
| AI revision summaries pre-filled into the note | Workers AI or a configured provider, with per-document and sitewide opt-outs | 2h |
| Backfill and validate commands | No WP-CLI equivalent, so these become admin-page actions or MCP tools | 1–2h |

## Migration and quality

| Gap | Proposed approach | Est. |
|---|---|---|
| **Import from WordPress** | EmDash's WXR importer puts attachments in the public media bucket. Instead, add an importer that reads WPDR's attachment history per document, streams each file into `DOCUMENTS`, and builds manifests with the original revision order, authors and dates. Keep the WP permalinks working; the date-prefixed form already resolves. This is what lets existing users actually switch. | 3–4h |
| Unit tests and CI | Unit tests for `store.ts` / `access.ts` with EmDash's plugin test runtime. Run [`scripts/verify.sh`](scripts/verify.sh) in CI against `astro dev`. | 2–3h |
| i18n | Admin strings through Lingui, EmDash's admin i18n, rather than GlotPress | 1–2h |
| Publish to npm | Build step (tsdown), `peerDependencies`, install docs (the README covers the manual steps) | 1h |

## Can't match exactly

- **Custom capabilities** (`edit_documents`, `read_private_documents`, permissions based on a taxonomy): EmDash's five roles are fixed. Finer rules can be enforced in [`access.ts`](plugin/src/access.ts), but they won't show up in EmDash's user admin.
- **Edit Flow, PublishPress, Multisite, WPML:** no EmDash counterparts. Workflow states stay a taxonomy, and EmDash has its own i18n model.
- **Code Cookbook recipes:** each would be its own small plugin or a setting, not core parity work.
