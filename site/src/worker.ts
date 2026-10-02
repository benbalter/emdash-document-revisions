import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { documentRevisionsQueue } from "emdash-document-revisions/worker";

export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
	// Extracts text from uploaded documents (emdash-document-revisions).
	queue: documentRevisionsQueue,
} satisfies ExportedHandler;
