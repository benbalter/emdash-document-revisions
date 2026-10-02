#!/usr/bin/env node
/**
 * Create (or repair) what emdash-document-revisions needs on an existing
 * EmDash site: the `documents` collection with its fields and features,
 * search, and the `workflow_state` taxonomy.
 *
 *   EMDASH_TOKEN=ec_pat_… node scripts/setup-collection.mjs --site https://your-site.example [--dry-run] [--no-workflow-states]
 *
 * Why a script: EmDash applies seed files only when a site's database is
 * first created, and its CLI can't set a collection's features (drafts,
 * revisions, search) or make fields searchable. New sites can copy the
 * collection from site/seed/seed.json instead.
 *
 * Safe to re-run: existing pieces are left alone or brought up to date.
 * The token needs the `admin` scope (Settings → API tokens, as an Administrator).
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		site: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		"no-workflow-states": { type: "boolean", default: false },
	},
});
const site = values.site?.replace(/\/$/, "");
const token = process.env.EMDASH_TOKEN;
if (!site || !token) {
	console.error("Usage: EMDASH_TOKEN=… node scripts/setup-collection.mjs --site <url> [--dry-run] [--no-workflow-states]");
	process.exit(2);
}
const dryRun = values["dry-run"];

const COLLECTION = {
	slug: "documents",
	label: "Documents",
	labelSingular: "Document",
	urlPattern: "/documents/{slug}",
	supports: ["drafts", "revisions", "search"],
};
const FIELDS = [
	{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
	{ slug: "summary", label: "Summary", type: "text", searchable: true },
];
const TAXONOMY = {
	name: "workflow_state",
	label: "Workflow states",
	labelSingular: "Workflow state",
	hierarchical: false,
	collections: ["documents"],
};
const TERMS = [
	{ slug: "draft", label: "Draft" },
	{ slug: "in-review", label: "In review" },
	{ slug: "final", label: "Final" },
];

async function api(path, { method = "GET", json } = {}) {
	const res = await fetch(`${site}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) },
		body: json ? JSON.stringify(json) : undefined,
	});
	const body = await res.json().catch(() => ({}));
	return { status: res.status, ok: res.ok && body.success !== false, data: body.data, error: body.error };
}

async function change(description, path, opts) {
	if (dryRun) {
		console.log(`  would ${description}`);
		return;
	}
	let r = await api(path, opts);
	// EmDash answers 409 while a just-deleted collection finishes deleting.
	for (let attempt = 1; r.status === 409 && attempt <= 5; attempt++) {
		await new Promise((done) => setTimeout(done, 2000));
		r = await api(path, opts);
	}
	if (!r.ok) throw new Error(`${description}: ${r.status} ${r.error?.message ?? ""}`);
	console.log(`  ${description}`);
}

console.log(`${dryRun ? "[dry run] " : ""}Setting up ${site}`);

// 1. Collection and its features.
const existing = await api(`/_emdash/api/schema/collections/${COLLECTION.slug}`);
if (existing.status === 404) {
	await change(`create the "${COLLECTION.slug}" collection`, "/_emdash/api/schema/collections", {
		method: "POST",
		json: COLLECTION,
	});
} else if (!existing.ok) {
	throw new Error(`Can't read the collection: ${existing.status} ${existing.error?.message ?? ""}`);
} else {
	const supports = existing.data.item.supports ?? [];
	const missing = COLLECTION.supports.filter((s) => !supports.includes(s));
	if (missing.length) {
		await change(`turn on ${missing.join(", ")}`, `/_emdash/api/schema/collections/${COLLECTION.slug}`, {
			method: "PUT",
			json: { supports: [...new Set([...supports, ...COLLECTION.supports])] },
		});
	} else {
		console.log(`  "${COLLECTION.slug}" collection already set up`);
	}
}

// 2. Fields.
const current =
	dryRun && existing.status === 404
		? { data: { items: [] } }
		: await api(`/_emdash/api/schema/collections/${COLLECTION.slug}/fields`);
const fields = new Map((current.data?.items ?? []).map((f) => [f.slug, f]));
for (const field of FIELDS) {
	const have = fields.get(field.slug);
	if (!have) {
		await change(`add the "${field.slug}" field`, `/_emdash/api/schema/collections/${COLLECTION.slug}/fields`, {
			method: "POST",
			json: field,
		});
	} else if (field.searchable && !have.searchable) {
		await change(`make "${field.slug}" searchable`, `/_emdash/api/schema/collections/${COLLECTION.slug}/fields/${field.slug}`, {
			method: "PUT",
			json: { searchable: true },
		});
	}
}

// 3. Search index (the plugin filters restricted documents out of results).
await change("enable search for documents", "/_emdash/api/search/enable", {
	method: "POST",
	json: { collection: COLLECTION.slug, enabled: true },
});

// 4. Workflow states.
if (!values["no-workflow-states"]) {
	const taxonomies = await api("/_emdash/api/taxonomies");
	const list = taxonomies.data?.taxonomies ?? taxonomies.data?.items ?? [];
	if (!list.some((t) => t.name === TAXONOMY.name)) {
		await change(`create the "${TAXONOMY.name}" taxonomy`, "/_emdash/api/taxonomies", { method: "POST", json: TAXONOMY });
	}
	const terms = dryRun ? { data: { terms: [] } } : await api(`/_emdash/api/taxonomies/${TAXONOMY.name}/terms`);
	const have = new Set((terms.data?.terms ?? []).map((t) => t.slug));
	for (const term of TERMS) {
		if (!have.has(term.slug)) {
			await change(`add the "${term.label}" workflow state`, `/_emdash/api/taxonomies/${TAXONOMY.name}/terms`, {
				method: "POST",
				json: term,
			});
		}
	}
}

console.log(dryRun ? "Dry run complete; nothing changed." : "Done.");
