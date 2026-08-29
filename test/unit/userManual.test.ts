import { describe, expect, test } from "vitest";
import { buildUserManual, MANUAL_TITLE } from "../../src/features/openManual";
import { allActions, ACTION_TREE, visibleEntries } from "../../src/views/actionList";
import { STEP_MENU } from "../../src/views/stepMenu";
import { canRunProcesses } from "../../src/core/runtime";

/**
 * 使い方のマニュアル（作者の要望、2026-08-28）。
 *
 * 作者はプログラマではない。操作は120個以上あり、ホバーで1つずつ読むしか
 * 無かった。**説明文を手で書かない**——メニューの定義から作るので、
 * 機能を足しても古びない。ここではその「古びなさ」を見張る。
 */

const MANUAL = buildUserManual();

describe("マニュアルの骨組み", () => {
  test("見出しと3つの章がある", () => {
    expect(MANUAL).toContain(`# ${MANUAL_TITLE}`);
    expect(MANUAL).toContain("## 作品づくりの流れ");
    expect(MANUAL).toContain("## 操作の一覧");
    expect(MANUAL).toContain("## 画面と考え方");
  });

  test("流れが、操作の一覧より先に来る", () => {
    // 初めて使う人が知りたいのは「どの順でやるか」である
    expect(MANUAL.indexOf("## 作品づくりの流れ")).toBeLessThan(
      MANUAL.indexOf("## 操作の一覧")
    );
  });

  test("どこに置いたのかを、先に書く", () => {
    // **前は「保存はしていない」と断っていた。** 無題文書をやめて
    // 実ファイルにしたので（設計書6.17.7）、断る中身が変わった。
    // いま伝えるべきは「作品と一緒にGitHubへ行かない」「溜まらない」の2つ
    expect(MANUAL).toContain("拡張機能の保管庫");
    expect(MANUAL).toContain("同期しません");
    expect(MANUAL).toContain("自動で消える");
  });
});

describe("メニューから作る（手で書き写さない）", () => {
  test("段階が、メニューと同じ並びで出る", () => {
    // **番号で拾わない。** 最下段の「ヘルプ」には番号が無く、
    // 番号だけを見ていると、増やした段が抜けても気づけない
    // （番号なしの段を足した2026-08-29に、実際にこの検査が空振りしかけた）。
    // 章を切り出してから見出しを数える
    const chapter = MANUAL.slice(
      MANUAL.indexOf("## 作品づくりの流れ"),
      MANUAL.indexOf("## 操作の一覧")
    );
    const headings = [...chapter.matchAll(/^### (.+)$/gm)].map((m) => m[1]);

    expect(headings).toEqual(STEP_MENU.map((step) => step.label));
  });

  test("詳細メニューの分類が、すべて章になる", () => {
    for (const group of ACTION_TREE.filter((entry) => !entry.generated)) {
      expect(MANUAL, group.label).toContain(`### ${group.label}`);
    }
  });

  test("いまの環境で使える操作の名前が、すべて載る", () => {
    // **1つでも欠けると、その機能は存在しないのと同じになる。**
    // ここが落ちたら、載せないと決めた理由を書いてから外すこと。
    //
    // ブラウザ版だけの操作（`browserOnly`）は、メニューに出ないので
    // マニュアルにも出さない——**画面に無い操作を案内しない**という、
    // AIへ渡す一覧（featureGuide）と同じ規則である
    const shown = visibleEntries(
      ACTION_TREE.filter((group) => !group.generated).flatMap(
        (group) => group.entries
      ),
      canRunProcesses()
    ).flatMap((entry) =>
      entry.kind === "section"
        ? visibleEntries(entry.items, canRunProcesses())
        : [entry]
    );

    expect(shown.length).toBeGreaterThan(50);
    const missing = shown
      .map((action) => action.label)
      .filter((label) => !MANUAL.includes(label));

    expect(missing).toEqual([]);
  });

  test("環境で隠れる操作のぶんしか、減っていない", () => {
    // 「全部載っている」が、絞り込みの取り違えで骨抜きにならないようにする
    const hidden = allActions().filter(
      (action) => !MANUAL.includes(action.label)
    );

    for (const action of hidden) {
      expect(
        action.browserOnly || action.devOnly,
        `${action.command} が理由なく落ちている`
      ).toBeTruthy();
    }
  });

  test("AIを使う操作には、その印が付く", () => {
    // クラウドのAIは実行のたびに課金される。押す前に見分けられないと、
    // 作者は料金の発生する操作を知らずに押すことになる
    const usesAI = allActions().find((action) => action.usesAI);
    expect(usesAI).toBeDefined();

    const line = MANUAL.split("\n").find((entry) =>
      entry.startsWith(`- ${usesAI!.label}`)
    );
    expect(line, usesAI!.label).toContain("（AIを使う）");
  });

  test("画面と考え方は、AIへ渡している説明と同じ出どころ", () => {
    // 文面を2か所に持つと、AIの言うこととマニュアルが食い違う
    expect(MANUAL).toContain("設定/plot.md");
    expect(MANUAL).toContain("### 画面");
    expect(MANUAL).toContain("### この拡張機能の考え方");
  });
});

describe("読み物として整っている", () => {
  test("強調の記号が本文に残らない", () => {
    // メニューのホバーは Markdown の強調が効くが、そのまま持ってくると
    // 説明文の中に記号が散らばる
    expect(MANUAL).not.toContain("*".repeat(2));
  });

  test("説明の無い操作を並べない", () => {
    // 名前だけ並んでいても、何が起きるのか分からない
    const empty = MANUAL.split("\n").filter((line) => /^ *- [^:]+: *$/.test(line));

    expect(empty).toEqual([]);
  });
});
