// Renders the data plates of the profile README, once per GitHub theme.
//
// Usage: GITHUB_TOKEN=<token> [PROFILE_STATS_TOKEN=<token>] [PROFILE_REPO_CACHE=<dir>] node scripts/render-activity.mjs [output-dir]
// Writes activity-{dark,light}.svg, and languages-{dark,light}.svg when PROFILE_STATS_TOKEN is set.
// PROFILE_REPO_CACHE keeps the repository clones between local runs.
//
// Activity numbers come from the public contribution calendar, the same green grid any
// visitor sees on the profile, so GITHUB_TOKEN is enough for them.
// Language shares count the lines the account has written itself, across every repository
// PROFILE_STATS_TOKEN can read, private and organization repositories included
// (see lib/authored-languages.mjs). Without that token the languages plate is left as it was.
// The stack under the languages lists the tools that code imports, grouped as in
// scripts/tool-map.json and ranked by the lines written in files that use each one
// (see lib/authored-tools.mjs).
//
// scripts/profile.config.json controls both plates:
//   chart.bucket            "day" | "week" | "month"     size of each bar
//   chart.periods           number of bars (4-400)
//   chart.showBars          true | false
//   chart.line              "average" | "cumulative" | "none"
//   chart.averageWindow     bars per moving average (2-52)
//   languages.count         how many languages to list (2-8)
//   languages.importLimit   commits adding more lines than this count as bulk imports
//   languages.exclude       language names left out of the shares
//   tools.perGroup          tools per group, most used first (1-4)
//   tools.groups            most groups to show (1-8); the groups with the fewest lines go first
//   tools.minLines          lines a tool needs, written in files that use it, to be listed
//   tools.exclude           tool names left out

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { measureAuthoredLanguages } from "./lib/authored-languages.mjs";
import { MARGIN, THEMES, WIDTH, drawFrame, drawLabel, drawText, measure, round, svgDocument } from "./lib/plate.mjs";

const LOGIN = process.env.PROFILE_LOGIN || "yuhanwang14";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const STATS_TOKEN = process.env.PROFILE_STATS_TOKEN;
const REPO_CACHE = process.env.PROFILE_REPO_CACHE || null;
const OUTPUT_DIR = process.argv[2] || "dist";
const CONFIG_URL = new URL("./profile.config.json", import.meta.url);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DEFAULTS = {
  chart: { bucket: "week", periods: 52, showBars: true, line: "average", averageWindow: 4 },
  languages: { count: 8, importLimit: 8000, exclude: [] },
  tools: { perGroup: 4, groups: 8, minLines: 1500, exclude: [] },
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
  languages.importLimit = clamp(languages.importLimit, 500, 1000000, DEFAULTS.languages.importLimit);
  const tools = Object.assign({}, DEFAULTS.tools, overrides.tools);
  tools.perGroup = clamp(tools.perGroup, 1, 4, DEFAULTS.tools.perGroup);
  tools.groups = clamp(tools.groups, 1, 8, DEFAULTS.tools.groups);
  tools.minLines = clamp(tools.minLines, 0, 10000000, DEFAULTS.tools.minLines);
  tools.exclude = Array.isArray(tools.exclude) ? tools.exclude : [];
  return { chart, languages, tools };
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

function formatPercent(share) {
  return share >= 0.095 ? Math.round(share * 100) + "%" : (share * 100).toFixed(1) + "%";
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

function rankLanguages(totals, config) {
  const excluded = new Set(config.exclude);
  const kept = [...totals.entries()].filter(([name]) => !excluded.has(name)).sort((a, b) => b[1] - a[1]);
  const total = kept.reduce((sum, [, lines]) => sum + lines, 0);
  return {
    total,
    languages: kept.slice(0, config.count).map(([name, lines]) => ({ name, lines, share: total ? lines / total : 0 })),
  };
}

// Groups keep the order of tool-map.json and list their tools by lines written with them.
// A group with no tool above minLines is left out; when more groups qualify than the config
// allows, the groups whose top tool has the fewest lines go.
function rankTools(weights, toolMap, config) {
  const excluded = new Set(config.exclude);
  const groupOf = new Map((toolMap.tools || []).map((tool) => [tool.name, tool.group]));
  const groups = (toolMap.groups || [])
    .map((name) => {
      const ranked = [...weights.entries()]
        .filter(([tool, weight]) => groupOf.get(tool) === name && weight.lines >= config.minLines && !excluded.has(tool))
        .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
        .slice(0, config.perGroup);
      return { name, tools: ranked.map(([tool]) => tool), lead: ranked.length ? ranked[0][1].lines : 0 };
    })
    .filter((group) => group.tools.length > 0);
  const kept = new Set([...groups].sort((a, b) => b.lead - a.lead).slice(0, config.groups).map((group) => group.name));
  return groups.filter((group) => kept.has(group.name));
}

// The stack is a table: group labels in the left column, tools on a grid of fixed columns
// whose third column lines up with the second column of languages above.
const STACK = { x: MARGIN + 100, column: 160, rowHeight: 30, size: 17 };

function stackFontSize(groups) {
  const widest = Math.max(0, ...groups.flatMap((group) => group.tools.map((tool) => measure(tool, "display", STACK.size).width)));
  const room = STACK.column - 20;
  return widest > room ? Math.floor((STACK.size * room) / widest) : STACK.size;
}

function renderLanguages(ranking, repositoryCount, stack, theme) {
  const { languages, total } = ranking;
  const columns = 2;
  const columnWidth = 340;
  const columnGap = WIDTH - 2 * MARGIN - columns * columnWidth;
  const rows = Math.ceil(languages.length / columns);
  const rowHeight = 52;
  const firstBaseline = 84;
  const ruleY = firstBaseline + rows * rowHeight - 6.5;
  const stackBaseline = ruleY + 36.5;
  const stackSize = stackFontSize(stack);
  const height = stack.length ? stackBaseline + (stack.length - 1) * STACK.rowHeight + 46 : ruleY + 16.5;
  const summary = formatCompact(total) + " lines written · " + repositoryCount + " repositories";

  const body = drawFrame(WIDTH, height, theme, { topLeft: "Languages", topRight: summary });
  languages.forEach((language, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = MARGIN + column * (columnWidth + columnGap);
    const y = firstBaseline + row * rowHeight;
    body.push(
      "  " + drawText(language.name, { x, y, size: 20, fill: theme.ink }),
      "  " + drawText(formatPercent(language.share), { x: x + columnWidth, y, font: "mono", size: 11, fill: theme.text, anchor: "end" }),
      "  " + drawLabel(formatCompact(language.lines), { theme, x: x + columnWidth - 52, y, anchor: "end", tracking: 0.5 }),
      '  <rect x="' + x + '" y="' + (y + 12) + '" width="' + columnWidth + '" height="2" fill="' + theme.ink + '" fill-opacity="0.1" />',
      '  <rect x="' + x + '" y="' + (y + 12) + '" width="' + round(Math.max(2, columnWidth * language.share)) + '" height="2" fill="' + theme.ink + '" fill-opacity="0.85" />',
    );
  });
  if (stack.length) {
    body.push('  <line x1="' + MARGIN + '" x2="' + (WIDTH - MARGIN) + '" y1="' + ruleY + '" y2="' + ruleY + '" stroke="' + theme.rule + '" />');
    stack.forEach((group, row) => {
      const y = stackBaseline + row * STACK.rowHeight;
      body.push("  " + drawLabel(group.name, { theme, x: MARGIN, y: y - 1 }));
      group.tools.forEach((tool, column) => {
        body.push("  " + drawText(tool, { x: STACK.x + column * STACK.column, y, size: stackSize, fill: theme.text }));
      });
    });
  }

  const description = "Lines of code written, by language: " +
    languages.map((language) => language.name + " " + formatPercent(language.share) + " (" + formatNumber(language.lines) + " lines)").join(", ") +
    ". " + formatNumber(total) + " lines across " + repositoryCount + " repositories." +
    (stack.length ? " Stack, by lines written with each tool: " + stack.map((group) => group.name + ": " + group.tools.join(", ")).join("; ") + "." : "");
  return svgDocument({ width: WIDTH, height, title: "Languages and tools I write code with", description, body });
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

function renderActivity(summary, series, chart, theme) {
  const height = 486;
  const columns = statColumns(summary);
  const columnWidth = (WIDTH - 2 * MARGIN) / columns.length;
  const asOf = formatDate(summary.today, true);
  const body = drawFrame(WIDTH, height, theme, { topLeft: "Activity", topRight: "As of " + asOf });

  columns.forEach((column, index) => {
    const x = MARGIN + index * columnWidth;
    body.push("  " + drawLabel(column.label, { theme, x, y: 78 }));
    body.push("  " + drawText(column.value, { x, y: 126, size: 44, fill: theme.ink }));
    let cursor = x + measure(column.value, "display", 44).width;
    if (column.unit) {
      body.push("  " + drawText(column.unit, { x: cursor + 6, y: 126, size: 18, fill: theme.muted }));
      cursor += 6 + measure(column.unit, "display", 18).width;
    }
    if (column.live) body.push('  <circle cx="' + round(cursor + 10) + '" cy="119" r="3.5" fill="' + theme.accent + '" />');
    body.push("  " + drawLabel(column.detail, { theme, x, y: 152 }));
  });
  body.push('  <line x1="' + MARGIN + '" x2="' + (WIDTH - MARGIN) + '" y1="184.5" y2="184.5" stroke="' + theme.rule + '" />');

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
    body.push('  <rect x="' + legendX + '" y="209" width="9" height="9" fill="' + theme.ink + '" fill-opacity="0.3" />');
    body.push("  " + drawLabel(barName, { theme, x: legendX + 17, y: 217 }));
    legendX += 17 + measure(barName.toUpperCase(), "mono", 10, 1.5).width + 28;
  }
  if (chart.line !== "none") {
    body.push('  <line x1="' + legendX + '" x2="' + (legendX + 14) + '" y1="213.5" y2="213.5" stroke="' + theme.accent + '" stroke-width="1.75" />');
    body.push("  " + drawLabel(lineName, { theme, x: legendX + 22, y: 217 }));
  }

  for (let value = 0; value <= primary.max + 1e-9; value += primary.step) {
    const y = round(yFor(value, primary)) + 0.5;
    body.push('  <line x1="' + plot.left + '" x2="' + plot.right + '" y1="' + y + '" y2="' + y + '" stroke="' + (value === 0 ? theme.rule : theme.grid) + '" />');
    body.push("  " + drawLabel(formatCompact(value), { theme, x: plot.left - 12, y: y + 3.5, anchor: "end", tracking: 0.5 }));
  }
  if (secondaryAxis) {
    for (let value = 0; value <= secondary.max + 1e-9; value += secondary.step) {
      body.push("  " + drawLabel(formatCompact(value), { theme, x: plot.right + 12, y: yFor(value, secondary) + 4, tracking: 0.5 }));
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
    body.push("  " + drawLabel(month === 1 ? item.start.slice(0, 4) : MONTHS[month - 1], { theme, x, y: plot.bottom + 22, anchor: "middle" }));
  });

  const peakIndex = series.reduce((best, item, index) => (item.total > series[best].total ? index : best), 0);
  if (chart.showBars) {
    const barWidth = Math.max(1, Math.min(slot * 0.62, 26));
    body.push('  <g fill="' + theme.ink + '" fill-opacity="0.24">');
    series.forEach((item, index) => {
      if (item.total <= 0) return;
      const top = Math.min(yFor(item.total, primary), plot.bottom - 1);
      body.push('    <rect x="' + round(xFor(index) - barWidth / 2) + '" y="' + round(top) + '" width="' + round(barWidth) + '" height="' + round(plot.bottom - top) + '" />');
    });
    body.push("  </g>");
    const peak = series[peakIndex];
    const peakX = Math.min(Math.max(xFor(peakIndex), plot.left + 44), plot.right - 44);
    body.push("  " + drawLabel("Peak " + formatNumber(peak.total), { theme, x: peakX, y: Math.max(yFor(peak.total, primary) - 9, plot.top - 6), anchor: "middle" }));
  }
  if (chart.line !== "none") {
    const scale = secondaryAxis ? secondary : primary;
    const points = lineValues.map((value, index) => round(xFor(index)) + " " + round(yFor(value, scale)));
    const last = points[points.length - 1].split(" ");
    body.push('  <path d="M' + points.join(" L") + '" fill="none" stroke="' + theme.accent + '" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />');
    body.push('  <circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="' + theme.accent + '" />');
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
const files = {};

const days = await fetchContributionDays();
if (days.length === 0) throw new Error("The contribution calendar came back empty.");
const summary = summarize(days);
const series = buildSeries(days, config.chart);
for (const [name, theme] of Object.entries(THEMES)) files["activity-" + name + ".svg"] = renderActivity(summary, series, config.chart, theme);
console.log(statColumns(summary).map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")").join("\n"));

if (STATS_TOKEN) {
  const toolMap = JSON.parse(await readFile(new URL("./tool-map.json", import.meta.url), "utf8"));
  const result = await measureAuthoredLanguages({ token: STATS_TOKEN, importLimit: config.languages.importLimit, toolMap, cacheDirectory: REPO_CACHE, log: (message) => console.log(message) });
  const ranking = rankLanguages(result.totals, config.languages);
  const stack = rankTools(result.tools, toolMap, config.tools);
  console.log("Tools by lines written in files that use them: " +
    ([...result.tools.entries()].sort((a, b) => b[1].lines - a[1].lines).map(([tool, weight]) => tool + " " + formatCompact(weight.lines) + "/" + weight.repositories).join(", ") || "none"));
  console.log("Stack: " + (stack.map((group) => group.name + ": " + group.tools.join(", ")).join("; ") || "none"));
  if (ranking.total === 0) throw new Error("No authored code was found; check PROFILE_STATS_TOKEN.");
  for (const [name, theme] of Object.entries(THEMES)) files["languages-" + name + ".svg"] = renderLanguages(ranking, result.repositoryCount, stack, theme);
  console.log("Languages: " + ranking.languages.map((language) => language.name + " " + formatPercent(language.share)).join(", ") + " of " + formatNumber(ranking.total) + " lines");
} else {
  console.log("PROFILE_STATS_TOKEN is not set, so the languages plate keeps its previous version.");
}

await mkdir(OUTPUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(files)) await writeFile(join(OUTPUT_DIR, name), svg, "utf8");
