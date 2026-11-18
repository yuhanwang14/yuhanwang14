// Renders the typewriter headline at the top of the profile README.
//
// Each line types itself out, then the cursor keeps blinking at the end of the
// last line. The dark variant adds a soft pulsing glow once typing finishes.
//
// Usage: node scripts/render-headline.mjs
// Writes assets/headline-dark.svg and assets/headline-light.svg.

import { writeFile } from "node:fs/promises";

const LINES = [
  "Computer Vision | Embodied Intelligence",
  "Agentic Framework | Quantitative Trading",
];

const WIDTH = 800;
const HEIGHT = 96;
const FONT_SIZE = 20;
// Forcing every glyph to 0.6em keeps the cursor aligned in any monospace font.
const CHAR_WIDTH = FONT_SIZE * 0.6;
const FIRST_BASELINE = 40;
const LINE_GAP = 32;
const TYPE_START = 0.5;
const CHAR_DURATION = 0.065;
const LINE_PAUSE = 0.35;
const FONT_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const THEMES = {
  dark: { text: "#58a6ff", glow: true },
  light: { text: "#0550ae", glow: false },
};

function seconds(value) {
  return value.toFixed(3) + "s";
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const longest = Math.max(...LINES.map((line) => line.length));
const left = Math.round((WIDTH - longest * CHAR_WIDTH) / 2);

let clock = TYPE_START;
const timeline = LINES.map((line, index) => {
  const begin = clock;
  const duration = line.length * CHAR_DURATION;
  clock = begin + duration + LINE_PAUSE;
  return { line, index, begin, duration, baseline: FIRST_BASELINE + index * LINE_GAP };
});
const typingEnd = clock - LINE_PAUSE;

function steps(count, toValue) {
  const values = [];
  for (let index = 1; index <= count; index += 1) values.push(toValue(index));
  return values.join(";");
}

function renderHeadline(theme) {
  const colors = THEMES[theme];
  const out = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + " " + HEIGHT + '" role="img" aria-labelledby="headline-title">',
    '  <title id="headline-title">' + escapeXml(LINES.join(" | ")) + "</title>",
    "  <style>",
    "    text { font-family: " + FONT_STACK + "; font-size: " + FONT_SIZE + "px; font-weight: 700; fill: " + colors.text + "; }",
    "  </style>",
    "  <defs>",
  ];

  for (const step of timeline) {
    out.push(
      '    <clipPath id="typed-' + step.index + '">',
      '      <rect x="' + left + '" y="' + (step.baseline - FONT_SIZE) + '" width="0" height="' + Math.round(FONT_SIZE * 1.5) + '">',
      '        <animate attributeName="width" begin="' + seconds(step.begin) + '" dur="' + seconds(step.duration) + '" calcMode="discrete" fill="freeze" values="' +
        steps(step.line.length, (count) => count * CHAR_WIDTH) + '" />',
      "      </rect>",
      "    </clipPath>",
    );
  }

  if (colors.glow) {
    out.push(
      '    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="' + WIDTH + '" height="' + HEIGHT + '">',
      '      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur">',
      '        <animate attributeName="stdDeviation" begin="' + seconds(typingEnd + 0.5) + '" dur="4s" values="2.5;5.5;2.5" repeatCount="indefinite" />',
      "      </feGaussianBlur>",
      '      <feComponentTransfer in="blur" result="halo"><feFuncA type="linear" slope="0.55" /></feComponentTransfer>',
      '      <feMerge><feMergeNode in="halo" /><feMergeNode in="SourceGraphic" /></feMerge>',
      "    </filter>",
    );
  }

  out.push("  </defs>", colors.glow ? '  <g filter="url(#glow)">' : "  <g>");

  for (const step of timeline) {
    out.push(
      '    <text x="' + left + '" y="' + step.baseline + '" textLength="' + step.line.length * CHAR_WIDTH + '" lengthAdjust="spacing" clip-path="url(#typed-' + step.index + ')">' +
        escapeXml(step.line) + "</text>",
    );
  }

  // The cursor follows the end of whichever line is being typed.
  const cursorTop = (baseline) => baseline - 17;
  out.push('    <rect x="' + left + '" y="' + cursorTop(timeline[0].baseline) + '" width="2.5" height="22" fill="' + colors.text + '">');
  for (const step of timeline) {
    if (step.index > 0) {
      out.push('      <set attributeName="y" to="' + cursorTop(step.baseline) + '" begin="' + seconds(step.begin) + '" fill="freeze" />');
    }
    out.push(
      '      <animate attributeName="x" begin="' + seconds(step.begin) + '" dur="' + seconds(step.duration) + '" calcMode="discrete" fill="freeze" values="' +
        steps(step.line.length, (count) => left + count * CHAR_WIDTH + 2) + '" />',
    );
  }
  out.push(
    '      <animate attributeName="opacity" values="1;0" dur="1s" calcMode="discrete" repeatCount="indefinite" />',
    "    </rect>",
    "  </g>",
    "</svg>",
    "",
  );
  return out.join("\n");
}

for (const theme of Object.keys(THEMES)) {
  const target = new URL("../assets/headline-" + theme + ".svg", import.meta.url);
  await writeFile(target, renderHeadline(theme), "utf8");
}
console.log("Typing ends at " + seconds(typingEnd));
