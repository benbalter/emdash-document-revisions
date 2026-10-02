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
import { candidates, etagMatches, fileSegment, parseRange } from "../permalinks";
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

interface FeedData {
	ok: true;
	userId: string;
	title: string;
	slug: string;
	updatedAt: string;
	revisions: Array<{
		n: number;
		filename: string;
		url: string;
		createdAt: string;
		authorName: string | null;
		note: string | null;
		size: number;
	}>;
}

/**
 * /documents/:slug/feed?key=… — the document's revision log as Atom, for
 * feed readers (which can't send session cookies, hence the per-user key).
 * Permission checks run in the plugin's public `feed-data` route, which has
 * the plugin context (users, drafts) that anonymous site requests lack.
 */
async function feed(locals: App.Locals, url: URL, slug: string): Promise<Response> {
	const handler = locals.emdash?.handlePublicPluginApiRoute;
	const key = url.searchParams.get("key") ?? "";
	if (typeof handler !== "function" || !key) return notFound();
	const dataUrl = new URL("/_emdash/api/plugins/document-revisions/feed-data", url);
	dataUrl.searchParams.set("doc", slug);
	dataUrl.searchParams.set("key", key);
	const res = await handler("document-revisions", "GET", "feed-data", new Request(dataUrl));
	const data = (res?.success ? res.data : null) as FeedData | { ok: false } | null;
	if (!data || !data.ok) return notFound();
	// Plugin user lookups don't say whether an account is disabled; check, and
	// refuse rather than serve if we can't tell.
	if (!(await accountActive(data.userId))) return notFound();

	const x = escapeHtml;
	const self = `${url.origin}/documents/${encodeURIComponent(slug)}/feed`;
	const entries = data.revisions
		.map(
			(r) => `<entry>
<id>${x(url.origin + r.url)}</id>
<title>${x(`Revision ${r.n}: ${r.filename}`)}</title>
<link rel="alternate" href="${x(url.origin + r.url)}"/>
<updated>${x(r.createdAt)}</updated>
<author><name>${x(r.authorName ?? "Unknown")}</name></author>
<summary>${x(r.note ?? "")}</summary>
</entry>`,
		)
		.join("\n");
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>${x(self)}</id>
<title>${x(`${data.title}: revisions`)}</title>
<link rel="self" href="${x(self)}"/>
<link rel="alternate" href="${x(`${url.origin}/documents/${encodeURIComponent(slug)}`)}"/>
<updated>${x(data.updatedAt)}</updated>
${entries}
</feed>`;
	return new Response(xml, {
		headers: {
			"Content-Type": "application/atom+xml; charset=utf-8",
			"Cache-Control": "private, no-store",
			"X-Robots-Tag": "noindex",
		},
	});
}

/**
 * Whether a user account is enabled, read from EmDash's `users` table through
 * the site's D1 binding (`DB`, or the name in DOCUMENT_D1_BINDING). Anonymous
 * requests have no database on locals, and EmDash's plugin user API omits the
 * disabled flag. Fails closed: no binding or a failed query counts as disabled.
 */
async function accountActive(userId: string): Promise<boolean> {
	try {
		const { env } = await import("cloudflare:workers");
		const vars = env as Record<string, unknown>;
		const name = typeof vars.DOCUMENT_D1_BINDING === "string" ? vars.DOCUMENT_D1_BINDING : "DB";
		const db = vars[name] as D1Database | undefined;
		if (!db) throw new Error(`No D1 binding named ${name}`);
		const row = await db.prepare("SELECT disabled FROM users WHERE id = ?").bind(userId).first<{ disabled: number }>();
		return row !== null && !row.disabled;
	} catch (e) {
		console.error("[document-revisions] can't check whether a feed key's account is disabled", e);
		return false;
	}
}

/**
 * Keep everything but a public file out of Astro's route cache, which
 * ignores Cache-Control: a site's routeRules covering /documents/** must not
 * store a private file, a password form or a feed and serve it to others.
 */
export const GET: APIRoute = async (context) => {
	const res = await serve(context);
	if (!res.headers.get("cache-control")?.startsWith("public")) context.cache?.set(false);
	return res;
};

const serve: APIRoute = async ({ params, locals, cookies, request, url }) => {
	const parts = (params.path ?? "").split("/").filter(Boolean);
	if (parts.length === 2 && parts[1] === "feed") return feed(locals, url, decodeURIComponent(parts[0]!));
	const r = await resolve(locals, params.path ?? "");
	if (!r) return notFound();

	const access = fileAccess(locals.user, r.entry, r.manifest, {
		revision: r.n !== null,
		passwordCookieValid: await cookieValid(r, cookies),
	});
	if (access === "password") return passwordForm(r.entry, false);
	// 404 rather than 403 so private document slugs don't leak.
	if (access === "deny") return notFound();

	const b = await bucket();
	const head = await b.head(r.revision.key);
	if (!head) return notFound();

	const isPublic =
		r.n === null && r.entry.status === "published" && (r.manifest.visibility?.mode ?? "public") === "public";

	const headers: Record<string, string> = {
		"Content-Type": r.revision.contentType,
		"Content-Disposition": contentDisposition(r.revision.filename, r.revision.contentType),
		"X-Content-Type-Options": "nosniff",
		// no-cache: revalidate every time (a cheap 304), so making a document
		// private or trashing it takes effect at once.
		"Cache-Control": isPublic ? "public, no-cache" : "private, no-store",
		"Accept-Ranges": "bytes",
		ETag: head.httpEtag,
	};
	// Chrome's PDF viewer renders blank under a sandbox CSP. PDFs are the
	// only inline type it's dropped for; scriptable types never go inline.
	if (r.revision.contentType !== "application/pdf") headers["Content-Security-Policy"] = "sandbox";

	// Conditional request: the file at this URL is unchanged.
	if (etagMatches(request.headers.get("if-none-match"), head.httpEtag)) {
		return new Response(null, { status: 304, headers });
	}

	// Single byte range, which is what PDF viewers and media players send.
	// Multi-range requests get the whole file, which RFC 9110 allows.
	const range = parseRange(request.headers.get("range"), head.size);
	if (range === "unsatisfiable") {
		return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${head.size}` } });
	}
	const obj = await b.get(r.revision.key, range ? { range } : undefined);
	if (!obj) return notFound();
	if (range) {
		const end = range.offset + range.length - 1;
		return new Response(obj.body as unknown as ReadableStream, {
			status: 206,
			headers: {
				...headers,
				"Content-Length": String(range.length),
				"Content-Range": `bytes ${range.offset}-${end}/${head.size}`,
			},
		});
	}
	return new Response(obj.body as unknown as ReadableStream, {
		headers: { ...headers, "Content-Length": String(head.size) },
	});
};

/**
 * Throttle password guesses per client and document. Uses the site's
 * DOC_PASSWORD_LIMIT rate-limit binding; without it, unthrottled.
 */
async function passwordAttemptAllowed(request: Request, entryId: string): Promise<boolean> {
	const { env } = await import("cloudflare:workers");
	const limiter = (env as Record<string, unknown>).DOC_PASSWORD_LIMIT as
		| { limit: (opts: { key: string }) => Promise<{ success: boolean }> }
		| undefined;
	if (!limiter) return true;
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const { success } = await limiter.limit({ key: `${ip}:${entryId}` });
	return success;
}

/** Password form submission. */
export const POST: APIRoute = async ({ params, locals, request, url, cache }) => {
	cache?.set(false);
	// Non-/_emdash routes get no CSRF check from EmDash; refuse cross-site posts.
	const origin = request.headers.get("origin");
	if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });

	const r = await resolve(locals, params.path ?? "");
	if (!r || r.manifest.visibility?.mode !== "password" || r.entry.status !== "published") {
		return notFound();
	}
	if (!(await passwordAttemptAllowed(request, r.entry.id))) {
		return new Response("Too many attempts. Try again in a minute.", {
			status: 429,
			headers: { "Retry-After": "60", "Cache-Control": "private, no-store" },
		});
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
