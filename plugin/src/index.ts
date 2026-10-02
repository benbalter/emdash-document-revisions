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

import { accountActive, fileAccess, type Entry, type User } from "./access";
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

const toggle = (action_id: string, label: string, initial_value: boolean) => ({
	type: "toggle" as const,
	action_id,
	label,
	initial_value,
});
const documentField = {
	type: "text_input" as const,
	action_id: "document",
	label: "Document slug",
	placeholder: "employee-handbook",
};

/**
 * Editor blocks matching WP Document Revisions' shortcodes and widget:
 * [documents], [document_revisions], [document_preview], and Latest
 * Documents (which also works as a sidebar widget: EmDash content widgets
 * render Portable Text, plugin blocks included). Renderers: astro/.
 */
const PORTABLE_TEXT_BLOCKS = [
	{
		type: "document-list",
		label: "Document list",
		icon: "files",
		description: "Documents visitors can open, optionally filtered by workflow state",
		category: "Documents",
		fields: [
			{ type: "text_input" as const, action_id: "heading", label: "Heading" },
			{ type: "number_input" as const, action_id: "limit", label: "How many", min: 1, max: 100, initial_value: 20 },
			{ type: "text_input" as const, action_id: "workflow_state", label: "Workflow state (slug, optional)" },
			{
				type: "select" as const,
				action_id: "order_by",
				label: "Order by",
				options: [
					{ value: "published", label: "Published date" },
					{ value: "updated", label: "Last updated" },
					{ value: "title", label: "Title" },
				],
				initial_value: "published",
			},
			{
				type: "select" as const,
				action_id: "order",
				label: "Order",
				options: [
					{ value: "desc", label: "Newest / Z–A first" },
					{ value: "asc", label: "Oldest / A–Z first" },
				],
				initial_value: "desc",
			},
			toggle("show_summary", "Show summaries", false),
			toggle("show_type", "Show file type and size", true),
			toggle("new_tab", "Open in a new tab", false),
		],
	},
	{
		type: "latest-documents",
		label: "Latest documents",
		icon: "clock-counter-clockwise",
		description: "Recently updated documents; also usable as a sidebar widget",
		category: "Documents",
		fields: [
			{ type: "text_input" as const, action_id: "heading", label: "Heading", initial_value: "Latest documents" },
			{ type: "number_input" as const, action_id: "limit", label: "How many", min: 1, max: 50, initial_value: 5 },
			toggle("show_date", "Show date", true),
			toggle("show_type", "Show file type and size", false),
		],
	},
	{
		type: "document-revisions",
		label: "Document revisions",
		icon: "list-numbers",
		description: "A document's revision log (shown only to people who may open past revisions)",
		category: "Documents",
		fields: [
			documentField,
			{ type: "number_input" as const, action_id: "limit", label: "How many", min: 1, max: 100, initial_value: 10 },
			toggle("show_notes", "Show revision notes", true),
			toggle("new_tab", "Open in a new tab", false),
		],
	},
	{
		type: "document-preview",
		label: "Document preview",
		icon: "file-magnifying-glass",
		description: "The current file inline: PDFs and images embedded, others as a download",
		category: "Documents",
		fields: [
			documentField,
			{ type: "number_input" as const, action_id: "height", label: "Height (px)", min: 200, max: 2000, initial_value: 600 },
			toggle("show_title", "Show title", false),
			toggle("show_download", "Show download link", true),
		],
	},
];

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		// users:read resolves a feed key's owner and role for revision feeds.
		capabilities: ["content:read", "users:read"],
		admin: {
			entry: `${PACKAGE}/admin`,
			portableTextBlocks: PORTABLE_TEXT_BLOCKS,
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
					// This route is reachable directly, not only through the site's feed
					// route, so check here that the key's account isn't disabled.
					if (!user || !(await accountActive(user.id))) return denied;
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
						// The site route re-checks this account isn't disabled (see accountActive()).
						userId: user.id,
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
		componentsEntry: `${PACKAGE}/astro`,
		options: {},
	};
}

/** Injects the permalink route and the document APIs. */
export function documentRevisionsRoutes(): AstroIntegration {
	return {
		name: PACKAGE,
		hooks: {
			/**
			 * Dev convenience: EmDash loads native plugin code once, so edits to
			 * this package don't hot-reload. Watch our own source and restart
			 * the dev server when it changes (only when the package is a linked
			 * checkout, which is the only time anyone edits it).
			 */
			"astro:server:setup": ({ server, logger }) => {
				// No imports here: this runs after Astro has closed the module runner
				// that loaded the config, so a dynamic import would throw.
				const dir = decodeURIComponent(new URL(".", import.meta.url).pathname);
				if (dir.includes("/node_modules/")) return;
				server.watcher.add(dir);
				let restarting = false;
				server.watcher.on("change", (file: string) => {
					if (restarting || !file.startsWith(dir)) return;
					restarting = true;
					logger.info(`${file.slice(dir.length)} changed; restarting to reload the plugin`);
					void server.restart().finally(() => {
						restarting = false;
					});
				});
			},
			"astro:config:setup": ({ injectRoute, addMiddleware }) => {
				// Filters private/password document hits out of EmDash's public search.
				addMiddleware({ entrypoint: `${PACKAGE}/middleware.ts`, order: "post" });
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
