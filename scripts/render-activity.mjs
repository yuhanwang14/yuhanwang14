// Renders the data plates of the profile README from live GitHub data.
//
// Usage: GITHUB_TOKEN=<token> node scripts/render-activity.mjs [output-dir]
// Writes languages.svg and activity.svg into the output directory (default: dist).
//
// Activity numbers come from the public contribution calendar, the same green grid any
// visitor sees on the profile. Language shares come from the code in public repositories
// the account owns, forks excluded.
//
// scripts/profile.config.json controls both plates:
//   chart.bucket          "day" | "week" | "month"     size of each bar
//   chart.periods         number of bars (4-400)
//   chart.showBars        true | false
//   chart.line            "average" | "cumulative" | "none"
//   chart.averageWindow   bars per moving average (2-52)
//   languages.count       how many languages to list (2-8)
//   languages.exclude     language names left out of the shares
//   languages.tools       frameworks and tools listed under the languages

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COLORS, MARGIN, WIDTH, drawFrame, drawLabel, drawText, measure, round, svgDocument } from "./lib/plate.mjs";

const LOGIN = process.env.PROFILE_LOGIN || "yuhanwang14";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const OUTPUT_DIR = process.argv[2] || "dist";
const CONFIG_URL = new URL("./profile.config.json", import.meta.url);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DEFAULTS = {
  chart: { bucket: "week", periods: 52, showBars: true, line: "average", averageWindow: 4 },
  languages: { count: 8, exclude: [], tools: [] },
};

// ---------------------------------------------------------------- data

async function graphql(query, variables) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: "bearer " + TOKEN, "Content-Type": "application/json", "User-Agent": LOGIN + "-profile" },
        body: JSON.stringify({ query, variables }),
      });
      const payload = await response.json();
      if (!response.ok || payload.errors) {
        throw new Error("GraphQL request failed (" + response.status + "): " + JSON.stringify(payload.errors || payload.message));
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}

// One aliased contributionsCollection per calendar year, since the API caps each at a year.
async function fetchContributionDays() {
  const { user } = await graphql("query($login: String!) { user(login: $login) { createdAt } }", { login: LOGIN });
  if (!user) throw new Error("GitHub user not found: " + LOGIN);
  const now = new Date();
  const firstYear = new Date(user.createdAt).getUTCFullYear();
  const lastYear = now.getUTCFullYear();
  const fields = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    const from = year === firstYear ? user.createdAt : year + "-01-01T00:00:00Z";
    const to = year === lastYear ? now.toISOString() : year + "-12-31T23:59:59Z";
    fields.push("y" + year + ': contributionsCollection(from: "' + from + '", to: "' + to + '") { contributionCalendar { weeks { contributionDays { date contributionCount } } } }');
  }
  const data = await graphql("query($login: String!) { user(login: $login) { " + fields.join(" ") + " } }", { login: LOGIN });
  const counts = new Map();
  for (const collection of Object.values(data.user)) {
    for (const week of collection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) counts.set(day.date, day.contributionCount);
    }
  }
  return [...counts.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchLanguageSizes() {
  const query =
    "query($login: String!, $cursor: String) { user(login: $login) { repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) { " +
    "pageInfo { hasNextPage endCursor } nodes { languages(first: 25, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } } } } }";
  const sizes = new Map();
  let cursor = null;
  do {
    const data = await graphql(query, { login: LOGIN, cursor });
    const page = data.user.repositories;
    for (const repository of page.nodes) {
      for (const edge of repository.languages.edges) sizes.set(edge.node.name, (sizes.get(edge.node.name) || 0) + edge.size);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return sizes;
}

async function loadConfig() {
  let overrides = {};
  try {
    overrides = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read scripts/profile.config.json: " + error.message);
  }
  const chart = Object.assign({}, DEFAULTS.chart, overrides.chart);
  const languages = Object.assign({}, DEFAULTS.languages, overrides.languages);
  if (!["day", "week", "month"].includes(chart.bucket)) throw new Error('chart.bucket must be "day", "week", or "month".');
  if (!["average", "cumulative", "none"].includes(chart.line)) throw new Error('chart.line must be "average", "cumulative", or "none".');
  chart.showBars = chart.showBars !== false;
  if (!chart.showBars && chart.line === "none") throw new Error("Turn on chart.showBars or choose a chart.line.");
  chart.periods = clamp(chart.periods, 4, 400, DEFAULTS.chart.periods);
  chart.averageWindow = clamp(chart.averageWindow, 2, 52, DEFAULTS.chart.averageWindow);
  languages.count = clamp(languages.count, 2, 8, DEFAULTS.languages.count);
  return { chart, languages };
}

function clamp(value, min, max, fallback) {
  return Math.min(Math.max(Math.round(Number(value) || fallback), min), max);
}

// ---------------------------------------------------------------- formatting

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatCompact(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDate(isoDate, withYear) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return MONTHS[month - 1] + " " + day + (withYear ? ", " + year : "");
}

function formatRange(start, end, currentYear) {
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  if (start === end) return formatDate(start, startYear !== currentYear);
  if (startYear === endYear) return formatDate(start, false) + " – " + formatDate(end, endYear !== currentYear);
  return formatDate(start, true) + " – " + formatDate(end, true);
}

// ---------------------------------------------------------------- languages plate

function rankLanguages(sizes, config) {
  const excluded = new Set(config.exclude);
  const kept = [...sizes.entries()].filter(([name]) => !excluded.has(name)).sort((a, b) => b[1] - a[1]);
  const total = kept.reduce((sum, [, size]) => sum + size, 0);
  return kept.slice(0, config.count).map(([name, size]) => ({ name, share: total ? size / total : 0 }));
}

function renderLanguages(languages, config) {
  const columns = 2;
  const columnWidth = 340;
  const columnGap = WIDTH - 2 * MARGIN - columns * columnWidth;
  const rows = Math.ceil(languages.length / columns);
  const rowHeight = 52;
  const firstBaseline = 84;
  const toolsBaseline = firstBaseline + rows * rowHeight + 22;
  const height = toolsBaseline + (config.tools.length ? 48 : 10);

  const body = drawFrame(WIDTH, height, { topLeft: "Languages", topRight: "Share of code in public repositories" });
  languages.forEach((language, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = MARGIN + column * (columnWidth + columnGap);
    const y = firstBaseline + row * rowHeight;
    const percent = language.share >= 0.095 ? Math.round(language.share * 100) + "%" : (language.share * 100).toFixed(1) + "%";
    body.push(
      "  " + drawText(language.name, { x, y, size: 20 }),
      "  " + drawText(percent, { x: x + columnWidth, y, font: "mono", size: 11, opacity: 0.7, anchor: "end" }),
      '  <rect x="' + x + '" y="' + (y + 12) + '" width="' + columnWidth + '" height="2" fill="' + COLORS.ink + '" fill-opacity="0.1" />',
      '  <rect x="' + x + '" y="' + (y + 12) + '" width="' + round(Math.max(2, columnWidth * language.share)) + '" height="2" fill="' + COLORS.ink + '" fill-opacity="0.85" />',
    );
  });
  if (config.tools.length) {
    body.push(
      '  <line x1="' + MARGIN + '" x2="' + (WIDTH - MARGIN) + '" y1="' + (toolsBaseline - 28.5) + '" y2="' + (toolsBaseline - 28.5) + '" stroke="' + COLORS.hairline + '" />',
      "  " + drawLabel("Tools", { x: MARGIN, y: toolsBaseline - 1 }),
      "  " + drawText(config.tools.join("  ·  "), { x: MARGIN + 90, y: toolsBaseline, size: 18, opacity: 0.78 }),
    );
  }

  const description = languages.map((language) => language.name + " " + Math.round(language.share * 100) + "%").join(", ") +
    (config.tools.length ? ". Tools: " + config.tools.join(", ") + "." : ".");
  return svgDocument({ width: WIDTH, height, title: "Languages across public repositories", description, body });
}

// ---------------------------------------------------------------- activity plate

function summarize(days) {
  const recent = days.slice(-365);
  const contributions = recent.reduce((sum, day) => sum + day.count, 0);
  const activeDays = recent.filter((day) => day.count > 0).length;

  // A day without contributions yet (usually today) does not break the streak.
  let end = days.length - 1;
  if (end >= 0 && days[end].count === 0) end -= 1;
  let start = end;
  while (start >= 0 && days[start].count > 0) start -= 1;
  const currentLength = Math.max(end - start, 0);
  const current = currentLength > 0 ? { length: currentLength, start: days[start + 1].date, end: days[end].date } : { length: 0 };

  let longest = { length: 0 };
  let runStart = -1;
  days.forEach((day, index) => {
    if (day.count === 0) {
      runStart = -1;
      return;
    }
    if (runStart < 0) runStart = index;
    const length = index - runStart + 1;
    if (length > longest.length) longest = { length, start: days[runStart].date, end: day.date };
  });

  return { contributions, activeDays, windowDays: recent.length, current, longest, today: days[days.length - 1].date };
}

function statColumns(summary) {
  const year = Number(summary.today.slice(0, 4));
  const unit = (length) => (length === 1 ? "day" : "days");
  return [
    { label: "Contributions", value: formatNumber(summary.contributions), detail: "Last 365 days" },
    { label: "Active days", value: formatNumber(summary.activeDays), detail: Math.round((100 * summary.activeDays) / summary.windowDays) + "% of the year" },
    {
      label: "Current streak",
      value: formatNumber(summary.current.length),
      unit: unit(summary.current.length),
      detail: summary.current.length ? formatRange(summary.current.start, summary.current.end, year) : "No active streak",
      live: summary.current.length > 0,
    },
    {
      label: "Longest streak",
      value: formatNumber(summary.longest.length),
      unit: unit(summary.longest.length),
      detail: summary.longest.length ? formatRange(summary.longest.start, summary.longest.end, year) : "No streak yet",
    },
  ];
}

function bucketStart(isoDate, bucket) {
  if (bucket === "day") return isoDate;
  if (bucket === "month") return isoDate.slice(0, 7) + "-01";
  const date = new Date(isoDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function buildSeries(days, chart) {
  const totals = new Map();
  for (const day of days) {
    const start = bucketStart(day.date, chart.bucket);
    totals.set(start, (totals.get(start) || 0) + day.count);
  }
  const buckets = [...totals.entries()].map(([start, total]) => ({ start, total }));
  // Averages look back past the visible window, so the first bars get a full window too.
  const averages = buckets.map((_, index) => {
    const window = buckets.slice(Math.max(0, index - chart.averageWindow + 1), index + 1);
    return window.reduce((sum, item) => sum + item.total, 0) / window.length;
  });
  const offset = Math.max(0, buckets.length - chart.periods);
  let running = 0;
  return buckets.slice(offset).map((bucket, index) => {
    running += bucket.total;
    return { start: bucket.start, total: bucket.total, average: averages[offset + index], cumulative: running };
  });
}

function niceScale(maxValue, targetTicks) {
  if (maxValue <= 0) return { max: targetTicks, step: 1 };
  const rough = maxValue / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough);
  return { max: Math.ceil(maxValue / step) * step, step };
}

function renderActivity(summary, series, chart) {
  const height = 486;
  const columns = statColumns(summary);
  const columnWidth = (WIDTH - 2 * MARGIN) / columns.length;
  const asOf = formatDate(summary.today, true);
  const body = drawFrame(WIDTH, height, { topLeft: "Activity", topRight: "As of " + asOf });

  columns.forEach((column, index) => {
    const x = MARGIN + index * columnWidth;
    body.push("  " + drawLabel(column.label, { x, y: 78 }));
    body.push("  " + drawText(column.value, { x, y: 126, size: 44 }));
    let cursor = x + measure(column.value, "display", 44).width;
    if (column.unit) {
      body.push("  " + drawText(column.unit, { x: cursor + 6, y: 126, size: 18, opacity: 0.55 }));
      cursor += 6 + measure(column.unit, "display", 18).width;
    }
    if (column.live) body.push('  <circle cx="' + round(cursor + 10) + '" cy="119" r="3.5" fill="' + COLORS.accent + '" />');
    body.push("  " + drawLabel(column.detail, { x, y: 152 }));
  });
  body.push('  <line x1="' + MARGIN + '" x2="' + (WIDTH - MARGIN) + '" y1="184.5" y2="184.5" stroke="' + COLORS.hairline + '" />');

  // Chart.
  const secondaryAxis = chart.showBars && chart.line === "cumulative";
  const plot = { left: MARGIN + 40, right: WIDTH - MARGIN - (secondaryAxis ? 40 : 0), top: 250, bottom: 418 };
  const slot = (plot.right - plot.left) / series.length;
  const xFor = (index) => plot.left + slot * (index + 0.5);
  const lineValues = chart.line === "none" ? [] : series.map((item) => (chart.line === "average" ? item.average : item.cumulative));
  const barValues = chart.showBars ? series.map((item) => item.total) : [];
  const primary = niceScale(Math.max(1, ...(secondaryAxis ? barValues : barValues.concat(lineValues))), 4);
  const secondary = secondaryAxis ? niceScale(Math.max(1, ...lineValues), 4) : primary;
  const yFor = (value, scale) => plot.bottom - (value / scale.max) * (plot.bottom - plot.top);
  const unitName = { day: "day", week: "week", month: "month" }[chart.bucket];
  const barName = { day: "Daily", week: "Weekly", month: "Monthly" }[chart.bucket] + " contributions";
  const lineName = chart.line === "average" ? chart.averageWindow + "-" + unitName + " average" : "Cumulative" + (secondaryAxis ? " (right axis)" : "");

  let legendX = MARGIN;
  if (chart.showBars) {
    body.push('  <rect x="' + legendX + '" y="209" width="9" height="9" fill="' + COLORS.ink + '" fill-opacity="0.3" />');
    body.push("  " + drawLabel(barName, { x: legendX + 17, y: 217 }));
    legendX += 17 + measure(barName.toUpperCase(), "mono", 10, 1.5).width + 28;
  }
  if (chart.line !== "none") {
    body.push('  <line x1="' + legendX + '" x2="' + (legendX + 14) + '" y1="213.5" y2="213.5" stroke="' + COLORS.accent + '" stroke-width="1.75" />');
    body.push("  " + drawLabel(lineName, { x: legendX + 22, y: 217 }));
  }

  for (let value = 0; value <= primary.max + 1e-9; value += primary.step) {
    const y = round(yFor(value, primary)) + 0.5;
    body.push('  <line x1="' + plot.left + '" x2="' + plot.right + '" y1="' + y + '" y2="' + y + '" stroke="' + (value === 0 ? COLORS.muted : COLORS.hairline) + '"' + (value === 0 ? ' stroke-opacity="0.45"' : "") + " />");
    body.push("  " + drawLabel(formatCompact(value), { x: plot.left - 12, y: y + 3.5, anchor: "end", tracking: 0.5 }));
  }
  if (secondaryAxis) {
    for (let value = 0; value <= secondary.max + 1e-9; value += secondary.step) {
      body.push("  " + drawLabel(formatCompact(value), { x: plot.right + 12, y: yFor(value, secondary) + 4, tracking: 0.5 }));
    }
  }

  let lastLabelX = -Infinity;
  series.forEach((item, index) => {
    const month = Number(item.start.slice(5, 7));
    const previous = index > 0 ? Number(series[index - 1].start.slice(5, 7)) : null;
    if (!(chart.bucket === "month" || (previous !== null && previous !== month))) return;
    const x = xFor(index);
    if (x - lastLabelX < 44) return;
    lastLabelX = x;
    body.push("  " + drawLabel(month === 1 ? item.start.slice(0, 4) : MONTHS[month - 1], { x, y: plot.bottom + 22, anchor: "middle" }));
  });

  const peakIndex = series.reduce((best, item, index) => (item.total > series[best].total ? index : best), 0);
  if (chart.showBars) {
    const barWidth = Math.max(1, Math.min(slot * 0.62, 26));
    body.push('  <g fill="' + COLORS.ink + '" fill-opacity="0.26">');
    series.forEach((item, index) => {
      if (item.total <= 0) return;
      const top = Math.min(yFor(item.total, primary), plot.bottom - 1);
      body.push('    <rect x="' + round(xFor(index) - barWidth / 2) + '" y="' + round(top) + '" width="' + round(barWidth) + '" height="' + round(plot.bottom - top) + '" />');
    });
    body.push("  </g>");
    const peak = series[peakIndex];
    const peakX = Math.min(Math.max(xFor(peakIndex), plot.left + 44), plot.right - 44);
    body.push("  " + drawLabel("Peak " + formatNumber(peak.total), { x: peakX, y: Math.max(yFor(peak.total, primary) - 9, plot.top - 6), anchor: "middle", opacity: 0.6 }));
  }
  if (chart.line !== "none") {
    const scale = secondaryAxis ? secondary : primary;
    const points = lineValues.map((value, index) => round(xFor(index)) + " " + round(yFor(value, scale)));
    const last = points[points.length - 1].split(" ");
    body.push('  <path d="M' + points.join(" L") + '" fill="none" stroke="' + COLORS.accent + '" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />');
    body.push('  <circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="' + COLORS.accent + '" />');
  }

  const total = series.reduce((sum, item) => sum + item.total, 0);
  const description =
    columns.map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")").join("; ") +
    ". " + barName + " for the last " + series.length + " " + unitName + "s: " + formatNumber(total) + " in total, peak " + formatNumber(series[peakIndex].total) + ".";
  return svgDocument({ width: WIDTH, height, title: "GitHub activity for " + LOGIN + " as of " + asOf, description, body });
}

// ---------------------------------------------------------------- main

if (!TOKEN) {
  console.error("Set GITHUB_TOKEN to a token that can read public GitHub data.");
  process.exit(1);
}

const config = await loadConfig();
const [days, languageSizes] = await Promise.all([fetchContributionDays(), fetchLanguageSizes()]);
if (days.length === 0) throw new Error("The contribution calendar came back empty.");

const summary = summarize(days);
const languages = rankLanguages(languageSizes, config.languages);
const files = {
  "languages.svg": renderLanguages(languages, config.languages),
  "activity.svg": renderActivity(summary, buildSeries(days, config.chart), config.chart),
};

await mkdir(OUTPUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(files)) await writeFile(join(OUTPUT_DIR, name), svg, "utf8");

console.log(statColumns(summary).map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")").join("\n"));
console.log("Languages: " + languages.map((language) => language.name + " " + (language.share * 100).toFixed(1) + "%").join(", "));
