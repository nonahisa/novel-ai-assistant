import { describe, expect, test } from "vitest";
import { workChatFeatureGuide } from "../../../src/core/workChatMaterials";

/**
 * 作品の中身を訊く相談に、使い方の目次（約4KB）を付けない（P-21、2026-10-01）。
 *
 * Sonnet が内部AIの代わりに撃った測定（docs/measurements/2026-10-01-sonnet-as-internal-ai.md
 * の不具合11）で、「この作品で、塩不足の問題は何話から何話までで解決されますか。」が
 * `topic: howto / reason: matched` と判定され、目次と「GitHub作品管理」の説明が付いた。
 * 当たった2文字組みは「作品」と「解決」（「競合解決」）——**「作品」は説明の束の
 * ほとんど（29束のうち20）に出る語**で、話題の証拠にならない。
 */
describe("作品の中身を訊く問いには目次を付けない", () => {
  test.each([
    "この作品で、塩不足の問題は何話から何話までで解決されますか。",
    "この作品の主人公の口調はどんな感じですか",
    "第200話あたりでユニィは何をしていましたか",
  ])("%s", (question) => {
    const guide = workChatFeatureGuide(question, []);
    expect(guide.topic).toBe("craft");
    expect(guide.featureIndex).toBe(false);
    expect(guide.selected).toEqual([]);
  });
});

describe("使い方を訊く問いには、今までどおり目次を付ける", () => {
  test.each([
    "第2話の誤字脱字を検知してほしい",
    "この作品をGitHubで同期したい",
    "作品の誤字脱字の検知はどこからできますか",
    "設定資料の抽出はどうやって動かしますか",
    "ルビを振りたい",
  ])("%s", (question) => {
    const guide = workChatFeatureGuide(question, []);
    expect(guide.featureIndex).toBe(true);
  });
});
