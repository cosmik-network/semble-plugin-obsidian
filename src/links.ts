import type { Loc, Pos } from "obsidian";

/*
 * Web link extraction. Kept free of runtime `obsidian` imports so it can be
 * unit tested in plain Node.
 *
 * Obsidian's metadata cache doesn't record external links, so http(s) URLs
 * are found by scanning the whole note text, including frontmatter and code.
 */

export interface WebLink {
	/** The http(s) URL. */
	url: string;
	/** Anchor or alt text, falling back to the URL. */
	displayText: string;
	/** True for remote images: `![alt](https://…)`. */
	image: boolean;
	/** The link exactly as written in the note. */
	original: string;
	/** Location in the note. */
	position: Pos;
}

const WEB_URL = /^https?:\/\//i;

// [text](url "title") and ![alt](url). The destination may be <wrapped> or
// contain one level of balanced parentheses (e.g. Wikipedia URLs).
const MARKDOWN_LINK =
	/(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
// <https://example.com>
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^\s<>]+)>/gi;
// Bare https://example.com, which Obsidian renders as a link.
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`[\]]+/gi;

type Range = [start: number, end: number];

export function extractLinks(content: string): WebLink[] {
	const lineStarts = computeLineStarts(content);
	const links: WebLink[] = [];
	const add = (start: number, end: number, link: Omit<WebLink, "original" | "position">) => {
		if (!WEB_URL.test(link.url)) return;
		links.push({
			original: content.slice(start, end),
			position: { start: toLoc(start, lineStarts), end: toLoc(end, lineStarts) },
			...link,
		});
	};

	let text = content;

	// Each pass masks what it matched so later, looser patterns don't re-match it.
	const matched: Range[] = [];
	for (const m of text.matchAll(MARKDOWN_LINK)) {
		const start = m.index;
		const end = start + m[0].length;
		matched.push([start, end]);
		const url = unwrapDestination(m[3] ?? "");
		add(start, end, { url, displayText: (m[2] ?? "").trim() || url, image: m[1] === "!" });
	}
	text = mask(text, matched);

	matched.length = 0;
	for (const m of text.matchAll(AUTOLINK)) {
		const start = m.index;
		const end = start + m[0].length;
		matched.push([start, end]);
		const url = m[1] ?? "";
		add(start, end, { url, displayText: url, image: false });
	}
	text = mask(text, matched);

	for (const m of text.matchAll(BARE_URL)) {
		const url = trimTrailingPunctuation(m[0]);
		add(m.index, m.index + url.length, { url, displayText: url, image: false });
	}

	return links.sort((a, b) => a.position.start.offset - b.position.start.offset);
}

/** Blank out ranges with spaces, keeping newlines so offsets and line numbers are preserved. */
function mask(text: string, ranges: Range[]): string {
	if (ranges.length === 0) return text;
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	let out = "";
	let cursor = 0;
	for (const [start, end] of sorted) {
		const from = Math.max(start, cursor);
		if (end <= from) continue;
		out += text.slice(cursor, from) + text.slice(from, end).replace(/[^\n]/g, " ");
		cursor = end;
	}
	return out + text.slice(cursor);
}

function unwrapDestination(dest: string): string {
	return dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1) : dest;
}

/** Drop sentence punctuation after a bare URL, keeping a `)` that closes a `(` inside it. */
export function trimTrailingPunctuation(url: string): string {
	let end = url.length;
	while (end > 0) {
		const ch = url[end - 1] ?? "";
		if (ch === ")") {
			const body = url.slice(0, end);
			const opens = body.split("(").length - 1;
			const closes = body.split(")").length - 1;
			if (opens >= closes) break;
		} else if (!".,;:!?*_~\"'".includes(ch)) {
			break;
		}
		end--;
	}
	return url.slice(0, end);
}

function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
	return starts;
}

function toLoc(offset: number, lineStarts: number[]): Loc {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo, col: offset - (lineStarts[lo] ?? 0), offset };
}
