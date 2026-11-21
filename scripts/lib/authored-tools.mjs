// Finds the tools and frameworks each repository depends on, read from its default branch.
//
// Dependency manifests (Python, Rust, Go, Gradle, Maven, sbt, Gemfile, Composer, CMake, Flutter)
// are searched for each dependency name, and a name only counts when it stands alone in the
// file: "torch" matches "torch>=2" but not "pytorch" or "torchvision". package.json is parsed
// and only real dependency keys count, so the word "three" in a description is not Three.js.
// Presence rules match file paths such as Dockerfile or .github/workflows, with an optional
// content check. Nothing here logs or returns file contents.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const MAX_MANIFEST_BYTES = 512 * 1024;
const MANIFEST = /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|environment\.ya?ml|pubspec\.yaml|Cargo\.toml|go\.mod|build\.gradle(\.kts)?|pom\.xml|build\.sbt|Gemfile|composer\.json|CMakeLists\.txt)$/i;
const NPM_MANIFEST = /(^|\/)package\.json$/;
const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A name counts only when it stands alone: not part of a longer name such as pytorch for torch.
function standalone(name) {
  return new RegExp("(?<![A-Za-z0-9_.\\-/@])" + escapeRegExp(name) + "(?![A-Za-z0-9_\\-])", "i");
}

export function compileToolRules(toolMap) {
  return {
    dependencies: Object.entries(toolMap.dependencies || {}).map(([name, tool]) => ({ tool, pattern: standalone(name) })),
    npm: new Map(Object.entries(toolMap.npm || {})),
    presence: (toolMap.presence || []).map((rule) => ({
      tool: rule.tool,
      path: new RegExp(rule.path, "i"),
      content: rule.content ? new RegExp(rule.content, "i") : null,
    })),
  };
}

async function readBlob(directory, sha) {
  const { stdout } = await run("git", ["-C", directory, "cat-file", "blob", sha], { maxBuffer: 2 * MAX_MANIFEST_BYTES });
  return stdout;
}

// Returns the set of tool names this repository uses. Paths for which skip() is true are ignored.
export async function detectTools({ directory, rules, skip }) {
  const { stdout } = await run("git", ["-C", directory, "ls-tree", "-r", "-l", "-z", "HEAD"], { maxBuffer: 1 << 28 });
  const found = new Set();

  for (const entry of stdout.split("\0")) {
    const match = /^\d+ blob ([0-9a-f]+) +(\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const [, sha, sizeText, path] = match;
    if (skip(path)) continue;
    const size = Number(sizeText);

    for (const rule of rules.presence) {
      if (found.has(rule.tool) || !rule.path.test(path)) continue;
      if (!rule.content) found.add(rule.tool);
      else if (size <= MAX_MANIFEST_BYTES && rule.content.test(await readBlob(directory, sha))) found.add(rule.tool);
    }

    const isNpm = NPM_MANIFEST.test(path);
    const isManifest = MANIFEST.test(path);
    if (!(isNpm || isManifest) || size > MAX_MANIFEST_BYTES) continue;
    const text = await readBlob(directory, sha);

    if (isNpm) {
      let manifest = {};
      try {
        manifest = JSON.parse(text);
      } catch {
        manifest = {};
      }
      for (const section of NPM_SECTIONS) {
        for (const name of Object.keys(manifest[section] || {})) {
          if (rules.npm.has(name)) found.add(rules.npm.get(name));
        }
      }
    } else {
      for (const rule of rules.dependencies) {
        if (!found.has(rule.tool) && rule.pattern.test(text)) found.add(rule.tool);
      }
    }
  }
  return found;
}
