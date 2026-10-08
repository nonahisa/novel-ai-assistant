import { describe, expect, test } from "vitest";
import {
  buildExportDocument,
  type SettingsExportData,
} from "../../../src/core/settingsExportProfiles";
import {
  buildExportDiffMarkdown,
  diffSnapshots,
  parseSnapshot,
  snapshotOf,
} from "../../../src/core/settingsExportDiff";
import {
  FIXTURE_AT,
  FIXTURE_OPTIONS,
  fixtureData,
} from "../support/settingsExportFixture";

/**
 * 前回書き出した時点との差分（F6、設計書6.75.1）。
 *
 * 差分の3種（足された項目・変わった欄・消えた項目）と、控えの読み書きを
 * 確かめる。**控えは「渡した中身」**なので、伏せた人物は控えにも無い。
 */

const LATER = new Date(2026, 8, 12, 9, 0, 0);

function snapshot(data: SettingsExportData, chapter: number | null = null, at = FIXTURE_AT) {
  return snapshotOf(
    buildExportDocument("editorial", data, { ...FIXTURE_OPTIONS, chapter }),
    at
  );
}

describe("差分の3種", () => {
  test("足された項目", () => {
    const before = fixtureData();
    const after = fixtureData();
    after.locations = [
      ...after.locations,
      { ...after.locations[1], id: "loc_003", name: "灯台" },
    ];
    const diff = diffSnapshots(snapshot(before), snapshot(after, null, LATER));
    expect(diff).toHaveLength(1);
    expect(diff[0].kind).toBe("locations");
    expect(diff[0].added.map((record) => record.name)).toEqual(["灯台"]);
    expect(diff[0].removed).toEqual([]);
  });

  test("変わった欄（値が変わった・欄が増えた・欄が消えた）", () => {
    const before = fixtureData();
    const base = fixtureData();
    // characters は読み取り専用の配列なので、差し替えた配列で作り直す
    const after = {
      ...base,
      characters: [
        {
          ...base.characters[0],
          personality: "人見知りを克服しつつある",
          speechStyle: "丁寧語",
          gender: "",
        },
        ...base.characters.slice(1),
      ],
    };
    const diff = diffSnapshots(snapshot(before), snapshot(after, null, LATER));
    const changed = diff[0].changed.find((record) => record.name === "月島灯")!;
    expect(changed.changes).toEqual(
      expect.arrayContaining([
        {
          label: "性格",
          before: "人見知りだが芯は強い",
          after: "人見知りを克服しつつある",
        },
        { label: "口調", before: null, after: "丁寧語" },
        { label: "性別", before: "女性", after: null },
      ])
    );
  });

  test("消えた項目", () => {
    const before = fixtureData();
    const after = fixtureData();
    after.world = after.world.filter((item) => item.name !== "灯守");
    const diff = diffSnapshots(snapshot(before), snapshot(after, null, LATER));
    expect(diff[0].kind).toBe("world");
    expect(diff[0].removed.map((record) => record.name)).toEqual(["灯守"]);
  });

  test("変わりが無ければ、そう書く", () => {
    const text = buildExportDiffMarkdown(
      snapshot(fixtureData()),
      snapshot(fixtureData(), null, LATER),
      { workTitle: "灯の塔" }
    );
    expect(text).toContain("前回から変わったところはありません。");
  });

  test("範囲を広げると、新しく出た人物が足された項目になる", () => {
    // 第3話まで渡した相手へ、次は全話ぶん（白鳥は第9話で初登場）
    const text = buildExportDiffMarkdown(
      snapshot(fixtureData(), 3),
      snapshot(fixtureData(), null, LATER),
      { workTitle: "灯の塔" }
    );
    expect(text).toContain("前回の書き出し**: 2026-09-05 14:30（第3話まで）");
    expect(text).toContain("今回**: 2026-09-12 09:00（全話ぶん）");
    expect(text).toMatch(/### 足された項目\n\n- 白鳥/);
  });

  test("Markdown に3種の見出しが並ぶ", () => {
    const before = fixtureData();
    const after = fixtureData();
    after.locations = [
      { ...after.locations[0], description: "建て替えられた塔" },
      { ...after.locations[1], id: "loc_003", name: "灯台" },
    ];
    const text = buildExportDiffMarkdown(
      snapshot(before),
      snapshot(after, null, LATER),
      { workTitle: "灯の塔" }
    );
    expect(text).toContain("### 足された項目\n\n- 灯台");
    expect(text).toContain("### 変わった欄\n\n#### 図書塔");
    expect(text).toContain("- **説明**: 「石造りの八角形。<屋根>に銅の風見鶏 & 鐘。」 → 「建て替えられた塔」");
    expect(text).toContain("### 消えた項目\n\n- 港");
  });
});

describe("控え", () => {
  test("伏せた人物と作者のメモは、控えにも入らない", () => {
    const json = JSON.stringify(snapshot(fixtureData()));
    expect(json).not.toContain("終幕の男");
    expect(json).not.toContain("作者だけの覚え書き");
  });

  test("書いて読み戻せる", () => {
    const saved = snapshot(fixtureData());
    expect(parseSnapshot(JSON.stringify(saved))).toEqual(saved);
  });

  test("壊れた控え・形の違う控えは読まない（直さない）", () => {
    expect(parseSnapshot("{")).toBeNull();
    expect(parseSnapshot("[]")).toBeNull();
    expect(parseSnapshot(JSON.stringify({ version: 99 }))).toBeNull();
    const saved = snapshot(fixtureData());
    const broken = JSON.parse(JSON.stringify(saved));
    broken.sections[0].records[0].values = [["読み"]];
    expect(parseSnapshot(JSON.stringify(broken))).toBeNull();
  });
});
