import { describe, expect, it } from "vitest";

import { candidates, etagMatches, fileSegment, parseRange } from "../../plugin/src/permalinks";

describe("fileSegment", () => {
	it.each([
		["tps-report.pdf", "tps-report.pdf"],
		["/tps-report.pdf/", "tps-report.pdf"],
		["2011/08/tps-report.pdf", "tps-report.pdf"],
		["2011/8/tps-report.pdf", null],
		["11/08/tps-report.pdf", null],
		["a/b", null],
		["2011/08", null],
		["", null],
	])("%j → %j", (path, segment) => {
		expect(fileSegment(path)).toBe(segment);
	});
});

describe("candidates: most literal reading first", () => {
	it("plain slug", () => {
		expect(candidates("tps-report")).toEqual([{ slug: "tps-report", n: null }]);
	});

	it("slug with extension", () => {
		expect(candidates("tps-report.pdf")).toEqual([
			{ slug: "tps-report.pdf", n: null },
			{ slug: "tps-report", n: null },
		]);
	});

	it("revision with extension", () => {
		expect(candidates("tps-report-revision-3.pdf")).toEqual([
			{ slug: "tps-report-revision-3.pdf", n: null },
			{ slug: "tps-report-revision-3", n: null },
			{ slug: "tps-report", n: 3 },
		]);
	});

	it("extensionless revision", () => {
		expect(candidates("tps-report-revision-12")).toEqual([
			{ slug: "tps-report-revision-12", n: null },
			{ slug: "tps-report", n: 12 },
		]);
	});

	it("dotted slug", () => {
		expect(candidates("v1.2")).toEqual([
			{ slug: "v1.2", n: null },
			{ slug: "v1", n: null },
		]);
	});

	it("only strips a short alphanumeric extension", () => {
		expect(candidates("a.b-c")).toEqual([{ slug: "a.b-c", n: null }]);
		expect(candidates("a.abcdefghijk")).toEqual([{ slug: "a.abcdefghijk", n: null }]);
	});
});

describe("parseRange", () => {
	it.each([
		[null, 100, null],
		["bytes=0-9", 100, { offset: 0, length: 10 }],
		["bytes=90-", 100, { offset: 90, length: 10 }],
		["bytes=90-500", 100, { offset: 90, length: 10 }],
		["bytes=-6", 100, { offset: 94, length: 6 }],
		["bytes=-500", 100, { offset: 0, length: 100 }],
		["bytes=-0", 100, "unsatisfiable"],
		["bytes=100-", 100, "unsatisfiable"],
		["bytes=9-3", 100, null],
		["bytes=-", 100, null],
		["bytes=0-1,5-6", 100, null],
		["items=0-9", 100, null],
		[" bytes=0-0 ", 100, { offset: 0, length: 1 }],
	] as const)("%j of %i bytes → %j", (header, size, out) => {
		expect(parseRange(header, size)).toEqual(out);
	});
});

describe("etagMatches", () => {
	it.each([
		[null, false],
		['"abc"', true],
		['W/"abc"', true],
		['"x", "abc"', true],
		["*", true],
		['"abd"', false],
	])("If-None-Match %j against \"abc\" → %s", (header, match) => {
		expect(etagMatches(header, '"abc"')).toBe(match);
	});

	it("compares weak and strong forms alike", () => {
		expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
	});
});
