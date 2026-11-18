// Shared drawing helpers for the profile's SVG plates.
//
// The type and grammar follow yuhanwang.page: Metropolitan Line (an open Johnston revival)
// for display text, JetBrains Mono for small uppercase labels, viewfinder corner ticks
// instead of boxes, and signal orange only for live marks. Backgrounds stay transparent and
// neutrals come from GitHub's own palette, so every plate sits on the page it is shown on.
// Each plate renders once per GitHub theme; the README picks the right one with <picture>.

import { readFileSync } from "node:fs";

const FONT_DIR = new URL("../../assets/fonts/", import.meta.url);
const METRICS = JSON.parse(readFileSync(new URL("metrics.json", FONT_DIR), "utf8"));

export const THEMES = {
  dark: { ink: "#f0f6fc", text: "#d1d7e0", muted: "#9198a1", tick: "#4d5561", rule: "#30363d", grid: "#262c36", accent: "#ff5a1f" },
  light: { ink: "#1f2328", text: "#31373d", muted: "#59636e", tick: "#b7c0c9", rule: "#d1d9e0", grid: "#eef1f4", accent: "#e8501a" },
};

export const WIDTH = 840;
export const MARGIN = 40;

const FONTS = {
  display: { family: "Metropolitan Line", file: "metropolitan-line.woff2", metrics: "metropolitan", fallback: "'Gill Sans', 'Segoe UI', sans-serif" },
  mono: { family: "JetBrains Mono", file: "jetbrains-mono-500.woff2", metrics: "jetbrains", fallback: "ui-monospace, Menlo, Consolas, monospace" },
};

let fontFaceCache;
function fontFaces() {
  if (!fontFaceCache) {
    fontFaceCache = Object.values(FONTS)
      .map((font) => {
        const data = readFileSync(new URL(font.file, FONT_DIR)).toString("base64");
        return "    @font-face { font-family: '" + font.family + "'; src: url(data:font/woff2;base64," + data + ") format('woff2'); }";
      })
      .join("\n");
  }
  return fontFaceCache;
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function round(value) {
  return Number(value.toFixed(2));
}

// Glyph positions from the font's own advances and kerning. Every <text> gets an explicit
// x per character, so typing animations and carets line up exactly in any browser.
export function measure(content, font, size, tracking = 0) {
  const metrics = METRICS[FONTS[font].metrics];
  const scale = size / metrics.unitsPerEm;
  const fallbackAdvance = metrics.unitsPerEm * 0.6;
  const xs = [];
  let x = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (index > 0) x += (metrics.kerning[content[index - 1] + char] || 0) * scale;
    xs.push(x);
    const advance = metrics.advances[char] === undefined ? fallbackAdvance : metrics.advances[char];
    x += advance * scale + tracking;
  }
  return { xs, width: content.length ? x - tracking : 0 };
}

export function drawText(content, options) {
  const { x, y, font = "display", size, fill, opacity, anchor = "start", tracking = 0, className, extra } = options;
  const { xs, width } = measure(content, font, size, tracking);
  const shift = anchor === "middle" ? width / 2 : anchor === "end" ? width : 0;
  const parts = [
    'class="' + font + (className ? " " + className : "") + '"',
    'x="' + xs.map((value) => round(x - shift + value)).join(" ") + '"',
    'y="' + round(y) + '"',
    'font-size="' + size + '"',
    'fill="' + fill + '"',
  ];
  if (opacity !== undefined) parts.push('fill-opacity="' + opacity + '"');
  if (extra) parts.push(extra);
  return "<text " + parts.join(" ") + ">" + escapeXml(content) + "</text>";
}

// Small uppercase mono label, the way the site labels its clocks and frames.
export function drawLabel(content, options) {
  return drawText(content.toUpperCase(), Object.assign({ font: "mono", size: 10, tracking: 1.5, fill: options.theme.muted }, options));
}

export function drawFrame(width, height, theme, labels = {}) {
  const inset = 14.5;
  const arm = 14;
  const right = width - inset;
  const bottom = height - inset;
  const ticks = [
    "M" + inset + " " + (inset + arm) + "V" + inset + "H" + (inset + arm),
    "M" + (right - arm) + " " + inset + "H" + right + "V" + (inset + arm),
    "M" + inset + " " + (bottom - arm) + "V" + bottom + "H" + (inset + arm),
    "M" + (right - arm) + " " + bottom + "H" + right + "V" + (bottom - arm),
  ].join(" ");
  const out = ['  <path d="' + ticks + '" fill="none" stroke="' + theme.tick + '" stroke-width="1" />'];
  if (labels.topLeft) out.push("  " + drawLabel(labels.topLeft, { theme, x: MARGIN, y: 33 }));
  if (labels.topRight) out.push("  " + drawLabel(labels.topRight, { theme, x: width - MARGIN, y: 33, anchor: "end" }));
  return out;
}

export function arrowPath(x, y, size) {
  return "M" + x + " " + (y + size) + "L" + (x + size) + " " + y + "M" + (x + size * 0.3) + " " + y + "H" + (x + size) + "V" + (y + size * 0.7);
}

export function svgDocument({ width, height, title, description, style = "", body }) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-labelledby="plate-title plate-desc">',
    '  <title id="plate-title">' + escapeXml(title) + "</title>",
    '  <desc id="plate-desc">' + escapeXml(description) + "</desc>",
    "  <style>",
    fontFaces(),
    "    text { font-kerning: none; font-variant-ligatures: none; white-space: pre; text-rendering: geometricPrecision; }",
    "    .display { font-family: '" + FONTS.display.family + "', " + FONTS.display.fallback + "; }",
    "    .mono { font-family: '" + FONTS.mono.family + "', " + FONTS.mono.fallback + "; }",
    style,
    "  </style>",
  ]
    .concat(body)
    .concat(["</svg>", ""])
    .join("\n");
}
