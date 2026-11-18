// Renders the static plates at the top of the profile README: the hero and the link buttons,
// once for GitHub's dark theme and once for its light theme.
//
// Usage: node scripts/render-static.mjs
// Writes assets/hero-{dark,light}.svg and assets/link-{website,linkedin}-{dark,light}.svg.
//
// assets/skyline-mask.jpg is a frame of the London aerial LiDAR point cloud on yuhanwang.page,
// captured at 2x with every overlay hidden, converted to grayscale with the site's background
// pushed to pure black. The hero uses it as a luminance mask, so the points take the theme's
// ink colour and the page background shows through everywhere else.

import { readFileSync, writeFileSync } from "node:fs";
import { MARGIN, THEMES, WIDTH, arrowPath, drawFrame, drawLabel, drawText, measure, round, svgDocument } from "./lib/plate.mjs";

const ASSETS = new URL("../assets/", import.meta.url);

const NAME = "Yuhan Wang";
const FOCUS_LINES = [
  "Computer Vision | Embodied Intelligence",
  "Agentic Framework | Quantitative Trading",
];
const LINKS = [
  { slug: "website", label: "Website", title: "Yuhan Wang's website" },
  { slug: "linkedin", label: "LinkedIn", title: "Yuhan Wang on LinkedIn" },
];

const HEIGHT = 400;
const SWEEP = { begin: 0.15, duration: 1.8, distance: WIDTH + 60 };

function seconds(value) {
  return round(value) + "s";
}

function sweepTiming() {
  return 'begin="' + seconds(SWEEP.begin) + '" dur="' + seconds(SWEEP.duration) + '" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.65 0 0.35 1"';
}

function renderHero(theme) {
  const skyline = readFileSync(new URL("skyline-mask.jpg", ASSETS)).toString("base64");
  const nameSize = 64;
  const nameY = 292;
  const stopX = MARGIN + measure(NAME + ".", "display", nameSize).xs[NAME.length];

  // The focus areas type themselves out one line after the other; the caret keeps blinking.
  const focusSize = 21;
  const charTime = 0.042;
  let clock = 1.25;
  const lines = FOCUS_LINES.map((content, index) => {
    const layout = measure(content, "display", focusSize);
    const begin = clock;
    const duration = content.length * charTime;
    clock = begin + duration + 0.28;
    return { content, index, layout, begin, duration, y: nameY + 44 + index * 30 };
  });
  const revealAt = (line, count) => (count < line.content.length ? line.layout.xs[count] : line.layout.width + 1);
  const steps = (line, toValue) => line.content.split("").map((_, index) => round(toValue(revealAt(line, index + 1)))).join(";");

  const style = [
    "    .rise { animation: rise 900ms cubic-bezier(0.16, 1, 0.3, 1) 150ms both; }",
    "    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }",
    "    .stop { transform-box: fill-box; transform-origin: 50% 50%; animation: stop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) 700ms both; }",
    "    @keyframes stop { from { opacity: 0; transform: scale(0); } to { opacity: 1; transform: none; } }",
    "    @media (prefers-reduced-motion: reduce) {",
    "      .rise, .stop { animation: none; }",
    "      .scan, .caret { display: none; }",
    "      .revealed, .typed { clip-path: none; }",
    "    }",
  ].join("\n");

  const white = (offset, opacity) => '<stop offset="' + offset + '" stop-color="#fff" stop-opacity="' + opacity + '" />';
  const fullRect = 'width="' + WIDTH + '" height="' + HEIGHT + '"';
  const maskBox = 'maskUnits="userSpaceOnUse" x="0" y="0" ' + fullRect;
  const body = [
    "  <defs>",
    '    <mask id="cloud" ' + maskBox + ">",
    '      <image href="data:image/jpeg;base64,' + skyline + '" x="0" y="0" ' + fullRect + ' preserveAspectRatio="xMidYMid slice" />',
    "    </mask>",
    // The points thin out toward the corner labels and under the text instead of being covered.
    '    <linearGradient id="fade-y" x1="0" y1="0" x2="0" y2="1">' + white(0, 0.35) + white(0.2, 1) + white(0.48, 1) + white(0.8, 0.22) + white(1, 0.1) + "</linearGradient>",
    '    <linearGradient id="fade-x" x1="0" y1="0" x2="1" y2="0">' + white(0, 0.3) + white(0.55, 1) + white(1, 1) + "</linearGradient>",
    '    <mask id="fade-y-mask" ' + maskBox + '><rect ' + fullRect + ' fill="url(#fade-y)" /></mask>',
    '    <mask id="fade-x-mask" ' + maskBox + '><rect ' + fullRect + ' fill="url(#fade-x)" /></mask>',
    '    <clipPath id="reveal"><rect x="0" y="0" width="0" height="' + HEIGHT + '"><animate attributeName="width" from="0" to="' + SWEEP.distance + '" ' + sweepTiming() + " /></rect></clipPath>",
    '    <linearGradient id="scan-trail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + theme.ink + '" stop-opacity="0" /><stop offset="1" stop-color="' + theme.ink + '" stop-opacity="0.1" /></linearGradient>',
  ];
  for (const line of lines) {
    body.push(
      '    <clipPath id="typed-' + line.index + '">',
      '      <rect x="' + MARGIN + '" y="' + (line.y - 22) + '" width="0" height="30">',
      '        <animate attributeName="width" begin="' + seconds(line.begin) + '" dur="' + seconds(line.duration) + '" calcMode="discrete" fill="freeze" values="' + steps(line, (value) => value) + '" />',
      "      </rect>",
      "    </clipPath>",
    );
  }
  body.push(
    "  </defs>",
    // A scan sweeps across the city once and brings it up to full brightness, as on the site.
    '  <g mask="url(#fade-y-mask)">',
    '    <g mask="url(#fade-x-mask)">',
    "      <rect " + fullRect + ' fill="' + theme.ink + '" fill-opacity="0.22" mask="url(#cloud)" />',
    '      <rect class="revealed" ' + fullRect + ' fill="' + theme.ink + '" mask="url(#cloud)" clip-path="url(#reveal)" />',
    "    </g>",
    "  </g>",
    '  <g class="scan">',
    '    <rect x="-56" y="0" width="56" height="' + HEIGHT + '" fill="url(#scan-trail)" />',
    '    <rect x="0" y="0" width="1" height="' + HEIGHT + '" fill="' + theme.accent + '" fill-opacity="0.9" />',
    '    <animateTransform attributeName="transform" type="translate" from="0 0" to="' + SWEEP.distance + ' 0" ' + sweepTiming() + " />",
    "  </g>",
  );
  body.push(...drawFrame(WIDTH, HEIGHT, theme, { topLeft: "London · Aerial LiDAR", topRight: "github.com/yuhanwang14" }));
  body.push(
    '  <g class="rise">',
    "    " + drawText(NAME, { x: MARGIN, y: nameY, size: nameSize, fill: theme.ink }),
    "    " + drawText(".", { x: stopX, y: nameY, size: nameSize, fill: theme.accent, className: "stop" }),
    "  </g>",
  );
  for (const line of lines) {
    body.push("  " + drawText(line.content, { x: MARGIN, y: line.y, size: focusSize, fill: theme.text, className: "typed", extra: 'clip-path="url(#typed-' + line.index + ')"' }));
  }
  body.push('  <rect class="caret" x="' + MARGIN + '" y="' + (lines[0].y - 17) + '" width="2" height="21" fill="' + theme.accent + '">');
  for (const line of lines) {
    if (line.index > 0) body.push('    <set attributeName="y" to="' + (line.y - 17) + '" begin="' + seconds(line.begin) + '" fill="freeze" />');
    body.push('    <animate attributeName="x" begin="' + seconds(line.begin) + '" dur="' + seconds(line.duration) + '" calcMode="discrete" fill="freeze" values="' + steps(line, (value) => MARGIN + value + 2) + '" />');
  }
  body.push('    <animate attributeName="opacity" values="1;0" dur="1.05s" calcMode="discrete" repeatCount="indefinite" />', "  </rect>");

  return svgDocument({
    width: WIDTH,
    height: HEIGHT,
    title: NAME + ".",
    description: FOCUS_LINES.join(" | ") + ". Background: an aerial LiDAR point cloud of London.",
    style,
    body,
  });
}

function renderLink(link, theme) {
  const width = 168;
  const height = 44;
  return svgDocument({
    width,
    height,
    title: link.title,
    description: link.label,
    body: [
      '  <rect x="0.5" y="0.5" width="' + (width - 1) + '" height="' + (height - 1) + '" fill="none" stroke="' + theme.rule + '" />',
      "  " + drawLabel(link.label, { theme, x: 18, y: 26, size: 11, tracking: 1.8, fill: theme.text }),
      '  <path d="' + arrowPath(width - 28, 17, 9) + '" fill="none" stroke="' + theme.muted + '" stroke-width="1.25" />',
    ],
  });
}

for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(new URL("hero-" + name + ".svg", ASSETS), renderHero(theme));
  for (const link of LINKS) writeFileSync(new URL("link-" + link.slug + "-" + name + ".svg", ASSETS), renderLink(link, theme));
}
console.log("Wrote the hero and " + LINKS.length + " link buttons for " + Object.keys(THEMES).length + " themes.");
