// Bundle-id mapping for local recording (DESIGN §15). Pure, no I/O.
import { describe, expect, it } from "vitest";
import { activeSources, classifyBundleId, localSourceLabel, LOCAL_SOURCE_RULES } from "../src/host/local-sources.js";

describe("classifyBundleId", () => {
  it("maps a meeting app by its exact bundle id", () => {
    expect(classifyBundleId("us.zoom.xos")).toEqual({ appKey: "zoom", label: "Zoom" });
    expect(classifyBundleId("com.microsoft.teams")).toEqual({ appKey: "teams", label: "Microsoft Teams" });
    expect(classifyBundleId("ru.keepcoder.Telegram")).toEqual({ appKey: "telegram", label: "Telegram" });
    expect(classifyBundleId("com.apple.FaceTime")).toEqual({ appKey: "facetime", label: "FaceTime" });
  });

  it('folds every supported browser and its helpers into one "browser call" source', () => {
    for (const id of ["com.google.Chrome", "com.apple.Safari", "company.thebrowser.browser", "org.mozilla.firefox", "com.microsoft.edgemac"]) {
      expect(classifyBundleId(id)).toEqual({ appKey: "browser", label: "Браузер" });
    }
  });

  it("maps helper processes to their parent app by prefix", () => {
    expect(classifyBundleId("us.zoom.caphost")).toEqual({ appKey: "zoom", label: "Zoom" });
    expect(classifyBundleId("com.microsoft.teams.helper")).toEqual({ appKey: "teams", label: "Microsoft Teams" });
    expect(classifyBundleId("com.google.Chrome.helper.1")).toEqual({ appKey: "browser", label: "Браузер" });
    // com.apple.WebKit.* belongs to any app's embedded web view, not only a listed browser,
    // so it is not classified (ownership cannot be resolved from the helper bundle id).
    expect(classifyBundleId("com.apple.WebKit.GPU")).toBeNull();
    expect(classifyBundleId("company.thebrowser.browser.helper")).toEqual({ appKey: "browser", label: "Браузер" });
  });

  it("returns null for an unlisted process and for an empty id", () => {
    expect(classifyBundleId("com.apple.Finder")).toBeNull();
    expect(classifyBundleId("")).toBeNull();
  });
});

describe("activeSources", () => {
  it("keeps only processes that hold the microphone, deduped per source", () => {
    const sources = activeSources([
      { pid: 10, bundleId: "us.zoom.xos", input: true, output: true },
      { pid: 11, bundleId: "us.zoom.caphost", input: true, output: false },
      { pid: 12, bundleId: "com.apple.Finder", input: true, output: false },
      { pid: 13, bundleId: "com.microsoft.teams", input: false, output: true },
    ]);
    expect(sources).toEqual([
      { appKey: "zoom", label: "Zoom" },
    ]);
  });

  it("excludes the capture helper and the bb CLI by pid", () => {
    const sources = activeSources(
      [
        { pid: 100, bundleId: "us.zoom.xos", input: true, output: true },
        { pid: 200, bundleId: "com.google.Chrome.helper", input: true, output: false },
      ],
      new Set([200]),
    );
    expect(sources).toEqual([{ appKey: "zoom", label: "Zoom" }]);
  });
});

describe("LOCAL_SOURCE_RULES", () => {
  it("declares the sources required by the spec", () => {
    expect(LOCAL_SOURCE_RULES.map((rule) => rule.appKey)).toEqual(["zoom", "teams", "telegram", "facetime", "browser"]);
    expect(localSourceLabel("zoom")).toBe("Zoom");
    expect(localSourceLabel("browser")).toBe("Браузер");
    expect(localSourceLabel("unknown-app")).toBe("unknown-app");
  });
});
