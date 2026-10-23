/**
 * Terminal lines → cells → SVG → PNG through resvg's WebAssembly build, so every platform renders the
 * same way without a browser or native binary. Runs in pi only; the gateway never loads it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type FontMetrics, type FontSet, loadFonts, missingCjkFontMessage } from "./fonts.ts";
import { type IconName, iconSvg } from "./icons.ts";

export interface CapturedScreen {
	lines: string[];
	columns: number;
	/** The terminal's default colours as #rrggbb. */
	foreground: string;
	background: string;
	palette: ScreenPalette;
}

export interface Cell {
	/** One grapheme; a wide one spans both its columns. */
	text: string;
	width: 1 | 2;
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	inverse?: boolean;
	hidden?: boolean;
}

type Style = Omit<Cell, "text" | "width">;
const STYLE_KEYS = [
	"fg",
	"bg",
	"bold",
	"dim",
	"italic",
	"underline",
	"strike",
	"inverse",
	"hidden",
] as const satisfies readonly (keyof Style)[];

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

const BASE16 = [
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#ffffff",
];

function hex(r: number, g: number, b: number): string {
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function rgb(r: number, g: number, b: number): string | undefined {
	return [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? hex(r, g, b) : undefined;
}

function color256(n: number): string | undefined {
	if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
	if (n < 16) return BASE16[n];
	if (n < 232) {
		const steps = [0, 95, 135, 175, 215, 255];
		const k = n - 16;
		return hex(steps[Math.floor(k / 36)], steps[Math.floor(k / 6) % 6], steps[k % 6]);
	}
	const grey = 8 + (n - 232) * 10;
	return hex(grey, grey, grey);
}

function applySgr(style: Style, params: string): void {
	const groups = (params === "" ? "0" : params)
		.split(";")
		.map((group) => group.split(":").map((part) => (part === "" ? 0 : Number(part))));
	for (let i = 0; i < groups.length; i++) {
		const sub = groups[i];
		const code = sub[0];
		if (code === 38 || code === 48 || code === 58) {
			let color: string | undefined;
			if (sub.length > 1) {
				// Colon form: 38:5:n, 38:2:r:g:b, or 38:2:colorspace:r:g:b.
				if (sub[1] === 5) color = color256(sub[2]);
				else if (sub[1] === 2) color = sub.length >= 6 ? rgb(sub[3], sub[4], sub[5]) : rgb(sub[2], sub[3], sub[4]);
			} else if (groups[i + 1]?.[0] === 5) {
				color = color256(groups[i + 2]?.[0] ?? -1);
				i += 2;
			} else if (groups[i + 1]?.[0] === 2) {
				color = rgb(groups[i + 2]?.[0] ?? -1, groups[i + 3]?.[0] ?? -1, groups[i + 4]?.[0] ?? -1);
				i += 4;
			}
			if (color && code === 38) style.fg = color;
			else if (color && code === 48) style.bg = color;
			continue;
		}
		if (code === 0) for (const key of STYLE_KEYS) delete style[key];
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 3) style.italic = true;
		else if (code === 23) style.italic = false;
		else if (code === 4) style.underline = sub[1] !== 0;
		else if (code === 21) style.underline = true;
		else if (code === 24) style.underline = false;
		else if (code === 7) style.inverse = true;
		else if (code === 27) style.inverse = false;
		else if (code === 8) style.hidden = true;
		else if (code === 28) style.hidden = false;
		else if (code === 9) style.strike = true;
		else if (code === 29) style.strike = false;
		else if (code >= 30 && code <= 37) style.fg = BASE16[code - 30];
		else if (code >= 90 && code <= 97) style.fg = BASE16[code - 82];
		else if (code === 39) delete style.fg;
		else if (code >= 40 && code <= 47) style.bg = BASE16[code - 40];
		else if (code >= 100 && code <= 107) style.bg = BASE16[code - 92];
		else if (code === 49) delete style.bg;
	}
}

/**
 * Best-effort masking of known values only, not a secret scanner: matches across styling, wraps and
 * padding, and replaces whole graphemes with the same number of cells.
 */
export function maskSecrets(rows: Cell[][], secrets: readonly string[]): Cell[][] {
	const needles = new Set<string>();
	for (const secret of secrets) {
		if (!secret) continue;
		const forms = [secret, JSON.stringify(secret).slice(1, -1)];
		try {
			forms.push(encodeURIComponent(secret));
		} catch {
			/* raw form remains available */
		}
		for (const form of forms) if (form.replace(/\s/g, "")) needles.add(form.replace(/\s/g, ""));
	}
	if (!needles.size) return rows;
	let joined = "";
	const positions: { row: number; cell: number }[] = [];
	rows.forEach((cells, row) => {
		cells.forEach((cell, index) => {
			const text = cell.text.replace(/\s/g, "");
			joined += text;
			for (let i = 0; i < text.length; i++) positions.push({ row, cell: index });
		});
	});
	const masked = rows.map(() => new Set<number>());
	for (const needle of needles) {
		for (let at = joined.indexOf(needle); at !== -1; at = joined.indexOf(needle, at + 1)) {
			for (let i = at; i < at + needle.length; i++) masked[positions[i].row].add(positions[i].cell);
		}
	}
	return rows.map((cells, row) =>
		cells.flatMap((cell, index) => {
			if (!masked[row].has(index)) return [cell];
			const star = { ...cell, text: "*", width: 1 as const };
			return cell.width === 2 ? [star, { ...star }] : [star];
		}),
	);
}

// ---------------------------------------------------------------- cells → SVG

/** Theme colours as #rrggbb; the capture reads all of them from pi's theme. */
export interface ScreenPalette {
	accent: string;
	muted: string;
	warning: string;
	link: string;
	variable: string;
}

export interface ScreenHeader {
	directory: string;
	provider: string;
	model: string;
	session: string;
	badge: string;
	badgeIcon: IconName;
	tone?: "accent" | "warning";
}

export interface SvgOptions {
	families: string[];
	/** The header's proportional stack, tried before `families`. */
	sansFamilies?: readonly string[];
	metrics: FontMetrics;
	foreground: string;
	background: string;
	palette: ScreenPalette;
	header?: ScreenHeader;
	fontSize?: number;
	lineHeight?: number;
}

/**
 * Every image is this size, whatever the terminal, so two pi windows and the phone (which shows an
 * image at the chat's width) stay comparable; wider content is scaled down instead of cut.
 */
export const TARGET_PNG_WIDTH = 1600;
export const TARGET_PNG_HEIGHT = 2150;
/** Below the header, 57 rows of a 113-column terminal (0.6 em cells) fill the canvas exactly. */
export const MAX_CONTENT_ROWS = 57;
/** Canvas margins in pixels: the header's content and the grid share the side margins. */
const CANVAS = { padX: 36, gap: 30, bottom: 30 } as const;

const FONT_SIZE = 15;
/** Rows filled edge to edge with one background (messages, tool output) become blocks with round corners. */
const BLOCK_RADIUS = 6;
/** Wide glyphs grow toward their two cells, at most by this factor: monospace Latin is wider than half a CJK em. */
const WIDE_SCALE = 1.12;

/** Cell metrics from the monospace font, clamped so an odd font cannot break the layout. */
export function cellMetrics(metrics: FontMetrics, fontSize = FONT_SIZE, lineHeight?: number) {
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
	bg?: string;
}

/** `rows` is never empty (renderScreenPng refuses an empty screen) and a terminal has at least one column. */
export function cellsToSvg(rows: Cell[][], columns: number, options: SvgOptions): string {
	const width = TARGET_PNG_WIDTH;
	const height = TARGET_PNG_HEIGHT;
	const header = options.header ? headerSvg(options.header, width, options) : undefined;
	const top = (header?.height ?? 0) + CANVAS.gap;
	const grid = gridSvg(rows, columns, options);
	const scale = Math.min((width - 2 * CANVAS.padX) / grid.width, (height - top - CANVAS.bottom) / grid.height);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="100%" height="100%" fill="${options.background}"/>`,
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
			const at = {
				c,
				col,
				fg: (c.inverse ? c.bg : c.fg) ?? (c.inverse ? options.background : options.foreground),
				bg: c.inverse ? (c.fg ?? options.foreground) : c.bg,
			};
			col += c.width;
			return at;
		});
	});
	const blockColor = placed.map((cells) => {
		const first = cells[0];
		const last = cells.at(-1);
		return first?.bg && last && last.col + last.c.width === used && last.bg === first.bg && cells.every((p) => p.bg)
			? first.bg
			: undefined;
	});
	const out: string[] = [];
	for (let row = 0; row < rows.length; ) {
		const color = blockColor[row];
		let end = row + 1;
		while (color && end < rows.length && blockColor[end] === color) end++;
		if (color)
			out.push(
				`<rect x="${x(0)}" y="${y(row)}" width="${round(used * cell.width)}" height="${round((end - row) * cell.height)}" rx="${BLOCK_RADIUS}" fill="${color}"/>`,
			);
		row = end;
	}
	placed.forEach((cells, row) => {
		for (let i = 0; i < cells.length; ) {
			const bg = cells[i].bg;
			let j = i + 1;
			while (j < cells.length && cells[j].bg === bg) j++;
			if (bg && bg !== blockColor[row]) {
				const end = cells[j - 1].col + cells[j - 1].c.width;
				out.push(
					`<rect x="${x(cells[i].col)}" y="${y(row)}" width="${round((end - cells[i].col) * cell.width)}" height="${cell.height}" fill="${bg}"/>`,
				);
			}
			i = j;
		}
	});
	// A wide glyph is drawn larger, up to filling its two cells, with its centre (about 0.38 em up) kept in place.
	const wide = Math.min(WIDE_SCALE, Math.max(1, (2 * cell.width) / fontSize));
	const wideAttrs = wide > 1 ? ` font-size="${round(fontSize * wide)}"` : "";
	const wideShift = fontSize * (wide - 1) * 0.38;
	out.push(`<g font-family="${escapeXml(fontFamilyList(options.families))}" font-size="${fontSize}">`);
	placed.forEach((cells, row) => {
		const baseline = round(y(row) + cell.baseline);
		for (const p of cells) {
			if (p.c.hidden) continue;
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
			if (p.c.hidden || p.c.text.trim() === "") {
				i++;
				continue;
			}
			const attrs = textAttributes(p.fg, p.c);
			if (p.c.width === 1 && p.c.text.length === 1) {
				const run = [p];
				let j = i + 1;
				while (j < cells.length) {
					const q = cells[j];
					if (
						q.c.width !== 1 ||
						q.c.text.length !== 1 ||
						q.c.hidden ||
						q.c.text === " " ||
						textAttributes(q.fg, q.c) !== attrs
					)
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
	/** The rule between the header and the terminal grid. */
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

function headerSvg(header: ScreenHeader, width: number, options: SvgOptions): { svg: string; height: number } {
	const colors = headerColors(options, header.tone);
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
			shownPrefix ? `<tspan fill="${colors.prefix}">${escapeXml(shownPrefix)}</tspan>` : "",
			`<tspan font-weight="700" fill="${colors.values[i]}">${escapeXml(shownValue)}</tspan></text>`,
		].join("");
	});
	const svg = [
		`<rect width="${width}" height="${band}" fill="${colors.band}"/>`,
		`<rect width="${width}" height="${HEADER.strip}" fill="${colors.tone}"/>`,
		`<rect y="${band}" width="${width}" height="${HEADER.rule}" fill="${colors.rule}"/>`,
		`<rect x="${left}" y="${tileTop}" width="${HEADER.tile}" height="${HEADER.tile}" rx="${HEADER.tileRadius}" fill="${colors.tile}"${colors.tileStroke ? ` stroke="${colors.tileStroke}" stroke-width="2"` : ""}/>`,
		`<svg x="${left + (HEADER.tile - HEADER.logo) / 2}" y="${tileTop + (HEADER.tile - HEADER.logo) / 2}" width="${HEADER.logo}" height="${HEADER.logo}" viewBox="165.29 165.29 469.43 469.43">${PI_LOGO}</svg>`,
		...lines,
		`<rect x="${pillX}" y="${pillTop}" width="${pillWidth}" height="${pill.height}" rx="${pill.height / 2}" fill="${colors.pill}"/>`,
		iconSvg(
			header.badgeIcon,
			round(pillX + pill.padX),
			round(pillTop + (pill.height - pill.icon) / 2),
			pill.icon,
			colors.pillText,
			2.25,
		),
		`<text x="${round(pillX + pill.padX + pill.icon + pill.gap)}" y="${baseline(pillTop, pill.height, pill.text)}" font-family="${sans}" font-size="${pill.text}" font-weight="700" fill="${colors.pillText}">${escapeXml(header.badge)}</text>`,
	].join("");
	return { svg, height: band + HEADER.rule };
}

/** A quiet prefix and a bold value on one row: the value is shortened first, the prefix only if it alone overflows. */
function fitPair(prefix: string, value: string, limit: number, size: number): [string, string] {
	const prefixWidth = fitWidth(prefix, sansMeasure(size));
	if (prefixWidth < limit) return [prefix, fitText(value, limit - prefixWidth, sansMeasure(size, true))];
	return [fitText(prefix, limit, sansMeasure(size)), ""];
}

/**
 * Every text and icon colour is pushed toward white or black until it reaches its floor against the
 * band: 7:1 for values, 4.5:1 for prefixes and pill text, 3:1 for icons and the rule. Of pi's built-in
 * themes only the light theme's values need it.
 */
export function headerColors(
	options: Pick<SvgOptions, "foreground" | "background" | "palette">,
	tone?: "accent" | "warning",
) {
	const { foreground: fg, background: bg, palette } = options;
	const dark = isDark(bg);
	const ink = dark ? "#ffffff" : "#000000";
	const band = mix(fg, bg, dark ? 0.08 : 0.045);
	const toneColor = tone === "warning" ? palette.warning : palette.accent;
	const pill = mix(toneColor, band, dark ? 0.22 : 0.15);
	const hues = [palette.accent, palette.link, palette.variable];
	return {
		band,
		tone: toneColor,
		rule: withContrast(band, band, contrast(fg, band) >= 3 ? fg : ink, 3),
		tile: dark ? mix(fg, band, 0.12) : bg,
		tileStroke: dark ? undefined : mix(fg, bg, 0.14),
		prefix: withContrast(palette.muted, band, ink, 4.5),
		values: [
			withContrast(fg, band, ink, 7),
			withContrast(palette.link, band, ink, 7),
			withContrast(palette.variable, band, ink, 7),
		],
		icons: hues.map((hue) => withContrast(hue, band, ink, 3)),
		pill,
		pillText: withContrast(toneColor, pill, ink, 4.5),
	};
}

/** Colours reaching the renderer are #rrggbb by construction (ANSI parsing and colorToHex); anything else is a bug. */
function rgbOf(color: string): [number, number, number] {
	const match = /^#([0-9a-f]{6})$/i.exec(color);
	if (!match) throw new Error(`invalid colour: ${color}`);
	const n = parseInt(match[1], 16);
	return [n >> 16, (n >> 8) & 255, n & 255];
}

/** `weight` of a over b. */
function mix(a: string, b: string, weight: number): string {
	const x = rgbOf(a);
	const y = rgbOf(b);
	return hex(...(x.map((v, i) => Math.round(v * weight + y[i] * (1 - weight))) as [number, number, number]));
}

function isDark(color: string): boolean {
	const c = rgbOf(color);
	return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5;
}

/** WCAG relative luminance. */
function luminance(color: string): number {
	const [r, g, b] = rgbOf(color).map((v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

function withContrast(color: string, background: string, ink: string, min: number): string {
	for (let step = 0; step <= 40; step++) {
		const candidate = mix(ink, color, step / 40);
		if (contrast(candidate, background) >= min) return candidate;
	}
	return ink;
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

export function fitText(text: string, max: number, measure: Measure): string {
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
	return ` fill="${fill}"${c.bold ? ' font-weight="bold"' : ""}${c.italic ? ' font-style="italic"' : ""}${c.dim ? ' fill-opacity="0.6"' : ""}`;
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
	secrets?: readonly string[];
	/** Overrides for tests. */
	fonts?: FontSet;
	header?: ScreenHeader;
	fontSize?: number;
	lineHeight?: number;
}

const HEADER_TEXT = ["directory", "provider", "model", "session", "badge"] as const;

export async function renderScreenPng(screen: CapturedScreen, options: RenderOptions = {}): Promise<Uint8Array> {
	const secrets = options.secrets ?? [];
	const rows = trimBlankRows(maskSecrets(screen.lines.map(parseAnsiLine), secrets));
	if (!rows.length) throw new Error("当前终端画面是空的");
	const header = options.header && maskHeader(options.header, secrets);
	const fonts = options.fonts ?? loadFonts();
	const headerText = header ? HEADER_TEXT.map((key) => header[key]).join("") : "";
	if (!fonts.hasCjk && (CJK.test(headerText) || rows.some((cells) => cells.some((cell) => CJK.test(cell.text))))) {
		throw new Error(missingCjkFontMessage(fonts.platform));
	}
	// Keep the newest rows and pad the bottom, so the geometry (and therefore the text scale) is the
	// same for every image; the footer padding is the terminal background, i.e. deliberately empty.
	const content = rows.slice(-MAX_CONTENT_ROWS);
	const padded: Cell[][] = [...content, ...Array.from({ length: MAX_CONTENT_ROWS - content.length }, () => [])];
	const svg = cellsToSvg(padded, screen.columns, {
		families: fonts.families,
		sansFamilies: fonts.sansFamilies,
		metrics: fonts.metrics,
		foreground: screen.foreground,
		background: screen.background,
		palette: screen.palette,
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

function maskHeader(header: ScreenHeader, secrets: readonly string[]): ScreenHeader {
	const masked = { ...header };
	for (const key of HEADER_TEXT) {
		masked[key] = maskSecrets([parseAnsiLine(header[key])], secrets)[0]
			.map((cell) => cell.text)
			.join("");
	}
	return masked;
}

function trimBlankRows(rows: Cell[][]): Cell[][] {
	const blank = (cells: Cell[]) => cells.every((cell) => !cell.text.trim() && !cell.bg && !cell.inverse);
	let start = 0;
	let end = rows.length;
	while (start < end && blank(rows[start])) start++;
	while (end > start && blank(rows[end - 1])) end--;
	return rows.slice(start, end);
}
