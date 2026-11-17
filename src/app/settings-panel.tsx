import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BotCard } from "./bot-card";
import { ProviderAccountCards } from "./accounts-panel";
import { fieldClass, Field, Toggle } from "./feature-controls";
import { useAsyncAction } from "./hooks";
import { IntegrationsPanel } from "./integrations-panel";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { TemplatesPanel } from "./templates-panel";
import { ErrorText, Notice, Spinner } from "./ui";
import { VoicesPanel } from "./voices-panel";
import { ZoomAccountCard } from "./zoom-card";

export type SettingsValues = Record<string, string | number | boolean | null | undefined>;
const TABS = [["recording", "Запись"], ["bot", "Бот"], ["analysis", "ИИ-разбор"], ["templates", "Шаблоны"], ["accounts", "Аккаунты"], ["integrations", "Интеграции"]] as const;
type Tab = typeof TABS[number][0];

export function SettingsPanel({ nav }: { nav: MeetingsNav }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-5 rounded-lg border border-border bg-card" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer px-4 py-3 text-sm font-medium">Настройки бота, разбора и интеграций</summary>{open ? <SettingsContent nav={nav} /> : null}</details>;
}

function SettingsContent({ nav }: { nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const [tab, setTab] = useState<Tab>("recording");
  const [settings, setSettings] = useState<SettingsValues | null>(null);
  const [patch, setPatch] = useState<SettingsValues>({});
  const [saved, setSaved] = useState(false);
  const [microphones, setMicrophones] = useState<readonly string[]>([]);
  // null until the recording machine answered: the accounts tab waits for it.
  const [hostPlatform, setHostPlatform] = useState<string | null>(null);
  const load = useAsyncAction(async () => {
    setSettings((await rpc.call("notetaker.settings", {})).settings as SettingsValues);
    // The device list is a convenience: without it the saved name is still shown and kept.
    const env = (await rpc.call("env.status").catch(() => null))?.env ?? null;
    setMicrophones(env?.inputDevices ?? []);
    setHostPlatform(env?.platform ?? "unknown");
  });
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [refresh]);
  const update = (key: string, value: string | number | boolean) => { setPatch(previous => ({ ...previous, [key]: value })); setSaved(false); };
  const value = (key: string) => patch[key] ?? settings?.[key];
  const savePatch = async (next: SettingsValues) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([key, value]) => !(["aiApiKey", "webhookSecret", "calendarIcsUrls"].includes(key) && value === "")));
    setSettings((await rpc.call("notetaker.settings", { patch: clean })).settings as SettingsValues);
    setPatch(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !(key in next))));
    setSaved(true);
  };
  const save = useAsyncAction(async () => savePatch(patch));
  const boolean = (key: string, label: string) => <Toggle key={key} label={label} checked={value(key) === true} onChange={checked => update(key, checked)} />;
  const number = (key: string, label: string, min: number, max: number, step = 1) => <Field key={key} label={label}><input className={fieldClass} type="number" min={min} max={max} step={step} value={Number(value(key) ?? min)} onChange={event => update(key, event.target.valueAsNumber)} /></Field>;
  const text = (key: string, label: string, hint?: string, secret = false) => <Field key={key} label={label} hint={hint}><input className={fieldClass} type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} value={String(secret ? patch[key] ?? "" : value(key) ?? "")} onChange={event => update(key, event.target.value)} placeholder={secret ? "Оставьте пустым, чтобы сохранить ключ" : undefined} /></Field>;
  const localAppOptions = [["zoom", "Zoom"], ["teams", "Microsoft Teams"], ["telegram", "Telegram"], ["facetime", "FaceTime"], ["browser", "Браузер"]] as const;
  const enabledLocalApps = (() => {
    try {
      const parsed: unknown = JSON.parse(String(value("localApps") ?? ""));
      return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : null;
    } catch {
      return null;
    }
  })();
  const isLocalAppEnabled = (appKey: string) => enabledLocalApps === null || enabledLocalApps.has(appKey);
  const toggleLocalApp = (appKey: string) => {
    const all = localAppOptions.map(([key]) => key);
    const current = enabledLocalApps === null ? new Set(all) : new Set(enabledLocalApps);
    if (current.has(appKey)) current.delete(appKey);
    else current.add(appKey);
    const enabled = all.filter((key) => current.has(key));
    update("localApps", enabled.length === all.length ? "" : JSON.stringify(enabled));
  };
  return <div className="min-w-0 border-t border-border p-3">
    <div role="tablist" aria-label="Настройки встреч" className="mb-4 flex flex-wrap gap-1">{TABS.map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} key={id} className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${tab === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`} onClick={() => setTab(id)}>{label}</button>)}</div>
    <ErrorText>{load.error}</ErrorText>
    {settings === null && load.error === null ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />Загружаем настройки…</p> : null}
    <div role="tabpanel" className="min-w-0 space-y-4">
      {tab === "recording" && settings ? <>
        <div className="grid gap-3 sm:grid-cols-2">{number("maxDurationMinutes", "Максимальная запись, мин", 5, 1440)}{number("maxConcurrentBots", "Одновременно ботов", 1, 8)}{number("waitingTimeoutMinutes", "Ожидание впуска, мин", 1, 240)}{number("aloneTimeoutMinutes", "Выйти, если остался один, мин", 0.5, 60, 0.5)}{number("silenceTimeoutMinutes", "Выйти при тишине, мин (0 — никогда)", 0, 240)}{number("screenshotIntervalSec", "Скриншоты, секунд (0 — по событиям)", 0, 300)}</div>
        <div className="grid gap-2 sm:grid-cols-2">{boolean("autoTranscribe", "Расшифровывать автоматически")}{boolean("liveTranscription", "Расшифровывать во время встречи")}{boolean("keepRawAudio", "Сохранять несжатый звук")}{boolean("notifyThread", "Сообщать агенту о завершении")}</div>
        {text("chatAnnouncement", "Сообщение в чат после подключения", "Пусто — не отправлять сообщение")}
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Разделение по спикерам"><select className={fieldClass} value={String(value("diarization") ?? "ui+acoustic")} onChange={event => update("diarization", event.target.value)}><option value="ui+acoustic">Интерфейс и голоса</option><option value="ui">Интерфейс встречи</option><option value="acoustic">По голосам</option></select></Field>{number("speakerLagMs", "Задержка индикатора спикера, мс", 0, 5000)}{text("gigaamUrl", "Сервер распознавания", "Пусто — GigaAM этого BB")}{text("chromePath", "Путь к Chrome", "Пусто — определить автоматически")}</div>
        <details><summary className="cursor-pointer text-xs text-muted-foreground">Календарь и расширенные настройки</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{boolean("calendarAutoJoin", "Автоматически входить по календарю")}{number("calendarLeadMinutes", "Входить заранее, мин", 0, 30)}{number("calendarOvertimeMinutes", "Задержаться после события, мин", 0, 600)}{number("calendarSyncMinutes", "Синхронизация календаря, мин", 1, 120)}{text("calendarFilter", "Фильтр событий")}{text("calendarIcsUrls", "Ссылки ICS", "Новые секретные ссылки через пробел; пусто сохраняет текущие", true)}{text("speakerSelectors", "Селекторы спикеров (JSON)")}</div></details>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Голоса говорящих</summary>
          <div className="mt-3 space-y-3">
            {boolean("voiceRecognition", "Узнавать говорящих по голосу")}
            <VoicesPanel />
          </div>
        </details>
        <details open={value("localRecordingEnabled") === true}>
          <summary className="cursor-pointer text-xs text-muted-foreground">Локальная запись (macOS, без бота)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {boolean("localRecordingEnabled", "Включить локальную запись")}
            {boolean("localAutoRecord", "Начинать запись автоматически")}
            {boolean("localCalendarTitles", "Название встречи из календаря macOS")}
            {number("localStartThresholdSec", "Порог начала, с", 1, 300)}
            {number("localGraceSec", "Остановить после тишины, с", 5, 3600)}
            <Field label="Микрофон" hint="С него записывается ваш голос. Звук собеседников берётся прямо из приложения встречи и от микрофона и наушников не зависит.">
              <select className={fieldClass} aria-label="Микрофон" value={String(value("localMicrophone") ?? "")} onChange={event => update("localMicrophone", event.target.value)}>
                <option value="">Тот же, что у приложения встречи</option>
                {[...new Set([...microphones, String(value("localMicrophone") ?? "")])].filter(name => name !== "").map(name => (
                  <option key={name} value={name}>{microphones.includes(name) ? name : `${name} (не подключён)`}</option>
                ))}
              </select>
            </Field>
            {text("localOwnerName", "Имя владельца в записи")}
            {text("localLanguage", "Язык распознавания")}
            {text("localGlossary", "Глоссарий терминов", "Одно на строку")}
          </div>
          <div className="mt-3">
            <Field label="Распознавание локальной записи">
              <select className={fieldClass} value={String(value("localEngine") ?? "whisper")} onChange={event => update("localEngine", event.target.value)}>
                <option value="whisper">Whisper (локально)</option>
                <option value="gigaam">GigaAM (сервер)</option>
              </select>
            </Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Модель для итоговой расшифровки" hint="Точная large-v3 лучше на смеси русского с английским, но занимает ещё около 3 ГБ и работает медленнее. После выбора запустите установку.">
              <select className={fieldClass} aria-label="Модель для итоговой расшифровки" value={String(value("localFinalModel") ?? "turbo")} onChange={event => update("localFinalModel", event.target.value)}>
                <option value="turbo">Быстрая (large-v3-turbo)</option>
                <option value="large-v3">Точная (large-v3)</option>
              </select>
            </Field>
            {number("audioRetentionDays", "Удалять аудио через, дней (0 — хранить)", 0, 3650)}
            {text("localSkipTitles", "Не записывать встречи с названием", "Одно правило на строку, например: личное")}
          </div>
          <div className="mt-3">
            <Field label="Приложения для записи" hint="Пусто — все поддерживаемые">
              <div className="grid gap-2 sm:grid-cols-2">
                {localAppOptions.map(([appKey, appLabel]) => (
                  <label key={appKey} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" className="accent-foreground" checked={isLocalAppEnabled(appKey)} onChange={() => toggleLocalApp(appKey)} />
                    {appLabel}
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Без бота: плагин замечает, что приложение на этом Mac (Zoom, Teams, Telegram, FaceTime или браузер) использует микрофон, и записывает звук локально. Требует macOS 14.4+ на Apple silicon.</p>
        </details>
      </> : null}
      {tab === "bot" ? <BotCard /> : null}
      {tab === "analysis" && settings ? <>
        {boolean("autoSummarize", "Автоматически разбирать готовые расшифровки")}
        <Field label="Как выполнять разбор"><select className={fieldClass} value={String(value("summaryMode") ?? "agent")} onChange={event => update("summaryMode", event.target.value)}><option value="agent">Агент BB</option><option value="api">Настроенный API</option></select></Field>
        <p className="text-xs leading-relaxed text-muted-foreground">{value("summaryMode") === "api" ? "Разбор и ответы выполняются через ваш API. Текст расшифровки передаётся выбранному провайдеру." : "Запрос на разбор получит агент в треде, который запустил встречу. Для записей из интерфейса запрос можно скопировать из карточки встречи."}</p>
        {value("summaryMode") === "api" ? <div className="grid gap-3 sm:grid-cols-2">{text("aiBaseUrl", "Адрес API", "Например https://api.example.com/v1")}{text("aiModel", "Модель")}{text("aiApiKey", "Ключ API", value("aiApiKeyConfigured") ? "Ключ уже сохранён" : "Ключ ещё не задан", true)}</div> : null}
        <Field label="Запрос агенту после встречи"><textarea rows={4} className={`${fieldClass} resize-y text-xs`} value={String(value("autoSummaryPrompt") ?? "")} onChange={event => update("autoSummaryPrompt", event.target.value)} /></Field>
      </> : null}
      {tab === "templates" && settings ? <TemplatesPanel defaultId={String(value("summaryTemplateId") ?? "executive")} onDefault={async id => savePatch({ summaryTemplateId: id })} /> : null}
      {tab === "accounts" && hostPlatform === "darwin" ? (
        <Notice tone="info" title="На этом Mac вход не нужен">
          <p>Аккаунты Zoom, Google Meet и Телемоста нужны только боту: он подключается к встрече через собственный Google Chrome и работает только на Linux.</p>
          <p>Здесь встречи записываются локально. Вы участвуете в звонке сами, в приложении или в своём браузере (Dia, Arc, Chrome, Яндекс Браузер, Firefox или Edge), под своим аккаунтом, а плагин записывает звук с этого Mac.</p>
        </Notice>
      ) : null}
      {tab === "accounts" && hostPlatform !== null && hostPlatform !== "darwin" ? <><ZoomAccountCard nav={nav} /><ProviderAccountCards nav={nav} /></> : null}
      {tab === "integrations" ? <><IntegrationsPanel /><div className="grid gap-3 sm:grid-cols-2">{text("webhookUrl", "Webhook завершения встречи")}{text("webhookSecret", "Секрет подписи", value("webhookSecretConfigured") ? "Секрет уже сохранён" : "Секрет не задан", true)}</div><p className="text-xs text-muted-foreground">Webhook отправляется после завершения расшифровки. Настройки агента и MCP доступны выше.</p></> : null}
    </div>
    {settings && (tab === "recording" || tab === "analysis" || tab === "integrations") ? <div className="mt-4 flex flex-wrap items-center gap-2"><Button size="sm" disabled={save.pending || Object.keys(patch).length === 0} onClick={() => void save.run()}>{save.pending ? <Spinner /> : null}Сохранить настройки</Button>{saved ? <span role="status" className="text-xs text-muted-foreground">Сохранено</span> : null}<ErrorText>{save.error}</ErrorText></div> : null}
  </div>;
}
