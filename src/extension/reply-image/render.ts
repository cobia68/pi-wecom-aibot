/**
 * pi-tui's rendered Markdown lines → cells → SVG → PNG through resvg's WebAssembly build. Runs in pi only,
 * without a browser or fetching embedded resources.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type FontMetrics, type FontSet, loadFonts, missingCjkFontMessage } from "./fonts.ts";
import { type IconName, iconSvg } from "./icons.ts";

export interface ReplyPage {
	lines: string[];
	columns: number;
}

/** One light theme for every image: Markdown styles and the header are drawn in these. */
export const COLORS = {
	foreground: "#182330",
	background: "#ffffff",
	accent: "#2357a3",
	muted: "#526170",
	link: "#075985",
	variable: "#5b21b6",
} as const;
const HEADER_COLORS = {
	band: "#f5f5f6",
	rule: "#878c93",
	tileStroke: "#dfe0e2",
	values: [COLORS.foreground, "#075782", COLORS.variable],
	icons: [COLORS.accent, COLORS.link, COLORS.variable],
	pill: "#d6ddea",
} as const;

export interface Cell {
	/** One grapheme; a wide one spans both its columns. */
	text: string;
	width: 1 | 2;
	fg?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
}

type Style = Omit<Cell, "text" | "width">;
const STYLE_KEYS = ["fg", "bold", "italic", "underline", "strike"] as const satisfies readonly (keyof Style)[];

// ---------------------------------------------------------------- ANSI → cells

/** CSI (SGR and the rest), OSC, string sequences such as APC (pi's cursor markers, image protocols), other escapes. */
const ESCAPE =
	/\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/y;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function parseAnsiLine(line: string): Cell[] {
	const cells: Cell[] = [];
	const style: Style = {};
	let text = "";
	const flush = () => {
		if (!text) return;
		for (const { segment } of graphemes.segment(text)) {
			const width = visibleWidth(segment);
			if (width <= 0) continue;
			cells.push({ text: segment, width: width >= 2 ? 2 : 1, ...style });
		}
		text = "";
	};
	let i = 0;
	while (i < line.length) {
		const char = line[i];
		if (char === "\x1b") {
			flush();
			ESCAPE.lastIndex = i;
			const match = ESCAPE.exec(line);
			if (!match || match[0].length === 0) {
				i++;
				continue;
			}
			if (match[3] === "m" && !match[2] && !/[<=>?]/.test(match[1] ?? "")) applySgr(style, match[1] ?? "");
			i += match[0].length;
			continue;
		}
		if (char === "\t") text += "   ";
		else if (char >= " " && char !== "\x7f" && !(char >= "\x80" && char <= "\x9f")) text += char;
		i++;
	}
	flush();
	return cells;
}

function hex(r: number, g: number, b: number): string {
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The styles our Markdown theme writes: bold, italic, underline, strike and 24-bit foreground colours. */
function applySgr(style: Style, params: string): void {
	const codes = (params === "" ? "0" : params).split(";").map((part) => (part === "" ? 0 : Number(part)));
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === 38 && codes[i + 1] === 2) {
			const [r, g, b] = codes.slice(i + 2, i + 5);
			if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) style.fg = hex(r, g, b);
			i += 4;
		} else if (code === 0) for (const key of STYLE_KEYS) delete style[key];
		else if (code === 1) style.bold = true;
		else if (code === 22) style.bold = false;
		else if (code === 3) style.italic = true;
		else if (code === 23) style.italic = false;
		else if (code === 4) style.underline = true;
		else if (code === 24) style.underline = false;
		else if (code === 9) style.strike = true;
		else if (code === 29) style.strike = false;
		else if (code === 39) delete style.fg;
	}
}

// ---------------------------------------------------------------- cells → SVG

export interface ImageHeader {
	directory: string;
	provider: string;
	model: string;
	session: string;
	badge: string;
	badgeIcon: IconName;
}

export interface SvgOptions {
	families: string[];
	/** The header's proportional stack, tried before `families`. */
	sansFamilies?: readonly string[];
	metrics: FontMetrics;
	header?: ImageHeader;
	fontSize?: number;
	lineHeight?: number;
}

/** Fixed width, variable height; the caller paginates, rather than discarding rows or shrinking the whole reply. */
export const TARGET_PNG_WIDTH = 1600;
export const MAX_CONTENT_ROWS = 160;
/** Canvas margins in pixels: the header's content and the grid share the side margins. */
const CANVAS = { padX: 36, gap: 30, bottom: 30 } as const;

const FONT_SIZE = 15;
/** Wide glyphs grow toward their two cells, at most by this factor: monospace Latin is wider than half a CJK em. */
const WIDE_SCALE = 1.12;

/** Cell metrics from the monospace font, clamped so an odd font cannot break the layout. */
function cellMetrics(metrics: FontMetrics, fontSize = FONT_SIZE, lineHeight?: number) {
	const width = fontSize * Math.min(0.75, Math.max(0.45, metrics.advance || 0.6));
	const natural = (metrics.ascent || 0.8) + (metrics.descent || 0.2) + (metrics.lineGap || 0);
	const height = Math.round(fontSize * (lineHeight ?? Math.min(1.6, Math.max(1.15, natural))));
	const ascent = metrics.ascent || 0.8;
	const descent = metrics.descent || 0.2;
	const baseline = (height - fontSize * (ascent + descent)) / 2 + fontSize * ascent;
	return { width, height, baseline };
}

interface Placed {
	c: Cell;
	col: number;
	fg: string;
}

/** Each bounded page keeps all its rows at the same readable scale; a short reply needs no blank canvas. */
export function cellsToSvg(rows: Cell[][], columns: number, options: SvgOptions): string {
	if (!rows.length || rows.length > MAX_CONTENT_ROWS) throw new Error("图片分页行数超出限制");
	const width = TARGET_PNG_WIDTH;
	const header = options.header ? headerSvg(options.header, width, options) : undefined;
	const top = (header?.height ?? 0) + CANVAS.gap;
	const grid = gridSvg(rows, columns, options);
	const scale = (width - 2 * CANVAS.padX) / grid.width;
	const height = Math.ceil(top + grid.height * scale + CANVAS.bottom);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
		header?.svg ?? "",
		`<svg x="${CANVAS.padX}" y="${top}" width="${round(grid.width * scale)}" height="${round(grid.height * scale)}" viewBox="0 0 ${round(grid.width)} ${round(grid.height)}">${grid.body}</svg>`,
		"</svg>",
	].join("");
}

function gridSvg(
	rows: Cell[][],
	columns: number,
	options: SvgOptions,
): { body: string; width: number; height: number } {
	const fontSize = options.fontSize ?? FONT_SIZE;
	const cell = cellMetrics(options.metrics, fontSize, options.lineHeight);
	const used = Math.max(columns, ...rows.map((cells) => cells.reduce((sum, c) => sum + c.width, 0)));
	const x = (col: number) => round(col * cell.width);
	const y = (row: number) => round(row * cell.height);
	const placed = rows.map((cells) => {
		let col = 0;
		return cells.map((c): Placed => {
			const at = { c, col, fg: c.fg ?? COLORS.foreground };
			col += c.width;
			return at;
		});
	});
	const out: string[] = [];
	// A wide glyph is drawn larger, up to filling its two cells, with its centre (about 0.38 em up) kept in place.
	const wide = Math.min(WIDE_SCALE, Math.max(1, (2 * cell.width) / fontSize));
	const wideAttrs = wide > 1 ? ` font-size="${round(fontSize * wide)}"` : "";
	const wideShift = fontSize * (wide - 1) * 0.38;
	out.push(`<g font-family="${escapeXml(fontFamilyList(options.families))}" font-size="${fontSize}">`);
	placed.forEach((cells, row) => {
		const baseline = round(y(row) + cell.baseline);
		for (const p of cells) {
			if (p.c.underline)
				out.push(
					`<rect x="${x(p.col)}" y="${round(baseline + fontSize * 0.12)}" width="${round(p.c.width * cell.width)}" height="1" fill="${p.fg}"/>`,
				);
			if (p.c.strike)
				out.push(
					`<rect x="${x(p.col)}" y="${round(baseline - fontSize * 0.3)}" width="${round(p.c.width * cell.width)}" height="1" fill="${p.fg}"/>`,
				);
		}
		for (let i = 0; i < cells.length; ) {
			const p = cells[i];
			if (p.c.text.trim() === "") {
				i++;
				continue;
			}
			const attrs = textAttributes(p.fg, p.c);
			if (p.c.width === 1 && p.c.text.length === 1) {
				const run = [p];
				let j = i + 1;
				while (j < cells.length) {
					const q = cells[j];
					if (q.c.width !== 1 || q.c.text.length !== 1 || q.c.text === " " || textAttributes(q.fg, q.c) !== attrs)
						break;
					run.push(q);
					j++;
				}
				out.push(
					`<text x="${run.map((r) => x(r.col)).join(" ")}" y="${baseline}"${attrs}>${escapeXml(run.map((r) => r.c.text).join(""))}</text>`,
				);
				i = j;
			} else {
				const wideGlyph = p.c.width === 2;
				out.push(
					`<text x="${round((p.col + p.c.width / 2) * cell.width)}" y="${wideGlyph ? round(baseline + wideShift) : baseline}" text-anchor="middle"${wideGlyph ? wideAttrs : ""}${attrs}>${escapeXml(p.c.text)}</text>`,
				);
				i++;
			}
		}
	});
	out.push("</g>");
	return { body: out.join(""), width: used * cell.width, height: rows.length * cell.height };
}

/** Header sizes in canvas pixels. */
const HEADER = {
	top: 30,
	bottom: 30,
	strip: 6,
	/** The rule between the header and the reply. */
	rule: 3,
	row: 48,
	text: 34,
	icon: 30,
	/** Icons sit centred in a fixed column, so the three rows' text starts at one x. */
	iconColumn: 40,
	iconGap: 16,
	tile: 112,
	tileRadius: 26,
	logo: 64,
	tileGap: 26,
	pill: { height: 64, text: 32, icon: 32, padX: 26, gap: 12 },
	pillGap: 28,
} as const;
/** Pi's mark (pi.dev/logo-auto.svg), in its three brand colours. */
const PI_LOGO = [
	'<path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/>',
	'<path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/>',
	'<path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/>',
].join("");

function headerSvg(header: ImageHeader, width: number, options: SvgOptions): { svg: string; height: number } {
	const colors = HEADER_COLORS;
	const sans = escapeXml(fontFamilyList([...new Set([...(options.sansFamilies ?? []), ...options.families])]));
	const { row, text } = HEADER;
	const band = HEADER.top + 3 * row + HEADER.bottom;
	const left = CANVAS.padX;
	const right = width - CANVAS.padX;
	const columnX = left + HEADER.tile + HEADER.tileGap;
	const textX = columnX + HEADER.iconColumn + HEADER.iconGap;
	const rowTop = (i: number) => HEADER.top + i * row;
	// Baselines put the text's visual middle (about 0.35 em above the baseline) in the middle of its box.
	const baseline = (top: number, box: number, size: number) => round(top + box / 2 + size * 0.35);
	const pill = HEADER.pill;
	const pillWidth = round(pill.padX * 2 + pill.icon + pill.gap + fitWidth(header.badge, sansMeasure(pill.text, true)));
	const pillX = round(right - pillWidth);
	const pillTop = round(rowTop(0) + (row - pill.height) / 2);
	const tileTop = HEADER.top + (3 * row - HEADER.tile) / 2;
	// The pill reaches into the second row's box, so the first two rows stop before it; text widths are
	// estimated and shortened with an ellipsis, with no second clip behind them.
	const besidePill = Math.max(0, pillX - HEADER.pillGap - textX);
	const rows: { icon: IconName; prefix: string; value: string; limit: number }[] = [
		{ icon: "folder", prefix: "", value: header.directory, limit: besidePill },
		{ icon: "bot", prefix: header.provider ? `${header.provider} · ` : "", value: header.model, limit: besidePill },
		{ icon: "message-square-code", prefix: "session ", value: header.session, limit: Math.max(0, right - textX) },
	];
	const lines = rows.map(({ icon, prefix, value, limit }, i) => {
		const top = rowTop(i);
		const [shownPrefix, shownValue] = fitPair(prefix, value, limit, text);
		const iconAt = round(top + (row - HEADER.icon) / 2);
		return [
			iconSvg(icon, round(columnX + (HEADER.iconColumn - HEADER.icon) / 2), iconAt, HEADER.icon, colors.icons[i]),
			`<text x="${textX}" y="${baseline(top, row, text)}" font-family="${sans}" font-size="${text}">`,
			shownPrefix ? `<tspan fill="${COLORS.muted}">${escapeXml(shownPrefix)}</tspan>` : "",
			`<tspan font-weight="700" fill="${colors.values[i]}">${escapeXml(shownValue)}</tspan></text>`,
		].join("");
	});
	const svg = [
		`<rect width="${width}" height="${band}" fill="${colors.band}"/>`,
		`<rect width="${width}" height="${HEADER.strip}" fill="${COLORS.accent}"/>`,
		`<rect y="${band}" width="${width}" height="${HEADER.rule}" fill="${colors.rule}"/>`,
		`<rect x="${left}" y="${tileTop}" width="${HEADER.tile}" height="${HEADER.tile}" rx="${HEADER.tileRadius}" fill="${COLORS.background}" stroke="${colors.tileStroke}" stroke-width="2"/>`,
		`<svg x="${left + (HEADER.tile - HEADER.logo) / 2}" y="${tileTop + (HEADER.tile - HEADER.logo) / 2}" width="${HEADER.logo}" height="${HEADER.logo}" viewBox="165.29 165.29 469.43 469.43">${PI_LOGO}</svg>`,
		...lines,
		`<rect x="${pillX}" y="${pillTop}" width="${pillWidth}" height="${pill.height}" rx="${pill.height / 2}" fill="${colors.pill}"/>`,
		iconSvg(
			header.badgeIcon,
			round(pillX + pill.padX),
			round(pillTop + (pill.height - pill.icon) / 2),
			pill.icon,
			COLORS.accent,
			2.25,
		),
		`<text x="${round(pillX + pill.padX + pill.icon + pill.gap)}" y="${baseline(pillTop, pill.height, pill.text)}" font-family="${sans}" font-size="${pill.text}" font-weight="700" fill="${COLORS.accent}">${escapeXml(header.badge)}</text>`,
	].join("");
	return { svg, height: band + HEADER.rule };
}

/** A quiet prefix and a bold value on one row: the value is shortened first, the prefix only if it alone overflows. */
function fitPair(prefix: string, value: string, limit: number, size: number): [string, string] {
	const prefixWidth = fitWidth(prefix, sansMeasure(size));
	if (prefixWidth < limit) return [prefix, fitText(value, limit - prefixWidth, sansMeasure(size, true))];
	return [fitText(prefix, limit, sansMeasure(size)), ""];
}

type Measure = (segment: string) => number;

/** An estimate for proportional text; the ellipsis counts one em because CJK fonts draw it full-width. */
function sansMeasure(size: number, bold = false): Measure {
	return (segment) =>
		size *
		(visibleWidth(segment) >= 2 || segment === "…"
			? 1
			: /[A-Z0-9mw]/.test(segment)
				? bold
					? 0.72
					: 0.68
				: bold
					? 0.6
					: 0.55);
}

function fitWidth(text: string, measure: Measure): number {
	let width = 0;
	for (const { segment } of graphemes.segment(text)) width += measure(segment);
	return width;
}

function fitText(text: string, max: number, measure: Measure): string {
	if (fitWidth(text, measure) <= max) return text;
	const budget = max - measure("…");
	let kept = "";
	let width = 0;
	for (const { segment } of graphemes.segment(text)) {
		width += measure(segment);
		if (width > budget) break;
		kept += segment;
	}
	return `${kept.trimEnd()}…`;
}

function textAttributes(fill: string, c: Cell): string {
	return ` fill="${fill}"${c.bold ? ' font-weight="bold"' : ""}${c.italic ? ' font-style="italic"' : ""}`;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function escapeXml(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fontFamilyList(families: readonly string[]): string {
	return families.map((family) => (family === "monospace" ? family : `'${family.replace(/['\\]/g, "")}'`)).join(", ");
}

// ---------------------------------------------------------------- SVG → PNG

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

interface ResvgModule {
	initWasm(module: Uint8Array): Promise<void>;
	Resvg: new (svg: string, options?: object) => { render(): { asPng(): Uint8Array; free(): void }; free(): void };
}

let resvg: Promise<ResvgModule> | undefined;

/** Once per process; a reload reuses the initialised module. */
function loadResvg(): Promise<ResvgModule> {
	resvg ??= (async () => {
		const require = createRequire(import.meta.url);
		const module = require("@resvg/resvg-wasm") as ResvgModule;
		try {
			await module.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
		} catch (error) {
			if (!(error instanceof Error && /already initialized/i.test(error.message))) throw error;
		}
		return module;
	})().catch((error: unknown) => {
		resvg = undefined;
		throw new Error(
			`无法加载图片渲染组件 @resvg/resvg-wasm（${error instanceof Error ? error.message : String(error)}）；请在插件目录运行 npm install`,
		);
	});
	return resvg;
}

export interface RenderOptions {
	/** Overrides for tests and for reusing a font set across pages. */
	fonts?: FontSet;
	header?: ImageHeader;
	fontSize?: number;
	lineHeight?: number;
}

const HEADER_TEXT = ["directory", "provider", "model", "session", "badge"] as const;

export async function renderReplyPage(page: ReplyPage, options: RenderOptions = {}): Promise<Uint8Array> {
	const rows = page.lines.map(parseAnsiLine);
	if (!rows.length) throw new Error("正文没有可渲染的文字");
	const header = options.header;
	const fonts = options.fonts ?? loadFonts();
	const headerText = header ? HEADER_TEXT.map((key) => header[key]).join("") : "";
	if (!fonts.hasCjk && (CJK.test(headerText) || rows.some((cells) => cells.some((cell) => CJK.test(cell.text))))) {
		throw new Error(missingCjkFontMessage(fonts.platform));
	}
	const svg = cellsToSvg(rows, page.columns, {
		families: fonts.families,
		sansFamilies: fonts.sansFamilies,
		metrics: fonts.metrics,
		header,
		fontSize: options.fontSize,
		lineHeight: options.lineHeight,
	});
	const { Resvg } = await loadResvg();
	// The SVG is already the canvas size, so it rasterises 1:1.
	const renderer = new Resvg(svg, {
		font: { fontBuffers: fonts.buffers, defaultFontFamily: fonts.families[0], monospaceFamily: fonts.families[0] },
	});
	try {
		const image = renderer.render();
		try {
			return image.asPng();
		} finally {
			image.free();
		}
	} finally {
		renderer.free();
	}
}
