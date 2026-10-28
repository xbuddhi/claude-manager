// Syntax colours for the diff viewer, with Lezer parsers. A language's parser loads the first time a diff
// shows one of its files. Each hunk is parsed twice, its old side (context and removed lines) and its new
// side (context and added lines), so code spanning lines inside a hunk reads right; context lines take the
// new side's colours. A hunk that starts inside a comment or string can still come out wrong.

import type { Parser, Tree } from "@lezer/common";
import { highlightCode, styleTags, Tag, tags as t, tagHighlighter } from "@lezer/highlight";
import type { DiffLine } from "./diffparse";

/** One coloured piece of a line: its text and its `syn-*` class ("" = plain). */
export type Token = [text: string, cls: string];

/** Files and diffs bigger than this (in characters) stay plain: colouring them takes too long to be worth it. */
const MAX_CHARS = 300_000;
/** Work done before giving the page a turn (ms), and the text coloured between two checks (characters). */
const SLICE_MS = 8;
const CHUNK = 16_000;

/** Says the result is no longer wanted (another file or diff came up): the work stops early. */
export type Stale = () => boolean;

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

/** The next task: lets input and painting run between two slices of work. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** Splits long work into slices of SLICE_MS; `pause()` is false once the result is stale. */
function slicer(stale: Stale | undefined) {
  let start = performance.now();
  return async (): Promise<boolean> => {
    if (performance.now() - start >= SLICE_MS) {
      await nextTask();
      start = performance.now();
    }
    return !stale?.();
  };
}
type Pause = ReturnType<typeof slicer>;

/** `text` split into lines of tokens, parsed and coloured a slice at a time; null once stale. */
async function tokenize(parser: Parser, text: string, pause: Pause): Promise<Token[][] | null> {
  const parse = parser.startParse(text);
  let tree: Tree | null = parse.advance();
  while (!tree) {
    if (!(await pause())) return null;
    tree = parse.advance();
  }
  const lines: Token[][] = [[]];
  const put = (piece: string, cls: string) => (lines[lines.length - 1] as Token[]).push([piece, cls]);
  const brk = () => lines.push([]);
  // in chunks that end after a line break, so no line is cut: the tokens come out as from one pass
  for (let from = 0; from < text.length; ) {
    const nl = from + CHUNK < text.length ? text.indexOf("\n", from + CHUNK) : -1;
    const to = nl < 0 ? text.length : nl + 1;
    highlightCode(text, tree, highlighter, put, brk, from, to);
    from = to;
    if (from < text.length && !(await pause())) return null;
  }
  return lines;
}

/**
 * Tokens for every line of the file `path` (null: no parser for its language, too large, or `stale` became
 * true meanwhile). The work is split so the page stays responsive.
 */
export async function highlightFile(path: string, text: string, stale?: Stale): Promise<Token[][] | null> {
  if (text.length > MAX_CHARS) return null;
  const parser = await parserFor(path);
  if (!parser || stale?.()) return null;
  return tokenize(parser, text, slicer(stale));
}

/** The path a "file" line names (a new file's line ends with "  (new file)"). */
function pathOf(d: DiffLine): string {
  return d.text.replace(/\s+\(new file\)$/, "");
}

/**
 * Tokens for every code line of `lines` (by index; missing = plain). Resolves once the parsers it needs
 * have loaded and every hunk is coloured; the work is split so the page stays responsive, and stops early
 * (leaving the rest plain) once `stale` is true.
 */
export async function highlightDiff(lines: readonly DiffLine[], stale?: Stale): Promise<Array<Token[] | undefined>> {
  const out: Array<Token[] | undefined> = new Array(lines.length);
  let chars = 0;
  for (const d of lines) chars += d.text.length + 1;
  if (chars > MAX_CHARS) return out;

  const pause = slicer(stale);
  let parser: Parser | null = null;
  // the hunk being collected: line indexes of each side, in order
  let oldSide: number[] = [];
  let newSide: number[] = [];
  /** Colours the hunk collected; false once stale. */
  const flush = async (): Promise<boolean> => {
    const sides = [oldSide, newSide];
    oldSide = [];
    newSide = [];
    if (!parser) return !stale?.();
    for (const side of sides) {
      if (!side.length) continue;
      const toks = await tokenize(parser, side.map((i) => (lines[i] as DiffLine).text).join("\n"), pause);
      if (!toks) return false;
      side.forEach((i, n) => {
        out[i] = toks[n];
      });
      if (!(await pause())) return false;
    }
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i] as DiffLine;
    if (d.kind === "file") {
      if (!(await flush())) return out;
      parser = await parserFor(pathOf(d));
    } else if (d.kind === "hunk") {
      if (!(await flush())) return out;
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
  await flush();
  return out;
}
