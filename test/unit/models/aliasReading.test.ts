import { describe, expect, test } from "vitest";
import { parseCharacter } from "../../../src/models/character";
import { parseAbility } from "../../../src/models/ability";
import { parseLocation } from "../../../src/models/location";
import { parseOrganization } from "../../../src/models/organization";
import { parseWorldItem } from "../../../src/models/world";
import { pruneAliasReadings } from "../../../src/models/aliasReading";

/**
 * 別名の読み（設計書6.42.2）を、設定資料のJSONから読む。
 *
 * - 古い形（欄が無い）はそのまま読め、**読んだ結果にも欄を足さない**
 *   （保存のたびに `{}` が増えると、同期している全部のファイルに差分が出る）
 * - 壊れた形は直さずに止める（CLAUDE.md 実装ルール2）
 * - 別名に無い鍵は持たない（別名を消したら読みも消える）
 */

const PARSERS = [
  { label: "人物", parse: parseCharacter, id: "char_001" },
  { label: "能力", parse: parseAbility, id: "abil_001" },
  { label: "組織", parse: parseOrganization, id: "org_001" },
  { label: "場所", parse: parseLocation, id: "loc_001" },
  { label: "世界観", parse: parseWorldItem, id: "world_001" },
] as const;

describe("別名の読みを読む", () => {
  for (const { label, parse, id } of PARSERS) {
    test(`${label}：古い形のファイルはそのまま読め、欄を足さない`, () => {
      const record = parse({ id, name: "灯台", aliases: ["白灯"] }) as unknown as Record<
        string,
        unknown
      >;
      expect("aliasReadings" in record).toBe(false);
    });

    test(`${label}：別名ごとの読みを持てる`, () => {
      const record = parse({
        id,
        name: "灯台",
        aliases: ["白灯", "北の灯"],
        aliasReadings: { 白灯: "はくとう" },
      }) as unknown as { aliasReadings?: Record<string, string> };
      expect(record.aliasReadings).toEqual({ 白灯: "はくとう" });
    });

    test(`${label}：壊れた形は止める`, () => {
      expect(() =>
        parse({ id, name: "灯台", aliases: ["白灯"], aliasReadings: ["はくとう"] })
      ).toThrow(/aliasReadings/);
      expect(() =>
        parse({ id, name: "灯台", aliases: ["白灯"], aliasReadings: { 白灯: 1 } })
      ).toThrow(/aliasReadings/);
    });

    test(`${label}：別名に無い鍵・空の読みは持たない`, () => {
      const record = parse({
        id,
        name: "灯台",
        aliases: ["白灯"],
        aliasReadings: { 消えた別名: "きえた", 灯台: "とうだい", 白灯: "" },
      }) as unknown as Record<string, unknown>;
      expect("aliasReadings" in record).toBe(false);
    });
  }
});

describe("刈り込み", () => {
  test("前後の空白を外して別名と比べる", () => {
    expect(
      pruneAliasReadings({ " 姫 ": " ひめ ", 殿下: "でんか" }, "灯", ["姫"])
    ).toEqual({ 姫: "ひめ" });
  });
});
