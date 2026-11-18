// Renders the "GitHub Activity" card for the profile README.
//
// Every number comes from the public contribution calendar (the green grid on
// github.com/<login>), read through the GitHub GraphQL API. Those counts are the
// same for any viewer, so the card matches what visitors can verify themselves.
//
// Usage: GITHUB_TOKEN=<token> node scripts/render-activity.mjs [output-dir]
// Writes activity-dark.svg and activity-light.svg into the output directory.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOGIN = process.env.PROFILE_LOGIN || "yuhanwang14";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const OUTPUT_DIR = process.argv[2] || "dist";

const WIDTH = 800;
const HEIGHT = 128;
const COLUMN_WIDTH = WIDTH / 4;
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// GitHub Primer colors, shared with assets/headline.svg and the link buttons.
const THEMES = {
  dark: { value: "#e6edf3", label: "#c9d1d9", detail: "#8b949e", rule: "#30363d", accent: "#58a6ff" },
  light: { value: "#1f2328", label: "#424a53", detail: "#59636e", rule: "#d0d7de", accent: "#0969da" },
};

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

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
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
  const description = columns
    .map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")")
    .join("; ");

  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '" viewBox="0 0 ' + WIDTH + " " + HEIGHT + '" role="img" aria-labelledby="activity-title activity-desc">',
    '  <title id="activity-title">GitHub activity for ' + escapeXml(LOGIN) + "</title>",
    '  <desc id="activity-desc">' + escapeXml(description) + "</desc>",
    "  <style>",
    "    text { font-family: " + FONT_STACK + "; text-anchor: middle; }",
    "    .value { fill: " + colors.value + "; font-size: 32px; font-weight: 600; letter-spacing: -0.5px; font-variant-numeric: tabular-nums; }",
    "    .accent { fill: " + colors.accent + "; }",
    "    .label { fill: " + colors.label + "; font-size: 14px; font-weight: 500; }",
    "    .detail { fill: " + colors.detail + "; font-size: 13px; font-weight: 400; }",
    "    .rule { stroke: " + colors.rule + "; stroke-width: 1; }",
    "  </style>",
  ];

  for (let index = 1; index < columns.length; index += 1) {
    const x = index * COLUMN_WIDTH;
    lines.push('  <line class="rule" x1="' + x + '" y1="22" x2="' + x + '" y2="106" />');
  }

  columns.forEach((column, index) => {
    const x = index * COLUMN_WIDTH + COLUMN_WIDTH / 2;
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

if (!TOKEN) {
  console.error("Set GITHUB_TOKEN to a token that can read public GitHub data.");
  process.exit(1);
}

const days = await fetchContributionDays();
if (days.length === 0) throw new Error("The contribution calendar came back empty.");

const columns = buildColumns(summarize(days));
const cards = {
  "activity-dark.svg": renderCard(columns, "dark"),
  "activity-light.svg": renderCard(columns, "light"),
};

await mkdir(OUTPUT_DIR, { recursive: true });
for (const [name, svg] of Object.entries(cards)) {
  await writeFile(join(OUTPUT_DIR, name), svg, "utf8");
}

console.log(columns.map((column) => column.label + ": " + column.value + (column.unit ? " " + column.unit : "") + " (" + column.detail + ")").join("\n"));
