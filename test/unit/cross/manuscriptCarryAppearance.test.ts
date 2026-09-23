import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * **既に開いているタブへも、前の話の見た目を引き継ぐ**（設計書6.25.5）。
 *
 * ## 何が起きていたか
 *
 * 作者の依頼（2026-09-12）は「前の話や次の話でファイル間を動いた場合、
 * 縦書き横書き、書体、倍率は元の設定に合わせて変更してください」だった。
 * 0.47.9 で入れたが、**いちど開いたタブへ移ると効かなかった**。
 *
 * 9巡目に実機で確かめた（0.50.3）——`いじめられっ子_確認用` で
 * `episode_0018` を縦書きにして「次の話 →」を押すと、**既に開いていた
 * `episode_9901` が横書きで出た**。逆に、まだ画面が生きていない話へ
 * 移ったときは縦書きで出る。作者から見ると「効いたり効かなかったりする」。
 *
 * ## なぜか
 *
 * 引き継ぐ値は `pendingAppearance` に置き、**画面が立ち上がるとき
 * （`ready`）に1回だけ取り出す**決まりである。ところが `openWith` は、
 * 既に開いているタブに対しては**そのタブを前に出すだけ**で、新しい画面を
 * 立ち上げない。つまり誰も取りに来ない。置いたままにすると、ずっと後で
 * その原稿を開いたときに古い見た目が当たるので、当時は**置かずに素通り**
 * させていた。素通りした結果が「引き継がれない」だった。
 *
 * ## どう直したか
 *
 * 生きている画面には**こちらから直に送る**（`applyAppearance`）。
 * 置き場を経由しないので、古い値が後から当たることもない。
 *
 * ## このテストの性質
 *
 * 直したのは画面と拡張機能のあいだの配線で、純粋な関数ではない
 * （見た目を決める規則そのものは `manuscriptAppearance.test.ts` が見る）。
 * ここでは**配線が戻っていないこと**をソースの形で押さえる。
 * `menuVisible.test.ts` や `manuscriptRevealLine.test.ts` と同じ考え方である。
 */

const editor = readFileSync("src/features/manuscriptEditor.ts", "utf8");
const html = readFileSync("src/views/manuscriptEditorHtml.ts", "utf8");

describe("前の話の見た目を、既に開いているタブへも当てる", () => {
  test("**素通りが戻っていない**（開いていたら何もしない、をしない）", () => {
    // これが復活したら、作者から見て「効いたり効かなかったり」に戻る
    expect(editor).not.toContain("if (openManuscripts.has(to)) return;");
  });

  test("生きている画面には、置き場を通さず直に送る", () => {
    expect(editor).toContain("const live = openManuscripts.get(to);");
    expect(editor).toContain("live.applyAppearance(now);");
  });

  test("台帳に `applyAppearance` の口がある", () => {
    expect(editor).toContain("applyAppearance(next: ManuscriptAppearance): void;");
    expect(editor).toContain('type: "applyAppearance", appearance: next');
  });

  test("画面が動き出す前に頼まれたら、`ready` まで待って出す", () => {
    // `revealLine`・`showReading` と同じ作法。待たずに送ると捨てられる
    expect(editor).toContain("let pendingApply: ManuscriptAppearance | undefined;");
    expect(editor).toContain("pendingApply = next;");
    expect(editor).toContain("pendingApply = undefined;");
  });

  test("画面側に受け口があり、縦横・大きさ・面の3つとも当てる", () => {
    expect(html).toContain('} else if (message.type === "applyAppearance") {');
    expect(html).toContain("vertical = message.appearance.vertical;");
    expect(html).toContain("size = message.appearance.size;");
    expect(html).toContain("if (message.appearance.compose && !composeOn) composeEnter();");
    expect(html).toContain(
      "else if (!message.appearance.compose && composeOn) composeLeave();"
    );
  });

  test("当てた見た目を、その原稿の覚えにする", () => {
    // これが無いと、閉じて開き直したときだけ前の見た目に戻る
    const at = html.indexOf('} else if (message.type === "applyAppearance") {');
    expect(at).toBeGreaterThan(0);
    const branch = html.slice(at, at + 900);
    expect(branch).toContain("remember();");
  });
});
