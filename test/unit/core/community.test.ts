import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMUNITY_DISCORD_URL } from "../../../src/core/community";

/**
 * コミュニティ（Discord）への案内のリンク（1.0.0）。リンクは `core/community.ts` の1か所に置き、
 * README と Discord の計画書の「いまの状態」はそれに合わせる（招待が切れたとき、直し漏れを止める）。
 */
const root = path.join(__dirname, "..", "..", "..");

describe("コミュニティ（Discord）のリンク", () => {
  it("Discord の招待の形をしている", () => {
    expect(COMMUNITY_DISCORD_URL).toMatch(/^https:\/\/discord\.gg\/[A-Za-z0-9]+$/);
  });

  it("README の案内は、定義と同じリンクを書いている（ほかの招待を書いていない）", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const invites = readme.match(/https:\/\/discord\.gg\/[A-Za-z0-9]+/g) ?? [];
    expect(invites.length).toBeGreaterThan(0);
    expect(new Set(invites)).toEqual(new Set([COMMUNITY_DISCORD_URL]));
  });
});
