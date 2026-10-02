/**
 * Typed HTTP helpers for the integration suites: a client per signed-in
 * user (or anonymous), document fixtures, and access to the dev server's
 * local D1 and R2 state.
 */

import { randomUUID } from "node:crypto";

import { inject } from "vitest";

import { D1, r2Count, userId, type UserKey } from "./db";

export const BASE = inject("baseUrl");
export const CONTENT = "/_emdash/api/content/documents";
export const API = "/_emdash/api/document-revisions";

/** EmDash's response envelope. */
export interface Envelope<T> {
	success: boolean;
	data: T;
	error?: { code: string; message: string };
}

export interface RevisionView {
	n: number;
	filename: string;
	contentType: string;
	size: number;
	authorName: string | null;
	note: string | null;
	createdAt: string;
	restoredFrom?: number | null;
	text?: { status: string; truncated?: boolean; chars?: number; error?: string };
	url: string | null;
}

export interface FilesView {
	entryId: string;
	slug: string | null;
	status: string;
	visibility: { mode: "public" | "private" | "password"; hasPassword: boolean };
	lock: { userId: string } | null;
	source: { system: string; id: number } | null;
	canEdit: boolean;
	revisions: RevisionView[];
	edits: Array<{ id: string; createdAt: string; authorName: string | null }>;
}

type Body = RequestInit["body"];

export class Client {
	private cookies = new Map<string, string>();

	constructor(cookieHeader = "") {
		for (const part of cookieHeader.split(/;\s*/).filter(Boolean)) {
			const i = part.indexOf("=");
			this.cookies.set(part.slice(0, i), part.slice(i + 1));
		}
	}

	get cookieHeader(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}

	/** Raw request. Sends EmDash's CSRF header unless `csrf: false`. */
	async fetch(path: string, init: RequestInit & { csrf?: boolean } = {}): Promise<Response> {
		const { csrf = true, ...rest } = init;
		const headers = new Headers(rest.headers);
		if (csrf && !headers.has("X-EmDash-Request")) headers.set("X-EmDash-Request", "1");
		if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", this.cookieHeader);
		const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
			redirect: "manual",
			...rest,
			headers,
		});
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const i = pair!.indexOf("=");
			this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
		}
		return res;
	}

	get(path: string, init: RequestInit & { csrf?: boolean } = {}) {
		return this.fetch(path, init);
	}

	post(path: string, json: unknown = {}, init: RequestInit & { csrf?: boolean } = {}) {
		return this.fetch(path, {
			...init,
			method: "POST",
			headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
			body: JSON.stringify(json),
		});
	}

	/** GET or POST, expecting a successful envelope; returns its data. */
	async json<T>(path: string, init: RequestInit = {}): Promise<T> {
		const res = await this.fetch(path, init);
		const body = (await res.json()) as Envelope<T>;
		if (!res.ok || !body.success) {
			throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body)}`);
		}
		return body.data;
	}

	async postJson<T>(path: string, json: unknown = {}): Promise<T> {
		return this.json<T>(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(json),
		});
	}

	/** Copy of this client with its own cookie jar (e.g. to add a password cookie). */
	clone(): Client {
		return new Client(this.cookieHeader);
	}

	addCookies(from: Client): this {
		for (const [k, v] of from.cookies) this.cookies.set(k, v);
		return this;
	}

	// --- Documents -------------------------------------------------------

	async createDocument(slug: string, title: string): Promise<string> {
		const data = await this.postJson<{ item: { id: string } }>(CONTENT, { slug, data: { title } });
		return data.item.id;
	}

	async publish(id: string): Promise<void> {
		await this.postJson(`${CONTENT}/${id}/publish`);
	}

	upload(
		id: string,
		body: Body,
		contentType: string,
		filename: string,
		init: RequestInit & { csrf?: boolean } = {},
	) {
		return this.fetch(`${CONTENT}/${id}/files?filename=${encodeURIComponent(filename)}`, {
			...init,
			method: "POST",
			headers: { "Content-Type": contentType, ...(init.headers as Record<string, string>) },
			body,
			...(body instanceof ReadableStream ? { duplex: "half" } : {}),
		} as RequestInit);
	}

	restore(id: string, n: number) {
		return this.post(`${CONTENT}/${id}/files/restore`, { n });
	}

	setVisibility(id: string, mode: "public" | "private" | "password", password = "") {
		return this.post(`${CONTENT}/${id}/files/visibility`, { mode, password });
	}

	files(id: string): Promise<FilesView> {
		return this.json<FilesView>(`${CONTENT}/${id}/files`);
	}

	trash(id: string) {
		return this.fetch(`${CONTENT}/${id}`, { method: "DELETE" });
	}

	/**
	 * Trash, then delete for good. The plugin removes the files in core's
	 * afterDelete hook, which can finish after the response; use
	 * settledR2Count() to check them.
	 */
	async deletePermanently(id: string): Promise<void> {
		const trashed = await this.trash(id);
		if (!trashed.ok) throw new Error(`trash ${id}: ${trashed.status}`);
		const res = await this.fetch(`${CONTENT}/${id}/permanent`, { method: "DELETE" });
		if (!res.ok) throw new Error(`permanent delete ${id}: ${res.status}`);
	}
}

const sessions = inject("sessions");

export const anon = () => new Client();
/** A client signed in as one of the test users (fresh cookie jar each call). */
export const as = (key: UserKey) => new Client(sessions[key]);

/** Unique per test run and call, so suites never collide on slugs. */
export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export const ONE = "one\n";
export const TWO_PDF = "%PDF-1.4 fake two\n";

export interface DocOptions {
	title?: string;
	files?: Array<{ body: Body; type: string; name: string }>;
	visibility?: "public" | "private" | "password";
	password?: string;
	publish?: boolean;
	owner?: UserKey;
	by?: Client;
}

/**
 * Create a document as an Admin, upload files, set visibility (public unless
 * given: the product default is private), publish, and optionally hand it to
 * another owner.
 */
export async function makeDocument(slug: string, opts: DocOptions = {}): Promise<string> {
	const c = opts.by ?? as("admin");
	const id = await c.createDocument(slug, opts.title ?? slug);
	for (const f of opts.files ?? [{ body: ONE, type: "text/plain", name: "one.txt" }]) {
		const res = await c.upload(id, f.body, f.type, f.name);
		if (res.status !== 201) throw new Error(`upload to ${slug} failed: ${res.status} ${await res.text()}`);
	}
	const vis = await c.setVisibility(id, opts.visibility ?? "public", opts.password ?? "");
	if (!vis.ok) throw new Error(`visibility for ${slug} failed: ${vis.status} ${await vis.text()}`);
	if (opts.publish ?? true) await c.publish(id);
	if (opts.owner) setOwner(id, opts.owner);
	return id;
}

// --- Local state ---------------------------------------------------------

let d1: D1 | undefined;
/** The dev server's D1 database (opened lazily, shared within a file). */
export function db(): D1 {
	d1 ??= new D1(inject("stateDir"));
	return d1;
}

export const r2count = (prefix: string) => r2Count(inject("stateDir"), prefix);

/**
 * The object count under `prefix` once it reaches `expected`, or the last
 * count after a few seconds. For work done in hooks after the response.
 */
export async function settledR2Count(prefix: string, expected: number, timeoutMs = 10_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	let n = r2count(prefix);
	while (n !== expected && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 200));
		n = r2count(prefix);
	}
	return n;
}

export function setOwner(entryId: string, key: UserKey): void {
	db().run("update ec_documents set author_id = ? where id = ?", userId(key), entryId);
}

/** Insert a live core edit lock held by `key` (default: the other editor). */
export function lockAs(entryId: string, key: UserKey = "other"): void {
	const now = new Date();
	db().run(
		"insert into _emdash_entry_locks (collection, entry_id, user_id, token, acquired_at, expires_at) values ('documents', ?, ?, 'test', ?, ?)",
		entryId,
		userId(key),
		now.toISOString(),
		new Date(now.getTime() + 5 * 60_000).toISOString(),
	);
}

export function unlock(entryId: string): void {
	db().run("delete from _emdash_entry_locks where entry_id = ?", entryId);
}

export function setRole(key: UserKey, role: number): void {
	db().run("update users set role = ? where id = ?", role, userId(key));
}

/** Poll until `fn` returns a value that isn't undefined. */
export async function eventually<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined) return v;
		if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** The Cache-Control header, or null. */
export const cacheControl = (res: Response) => res.headers.get("cache-control");
