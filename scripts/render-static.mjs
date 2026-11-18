// Renders the static plates at the top of the profile README: the hero and the link buttons.
//
// Usage: node scripts/render-static.mjs
// Writes assets/hero.svg, assets/link-website.svg and assets/link-linkedin.svg.
//
// The hero background, assets/skyline.jpg, is a frame of the London aerial LiDAR point
// cloud on yuhanwang.page, captured at 2x with every overlay hidden.

import { readFileSync, writeFileSync } from "node:fs";
import { COLORS, MARGIN, WIDTH, arrowPath, drawFrame, drawLabel, drawText, measure, round, svgDocument } from "./lib/plate.mjs";

const ASSETS = new URL("../assets/", import.meta.url);

const NAME = "Yuhan Wang";
const FOCUS_LINES = [
  "Computer Vision | Embodied Intelligence",
  "Agentic Framework | Quantitative Trading",
];
const LINKS = [
  { file: "link-website.svg", label: "Website", title: "Yuhan Wang's website" },
  { file: "link-linkedin.svg", label: "LinkedIn", title: "Yuhan Wang on LinkedIn" },
];

function seconds(value) {
  return round(value) + "s";
}

function renderHero() {
  const height = 400;
  const skyline = readFileSync(new URL("skyline.jpg", ASSETS)).toString("base64");

  const nameSize = 64;
  const nameY = 292;
  const stopX = MARGIN + measure(NAME + ".", "display", nameSize).xs[NAME.length];

  // The focus areas type themselves out one line after the other, the way the original
  // headline did, and the caret keeps blinking at the end.
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
    "    .cover { animation: sweep 1800ms cubic-bezier(0.65, 0, 0.35, 1) 150ms both; }",
    "    @keyframes sweep { from { transform: translateX(0); } to { transform: translateX(" + (WIDTH + 60) + "px); } }",
    "    @media (prefers-reduced-motion: reduce) {",
    "      .rise, .stop { animation: none; }",
    "      .cover, .caret { display: none; }",
    "      .typed { clip-path: none; }",
    "    }",
  ].join("\n");

  const body = [
    "  <defs>",
    '    <linearGradient id="fade-bottom" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="' + COLORS.ground + '" stop-opacity="0.94" /><stop offset="0.6" stop-color="' + COLORS.ground + '" stop-opacity="0" /></linearGradient>',
    '    <linearGradient id="fade-left" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + COLORS.ground + '" stop-opacity="0.7" /><stop offset="0.55" stop-color="' + COLORS.ground + '" stop-opacity="0" /></linearGradient>',
    '    <linearGradient id="fade-top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + COLORS.ground + '" stop-opacity="0.75" /><stop offset="0.25" stop-color="' + COLORS.ground + '" stop-opacity="0" /></linearGradient>',
    '    <linearGradient id="scan-trail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + COLORS.ink + '" stop-opacity="0" /><stop offset="1" stop-color="' + COLORS.ink + '" stop-opacity="0.12" /></linearGradient>',
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
    '  <image href="data:image/jpeg;base64,' + skyline + '" x="0" y="0" width="' + WIDTH + '" height="' + height + '" preserveAspectRatio="xMidYMid slice" />',
    // A scan sweeps across the city once and brings it up to full brightness, as on the site.
    '  <g class="cover">',
    '    <rect x="0" y="0" width="' + (WIDTH + 60) + '" height="' + height + '" fill="' + COLORS.ground + '" fill-opacity="0.8" />',
    '    <rect x="-56" y="0" width="56" height="' + height + '" fill="url(#scan-trail)" />',
    '    <rect x="0" y="0" width="1" height="' + height + '" fill="' + COLORS.accent + '" fill-opacity="0.9" />',
    "  </g>",
    '  <rect width="' + WIDTH + '" height="' + height + '" fill="url(#fade-top)" />',
    '  <rect width="' + WIDTH + '" height="' + height + '" fill="url(#fade-left)" />',
    '  <rect width="' + WIDTH + '" height="' + height + '" fill="url(#fade-bottom)" />',
  );
  body.push(...drawFrame(WIDTH, height, { topLeft: "London · Aerial LiDAR", topRight: "github.com/yuhanwang14" }));
  body.push(
    '  <g class="rise">',
    "    " + drawText(NAME, { x: MARGIN, y: nameY, size: nameSize }),
    "    " + drawText(".", { x: stopX, y: nameY, size: nameSize, fill: COLORS.accent, className: "stop" }),
    "  </g>",
  );
  for (const line of lines) {
    body.push("  " + drawText(line.content, { x: MARGIN, y: line.y, size: focusSize, opacity: 0.78, className: "typed", extra: 'clip-path="url(#typed-' + line.index + ')"' }));
  }
  body.push('  <rect class="caret" x="' + MARGIN + '" y="' + (lines[0].y - 17) + '" width="2" height="21" fill="' + COLORS.accent + '">');
  for (const line of lines) {
    if (line.index > 0) body.push('    <set attributeName="y" to="' + (line.y - 17) + '" begin="' + seconds(line.begin) + '" fill="freeze" />');
    body.push('    <animate attributeName="x" begin="' + seconds(line.begin) + '" dur="' + seconds(line.duration) + '" calcMode="discrete" fill="freeze" values="' + steps(line, (value) => MARGIN + value + 2) + '" />');
  }
  body.push('    <animate attributeName="opacity" values="1;0" dur="1.05s" calcMode="discrete" repeatCount="indefinite" />', "  </rect>");

  return svgDocument({
    width: WIDTH,
    height,
    title: NAME + ".",
    description: FOCUS_LINES.join(" | ") + ". Background: an aerial LiDAR point cloud of London.",
    style,
    body,
  });
}

function renderLink(link) {
  const width = 168;
  const height = 44;
  return svgDocument({
    width,
    height,
    title: link.title,
    description: link.label,
    body: [
      '  <rect x="0.5" y="0.5" width="' + (width - 1) + '" height="' + (height - 1) + '" fill="none" stroke="' + COLORS.hairline + '" />',
      "  " + drawLabel(link.label, { x: 18, y: 26, size: 11, tracking: 1.8, opacity: 0.88 }),
      '  <path d="' + arrowPath(width - 28, 17, 9) + '" fill="none" stroke="' + COLORS.muted + '" stroke-width="1.25" />',
    ],
  });
}

writeFileSync(new URL("hero.svg", ASSETS), renderHero());
for (const link of LINKS) writeFileSync(new URL(link.file, ASSETS), renderLink(link));
console.log("Wrote hero.svg and " + LINKS.length + " link buttons.");
