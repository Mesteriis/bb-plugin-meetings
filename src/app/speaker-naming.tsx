// "Name the speakers from the transcript": hands a request to a BB agent, which
// reads the transcript and renames speakers through the plugin's own tools. The
// owner chooses the model in BB's composer and can edit the request first.
import { useState, type ComponentProps } from "react";
import { experimental_NewThreadComposer as NewThreadComposer, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import { ErrorText, Spinner } from "./ui";

type NewThreadRequest = Parameters<ComponentProps<typeof NewThreadComposer>["onSubmit"]>[0];

export function SpeakerNaming({ meetingId }: { meetingId: string }) {
  const rpc = useMeetingsRpc();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const prepare = useAsyncAction(async () => {
    setThreadId(null);
    setPrompt((await rpc.call("meetings.namingPrompt", { id: meetingId })).prompt);
  });
  const send = useAsyncAction(async (request: NewThreadRequest) => {
    const thread = await sdk.threads.spawn(request);
    setThreadId(thread.id);
    setPrompt(null);
  });
  return (
    <div className="mt-3 space-y-2">
      {prompt === null ? (
        <Button size="sm" variant="outline" disabled={prepare.pending} onClick={() => void prepare.run()}>
          {prepare.pending ? <Spinner /> : null}
          Определить имена по расшифровке
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Агент прочитает расшифровку и назовёт тех, чьё имя из неё ясно: по обращениям и по тому, как люди представляются. Выберите модель посильнее и отправьте запрос. Расшифровка при этом уходит выбранной модели. Названные голоса запоминаются, поэтому проверьте результат и исправьте ошибки.
          </p>
          <NewThreadComposer key={prompt} initialPrompt={prompt} layout="contained" onSubmit={request => send.run(request)} />
          <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>Отмена</Button>
        </div>
      )}
      {threadId !== null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Агент запущен. Имена появятся здесь, когда он закончит.{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.toThread(threadId)}>
            Открыть его поток
          </button>
        </p>
      ) : null}
      <ErrorText className="text-xs">{prepare.error ?? send.error}</ErrorText>
    </div>
  );
}
