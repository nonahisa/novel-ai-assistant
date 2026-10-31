import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pickHintedWork } from "../../../src/core/workTarget";

/**
 * 画面で「この作品」と指しているなら、選び直させない
 * （作者の指摘。設計書6.68.2／6.104）。
 *
 * ## 何が起きていたか
 *
 * 相談パネルには作品名が出ているのに、そこから案内の札でターゲット読者診断へ
 * 入ると、**いま相談している作品をもう一度選ばされた**。`resolveWork` が
 * 引数（ツリーの節点）しか見ておらず、相談パネルが覚えている作品を
 * 知る口も無かったためである。
 *
 * `workAlreadyChosen.test.ts` は「名指しできる場所から名指しを落としていないか」
 * を見る。こちらはその先——**名指しが無いときに、何を当てどころにしてよいか**。
 */

describe("作品の当てどころ", () => {
  test("相談の対象があれば、それを使う（訊かない）", () => {
    expect(
      pickHintedWork({
        registeredIds: ["w-1", "w-2", "w-3"],
        chatTargetId: "w-2",
      })
    ).toEqual({ workId: "w-2", source: "chat" });
  });

  test("ツリーの選択が、相談の対象より先", () => {
    // 作品一覧は「いまどの作品を見ているか」をいちばん直接に表している。
    // 相談は、別の作品を見始めたあとも前の作品のまま残ることがある
    expect(
      pickHintedWork({
        registeredIds: ["w-1", "w-2", "w-3"],
        treeSelectedId: "w-3",
        chatTargetId: "w-2",
      })
    ).toEqual({ workId: "w-3", source: "tree" });
  });

  test("当てどころが無ければ、決めずに返す（作者に訊く）", () => {
    expect(pickHintedWork({ registeredIds: ["w-1", "w-2"] })).toBeUndefined();
  });

  /**
   * **登録から外れた作品を当てどころにしない。** ツリーの選択も相談の対象も、
   * 作品を登録から外したあとしばらく残る。外れたIDで進むと、
   * 「その作品は無い」と言われるか、もっと悪ければ別の作品に当たる
   */
  test("登録簿に無いIDは当てにしない", () => {
    expect(
      pickHintedWork({
        registeredIds: ["w-1", "w-2"],
        treeSelectedId: "w-9",
        chatTargetId: "w-9",
      })
    ).toBeUndefined();
  });

  test("1作品しか無ければ、画面が何を指していてもそれ", () => {
    expect(
      pickHintedWork({ registeredIds: ["w-1"], chatTargetId: "w-9" })
    ).toEqual({ workId: "w-1", source: "single" });
  });

  /*
    相談から光らせた詳細メニューの項目を押した1回（作者の判断 2026-11-01）。
    作品一覧の選択より先に相談の作品を使う
  */
  test("光らせた項目を押した1回は、作品一覧の選択より相談の作品が先", () => {
    expect(
      pickHintedWork({
        registeredIds: ["w-1", "w-2", "w-3"],
        treeSelectedId: "w-3",
        chatTargetId: "w-2",
        spotlightWorkId: "w-2",
      })
    ).toEqual({ workId: "w-2", source: "chat" });
  });

  test("光らせた作品が登録から外れていれば、ふだんの順へ戻る", () => {
    expect(
      pickHintedWork({
        registeredIds: ["w-1", "w-2", "w-3"],
        treeSelectedId: "w-3",
        spotlightWorkId: "w-9",
      })
    ).toEqual({ workId: "w-3", source: "tree" });
  });

  test("作品が1つも無ければ、当てどころは無い", () => {
    expect(pickHintedWork({ registeredIds: [] })).toBeUndefined();
  });

  /*
    配線（`resolveWork` が当てどころを見ること、**見えている画面だけ**を
    当てにすること）はソースの形で押さえる。畳んだツリーや閉じた相談から
    当てると、作者から見れば「関係のない作品が勝手に選ばれた」ことになる。
  */
  test("resolveWork が当てどころを見ており、見えている画面だけを渡している", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/extension.ts"),
      "utf8"
    );
    const body = source.slice(source.indexOf("async function resolveWork("));

    expect(body).toContain("pickHintedWork({");
    // 見えているときだけ当てにする（畳んだツリー・閉じた相談からは当てない）
    const hints = source.slice(source.indexOf("workTargetHints = () => ({"));
    expect(hints).toContain("worksView?.visible");
    expect(hints).toContain("workChatPanel.isVisible()");
    expect(hints).toContain("workChatPanel.currentWorkId()");
  });

  /*
    相談から光らせた詳細メニューの項目（作者の判断 2026-11-01）。命令名を知って
    いるのはコマンドの包みだけなので、包みが光らせた項目かを見分けて当てどころへ渡す。
    渡す先が作品を訊く場面（`workTargetHints`）であることをソースの形で押さえる
  */
  test("コマンドの包みが光らせた項目を見分け、作品を訊く場面へ渡している", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/extension.ts"),
      "utf8"
    );
    const wrapper = source.slice(
      source.indexOf("const registerCommand: typeof vscode.commands.registerCommand")
    );
    const litAt = wrapper.indexOf("spotlightWorkFor?.(command)");
    expect(litAt, "包みが光らせた項目を見ていない").toBeGreaterThan(0);
    // 関門より先（前提の関門が作品を訊く場面でも同じ作品になるように）
    expect(litAt).toBeLessThan(wrapper.indexOf("guardWorkKind(command, args)"));
    expect(wrapper.slice(litAt, litAt + 200)).toContain("args[0] === undefined");

    const hints = source.slice(source.indexOf("workTargetHints = () => ({"));
    expect(hints.slice(0, 1500)).toContain("spotlightWorkId:");
    expect(source).toContain("actionSpotlight.takeWorkFor(command)");
  });
});
