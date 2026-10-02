import * as cheerio from "cheerio";
import { beforeAll, describe, expect, it } from "vitest";

import { anon, as, makeDocument, TWO_PDF, uniq, type Client } from "../support/client";

interface SearchItem {
	collection: string;
	id: string;
	title?: string;
}

describe("Search filters documents per viewer", () => {
	// A word only these documents contain, so other suites' documents don't matter.
	const word = `zebra${uniq("q").slice(2)}`;
	const ids: Record<"pub" | "privOwn" | "privOther" | "pw", string> = {} as never;

	beforeAll(async () => {
		ids.pub = await makeDocument(uniq("verify-search-pub"), { title: `Public ${word}` });
		ids.privOwn = await makeDocument(uniq("verify-search-own"), {
			title: `Own private ${word}`,
			visibility: "private",
			owner: "author",
		});
		ids.privOther = await makeDocument(uniq("verify-search-priv"), {
			title: `Other private ${word}`,
			visibility: "private",
			owner: "other",
		});
		ids.pw = await makeDocument(uniq("verify-search-pw"), {
			title: `Locked ${word}`,
			visibility: "password",
			password: "s3cret",
			owner: "other",
		});
	});

	const found = async (c: Client, path = "/_emdash/api/search") => {
		const res = await c.get(`${path}?q=${word}`);
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { items: SearchItem[] } };
		const docIds = new Set(data.items.filter((i) => i.collection === "documents").map((i) => i.id));
		return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, docIds.has(id)]));
	};

	it("anonymous search finds the public document only", async () => {
		expect(await found(anon())).toEqual({ pub: true, privOwn: false, privOther: false, pw: false });
	});

	it("subscriber search finds the public document only", async () => {
		expect(await found(as("subscriber"))).toEqual({ pub: true, privOwn: false, privOther: false, pw: false });
	});

	it("author also finds their own private document", async () => {
		expect(await found(as("author"))).toEqual({ pub: true, privOwn: true, privOther: false, pw: false });
	});

	it("admin finds all of them", async () => {
		expect(await found(as("admin"))).toEqual({ pub: true, privOwn: true, privOther: true, pw: true });
	});

	it("a trailing slash doesn't bypass the filter", async () => {
		// EmDash 1.1 doesn't treat /search/ as its public route (401 for
		// visitors); the middleware filters it anyway in case that changes.
		for (const c of [anon(), as("subscriber")]) {
			const res = await c.get(`/_emdash/api/search/?q=${word}`);
			if (!res.ok) {
				expect([401, 403, 404]).toContain(res.status);
				continue;
			}
			const { data } = (await res.json()) as { data: { items: SearchItem[] } };
			const docIds = data.items.map((i) => i.id);
			for (const id of [ids.privOwn, ids.privOther, ids.pw]) expect(docIds).not.toContain(id);
		}
	});

	it("suggestions are filtered the same way", async () => {
		const res = await anon().get(`/_emdash/api/search/suggest?q=${word}`);
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { items?: SearchItem[] } | SearchItem[] };
		const items = Array.isArray(data) ? data : (data.items ?? []);
		const docIds = items.filter((i) => i.collection === "documents").map((i) => i.id);
		expect(docIds).not.toContain(ids.privOther);
		expect(docIds).not.toContain(ids.pw);
		expect(docIds).not.toContain(ids.privOwn);
	});
});

describe("Private titles stay out of public listings", () => {
	const admin = as("admin");
	const PUB = uniq("verify-list-pub");
	const PRIV = uniq("verify-list-priv");
	let pubId: string;

	beforeAll(async () => {
		pubId = await makeDocument(PUB, { files: [{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" }] });
		await makeDocument(PRIV, { visibility: "private", owner: "other" });
	});

	const listed = async (slug: string) => {
		const $ = cheerio.load(await (await anon().get("/documents")).text());
		return $(`a[href^="/documents/${slug}."]`).length;
	};

	it("listing page shows a public document", async () => {
		expect(await listed(PUB)).toBe(1);
	});

	it("listing page hides a password-protected document", async () => {
		await admin.setVisibility(pubId, "password", "lp");
		try {
			expect(await listed(PUB)).toBe(0);
		} finally {
			await admin.setVisibility(pubId, "public");
		}
	});

	it("listing page hides a private document", async () => {
		expect(await listed(PRIV)).toBe(0);
	});
});
