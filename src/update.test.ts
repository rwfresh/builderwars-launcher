import { describe, expect, it } from "vitest";
import { parseUpdateState, updateBanner } from "./update";

describe("parseUpdateState", () => {
  it("accepts every state the main process sends", () => {
    for (const s of [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "available", version: "0.2.1" },
      { kind: "downloading", version: "0.2.1", percent: 42 },
      { kind: "ready", version: "0.2.1" },
      { kind: "up-to-date", version: "0.2.0" },
      { kind: "error", message: "offline" },
    ]) {
      expect(parseUpdateState(s), s.kind).toEqual(s);
    }
  });
  it("rejects malformed payloads", () => {
    expect(parseUpdateState(null)).toBeNull();
    expect(parseUpdateState({ kind: "ready" })).toBeNull();
    expect(parseUpdateState({ kind: "downloading", version: "1", percent: 101 })).toBeNull();
    expect(parseUpdateState({ kind: "install-now" })).toBeNull();
    expect(parseUpdateState({ kind: "available", version: "" })).toBeNull();
  });
});

describe("updateBanner", () => {
  it("offers restart and later when ready, and hides after later", () => {
    const ready = { kind: "ready", version: "0.2.1" } as const;
    expect(updateBanner(ready, null, null)).toEqual({ text: "Builder Wars 0.2.1 is ready.", actions: ["restart", "later"], subtle: false });
    expect(updateBanner(ready, "0.2.1", null)).toBeNull();
    // A newer ready version shows again.
    expect(updateBanner({ kind: "ready", version: "0.2.2" }, "0.2.1", null)?.actions).toEqual(["restart", "later"]);
  });
  it("offers the download page in notify mode", () => {
    expect(updateBanner({ kind: "available", version: "0.2.1" }, null, null)).toEqual({
      text: "Builder Wars 0.2.1 is available.",
      actions: ["download"],
      subtle: false,
    });
  });
  it("shows manual-check feedback and lets the player dismiss it", () => {
    const upToDate = { kind: "up-to-date", version: "0.2.0" } as const;
    expect(updateBanner(upToDate, null, null)?.text).toBe("You're on the latest version (0.2.0).");
    expect(updateBanner(upToDate, null, { ...upToDate })).toBeNull();
    expect(updateBanner({ kind: "error", message: "offline" }, null, null)?.text).toBe("Update check failed: offline");
  });
  it("is quiet when idle and subtle while downloading", () => {
    expect(updateBanner({ kind: "idle" }, null, null)).toBeNull();
    expect(updateBanner({ kind: "downloading", version: "0.2.1", percent: 7 }, null, null)).toEqual({
      text: "Downloading Builder Wars 0.2.1… 7%",
      actions: [],
      subtle: true,
    });
  });
});
