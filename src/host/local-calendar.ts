// The title of a local recording (docs/dev/DESIGN.md §15): the macOS system
// calendar event that is going on when the recording starts. The capture
// helper reads the calendar through EventKit (`capture events`); this module
// chooses the event.
import { run } from "./exec.js";
import { statOrNull } from "./fsutil.js";
import type { HostPaths } from "./paths.js";

export interface CalendarEvent {
  readonly title: string;
  /** Epoch ms. */
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  /** The owner declined the invitation. */
  readonly declined: boolean;
  /** Host and path of the links in the event's location, URL and notes. */
  readonly links: readonly string[];
  /** Names of the other invitees. */
  readonly attendees: readonly string[];
}

/** granted, denied by the owner, no answer to the prompt in time, or the helper failed. */
export type CalendarAccess = "granted" | "denied" | "timeout" | "error";

export interface CalendarAnswer {
  readonly access: CalendarAccess;
  readonly events: CalendarEvent[];
}

/** A call may be joined this long before its event starts… */
export const CALENDAR_EARLY_MS = 15 * 60_000;
/** …and may still be going this long after it ended. */
export const CALENDAR_LATE_MS = 5 * 60_000;

/** Link hosts that say an event is held in this meeting source. */
const LINK_HOSTS: Readonly<Record<string, readonly string[]>> = {
  zoom: ["zoom.us", "zoom.com"],
  teams: ["teams.microsoft.com", "teams.live.com"],
  browser: ["meet.google.com", "telemost.yandex.ru", "telemost.360.yandex.ru", "meet.jit.si", "teams.microsoft.com", "teams.live.com"],
};

function linkMatches(link: string, appKey: string): boolean {
  const host = link.split("/")[0]!.toLowerCase();
  return (LINK_HOSTS[appKey] ?? []).some((known) => host === known || host.endsWith(`.${known}`));
}

/**
 * The event a call in `appKey` at `now` belongs to, or null. Among the events
 * going on now, one whose link is for that app wins; otherwise the one that
 * started closest to now.
 */
export function pickCalendarEvent(events: readonly CalendarEvent[], now: number, appKey: string): CalendarEvent | null {
  const current = events.filter(
    (event) =>
      !event.allDay && !event.declined && event.title.trim() !== "" && event.start - CALENDAR_EARLY_MS <= now && now <= event.end + CALENDAR_LATE_MS,
  );
  const forApp = current.filter((event) => event.links.some((link) => linkMatches(link, appKey)));
  const pool = forApp.length > 0 ? forApp : current;
  let best: CalendarEvent | null = null;
  for (const event of pool) {
    if (best === null || Math.abs(event.start - now) < Math.abs(best.start - now)) best = event;
  }
  return best;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The answer of `capture events`; anything unreadable is access "error". */
export function parseCalendarEvents(stdout: string): CalendarAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { access: "error", events: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { access: "error", events: [] };
  const { access, events } = parsed as { access?: unknown; events?: unknown };
  if (access !== "granted" && access !== "denied" && access !== "timeout") return { access: "error", events: [] };
  const rows: CalendarEvent[] = [];
  for (const row of Array.isArray(events) ? events : []) {
    if (typeof row !== "object" || row === null) continue;
    const { title, start, end, allDay, declined, links, attendees } = row as Record<string, unknown>;
    if (typeof title !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    rows.push({ title, start, end, allDay: allDay === true, declined: declined === true, links: strings(links), attendees: strings(attendees) });
  }
  return { access, events: rows };
}

export interface CalendarLookup {
  readonly access: CalendarAccess;
  /** The chosen event's title, or null when no event fits. */
  readonly title: string | null;
  readonly attendees: string[];
}

/** Ask the system calendar which event a call in `appKey` at `now` belongs to. */
export async function lookupCalendarEvent(paths: HostPaths, appKey: string, now: number): Promise<CalendarLookup> {
  if ((await statOrNull(paths.capture)) === null) return { access: "error", title: null, attendees: [] };
  // The helper waits up to 20 s for the owner to answer the first access prompt.
  const result = await run(paths.capture, ["events", "--from", String(now - CALENDAR_LATE_MS), "--to", String(now + CALENDAR_EARLY_MS)], {
    timeoutMs: 30_000,
  }).catch(() => null);
  if (result === null || result.code !== 0) return { access: "error", title: null, attendees: [] };
  const answer = parseCalendarEvents(result.stdout);
  const event = pickCalendarEvent(answer.events, now, appKey);
  return { access: answer.access, title: event === null ? null : event.title.trim(), attendees: event === null ? [] : [...event.attendees] };
}
