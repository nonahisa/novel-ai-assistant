import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 「他のメニューを閉じる」（作者の依頼、2026-08-29）。
 *
 * 左側には4つのビューが縦に並ぶ（作品一覧・簡単ステップメニュー・
 * 詳細メニュー・AIに相談）。畳んでも見出しの行は残るので、1つを大きく
 * 使いたいときに邪魔になる。そこで**1つだけを残す**表示を用意した。
 *
 * ## ここで見張るもの
 *
 * `when` 式は package.json の中の**ただの文字列**である。書き間違えても
 * ビルドは通り、型検査も通り、実機で「メニューが出てこない」という形でしか
 * 現れない。しかも出てこないので、直す入口も画面に無い。
 *
 * **いちばん怖いのは、戻り道の無い非表示である。** 消えたまま戻し方が
 * 分からないと、拡張機能が壊れたようにしか見えない（`exitChatFocus` を
 * 作ったときと同じ考え方）。
 */

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string }>;
    views: Record<string, Array<{ id: string; name: string; when?: string }>>;
    menus: Record<
      string,
      Array<{ command: string; when?: string; group?: string }>
    >;
  };
}

const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as Manifest;

/** 左側に縦に並ぶ4つのビューと、`soloView` に入れる短い名前の対応 */
const SIDEBAR_VIEWS = [
  { id: "novelai.works", solo: "works", command: "novelai.soloWorks" },
  { id: "novelai.steps", solo: "steps", command: "novelai.soloSteps" },
  { id: "novelai.actions", solo: "actions", command: "novelai.soloActions" },
  { id: "novelai.chatView", solo: "chat", command: "novelai.soloChat" },
] as const;

function viewWhen(id: string): string {
  const view = pkg.contributes.views["novelai"].find((entry) => entry.id === id);
  if (!view) throw new Error(`ビュー ${id} が package.json にありません`);
  return view.when ?? "";
}

function titleMenu(command: string): Array<{ when: string; group?: string }> {
  return pkg.contributes.menus["view/title"]
    .filter((entry) => entry.command === command)
    .map((entry) => ({ when: entry.when ?? "", group: entry.group }));
}

describe("ビューの出し入れ", () => {
  test("印が立っていなければ、4つとも出る", () => {
    // 既定は今までどおり。**新しい表示を既定にしない**——
    // 印は再起動で消えるので、ここが崩れると全員が困る
    for (const view of SIDEBAR_VIEWS) {
      expect(viewWhen(view.id), view.id).toContain("!novelai.soloView");
    }
  });

  test("自分の名前が立っているときだけ残る", () => {
    for (const view of SIDEBAR_VIEWS) {
      expect(viewWhen(view.id), view.id).toContain(
        `novelai.soloView == '${view.solo}'`
      );
    }
  });

  test("ほかのビューの名前は見ない", () => {
    // 書き写しの間違い（steps の式に works と書く）は、実機で
    // 「2つ残る」「1つも残らない」という形でしか出ない
    for (const view of SIDEBAR_VIEWS) {
      const others = SIDEBAR_VIEWS.filter((entry) => entry.solo !== view.solo);
      for (const other of others) {
        expect(viewWhen(view.id), `${view.id} に ${other.solo}`).not.toContain(
          `soloView == '${other.solo}'`
        );
      }
    }
  });
});

describe("相談に集中する表示との共存", () => {
  test("相談に集中しているときの見え方は、今までどおり", () => {
    // `novelai.focusChat` は、新しい作品のプロット相談を始めるときに
    // 自動で掛かる（設計書6.21.2）。**そのときは相談だけが出る**という
    // 今までの見え方を、印を足したことで変えない
    for (const view of SIDEBAR_VIEWS.filter((entry) => entry.solo !== "chat")) {
      expect(viewWhen(view.id), view.id).toContain("!novelai.focusChat");
    }
  });

  test("相談は、集中しているあいだ必ず出る", () => {
    /*
      **両方の印が同時に立つと、左側が空になりうる。**
      「作品一覧だけを残す」を選んだあとにプロット相談が始まると、
      作品一覧は focusChat で消え、相談は soloView で消える——
      残るビューが1つも無く、戻すボタンもどこにも出ない。

      相談の式に focusChat を先に置いて、この組み合わせを潰す。
    */
    expect(viewWhen("novelai.chatView")).toContain("novelai.focusChat ||");
  });
});

describe("入口と戻り道", () => {
  test("ビューごとに、自分の分だけが出る", () => {
    for (const view of SIDEBAR_VIEWS) {
      const menus = titleMenu(view.command);

      expect(menus, view.command).toHaveLength(1);
      expect(menus[0].when).toBe(
        `view == ${view.id} && !novelai.soloView`
      );
    }
  });

  test("閉じたあとは、残ったビューに戻り道が出る", () => {
    // **戻り道の無い非表示は作らない。** どのビューを残しても、
    // その見出しから全部を出し直せる
    const menus = titleMenu("novelai.showAllViews");

    expect(menus).toHaveLength(SIDEBAR_VIEWS.length);
    for (const view of SIDEBAR_VIEWS) {
      expect(
        menus.map((entry) => entry.when),
        view.id
      ).toContain(`view == ${view.id} && novelai.soloView`);
    }
  });

  test("戻り道はアイコン付きで、見出しにそのまま出る", () => {
    // 「…」の中に隠すと、閉じ込められた人が見つけられない
    for (const entry of titleMenu("novelai.showAllViews")) {
      expect(entry.group).toMatch(/^navigation/);
    }
  });

  test("戻り道はコマンドパレットからも呼べる", () => {
    // 見出しのボタンに気づけなかったときの最後の出口。
    // **ここを塞がない**（入口の4つは名前が同じなので塞いである）
    const hidden = pkg.contributes.menus["commandPalette"]
      .filter((entry) => entry.when === "false")
      .map((entry) => entry.command);

    expect(hidden).not.toContain("novelai.showAllViews");
    for (const view of SIDEBAR_VIEWS) {
      expect(hidden, view.command).toContain(view.command);
    }
  });
});

describe("コマンドの登録", () => {
  const declared = (command: string): { title: string; icon?: string } => {
    const found = pkg.contributes.commands.find(
      (entry) => entry.command === command
    );
    if (!found) throw new Error(`${command} が package.json にありません`);
    return found;
  };

  test("入口はすべて同じ名前で出る", () => {
    // 押した先で残るビューが違うだけで、作者にとっては同じ操作である
    for (const view of SIDEBAR_VIEWS) {
      expect(declared(view.command).title).toBe("他のメニューを閉じる");
    }
    expect(declared("novelai.showAllViews").title).toBe(
      "すべてのメニューを出す"
    );
  });

  test("アイコンが付いている", () => {
    // 見出しのボタンは名前ではなくアイコンで出る。無いと空白になる
    for (const command of [
      ...SIDEBAR_VIEWS.map((view) => view.command),
      "novelai.showAllViews",
    ]) {
      expect(declared(command).icon, command).toBeTruthy();
    }
  });

  test("拡張機能が起動時に登録する", () => {
    // package.json にあってもハンドラが無ければ「コマンドが見つかりません」
    const source = readFileSync("src/extension.ts", "utf-8");

    for (const view of SIDEBAR_VIEWS) {
      expect(source, view.command).toContain(`"${view.command}"`);
      expect(source, view.solo).toContain(`setSoloView("${view.solo}")`);
    }
    expect(source).toContain('"novelai.showAllViews"');
    expect(source).toContain("setSoloView(undefined)");
  });

  test("閉じた状態を覚えない", () => {
    /*
      **再起動で全部が戻る。** 閉じたまま覚えると、出し方を知らない
      作者には拡張機能が壊れたようにしか見えない。
      印は `setContext` にしか置かない（globalState へ書かない）。
    */
    const source = readFileSync("src/extension.ts", "utf-8");
    const stored = source
      .split("\n")
      .filter((line) => line.includes("soloView") && line.includes("State"));

    expect(stored).toEqual([]);
  });
});
