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
 *   permalink route and the /_emdash/api/document-revisions/* API
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
import { definePlugin } from "emdash";

import { bucket, COLLECTION, deleteAll, deleteEntry, readManifest, updateManifest } from "./store";

const PLUGIN_ID = "document-revisions";
const PLUGIN_VERSION = "0.2.0";
const PACKAGE = "emdash-document-revisions";

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["content:read"],
		admin: {
			entry: `${PACKAGE}/admin`,
			pages: [{ path: "/new", label: "Upload document", icon: "upload-simple" }],
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

/** Injects the permalink route and the document API. */
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
				injectRoute({
					pattern: "/_emdash/api/document-revisions/[...action]",
					entrypoint: `${PACKAGE}/routes/api.ts`,
					prerender: false,
				});
			},
		},
	};
}
