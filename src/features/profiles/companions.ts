// Profile companions: a small round character per profile, one per team role (SE, QA, PM, ...). Each one
// breathes and blinks on its own clock and has one slow habit of its own (profiles.css, `pc-`). A profile
// without a chosen companion gets one nobody else has, starting from a hash of its folder (so a rename
// does not change it). Drawn as SVG markup from numbers and fixed names only.

import { settings } from "../../core/settings";
import { store } from "../../core/store";

export interface Companion {
  key: string;
  /** Its own name ("Byte"), shown in the chooser. */
  name: string;
  /** What it does when it moves ("bobs to music"), for the tooltip. */
  habit: string;
  body: string;
  wear: Wear;
  /** Blink clock and its offset, so companions never blink together. */
  blink: string;
  blinkDelay: string;
}

type Wear = "headphones" | "glasses" | "flag" | "beanie" | "sleepy" | "chart" | "visor" | "spark" | "cap" | "band";

export const COMPANIONS: readonly Companion[] = [
  {
    key: "se",
    name: "Byte",
    habit: "bobs to music",
    body: "#F2784B",
    wear: "headphones",
    blink: "5.2s",
    blinkDelay: "-1s",
  },
  {
    key: "qa",
    name: "Scout",
    habit: "leans in to look closer",
    body: "#3DC48A",
    wear: "glasses",
    blink: "6.1s",
    blinkDelay: "-3s",
  },
  { key: "pm", name: "Sunny", habit: "waves a flag", body: "#F7B731", wear: "flag", blink: "4.7s", blinkDelay: "-2s" },
  { key: "ux", name: "Doodle", habit: "daydreams", body: "#B072F2", wear: "beanie", blink: "6.8s", blinkDelay: "-4s" },
  {
    key: "ops",
    name: "Snooze",
    habit: "dozes off on call",
    body: "#3F9BF5",
    wear: "sleepy",
    blink: "0s",
    blinkDelay: "0s",
  },
  {
    key: "data",
    name: "Tally",
    habit: "watches the numbers",
    body: "#FF9A2E",
    wear: "chart",
    blink: "5.6s",
    blinkDelay: "-1.5s",
  },
  { key: "sec", name: "Ward", habit: "keeps watch", body: "#6E6AF2", wear: "visor", blink: "0s", blinkDelay: "0s" },
  {
    key: "lead",
    name: "Spark",
    habit: "nods now and then",
    body: "#E8613C",
    wear: "spark",
    blink: "5.9s",
    blinkDelay: "-2.5s",
  },
  { key: "be", name: "Mochi", habit: "rocks, content", body: "#7CC242", wear: "cap", blink: "0s", blinkDelay: "0s" },
  {
    key: "fe",
    name: "Pip",
    habit: "hops now and then",
    body: "#F2679A",
    wear: "band",
    blink: "4.9s",
    blinkDelay: "-3.5s",
  },
];

const INK = "#3b302b";
const BLUSH = "#f4a39a";
const DARK = "#3a3530";

/** FNV-1a of a profile folder: the same folder always gets the same companion. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type Chosen = Readonly<Record<string, string | undefined>>;

const byKey = (key: string | undefined) => COMPANIONS.find((c) => c.key === key);

/**
 * Every profile's companion: the one chosen in the app, else one of the companions nobody has yet, so no
 * two profiles share one while there are enough. Each folder starts looking at the companion its hash
 * points to and takes the next free one; folders are handed theirs in path order, so the result does not
 * depend on the order profiles are found in.
 */
export function assignCompanions(dirs: readonly string[], chosen: Chosen): Map<string, Companion> {
  const out = new Map<string, Companion>();
  const used = new Set<string>();
  for (const dir of dirs) {
    const c = byKey(chosen[dir]);
    if (c) {
      out.set(dir, c);
      used.add(c.key);
    }
  }
  for (const dir of [...new Set(dirs)].filter((d) => !out.has(d)).sort()) {
    const start = hash(dir) % COMPANIONS.length;
    let pick = COMPANIONS[start] as Companion;
    for (let i = 0; i < COMPANIONS.length; i++) {
      const c = COMPANIONS[(start + i) % COMPANIONS.length] as Companion;
      if (!used.has(c.key)) {
        pick = c;
        break;
      }
    }
    out.set(dir, pick);
    used.add(pick.key);
  }
  return out;
}

/** Folders of every known profile, hidden ones too (they keep their companion). */
function profileDirs(): string[] {
  const s = store.get();
  return [...s.profiles, ...s.hiddenProfiles].map((p) => p.dir);
}

/** The companion of a profile folder (see assignCompanions). */
export function companionFor(
  dir: string,
  chosen: Chosen = settings().profileCompanions,
  dirs: readonly string[] = profileDirs(),
): Companion {
  const all = dirs.includes(dir) ? dirs : [...dirs, dir];
  return assignCompanions(all, chosen).get(dir) as Companion;
}

/** Mixes a hex colour toward white (t > 0) or black (t < 0). */
export function shade(hex: string, t: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(t > 0 ? c + (255 - c) * t : c * (1 + t)));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** A Claude-like spark: eight rounded rays, long and short in turn. */
function spark(cx: number, cy: number, r: number, fill: string, cls: string): string {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const len = i % 2 === 0 ? r : r * 0.6;
    rays += `<rect x="${cx - 1.4}" y="${cy - len}" width="2.8" height="${len}" rx="1.4" fill="${fill}" transform="rotate(${i * 45} ${cx} ${cy})"/>`;
  }
  return `<g${cls}>${rays}</g>`;
}

let seq = 0;

/** The companion as SVG markup, `size` px square. `moving` adds the animation classes (profiles.css). */
export function companionSvg(c: Companion, size: number, moving: boolean): string {
  const id = `pc${++seq}`;
  const cls = (name: string) => (moving ? ` class="${name}"` : "");
  const top = shade(c.body, 0.2);
  const bottom = shade(c.body, -0.06);
  const foot = shade(c.body, -0.2);
  const openEyes = `<ellipse cx="39.5" cy="59" rx="4.3" ry="5.3" fill="${INK}"/><ellipse cx="60.5" cy="59" rx="4.3" ry="5.3" fill="${INK}"/><circle cx="41" cy="57" r="1.7" fill="#fff"/><circle cx="62" cy="57" r="1.7" fill="#fff"/><circle cx="38.4" cy="61.3" r="0.8" fill="#fff"/><circle cx="59.4" cy="61.3" r="0.8" fill="#fff"/>`;
  let eyes = `<g${moving ? ` class="pc-blink" style="--pc-b:${c.blink};--pc-bd:${c.blinkDelay}"` : ""}>${openEyes}</g>`;
  let front = "";
  let wrap = "";
  switch (c.wear) {
    case "headphones":
      front = `<path d="M23 58 C23 28 77 28 77 58" fill="none" stroke="${DARK}" stroke-width="3.6"/><rect x="16.5" y="52" width="9.5" height="15" rx="4.75" fill="${DARK}"/><rect x="74" y="52" width="9.5" height="15" rx="4.75" fill="${DARK}"/>`;
      wrap = "pc-groove";
      break;
    case "glasses":
      front = `<g fill="none" stroke="${DARK}" stroke-width="2.1"><circle cx="39.5" cy="59" r="8"/><circle cx="60.5" cy="59" r="8"/><path d="M47.5 58 H52.5"/></g><path${cls("pc-glint")} d="M34.5 55 L37.5 52" stroke="#fff" stroke-width="1.8" stroke-linecap="round"${moving ? "" : ' opacity="0"'}/>`;
      wrap = "pc-lean";
      break;
    case "flag":
      front = `<g${cls("pc-flag")}><path d="M78 76 V50" stroke="${DARK}" stroke-width="2.2" stroke-linecap="round"/><path d="M79 50 H90 L87 54 L90 58 H79 Z" fill="#E8613C"/></g>`;
      break;
    case "beanie":
      front = `<path d="M23 50 C23 28 77 28 77 50 Z" fill="#F25F7A"/><rect x="21" y="46" width="58" height="7.5" rx="3.75" fill="#FF8FA3"/>`;
      eyes = `<g${cls("pc-dream")}>${eyes}</g>`;
      break;
    case "sleepy": {
      // eyelids in the body colour slide down over the eyes, then it snaps awake
      const lid = moving
        ? `<clipPath id="${id}e"><ellipse cx="39.5" cy="59" rx="4.6" ry="5.6"/><ellipse cx="60.5" cy="59" rx="4.6" ry="5.6"/></clipPath><g clip-path="url(#${id}e)"><rect class="pc-lids" x="33" y="51" width="34" height="9" fill="${shade(c.body, 0.12)}"/></g>`
        : `<path d="M35 57 H44 M56 57 H65" stroke="${shade(c.body, 0.12)}" stroke-width="4"/>`;
      eyes = `<g>${openEyes}</g>${lid}`;
      break;
    }
    case "chart":
      front = `<g fill="#FFF4E0"><rect${cls("pc-bar")} x="43" y="73" width="3.6" height="7" rx="1.4"/><rect${cls("pc-bar pc-b2")} x="48.2" y="71" width="3.6" height="9" rx="1.4"/><rect${cls("pc-bar pc-b3")} x="53.4" y="74.5" width="3.6" height="5.5" rx="1.4"/></g>`;
      eyes = `<g${cls("pc-lookup")}>${eyes}</g>`;
      break;
    case "visor":
      eyes = "";
      front = `<rect x="25" y="51" width="50" height="16" rx="8" fill="#262a31"/><g${cls("pc-watch")}><rect x="34" y="56.5" width="9" height="5" rx="2.5" fill="#86e3f5"/><rect x="57" y="56.5" width="9" height="5" rx="2.5" fill="#86e3f5"/></g>`;
      break;
    case "spark":
      front = spark(50, 43, 5.2, "#FFE3C2", cls("pc-turn"));
      wrap = "pc-nod";
      break;
    case "cap":
      eyes = `<path d="M35 59 Q39.5 63 44 59 M56 59 Q60.5 63 65 59" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
      front = `<path d="M25 49 C25 30 75 30 75 49 Z" fill="${DARK}"/><path d="M60 47 H84 C84 51 79 52 73 52 H60 Z" fill="#2a2622"/>`;
      wrap = "pc-rock";
      break;
    case "band":
      front = `<rect x="21" y="43" width="58" height="7" rx="3.5" fill="#f6f2ea"/><g${cls("pc-flutter")}><path d="M77 45 L87 41 L85 49 Z" fill="#f6f2ea"/></g>`;
      wrap = "pc-hop";
      break;
  }
  const figure = `<ellipse cx="38" cy="85" rx="7" ry="3.6" fill="${foot}"/><ellipse cx="62" cy="85" rx="7" ry="3.6" fill="${foot}"/>
    <path d="M50 31 C71 31 82 45 82 61 C82 77 70 85 50 85 C30 85 18 77 18 61 C18 45 29 31 50 31 Z" fill="url(#${id}g)"/>
    <ellipse cx="31.5" cy="66" rx="4.6" ry="2.6" fill="${BLUSH}" opacity="0.6"/><ellipse cx="68.5" cy="66" rx="4.6" ry="2.6" fill="${BLUSH}" opacity="0.6"/>
    ${eyes}<path d="M47.5 67 Q50 69.4 52.5 67" stroke="${INK}" stroke-width="1.9" fill="none" stroke-linecap="round"/>${front}`;
  const alive = moving && wrap ? `<g class="${wrap}">${figure}</g>` : figure;
  // no backdrop: the companion stands on its own. Small ones are framed on the body, so the face fills them.
  const small = size <= 24;
  const view = small ? "18 26 64 64" : "10 18 80 80";
  // breathing scales the whole svg box (an element transform the compositor runs), from between its feet:
  // (50, 86) of the view box
  const breath = moving ? `;transform-origin:50% ${small ? "93.75%" : "85%"}` : "";
  // its own size (base.css sizes every svg as a 16px icon)
  return `<svg class="pc${moving ? " pc-breath" : ""}" width="${size}" height="${size}" style="width:${size}px;height:${size}px${breath}" viewBox="${view}" aria-hidden="true">
    <defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
    ${size > 24 ? `<ellipse cx="50" cy="89" rx="24" ry="3" fill="${INK}" opacity="0.12"/>` : ""}${alive}</svg>`;
}

/** One small, plain companion (no accessory) in the 100×100 box, for the "All profiles" huddle. */
function mini(color: string, id: string, cls: string): string {
  const eyes = `<ellipse cx="39.5" cy="59" rx="4.6" ry="5.6" fill="${INK}"/><ellipse cx="60.5" cy="59" rx="4.6" ry="5.6" fill="${INK}"/><circle cx="41.2" cy="56.8" r="1.9" fill="#fff"/><circle cx="62.2" cy="56.8" r="1.9" fill="#fff"/>`;
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(color, 0.2)}"/><stop offset="1" stop-color="${shade(color, -0.06)}"/></linearGradient></defs>
    <g${cls}><ellipse cx="38" cy="85" rx="7" ry="3.6" fill="${shade(color, -0.2)}"/><ellipse cx="62" cy="85" rx="7" ry="3.6" fill="${shade(color, -0.2)}"/>
    <path d="M50 31 C71 31 82 45 82 61 C82 77 70 85 50 85 C30 85 18 77 18 61 C18 45 29 31 50 31 Z" fill="url(#${id})"/>
    <ellipse cx="31.5" cy="66" rx="4.6" ry="2.6" fill="${BLUSH}" opacity="0.6"/><ellipse cx="68.5" cy="66" rx="4.6" ry="2.6" fill="${BLUSH}" opacity="0.6"/>
    ${eyes}<path d="M47.5 67 Q50 69.4 52.5 67" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/></g>`;
}

/** "All profiles": three companions huddled together, each bobbing on its own beat when `moving`. */
export function huddleSvg(size: number, moving: boolean): string {
  const id = `pc${++seq}`;
  const one = (x: number, y: number, s: number, color: string, beat: string) =>
    `<g transform="translate(${x} ${y}) scale(${s}) translate(-50 -58)">${mini(color, `${id}${beat}`, moving ? ` class="pc-huddle pc-${beat}"` : "")}</g>`;
  return `<svg class="pc" width="${size}" height="${size}" style="width:${size}px;height:${size}px" viewBox="8 16 84 84" aria-hidden="true">
    ${size > 24 ? `<ellipse cx="50" cy="88" rx="34" ry="3" fill="${INK}" opacity="0.12"/>` : ""}
    ${one(30, 46, 0.62, "#3F9BF5", "h1")}${one(70, 46, 0.62, "#B072F2", "h2")}${one(50, 60, 0.8, "#F2784B", "h3")}</svg>`;
}
