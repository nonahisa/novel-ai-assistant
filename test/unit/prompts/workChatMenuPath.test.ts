import { describe, expect, test } from "vitest";
import {
  WORK_CHAT_VERSION,
  buildWorkChatSystemPrompt,
} from "../../../src/prompts/workChat";
import { findMenuMentions } from "../../../src/core/menuMentions";
import { guideMenuEntries, MENU_PATH_START } from "../../../src/core/menuPath";

/**
 * 操作の質問への答え方（P-21 v3.38。設計書6.118。作者の依頼 2026-11-05）。
 *
 * - 項目の名前は「」で正確に書く（光らせる札と場所の図は、この囲みで拾う。`findMenuMentions`）
 * - 場所は毎回、最初の一押し（左の端のアイコン）から書く
 * - 前の答えを指して省かない（作者はスマホで読み、上へ戻れない）
 *
 * **指示の言葉は、そのまま答えに返ってくる**（CLAUDE.md の失敗3）。足した指示の文が
 * 答えに写されても、関係の無い項目が光ったり、作者に「上を見て」と言ったりしないことを見る。
 */

/** 使い方の節（目次を渡す回にだけ付く）を切り出す */
function guideSection(prompt: string): string {
  const start = prompt.indexOf("【この拡張機能の使い方を聞かれたとき】");
  expect(start).toBeGreaterThan(-1);
  const rest = prompt.slice(start + 1);
  const end = rest.indexOf("\n【");
  return end === -1 ? rest : rest.slice(0, end);
}

const prompt = buildWorkChatSystemPrompt({ featureIndex: true, paid: true });
const section = guideSection(prompt);

describe("操作の答え方の指示", () => {
  test("版を上げてある", () => {
    expect(Number(WORK_CHAT_VERSION)).toBeGreaterThanOrEqual(3.38);
  });

  test("名前を「」で囲むこと・最初の一押しから書くこと・前の答えを指さないことを言う", () => {
    expect(section).toContain("「」で囲");
    expect(section).toContain(MENU_PATH_START.slice(0, 18));
    expect(section).toContain("前の答え");
  });

  test("場所の図は製品が付けるので、AIに描かせない", () => {
    expect(section).toContain("図");
  });
});

describe("指示の言葉がそのまま答えに写されても壊れない", () => {
  test("使い方の節の文を答えとして拾っても、光らせる項目は1つも出ない（両モード）", () => {
    // 例文に実在の操作名を「」で書くと、写されたときに関係の無い項目が光る
    for (const mode of ["author", "editor"] as const) {
      expect(findMenuMentions(section, guideMenuEntries(mode)), mode).toEqual([]);
    }
  });

  test("作業を頼まれたときの、場所の伝え方の一文も同じ", () => {
    // この節には起動できる操作の一覧（名前そのもの）があるので、節ごとではなく
    // 道順を言う一文だけを見る
    const start = prompt.indexOf("- 一覧に無い操作を頼まれたら");
    expect(start).toBeGreaterThan(-1);
    const line = prompt.slice(start, prompt.indexOf("札が出ます）。", start));
    expect(line).toContain("左の端の統合小説執筆環境のアイコン");
    for (const mode of ["author", "editor"] as const) {
      expect(findMenuMentions(line, guideMenuEntries(mode)), mode).toEqual([]);
    }
  });

  test("「上の手順」の字を書かない（写されると、作者に戻れない所を指す）", () => {
    expect(prompt).not.toContain("上の手順");
    expect(prompt).not.toContain("上の答え");
  });
});
