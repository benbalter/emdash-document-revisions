import { beforeEach, describe, expect, it, vi } from "vitest";

import { onRequest } from "../../plugin/src/middleware";
import { updateManifest, writeSettings, type VisibilityMode } from "../../plugin/src/store";
import { bucket, clearBucket, user } from "./helpers";

type Item = { collection: string; id: string; title?: string };

/** Run the middleware on `path` with EmDash's response `upstream`. */
async function run(
	path: string,
	upstream: Response,
	opts: { user?: ReturnType<typeof user>; authors?: Record<string, string>; method?: string } = {},
) {
	const locals = {
		user: opts.user,
		emdash: {
			// What getEntry() calls for signed-in viewers.
			handleContentGet: async (_c: string, id: string) => ({
				success: true,
				data: { item: { id, slug: id, status: "published", authorId: opts.authors?.[id] ?? null, data: {} } },
			}),
		},
	};
	const url = new URL(`http://site.test${path}`);
	const context = { url, request: new Request(url, { method: opts.method ?? "GET" }), locals };
	return (onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(
		context,
		async () => upstream,
	);
}

const search = (items: unknown) => Response.json({ success: true, data: { items } });
const ids = async (res: Response) => ((await res.json()) as { data: { items: Item[] } }).data.items.map((i) => i.id);

async function doc(id: string, mode: VisibilityMode) {
	await updateManifest(bucket(), id, id, (m) => ({ ...m, visibility: { mode } }));
}

const hits: Item[] = [
	{ collection: "posts", id: "post" },
	{ collection: "documents", id: "pub" },
	{ collection: "documents", id: "priv" },
	{ collection: "documents", id: "pw" },
	{ collection: "documents", id: "nomanifest" },
];

beforeEach(async () => {
	await clearBucket();
	await doc("pub", "public");
	await doc("priv", "private");
	await doc("pw", "password");
});

describe("search filter", () => {
	it("anonymous visitors see public documents and other collections only", async () => {
		expect(await ids(await run("/_emdash/api/search", search(hits)))).toEqual(["post", "pub"]);
	});

	it("documents without a manifest follow the site default", async () => {
		await writeSettings(bucket(), { defaultVisibility: "public" });
		expect(await ids(await run("/_emdash/api/search", search(hits)))).toEqual(["post", "pub", "nomanifest"]);
	});

	it("suggestions are filtered too", async () => {
		expect(await ids(await run("/_emdash/api/search/suggest", search(hits)))).toEqual(["post", "pub"]);
	});

	it("a trailing slash doesn't bypass the filter", async () => {
		expect(await ids(await run("/_emdash/api/search/", search(hits)))).toEqual(["post", "pub"]);
		expect(await ids(await run("/_emdash/api/search/suggest//", search(hits)))).toEqual(["post", "pub"]);
	});

	it("every method is filtered", async () => {
		expect(await ids(await run("/_emdash/api/search", search(hits), { method: "POST" }))).toEqual(["post", "pub"]);
	});

	it("authors find their own private and password documents", async () => {
		const res = await run("/_emdash/api/search", search(hits), {
			user: user("me", 30),
			authors: { priv: "me", pw: "me" },
		});
		expect(await ids(res)).toEqual(["post", "pub", "priv", "pw"]);
	});

	it("a contributor's own password document stays hidden (needs edit rights)", async () => {
		const res = await run("/_emdash/api/search", search(hits), {
			user: user("me", 20),
			authors: { priv: "me", pw: "me" },
		});
		expect(await ids(res)).toEqual(["post", "pub", "priv"]);
	});

	it("editors see everything", async () => {
		expect(await ids(await run("/_emdash/api/search", search(hits), { user: user("ed", 40) }))).toEqual([
			"post",
			"pub",
			"priv",
			"pw",
			"nomanifest",
		]);
	});

	it("drops Content-Length and keeps the rest of the envelope", async () => {
		const upstream = Response.json(
			{ success: true, data: { items: hits, nextCursor: "c1" } },
			{ headers: { "Content-Length": "999", "X-Test": "kept" } },
		);
		const res = await run("/_emdash/api/search", upstream);
		expect(res.headers.get("content-length")).not.toBe("999");
		expect(res.headers.get("x-test")).toBe("kept");
		expect(((await res.json()) as { data: { nextCursor: string } }).data.nextCursor).toBe("c1");
	});

	it("leaves other paths and error responses alone", async () => {
		const other = search(hits);
		expect(await run("/_emdash/api/content/documents", other)).toBe(other);
		const failed = Response.json({ success: false }, { status: 500 });
		expect(await run("/_emdash/api/search", failed)).toBe(failed);
	});

	it("passes results with no documents through untouched", async () => {
		const upstream = search([{ collection: "posts", id: "post" }]);
		expect(await run("/_emdash/api/search", upstream)).toBe(upstream);
	});

	describe("fails closed on a response it doesn't recognize", () => {
		beforeEach(() => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
		});

		it.each([
			["items renamed", { success: true, data: { results: hits } }],
			["hits without a collection", { success: true, data: { items: [{ id: "priv", title: "Secret" }] } }],
			["hits without an id", { success: true, data: { items: [{ collection: "documents", title: "Secret" }] } }],
			["not an envelope", [{ collection: "documents", id: "priv" }]],
		])("%s → no results", async (_name, body) => {
			const res = await run("/_emdash/api/search", Response.json(body));
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("private, no-store");
			expect(await res.json()).toEqual({ success: true, data: { items: [] } });
		});

		it("non-JSON body → no results", async () => {
			const res = await run("/_emdash/api/search", new Response("<html>oops</html>"));
			expect(await res.json()).toEqual({ success: true, data: { items: [] } });
		});
	});
});
