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
