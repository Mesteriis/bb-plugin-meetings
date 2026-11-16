// Maps macOS Core Audio client processes (bundle ids) to meeting sources
// for local recording (docs/dev/DESIGN.md §15). Pure: no I/O, no platform
// calls, so the mapping and the detection state machine are unit-tested
// independently of Core Audio.
//
// A meeting source is "the app that holds the microphone": Zoom, Teams,
// Telegram, FaceTime, or a browser (any supported browser counts as one
// "browser call" source). Helper processes (Zoom's caphost, a browser's
// GPU/renderer helpers) map to their parent app by bundle-id prefix.

export interface LocalSource {
  /** Stable key used in the meeting row's url (local://<appKey>), settings and events. */
  readonly appKey: string;
  /** Russian label shown on the page and in the CLI. */
  readonly label: string;
}

/** One meeting source: its bundle ids and the prefixes of its helper processes. */
export interface LocalSourceRule extends LocalSource {
  readonly bundleIds: readonly string[];
  readonly helperPrefixes: readonly string[];
}

/**
 * A browser is a single meeting source ("browser call"), regardless of which
 * browser is used. Helpers (com.google.Chrome.helper.*, com.apple.WebKit.*,
 * company.thebrowser.browser.*, …) are folded into it by prefix.
 */
// Safari (com.apple.Safari) is not supported: its WebKit helpers are launchd-spawned
// (ppid 1), so their owning app cannot be resolved and a Safari call cannot be
// detected reliably (DESIGN §15).
export const BROWSER_BUNDLE_IDS = [
  "com.google.Chrome",
  "company.thebrowser.browser",
  "company.thebrowser.dia",
  "ru.yandex.desktop.yandex-browser",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
] as const;

const BROWSER_HELPER_PREFIXES = [
  "com.google.Chrome.helper",
  "company.thebrowser.browser.",
  "company.thebrowser.dia.",
  "ru.yandex.desktop.yandex-browser.",
  "org.mozilla.firefox.",
  "com.microsoft.edgemac.",
] as const;

/** The rule set (DESIGN §15): bundle ids and helper prefixes per meeting source. */
export const LOCAL_SOURCE_RULES: readonly LocalSourceRule[] = [
  {
    appKey: "zoom",
    label: "Zoom",
    bundleIds: ["us.zoom.xos"],
    // us.zoom.caphost appears only during a call; other us.zoom.* helpers exist.
    helperPrefixes: ["us.zoom."],
  },
  {
    appKey: "teams",
    label: "Microsoft Teams",
    bundleIds: ["com.microsoft.teams", "com.microsoft.teams2"],
    helperPrefixes: ["com.microsoft.teams"],
  },
  {
    appKey: "telegram",
    label: "Telegram",
    // The App Store build and the direct-download build (Telegram Desktop).
    bundleIds: ["ru.keepcoder.Telegram", "com.tdesktop.Telegram"],
    helperPrefixes: [],
  },
  {
    appKey: "facetime",
    label: "FaceTime",
    bundleIds: ["com.apple.FaceTime"],
    helperPrefixes: [],
  },
  {
    appKey: "browser",
    label: "Браузер",
    bundleIds: [...BROWSER_BUNDLE_IDS],
    helperPrefixes: [...BROWSER_HELPER_PREFIXES],
  },
];

export function localSourceLabel(appKey: string): string {
  return LOCAL_SOURCE_RULES.find((rule) => rule.appKey === appKey)?.label ?? appKey;
}

/** Bundle-id matchers (exact ids + helper prefixes) for the capture helper's process tap. */
export function localSourceBundles(appKey: string): string[] {
  const rule = LOCAL_SOURCE_RULES.find((candidate) => candidate.appKey === appKey);
  if (rule === undefined) return [];
  return [...rule.bundleIds, ...rule.helperPrefixes];
}

/** The meeting source for a bundle id, or null when it is not a listed app. */
export function classifyBundleId(bundleId: string): LocalSource | null {
  const id = bundleId.trim();
  if (id === "") return null;
  for (const rule of LOCAL_SOURCE_RULES) {
    if (rule.bundleIds.includes(id)) return { appKey: rule.appKey, label: rule.label };
  }
  for (const rule of LOCAL_SOURCE_RULES) {
    if (rule.helperPrefixes.some((prefix) => id.startsWith(prefix))) {
      return { appKey: rule.appKey, label: rule.label };
    }
  }
  return null;
}

/** A raw audio client process as reported by the capture helper's `detect`. */
export interface AudioClientProcess {
  readonly pid: number;
  readonly bundleId: string;
  /** kAudioProcessPropertyIsRunningInput: the process holds the microphone. */
  readonly input: boolean;
  readonly output: boolean;
}

/**
 * The distinct meeting sources that currently hold the microphone, excluding
 * the given pids (the bb CLI's own processes and the capture helper itself
 * must never count as a meeting). Duplicates (several helpers of one app) fold
 * into one source.
 */
export function activeSources(processes: readonly AudioClientProcess[], excludePids: ReadonlySet<number> = new Set()): LocalSource[] {
  const seen = new Map<string, LocalSource>();
  for (const proc of processes) {
    if (!proc.input || excludePids.has(proc.pid)) continue;
    const source = classifyBundleId(proc.bundleId);
    if (source !== null && !seen.has(source.appKey)) seen.set(source.appKey, source);
  }
  return [...seen.values()];
}
