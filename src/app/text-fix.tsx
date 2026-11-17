// "Fix the text with a model": hands the transcript to a BB agent that corrects
// recognition errors (terms, names) through meetings_fix_text. The recognised
// text is kept; "Вернуть исходный текст" puts it back.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentHandoff } from "./agent-handoff";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import { ErrorText } from "./ui";

export function TextFix({ meetingId, revision }: { meetingId: string; /** Changes when the transcript's segments do. */ revision: number }) {
  const rpc = useMeetingsRpc();
  const [corrected, setCorrected] = useState(0);
  useEffect(() => {
    let current = true;
    rpc
      .call("meetings.textFixPrompt", { id: meetingId })
      .then((result) => {
        if (current) setCorrected(result.corrected);
      })
      .catch(() => {
        // Not final yet: nothing to fix or to put back.
        if (current) setCorrected(0);
      });
    return () => {
      current = false;
    };
  }, [rpc, meetingId, revision]);
  const revert = useAsyncAction(async () => {
    await rpc.call("meetings.revertTextFixes", { id: meetingId });
    setCorrected(0);
  });
  return (
    <div>
      <AgentHandoff
        label="Исправить текст моделью"
        explain="Агент прочитает расшифровку и исправит ошибки распознавания: английские термины, записанные русскими буквами, имена и явные ослышки. Он не перефразирует речь. Выберите модель посильнее и отправьте запрос. Расшифровка при этом уходит выбранной модели. Исходный текст сохраняется, его можно вернуть."
        started="Агент запущен. Исправления появятся в расшифровке, когда он закончит."
        prepare={async () => (await rpc.call("meetings.textFixPrompt", { id: meetingId })).prompt}
      >
        {corrected > 0 ? (
          <>
            <span className="text-xs text-muted-foreground">Исправлено реплик: {corrected}</span>
            <Button size="sm" variant="ghost" disabled={revert.pending} onClick={() => void revert.run()}>
              Вернуть исходный текст
            </Button>
          </>
        ) : null}
      </AgentHandoff>
      <ErrorText className="text-xs">{revert.error}</ErrorText>
    </div>
  );
}
