// Naming a local recording after the calendar event it belongs to (src/host/local-calendar.ts).
import { describe, expect, it } from "vitest";
import { parseCalendarEvents, pickCalendarEvent, type CalendarEvent } from "../src/host/local-calendar.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
function event(parts: Partial<CalendarEvent>): CalendarEvent {
  return { title: "Планёрка", start: NOW - 10 * MIN, end: NOW + 20 * MIN, allDay: false, declined: false, links: [], attendees: [], ...parts };
}

describe("pickCalendarEvent", () => {
  it("takes the event that is going on now", () => {
    expect(pickCalendarEvent([event({ title: "Планёрка" })], NOW, "zoom")?.title).toBe("Планёрка");
  });

  it("prefers the event whose link is for the app the call runs in", () => {
    const events = [
      event({ title: "Обед", start: NOW - 1 * MIN }),
      event({ title: "Созвон с заказчиком", start: NOW - 9 * MIN, links: ["acme.zoom.us/j/123"] }),
      event({ title: "Ретро", start: NOW - 2 * MIN, links: ["meet.google.com/abc-defg-hij"] }),
    ];
    expect(pickCalendarEvent(events, NOW, "zoom")?.title).toBe("Созвон с заказчиком");
    expect(pickCalendarEvent(events, NOW, "browser")?.title).toBe("Ретро");
  });

  it("without a matching link takes the event that started closest to now", () => {
    const events = [event({ title: "Давно идёт", start: NOW - 50 * MIN, end: NOW + 60 * MIN }), event({ title: "Только началась", start: NOW - 2 * MIN })];
    expect(pickCalendarEvent(events, NOW, "telegram")?.title).toBe("Только началась");
  });

  it("accepts a call joined up to 15 minutes early or 5 minutes after the event ended", () => {
    expect(pickCalendarEvent([event({ start: NOW + 15 * MIN, end: NOW + 45 * MIN })], NOW, "zoom")?.title).toBe("Планёрка");
    expect(pickCalendarEvent([event({ start: NOW + 16 * MIN, end: NOW + 45 * MIN })], NOW, "zoom")).toBeNull();
    expect(pickCalendarEvent([event({ start: NOW - 60 * MIN, end: NOW - 5 * MIN })], NOW, "zoom")?.title).toBe("Планёрка");
    expect(pickCalendarEvent([event({ start: NOW - 60 * MIN, end: NOW - 6 * MIN })], NOW, "zoom")).toBeNull();
  });

  it("ignores all-day events, declined events and events without a title", () => {
    const events = [event({ title: "Отпуск", allDay: true }), event({ title: "Не пойду", declined: true }), event({ title: "   " })];
    expect(pickCalendarEvent(events, NOW, "zoom")).toBeNull();
  });
});

describe("parseCalendarEvents", () => {
  it("reads the helper's answer and drops malformed rows", () => {
    const stdout = JSON.stringify({
      access: "granted",
      events: [
        { title: "Планёрка", start: 1, end: 2, allDay: false, declined: false, links: ["acme.zoom.us/j/1"], attendees: ["Анна"] },
        { title: 5, start: 1, end: 2 },
        "x",
      ],
    });
    expect(parseCalendarEvents(stdout)).toEqual({
      access: "granted",
      events: [{ title: "Планёрка", start: 1, end: 2, allDay: false, declined: false, links: ["acme.zoom.us/j/1"], attendees: ["Анна"] }],
    });
  });

  it("reports a refusal and unreadable output", () => {
    expect(parseCalendarEvents(JSON.stringify({ access: "denied", events: [] }))).toEqual({ access: "denied", events: [] });
    expect(parseCalendarEvents("usage: capture")).toEqual({ access: "error", events: [] });
  });
});
