// Hands a prepared request to a BB agent: the owner sees the request in BB's own
// composer, picks the model, may edit the text, and sends it. Used for naming
// speakers and for fixing the transcript's text.
import { useState, type ComponentProps, type ReactNode } from "react";
import { experimental_NewThreadComposer as NewThreadComposer, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { useAsyncAction } from "./hooks";
import { ErrorText, Spinner } from "./ui";

type NewThreadRequest = Parameters<ComponentProps<typeof NewThreadComposer>["onSubmit"]>[0];

export function AgentHandoff({
  label,
  explain,
  started,
  prepare,
  children,
}: {
  /** The button that opens the request. */
  label: string;
  /** What the agent will do and what leaves the machine. */
  explain: string;
  /** Shown once the agent's thread exists. */
  started: string;
  /** Builds the request text. */
  prepare: () => Promise<string>;
  /** Extra controls next to the button. */
  children?: ReactNode;
}) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const open = useAsyncAction(async () => {
    setThreadId(null);
    setPrompt(await prepare());
  });
  const send = useAsyncAction(async (request: NewThreadRequest) => {
    const thread = await sdk.threads.spawn(request);
    setThreadId(thread.id);
    setPrompt(null);
  });
  return (
    <div className="mt-3 space-y-2">
      {prompt === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={open.pending} onClick={() => void open.run()}>
            {open.pending ? <Spinner /> : null}
            {label}
          </Button>
          {children}
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{explain}</p>
          <NewThreadComposer key={prompt} initialPrompt={prompt} layout="contained" onSubmit={request => send.run(request)} />
          <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>Отмена</Button>
        </div>
      )}
      {threadId !== null ? (
        <p role="status" className="text-xs text-muted-foreground">
          {started}{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.toThread(threadId)}>
            Открыть его поток
          </button>
        </p>
      ) : null}
      <ErrorText className="text-xs">{open.error ?? send.error}</ErrorText>
    </div>
  );
}
