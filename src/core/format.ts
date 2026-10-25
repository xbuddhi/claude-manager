// Text formatting shared by every feature. Pure functions; `now` is a parameter so tests can fix it.
// Wording and thresholds follow the Windows app (Projects.Ago, Usage.Fmt, Usage.Until, Plan.ResetText).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** "just now", "5m ago", "3h ago", "Yesterday", "4d ago", "Oct 3", "Oct 3, 2025"; "no sessions" without a time. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms || ms <= 0) return "no sessions";
  const diff = now - ms;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.round(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "Yesterday";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  const date = new Date(ms);
  return date.getFullYear() === new Date(now).getFullYear() ? monthDay.format(date) : monthDayYear.format(date);
}

/** Transcript size: "512 KB", "1.5 MB". */
export function size(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** Token counts: "950", "1.2K", "120K", "1.2M", "12M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return n >= 10_000_000 ? `${Math.round(n / 1_000_000)}M` : `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return n >= 100_000 ? `${Math.round(n / 1000)}K` : `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Time left until `target`: "less than a minute", "4m 05s", "2h 14m". */
export function until(target: number, now = Date.now()): string {
  const left = target - now;
  if (left < MINUTE) return "less than a minute";
  if (left >= HOUR) return `${Math.floor(left / HOUR)}h ${Math.floor((left % HOUR) / MINUTE)}m`;
  const seconds = Math.floor((left % MINUTE) / 1000);
  return `${Math.floor(left / MINUTE)}m ${String(seconds).padStart(2, "0")}s`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** When a usage limit resets: "Resets now", "Resets in 2h 14m  ·  3:00 PM", "Resets tomorrow 9:00 AM", "Resets Mon 9:00 AM". */
export function resetText(target: number | null | undefined, now = Date.now()): string {
  if (target === null || target === undefined) return "";
  const left = target - now;
  if (left < MINUTE) return "Resets now";
  const date = new Date(target);
  // calendar days in local time (a DST change makes a day 23 or 25 hours, so round)
  const days = Math.round((startOfDay(target) - startOfDay(now)) / DAY);
  // newer ICU puts a narrow no-break space before AM/PM; keep plain spaces like the Windows app
  const time = clock.format(date).replace(/[\u202f\u00a0]/g, " ");
  const when = days === 0 ? time : days === 1 ? `tomorrow ${time}` : `${weekday.format(date)} ${time}`;
  return left < DAY ? `Resets in ${until(target, now)}  ·  ${when}` : `Resets ${when}`;
}

/** Cuts text to `max` characters, ending in "…" when it was longer. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** "1 session", "3 sessions". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** Last part of a path, for both separators: "C:\\src\\app" and "/Users/me/app" give "app". */
export function leaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

/** Colour for a usage level in percent: accent below 70, orange from 70, red from 90 (Usage ring). */
export function levelColor(percent: number): string {
  if (percent >= 90) return "var(--danger)";
  if (percent >= 70) return "var(--warn)";
  return "var(--accent)";
}
