/// <reference types="emdash/locals" />
/**
 * Document permalinks, matching WP Document Revisions' URL shapes:
 *
 *   /documents/tps-report.pdf              latest file
 *   /documents/tps-report-revision-3.pdf   revision 3
 *   /documents/2011/08/tps-report.pdf      WP's date-based form (date ignored)
 *   /documents/tps-report                  extensionless (EmDash's "Live View")
 *
 * This is a site route rather than a plugin route on purpose:
 * - Private plugin routes require the X-EmDash-Request CSRF header even on
 *   GET, so a plain <a href> to one fails; site routes get the session user
 *   through EmDash's soft-auth middleware instead.
 * - Plugin route responses are buffered and capped at 8 MiB; this streams.
 */

import type { APIRoute, AstroCookies } from "astro";

import {
	fileAccess,
	getEntry,
	getPublishedEntry,
	passwordCookieHeader,
	passwordCookieName,
	passwordCookieValid,
	verifyPassword,
	type Entry,
} from "../access";
import {
	bucket,
	contentDisposition,
	entryIdForSlug,
	readManifest,
	type Manifest,
	type RevisionRecord,
} from "../store";

export const prerender = false;

const notFound = () => new Response("Not found", { status: 404 });

interface Resolved {
	entry: Entry;
	manifest: Manifest;
	revision: RevisionRecord;
	n: number | null;
}

/**
 * Slugs are free-form and may contain dots or end in "-revision-N", so try
 * the most literal reading first: exact slug, then slug without extension,
 * then the revision forms.
 */
function candidates(segment: string): Array<{ slug: string; n: number | null }> {
	const out: Array<{ slug: string; n: number | null }> = [{ slug: segment, n: null }];
	const noExt = segment.replace(/\.[A-Za-z0-9]{1,10}$/, "");
	if (noExt !== segment) out.push({ slug: noExt, n: null });
	for (const base of new Set([segment, noExt])) {
		const m = /^(.+)-revision-(\d+)$/.exec(base);
		if (m) out.push({ slug: m[1]!, n: Number.parseInt(m[2]!, 10) });
	}
	return out;
}

function fileSegment(path: string): string | null {
	const parts = path.split("/").filter(Boolean);
	if (parts.length === 1) return parts[0]!;
	if (parts.length === 3 && /^\d{4}$/.test(parts[0]!) && /^\d{2}$/.test(parts[1]!)) return parts[2]!;
	return null;
}

async function resolve(locals: App.Locals, path: string): Promise<Resolved | null> {
	const segment = fileSegment(path);
	if (!segment) return null;
	const b = await bucket();
	for (const { slug, n } of candidates(decodeURIComponent(segment))) {
		const entryId = await entryIdForSlug(b, slug);
		if (!entryId) continue;
		const entry = locals.user
			? await getEntry(locals, entryId)
			: await getPublishedEntry(slug, entryId);
		// Trashed (null) or a recycled slug now owned by another entry.
		if (!entry || entry.slug !== slug) return null;
		const { manifest } = await readManifest(b, entryId);
		const latest = manifest?.revisions.at(-1);
		if (!manifest || !latest) return null;
		const revision = n === null ? latest : manifest.revisions.find((r) => r.n === n);
		return revision ? { entry, manifest, revision, n } : null;
	}
	return null;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function passwordForm(entry: Entry, error: boolean): Response {
	const title = escapeHtml(String(entry.data.title ?? entry.slug ?? "Document"));
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}
input,button{font:inherit;padding:.4rem .6rem}.err{color:#b00020}</style></head><body>
<h1>${title}</h1><p>This document is password protected. Enter the password to view it.</p>
${error ? '<p class="err" role="alert">That password is incorrect.</p>' : ""}
<form method="post"><label>Password <input type="password" name="password" required autofocus></label>
<button type="submit">Open</button></form></body></html>`;
	return new Response(html, {
		status: 401,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
	});
}

async function cookieValid(r: Resolved, cookies: AstroCookies): Promise<boolean> {
	return passwordCookieValid(r.manifest, cookies.get(passwordCookieName(r.entry.id))?.value);
}

export const GET: APIRoute = async ({ params, locals, cookies }) => {
	const r = await resolve(locals, params.path ?? "");
	if (!r) return notFound();

	const access = fileAccess(locals.user, r.entry, r.manifest, {
		revision: r.n !== null,
		passwordCookieValid: await cookieValid(r, cookies),
	});
	if (access === "password") return passwordForm(r.entry, false);
	// 404 rather than 403 so private document slugs don't leak.
	if (access === "deny") return notFound();

	const obj = await (await bucket()).get(r.revision.key);
	if (!obj) return notFound();

	const isPublic =
		r.n === null && r.entry.status === "published" && (r.manifest.visibility?.mode ?? "public") === "public";

	const headers: Record<string, string> = {
		"Content-Type": r.revision.contentType,
		"Content-Length": String(r.revision.size),
		"Content-Disposition": contentDisposition(r.revision.filename, r.revision.contentType),
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": isPublic ? "public, max-age=60" : "private, no-store",
		ETag: obj.httpEtag,
	};
	// Chrome's PDF viewer renders blank under a sandbox CSP. PDFs are the
	// only inline type it's dropped for; scriptable types never go inline.
	if (r.revision.contentType !== "application/pdf") headers["Content-Security-Policy"] = "sandbox";
	return new Response(obj.body as unknown as ReadableStream, { headers });
};

/** Password form submission. */
export const POST: APIRoute = async ({ params, locals, request, url }) => {
	// Non-/_emdash routes get no CSRF check from EmDash; refuse cross-site posts.
	const origin = request.headers.get("origin");
	if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });

	const r = await resolve(locals, params.path ?? "");
	if (!r || r.manifest.visibility?.mode !== "password" || r.entry.status !== "published") {
		return notFound();
	}
	const form = await request.formData().catch(() => null);
	const password = form?.get("password");
	if (typeof password !== "string" || !(await verifyPassword(r.manifest, password))) {
		return passwordForm(r.entry, true);
	}
	return new Response(null, {
		status: 303,
		headers: {
			Location: url.pathname,
			"Set-Cookie": await passwordCookieHeader(r.manifest, url.protocol === "https:"),
			"Cache-Control": "private, no-store",
		},
	});
};
