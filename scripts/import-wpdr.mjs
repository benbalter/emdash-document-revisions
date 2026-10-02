#!/usr/bin/env node
/**
 * Import a WP Document Revisions export bundle (scripts/wpdr-export.php)
 * into an EmDash site running this plugin.
 *
 *   EMDASH_TOKEN=ec_pat_… node scripts/import-wpdr.mjs <bundle-dir> --site https://example.com [--dry-run]
 *
 * The token must have the `admin` scope, from an Administrator: imports
 * set authors and dates, and look users up by email.
 *
 * The bundle is sensitive (plaintext post passwords, emails, private
 * files): keep it off shared storage and delete it after importing.
 *
 * For each document it:
 *   1. creates the entry with its original slug, title, description and dates;
 *   2. assigns the WordPress author when an EmDash user has the same email;
 *   3. imports every revision with its original number, author, date and
 *      note, uploading each distinct file once;
 *   4. sets private / password-protected visibility;
 *   5. assigns workflow states, creating missing terms;
 *   6. publishes what was published (or private), schedules what was
 *      scheduled, and trashes what was trashed.
 *
 * Re-running is safe: documents whose manifest records the same WordPress
 * ID are skipped, and a slug taken by an unrelated document (or by a
 * document whose earlier import didn't finish) is reported and left alone;
 * delete that entry and re-run to retry it. Old /documents/YYYY/MM/slug-revision-N.ext links keep
 * working because revision numbers are preserved.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		site: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		only: { type: "string" },
	},
});

const bundleDir = positionals[0];
const site = values.site?.replace(/\/$/, "");
const token = process.env.EMDASH_TOKEN;
if (!bundleDir || !site || !token) {
	console.error("Usage: EMDASH_TOKEN=… node scripts/import-wpdr.mjs <bundle-dir> --site <url> [--dry-run] [--only <slug>]");
	process.exit(2);
}
const dryRun = values["dry-run"];

const bundle = JSON.parse(await readFile(join(bundleDir, "export.json"), "utf8"));
if (bundle.format !== "wpdr-export" || bundle.version !== 1) {
	console.error(`Not a version-1 wpdr-export bundle: ${bundleDir}`);
	process.exit(2);
}

class ApiError extends Error {
	constructor(status, code, message) {
		super(`${status} ${code}: ${message}`);
		this.status = status;
		this.code = code;
	}
}

async function api(path, { method = "GET", json, body, headers = {} } = {}) {
	const res = await fetch(`${site}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(json !== undefined ? { "Content-Type": "application/json" } : {}),
			...headers,
		},
		body: json !== undefined ? JSON.stringify(json) : body,
		duplex: body ? "half" : undefined,
	});
	const text = await res.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		payload = { success: false, error: { code: "BAD_RESPONSE", message: text.slice(0, 200) } };
	}
	if (!res.ok || payload.success === false) {
		throw new ApiError(res.status, payload.error?.code ?? "ERROR", payload.error?.message ?? res.statusText);
	}
	return payload.data;
}

const CONTENT = "/_emdash/api/content/documents";

/** EmDash users by lowercased email, for author mapping. */
async function loadUsers() {
	const users = new Map();
	let cursor;
	do {
		const qs = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
		const page = await api(`/_emdash/api/admin/users?${qs}`);
		for (const u of page.items ?? []) users.set(String(u.email).toLowerCase(), u);
		cursor = page.nextCursor;
	} while (cursor);
	return users;
}

/** Workflow-state term IDs by slug, creating missing terms. */
async function termIdFor(slug, name, cache) {
	if (cache.has(slug)) return cache.get(slug);
	if (dryRun) return `dry-${slug}`;
	const created = await api(`/_emdash/api/taxonomies/workflow_state/terms`, {
		method: "POST",
		json: { slug, label: name },
	});
	const id = created.term?.id ?? created.item?.id ?? created.id;
	cache.set(slug, id);
	return id;
}

async function loadTerms() {
	const data = await api(`/_emdash/api/taxonomies/workflow_state/terms`);
	const terms = data.terms ?? data.items ?? [];
	return new Map(terms.map((t) => [t.slug, t.id]));
}

/** The existing entry at this slug, if any. Core's get skips the trash, so look there too. */
async function findBySlug(slug) {
	try {
		const data = await api(`${CONTENT}/${encodeURIComponent(slug)}`);
		return data.item ?? null;
	} catch (e) {
		if (!(e instanceof ApiError && e.status === 404)) throw e;
	}
	let cursor;
	do {
		const qs = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
		const page = await api(`${CONTENT}/trash?${qs}`);
		const hit = (page.items ?? []).find((i) => i.slug === slug);
		if (hit) return hit;
		cursor = page.nextCursor;
	} while (cursor);
	return null;
}

async function importDocument(doc, ctx) {
	const label = `${doc.slug} (WP #${doc.wpId}, ${doc.status})`;
	// Check sizes before creating anything, so an oversized file can't leave
	// a half-imported document behind.
	const tooBig = doc.revisions.find((r) => r.file.size > ctx.maxUploadBytes);
	if (tooBig) {
		return {
			status: "too-large",
			label,
			reason: `revision ${tooBig.n} is ${(tooBig.file.size / 1048576).toFixed(1)} MB; the limit is ${ctx.maxUploadBytes / 1048576} MB`,
		};
	}
	const existing = await findBySlug(doc.slug);
	if (existing) {
		const files = await api(`${CONTENT}/${existing.id}/files`).catch(() => null);
		if (files?.source?.system === "wordpress" && files.source.id === doc.wpId) {
			return { status: "skipped", label, reason: "already imported" };
		}
		return { status: "conflict", label, reason: `slug already used by EmDash entry ${existing.id}` };
	}
	if (dryRun) {
		return { status: "would-import", label, reason: `${doc.revisions.length} revisions` };
	}

	const published = doc.status === "publish" || doc.status === "private";
	const created = await api(CONTENT, {
		method: "POST",
		json: {
			slug: doc.slug,
			data: { title: doc.title, ...(doc.description ? { summary: doc.description } : {}) },
			...(doc.date ? { createdAt: doc.date } : {}),
			...(published && doc.date ? { publishedAt: doc.date } : {}),
		},
	});
	const id = created.item.id;

	const owner = doc.author?.email ? ctx.users.get(doc.author.email.toLowerCase()) : null;
	if (owner) await api(`${CONTENT}/${id}`, { method: "PUT", json: { authorId: owner.id } });

	// Revisions, oldest first; each distinct WordPress attachment is uploaded once.
	const uploadedAs = new Map();
	for (const [i, rev] of doc.revisions.entries()) {
		const qs = new URLSearchParams({
			n: String(rev.n),
			filename: rev.file.filename,
			note: rev.note ?? "",
			createdAt: rev.date ?? "",
			authorName: rev.author?.name ?? "",
			authorEmail: rev.author?.email ?? "",
		});
		// Record the WordPress ID with the *last* revision, so a run that dies
		// halfway isn't mistaken for a finished import on the next run.
		if (i === doc.revisions.length - 1) {
			qs.set("sourceId", String(doc.wpId));
			qs.set("sourceSite", bundle.site);
		}
		const reuse = uploadedAs.get(rev.file.attachmentId);
		if (reuse !== undefined) {
			qs.set("reuse", String(reuse));
			await api(`${CONTENT}/${id}/files/import?${qs}`, { method: "POST" });
		} else {
			const path = resolve(bundleDir, rev.file.path);
			const { size } = await stat(path);
			await api(`${CONTENT}/${id}/files/import?${qs}`, {
				method: "POST",
				body: await readFile(path),
				headers: { "Content-Type": rev.file.contentType, "Content-Length": String(size) },
			});
			uploadedAs.set(rev.file.attachmentId, rev.n);
		}
	}

	if (doc.revisions.length === 0) {
		await api(`${CONTENT}/${id}/files/source`, { method: "POST", json: { id: doc.wpId, site: bundle.site } });
	}

	if (doc.status === "private") {
		await api(`${CONTENT}/${id}/files/visibility`, { method: "POST", json: { mode: "private" } });
	} else if (doc.password) {
		// WordPress stores post passwords in plaintext; EmDash gets a hash.
		await api(`${CONTENT}/${id}/files/visibility`, {
			method: "POST",
			json: { mode: "password", password: doc.password },
		});
	}

	if (doc.workflowStates.length) {
		const termIds = [];
		for (const s of doc.workflowStates) termIds.push(await termIdFor(s.slug, s.name, ctx.terms));
		await api(`${CONTENT}/${id}/terms/workflow_state`, { method: "POST", json: { termIds } });
	}

	if (published) {
		const current = await api(`${CONTENT}/${id}`);
		await api(`${CONTENT}/${id}/publish`, { method: "POST", json: { _rev: current._rev } });
	} else if (doc.status === "future" && doc.date) {
		await api(`${CONTENT}/${id}/schedule`, { method: "POST", json: { scheduledAt: doc.date } });
	} else if (doc.status === "trash") {
		await api(`${CONTENT}/${id}`, { method: "DELETE" });
	}

	return {
		status: "imported",
		label,
		reason: `${doc.revisions.length} revisions, ${uploadedAs.size} files${owner ? "" : ", author kept as name only"}`,
	};
}

const ctx = {
	users: await loadUsers(),
	terms: await loadTerms(),
	maxUploadBytes: (await api("/_emdash/api/document-revisions/me")).maxUploadBytes,
};

const docs = bundle.documents.filter((d) => !values.only || d.slug === values.only);
console.log(`${dryRun ? "[dry run] " : ""}Importing ${docs.length} documents from ${bundle.site} into ${site}`);
const counts = {};
let failed = 0;
for (const doc of docs) {
	try {
		const r = await importDocument(doc, ctx);
		counts[r.status] = (counts[r.status] ?? 0) + 1;
		console.log(`  ${r.status.padEnd(12)} ${r.label}: ${r.reason}`);
	} catch (e) {
		failed++;
		console.log(`  ${"failed".padEnd(12)} ${doc.slug}: ${e.message}`);
	}
}
console.log(
	Object.entries(counts)
		.map(([k, v]) => `${v} ${k}`)
		.concat(failed ? [`${failed} failed`] : [])
		.join(", "),
);
process.exit(failed ? 1 : 0);
