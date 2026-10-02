/**
 * Astro renderers for the plugin's Portable Text blocks, keyed by block
 * `_type` (see admin.portableTextBlocks in ../index.ts). EmDash merges these
 * into <PortableText> automatically, including in content widgets, which is
 * how "Latest documents" works as a sidebar widget.
 */
import DocumentList from "./DocumentList.astro";
import DocumentPreview from "./DocumentPreview.astro";
import DocumentRevisions from "./DocumentRevisions.astro";

export const blockComponents = {
	"document-list": DocumentList,
	"latest-documents": DocumentList,
	"document-revisions": DocumentRevisions,
	"document-preview": DocumentPreview,
};
