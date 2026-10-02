/// <reference types="astro/client" />
/// <reference types="emdash/locals" />
/**
 * Post-filters EmDash's public search so documents can stay searchable
 * without leaking private or password-protected titles: EmDash has no
 * per-entry read policy, so drop any document hit the caller couldn't open.
 * Injected by documentRevisionsRoutes() with order "post", so it runs after
 * EmDash's own middleware has resolved the session user.
 */
import { defineMiddleware } from "astro:middleware";

import { canEdit, canReadPrivate, getEntry } from "./access";
import { bucket, COLLECTION, readManifest, readSettings, visibilityOf } from "./store";

const SEARCH_PATHS = new Set(["/_emdash/api/search", "/_emdash/api/search/suggest"]);

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();
	const path = context.url.pathname.replace(/\/+$/, "");
	if (!SEARCH_PATHS.has(path) || !response.ok) return response;
	const body = (await response.clone().json().catch(() => null)) as
		| { success?: boolean; data?: { items?: Array<Record<string, unknown>> } }
		| null;
	const items = body?.data?.items;
	// Fail closed: if EmDash changes this response's shape, we can't tell which
	// hits are documents, so return no results rather than risk leaking titles.
	if (!Array.isArray(items) || !items.every((i) => typeof i?.collection === "string" && i.id != null)) {
		console.error("[document-revisions] unrecognized search response; returning no results");
		return Response.json({ success: true, data: { items: [] } }, { status: 200, headers: { "Cache-Control": "private, no-store" } });
	}
	if (!items.some((i) => i.collection === COLLECTION)) return response;

	const user = context.locals.user;
	const b = await bucket();
	const { defaultVisibility } = await readSettings(b);
	const keep = await Promise.all(
		items.map(async (item) => {
			if (item.collection !== COLLECTION) return true;
			const { manifest } = await readManifest(b, String(item.id));
			const mode = manifest ? visibilityOf(manifest).mode : defaultVisibility;
			if (mode === "public") return true;
			if (!user) return false;
			// Search results don't carry the author; look it up so authors still
			// find their own private and password-protected documents.
			const entry = (await getEntry(context.locals, String(item.id))) ?? { authorId: null };
			return mode === "private" ? canReadPrivate(user, entry) : canEdit(user, entry);
		}),
	);
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(JSON.stringify({ ...body, data: { ...body!.data, items: items.filter((_, i) => keep[i]) } }), {
		status: response.status,
		headers,
	});
});
