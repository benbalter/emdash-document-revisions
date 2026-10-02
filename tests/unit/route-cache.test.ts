import { beforeEach, describe, expect, it, vi } from "vitest";

import { onRequest } from "../../plugin/src/middleware";
import { GET } from "../../plugin/src/routes/document";
import { clearBucket, user } from "./helpers";

/**
 * Astro's route cache applies its headers after the middleware chain
 * returns, and a later cache.set(hint) re-enables a cache an earlier
 * set(false) disabled. So the opt-out for viewer-specific responses has to
 * happen after next(), in middleware or in the route itself.
 */
function context(path: string, opts: { user?: ReturnType<typeof user>; cookie?: string } = {}) {
	const url = new URL(`http://site.test${path}`);
	const headers = opts.cookie ? { cookie: opts.cookie } : undefined;
	return {
		url,
		request: new Request(url, { headers }),
		locals: { user: opts.user },
		params: { path: path.replace(/^\/documents\//, "") },
		cookies: { get: () => undefined },
		cache: { set: vi.fn() },
	};
}

const page = () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } });

async function middleware(c: ReturnType<typeof context>) {
	await (onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(c, async () => page());
	return c.cache.set;
}

describe("route-cache opt-out in middleware", () => {
	it("a signed-in viewer's page is never stored", async () => {
		expect(await middleware(context("/pages/x", { user: user("u", 10) }))).toHaveBeenCalledWith(false);
	});

	it("a visitor with a document password cookie isn't either", async () => {
		expect(await middleware(context("/pages/x", { cookie: "a=1; edr_pw_e1=abc" }))).toHaveBeenCalledWith(false);
	});

	it("an anonymous visitor's page stays cacheable", async () => {
		expect(await middleware(context("/pages/x", { cookie: "theme=dark" }))).not.toHaveBeenCalled();
	});

	it("EmDash's own routes are left to EmDash", async () => {
		expect(await middleware(context("/_emdash/api/content/posts", { user: user("u", 50) }))).not.toHaveBeenCalled();
	});
});

describe("route-cache opt-out in the permalink route", () => {
	beforeEach(clearBucket);

	it("a response that isn't a public file is never stored", async () => {
		const c = context("/documents/no-such-document.pdf");
		const res = await (GET as unknown as (c: unknown) => Promise<Response>)(c);
		expect(res.status).toBe(404);
		expect(c.cache.set).toHaveBeenCalledWith(false);
	});
});
