import type { Processor } from "./index";

const TEXT_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/tab-separated-values",
	"application/json",
	"application/xml",
	"text/xml",
]);

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|log)$/i;

/** Plain-text formats need no conversion: store the text as-is. */
export const textProcessor: Processor = {
	name: "text",
	// Plain text can be cut anywhere: read the first 25 MB of a huge log.
	readBytes: 25 * 1024 * 1024,
	accepts: (job) => TEXT_TYPES.has(job.contentType) || TEXT_EXTENSIONS.test(job.filename),
	run: async (file) => file.text(),
};
