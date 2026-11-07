import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { buildWorkChatPanelHtml } from "../../../src/views/workChatPanelHtml";

/**
 * 横の相談パネル（AIに相談）が、**入力欄の見えないまま開かない**こと（作者の裁定「両方直す」、2026-10-16）。
 *
 * 左の列には作品一覧・簡単ステップメニュー・詳細メニュー・AIに相談の4つが縦に並ぶ。相談は畳んだ形
 * （`visibility: collapsed`）で一番下に置かれ、開くと約100pxまで縮むことがあった（2026-10-23 夜に測ると、
 * 畳んだ区画は戻す高さを持たず、VS Code の区画の最小の高さ 120px で開いていた）。中の作り（上の「相談の対象」・
 * 聞き方の例・入力欄・ボタン2段）は合わせて約150pxあるので、入力欄と［送る］が窓の外へ押し出され、
 * 開いたのに打てない形になった（画面テスト `support/chatInput.ts`）。
 * 2026-10-24 夜の作者の裁定「畳まずに出す」で、`collapsed` を外した。
 *
 * 直しは2段：
 * 1. **最初に出すときの高さを貰う**（`initialSize`）。VS Code は列の高さを、各ビューの重み（指定が無ければ20）
 *    で割って配る。相談に60を付けると、ほかの3つ（20×3）と同じだけ——列の半分を貰う。
 *    ただし効くのは「最初に出すとき」だけで、作者が境目を動かしたあとは作者の高さが勝つ。
 *    **畳んだ区画には使われない**ので、10-16〜10-24 のあいだは値があっても効いていなかった
 * 2. **それでも低いときは、中の作りを詰めて入力欄と［送る］を残す**（WebView の CSS）。
 *    高さを決めるのは VS Code の側で、拡張機能に「この高さにしろ」と言う口は無い。確実に効くのはこちら
 */

const SIDEBAR = buildWorkChatPanelHtml("test-nonce", "vscode-resource:");

function styleOf(html: string): string {
  const found = html.match(/<style nonce="test-nonce">([\s\S]*?)<\/style>/);
  expect(found, "スタイルが見つからない").toBeTruthy();
  return found![1];
}

/** `@media (max-height: Npx) { ... }` の中身と N を取り出す */
function shortBlock(css: string): { limit: number; body: string } | undefined {
  const start = css.search(/@media \(max-height: \d+px\)/);
  if (start === -1) return undefined;
  const limit = Number(/max-height: (\d+)px/.exec(css.slice(start))![1]);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { limit, body: css.slice(open + 1, i) };
  }
  return undefined;
}

describe("横の相談パネルの高さ", () => {
  test("最初に出すとき、ほかの3つのビューと同じだけの高さを貰う（initialSize）", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: {
        views: Record<string, Array<{ id: string; initialSize?: number; visibility?: string }>>;
      };
    };
    const views = manifest.contributes.views.novelai;
    const chat = views.find((view) => view.id === "novelai.chatView");
    // **畳んだ区画には initialSize が使われない**（2026-10-23 夜の測定。開くと最小の120pxに落ちた）。
    // 値があっても畳んでいれば効かないので、畳まないことも一緒に見張る
    expect(chat?.visibility).not.toBe("collapsed");
    /*
      同時に出るビューだけを数える。編集者メニューは編集者モードでだけ出て、そのときは
      簡単ステップメニューが出ない（設計書5.6.6）。どちらのモードでも、相談のほかは3つ
    */
    const shownIn = (mode: "author" | "editor") =>
      views.filter((view) => {
        const when = (view as { when?: string }).when ?? "";
        // 「novelai.editorMode」だけ（前に ! が無い）なら編集者モードでだけ出る
        return mode === "author"
          ? !/(^|[^!])novelai.editorMode/.test(when)
          : !when.includes("!novelai.editorMode");
      });
    const others = Math.max(
      ...(["author", "editor"] as const).map((mode) =>
        shownIn(mode)
          .filter((view) => view.id !== "novelai.chatView")
          .reduce((sum, view) => sum + (view.initialSize ?? 20), 0)
      )
    );
    expect(chat?.initialSize).toBeTypeOf("number");
    expect(chat!.initialSize!).toBeGreaterThanOrEqual(others);
  });

  test("低いときは、聞き方の例・案内・相談の対象・控えのボタンを隠して、入力欄と［送る］を残す", () => {
    const block = shortBlock(styleOf(SIDEBAR));
    expect(block, "低いときの決まり（@media (max-height)）が無い").toBeTruthy();
    // 約100pxに縮んだ形を覆う高さで効かせる
    expect(block!.limit).toBeGreaterThanOrEqual(160);
    for (const hidden of ["#examples", "#context", "#composer .hint", "#thinking", "#apply-settings", "#clear"]) {
      expect(block!.body, `${hidden} を隠していない`).toMatch(
        new RegExp(`${hidden.replace(/[.#]/g, (c) => `\\${c}`)}[^{]*\\{[^}]*display: none`)
      );
    }
    // ［送る］と入力欄は隠さない。［メインに表示］も隠さない——縮んで狭いときこそ大きい画面へ逃げる入口が要る
    // （chatLocateAndMain の2件目は、縮んだ横のパネルでこれを押す）
    for (const kept of ["#send", "#input", "#to-main"]) {
      expect(block!.body, `${kept} を隠している`).not.toMatch(
        new RegExp(`${kept.replace(/[.#]/g, (c) => `\\${c}`)}[^{]*\\{[^}]*display: none`)
      );
    }
    // 入力欄は1行ぶんまで低くしてよい（ふだんの最低54pxのままでは100pxに収まらない）
    expect(block!.body).toMatch(/textarea[^{]*\{[^}]*min-height: (\d+)px/);
    const min = Number(/textarea[^{]*\{[^}]*min-height: (\d+)px/.exec(block!.body)![1]);
    expect(min).toBeLessThanOrEqual(32);
  });

  /*
    2026-11-07、Mac で枠が 217px（詰め方の効く 200px の手前）のとき、細い枠で聞き方の例が折れて
    ［送る］を 44px 枠の外へ押し出した。高さの境目に頼らず、足りない分は会話の欄・札の欄・上の行が
    縮む作りにした。形の確かめは画面の自動テスト（chatSideRoom の2件目）と、静的に組んだ測定で行う。
    ここは、その作りが消えていないことだけを見る
  */
  test("200px の手前でも、縮むのは会話の欄・聞き方の例・上の行で、ボタンの行は縮まない", () => {
    const css = styleOf(SIDEBAR);
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.#>*]/g, (c) => `\\${c}`);
      const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
      expect(found, `${selector} の決まりが無い`).toBeTruthy();
      return found![1];
    };
    expect(rule("#log")).toMatch(/min-height: 0/);
    expect(rule("#composer")).toMatch(/flex-direction: column/);
    expect(rule("#composer")).toMatch(/min-height: 0/);
    // ボタンの行・案内は縮めない（［送る］を残すのが入力の区画の役目）
    expect(rule("#composer > *")).toMatch(/flex: 0 0 auto/);
    // 聞き方の例は高さに上限を置き、あふれた札は欄の中で巻く（消さない）
    expect(rule("#examples")).toMatch(/max-height: \d+px/);
    expect(rule("#examples")).toMatch(/overflow-y: auto/);
    expect(rule("#composer > #examples")).toMatch(/min-height: 0/);
    // 入力欄は、ふだんでも低い枠では1行ぶんまで縮む
    const min = Number(/min-height: (\d+)px/.exec(rule("textarea"))?.[1]);
    expect(min).toBeLessThanOrEqual(32);
  });
});
