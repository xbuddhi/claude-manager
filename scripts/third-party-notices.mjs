// Writes THIRD_PARTY_NOTICES: every Rust crate compiled into the app (Windows and macOS targets, normal
// dependencies only) and every npm package bundled into the frontend, with its license and the license
// texts the packages ship. Run it after changing dependencies, and before a release:
//
//   node scripts/third-party-notices.mjs
//
// Needs cargo and pnpm on PATH (on the dev workstation: RUSTUP_TOOLCHAIN as in docs/port/README.md).

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin"];
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

// fixed command lines only (pnpm is a .cmd shim on Windows, which needs a shell)
function run(command, cwd) {
  return execSync(command, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function licenseTexts(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n?/g, "\n").trim())
    .filter((t) => t.length > 0);
}

/** Packages reachable from `rootId` through normal (not dev or build) dependencies. */
export function runtimeCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [metadata.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(metadata.resolve.root);
  return metadata.packages.filter((p) => seen.has(p.id));
}

function rustPackages() {
  const platforms = TARGETS.map((t) => `--filter-platform ${t}`).join(" ");
  const metadata = JSON.parse(run(`cargo metadata --format-version 1 --locked ${platforms}`, join(root, "src-tauri")));
  return runtimeCrates(metadata).map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license ?? (p.license_file ? `see ${p.license_file}` : "unknown"),
    url: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
    texts: licenseTexts(dirname(p.manifest_path)),
  }));
}

function npmPackages() {
  const byLicense = JSON.parse(run("pnpm licenses list --prod --json", root));
  return Object.values(byLicense)
    .flat()
    .flatMap((p) =>
      p.versions.map((version, i) => ({
        name: p.name,
        version,
        license: p.license ?? "unknown",
        url: p.homepage ?? `https://www.npmjs.com/package/${p.name}`,
        texts: licenseTexts(p.paths?.[i]),
      })),
    );
}

/** The notices file: a list of packages, then each distinct license text once with the packages that ship it. */
/**
 * Artwork copied into the source rather than installed as a package (icons drawn inline), with the license
 * text it ships. Keep this list in step with the code that uses it.
 */
export const VENDORED = [
  {
    name: "Lucide icons",
    version: "0.469.0",
    license: "ISC",
    url: "https://lucide.dev (settings, palette, square-terminal, info)",
    texts: [
      `ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
    ],
  },
  {
    name: "Octicons",
    version: "mark-github",
    license: "MIT",
    url: "https://github.com/primer/octicons (the GitHub mark in Settings > About)",
    texts: [
      `MIT License

Copyright (c) 2026 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
    ],
  },
];

export function renderNotices(rust, npm, vendored = []) {
  const sort = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const out = [
    "THIRD-PARTY NOTICES",
    "",
    "Claude Manager includes the open source software listed below. Each package is distributed under its",
    "own license, reproduced in the second part of this file. Generated by scripts/third-party-notices.mjs.",
    "",
  ];
  const texts = new Map();
  for (const [title, list] of [
    ["Rust crates (compiled into the app)", sort(rust)],
    ["npm packages (bundled into the user interface)", sort(npm)],
    ["Artwork (drawn into the user interface)", vendored],
  ]) {
    if (!list.length) continue;
    out.push(`== ${title} ==`, "");
    for (const p of list) {
      out.push(`${p.name} ${p.version} - ${p.license} - ${p.url}`);
      for (const t of p.texts) {
        if (!texts.has(t)) texts.set(t, []);
        texts.get(t).push(`${p.name} ${p.version}`);
      }
    }
    out.push("");
  }
  out.push("== License texts ==", "");
  for (const [text, users] of texts) {
    out.push("-".repeat(80), `Used by: ${users.join(", ")}`, "", text, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rust = rustPackages();
  const npm = npmPackages();
  writeFileSync(join(root, "THIRD_PARTY_NOTICES"), renderNotices(rust, npm, VENDORED));
  console.log(`THIRD_PARTY_NOTICES: ${rust.length} crates, ${npm.length} npm packages, ${VENDORED.length} artwork`);
}
