/**
 * EmDash Document Revisions
 *
 * Each entry in the `documents` collection owns an ordered list of uploaded
 * files. Files live in a private R2 bucket and are only reachable through
 * permission-checked permalinks (routes/document.ts), never through EmDash's
 * public media route.
 *
 * The package has two halves, because a native plugin descriptor can't
 * inject site routes:
 * - documentRevisions(): the EmDash plugin (admin panel + page, lifecycle hooks)
 * - documentRevisionsRoutes(): an Astro integration that injects the
 *   permalink route and the document APIs (see routes/)
 *
 * Usage in astro.config.mjs:
 *   import { documentRevisions, documentRevisionsRoutes } from "emdash-document-revisions";
 *   integrations: [
 *     emdash({ plugins: [documentRevisions()] }),
 *     documentRevisionsRoutes(),
 *   ]
 */

import type { AstroIntegration } from "astro";
import type { PluginDescriptor } from "emdash";
import { definePlugin, definePluginRoute } from "emdash";

import { fileAccess, type Entry, type User } from "./access";
import {
	bucket,
	COLLECTION,
	deleteAll,
	deleteEntry,
	entryIdForSlug,
	feedKeyUser,
	permalink,
	readManifest,
	readSettings,
	updateManifest,
} from "./store";

const PLUGIN_ID = "document-revisions";
const PLUGIN_VERSION = "0.2.0";
const PACKAGE = "emdash-document-revisions";

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		// users:read resolves a feed key's owner and role for revision feeds.
		capabilities: ["content:read", "users:read"],
		admin: {
			entry: `${PACKAGE}/admin`,
			pages: [
				{ path: "/new", label: "Upload document", icon: "upload-simple" },
				{ path: "/storage", label: "Document settings", icon: "gear" },
			],
		},
		routes: {
			/**
			 * Revision-feed data for a feed key. Public because feed readers
			 * send no session; the key is the credential. Returns JSON that
			 * routes/document.ts renders as Atom (plugin raw responses can't
			 * serve XML). Reached in-process via handlePublicPluginApiRoute.
			 */
			"feed-data": definePluginRoute({
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				handler: async (ctx) => {
					const q = new URL(ctx.request.url).searchParams;
					const denied = { ok: false as const };
					const b = await bucket();
					const userId = await feedKeyUser(b, q.get("key") ?? "");
					const user = userId ? await ctx.users?.get(userId) : null;
					if (!user) return denied;
					const slug = q.get("doc") ?? "";
					const entryId = slug ? await entryIdForSlug(b, slug) : null;
					const item = entryId ? await ctx.content?.get(COLLECTION, entryId) : null;
					if (!item || item.slug !== slug) return denied;
					const { manifest } = await readManifest(b, item.id);
					if (!manifest?.revisions.length) return denied;
					const entry: Entry = {
						id: item.id,
						slug: item.slug,
						status: item.status,
						authorId: item.authorId ?? null,
						data: item.data,
					};
					// The feed lists past revisions, so it needs what revision URLs need.
					const access = fileAccess(user as unknown as User, entry, manifest, {
						revision: true,
						passwordCookieValid: false,
					});
					if (access !== "allow") return denied;
					return {
						ok: true as const,
						title: String(item.data.title ?? slug),
						slug,
						updatedAt: manifest.revisions.at(-1)!.createdAt,
						revisions: [...manifest.revisions].reverse().map((r) => ({
							n: r.n,
							filename: r.filename,
							url: permalink(slug, r, r.n),
							createdAt: r.createdAt,
							authorName: r.authorName,
							note: r.note,
							size: r.size,
						})),
					};
				},
			}),
		},
		hooks: {
			/**
			 * New documents get a manifest with the site's default visibility
			 * (private unless an Admin changes it, as in WP Document
			 * Revisions), and renamed documents keep resolving.
			 */
			"content:afterSave": async (event) => {
				if (event.collection !== COLLECTION) return;
				const id = event.content.id as string | undefined;
				const slug = (event.content.slug as string | null | undefined) ?? null;
				if (!id) return;
				const b = await bucket();
				const { manifest } = await readManifest(b, id);
				if (event.isNew && !manifest) {
					const { defaultVisibility } = await readSettings(b);
					await updateManifest(b, id, slug, (m) => ({ ...m, visibility: { mode: defaultVisibility } }));
					return;
				}
				if (!manifest || manifest.slug === slug) return;
				await updateManifest(b, id, slug, (m) => ({ ...m, slug }));
			},

			/**
			 * Trashing keeps the files (the entry can be restored, and the
			 * permalink already 404s for trashed entries). Permanent deletion
			 * removes them.
			 */
			"content:afterDelete": async (event, ctx) => {
				if (event.collection !== COLLECTION || !event.permanent) return;
				const deleted = await deleteEntry(await bucket(), event.id);
				ctx.log.info("Deleted document files", { entryId: event.id, objects: deleted });
			},

			// EmDash only runs this for marketplace/registry installs; native
			// sites use the Document storage page (routes/api.ts) instead.
			"plugin:uninstall": async (event, ctx) => {
				if (!event.deleteData) return;
				const deleted = await deleteAll(await bucket());
				ctx.log.info("Deleted all document files", { objects: deleted });
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

/** Injects the permalink route and the document APIs. */
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
				// Under core's content namespace so API-token scopes map like
				// core content routes (content:read / content:write).
				injectRoute({
					pattern: "/_emdash/api/content/documents/[id]/files/[...action]",
					entrypoint: `${PACKAGE}/routes/files.ts`,
					prerender: false,
				});
				injectRoute({
					pattern: "/_emdash/api/document-revisions/[...action]",
					entrypoint: `${PACKAGE}/routes/api.ts`,
					prerender: false,
				});
			},
		},
	};
}
