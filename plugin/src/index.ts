/**
 * EmDash Document Revisions
 *
 * Each entry in the `documents` collection owns an ordered list of uploaded
 * files. Files live in a private R2 bucket and are only reachable through the
 * permission-checked `/documents/:slug` permalink (see routes/document.ts),
 * never through EmDash's public media route.
 *
 * Usage in astro.config.mjs:
 *   import { documentRevisions, documentRevisionsRoutes } from "emdash-document-revisions";
 *   integrations: [
 *     emdash({ plugins: [documentRevisions()] }),
 *     documentRevisionsRoutes(),
 *   ]
 */

import type { AstroIntegration } from "astro";
import type { PluginDescriptor, RouteContext } from "emdash";
import { definePlugin, definePluginRoute, PluginRouteError } from "emdash";

import {
	activeLock,
	bucket,
	COLLECTION,
	LOCK_TTL_MS,
	readManifest,
	revisionObjectKey,
	Role,
	updateManifest,
} from "./store";

const PLUGIN_ID = "document-revisions";
const PLUGIN_VERSION = "0.1.0";
const PACKAGE = "emdash-document-revisions";

/** Plugin route bodies are buffered and capped by EmDash at 8 MiB. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

type Ctx = RouteContext<unknown>;

/**
 * Authors may only touch their own documents; editors and admins any.
 * Mirrors core's content:edit_own / content:edit_any split, which a route's
 * single `permission` can't express on its own.
 */
async function loadEditable(ctx: Ctx, entryId: string) {
	const user = ctx.user;
	if (!user) throw PluginRouteError.unauthorized();
	if (!ctx.content) throw PluginRouteError.internal("content:read capability missing");
	const entry = await ctx.content.get(COLLECTION, entryId);
	if (!entry) throw PluginRouteError.notFound("Document not found");
	if (user.role < Role.EDITOR && entry.authorId !== user.id) {
		throw PluginRouteError.forbidden("You can only change your own documents");
	}
	return { user, entry };
}

function param(ctx: Ctx, name: string): string {
	const value = new URL(ctx.request.url).searchParams.get(name);
	if (!value) throw PluginRouteError.badRequest(`Missing ${name}`);
	return value;
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["content:read"],
		admin: {
			entry: `${PACKAGE}/admin`,
		},
		routes: {
			/** Revision log and lock state for one document. */
			revisions: definePluginRoute({
				methods: ["GET"],
				permission: "content:read_drafts",
				request: { body: "none" },
				handler: async (ctx) => {
					const entryId = param(ctx, "entryId");
					const { manifest } = await readManifest(await bucket(), entryId);
					return {
						// Storage keys stay server-side; clients download by slug + n.
						revisions: (manifest?.revisions ?? []).map(({ key: _key, ...r }) => r).reverse(),
						lock: activeLock(manifest),
						userId: ctx.user?.id ?? null,
					};
				},
			}),

			/**
			 * Upload a new revision. The raw file is the request body; metadata
			 * rides in the query string because `bytes` mode has no envelope.
			 */
			upload: definePluginRoute({
				methods: ["POST"],
				permission: "content:edit_own",
				request: { body: "bytes", maxBytes: MAX_UPLOAD_BYTES },
				handler: async (ctx) => {
					const entryId = param(ctx, "entryId");
					const filename = param(ctx, "filename").slice(0, 255);
					const note = new URL(ctx.request.url).searchParams.get("note")?.slice(0, 500) || null;
					const { user, entry } = await loadEditable(ctx, entryId);
					const bytes = ctx.input;
					if (!bytes.byteLength) throw PluginRouteError.badRequest("Empty file");

					const b = await bucket();
					const lock = activeLock((await readManifest(b, entryId)).manifest);
					if (lock && lock.userId !== user.id) {
						throw PluginRouteError.conflict(`Checked out by ${lock.userName ?? "another user"}`);
					}

					const contentType =
						ctx.request.headers.get("content-type")?.split(";")[0]?.trim() ||
						"application/octet-stream";

					// Write the object before the manifest: an orphaned object is
					// harmless, a manifest entry pointing at nothing is not.
					const key = revisionObjectKey(entryId);
					await b.put(key, bytes, { httpMetadata: { contentType } });

					const next = await updateManifest(b, entryId, entry.slug, (m) => {
						return {
							...m,
							slug: entry.slug,
							revisions: [
								...m.revisions,
								{
									n: (m.revisions.at(-1)?.n ?? 0) + 1,
									key,
									filename,
									contentType,
									size: bytes.byteLength,
									authorId: user.id,
									authorName: user.name ?? user.email,
									note,
									createdAt: new Date().toISOString(),
								},
							],
						};
					});
					const { key: _key, ...revision } = next.revisions.at(-1)!;
					return { revision };
				},
			}),

			/** Check a document out (or back in) so others can't upload over it. */
			lock: definePluginRoute({
				methods: ["POST"],
				permission: "content:edit_own",
				request: { body: "json" },
				handler: async (ctx) => {
					const input = ctx.input as { entryId?: unknown; action?: unknown };
					if (typeof input?.entryId !== "string") throw PluginRouteError.badRequest("Missing entryId");
					const action = input.action === "release" ? "release" : "acquire";
					const { user, entry } = await loadEditable(ctx, input.entryId);
					const b = await bucket();

					const next = await updateManifest(b, input.entryId, entry.slug, (m) => {
						const held = activeLock(m);
						if (held && held.userId !== user.id && user.role < Role.EDITOR) {
							throw PluginRouteError.conflict(`Checked out by ${held.userName ?? "another user"}`);
						}
						return {
							...m,
							lock:
								action === "release"
									? null
									: {
											userId: user.id,
											userName: user.name ?? user.email,
											expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
										},
						};
					});
					return { lock: activeLock(next) };
				},
			}),
		},
		hooks: {
			/** Keep the slug → entry index current so renamed documents keep resolving. */
			"content:afterSave": async (event) => {
				if (event.collection !== COLLECTION) return;
				const id = event.content.id as string | undefined;
				const slug = (event.content.slug as string | null | undefined) ?? null;
				if (!id) return;
				const b = await bucket();
				const { manifest } = await readManifest(b, id);
				if (!manifest || manifest.slug === slug) return;
				await updateManifest(b, id, slug, (m) => ({ ...m, slug }));
			},
		},
	});
}

export default createPlugin;

/** Descriptor for `emdash({ plugins: [...] })`. */
export function documentRevisions(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: `${PACKAGE}/admin`,
		options: {},
	};
}

/**
 * Native plugin descriptors can't inject site routes, so the document
 * permalink ships as a separate Astro integration.
 */
export function documentRevisionsRoutes(): AstroIntegration {
	return {
		name: PACKAGE,
		hooks: {
			"astro:config:setup": ({ injectRoute }) => {
				injectRoute({
					pattern: "/documents/[...path]",
					entrypoint: `${PACKAGE}/routes/document.ts`,
					prerender: false,
				});
			},
		},
	};
}
