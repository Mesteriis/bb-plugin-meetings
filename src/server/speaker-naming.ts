// The request for an agent that names a meeting's speakers from what was said
// (docs/dev/DESIGN.md §16): people address each other by name, introduce
// themselves, are asked about their work. The agent reads the transcript with
// the plugin's own tools and renames through them, so every name it sets goes
// the same way as a name typed by the owner, voice memory included.

export interface NamingSpeaker {
  readonly key: string;
  readonly label: string;
  readonly talkSec: number;
  /** Share of all speech, 0..1. */
  readonly share: number;
}

export interface NamingPromptInput {
  readonly meetingId: string;
  readonly title: string;
  /** How the owner is labelled when the microphone identified them. */
  readonly ownerName: string;
  readonly speakers: readonly NamingSpeaker[];
  /** Invitees of the calendar event the recording was named after; may be empty. */
  readonly attendees: readonly string[];
}

/** A speaker the transcriber could only number. */
function unnamed(speaker: NamingSpeaker): boolean {
  return speaker.key.startsWith("spk:") || speaker.key === "unknown";
}

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes} мин ${total % 60} с` : `${total} с`;
}

export function buildNamingPrompt(input: NamingPromptInput): string {
  const todo = input.speakers.filter(unnamed);
  const named = input.speakers.filter((speaker) => !unnamed(speaker));
  const lines = [
    `Определи, кто есть кто во встрече «${input.title}» (id: ${input.meetingId}), по тому, что в ней говорили.`,
    "",
    `Прочитай расшифровку целиком инструментом meetings_transcript (id: ${input.meetingId}; она отдаётся страницами, читай до конца).`,
    "",
  ];
  if (todo.length === 0) {
    lines.push("Без имени никого не осталось: все говорящие уже названы. Ничего не меняй и скажи об этом.");
  } else {
    lines.push("Говорящие без имени:", ...todo.map((s) => `- ${s.key} — «${s.label}», ${duration(s.talkSec)}, ${Math.round(s.share * 100)} % речи`));
  }
  if (named.length > 0) {
    lines.push("", `Уже названы, не переименовывай: ${named.map((s) => `«${s.label}» (${s.key})`).join(", ")}.`);
  }
  if (input.attendees.length > 0) {
    lines.push("", `Приглашённые по календарю (кто-то мог не прийти, мог прийти кто-то ещё): ${input.attendees.join(", ")}.`);
  }
  lines.push(
    "",
    `Владелец записи в расшифровке подписан «${input.ownerName}», когда его узнал микрофон.`,
    "",
    "Как определять:",
    "- обращения по имени: кто отвечает сразу после «Анна, что у тебя?», тот, скорее всего, Анна;",
    "- человек называет себя сам или говорит о своей работе так, что это однозначно указывает на него;",
    "- одно свидетельство может быть случайным: ищи второе, которое с ним согласуется.",
    "",
    "Не угадывай. Имя, поставленное этим запросом, запоминается вместе с голосом и будет подставляться в следующих встречах, поэтому ошибка размножится. Если свидетельств нет или они противоречат друг другу, оставь как есть.",
    "",
    `Каждого, в ком уверен, переименуй инструментом meetings_rename_speaker (id: ${input.meetingId}, speaker: ключ из списка, name: имя; если из календаря ясно полное имя, используй его).`,
    "",
    "В конце напиши: кого и как назвал и по каким репликам (время и короткая цитата), кого оставил без имени и почему.",
  );
  return lines.join("\n");
}
