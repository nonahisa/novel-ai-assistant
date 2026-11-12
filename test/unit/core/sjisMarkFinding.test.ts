import { describe, expect, it } from "vitest";
import { locateFindings } from "../../../src/core/findingLocation";
import { findingAppliesDirectly, findingRestoreOf } from "../../../src/core/findingSource";
import { findingHeadline, findingToneClass, isKnownFindingLabel } from "../../../src/core/sceneMemoRows";
import { planShiftJisSave } from "../../../src/core/sjisFallback";
import { SJIS_MARK_FINDING_LABEL, buildSjisMarkFindings } from "../../../src/core/sjisMarkFinding";

/**
 * 保存の直前に「〓」にした字の説明を、校正・メモパネルの行にする（設計書5.4.2、0.148.3。
 * 作者の答え 2026-11-09「目印に置き換えた上で、メモ校正パネルに説明を残して…」）。
 *
 * 見張ること：〓の行へ飛べる・作者が〓を直したら行が消える・［直す］や提案パネルの道に乗らない。
 */

const WORK = "C:\\小説\\作品";
const EPISODE = `${WORK}\\本文\\001.txt`;
const RECOVERY = `${WORK}\\本文\\.novelai-recovery\\001.txt.20261109.bak`;
const TIME = "2026-11-09T01:00:00.000Z";

function marksOf(text: string) {
  const plan = planShiftJisSave(text);
  return { saved: plan.text, findings: buildSjisMarkFindings(WORK, EPISODE, plan.text, plan.marks, RECOVERY, TIME) };
}

describe("〓にした字の説明の行", () => {
  it("字と控えの場所を説明に書き、〓の行に置く", () => {
    const { saved, findings } = marksOf("一行目。\nかきくけ♡さしすせ\n三行目。");
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.label).toBe(SJIS_MARK_FINDING_LABEL);
    expect(finding.file).toBe("本文/001.txt");
    expect(finding.hintLine).toBe(2);
    expect(finding.message).toBe(
      "「♡」は Shift_JIS に無い字なので「〓」にしました。元の字は控え（本文/.novelai-recovery/001.txt.20261109.bak）にあります。" +
        // 原稿の文字コード変換を案内する（作者の指示 2026-11-09）。行から命令は呼べないので、呼ぶ場所を書く
        "この原稿を UTF-8 に変換すれば、この字もそのまま書けます。" +
        "（作品一覧でこの話を右クリック →「原稿 UTF-8 変換」）"
    );
    // 画面の主文は説明（修正案が無いので）
    expect(findingHeadline(finding)).toBe(finding.message);
    // 保存したあとの本文で、2行目に見つかる
    const located = locateFindings(findings, new Map([["本文/001.txt", saved]]));
    expect(located.map(({ line }) => line)).toEqual([2]);
  });

  it("作者が〓を直したら、行は消える（場所が本文から見つからない）", () => {
    const { findings } = marksOf("かきくけ♡さしすせ");
    const fixed = new Map([["本文/001.txt", "かきくけ♥さしすせ"]]);
    expect(locateFindings(findings, fixed)).toEqual([]);
  });

  it("［直す］の道にも、提案パネルへ戻す道にも乗らない（［本文へ］と［見送る］だけ）", () => {
    const [finding] = marksOf("♡").findings;
    expect(findingAppliesDirectly(finding)).toBe(false);
    expect(findingRestoreOf(finding)).toBeUndefined();
  });

  it("分類名には色が決まっている（選び口で空欄にしない）", () => {
    expect(isKnownFindingLabel(SJIS_MARK_FINDING_LABEL)).toBe(true);
    expect(findingToneClass(SJIS_MARK_FINDING_LABEL)).toBe("finding-other");
  });

  it("行の違う〓は別の行に、前後の同じ〓（♡♡）は1行にまとめる", () => {
    const { findings } = marksOf("一つ目の♡です。\n二つ目の😀です。\nあい♡♡うえ");
    expect(findings.map(({ hintLine }) => hintLine)).toEqual([1, 2, 3]);
    expect(findings[2].message.startsWith("「♡」は")).toBe(true);
  });

  it("控えを残せなかったときは、そう書く", () => {
    const plan = planShiftJisSave("♡");
    const [finding] = buildSjisMarkFindings(WORK, EPISODE, plan.text, plan.marks, undefined, TIME);
    expect(finding.message).toContain("控えは残せませんでした");
  });
});
