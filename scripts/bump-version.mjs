// The app version has one source: `version` in src-tauri/Cargo.toml (tauri.conf.json has none, so Tauri
// takes Cargo's). package.json and Cargo.lock follow it. Versions are plain numbers: X.Y.Z.
//
//   node scripts/bump-version.mjs 1.2.0          set the version everywhere
//   node scripts/bump-version.mjs --check        package.json and Cargo.lock agree with Cargo.toml
//   node scripts/bump-version.mjs --check v1.2.0 ... and the release tag names the same version

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = "claude-manager";
const FILES = {
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
  packageJson: "package.json",
};

const NUMERIC = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isNumericVersion(v) {
  return NUMERIC.test(v);
}

/** The version in a release tag: "v1.2.0" -> "1.2.0"; null when the tag is not of that form. */
export function tagVersion(tag) {
  const m = /^v(.+)$/.exec(tag.trim());
  return m && isNumericVersion(m[1]) ? m[1] : null;
}

// [[package]] name = "claude-manager" followed by its version line
const LOCK_VERSION = new RegExp(`(^name = "${CRATE}"\r?\nversion = ")([^"]*)(")`, "m");
const PACKAGE_VERSION = /^([ \t]*"version"[ \t]*:[ \t]*")([^"]*)(")/m;
const VERSION_LINE = /^(version[ \t]*=[ \t]*")([^"]*)(")/m;

/** Where the [package] table of Cargo.toml starts and ends. */
function packageTable(text) {
  const head = /^\[package\][ \t]*$/m.exec(text);
  if (!head) return null;
  const start = head.index + head[0].length;
  const next = /^\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

// Cargo.toml: the version line inside [package], never a dependency's
const CARGO_VERSION = {
  exec(text) {
    const t = packageTable(text);
    const m = t && VERSION_LINE.exec(text.slice(t.start, t.end));
    return m ? Object.assign(m, { index: t.start + m.index }) : null;
  },
};

function read(re, text, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`no version found in ${what}`);
  return m[2];
}

function replace(re, text, version, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`no version found in ${what}`);
  return text.slice(0, m.index) + m[1] + version + m[3] + text.slice(m.index + m[0].length);
}

export function readVersions({ cargoToml, cargoLock, packageJson }) {
  return {
    cargo: read(CARGO_VERSION, cargoToml, FILES.cargoToml),
    lock: read(LOCK_VERSION, cargoLock, FILES.cargoLock),
    package: read(PACKAGE_VERSION, packageJson, FILES.packageJson),
  };
}

export function setVersion(texts, version) {
  if (!isNumericVersion(version)) throw new Error(`not a numeric version (X.Y.Z): ${version}`);
  return {
    cargoToml: replace(CARGO_VERSION, texts.cargoToml, version, FILES.cargoToml),
    cargoLock: replace(LOCK_VERSION, texts.cargoLock, version, FILES.cargoLock),
    packageJson: replace(PACKAGE_VERSION, texts.packageJson, version, FILES.packageJson),
  };
}

/** Problems with the versions (empty = fine). `tag` is the release tag, when there is one. */
export function checkVersions(texts, tag) {
  const v = readVersions(texts);
  const problems = [];
  if (!isNumericVersion(v.cargo)) problems.push(`${FILES.cargoToml} version ${v.cargo} is not numeric (X.Y.Z)`);
  if (v.lock !== v.cargo) problems.push(`${FILES.cargoLock} has ${v.lock}, ${FILES.cargoToml} has ${v.cargo}`);
  if (v.package !== v.cargo) problems.push(`${FILES.packageJson} has ${v.package}, ${FILES.cargoToml} has ${v.cargo}`);
  if (tag !== undefined) {
    const tv = tagVersion(tag);
    if (tv === null) problems.push(`tag ${tag} is not of the form vX.Y.Z`);
    else if (tv !== v.cargo) problems.push(`tag ${tag} does not match ${FILES.cargoToml} version ${v.cargo}`);
  }
  return problems;
}

function load() {
  return Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readFileSync(join(root, f), "utf8")]));
}

function main(args) {
  if (args[0] === "--check") {
    const problems = checkVersions(load(), args[1]);
    for (const p of problems) console.error(`version check: ${p}`);
    if (problems.length) process.exit(1);
    console.log(`version ${readVersions(load()).cargo} is consistent${args[1] ? ` with tag ${args[1]}` : ""}`);
    return;
  }
  if (args.length !== 1) {
    console.error("usage: node scripts/bump-version.mjs <X.Y.Z> | --check [vX.Y.Z]");
    process.exit(2);
  }
  const next = setVersion(load(), args[0]);
  for (const [k, f] of Object.entries(FILES)) writeFileSync(join(root, f), next[k]);
  console.log(`version set to ${args[0]}; commit, then tag v${args[0]}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
