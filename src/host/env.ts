// env.check: one report of everything the bot and transcriber need on this
// machine, with Russian labels for the Meetings page and, where env.setup
// cannot help, the command that fixes it.
import type { EnvItem, EnvReport } from "../shared/contract.js";
import { discoverGigaam } from "./gigaam.js";
import { checkModel } from "./models.js";
import type { HostPaths } from "./paths.js";
import {
  APT_PACKAGES,
  MIN_MACOS_MAJOR,
  MIN_MACOS_MINOR,
  MIN_NODE_MAJOR,
  MODELS,
  PLAYWRIGHT_CORE,
  PYTHON_VERSION,
  WHISPER_MODEL,
  chromeInstallCommand,
  isMacArm64,
  platformProblem,
  uvDownload,
} from "./platform.js";
import { probeMacVersion, probeRuntime, probeSudo, probeSwift, probeSystem, probeVenv, type BinaryProbe } from "./probes.js";
import { run } from "./exec.js";
import { listInputDevices } from "./local-recording.js";
import { errorMessage, statOrNull } from "./fsutil.js";
import { setupSummary } from "./setup-state.js";

/** env.check is called with a 30 s deadline: every probe has to answer well within it. */
const VENV_CHECK_TIMEOUT_MS = 20_000;

export interface EnvCheckInput {
  readonly chromePath: string;
  readonly gigaamUrl: string;
}

function item(fields: Omit<EnvItem, "fix"> & { fix?: string | null }): EnvItem {
  return { ...fields, fix: fields.ok ? null : (fields.fix ?? null) };
}

function aptFix(sudo: boolean, packages: readonly string[]): string | null {
  return sudo ? null : `sudo apt-get install -y ${[...new Set(packages)].join(" ")}`;
}

function located(probe: BinaryProbe, missing: string): string {
  return probe.path ?? missing;
}

async function uvVersion(paths: HostPaths): Promise<string | null> {
  if ((await statOrNull(paths.uv)) === null) return null;
  const result = await run(paths.uv, ["--version"], { timeoutMs: 10_000 }).catch(() => null);
  return /uv (\S+)/.exec(result?.stdout ?? "")?.[1] ?? null;
}

export interface EnvCheckOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export async function checkEnv(paths: HostPaths, input: EnvCheckInput, options: EnvCheckOptions = {}): Promise<EnvReport> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (isMacArm64(platform, arch)) return checkMacEnv(paths, input, platform, arch);
  const unsupported = platformProblem(platform, arch);
  const [sudo, system, runtime, venv, uv, gigaam, setup, ...models] = await Promise.all([
    probeSudo(),
    probeSystem(input.chromePath),
    probeRuntime(paths),
    probeVenv(paths, { timeoutMs: VENV_CHECK_TIMEOUT_MS }),
    uvVersion(paths),
    discoverGigaam(paths, input.gigaamUrl),
    setupSummary(paths),
    ...MODELS.map((spec) => checkModel(paths, spec).catch((error: unknown) => ({ ok: false, detail: errorMessage(error) }))),
  ]);
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const sudoHint = sudo ? null : "нет sudo без пароля — выполните команду вручную";

  const items: EnvItem[] = [
    item({
      id: "chrome",
      label: "Google Chrome",
      ok: system.chrome.path !== null && system.chrome.version !== null,
      required: true,
      version: system.chrome.version,
      detail: system.chrome.detail,
      fix: system.chrome.configured
        ? "Исправьте путь в настройке chromePath или очистите её для автопоиска"
        : sudo
          ? null
          : chromeInstallCommand(),
    }),
    item({
      id: "xvfb",
      label: "Виртуальный дисплей Xvfb",
      ok: system.xvfb.path !== null,
      required: true,
      version: system.xvfb.version,
      detail: located(system.xvfb, "Xvfb не найден"),
      fix: aptFix(sudo, [APT_PACKAGES.Xvfb]),
    }),
    item({
      id: "pulseaudio",
      label: "PulseAudio (захват звука)",
      ok: system.pulseaudio.path !== null && system.pactl.path !== null,
      required: true,
      version: system.pulseaudio.version,
      detail:
        system.pulseaudio.path === null
          ? "pulseaudio не найден"
          : system.pactl.path === null
            ? "pactl не найден (пакет pulseaudio-utils)"
            : `${system.pulseaudio.path}, ${system.pactl.path}`,
      fix: aptFix(sudo, [APT_PACKAGES.pulseaudio, APT_PACKAGES.pactl]),
    }),
    item({
      id: "ffmpeg",
      label: "ffmpeg с кодеком Opus",
      ok: system.ffmpeg.path !== null && system.ffmpeg.libopus && system.ffprobe.path !== null,
      required: true,
      version: system.ffmpeg.version,
      detail:
        system.ffmpeg.path === null
          ? "ffmpeg не найден"
          : !system.ffmpeg.libopus
            ? `${system.ffmpeg.path}: нет кодировщика libopus`
            : system.ffprobe.path === null
              ? "ffprobe не найден"
              : system.ffmpeg.path,
      fix: aptFix(sudo, [APT_PACKAGES.ffmpeg]),
    }),
    item({
      id: "xdotool",
      label: "xdotool (закрывает системные диалоги Chrome)",
      ok: system.xdotool.path !== null,
      required: false,
      version: system.xdotool.version,
      detail: located(system.xdotool, "Не найден: бот не сможет закрыть диалог «Open xdg-open?»"),
      fix: aptFix(sudo, [APT_PACKAGES.xdotool]),
    }),
    item({
      id: "node",
      label: `Node.js ${MIN_NODE_MAJOR}+ для бота`,
      ok: nodeMajor >= MIN_NODE_MAJOR,
      required: true,
      version: nodeVersion,
      detail: process.execPath,
      fix: `Обновите bb: бот запускается тем же Node.js, что и bb (нужен ${MIN_NODE_MAJOR}+)`,
    }),
    item({
      id: "runtime",
      label: "Файлы бота и транскрибатора",
      ok: runtime.ready,
      required: true,
      version: paths.runtimeHash,
      detail: runtime.ready ? paths.runtime : "Не установлены",
    }),
    item({
      id: "playwright",
      label: `playwright-core ${PLAYWRIGHT_CORE.version}`,
      ok: runtime.playwright === PLAYWRIGHT_CORE.version,
      required: true,
      version: runtime.playwright ?? runtime.sharedPlaywright,
      detail:
        runtime.playwright === PLAYWRIGHT_CORE.version
          ? "Установлен"
          : runtime.sharedPlaywright !== null
            ? "Скачан, но не подключён к текущей версии бота"
            : runtime.playwright !== null
              ? `Версия ${runtime.playwright} вместо ${PLAYWRIGHT_CORE.version}`
              : "Не установлен",
    }),
    item({
      id: "uv",
      label: "Менеджер пакетов uv",
      ok: uv !== null,
      required: true,
      version: uv,
      detail: uv !== null ? paths.uv : uvDownload() === null ? `Нет сборки uv для ${process.platform}-${process.arch}` : "Не установлен",
    }),
    item({
      id: "venv",
      label: `Python ${PYTHON_VERSION} для транскрибатора`,
      ok: venv.python !== null,
      required: true,
      version: venv.python,
      detail: venv.python !== null ? paths.venv : (venv.error ?? "Не установлен"),
    }),
    item({
      id: "sherpa-onnx",
      label: "sherpa-onnx (VAD и голоса спикеров)",
      ok: venv.sherpa !== null && venv.specOk,
      required: true,
      version: venv.sherpa,
      detail:
        venv.sherpa === null
          ? venv.python === null
            ? "Нет Python-окружения"
            : `Не импортируется: ${venv.error ?? "неизвестная ошибка"}`
          : venv.specOk
            ? `numpy ${venv.numpy ?? "?"}`
            : "Пакеты устарели: нужна повторная установка",
    }),
    ...MODELS.map((spec, index) =>
      item({
        id: spec.id,
        label: spec.label,
        ok: models[index]!.ok,
        required: true,
        version: null,
        detail: models[index]!.detail,
      }),
    ),
    item({
      id: "gigaam",
      label: "Распознавание речи GigaAM",
      ok: gigaam.ready,
      required: true,
      version: null,
      detail: gigaam.detail,
      fix: "Установите плагин gigaam и дождитесь готовности (bb gigaam status) или укажите адрес сервера в настройке gigaamUrl",
    }),
  ];

  if (unsupported !== null) {
    for (const [index, entry] of items.entries()) items[index] = { ...entry, ok: false, detail: unsupported, fix: null };
  }
  if (sudoHint !== null) {
    for (const [index, entry] of items.entries()) {
      if (!entry.ok && entry.fix?.includes("sudo ")) items[index] = { ...entry, detail: `${entry.detail}; ${sudoHint}` };
    }
  }

  return {
    ready: items.every((entry) => entry.ok || !entry.required),
    items,
    setup,
    runtimeHash: paths.runtimeHash,
    hostDataDir: paths.root,
    platform,
    arch,
    sudo,
    gigaam,
    chromePath: system.chrome.path,
  };
}

/** macOS Apple silicon: only what local recording needs (no Chrome/Xvfb/PulseAudio/apt). */
async function checkMacEnv(paths: HostPaths, input: EnvCheckInput, platform: NodeJS.Platform, arch: string): Promise<EnvReport> {
  const [system, runtime, venv, uv, gigaam, setup, swift, macVersion, ...models] = await Promise.all([
    probeSystem(input.chromePath),
    probeRuntime(paths),
    probeVenv(paths, { timeoutMs: VENV_CHECK_TIMEOUT_MS }),
    uvVersion(paths),
    discoverGigaam(paths, input.gigaamUrl),
    setupSummary(paths),
    probeSwift(),
    probeMacVersion(),
    ...MODELS.map((spec) => checkModel(paths, spec).catch((error: unknown) => ({ ok: false, detail: errorMessage(error) }))),
  ]);
  const capture = await statOrNull(paths.capture);
  const whisper = await statOrNull(paths.whisperModel);
  const detectOk = capture === null ? false : await run(paths.capture, ["detect"], { timeoutMs: 10_000 }).then((r) => r.code === 0 && r.stdout.trim().startsWith("[")).catch(() => false);
  const macOk =
    macVersion !== null &&
    (macVersion.major > MIN_MACOS_MAJOR || (macVersion.major === MIN_MACOS_MAJOR && macVersion.minor >= MIN_MACOS_MINOR));
  const items: EnvItem[] = [
    item({
      id: "macos",
      label: "macOS 14.4+ (Apple silicon)",
      ok: macOk,
      required: true,
      version: macVersion?.detail ?? null,
      detail: macVersion === null ? "не удалось прочитать версию macOS" : "macOS " + macVersion.detail,
      fix: "Локальная запись требует macOS 14.4 или новее на Apple silicon",
    }),
    item({
      id: "swiftc",
      label: "Компилятор Swift",
      ok: swift.path !== null,
      required: true,
      version: swift.version,
      detail: swift.path ?? "swiftc не найден",
      fix: "xcode-select --install",
    }),
    item({
      id: "capture",
      label: "Хелпер захвата звука",
      ok: capture !== null,
      required: true,
      version: null,
      detail: capture !== null ? paths.capture : "не скомпилирован (bb meetings setup)",
      fix: "bb meetings setup",
    }),
    item({
      id: "detection",
      label: "Обнаружение встреч (detect)",
      ok: detectOk,
      required: true,
      version: null,
      detail: detectOk ? "capture detect возвращает список процессов" : "capture detect не отвечает (проверьте bb meetings logs)",
      fix: "bb meetings setup",
    }),
    item({
      id: "ffmpeg",
      label: "ffmpeg",
      ok: system.ffmpeg.path !== null && system.ffprobe.path !== null,
      required: true,
      version: system.ffmpeg.version,
      detail: system.ffmpeg.path ?? "ffmpeg не найден",
      fix: "brew install ffmpeg",
    }),
    item({
      id: "uv",
      label: "Менеджер пакетов uv",
      ok: uv !== null,
      required: true,
      version: uv,
      detail: uv !== null ? paths.uv : uvDownload() === null ? "Нет сборки uv для " + process.platform + "-" + process.arch : "Не установлен",
    }),
    item({
      id: "venv",
      label: "Python " + PYTHON_VERSION + " для транскрибатора",
      ok: venv.python !== null,
      required: true,
      version: venv.python,
      detail: venv.python !== null ? paths.venv : (venv.error ?? "Не установлен"),
    }),
    item({
      id: "sherpa-onnx",
      label: "sherpa-onnx (VAD и голоса спикеров)",
      ok: venv.sherpa !== null && venv.specOk,
      required: true,
      version: venv.sherpa,
      detail:
        venv.sherpa === null
          ? venv.python === null
            ? "Нет Python-окружения"
            : "Не импортируется: " + (venv.error ?? "неизвестная ошибка")
          : venv.specOk
            ? "numpy " + (venv.numpy ?? "?")
            : "Пакеты устарели: нужна повторная установка",
    }),
    ...MODELS.map((spec, index) =>
      item({ id: spec.id, label: spec.label, ok: models[index]!.ok, required: true, version: null, detail: models[index]!.detail }),
    ),
    item({
      id: "whisper-model",
      label: "Модель Whisper large-v3-turbo",
      ok: whisper !== null,
      required: true,
      version: null,
      detail: whisper !== null ? paths.whisperModel : "Не загружена (~" + (WHISPER_MODEL.diskBytes / 1e9).toFixed(1) + " ГБ); загружается при установке",
      fix: "bb meetings setup",
    }),
    item({
      id: "microphone",
      label: "Доступ к микрофону",
      ok: true,
      required: false,
      version: null,
      detail: "Выдаётся приложению BB при первой записи (Системные настройки → Конфиденциальность → Микрофон)",
      fix: null,
    }),
    item({
      id: "system-audio",
      label: "Запись системного звука",
      ok: true,
      required: false,
      version: null,
      detail: "Выдаётся приложению BB при первой записи (Системные настройки → Конфиденциальность → Запись системного звука)",
      fix: null,
    }),
    item({
      id: "gigaam",
      label: "Распознавание речи GigaAM (доп.)",
      ok: gigaam.ready,
      required: false,
      version: null,
      detail: gigaam.detail,
      fix: "Установите плагин gigaam и дождитесь готовности (bb gigaam status) или укажите адрес сервера в настройке gigaamUrl",
    }),
  ];
  return {
    ready: items.every((entry) => entry.ok || !entry.required),
    items,
    setup,
    runtimeHash: paths.runtimeHash,
    hostDataDir: paths.root,
    platform,
    arch,
    sudo: false,
    gigaam,
    chromePath: system.chrome.path,
    inputDevices: await listInputDevices(paths),
  };
}
