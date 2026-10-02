import { beforeAll, describe, expect, it } from "vitest";

import { anon, as, cacheControl, CONTENT, makeDocument, ONE, TWO_PDF, uniq } from "../support/client";

describe("Upload and permalinks", () => {
	const admin = as("admin");
	const P = uniq("verify");
	let id: string;

	beforeAll(async () => {
		id = await admin.createDocument(P, `Verify ${P}`);
	});

	it("upload revision 1", async () => {
		expect((await admin.upload(id, ONE, "text/plain", "one.txt")).status).toBe(201);
	});

	it("upload revision 2", async () => {
		expect((await admin.upload(id, TWO_PDF, "application/pdf", "two.pdf")).status).toBe(201);
		// The rest of this block reads it as a public document once published.
		expect((await admin.setVisibility(id, "public")).status).toBe(200);
	});

	it("draft, anonymous", async () => {
		expect((await anon().get(`/documents/${P}`)).status).toBe(404);
	});

	it("draft, admin", async () => {
		const res = await admin.get(`/documents/${P}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(TWO_PDF);
	});

	it("draft is never publicly cacheable", async () => {
		expect(cacheControl(await admin.get(`/documents/${P}`))).toBe("private, no-store");
	});

	describe("once published", () => {
		beforeAll(async () => {
			await admin.publish(id);
		});

		it("published, extensionless", async () => {
			expect((await anon().get(`/documents/${P}`)).status).toBe(200);
		});

		it("published, canonical .pdf", async () => {
			const res = await anon().get(`/documents/${P}.pdf`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/pdf");
			expect(res.headers.get("content-disposition")).toBe(
				`inline; filename="two.pdf"; filename*=UTF-8''two.pdf`,
			);
		});

		it("published, wrong extension still resolves", async () => {
			expect((await anon().get(`/documents/${P}.doc`)).status).toBe(200);
		});

		it("published, WP date form", async () => {
			expect((await anon().get(`/documents/2011/08/${P}.pdf`)).status).toBe(200);
		});

		it("public latest is cacheable", async () => {
			expect(cacheControl(await anon().get(`/documents/${P}.pdf`))).toBe("public, max-age=60");
		});

		it("published, signed-in subscriber", async () => {
			expect((await as("subscriber").get(`/documents/${P}.pdf`)).status).toBe(200);
		});

		it("revision 1, subscriber", async () => {
			expect((await as("subscriber").get(`/documents/${P}-revision-1.txt`)).status).toBe(404);
		});

		it("revision 1, anonymous", async () => {
			expect((await anon().get(`/documents/${P}-revision-1.txt`)).status).toBe(404);
		});

		it("revision 1, admin", async () => {
			const res = await admin.get(`/documents/${P}-revision-1.txt`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(ONE);
			// Past revisions are never publicly cacheable.
			expect(cacheControl(res)).toBe("private, no-store");
		});

		it("unknown revision", async () => {
			expect((await admin.get(`/documents/${P}-revision-99.txt`)).status).toBe(404);
		});

		it("bad path shape", async () => {
			expect((await anon().get("/documents/a/b")).status).toBe(404);
		});

		it("revision log hides storage keys", async () => {
			const log = await admin.files(id);
			expect(log.revisions.map((r) => r.n)).toEqual([2, 1]);
			for (const r of log.revisions) expect(r).not.toHaveProperty("key");
			expect(JSON.stringify(log)).not.toContain('"key"');
		});

		it("revision log includes core field edits, ISO-dated", async () => {
			await admin.json(`${CONTENT}/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Verify renamed" } }),
			});
			const { edits } = await admin.files(id);
			expect(edits.length).toBeGreaterThan(0);
			for (const e of edits) expect(e.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
		});
	});
});

describe("Dotted slugs", () => {
	const admin = as("admin");
	const DOT = `verify.${uniq("dot")}`;

	beforeAll(async () => {
		await makeDocument(DOT, { publish: false });
	});

	it("dotted slug, exact", async () => {
		expect((await admin.get(`/documents/${DOT}`)).status).toBe(200);
	});

	it("dotted slug + extension", async () => {
		expect((await admin.get(`/documents/${DOT}.txt`)).status).toBe(200);
	});
});

describe("Range and conditional requests", () => {
	const SLUG = uniq("verify-range");
	const text = Array.from({ length: 2000 }, (_, i) => `${i + 1}\n`).join("");
	const url = `/documents/${SLUG}.txt`;
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(SLUG, { files: [{ body: text, type: "text/plain", name: "range.txt" }] });
	});

	it("first 10 bytes", async () => {
		const res = await anon().get(url, { headers: { Range: "bytes=0-9" } });
		expect(await res.text()).toBe(text.slice(0, 10));
	});

	it("206 with Content-Range", async () => {
		const res = await anon().get(url, { headers: { Range: "bytes=0-9" } });
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes 0-9/${text.length}`);
		expect(res.headers.get("content-length")).toBe("10");
	});

	it("suffix range", async () => {
		const res = await anon().get(url, { headers: { Range: "bytes=-6" } });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe(text.slice(-6));
	});

	it("unsatisfiable range", async () => {
		const res = await anon().get(url, { headers: { Range: "bytes=99999999-" } });
		expect(res.status).toBe(416);
		expect(res.headers.get("content-range")).toBe(`bytes */${text.length}`);
	});

	it("If-None-Match gets 304", async () => {
		const etag = (await anon().get(url)).headers.get("etag");
		expect(etag).toBeTruthy();
		expect((await anon().get(url, { headers: { "If-None-Match": etag! } })).status).toBe(304);
	});

	it("Accept-Ranges advertised", async () => {
		expect((await anon().get(url)).headers.get("accept-ranges")).toBe("bytes");
	});

	it("Range doesn't bypass privacy", async () => {
		await as("admin").setVisibility(id, "private");
		expect((await anon().get(url, { headers: { Range: "bytes=0-9" } })).status).toBe(404);
	});
});

describe("Malformed permalinks", () => {
	it("a stray percent-escape is a 404, not a server error", async () => {
		expect((await anon().get("/documents/%E0%A4%A")).status).toBe(404);
		expect((await anon().get("/documents/100%.pdf")).status).toBe(404);
		expect((await anon().get("/documents/100%/feed?key=wrongwrongwrongwrongwrong")).status).toBe(404);
	});
});
