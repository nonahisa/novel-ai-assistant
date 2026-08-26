import { describe, expect, test } from "vitest";
import { buildFeatureGuide } from "../../src/features/featureGuide";
import { ACTION_TREE } from "../../src/views/actionList";

const guide = buildFeatureGuide();

function allActions() {
  // 写しの分類（「テスト中」）は案内に入れない。中身は元の操作の写しである
  return ACTION_TREE.filter((group) => !group.generated).flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.kind === "section" ? entry.items : [entry]
    )
  );
}

describe("使い方の説明", () => {
  test("操作メニューの全操作が漏れなく入る", () => {
    // 漏れると、AIは「その機能はありません」と嘘を答える。
    // 説明書を手で書かずメニューの定義から作るのは、これを防ぐため
    for (const action of allActions()) {
      // **画面に出ない操作は、案内にも入れない**（`browserOnly`）。
      // 試験は手元（Nodeあり）で走るので、ブラウザ版だけの操作は外れる
      if (action.browserOnly) continue;
      expect(guide, action.label).toContain(action.label);
    }
  });

  test("ブラウザ版だけの操作は、手元の案内に入れない", () => {
    // 画面に無い操作をAIが案内すると、探しても見つからない
    const browserOnly = allActions().filter((action) => action.browserOnly);

    expect(browserOnly.length).toBeGreaterThan(0);
    for (const action of browserOnly) {
      expect(guide, action.label).not.toContain(action.label);
    }
  });

  test("分類と小分類の見出しが、画面と同じ並びで入る", () => {
    // 並びが画面と違うと「どこにあるか」を答えられない
    // 写しの分類（「テスト中」）は案内に入れない
    const groupPositions = ACTION_TREE.filter((group) => !group.generated).map(
      (group) => guide.indexOf(`■ ${group.label}`)
    );

    expect(groupPositions.every((at) => at >= 0)).toBe(true);
    const sorted = [...groupPositions].sort((a, b) => a - b);
    expect(groupPositions).toEqual(sorted);
  });

  test("AIを使う操作には印を付ける", () => {
    // 料金がかかることを答えられないと、案内として役に立たない
    const line = guide
      .split("\n")
      .find((entry) => entry.includes("誤字脱字を検知"));

    expect(line).toContain("（AIを使う）");
  });

  test("AIを使わない操作には印を付けない", () => {
    const line = guide
      .split("\n")
      .find((entry) => entry.includes("表記ゆれを検知"));

    expect(line).not.toContain("（AIを使う）");
  });

  test("画面の説明を含む（操作メニューに出ないもの）", () => {
    for (const name of ["提案", "設定資料", "作品一覧", "右クリック"]) {
      expect(guide, name).toContain(name);
    }
  });

  test("ファイルの置き場所を含む", () => {
    expect(guide).toContain("設定/plot.md");
    expect(guide).toContain("設定/synopsis.md");
  });

  test("画面用の強調記号を落とす", () => {
    // ** はメニューのホバー表示用。AIへの指示と混ざると読みにくい
    expect(guide).not.toContain("**");
  });

  test("説明文がそのまま入る（要約して意味を変えない）", () => {
    const action = allActions().find(
      (entry) => entry.command === "novelai.checkNotation"
    );
    expect(action).toBeDefined();
    expect(guide).toContain(action!.detail.replace(/\*\*/g, ""));
  });
});
