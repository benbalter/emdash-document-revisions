import * as cheerio from "cheerio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anon, API, as, db, makeDocument, ONE, setRole, TWO_PDF, uniq } from "../support/client";
import { userId } from "../support/db";

const issueKey = async (who: Parameters<typeof as>[0]) =>
	(await as(who).postJson<{ key: string }>(`${API}/feed-key`)).key;

describe("Revision feed", () => {
	const PUB = uniq("verify-feed");
	const PRIV = uniq("verify-feed-priv");
	const feed = (slug: string, key?: string) =>
		anon().get(`/documents/${slug}/feed${key === undefined ? "" : `?key=${encodeURIComponent(key)}`}`);
	let key: string;

	beforeAll(async () => {
		await makeDocument(PUB, {
			files: [
				{ body: ONE, type: "text/plain", name: "one.txt" },
				{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" },
				{ body: ONE, type: "text/plain", name: "three.txt" },
				{ body: TWO_PDF, type: "application/pdf", name: "four.pdf" },
			],
		});
		await makeDocument(PRIV, { visibility: "private", owner: "other" });
		key = await issueKey("admin");
	});

	afterAll(() => {
		setRole("mutable", 20);
		db().run("update users set disabled = 0 where id = ?", userId("mutable"));
	});

	it("feed without a key", async () => {
		expect((await feed(PUB)).status).toBe(404);
	});

	it("feed with a wrong key", async () => {
		expect((await feed(PUB, "wrongwrongwrongwrongwrong")).status).toBe(404);
	});

	it("feed with the key", async () => {
		const res = await feed(PUB, key);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("feed is Atom with one entry per revision", async () => {
		const $ = cheerio.load(await (await feed(PUB, key)).text(), { xml: true });
		expect($("feed").attr("xmlns")).toBe("http://www.w3.org/2005/Atom");
		const entries = $("feed > entry");
		expect(entries).toHaveLength(4);
		const hrefs = entries.map((_, e) => $(e).find("link").attr("href")).get();
		for (const href of hrefs) expect(href).toMatch(new RegExp(`/documents/${PUB}-revision-\\d\\.(txt|pdf)$`));
		expect($("feed > entry > title").first().text()).toMatch(/^Revision \d: /);
	});

	it("feed keys are shown once", async () => {
		expect(await as("admin").json<{ hasKey: boolean }>(`${API}/feed-key`)).toEqual({ hasKey: true });
	});

	it("a new key revokes the old one", async () => {
		const old = key;
		key = await issueKey("admin");
		expect((await feed(PUB, old)).status).toBe(404);
		expect((await feed(PUB, key)).status).toBe(200);
	});

	it("subscribers can't get feed keys", async () => {
		expect((await as("subscriber").post(`${API}/feed-key`)).status).toBe(403);
	});

	describe("the key follows its user's current role and status", () => {
		let mkey: string;

		beforeAll(async () => {
			setRole("mutable", 20);
			mkey = await issueKey("mutable");
		});

		it("contributor's key can't read another's private document feed", async () => {
			expect((await feed(PRIV, mkey)).status).toBe(404);
		});

		it("contributor's key reads a public document feed", async () => {
			expect((await feed(PUB, mkey)).status).toBe(200);
		});

		it("same key works once the user is promoted", async () => {
			setRole("mutable", 50);
			expect((await feed(PRIV, mkey)).status).toBe(200);
		});

		it("a disabled account's key stops working", async () => {
			db().run("update users set disabled = 1 where id = ?", userId("mutable"));
			expect((await feed(PRIV, mkey)).status).toBe(404);
			expect((await feed(PUB, mkey)).status).toBe(404);
		});

		it("and works again once the account is re-enabled", async () => {
			db().run("update users set disabled = 0 where id = ?", userId("mutable"));
			expect((await feed(PRIV, mkey)).status).toBe(200);
		});
	});

	describe("revocation", () => {
		it("revoking everyone's keys is Admin-only", async () => {
			expect((await as("editor").post(`${API}/revoke-feed-keys`)).status).toBe(403);
		});

		it("Admin revokes all feed keys", async () => {
			expect((await as("admin").post(`${API}/revoke-feed-keys`)).status).toBe(200);
		});

		it("bulk-revoked key stops working", async () => {
			expect((await feed(PUB, key)).status).toBe(404);
		});

		it("revoked key stops working", async () => {
			key = await issueKey("admin");
			expect((await feed(PRIV, key)).status).toBe(200);
			const res = await as("admin").fetch(`${API}/feed-key`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect((await feed(PRIV, key)).status).toBe(404);
		});
	});
});
