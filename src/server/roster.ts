// A meeting's roster: who the calendar invited, as keys that are the same from
// one meeting to the next. Voice recognition uses it as a hint, never as proof:
// invitees skip meetings and others join.

/** "Анна Смирнова <A.Smirnova@x.io>" -> "a.smirnova@x.io"; a bare name -> the name, lower-cased. */
export function rosterKey(attendee: string): string {
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(attendee);
  return (bracketed?.[1] ?? attendee).trim().toLowerCase();
}

/** The roster of a list of invitees: distinct keys, in order, at most 100. */
export function rosterKeys(attendees: readonly string[]): string[] {
  const keys: string[] = [];
  for (const attendee of attendees) {
    const key = rosterKey(attendee);
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys.slice(0, 100);
}

/** The invitee's name without the address; "" when the calendar only has an address. */
function inviteeName(attendee: string): string {
  const match = /^(.*?)<[^<>]*>\s*$/su.exec(attendee);
  const name = (match ? match[1]! : attendee).replace(/\s+/gu, " ").trim();
  return name.includes("@") ? "" : name.slice(0, 80);
}

/**
 * What the calendar knows that helps recognise speech: the meeting's title and
 * the invitees' names, as words the recogniser should expect. At most 40.
 */
export function calendarHints(title: string, attendees: readonly string[]): string[] {
  const hints: string[] = [];
  for (const hint of [title.replace(/\s+/gu, " ").trim().slice(0, 200), ...attendees.map(inviteeName)]) {
    if (hint !== "" && !hints.includes(hint)) hints.push(hint);
  }
  return hints.slice(0, 40);
}

/** The owner's "do not record" rules, one per line: a title containing any of them is skipped. */
export function titleIsSkipped(title: string, rules: string): boolean {
  const lower = title.toLowerCase();
  return rules
    .split("\n")
    .map((rule) => rule.trim().toLowerCase())
    .some((rule) => rule !== "" && lower.includes(rule));
}
