import * as cheerio from "cheerio";
import { beforeAll, describe, expect, it } from "vitest";

import { anon, as, CONTENT, makeDocument, TWO_PDF, uniq, type Client } from "../support/client";

type Page = cheerio.CheerioAPI;

describe("Front-end blocks", () => {
	const admin = as("admin");
	const run = uniq("bk");
	const PUB = `verify-bk-pub-${run}`;
	const PW = `verify-bk-pw-${run}`;
	const PRIV = `verify-bk-priv-${run}`;
	const pages: Record<"anon" | "admin" | "subscriber", Page> = {} as never;

	beforeAll(async () => {
		// Three public documents first, then restricted ones that are newer,
		// so "Latest documents" has to skip entries to fill its limit.
		for (let i = 1; i <= 3; i++) await makeDocument(`verify-bk-filler-${i}-${run}`, { title: `Filler ${i} ${run}` });

		const pub = await makeDocument(PUB, {
			title: `Block Public ${run}`,
			files: [{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" }],
		});
		const { terms } = await admin.json<{ terms: Array<{ id: string; slug: string }> }>(
			"/_emdash/api/taxonomies/workflow_state/terms",
		);
		const final = terms.find((t) => t.slug === "final");
		expect(final, "seeded workflow_state term 'final'").toBeDefined();
		await admin.postJson(`${CONTENT}/${pub}/terms/workflow_state`, { termIds: [final!.id] });

		// Owned by someone else, so the subscriber check isn't an author check.
		await makeDocument(PRIV, { title: `Block Private ${run}`, visibility: "private", owner: "other" });
		await makeDocument(PW, { title: `Block Locked ${run}`, visibility: "password", password: "bk" });
		for (let i = 1; i <= 3; i++) {
			await makeDocument(`verify-bk-newer-${i}-${run}`, { title: `Newer ${i} ${run}`, visibility: "private", owner: "other" });
		}

		const page = await admin.postJson<{ item: { id: string } }>("/_emdash/api/content/pages", {
			slug: `verify-blocks-${run}`,
			data: {
				title: "Blocks",
				content: [
					{ _type: "document-list", _key: "a", heading: "All", limit: 100 },
					{ _type: "document-list", _key: "f", heading: "Final only", limit: 100, workflow_state: "final" },
					{ _type: "latest-documents", _key: "l", limit: 3 },
					{ _type: "document-revisions", _key: "r", document: PUB },
					{ _type: "document-preview", _key: "p1", document: PUB },
					{ _type: "document-preview", _key: "p2", document: PW },
					{ _type: "document-preview", _key: "p3", document: PRIV },
				],
			},
		});
		await admin.postJson(`/_emdash/api/content/pages/${page.item.id}/publish`);

		const load = async (c: Client) => {
			const res = await c.get(`/pages/verify-blocks-${run}`);
			expect(res.status).toBe(200);
			return cheerio.load(await res.text());
		};
		pages.anon = await load(anon());
		pages.admin = await load(admin);
		pages.subscriber = await load(as("subscriber"));
	});

	/** Titles listed in the document-list block with this heading. */
	const list = ($: Page, heading: string) =>
		$("section.edr-documents")
			.filter((_, s) => $(s).find(".edr-documents__heading strong").text() === heading)
			.find("li > a:first-child")
			.map((_, a) => $(a).text().trim())
			.get();

	it("list shows a public document to visitors", () => {
		expect(list(pages.anon, "All")).toContain(`Block Public ${run}`);
	});

	it("list hides a private document from visitors", () => {
		expect(pages.anon.html()).not.toContain(`Block Private ${run}`);
	});

	it("list hides a password-protected document from visitors", () => {
		expect(list(pages.anon, "All")).not.toContain(`Block Locked ${run}`);
	});

	it("list shows the private document to an admin", () => {
		expect(list(pages.admin, "All")).toContain(`Block Private ${run}`);
	});

	it("list hides the private document from a subscriber", () => {
		expect(list(pages.subscriber, "All")).not.toContain(`Block Private ${run}`);
	});

	it("workflow-state filter includes the final document", () => {
		expect(list(pages.anon, "Final only")).toContain(`Block Public ${run}`);
	});

	it("workflow-state filter excludes others", () => {
		expect(list(pages.admin, "Final only")).not.toContain(`Block Private ${run}`);
		expect(list(pages.admin, "Final only")).not.toContain(`Filler 1 ${run}`);
	});

	it("latest documents fills its limit despite filtered entries", () => {
		const $ = pages.anon;
		const items = $('section[data-block="latest-documents"] li > a:first-child')
			.map((_, a) => $(a).text().trim())
			.get();
		expect(items).toHaveLength(3);
		for (const t of items) expect(t).not.toMatch(/^(Newer|Block Private|Block Locked)/);
	});

	it("revision list hidden from visitors", () => {
		expect(pages.anon(".edr-revisions")).toHaveLength(0);
	});

	it("revision list hidden from subscribers", () => {
		expect(pages.subscriber(".edr-revisions")).toHaveLength(0);
	});

	it("revision list shown to admin", () => {
		const $ = pages.admin;
		expect($(".edr-revisions")).toHaveLength(1);
		expect($(".edr-revisions li a").first().attr("href")).toBe(`/documents/${PUB}-revision-1.pdf`);
	});

	it("preview embeds a public PDF for visitors", () => {
		expect(pages.anon(`.edr-preview iframe[src="/documents/${PUB}.pdf"]`)).toHaveLength(1);
	});

	it("preview asks visitors for the password", () => {
		const $ = pages.anon;
		const locked = $(".edr-preview__locked").filter((_, p) => $(p).text().includes("password protected"));
		expect(locked).toHaveLength(1);
		expect(locked.find("a").attr("href")).toBe(`/documents/${PW}.txt`);
	});

	it("preview refuses visitors a private document", () => {
		const $ = pages.anon;
		expect($(".edr-preview__locked").filter((_, p) => $(p).text().includes("have access"))).toHaveLength(1);
	});

	it("preview serves everything to admin", () => {
		const $ = pages.admin;
		expect($(".edr-preview__locked")).toHaveLength(0);
		expect($(".edr-preview")).toHaveLength(3);
	});
});
