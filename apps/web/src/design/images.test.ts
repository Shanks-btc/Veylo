import { describe, expect, it } from "vitest";
import { IMAGES, licenceProblems } from "./images";

const sources = Object.values(IMAGES).map((s) => s.source);

describe("photo licences (W2.1 R3)", () => {
  it("fails when LICENSES.md is missing", () => {
    expect(licenceProblems(undefined, sources)).toEqual(["design/images/LICENSES.md is missing"]);
  });
  it("fails for each photo the file doesn't name", () => {
    expect(licenceProblems("hero-team.jpg: https://unsplash.com/…", sources)).toHaveLength(2);
  });
  it("passes when every photo is named", () => {
    expect(licenceProblems(sources.join("\n"), sources)).toEqual([]);
  });
  it("sources are plain .jpg files (no doubled extension)", () => {
    for (const s of sources) expect(s).toMatch(/^[a-z-]+\.jpg$/);
  });
});
