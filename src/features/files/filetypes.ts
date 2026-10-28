// File type badges for the tree: a short label in a syntax colour (git.css --syn-*), by whole name first,
// then by extension. Files without one keep the plain file icon.

export interface FileType {
  label: string;
  /** A --syn-* colour, without "var()". */
  color: string;
}

const t = (label: string, color: string): FileType => ({ label, color: `--syn-${color}` });

const TS = t("TS", "cyan");
/** React components: their own label, in a colour apart from plain TypeScript. */
const TSX = t("TX", "purple");
const JS = t("JS", "yellow");
const JSX = t("JX", "orange");
const JSON_ = t("{}", "yellow");
const MD = t("M↓", "purple");
const STYLE = t("#", "red");
const MARKUP = t("<>", "orange");
const CONFIG = t("≡", "comment-strong");
const SHELL = t("$", "green");
const IMAGE = t("▣", "purple");

const BY_NAME: Record<string, FileType> = {
  "claude.md": t("✱", "orange"),
  "claude.local.md": t("✱", "orange"),
  "package.json": t("{}", "green"),
  ".gitignore": t("◆", "orange"),
  ".gitattributes": t("◆", "orange"),
  ".gitmodules": t("◆", "orange"),
  dockerfile: t("D", "cyan"),
  makefile: t("M", "orange"),
  license: t("§", "yellow"),
  "license.md": t("§", "yellow"),
};

const BY_EXT: Record<string, FileType> = {
  ts: TS,
  tsx: TSX,
  mts: TS,
  cts: TS,
  js: JS,
  jsx: JSX,
  mjs: JS,
  cjs: JS,
  json: JSON_,
  jsonc: JSON_,
  json5: JSON_,
  md: MD,
  mdx: MD,
  markdown: MD,
  css: STYLE,
  scss: STYLE,
  sass: STYLE,
  less: STYLE,
  html: MARKUP,
  htm: MARKUP,
  xml: MARKUP,
  vue: t("V", "green"),
  svelte: t("S", "orange"),
  rs: t("RS", "orange"),
  py: t("PY", "green"),
  go: t("GO", "cyan"),
  java: t("J", "red"),
  kt: t("K", "purple"),
  swift: t("SW", "orange"),
  c: t("C", "cyan"),
  h: t("H", "purple"),
  cpp: t("C+", "cyan"),
  cs: t("C#", "green"),
  rb: t("RB", "red"),
  php: t("PH", "purple"),
  sql: t("DB", "yellow"),
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  ps1: SHELL,
  yml: CONFIG,
  yaml: CONFIG,
  toml: CONFIG,
  ini: CONFIG,
  lock: CONFIG,
  txt: CONFIG,
  log: CONFIG,
  env: t("≡", "yellow"),
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  ico: IMAGE,
  svg: t("<>", "yellow"),
  pdf: t("PDF", "red"),
};

/** The badge for a file named `name`, or null for the plain file icon. */
export function fileType(name: string): FileType | null {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  // .env, .env.local, .env.production
  if (lower === ".env" || lower.startsWith(".env.")) return BY_EXT.env as FileType;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXT[lower.slice(dot + 1)] ?? null;
}
