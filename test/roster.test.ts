// Roster keys of calendar invitees (src/server/roster.ts).
import { describe, expect, it } from "vitest";
import { calendarHints, rosterKey, rosterKeys, titleIsSkipped } from "../src/server/roster.js";

describe("rosterKey", () => {
  it("is the address when the invitee has one, lower-cased", () => {
    expect(rosterKey("Анна Смирнова <A.Smirnova@Example.io>")).toBe("a.smirnova@example.io");
    expect(rosterKey("L.Doroshenkov@example.io")).toBe("l.doroshenkov@example.io");
  });

  it("is the lower-cased name when there is no address", () => {
    expect(rosterKey("  Борис Орлов ")).toBe("борис орлов");
  });
});

describe("rosterKeys", () => {
  it("keeps one key per person, in order, and drops empty entries", () => {
    expect(rosterKeys(["Анна <a@x.io>", "a@x.io", " ", "Борис"])).toEqual(["a@x.io", "борис"]);
  });
});

describe("calendarHints", () => {
  it("gives the recogniser the meeting's title and the invitees' names, never their addresses", () => {
    expect(calendarHints("Matcher Analyzer", ["Анна Смирнова <a.smirnova@x.io>", "b.orlov@x.io", "Анна Смирнова <a.smirnova@x.io>", "Пётр\nИванов"])).toEqual([
      "Matcher Analyzer",
      "Анна Смирнова",
      "Пётр Иванов",
    ]);
    expect(calendarHints("", [])).toEqual([]);
  });
});

describe("titleIsSkipped", () => {
  it("matches a rule anywhere in the title, whatever the case, and ignores empty lines", () => {
    const rules = "1:1\n\n  Личное  \n";
    expect(titleIsSkipped("Иван / Анна 1:1", rules)).toBe(true);
    expect(titleIsSkipped("ЛИЧНОЕ: врач", rules)).toBe(true);
    expect(titleIsSkipped("Daily Business Engineering", rules)).toBe(false);
    expect(titleIsSkipped("Daily", "")).toBe(false);
  });
});
