// Shared drawing helpers for the profile's SVG plates.
//
// The visual system follows yuhanwang.page: a graphite ground, lamplit-paper ink,
// signal orange used only for live marks, Metropolitan Line (an open Johnston revival)
// for display text, JetBrains Mono for small uppercase labels, and viewfinder corner
// ticks instead of boxes. Fonts are subset and embedded so every visitor sees them.

import { readFileSync } from "node:fs";

const FONT_DIR = new URL("../../assets/fonts/", import.meta.url);
const METRICS = JSON.parse(readFileSync(new URL("metrics.json", FONT_DIR), "utf8"));

export const COLORS = {
  ground: "#151515",
  ink: "#E8E5DE",
  muted: "#A0A0A0",
  hairline: "#2E2E2E",
  accent: "#FF5A1F",
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
  const { x, y, font = "display", size, fill = COLORS.ink, opacity, anchor = "start", tracking = 0, className, extra } = options;
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
  return drawText(content.toUpperCase(), Object.assign({ font: "mono", size: 10, tracking: 1.5, opacity: 0.55 }, options));
}

export function drawFrame(width, height, labels = {}) {
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
  const out = ['  <path d="' + ticks + '" fill="none" stroke="' + COLORS.ink + '" stroke-opacity="0.3" stroke-width="1" />'];
  if (labels.topLeft) out.push("  " + drawLabel(labels.topLeft, { x: MARGIN, y: 33 }));
  if (labels.topRight) out.push("  " + drawLabel(labels.topRight, { x: width - MARGIN, y: 33, anchor: "end" }));
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
    '  <rect width="' + width + '" height="' + height + '" fill="' + COLORS.ground + '" />',
  ]
    .concat(body)
    .concat(["</svg>", ""])
    .join("\n");
}
