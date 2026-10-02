import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anon, as, CONTENT, lockAs, makeDocument, ONE, uniq, unlock } from "../support/client";

const MiB = 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("Large uploads (streamed, no 8 MiB plugin cap)", () => {
	const admin = as("admin");
	const SLUG = uniq("verify-big");
	const big = randomBytes(30 * MiB);
	let id: string;

	beforeAll(async () => {
		id = await makeDocument(SLUG);
	});

	it("30 MiB upload", async () => {
		expect((await admin.upload(id, big, "application/octet-stream", "big.bin")).status).toBe(201);
	});

	it("30 MiB round-trips byte-identical", async () => {
		const res = await anon().get(`/documents/${SLUG}`);
		expect(res.status).toBe(200);
		expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(big));
	});

	it("missing Content-Length", async () => {
		// A streamed body goes out chunked, with no Content-Length.
		const body = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(ONE));
				c.close();
			},
		});
		expect((await admin.upload(id, body, "text/plain", "one.txt")).status).toBe(411);
	});

	it("over 100 MiB", async () => {
		const res = await admin.upload(id, new Uint8Array(101 * MiB), "application/octet-stream", "huge.bin");
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
	});
});

describe("Multipart uploads (past the 100 MB single-request cap)", () => {
	const admin = as("admin");
	const SLUG = uniq("verify-mp");
	const file = randomBytes(150 * MiB);
	let id: string;
	let otherId: string;

	interface Created {
		uploadId: string;
		key: string;
	}
	const start = (entryId: string, c = admin) =>
		c.post(`${CONTENT}/${entryId}/files/uploads`, { contentType: "application/octet-stream" });
	const partUrl = (entryId: string, up: Created, n: number) =>
		`${CONTENT}/${entryId}/files/uploads/${up.uploadId}/parts/${n}?key=${encodeURIComponent(up.key)}`;

	beforeAll(async () => {
		id = await admin.createDocument(SLUG, `Multipart ${SLUG}`);
		await admin.setVisibility(id, "public");
		otherId = await makeDocument(uniq("verify-mp-other"), { owner: "other" });
	});

	afterAll(() => unlock(id));

	let parts: unknown[] = [];
	let up: Created;

	it("three parts accepted", async () => {
		up = ((await (await start(id)).json()) as { data: Created }).data;
		parts = [];
		for (let i = 0, n = 1; i < file.length; i += 50 * MiB, n++) {
			const res = await admin.fetch(partUrl(id, up, n), { method: "PUT", body: file.subarray(i, i + 50 * MiB) });
			expect(res.status).toBe(200);
			parts.push(((await res.json()) as { data: unknown }).data);
		}
		expect(parts).toHaveLength(3);
	});

	it("complete", async () => {
		const res = await admin.post(`${CONTENT}/${id}/files/uploads/${up.uploadId}/complete`, {
			key: up.key,
			parts,
			filename: "big.bin",
			note: "multipart",
		});
		expect(res.status).toBe(201);
	});

	it("150 MiB round-trips byte-identical", async () => {
		const res = await admin.get(`/documents/${SLUG}`);
		expect(res.status).toBe(200);
		expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(file));
	});

	it("abort", async () => {
		const up2 = ((await (await start(id)).json()) as { data: Created }).data;
		await admin.fetch(partUrl(id, up2, 1), { method: "PUT", body: ONE });
		const res = await admin.fetch(
			`${CONTENT}/${id}/files/uploads/${up2.uploadId}?key=${encodeURIComponent(up2.key)}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
	});

	it("aborted upload adds no revision", async () => {
		const log = await admin.files(id);
		expect(log.revisions).toHaveLength(1);
		expect(log.revisions[0]!.note).toBe("multipart");
	});

	it("a part can't target another document's key", async () => {
		const res = await admin.fetch(
			`${CONTENT}/${id}/files/uploads/x/parts/1?key=${encodeURIComponent(`entries/${otherId}/files/x`)}`,
			{ method: "PUT", body: ONE },
		);
		expect(res.status).toBe(400);
	});

	it("multipart refused while someone else holds the lock", async () => {
		lockAs(id);
		try {
			expect((await admin.post(`${CONTENT}/${id}/files/uploads`, {})).status).toBe(409);
		} finally {
			unlock(id);
		}
	});

	it("author can't start a multipart upload on another's document", async () => {
		expect((await as("author").post(`${CONTENT}/${otherId}/files/uploads`, {})).status).toBe(403);
	});
});

describe("Client-supplied content types", () => {
	const admin = as("admin");

	it("a multipart content type that isn't a MIME type is stored as octet-stream", async () => {
		const slug = uniq("verify-ctype");
		const id = await makeDocument(slug);
		const created = (await (
			await admin.post(`${CONTENT}/${id}/files/uploads`, { contentType: "text/html\r\nX-Injected: 1" })
		).json()) as { data: { uploadId: string; key: string } };
		const up = created.data;
		const part = await admin.fetch(
			`${CONTENT}/${id}/files/uploads/${up.uploadId}/parts/1?key=${encodeURIComponent(up.key)}`,
			{ method: "PUT", body: "<p>hi</p>" },
		);
		const done = await admin.post(`${CONTENT}/${id}/files/uploads/${up.uploadId}/complete`, {
			key: up.key,
			parts: [((await part.json()) as { data: unknown }).data],
			filename: "page.html",
		});
		expect(done.status).toBe(201);
		const res = await anon().get(`/documents/${slug}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("x-injected")).toBeNull();
	});
});
