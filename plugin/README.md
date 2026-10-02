# emdash-document-revisions

Document management for [EmDash](https://github.com/emdash-cms/emdash): each document is a series of uploaded files with a revision log. Files are stored privately in R2 and served only through permission-checked permalinks.

A TypeScript port of [WP Document Revisions](https://github.com/wp-document-revisions/wp-document-revisions) for EmDash on Cloudflare Workers, with an importer that brings WordPress libraries over, history included.

> **Status: early.** Tested end to end against EmDash 1.1 in Cloudflare's local runtime, but not yet on a production deployment. APIs may change before 1.0, and it relies on a few EmDash internals that an EmDash upgrade could move ([details](https://github.com/benbalter/emdash-document-revisions#upgrading)). Not affiliated with EmDash or Cloudflare.

**Full documentation is in the [project README](https://github.com/benbalter/emdash-document-revisions#readme)**: features, permissions, configuration, deployment, troubleshooting and the WordPress importer. Internals and platform constraints are in [docs/architecture.md](https://github.com/benbalter/emdash-document-revisions/blob/main/docs/architecture.md).

## Install

Requires an EmDash 1.1 site on Cloudflare Workers with R2.

```sh
pnpm add emdash-document-revisions
```

1. Register both halves in `astro.config.mjs`. A native EmDash plugin can't inject site routes, so the permalink and API routes come from a separate Astro integration:
   ```js
   import { documentRevisions, documentRevisionsRoutes } from "emdash-document-revisions";

   integrations: [
     emdash({ /* database, storage, … */ plugins: [documentRevisions()] }),
     documentRevisionsRoutes(),
   ],
   ```
2. Add a `DOCUMENTS` R2 bucket in `wrangler.jsonc`. It must be a **different bucket** from EmDash's media bucket, which EmDash serves publicly by key.
3. Add the `documents` collection to your site: from the seed on a new site, or with [`scripts/setup-collection.mjs`](https://github.com/benbalter/emdash-document-revisions/blob/main/scripts/setup-collection.mjs) from the repository on an existing one. See [install step 3](https://github.com/benbalter/emdash-document-revisions#install-into-an-emdash-site).
4. If your templates list documents, filter them through `filterPublicDocuments()` from `emdash-document-revisions/visibility` (or use the Document list component). Otherwise private and password-protected titles appear publicly.

Text extraction, password throttling and the other optional bindings are covered in the [configuration reference](https://github.com/benbalter/emdash-document-revisions#configuration-reference).

This is a native plugin with full access to your site, its database and secrets. Install it only from a source you trust. [Why it isn't sandboxed](https://github.com/benbalter/emdash-document-revisions/blob/main/docs/architecture.md#why-a-native-plugin-not-a-sandboxed-one).

## License

[MIT](https://github.com/benbalter/emdash-document-revisions/blob/main/LICENSE)
