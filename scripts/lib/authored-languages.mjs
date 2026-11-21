// Counts the lines of code the account has written, by language, across every repository
// the token can see: personal, organization and collaborator repositories, private ones too.
// It also weighs the tools that code is written with (see authored-tools.mjs).
//
// Each repository with commits authored by the account on its default branch is cloned,
// and git log --numstat is read for those commits only. Lines added are summed by file
// type. A commit that appears in several repositories (a fork, a mirror) counts once.
// Vendored, generated and lock files are skipped, and so are bulk imports: commits that add
// more than importLimit lines at once, which nearly always copy code in rather than write it.
// Only totals per language and per tool leave this module; repository names are never rendered.
// Workflow logs on a public repository are public, so nothing here logs repository names,
// git output or command lines, and the token reaches git through the environment only.
// Clones go to a temporary folder that is removed afterwards. Local runs can pass
// cacheDirectory to keep the clones between runs; delete that folder to read fresh history.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { compileToolRules, weighTools } from "./authored-tools.mjs";

const run = promisify(execFile);

const EXTENSIONS = {
  py: "Python", pyi: "Python", pyx: "Python",
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  c: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++", ipp: "C++",
  cu: "Cuda", cuh: "Cuda", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin",
  scala: "Scala", sc: "Scala", swift: "Swift", dart: "Dart", rb: "Ruby", php: "PHP", cs: "C#",
  fs: "F#", lean: "Lean", jl: "Julia", hs: "Haskell", ml: "OCaml", mli: "OCaml", ex: "Elixir",
  exs: "Elixir", erl: "Erlang", lua: "Lua", r: "R", sh: "Shell", bash: "Shell", zsh: "Shell",
  fish: "Shell", ps1: "PowerShell", sql: "SQL", astro: "Astro", vue: "Vue", svelte: "Svelte",
  html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  md: "Markdown", mdx: "MDX", tex: "TeX", typ: "Typst", wgsl: "WGSL", glsl: "GLSL",
  s: "Assembly", asm: "Assembly", ipynb: "Jupyter Notebook", pl: "Perl", pm: "Perl", nix: "Nix",
  zig: "Zig", sol: "Solidity", proto: "Protocol Buffer", m: "Objective-C", mm: "Objective-C++",
  v: "Verilog", sv: "SystemVerilog", vhd: "VHDL", clj: "Clojure", elm: "Elm", gd: "GDScript",
  tf: "HCL", bat: "Batchfile", cmd: "Batchfile",
};
const FILENAMES = { makefile: "Makefile", gnumakefile: "Makefile", dockerfile: "Dockerfile", "cmakelists.txt": "CMake", justfile: "Just" };
const SKIP_DIRECTORY = /(^|\/)(node_modules|vendor|vendored|third_party|third-party|external|deps|dist|build|out|target|\.venv|venv|site-packages|__pycache__|\.next|\.nuxt|\.svelte-kit|coverage|generated|__generated__)\//i;
const SKIP_FILE = /(\.min\.(js|css)|\.map|\.pb\.go|_pb2\.py|\.g\.dart|\.freezed\.dart|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|Podfile\.lock))$/i;
const isSkipped = (path) => SKIP_DIRECTORY.test(path) || SKIP_FILE.test(path);

function createGraphql(token) {
  return async function graphql(query, variables) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: { Authorization: "bearer " + token, "Content-Type": "application/json", "User-Agent": "profile-authored-languages" },
          body: JSON.stringify({ query, variables }),
        });
        const payload = await response.json();
        if (!response.ok || payload.errors) throw new Error("GraphQL request failed (" + response.status + "): " + JSON.stringify(payload.errors || payload.message));
        return payload.data;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
    throw lastError;
  };
}

const REPOSITORY_FIELDS =
  "nameWithOwner isEmpty languages(first: 20) { edges { size node { name } } } " +
  "defaultBranchRef { target { ... on Commit { history(author: { id: $id }, first: 100) { totalCount nodes { author { email } } } } } }";

async function listRepositories(graphql) {
  const { viewer } = await graphql("query { viewer { id login } }", {});
  const repositories = new Map();
  const emails = new Set();
  const collect = (node) => {
    const history = node.defaultBranchRef && node.defaultBranchRef.target && node.defaultBranchRef.target.history;
    if (!history || history.totalCount === 0 || node.isEmpty) return;
    for (const commit of history.nodes) if (commit.author && commit.author.email) emails.add(commit.author.email.toLowerCase());
    const sizes = Object.fromEntries(node.languages.edges.map((edge) => [edge.node.name, edge.size]));
    repositories.set(node.nameWithOwner, { name: node.nameWithOwner, headerLanguage: (sizes.C || 0) > (sizes["C++"] || 0) ? "C" : "C++" });
  };

  for (const connection of ["repositories", "repositoriesContributedTo"]) {
    const filter = connection === "repositories"
      ? "ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]"
      : "contributionTypes: [COMMIT], includeUserRepositories: true";
    let cursor = null;
    do {
      const data = await graphql(
        "query($id: ID!, $cursor: String) { viewer { " + connection + "(first: 50, after: $cursor, " + filter + ") { pageInfo { hasNextPage endCursor } nodes { " + REPOSITORY_FIELDS + " } } } }",
        { id: viewer.id, cursor },
      );
      const page = data.viewer[connection];
      page.nodes.forEach(collect);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }
  return { repositories: [...repositories.values()], emails: [...emails] };
}

function languageOf(path, headerLanguage) {
  const file = path.split("/").pop().toLowerCase();
  if (FILENAMES[file]) return FILENAMES[file];
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = file.slice(dot + 1);
  if (extension === "h") return headerLanguage;
  return EXTENSIONS[extension] || null;
}

function normalizePath(raw) {
  const braced = raw.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1").replace(/\/\//g, "/");
  return braced.includes(" => ") ? braced.split(" => ").pop() : braced;
}

// One entry per commit: lines added in total, by language, and by file.
function parseLog(stdout, headerLanguage) {
  const commits = [];
  let commit = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) {
      commit = { sha: line.slice(2), total: 0, languages: new Map(), paths: new Map() };
      commits.push(commit);
      continue;
    }
    const match = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
    if (!match || !commit) continue;
    const path = normalizePath(match[3]);
    if (isSkipped(path)) continue;
    const language = languageOf(path, headerLanguage);
    const added = Number(match[1]);
    if (!language || added === 0) continue;
    commit.total += added;
    commit.languages.set(language, (commit.languages.get(language) || 0) + added);
    commit.paths.set(path, (commit.paths.get(path) || 0) + added);
  }
  return commits;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function measureAuthoredLanguages({ token, importLimit = 8000, toolMap = {}, cacheDirectory = null, log = () => {} }) {
  const graphql = createGraphql(token);
  const toolRules = compileToolRules(toolMap);
  const { repositories, emails } = await listRepositories(graphql);
  log("Repositories with authored commits: " + repositories.length + "; author emails: " + emails.length);

  const workspace = cacheDirectory || (await mkdtemp(join(tmpdir(), "authored-languages-")));
  await mkdir(workspace, { recursive: true });
  const encoded = Buffer.from("x-access-token:" + token).toString("base64");
  if (process.env.GITHUB_ACTIONS === "true") console.log("::add-mask::" + encoded);
  const gitEnv = Object.assign({}, process.env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + encoded,
  });
  const seen = new Set();
  const totals = new Map();
  const tools = new Map();
  let skippedImports = 0;
  let countedCommits = 0;
  let failed = 0;
  let unweighed = 0;

  try {
    const histories = await mapLimit(repositories, 6, async (repository) => {
      const directory = join(workspace, repository.name.replace("/", "__") + ".git");
      try {
        if (!cacheDirectory || !existsSync(directory)) {
          const partial = directory + ".partial";
          await rm(partial, { recursive: true, force: true });
          await run("git", ["clone", "--bare", "--quiet", "--single-branch", "--no-tags", "https://github.com/" + repository.name + ".git", partial], { env: gitEnv, maxBuffer: 1 << 20 });
          await rename(partial, directory);
        }
        const args = ["-C", directory, "log", "--no-merges", "--numstat", "--format=@@%H", "--fixed-strings", "-i"];
        for (const email of emails) args.push("--author=" + email);
        const { stdout } = await run("git", args, { env: gitEnv, maxBuffer: 1 << 28 });
        return { directory, commits: parseLog(stdout, repository.headerLanguage), files: new Map() };
      } catch (error) {
        failed += 1;
        log("A repository could not be read (git exit code " + (typeof error.code === "number" ? error.code : "unknown") + ").");
        return { directory, commits: [], files: new Map() };
      }
    });

    // Each commit counts once, in the first repository that has it, unless it is a bulk import.
    for (const history of histories) {
      for (const commit of history.commits) {
        if (seen.has(commit.sha)) continue;
        seen.add(commit.sha);
        if (commit.total > importLimit) {
          skippedImports += 1;
          continue;
        }
        if (commit.total === 0) continue;
        countedCommits += 1;
        for (const [language, lines] of commit.languages) totals.set(language, (totals.get(language) || 0) + lines);
        for (const [path, lines] of commit.paths) history.files.set(path, (history.files.get(path) || 0) + lines);
      }
    }

    const weights = await mapLimit(histories, 6, (history) =>
      history.files.size === 0
        ? new Map()
        : weighTools({ directory: history.directory, rules: toolRules, files: history.files, skip: isSkipped }).catch(() => {
            unweighed += 1;
            return new Map();
          }),
    );
    for (const repositoryWeights of weights) {
      for (const [tool, lines] of repositoryWeights) {
        if (lines === 0) continue;
        const entry = tools.get(tool) || { lines: 0, repositories: 0 };
        entry.lines += lines;
        entry.repositories += 1;
        tools.set(tool, entry);
      }
    }
  } finally {
    if (!cacheDirectory) await rm(workspace, { recursive: true, force: true });
  }

  log("Counted commits: " + countedCommits + "; bulk imports skipped: " + skippedImports + "; repositories that failed to clone: " + failed);
  if (unweighed) log("Repositories whose tools could not be read: " + unweighed);
  return { totals, tools, repositoryCount: repositories.length - failed, commitCount: countedCommits };
}
