// Roster keys of calendar invitees (src/server/roster.ts).
import { describe, expect, it } from "vitest";
import { rosterKey, rosterKeys } from "../src/server/roster.js";

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
