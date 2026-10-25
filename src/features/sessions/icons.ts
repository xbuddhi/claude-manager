// Icons only the sessions view uses (same style as core/icons.ts: 16x16 strokes in currentColor).

import { fragment, raw } from "../../core/dom";

const svg = (body: string) => raw(`<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`);

const CHAT = svg(`<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>`);
const PLAY = svg(`<path d="M5 3.2v9.6L12.5 8z"/>`);

/** A session row's icon (a speech bubble). */
export const chatIcon = (): Element => fragment(CHAT);
/** Resume. */
export const playIcon = (): Element => fragment(PLAY);
