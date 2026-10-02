import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { aiMarkdownProcessor } from "../../plugin/src/processing/ai-markdown";
import { MAX_TEXT_CHARS, processors, textKey, type Job, type ProcessorEnv } from "../../plugin/src/processing";
import { textProcessor } from "../../plugin/src/processing/text";
import { readManifest, updateManifest } from "../../plugin/src/store";
import { documentRevisionsQueue, processJob } from "../../plugin/src/worker";
import { bucket, clearBucket, revision } from "./helpers";

const MB = 1024 * 1024;
const job = (over: Partial<Job> = {}): Job => ({
	entryId: "e1",
	n: 1,
	key: "entries/e1/files/f1",
	contentType: "text/plain",
	filename: "notes.txt",
	...over,
});

/** Store a file and a manifest whose revisions 1 and 2 share it. */
async function seed(body: string | Uint8Array, j: Job = job()) {
	await bucket().put(j.key, body);
	await updateManifest(bucket(), j.entryId, "doc", (m) => ({
		...m,
		revisions: [
			revision(1, { key: j.key, filename: j.filename, contentType: j.contentType }),
			revision(2, { key: j.key, filename: j.filename, contentType: j.contentType, restoredFrom: 1 }),
			revision(3, { key: "entries/e1/files/other" }),
		],
	}));
}
const textOf = async (n: number) =>
	(await readManifest(bucket(), "e1")).manifest!.revisions.find((r) => r.n === n)!.text;

const aiEnv = (data: unknown = { format: "markdown", data: "# Converted" }) => {
	const toMarkdown = vi.fn(async () => data);
	return { env: { AI: { toMarkdown } } as ProcessorEnv, toMarkdown };
};

beforeEach(clearBucket);

describe("processor selection", () => {
	it.each([
		["text/plain", "a.bin", true],
		["application/json", "a", true],
		["text/csv", "a", true],
		["application/octet-stream", "server.log", true],
		["application/octet-stream", "README.MD", true],
		["application/pdf", "a.pdf", false],
		["application/octet-stream", "a.bin", false],
	])("text accepts %s / %s: %s", (contentType, filename, accepted) => {
		expect(textProcessor.accepts(job({ contentType, filename }), {})).toBe(accepted);
	});

	it("ai-markdown needs the AI binding", () => {
		const pdf = job({ contentType: "application/pdf", filename: "a.pdf" });
		expect(aiMarkdownProcessor.accepts(pdf, {})).toBe(false);
		expect(aiMarkdownProcessor.accepts(pdf, aiEnv().env)).toBe(true);
	});

	it.each(["a.pdf", "a.DOCX", "a.xlsx", "a.odt", "a.html", "a.jpeg", "a.png", "a.svg", "a.csv"])(
		"ai-markdown accepts %s",
		(filename) => {
			expect(aiMarkdownProcessor.accepts(job({ filename, contentType: "x/y" }), aiEnv().env)).toBe(true);
		},
	);

	it.each(["a.zip", "a.exe", "a.mp4", "a.pptx"])("ai-markdown refuses %s", (filename) => {
		expect(aiMarkdownProcessor.accepts(job({ filename, contentType: "x/y" }), aiEnv().env)).toBe(false);
	});

	it("tries the cheap exact path first", () => {
		expect(processors.map((p) => p.name)).toEqual(["text", "ai-markdown"]);
	});

	it("memory bounds", () => {
		expect(textProcessor.readBytes).toBe(25 * MB);
		expect(aiMarkdownProcessor.maxBytes).toBe(25 * MB);
	});

	it("text is stored once per file, not per revision", () => {
		expect(textKey("e1", "entries/e1/files/abc-123")).toBe("entries/e1/text/abc-123.md");
	});
});

describe("processJob", () => {
	it("extracts plain text for every revision that shares the file", async () => {
		await seed("hello world\n");
		const info = await processJob(job(), {});
		expect(info).toMatchObject({ status: "done", processor: "text", chars: 12 });
		expect(info.truncated).toBeUndefined();
		expect(await (await bucket().get(textKey("e1", job().key)))!.text()).toBe("hello world\n");
		expect(await textOf(1)).toEqual(info);
		expect(await textOf(2)).toEqual(info);
		expect(await textOf(3)).toBeUndefined();
	});

	it("doesn't redo finished work", async () => {
		await seed("v1");
		const first = await processJob(job(), {});
		await bucket().put(job().key, "v2 changed");
		expect(await processJob(job(), {})).toEqual(first);
	});

	it("skips files no processor accepts", async () => {
		const j = job({ filename: "a.bin", contentType: "application/octet-stream" });
		await seed(new Uint8Array([1, 2, 3]), j);
		expect(await processJob(j, {})).toMatchObject({ status: "skipped" });
		expect((await textOf(1))?.status).toBe("skipped");
		expect(await bucket().head(textKey("e1", j.key))).toBeNull();
	});

	it("skips files no longer in the revision log, without writing", async () => {
		await seed("x");
		const info = await processJob(job({ key: "entries/e1/files/gone" }), {});
		expect(info).toMatchObject({ status: "skipped", error: "File no longer in the revision log" });
		expect(await textOf(1)).toBeUndefined();
	});

	it("reads only the first 25 MB of a huge text file and marks it truncated", async () => {
		await seed(new Uint8Array(26 * MB).fill(0x61));
		const info = await processJob(job({ filename: "huge.log" }), {});
		expect(info).toMatchObject({ status: "done", truncated: true, chars: MAX_TEXT_CHARS });
	});

	it("caps extracted text at MAX_TEXT_CHARS", async () => {
		await seed("b".repeat(MAX_TEXT_CHARS + 10));
		const info = await processJob(job(), {});
		expect(info).toMatchObject({ status: "done", truncated: true, chars: MAX_TEXT_CHARS });
		expect((await (await bucket().get(textKey("e1", job().key)))!.text()).length).toBe(MAX_TEXT_CHARS);
	});

	it("converts through Workers AI when bound", async () => {
		const j = job({ filename: "report.pdf", contentType: "application/pdf" });
		await seed("%PDF-1.4", j);
		const { env, toMarkdown } = aiEnv();
		expect(await processJob(j, env)).toMatchObject({ status: "done", processor: "ai-markdown", chars: 11 });
		expect(toMarkdown).toHaveBeenCalledWith(expect.objectContaining({ name: "report.pdf" }));
	});

	it("skips files too large to send to Workers AI, without reading them", async () => {
		const j = job({ filename: "big.pdf", contentType: "application/pdf" });
		await seed(new Uint8Array(25 * MB + 1), j);
		const { env, toMarkdown } = aiEnv();
		expect(await processJob(j, env)).toMatchObject({ status: "skipped", error: "Too large to extract (25 MB)" });
		expect(toMarkdown).not.toHaveBeenCalled();
	});

	it("fails (for a retry) when Workers AI reports an error", async () => {
		const j = job({ filename: "bad.pdf", contentType: "application/pdf" });
		await seed("%PDF", j);
		await expect(processJob(j, aiEnv({ format: "error", error: "unsupported" }).env)).rejects.toThrow("unsupported");
	});

	it("fails when the stored file is missing", async () => {
		await seed("x");
		await bucket().delete(job().key);
		await expect(processJob(job(), {})).rejects.toThrow(/is missing/);
	});
});

describe("queue consumer", () => {
	const batch = (attempts: number, body: Job) =>
		createMessageBatch<Job>("document-jobs", [{ id: "m1", timestamp: Date.now(), attempts, body }]);

	it("acks processed messages", async () => {
		await seed("hi");
		const b = batch(1, job());
		const ctx = createExecutionContext();
		await documentRevisionsQueue(b, {});
		const result = await getQueueResult(b, ctx);
		expect(result.explicitAcks).toEqual(["m1"]);
		expect((await textOf(1))?.status).toBe("done");
	});

	it("retries a failing job with backoff", async () => {
		await seed("x");
		await bucket().delete(job().key);
		const b = batch(2, job());
		const ctx = createExecutionContext();
		await documentRevisionsQueue(b, {});
		const result = await getQueueResult(b, ctx);
		expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m1"]);
		expect(result.explicitAcks).toEqual([]);
	});

	it("backs off ten seconds per attempt", async () => {
		await seed("x");
		await bucket().delete(job().key);
		// The test harness doesn't report delaySeconds, so use a hand-made message.
		const retry = vi.fn();
		const ack = vi.fn();
		const message = { id: "m1", timestamp: new Date(), attempts: 2, body: job(), retry, ack };
		await documentRevisionsQueue({ messages: [message] } as unknown as MessageBatch<Job>, {});
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 20 });
		expect(ack).not.toHaveBeenCalled();
	});

	it("records the error and acks after the last attempt", async () => {
		await seed("x");
		await bucket().delete(job().key);
		const b = batch(3, job());
		const ctx = createExecutionContext();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await documentRevisionsQueue(b, {});
		const result = await getQueueResult(b, ctx);
		expect(result.explicitAcks).toEqual(["m1"]);
		expect(await textOf(1)).toMatchObject({ status: "error", error: expect.stringMatching(/is missing/) });
	});
});
