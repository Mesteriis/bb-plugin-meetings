// The request that asks an agent to name a meeting's speakers from what was said (src/server/speaker-naming.ts).
import { describe, expect, it } from "vitest";
import { buildNamingPrompt } from "../src/server/speaker-naming.js";

const base = {
  meetingId: "mtg_naming000001",
  title: "Планёрка",
  ownerName: "Я",
  speakers: [
    { key: "spk:1", label: "Спикер 1", talkSec: 371, share: 0.5 },
    { key: "voice:Анна", label: "Анна", talkSec: 98, share: 0.13 },
    { key: "spk:4", label: "Спикер 4", talkSec: 179, share: 0.24 },
  ],
  attendees: ["Анна Смирнова", "Борис Орлов"],
};

describe("buildNamingPrompt", () => {
  it("names the meeting, the tools to use and the speakers that still have no name", () => {
    const prompt = buildNamingPrompt(base);
    expect(prompt).toContain("mtg_naming000001");
    expect(prompt).toContain("«Планёрка»");
    expect(prompt).toContain("meetings_transcript");
    expect(prompt).toContain("meetings_rename_speaker");
    expect(prompt).toContain("- spk:1 — «Спикер 1», 6 мин 11 с, 50 % речи");
    expect(prompt).toContain("- spk:4 — «Спикер 4», 2 мин 59 с, 24 % речи");
  });

  it("lists speakers that already have a name separately, as not to be renamed", () => {
    const prompt = buildNamingPrompt(base);
    expect(prompt).toContain("Уже названы, не переименовывай: «Анна» (voice:Анна).");
    expect(prompt).not.toContain("- voice:Анна");
  });

  it("offers the calendar's invitees as candidates and says the list may be incomplete", () => {
    expect(buildNamingPrompt(base)).toContain("Приглашённые по календарю (кто-то мог не прийти, мог прийти кто-то ещё): Анна Смирнова, Борис Орлов.");
    expect(buildNamingPrompt({ ...base, attendees: [] })).not.toContain("Приглашённые по календарю");
  });

  it("tells the agent to name only on evidence and to leave the rest", () => {
    const prompt = buildNamingPrompt(base);
    expect(prompt).toContain("Не угадывай");
    expect(prompt).toContain("оставь как есть");
  });

  it("says there is nobody to name when every speaker has a name", () => {
    const prompt = buildNamingPrompt({ ...base, speakers: [base.speakers[1]!] });
    expect(prompt).toContain("Без имени никого не осталось");
  });
});
