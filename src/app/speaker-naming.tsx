// "Name the speakers from the transcript": hands a request to a BB agent, which
// reads the transcript and renames speakers through the plugin's own tools. The
// owner chooses the model in BB's composer and can edit the request first.
import { AgentHandoff } from "./agent-handoff";
import { useMeetingsRpc } from "./rpc";

export function SpeakerNaming({ meetingId }: { meetingId: string }) {
  const rpc = useMeetingsRpc();
  return (
    <AgentHandoff
      label="Определить имена по расшифровке"
      explain="Агент прочитает расшифровку и назовёт тех, чьё имя из неё ясно: по обращениям и по тому, как люди представляются. Выберите модель посильнее и отправьте запрос. Расшифровка при этом уходит выбранной модели. Названные голоса запоминаются, поэтому проверьте результат и исправьте ошибки."
      started="Агент запущен. Имена появятся здесь, когда он закончит."
      prepare={async () => (await rpc.call("meetings.namingPrompt", { id: meetingId })).prompt}
    />
  );
}
