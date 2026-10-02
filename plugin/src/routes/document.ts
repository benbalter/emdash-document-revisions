/**
 * Document permalink: /documents/:slug and /documents/:slug/revisions/:n
 *
 * This is a site route rather than a plugin route on purpose:
 * - Private plugin routes require the X-EmDash-Request CSRF header even on
 *   GET, so a plain <a href> to one fails; site routes get the session user
 *   through EmDash's soft-auth middleware instead.
 * - Plugin route responses are buffered and capped at 8 MiB; this streams.
 *
 * Access rules (mirroring core's content:read / content:read_drafts split):
 * - Latest file of a published document: anyone.
 * - Unpublished documents and past revisions: Contributor and up.
 */

/// <reference types="emdash/locals" />
import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";

import { bucket, COLLECTION, contentDisposition, entryIdForSlug, readManifest, Role } from "../store";

export const prerender = false;

const notFound = () => new Response("Not found", { status: 404 });

export const GET: APIRoute = async ({ params, locals }) => {
	const parts = (params.path ?? "").split("/").filter(Boolean);
	const [slug, segment, nRaw] = parts;
	if (!slug || parts.length === 2 || parts.length > 3 || (segment && segment !== "revisions")) {
		return notFound();
	}
	const n = nRaw ? Number.parseInt(nRaw, 10) : null;
	if (nRaw && (!Number.isInteger(n) || String(n) !== nRaw)) return notFound();

	const b = await bucket();
	const entryId = await entryIdForSlug(b, slug);
	if (!entryId) return notFound();
	const { manifest } = await readManifest(b, entryId);
	const latest = manifest?.revisions.at(-1);
	if (!manifest || !latest) return notFound();

	// getEmDashEntry only returns published entries outside preview/edit mode,
	// which is exactly the "is this public?" question.
	const { entry } = await getEmDashEntry(COLLECTION, slug);
	const isPublic = Boolean(entry) && n === null;
	const canReadDrafts = (locals.user?.role ?? 0) >= Role.CONTRIBUTOR;

	// 404 rather than 403 so private document slugs don't leak.
	if (!isPublic && !canReadDrafts) return notFound();

	const revision = n === null ? latest : manifest.revisions.find((r) => r.n === n);
	if (!revision) return notFound();

	const obj = await b.get(revision.key);
	if (!obj) return notFound();

	return new Response(obj.body as unknown as ReadableStream, {
		headers: {
			"Content-Type": revision.contentType,
			"Content-Length": String(revision.size),
			"Content-Disposition": contentDisposition(revision.filename, revision.contentType),
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Cache-Control": isPublic ? "public, max-age=60" : "private, no-store",
			ETag: obj.httpEtag,
		},
	});
};
