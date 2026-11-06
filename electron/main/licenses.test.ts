// The packaged app ships licenses/ as extraResources (electron-builder.yml). Bundled third-party assets whose license
// requires the text to travel with them get a committed copy there; this keeps each copy in sync with its package.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");

describe("third-party licenses", () => {
  it("ships the Inter font's OFL text as published by @fontsource-variable/inter", () => {
    const pkgDir = path.dirname(require.resolve("@fontsource-variable/inter/package.json"));
    const upstream = fs.readFileSync(path.join(pkgDir, "LICENSE"), "utf8");
    const shipped = fs.readFileSync(path.join(root, "licenses", "Inter-OFL-1.1.txt"), "utf8");
    expect(shipped).toBe(upstream);
    expect(shipped).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("is packaged into every build", () => {
    const config = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
    expect(config).toMatch(/^extraResources:\n {2}- from: licenses\n {4}to: licenses\n/m);
  });
});
