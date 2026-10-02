# Roadmap

This covers what's left between this port and [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions), plus what EmDash and Cloudflare make possible beyond it. Estimates assume Claude doing the work with a human reviewing.

**Done so far:**
- the core document model and the [WordPress importer](README.md#import-from-wordpress);
- private titles kept out of public search;
- the **Document settings** page: default visibility, storage, cleanup;
- the lock check failing closed;
- `content:*` API tokens;
- multipart uploads up to 5 GB;
- Range and `304` requests;
- password rate limiting;
- queue-driven text extraction;
- revision feeds with per-user keys;
- admin list columns.

See the README's [parity table](README.md#parity-with-wp-document-revisions) and [platform constraints](README.md#platform-constraints). The EmDash changes that would remove workarounds are drafted in [docs/upstream-requests.md](docs/upstream-requests.md).

## Parity audit: remaining gaps

The audit covered WP Document Revisions' [feature list](https://github.com/wp-document-revisions/wp-document-revisions/blob/main/docs/features.md), its 77 filters and 11 actions, its shortcodes, blocks and widget, the block-editor sidebar, notifications, settings and admin list columns.

| WP Document Revisions | Status | Proposed approach | Est. |
|---|---|---|---|
| Shortcodes, blocks, widget: `[documents]`, `[document_revisions]`, Latest Documents | Missing | Portable Text blocks plus Astro components (native `portableTextBlocks` / `componentsEntry`). The listing reuses `filterPublicDocuments`. | 3–4h |
| `[document_preview]` | Missing | Portable Text block: PDF inline, other types as a download card, with an optional thumbnail (see Browser Rendering below). | 1–2h |
| Email notifications on new revisions and workflow changes, with recipients | Missing | Needs a mail transport; see Email Sending below. Recipients go on the Document settings page. | 2h |
| Lock-takeover email | Blocked | Core fires no takeover hook ([upstream request #2](docs/upstream-requests.md)). Until then, the panel could warn in-app. | 1h after the hook |
| Configurable permalink base (`document_slug`) | Missing | Option on `documentRevisionsRoutes({ base })`, applied to `injectRoute` and `permalink()`. | 1h |
| Featured image / thumbnail | Missing | An `image` field in the seed; automatic thumbnails via Browser Rendering. | 30m (field) |
| PDF/DOCX/ODT text extraction | Partial | The pipeline is built; plain-text formats extract locally. PDF and Office need a Workers AI binding (`ai-markdown` processor, already written, untested against a remote binding). | 30m to verify |
| Unified diff between revisions | Missing | Diff extracted text; render in the panel. | 1h |
| AI revision summaries | Missing | See Workers AI below. | 2h |
| Validate structure / `validate` CLI | Partial | The Document settings page finds orphans. Add "verify every manifest's objects exist" and a backfill to re-queue extraction. | 1h |
| Serve-time hooks (`serve_document_auth`, `document_serve`, headers) | Missing | An options object on `documentRevisionsRoutes()`, once a real extension need appears. | — |
| Abilities API → MCP | Partial | Core MCP covers entries. Add plugin `mcp.tools`: list revisions, fetch extracted text. | 1h |
| i18n | Missing | Lingui catalogs for admin strings. | 1–2h |
| Revision limit | Not planned | The port never deletes revisions, a stronger guarantee than WordPress's deletion guard. Add a limit only if asked. | — |
| gzip, upload directory, review prompt, onboarding, help tabs | N/A | Edge compression, the R2 bucket, and WordPress.org-specific UI respectively. | — |

### Other known gaps

| Gap | Why | Proposed fix | Est. |
|---|---|---|---|
| First-write race on a new manifest | Concurrent first writes, now less likely because the manifest is created when the entry is. | `onlyIf` on create, or a sentinel object. | 30m |
| Visibility isn't versioned | It lives in the manifest so a password can't leak through content APIs. | Log visibility changes as timeline events. | 30m |
| Public documents aren't in site search | `search` is off for the collection so that private titles can't leak. | AI Search (below), or [upstream request #4](docs/upstream-requests.md). | — |

## Cloudflare integrations

These are designs, ready to build once remote bindings (and their small usage costs) are OK'd. Local dev can't fully emulate them.

1. **Permission-aware content search (AI Search).**
   - **Indexing:** after extraction, the consumer writes `search/<entryId>.md` with R2 custom metadata `visibility`, `status` and `entry`, and rewrites it when visibility or status changes. An [AI Search](https://developers.cloudflare.com/ai-search/) instance over the bucket indexes only `search/**` (path filtering), with those as custom metadata fields.
   - **Querying:** a public search route filters `visibility=public AND status=published` for anonymous visitors, and widens the filter by role for signed-in users. Natural-language answers come from the same instance.
   - **Why it matters:** this fixes "public documents aren't in site search" and adds contents search, which WordPress never had.
   - **Limits:** plain text is indexed up to 10 MiB, which is why the pre-extracted Markdown is indexed rather than the original file.
2. **Extraction for every format (Workers AI `toMarkdown`).** Bind `AI` and the `ai-markdown` processor handles PDF, Office, spreadsheets, HTML and images (with OCR and descriptions). Test it against a remote binding, then add a backfill action.
3. **AI revision summaries and "ask this document".**
   - Workers AI over the diff of two revisions' extracted text pre-fills the revision note, with a per-document and a sitewide opt-out. Optionally routed through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching and logs.
   - Expose "summarize" and "ask" as plugin MCP tools that use the same permission checks.
4. **Email Sending provider plugin.**
   - A small EmDash email transport backed by the [`EMAIL` binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/). It benefits the whole site and unblocks the notifications above.
   - Needs Workers Paid and a verified sending domain.
5. **Thumbnails and previews (Browser Rendering).**
   - Render page one of PDFs and Office documents (via the extracted HTML) to PNG.
   - Store the image next to the file.
   - Use it in list cards, `[document_preview]` and the editor panel.
6. **Download analytics (Analytics Engine).** One data point per download (document, revision, anonymous or signed-in), with a small chart in the panel. WordPress had no equivalent.
7. **Retention and legal hold (R2 bucket locks).** For regulated libraries, lock the `entries/*/files/` prefix for a retention period so even an Admin purge can't delete files early. The storage page would need to explain why a purge partly fails. Investigate.
8. **Turnstile on the password form**, if rate limiting alone isn't enough for a public-facing site.

## Migration and quality

| Gap | Proposed approach | Est. |
|---|---|---|
| Unit tests and CI | Unit tests for `store.ts`, `access.ts` and `processing/`. Run [`scripts/verify.sh`](scripts/verify.sh) and [`scripts/verify-import.sh`](scripts/verify-import.sh) in CI against `astro dev`. | 2–3h |
| Publish to npm | Build step (tsdown), `peerDependencies`, install docs. | 1h |

## Can't match exactly

- **Custom capabilities** (`edit_documents`, `read_private_documents`, permissions based on a taxonomy): EmDash's five roles are fixed. Finer rules can be enforced in [`access.ts`](plugin/src/access.ts), but they won't show up in EmDash's user admin.
- **Edit Flow, PublishPress, Multisite, WPML:** no EmDash counterparts. Workflow states stay a taxonomy, and EmDash has its own i18n model.
- **Code Cookbook recipes:** each would be its own small plugin or a setting, not core parity work.
