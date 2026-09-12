import { describe, expect, test } from "vitest";
import { ACTION_TREE, shownEntries } from "../../src/views/actionList";

/**
 * **画面に実際に出る詳細メニュー**を、ここに写して固定する。
 *
 * ## なぜ要るか
 *
 * `ACTION_TREE` をそのまま読むと、**画面に出ないものまで並ぶ**。
 * `hiddenFromActionList` が付いた項目（設定管理へ移したもの。設計書6.56.3）と、
 * 外部プロセスを起動できない環境で落ちる項目が、`shownEntries` で除かれるためである。
 *
 * **その違いで2度続けて実機確認の巡を迷わせた**（2026-09-12）。本体が
 * 「コードで確かめた」と言って渡した道順に、出ないはずの「セットアップを開始」
 * 「AI相談の強化」「機能ごとにAIを割り当てる」が入っていた。巡は画面を10分探し、
 * 見つからないまま終わった。**同じ日に、README も同じ古い並びを載せていた**
 * ことが分かっている（8巡目で直した）。
 *
 * ## 何を守るか
 *
 * - **道順を書く人は、まずここを読む。** `ACTION_TREE` を直に読まない
 * - **並びを変えたら、ここが落ちる。** 意図した変更なら写しを直す。
 *   意図していなければ、それは不具合である
 * - **README のメニューの図も、ここと揃える**（食い違ったまま配布された実績がある）
 *
 * 手元の環境（外部プロセスを起動できる）での並びを写す。ブラウザ版で何が落ちるかは
 * `actionList.test.ts` の「外部プロセスを起動できない環境（ブラウザ版）」が見る。
 */
function visibleMenu(): string[] {
  const out: string[] = [];
  for (const group of ACTION_TREE) {
    out.push(group.label);
    for (const entry of shownEntries(group.entries, true)) {
      if (entry.kind === "section") {
        out.push("  " + entry.label);
        for (const item of shownEntries(entry.items, true)) {
          out.push("    " + item.label);
        }
      } else {
        out.push("  " + entry.label);
      }
    }
  }
  return out;
}

describe("画面に出る詳細メニュー（道順を書く人はここを読む）", () => {
  test("分類は6つで、この順に並ぶ", () => {
    expect(ACTION_TREE.map((group) => group.label)).toEqual([
      "執筆データ",
      "作品管理",
      "執筆AI支援",
      "資料管理",
      "拡張機能の設定",
      "ヘルプ",
    ]);
  });

  test("**「拡張機能の設定」に出るのは4つだけ**", () => {
    // 「作者／編集者の切り替え」「セットアップを開始」「AI相談の強化」は
    // 設定管理へ移したので出ない（設計書6.56.3、作者の指示 2026-08-31）。
    // コマンドパレットからは今までどおり呼べる
    const group = ACTION_TREE.find((g) => g.label === "拡張機能の設定");
    expect(group).toBeDefined();

    expect(shownEntries(group!.entries, true).map((e) => e.label)).toEqual([
      "設定管理を開く",
      "訊かないことにした確認を見直す",
      "作品ごとの設定",
      "AI",
    ]);
  });

  test("**「AI」に出るのは4つだけ**", () => {
    // 「機能ごとにAIを割り当てる」「Ollamaの実行ファイル位置を指定」は出ない
    const group = ACTION_TREE.find((g) => g.label === "拡張機能の設定");
    const section = shownEntries(group!.entries, true).find(
      (e) => e.kind === "section" && e.label === "AI"
    );
    expect(section?.kind).toBe("section");
    if (section?.kind !== "section") return;

    expect(shownEntries(section.items, true).map((i) => i.label)).toEqual([
      "AI設定",
      "AI接続の確認",
      "AIチューニング",
      "AIチューニングの実測一覧を表示",
    ]);
  });

  test("「作品ごとの設定」は4つ", () => {
    const group = ACTION_TREE.find((g) => g.label === "拡張機能の設定");
    const section = shownEntries(group!.entries, true).find(
      (e) => e.kind === "section" && e.label === "作品ごとの設定"
    );
    if (section?.kind !== "section") throw new Error("見つからない");

    expect(shownEntries(section.items, true).map((i) => i.label)).toEqual([
      "この作品の目標を決める",
      "形式とジャンルを決める",
      "一覧に項目を増やす",
      "告知の設定",
    ]);
  });

  test("**「ヘルプ」の一番上は「作家のタイプ診断」**（設計書6.90）", () => {
    // はじめて開いた人が知りたいのは「全部の機能」ではなく
    // 「自分は何から始めればよいか」である。マニュアルはその次
    const group = ACTION_TREE.find((g) => g.label === "ヘルプ");
    const labels = shownEntries(group!.entries, true).map((e) => e.label);

    expect(labels[0]).toBe("作家のタイプ診断");
    expect(labels[1]).toBe("使い方");
  });

  test("「ヘルプ」に「動作を診断」は出ない（ブラウザ版だけ）", () => {
    const group = ACTION_TREE.find((g) => g.label === "ヘルプ");
    const labels = shownEntries(group!.entries, true).map((e) => e.label);

    expect(labels).not.toContain("動作を診断");
    expect(labels).toContain("使い方");
  });

  test("**隠した項目が、画面のどこにも出ていない**", () => {
    // 1つでも漏れると、作者は「設定管理にもメニューにもある」状態になり、
    // どちらが正なのか分からなくなる
    const shown = new Set(visibleMenu().map((line) => line.trim()));

    for (const label of [
      "作者／編集者を切り替える",
      "セットアップを開始",
      "セットアップ",
      "Ollamaのセットアップ",
      "LM Studioのセットアップ",
      "AI相談の強化",
      "機能ごとにAIを割り当てる",
      "Ollamaの実行ファイル位置を指定",
      "意味検索の準備",
    ]) {
      expect(shown.has(label), label).toBe(false);
    }
  });
});
