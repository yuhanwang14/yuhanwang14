// Renders the "GitHub Activity" section of the profile README.
//
// Every number comes from the public contribution calendar (the green grid on
// github.com/<login>), read through the GitHub GraphQL API. Those counts are the
// same for any viewer, so visitors can verify them against the profile.
//
// Usage: GITHUB_TOKEN=<token> node scripts/render-activity.mjs [output-dir]
// Writes into the output directory:
//   activity-dark.svg, activity-light.svg              four headline numbers
//   activity-chart-dark.svg, activity-chart-light.svg  bar and line chart
//
// The chart reads its settings from scripts/activity-chart.json:
//   bucket         "day" | "week" | "month"     size of each bar
//   periods        number of bars to show (4-400)
//   showBars       true | false
//   line           "average" | "cumulative" | "none"
//   averageWindow  bars per moving average (2-52), used when line is "average"

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOGIN = process.env.PROFILE_LOGIN || "yuhanwang14";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const OUTPUT_DIR = process.argv[2] || "dist";
const CHART_CONFIG_URL = new URL("./activity-chart.json", import.meta.url);

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// GitHub Primer colors, shared with the headline and the link buttons.
const THEMES = {
  dark: {
    value: "#e6edf3", label: "#c9d1d9", detail: "#8b949e", rule: "#30363d", grid: "#21262d",
    accent: "#58a6ff", bar: "#1f6feb", barOpacity: 0.55,
  },
  light: {
    value: "#1f2328", label: "#424a53", detail: "#59636e", rule: "#d0d7de", grid: "#eaeef2",
    accent: "#0969da", bar: "#0969da", barOpacity: 0.34,
  },
};

const CHART_DEFAULTS = { bucket: "week", periods: 52, showBars: true, line: "average", averageWindow: 4 };

// ---------------------------------------------------------------- data

async function graphql(query, variables) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: "bearer " + TOKEN,
          "Content-Type": "application/json",
          "User-Agent": LOGIN + "-profile-activity",
        },
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

// The API returns at most one year per contributionsCollection, so the query
// asks for one aliased collection per calendar year since the account was created.
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
    fields.push(
      "y" + year + ': contributionsCollection(from: "' + from + '", to: "' + to + '") ' +
        "{ contributionCalendar { weeks { contributionDays { date contributionCount } } } }",
    );
  }

  const data = await graphql("query($login: String!) { user(login: $login) { " + fields.join(" ") + " } }", { login: LOGIN });
  const countsByDate = new Map();
  for (const collection of Object.values(data.user)) {
    for (const week of collection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) countsByDate.set(day.date, day.contributionCount);
    }
  }

  return [...countsByDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function loadChartConfig() {
  let overrides = {};
  try {
    overrides = JSON.parse(await readFile(CHART_CONFIG_URL, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read scripts/activity-chart.json: " + error.message);
  }
  const config = Object.assign({}, CHART_DEFAULTS, overrides);
  if (!["day", "week", "month"].includes(config.bucket)) throw new Error('bucket must be "day", "week", or "month".');
  if (!["average", "cumulative", "none"].includes(config.line)) throw new Error('line must be "average", "cumulative", or "none".');
  if (!config.showBars && config.line === "none") throw new Error("Turn on showBars or choose a line.");
  config.periods = Math.min(Math.max(Math.round(Number(config.periods) || CHART_DEFAULTS.periods), 4), 400);
  config.averageWindow = Math.min(Math.max(Math.round(Number(config.averageWindow) || CHART_DEFAULTS.averageWindow), 2), 52);
  config.showBars = config.showBars !== false;
  return config;
}

// ---------------------------------------------------------------- shared helpers

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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attrs(values) {
  return Object.entries(values)
    .map(([name, value]) => name + '="' + escapeXml(value) + '"')
    .join(" ");
}

function svgOpen(width, height, titleId, title, description) {
  return [
    "<svg " + attrs({ xmlns: "http://www.w3.org/2000/svg", width, height, viewBox: "0 0 " + width + " " + height, role: "img", "aria-labelledby": titleId + "-title " + titleId + "-desc" }) + ">",
    '  <title id="' + titleId + '-title">' + escapeXml(title) + "</title>",
    '  <desc id="' + titleId + '-desc">' + escapeXml(description) + "</desc>",
  ];
}

// ---------------------------------------------------------------- summary card

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
  const current = currentLength > 0
    ? { length: currentLength, start: days[start + 1].date, end: days[end].date }
    : { length: 0 };

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

function dayUnit(length) {
  return length === 1 ? "day" : "days";
}

function buildColumns(summary) {
  const currentYear = Number(summary.today.slice(0, 4));
  const activeShare = Math.round((100 * summary.activeDays) / summary.windowDays);
  return [
    { value: formatNumber(summary.contributions), label: "Contributions", detail: "Last 365 days" },
    { value: formatNumber(summary.activeDays), label: "Active days", detail: activeShare + "% of the year" },
    {
      value: formatNumber(summary.current.length),
      unit: dayUnit(summary.current.length),
      label: "Current streak",
      detail: summary.current.length ? formatRange(summary.current.start, summary.current.end, currentYear) : "No active streak",
      accent: summary.current.length > 0,
    },
    {
      value: formatNumber(summary.longest.length),
      unit: dayUnit(summary.longest.length),
      label: "Longest streak",
      detail: summary.longest.length ? formatRange(summary.longest.start, summary.longest.end, currentYear) : "No streak yet",
    },
  ];
}

function renderCard(columns, theme) {
  const colors = THEMES[theme];
  const width = 800;
  const height = 128;
  const columnWidth = width / columns.length;
  const description = columns
    .map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")")
    .join("; ");

  const lines = svgOpen(width, height, "activity", "GitHub activity for " + LOGIN, description).concat([
    "  <style>",
    "    text { font-family: " + FONT_STACK + "; text-anchor: middle; }",
    "    .value { fill: " + colors.value + "; font-size: 32px; font-weight: 600; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; }",
    "    .accent { fill: " + colors.accent + "; }",
    "    .label { fill: " + colors.label + "; font-size: 14px; font-weight: 500; }",
    "    .detail { fill: " + colors.detail + "; font-size: 13px; font-weight: 400; }",
    "    .rule { stroke: " + colors.rule + "; stroke-width: 1; }",
    "  </style>",
  ]);

  for (let index = 1; index < columns.length; index += 1) {
    const x = index * columnWidth;
    lines.push('  <line class="rule" x1="' + x + '" y1="22" x2="' + x + '" y2="106" />');
  }

  columns.forEach((column, index) => {
    const x = index * columnWidth + columnWidth / 2;
    // Presentation attributes keep the unit styled even in renderers that skip CSS on tspans.
    const unit = column.unit
      ? '<tspan dx="5" fill="' + colors.detail + '" font-size="16" font-weight="500" letter-spacing="0">' + escapeXml(column.unit) + "</tspan>"
      : "";
    const valueClass = column.accent ? "value accent" : "value";
    lines.push('  <text class="' + valueClass + '" x="' + x + '" y="52">' + escapeXml(column.value) + unit + "</text>");
    lines.push('  <text class="label" x="' + x + '" y="80">' + escapeXml(column.label) + "</text>");
    lines.push('  <text class="detail" x="' + x + '" y="100">' + escapeXml(column.detail) + "</text>");
  });

  lines.push("</svg>", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- chart

function bucketStart(isoDate, bucket) {
  if (bucket === "day") return isoDate;
  if (bucket === "month") return isoDate.slice(0, 7) + "-01";
  const date = new Date(isoDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function buildSeries(days, config) {
  const totals = new Map();
  for (const day of days) {
    const start = bucketStart(day.date, config.bucket);
    totals.set(start, (totals.get(start) || 0) + day.count);
  }
  const buckets = [...totals.entries()].map(([start, total]) => ({ start, total }));

  // Averages look back past the visible window, so the first bars get a full window too.
  const averages = buckets.map((bucket, index) => {
    const window = buckets.slice(Math.max(0, index - config.averageWindow + 1), index + 1);
    return window.reduce((sum, item) => sum + item.total, 0) / window.length;
  });

  const visible = buckets.slice(-config.periods).map((bucket, offset, list) => {
    const index = buckets.length - list.length + offset;
    return { start: bucket.start, total: bucket.total, average: averages[index] };
  });
  let running = 0;
  for (const bucket of visible) {
    running += bucket.total;
    bucket.cumulative = running;
  }
  return visible;
}

function niceScale(maxValue, targetTicks) {
  if (maxValue <= 0) return { max: targetTicks, step: 1 };
  const rough = maxValue / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough);
  return { max: Math.ceil(maxValue / step) * step, step };
}

function bucketNoun(bucket) {
  return { day: "Daily", week: "Weekly", month: "Monthly" }[bucket];
}

function bucketUnit(bucket) {
  return { day: "day", week: "week", month: "month" }[bucket];
}

function axisLabels(series, bucket, xFor) {
  const labels = [];
  const minGap = 44;
  series.forEach((item, index) => {
    const month = Number(item.start.slice(5, 7));
    const previous = index > 0 ? Number(series[index - 1].start.slice(5, 7)) : null;
    const monthStarts = bucket === "month" || (previous !== null && previous !== month);
    if (!monthStarts) return;
    const x = xFor(index);
    if (labels.length && x - labels[labels.length - 1].x < minGap) return;
    labels.push({ x, text: month === 1 ? item.start.slice(0, 4) : MONTHS[month - 1] });
  });
  return labels;
}

function linePath(points) {
  return points.map((point, index) => (index === 0 ? "M" : "L") + point.x.toFixed(1) + " " + point.y.toFixed(1)).join(" ");
}

function renderChart(series, config, theme) {
  const colors = THEMES[theme];
  const width = 800;
  const height = 240;
  const secondaryAxis = config.showBars && config.line === "cumulative";
  const plot = { left: 44, right: width - (secondaryAxis ? 52 : 12), top: 46, bottom: height - 30 };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const slot = plotWidth / series.length;
  const xFor = (index) => plot.left + slot * (index + 0.5);

  const lineValues = config.line === "none" ? [] : series.map((item) => (config.line === "average" ? item.average : item.cumulative));
  const barValues = config.showBars ? series.map((item) => item.total) : [];
  const primaryValues = secondaryAxis ? barValues : barValues.concat(lineValues);
  const primary = niceScale(Math.max(1, ...primaryValues), 4);
  const secondary = secondaryAxis ? niceScale(Math.max(1, ...lineValues), 4) : primary;
  const yFor = (value, scale) => plot.bottom - (value / scale.max) * plotHeight;

  const noun = bucketNoun(config.bucket);
  const lineLabel = config.line === "average" ? config.averageWindow + "-" + bucketUnit(config.bucket) + " average" : "Cumulative";
  const total = series.reduce((sum, item) => sum + item.total, 0);
  const peakIndex = series.reduce((best, item, index) => (item.total > series[best].total ? index : best), 0);
  const peak = series[peakIndex];
  const description =
    noun + " contributions for the last " + series.length + " " + bucketUnit(config.bucket) + "s: " + formatNumber(total) +
    " in total, peak of " + formatNumber(peak.total) + " starting " + formatDate(peak.start, true) + ".";

  const out = svgOpen(width, height, "activity-chart", noun + " contributions for " + LOGIN, description).concat([
    "  <style>",
    "    text { font-family: " + FONT_STACK + "; }",
    "    .axis { fill: " + colors.detail + "; font-size: 11px; font-variant-numeric: tabular-nums; }",
    "    .legend { fill: " + colors.label + "; font-size: 12px; font-weight: 500; }",
    "    .peak { fill: " + colors.detail + "; font-size: 11px; font-weight: 500; text-anchor: middle; }",
    "  </style>",
  ]);

  // Gridlines and axis labels.
  for (let value = 0; value <= primary.max + 1e-9; value += primary.step) {
    const y = yFor(value, primary);
    out.push('  <line x1="' + plot.left + '" x2="' + plot.right + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + (value === 0 ? colors.rule : colors.grid) + '" stroke-width="1" />');
    out.push('  <text class="axis" x="' + (plot.left - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + formatCompact(value) + "</text>");
  }
  if (secondaryAxis) {
    for (let value = 0; value <= secondary.max + 1e-9; value += secondary.step) {
      const y = yFor(value, secondary);
      out.push('  <text class="axis" x="' + (plot.right + 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="start">' + formatCompact(value) + "</text>");
    }
  }
  for (const label of axisLabels(series, config.bucket, xFor)) {
    out.push('  <text class="axis" x="' + label.x.toFixed(1) + '" y="' + (plot.bottom + 18) + '" text-anchor="middle">' + label.text + "</text>");
  }

  // Bars.
  if (config.showBars) {
    const barWidth = Math.max(1, Math.min(slot * 0.64, 28));
    out.push('  <g fill="' + colors.bar + '" fill-opacity="' + colors.barOpacity + '">');
    series.forEach((item, index) => {
      if (item.total <= 0) return;
      const top = Math.min(yFor(item.total, primary), plot.bottom - 1);
      const radius = Math.min(2, barWidth / 3);
      out.push(
        '    <rect x="' + (xFor(index) - barWidth / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + barWidth.toFixed(1) +
          '" height="' + (plot.bottom - top).toFixed(1) + '" rx="' + radius.toFixed(1) + '" />',
      );
    });
    out.push("  </g>");

    const peakTop = yFor(peak.total, primary);
    const peakX = Math.min(Math.max(xFor(peakIndex), plot.left + 40), plot.right - 40);
    out.push('  <text class="peak" x="' + peakX.toFixed(1) + '" y="' + Math.max(peakTop - 7, plot.top - 4).toFixed(1) + '">Peak ' + formatNumber(peak.total) + "</text>");
  }

  // Line.
  if (config.line !== "none") {
    const scale = secondaryAxis ? secondary : primary;
    const points = lineValues.map((value, index) => ({ x: xFor(index), y: yFor(value, scale) }));
    const last = points[points.length - 1];
    out.push(
      '  <path d="' + linePath(points) + '" fill="none" stroke="' + colors.accent + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />',
      '  <circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="3.5" fill="' + colors.accent + '" />',
    );
  }

  // Legend.
  let legendX = plot.left;
  const legendY = 20;
  if (config.showBars) {
    const label = noun + " contributions";
    out.push('  <rect x="' + legendX + '" y="' + (legendY - 9) + '" width="10" height="10" rx="2" fill="' + colors.bar + '" fill-opacity="' + colors.barOpacity + '" />');
    out.push('  <text class="legend" x="' + (legendX + 16) + '" y="' + legendY + '">' + label + "</text>");
    legendX += 16 + Math.round(label.length * 6.9) + 20;
  }
  if (config.line !== "none") {
    out.push('  <line x1="' + legendX + '" x2="' + (legendX + 16) + '" y1="' + (legendY - 4) + '" y2="' + (legendY - 4) + '" stroke="' + colors.accent + '" stroke-width="2" stroke-linecap="round" />');
    out.push('  <text class="legend" x="' + (legendX + 22) + '" y="' + legendY + '">' + lineLabel + (secondaryAxis ? " (right axis)" : "") + "</text>");
  }

  out.push("</svg>", "");
  return out.join("\n");
}

// ---------------------------------------------------------------- main

if (!TOKEN) {
  console.error("Set GITHUB_TOKEN to a token that can read public GitHub data.");
  process.exit(1);
}

const chartConfig = await loadChartConfig();
const days = await fetchContributionDays();
if (days.length === 0) throw new Error("The contribution calendar came back empty.");

const columns = buildColumns(summarize(days));
const series = buildSeries(days, chartConfig);
const files = {
  "activity-dark.svg": renderCard(columns, "dark"),
  "activity-light.svg": renderCard(columns, "light"),
  "activity-chart-dark.svg": renderChart(series, chartConfig, "dark"),
  "activity-chart-light.svg": renderChart(series, chartConfig, "light"),
};

await mkdir(OUTPUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(files)) {
  await writeFile(join(OUTPUT_DIR, name), svg, "utf8");
}

console.log(columns.map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")").join("\n"));
console.log("Chart: " + JSON.stringify(chartConfig));
