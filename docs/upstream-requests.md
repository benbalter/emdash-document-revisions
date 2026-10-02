# Upstream requests for EmDash

These are drafts of issues for [emdash-cms/emdash](https://github.com/emdash-cms/emdash), none filed yet. Each one would remove a workaround in this plugin. They're ordered by how much they'd simplify things or reduce risk. Each is written to stand alone, so it can be filed as is.

---

## 1. Expose entry edit-lock state to plugins

**Problem.** A plugin that writes on behalf of an entry can't honor core's edit lock. `handleEntryLockRead` and `EntryLockRepository` aren't exported, aren't on `locals.emdash`, and aren't on the plugin context. To refuse writes while another user holds the lock, the same rule core applies to saves, a plugin has to query `_emdash_entry_locks` directly and duplicate `findEnforceable`'s join on `_emdash_collections.edit_locking`. That breaks silently if the table changes.

**Ask.** Any one of these:
- `ctx.content.getLock(collection, id)` on the plugin context, returning `{ holder, heldByCaller }`, gated by `content:read`; or
- `handleEntryLockRead` on `locals.emdash`, like the other content handlers; or
- an exported `assertEntryWritable(db, collection, id, userId)` that wraps the existing refusal logic.

**Workaround today.** A direct table read that fails closed with a 503 if the query errors ([`access.ts`](../plugin/src/access.ts)).

---

## 2. Hook for edit-lock takeover

**Problem.** WordPress emails the previous holder when someone takes over a post lock, so they know their unsaved work may conflict. EmDash's takeover (`POST …/lock` with `takeover: true`) fires no hook, so a plugin can't notify anyone.

**Ask.** A `content:afterLockTakeover` hook with `{ collection, id, previousHolder, newHolder }`, gated by `content:read`.

**Workaround today.** None. The previous holder finds out when their next save is refused.

---

## 3. Run `plugin:uninstall` (or an equivalent) for native plugins

**Problem.** `runPluginUninstallLifecycle` is only reached from the marketplace and registry uninstall routes. A native plugin removed from `astro.config` never runs its `plugin:uninstall` hook, so data it stored outside EmDash's tables (here, an R2 bucket) is orphaned.

**Ask.** Any one of these:
- an admin action that runs a native plugin's uninstall hook before the site owner removes it from config; or
- a documented `emdash plugin uninstall <id>` CLI command that runs the hook; or
- a note in the docs that native plugins must provide their own cleanup.

**Workaround today.** The **Document settings** admin page, with "delete orphaned files" and "delete all document files".

---

## 4. Per-entry read policy for public queries

**Problem.** There's no way to mark a *published* entry as hidden from anonymous reads. `content:beforePublish` and the other content-policy hooks gate state changes, not reads. A plugin that adds WordPress-style "private" or "password-protected" entries therefore can't keep their titles out of `/_emdash/api/search`, `/search/suggest`, or `getEmDashCollection()` results.

**Ask.** A read-side hook, such as `content:filterPublic(entries) → entries`, applied by the public search, suggest, live-collection and sitemap paths, gated by a capability like `hooks.content-visibility:register`. Or a core `visibility` column, which would also benefit sites without this plugin.

**Workaround today.** Search is turned off for the collection, and site templates filter listings through a helper.

---

## 5. Let plugins stream request and response bodies

**Problem.** Plugin route bodies are buffered and capped at 8 MiB (`PLUGIN_HTTP_MAX_REQUEST_BYTES` / `PLUGIN_HTTP_MAX_RESPONSE_BYTES`). That's reasonable for sandboxed plugins, but it also applies to native ones, so file-handling plugins have to inject their own Astro routes.

**Ask.** Allow native plugin routes to opt into streaming, e.g. `request: { body: "stream" }`, and return a `Response` directly.

**Workaround today.** Injected Astro routes under `/_emdash/api/content/…`, which also get core's auth, CSRF and token-scope handling.

---

## 6. What a sandboxed version would need

**Problem.** Sandboxed plugins are the safer, one-click way to extend EmDash, but a document library can't be one. Its core guarantee, private files behind permission-checked links, needs things only native plugins can do today. Each of these would also help other file-handling plugins:

1. **Plugin-private object storage.** A capability such as `storage:objects` that gives the plugin its own namespaced, non-public R2 prefix with streaming reads and writes, ranges, conditional writes and multipart uploads. Today a sandboxed plugin's only file storage is the media library, which serves every key publicly.
2. **Authenticated, link-friendly GET routes.** A route option such as `{ methods: ["GET"], linkable: true }`, for side-effect-free GETs that accept the session cookie without the `X-EmDash-Request` header. That makes plain `<a href>` downloads work, and they should see `routeCtx.user`. Today private routes need the header and public routes see no user.
3. **Streaming bodies.** Request and response streaming for routes that opt in (request #5), past the 8 MiB buffer.
4. **Edit-lock access.** Request #1, exposed to the sandbox as a capability.

With these, everything but the front-end block renderers could run sandboxed. Those could stay in a small trusted renderer package, or EmDash could let sandboxed plugins ship Portable Text renderers as declarative templates.
