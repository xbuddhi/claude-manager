// The app's icon set: inline 16x16 stroke SVGs (no icon font, so they look the same on both OSes).
// They take currentColor; size them with CSS on the svg element.

import { raw, type SafeHtml } from "./dom";

const svg = (body: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;

export const icons = {
  folder: svg(`<path d="M1.5 3.5h4.2l1.5 1.5h7.3v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>`),
  star: svg(`<path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z"/>`),
  warning: svg(`<path d="M8 2.2l6.2 11H1.8zM8 6.5v3"/><circle cx="8" cy="11.4" r=".35"/>`),
  group: svg(`<path d="M1.5 4.5h4l1.2 1.2h7.8v6.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM3.5 2.5h3.2l1 1"/>`),
  chevron: svg(`<path d="M6 4l4 4-4 4"/>`),
  chevronDown: svg(`<path d="M4 6l4 4 4-4"/>`),
  chevronLeft: svg(`<path d="M10 4L6 8l4 4"/>`),
  plus: svg(`<path d="M8 3v10M3 8h10"/>`),
  close: svg(`<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`),
  minus: svg(`<path d="M3.5 8h9"/>`),
  home: svg(`<path d="M2.5 7.5L8 3l5.5 4.5V13h-3.5V9.5h-4V13H2.5z"/>`),
  terminal: svg(`<path d="M2 3.5h12v9H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5"/>`),
  branch: svg(`<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/>
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5"/>`),
  fetch: svg(`<path d="M8 2.5v8M5 7.5l3 3 3-3M3 13.5h10"/>`),
  pull: svg(`<path d="M8 2.5v9M4.5 8l3.5 3.5L11.5 8"/>`),
  push: svg(`<path d="M8 13.5v-9M4.5 8L8 4.5 11.5 8"/>`),
  refresh: svg(`<path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3"/>`),
  check: svg(`<path d="M3.5 8.5l3 3 6-7"/>`),
  trash: svg(`<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5"/>`),
  vscode: svg(`<path d="M11.5 1.8l2.5 1.2v10l-2.5 1.2-7-6.2-2.5 2V6l2.5 2z M11.5 4.8v6.4L7.4 8z"/>`),
  popout: svg(`<path d="M9 2.5h4.5V7M13.5 2.5L8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>`),
  search: svg(`<circle cx="7" cy="7" r="4.5"/><path d="M10.3 10.3l3.2 3.2"/>`),
  more: svg(`<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>`),
  info: svg(`<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".35"/>`),
} as const;

export type IconName = keyof typeof icons;

/** Icon markup for html`` templates. */
export function icon(name: IconName): SafeHtml {
  return raw(icons[name]);
}
