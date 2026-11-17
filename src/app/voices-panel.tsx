// Remembered voices on the recording settings tab: who the plugin recognizes
// by voice, and a way to forget each of them.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import { ErrorText } from "./ui";

interface Voice {
  name: string;
  seconds: number;
  meetings: number;
}

/** "встреча", "встречи", "встреч" for a count. */
function meetingsWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "встреч";
  if (last === 1) return "встреча";
  return last >= 2 && last <= 4 ? "встречи" : "встреч";
}

export function describeVoice(voice: Voice): string {
  const speech = voice.seconds >= 60 ? `${Math.round(voice.seconds / 60)} мин речи` : `${Math.round(voice.seconds)} с речи`;
  return `${speech}, ${voice.meetings} ${meetingsWord(voice.meetings)}`;
}

export function VoicesPanel() {
  const rpc = useMeetingsRpc();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const load = useAsyncAction(async () => setVoices((await rpc.call("voices.list", {})).voices));
  const forget = useAsyncAction(async (name: string) => setVoices((await rpc.call("voices.forget", { name })).voices));
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Чтобы плагин запомнил голос, дайте говорящему имя на странице встречи. В следующих встречах этот человек будет подписан сам. Голоса хранятся только на машине записи.
      </p>
      {voices !== null && voices.length === 0 ? <p className="text-xs text-muted-foreground">Пока ни одного голоса не запомнено.</p> : null}
      {voices !== null && voices.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {voices.map(voice => (
            <li key={voice.name} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{voice.name}</p>
                <p className="text-xs text-muted-foreground">{describeVoice(voice)}</p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Забыть голос: ${voice.name}`} disabled={forget.pending} onClick={() => void forget.run(voice.name)}>
                Забыть
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorText className="text-xs">{load.error ?? forget.error}</ErrorText>
    </div>
  );
}
