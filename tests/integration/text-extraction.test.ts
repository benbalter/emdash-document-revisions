import { beforeAll, describe, expect, it } from "vitest";

import {
	as,
	CONTENT,
	eventually,
	makeDocument,
	r2count,
	settledR2Count,
	TWO_PDF,
	uniq,
	type FilesView,
} from "../support/client";

const settled = (log: FilesView, n: number) => {
	const status = log.revisions.find((r) => r.n === n)?.text?.status;
	return status && status !== "pending" ? status : undefined;
};

describe("Text extraction (queue)", () => {
	const admin = as("admin");
	let id: string;
	let log: FilesView;

	beforeAll(async () => {
		id = await makeDocument(uniq("verify-tx"), {
			publish: false,
			files: [
				{ body: "The quick brown fox\n", type: "text/plain", name: "fox.txt" },
				{ body: TWO_PDF, type: "application/pdf", name: "two.pdf" },
			],
		});
		log = await eventually(async () => {
			const l = await admin.files(id);
			return settled(l, 1) && settled(l, 2) ? l : undefined;
		});
	});

	it("plain text extracted", () => {
		expect(log.revisions.find((r) => r.n === 1)!.text).toMatchObject({ status: "done", chars: 20 });
	});

	it("extracted text matches", async () => {
		const data = await admin.json<{ text: string }>(`${CONTENT}/${id}/files/text?n=1`);
		expect(data.text.trim()).toBe("The quick brown fox");
	});

	it("PDF skipped without a Workers AI binding", () => {
		expect(log.revisions.find((r) => r.n === 2)!.text).toMatchObject({
			status: "skipped",
			error: "needs a Workers AI binding",
		});
	});

	it("skipped revision has no text", async () => {
		const res = await admin.get(`${CONTENT}/${id}/files/text?n=2`);
		expect(res.status).toBe(404);
	});

	it("extracted text needs read-drafts", async () => {
		expect((await as("subscriber").get(`${CONTENT}/${id}/files/text?n=1`)).status).toBe(403);
	});

	it("permanent delete removes extracted text", async () => {
		expect(r2count(`entries/${id}/text/`)).toBe(1);
		await admin.deletePermanently(id);
		expect(await settledR2Count(`entries/${id}/text/`, 0)).toBe(0);
	});
});

describe("Large text files stay within memory bounds", () => {
	it("40 MB log extracted from its first part, marked truncated", async () => {
		const admin = as("admin");
		const line = "log line with some padding to make it longer\n";
		const big = Buffer.alloc(40 * 1024 * 1024, line);
		const id = await makeDocument(uniq("verify-biglog"), {
			publish: false,
			files: [{ body: big, type: "text/plain", name: "big.log" }],
		});
		const log = await eventually(async () => {
			const l = await admin.files(id);
			return settled(l, 1) ? l : undefined;
		}, 40_000);
		// The text processor reads the first 25 MB; extracted text is capped at 2M chars.
		expect(log.revisions[0]!.text).toMatchObject({ status: "done", truncated: true, chars: 2_000_000 });
	});
});
