// Finds the tools the account writes code with, weighted by how much of that code it wrote.
//
// A file uses a tool when it imports it: "import torch", 'from "react"', "#include <opencv2/...>",
// "use tokio::", "import SwiftUI". A tool's weight is the number of lines the account wrote in
// files that use it, so tools rank by how much of the account's own code is built on them.
// A library that is declared but barely touched ranks low, and build, test and CI tooling does
// not show up at all, because application code never imports it.
//
// tool-map.json lists each tool with its group and the names it is imported by in each language
// (python, js, cpp, rust, go, swift, jvm, dart). Dotted and slashed names match by prefix, so
// "google.genai" matches "from google.genai import types", and "@scope/*" matches a whole npm
// scope. Three optional rules cover tools that imports alone do not reveal:
//   extensions          files of these types always use the tool (.astro is Astro, .cu is CUDA)
//   projectExtensions   files of these types use the tool in a repository that imports it or
//                       declares it in package.json (.tsx files in a React project)
//   paths               a matching file, such as a Dockerfile, means every file of code under
//                       its folder uses the tool
// Files are read on the default branch, so code deleted since then no longer counts. Nothing
// here logs or returns file contents.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const MAX_FILE_BYTES = 512 * 1024;
const FAMILY_EXTENSIONS = {
  python: ["py", "pyi", "pyx"],
  js: ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "astro", "vue", "svelte"],
  cpp: ["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "ipp", "cu", "cuh", "m", "mm"],
  rust: ["rs"],
  go: ["go"],
  swift: ["swift"],
  jvm: ["java", "kt", "kts", "scala"],
  dart: ["dart"],
};
const FAMILY_OF = new Map(Object.entries(FAMILY_EXTENSIONS).flatMap(([family, extensions]) => extensions.map((extension) => [extension, family])));
// Import names nest in these families: torch.nn, androidx.compose.ui, github.com/gin-gonic/gin/binding.
const SEPARATOR = { python: ".", jvm: ".", go: "/" };

function extensionOf(path) {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

// "next/link" is the package "next", "@scope/name/sub" is "@scope/name"; relative paths,
// path aliases and protocol imports such as node:fs are not packages.
function npmPackage(specifier) {
  if (/^[./~#]|^[a-z][\w+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function words(list) {
  return list.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
}

const EXTRACT = {
  python(text) {
    const names = [];
    for (const match of text.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b([^\n#]*)|import[ \t]+([^\n#;]+))/gm)) {
      if (match[1]) {
        names.push(match[1]);
        for (const name of words(match[2].replace(/[()\\]/g, ""))) if (/^[A-Za-z_]\w*$/.test(name)) names.push(match[1] + "." + name);
      } else {
        for (const name of words(match[3])) if (/^[A-Za-z_][\w.]*$/.test(name)) names.push(name);
      }
    }
    return names;
  },
  js(text) {
    const names = [];
    for (const match of text.matchAll(/(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"'\n]+)["']/g)) {
      const name = npmPackage(match[1]);
      if (name) names.push(name);
    }
    return names;
  },
  cpp(text) {
    return [...text.matchAll(/^[ \t]*#[ \t]*(?:include|import)[ \t]*[<"]([^>"\n]+)[>"]/gm)].map((match) => match[1].split("/")[0].replace(/\.(h|hh|hpp|hxx|cuh)$/i, ""));
  },
  rust(text) {
    return [...text.matchAll(/^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:use|extern[ \t]+crate)[ \t]+(?:::)?([A-Za-z_]\w*)|^[ \t]*#\[([A-Za-z_]\w*)::/gm)].map((match) => match[1] || match[2]);
  },
  go(text) {
    const names = [];
    for (const block of text.matchAll(/^import[ \t]*\(([^)]*)\)/gm)) for (const match of block[1].matchAll(/"([^"\n]+)"/g)) names.push(match[1]);
    for (const match of text.matchAll(/^import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) names.push(match[1]);
    return names;
  },
  swift(text) {
    return [...text.matchAll(/^[ \t]*(?:@[\w()]+[ \t]+)*import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?([A-Za-z_]\w*)/gm)].map((match) => match[1]);
  },
  jvm(text) {
    return [...text.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm)].map((match) => match[1]);
  },
  dart(text) {
    return [...text.matchAll(/^[ \t]*(?:import|export)[ \t]+["']package:(\w+)\//gm)].map((match) => match[1]);
  },
};

function lookup(names, name, family) {
  if (names.has(name)) return names.get(name);
  const separator = SEPARATOR[family];
  if (separator) {
    for (let cut = name.lastIndexOf(separator); cut > 0; cut = name.lastIndexOf(separator, cut - 1)) {
      const prefix = name.slice(0, cut);
      if (names.has(prefix)) return names.get(prefix);
    }
  }
  if (family === "js" && name.startsWith("@")) return names.get(name.split("/")[0] + "/*");
  return undefined;
}

export function compileToolRules(toolMap) {
  const imports = Object.fromEntries(Object.keys(FAMILY_EXTENSIONS).map((family) => [family, new Map()]));
  const extensions = new Map();
  const projectExtensions = [];
  const paths = [];
  for (const tool of toolMap.tools || []) {
    for (const family of Object.keys(imports)) for (const name of tool[family] || []) imports[family].set(name, tool.name);
    for (const extension of tool.extensions || []) extensions.set(extension, (extensions.get(extension) || []).concat(tool.name));
    if (tool.projectExtensions) projectExtensions.push({ tool: tool.name, extensions: new Set(tool.projectExtensions), packages: tool.js || [] });
    if (tool.paths) paths.push({ tool: tool.name, patterns: tool.paths.map((pattern) => new RegExp(pattern, "i")) });
  }
  return { imports, extensions, projectExtensions, paths };
}

// Reads many blobs through one git process; returns their text in the order asked for.
function readBlobs(directory, shas) {
  if (shas.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", directory, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("git cat-file exited with code " + code));
      const output = Buffer.concat(chunks);
      const texts = [];
      let offset = 0;
      for (let index = 0; index < shas.length; index += 1) {
        const end = output.indexOf(10, offset);
        if (end < 0) break;
        const header = output.toString("latin1", offset, end).split(" ");
        offset = end + 1;
        if (header[1] === "missing") {
          texts.push("");
          continue;
        }
        const size = Number(header[2]);
        texts.push(output.toString("utf8", offset, offset + size));
        offset += size + 1;
      }
      resolve(texts);
    });
    child.stdin.end(shas.join("\n") + "\n");
  });
}

async function declaredPackages(directory, tree) {
  const manifests = [...tree.entries()].filter(([path, blob]) => /(^|\/)package\.json$/.test(path) && blob.size <= MAX_FILE_BYTES);
  const declared = new Set();
  for (const text of await readBlobs(directory, manifests.map(([, blob]) => blob.sha))) {
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      continue;
    }
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest[section] || {})) declared.add(name);
    }
  }
  return declared;
}

// files maps each path to the lines the account wrote there. Returns a Map of tool to lines.
// Paths for which skip() is true (vendored or generated code) are ignored.
export async function weighTools({ directory, rules, files, skip }) {
  const { stdout } = await run("git", ["-C", directory, "ls-tree", "-r", "-l", "-z", "HEAD"], { maxBuffer: 1 << 28 });
  const tree = new Map();
  for (const entry of stdout.split("\0")) {
    const match = /^\d+ blob ([0-9a-f]+) +(\d+)\t([\s\S]+)$/.exec(entry);
    if (match && !skip(match[3])) tree.set(match[3], { sha: match[1], size: Number(match[2]) });
  }

  // The account's files that still exist, in a language whose imports can be read.
  const code = [...files.keys()].filter((path) => tree.has(path) && FAMILY_OF.has(extensionOf(path)));
  const readable = code.filter((path) => tree.get(path).size <= MAX_FILE_BYTES);
  const texts = await readBlobs(directory, readable.map((path) => tree.get(path).sha));

  const uses = new Map();
  const use = (tool, path) => {
    if (!uses.has(tool)) uses.set(tool, new Set());
    uses.get(tool).add(path);
  };

  readable.forEach((path, index) => {
    const family = FAMILY_OF.get(extensionOf(path));
    for (const name of EXTRACT[family](texts[index] || "")) {
      const tool = lookup(rules.imports[family], name, family);
      if (tool) use(tool, path);
    }
  });
  for (const path of code) for (const tool of rules.extensions.get(extensionOf(path)) || []) use(tool, path);

  if (rules.projectExtensions.length) {
    const declared = await declaredPackages(directory, tree);
    for (const rule of rules.projectExtensions) {
      if (!uses.has(rule.tool) && !rule.packages.some((name) => declared.has(name))) continue;
      for (const path of code) if (rule.extensions.has(extensionOf(path))) use(rule.tool, path);
    }
  }

  for (const rule of rules.paths) {
    const folders = [...tree.keys()].filter((path) => rule.patterns.some((pattern) => pattern.test(path))).map((path) => path.slice(0, path.lastIndexOf("/") + 1));
    if (folders.length === 0) continue;
    for (const path of code) if (folders.some((folder) => path.startsWith(folder))) use(rule.tool, path);
  }

  const weights = new Map();
  for (const [tool, paths] of uses) weights.set(tool, [...paths].reduce((sum, path) => sum + files.get(path), 0));
  return weights;
}
