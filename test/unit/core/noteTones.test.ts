import { describe, expect, it } from "vitest";
import { recordedFindingLabels } from "../../../src/core/findingSource";
import { MEMO_TAG_COLORS, memoTagClass } from "../../../src/core/sceneMemo";
import {
  FINDING_CATEGORY_LABELS,
  FINDING_TONES,
  findingToneClass,
  findingToneVars,
  isKnownFindingLabel,
  noteToneClasses,
  tagTonesOf,
} from "../../../src/core/sceneMemoRows";
import { TERM_COLORS } from "../../../src/core/termColors";

/**
 * 校正・メモパネルの種類の色分け（作者の要望 2026-10-04「推敲や誤字脱字等で
 * 色分けしてください」「表示ジャンルすべてです」。設計書6.96.5）。
 *
 * 0.98.9 までは、AIの指摘はどの種類も同じ1色（`memo-ai`）だった。
 */
describe("指摘の種類の色", () => {
  /**
   * **取りこぼしの見張り。** 検知を足すと `findingSource.ts` の表へ1行足す
   * （足さないと記録されない）。そのとき色の表に無ければ、ここで落ちる
   * ——選び口に並ぶのに色の無い種類を作らない
   */
  it("記録する分類名と、古い記録の呼び名のすべてに色が決まっている", () => {
    const labels = [
      ...recordedFindingLabels(),
      ...Object.values(FINDING_CATEGORY_LABELS),
    ];
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) {
      expect(isKnownFindingLabel(label), `${label} の色が無い`).toBe(true);
    }
  });

  it("誤字脱字・表記ゆれ・推敲・矛盾・矛盾（事実の照合）・プロット逸脱は、それぞれ違う色", () => {
    const labels = recordedFindingLabels();
    const classes = labels.map(findingToneClass);
    expect(new Set(classes).size).toBe(labels.length);
    const vars = findingToneVars();
    const colors = classes.map((name) => vars[name]);
    expect(new Set(colors).size).toBe(labels.length);
  });

  it("色の値はどれも違う（同じ色の種類を作らない）", () => {
    const values = Object.values(FINDING_TONES);
    expect(new Set(values).size).toBe(values.length);
  });

  it("古い呼び名「誤字」は誤字脱字と同じ色", () => {
    expect(findingToneClass("誤字")).toBe(findingToneClass("誤字脱字"));
  });

  it("知らない分類名（外から置かれた指摘など）は、その他の色に倒す（空欄にしない）", () => {
    expect(isKnownFindingLabel("新しい検知")).toBe(false);
    expect(findingToneClass("新しい検知")).toBe(findingToneClass("指摘"));
  });

  /**
   * **明るい・暗い・ハイコントラストのどれでも読める**ように、VS Code の
   * テーマの色（グラフの色）を使う。テーマが持たない環境だけ既定の色に倒す
   */
  it("色は VS Code のテーマの色で受ける", () => {
    for (const value of Object.values(FINDING_TONES)) {
      expect(value).toMatch(/^var\(--vscode-[a-zA-Z.-]+, #[0-9a-f]{6}\)$/);
    }
  });

  /** 用語の色（`termColors.ts` が唯一の定義）の写しを作らない */
  it("用語の色の16進を使わない", () => {
    const termHexes = Object.values(TERM_COLORS).flatMap((pair) => [
      pair.light.toLowerCase(),
      pair.dark.toLowerCase(),
    ]);
    for (const value of Object.values(FINDING_TONES)) {
      for (const hex of termHexes) expect(value.toLowerCase()).not.toContain(hex);
    }
  });
});

describe("付箋と指摘の色の印", () => {
  it("付箋の種類と指摘の種類で、印の名前が重ならない", () => {
    const memoClasses = Object.keys(MEMO_TAG_COLORS).map((kind) => `memo-${kind}`);
    const findingClasses = Object.keys(FINDING_TONES).map((key) => `finding-${key}`);
    expect(noteToneClasses().sort()).toEqual([...memoClasses, ...findingClasses].sort());
    expect(new Set(noteToneClasses()).size).toBe(noteToneClasses().length);
  });

  it("選び口の項目それぞれに印が付く（付箋のタグは付箋の色、指摘の種類は指摘の色）", () => {
    const tones = tagTonesOf(["TODO", "メモ", "伏線"], ["推敲", "誤字脱字", "矛盾"]);
    expect(tones).toEqual({
      TODO: memoTagClass("TODO"),
      メモ: memoTagClass("メモ"),
      伏線: memoTagClass("伏線"),
      推敲: findingToneClass("推敲"),
      誤字脱字: findingToneClass("誤字脱字"),
      矛盾: findingToneClass("矛盾"),
    });
    // 選び口に並ぶ項目と、印のある項目が同じ数
    expect(Object.keys(tones)).toHaveLength(6);
  });

  it("付箋のタグと指摘の種類が同じ語なら、付箋の色を使う（選び口の項目は1つ）", () => {
    const tones = tagTonesOf(["推敲"], ["推敲"]);
    expect(tones).toEqual({ 推敲: memoTagClass("推敲") });
  });
});
