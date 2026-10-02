/**
 * Pure request-parsing helpers for the /documents/… permalink route
 * (routes/document.ts): URL shapes, Range and If-None-Match. Kept free of
 * runtime imports so they can be unit-tested on their own.
 */

/**
 * Slugs are free-form and may contain dots or end in "-revision-N", so try
 * the most literal reading first: exact slug, then slug without extension,
 * then the revision forms.
 */
export function candidates(segment: string): Array<{ slug: string; n: number | null }> {
	const out: Array<{ slug: string; n: number | null }> = [{ slug: segment, n: null }];
	const noExt = segment.replace(/\.[A-Za-z0-9]{1,10}$/, "");
	if (noExt !== segment) out.push({ slug: noExt, n: null });
	for (const base of new Set([segment, noExt])) {
		const m = /^(.+)-revision-(\d+)$/.exec(base);
		if (m) out.push({ slug: m[1]!, n: Number.parseInt(m[2]!, 10) });
	}
	return out;
}

/** The file part of a permalink path: `slug.ext`, or WordPress's `YYYY/MM/slug.ext`. */
export function fileSegment(path: string): string | null {
	const parts = path.split("/").filter(Boolean);
	if (parts.length === 1) return parts[0]!;
	if (parts.length === 3 && /^\d{4}$/.test(parts[0]!) && /^\d{2}$/.test(parts[1]!)) return parts[2]!;
	return null;
}

export function etagMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	if (header.trim() === "*") return true;
	const bare = (t: string) => t.trim().replace(/^W\//, "");
	return header.split(",").some((t) => bare(t) === bare(etag));
}

/** Parse a single `bytes=` range against a file size. null = serve the whole file. */
export function parseRange(
	header: string | null,
	size: number,
): { offset: number; length: number } | "unsatisfiable" | null {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === "" && m[2] === "")) return null;
	if (m[1] === "") {
		// Suffix range: the last N bytes.
		const n = Number(m[2]);
		if (n === 0) return "unsatisfiable";
		const length = Math.min(n, size);
		return { offset: size - length, length };
	}
	const start = Number(m[1]);
	if (start >= size) return "unsatisfiable";
	const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (end < start) return null;
	return { offset: start, length: end - start + 1 };
}
