// Syntax colours for the diff viewer, with Lezer parsers. A language's parser loads the first time a diff
// shows one of its files. Each hunk is parsed twice, its old side (context and removed lines) and its new
// side (context and added lines), so code spanning lines inside a hunk reads right; context lines take the
// new side's colours. A hunk that starts inside a comment or string can still come out wrong.

import type { Parser } from "@lezer/common";
import { highlightCode, styleTags, Tag, tags as t, tagHighlighter } from "@lezer/highlight";
import type { DiffLine } from "./diffparse";

/** One coloured piece of a line: its text and its `syn-*` class ("" = plain). */
export type Token = [text: string, cls: string];

/** Diffs bigger than this (in characters) stay plain: parsing them would hold up the view. */
const MAX_CHARS = 2_000_000;

/** Roles the JS/TS grammar does not tag apart, which Monokai colours: parameters, and members of a type. */
const param = Tag.define(t.variableName);
const member = Tag.define(t.propertyName);
const jsRoles = styleTags({
  "ParamList/VariableDefinition ParamList/ObjectPattern/PatternProperty/VariableDefinition ParamList/ArrayPattern/VariableDefinition":
    param,
  "PropertyType/PropertyDefinition": member,
});

/**
 * Syntax tags -> classes, in the roles Monokai Pro colours apart (git.css has the colours): `export` and
 * `const` differ, calls differ from the names they call, `=>` is an operator. The most specific tag wins.
 */
const highlighter = tagHighlighter([
  { tag: t.keyword, class: "syn-keyword" },
  { tag: [t.definitionKeyword, t.modifier], class: "syn-storage" },
  { tag: [t.operator, t.function(t.punctuation)], class: "syn-operator" },
  { tag: t.punctuation, class: "syn-punct" },
  { tag: [t.string, t.special(t.string), t.attributeValue], class: "syn-string" },
  { tag: [t.regexp, t.escape], class: "syn-escape" },
  { tag: [t.number, t.bool, t.null, t.atom, t.self], class: "syn-constant" },
  { tag: t.comment, class: "syn-comment" },
  { tag: param, class: "syn-param" },
  { tag: member, class: "syn-member" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.function(t.definition(t.variableName)),
      t.macroName,
    ],
    class: "syn-function",
  },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.className)], class: "syn-type" },
  { tag: t.tagName, class: "syn-tag" },
  { tag: t.attributeName, class: "syn-attribute" },
  { tag: [t.meta, t.annotation], class: "syn-meta" },
  { tag: t.heading, class: "syn-heading" },
  { tag: [t.link, t.url], class: "syn-link" },
  { tag: t.emphasis, class: "syn-emphasis" },
  { tag: t.strong, class: "syn-strong" },
]);

type Loader = () => Promise<Parser>;

const js =
  (dialect: string): Loader =>
  async () =>
    (await import("@lezer/javascript")).parser.configure({ dialect, props: [jsRoles] });

/** File extension -> parser loader. */
const LANGUAGES: Record<string, Loader> = {
  js: js("jsx"),
  mjs: js(""),
  cjs: js(""),
  jsx: js("jsx"),
  ts: js("ts"),
  mts: js("ts"),
  cts: js("ts"),
  tsx: js("ts jsx"),
  json: async () => (await import("@lezer/json")).parser,
  css: async () => (await import("@lezer/css")).parser,
  html: async () => (await import("@lezer/html")).parser,
  htm: async () => (await import("@lezer/html")).parser,
  rs: async () => (await import("@lezer/rust")).parser,
  py: async () => (await import("@lezer/python")).parser,
  yml: async () => (await import("@lezer/yaml")).parser,
  yaml: async () => (await import("@lezer/yaml")).parser,
  md: async () => (await import("@lezer/markdown")).parser,
};
// jsonc, tsconfig and the like are JSON with comments: the JSON parser marks the comments as errors, which
// only means they stay plain
for (const ext of ["jsonc", "json5"]) LANGUAGES[ext] = LANGUAGES.json as Loader;

const loaded = new Map<string, Promise<Parser | null>>();

/** The parser for `path`, loaded once per language; null for a language without one. */
function parserFor(path: string): Promise<Parser | null> {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  const load = LANGUAGES[ext];
  if (!load) return Promise.resolve(null);
  let p = loaded.get(ext);
  if (!p) {
    p = load().catch(() => null);
    loaded.set(ext, p);
  }
  return p;
}

/** `text` split into lines of tokens. */
function tokenize(parser: Parser, text: string): Token[][] {
  const lines: Token[][] = [[]];
  highlightCode(
    text,
    parser.parse(text),
    highlighter,
    (piece, cls) => (lines[lines.length - 1] as Token[]).push([piece, cls]),
    () => lines.push([]),
  );
  return lines;
}

/** Tokens for every line of the file `path` (null: no parser for its language, or too large). */
export async function highlightFile(path: string, text: string): Promise<Token[][] | null> {
  if (text.length > MAX_CHARS) return null;
  const parser = await parserFor(path);
  return parser ? tokenize(parser, text) : null;
}

/** The path a "file" line names (a new file's line ends with "  (new file)"). */
function pathOf(d: DiffLine): string {
  return d.text.replace(/\s+\(new file\)$/, "");
}

/**
 * Tokens for every code line of `lines` (by index; missing = plain). Resolves once the parsers it needs
 * have loaded.
 */
export async function highlightDiff(lines: readonly DiffLine[]): Promise<Array<Token[] | undefined>> {
  const out: Array<Token[] | undefined> = new Array(lines.length);
  let chars = 0;
  for (const d of lines) chars += d.text.length + 1;
  if (chars > MAX_CHARS) return out;

  let parser: Parser | null = null;
  // the hunk being collected: line indexes of each side, in order
  let oldSide: number[] = [];
  let newSide: number[] = [];
  const flush = () => {
    if (parser) {
      for (const side of [oldSide, newSide]) {
        if (!side.length) continue;
        const toks = tokenize(parser, side.map((i) => (lines[i] as DiffLine).text).join("\n"));
        side.forEach((i, n) => {
          out[i] = toks[n];
        });
      }
    }
    oldSide = [];
    newSide = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i] as DiffLine;
    if (d.kind === "file") {
      flush();
      parser = await parserFor(pathOf(d));
    } else if (d.kind === "hunk") {
      flush();
    } else if (d.kind === "del") {
      oldSide.push(i);
    } else if (d.kind === "add") {
      newSide.push(i);
    } else if (d.kind === "context") {
      // the new side's colours win: it is filled after the old side
      oldSide.push(i);
      newSide.push(i);
    }
  }
  flush();
  return out;
}
