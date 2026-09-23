import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { TERM_COLORS } from "../../src/core/termColors";
import { buildSettingsPanelHtml } from "../../src/views/settingsPanelHtml";

/**
 * 用語の色は、画面ごとに違ってはならない（作者の指示、2026-08-28
 * 「文字の色分け説明は不要です。代わりに、設定資料パネルのタブを
 * 同じ色分けにしてください」）。
 *
 * 凡例（■登場人物 ■場所 …）を外した以上、**色そのものが説明になる。**
 * 本文で人物が青なら、設定資料パネルの「登場人物」タブも青でなければ、
 * 何の手がかりにもならない。
 *
 * ## 注釈では守れなかった
 *
 * `features/manuscriptEditor.ts` には「termHighlight.ts と同じ色を使う」と
 * 書いてあったが、**実体は16進の写し**だった。写しは片方だけが直る日が
 * 来るので、定義を `core/termColors.ts` の1つにして、
 * **読む側が本当にそこを読んでいるか**を機械で見張る。
 */

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("用語の色は1か所で決める", () => {
  /**
   * 色を使う3か所が、揃って `core/termColors.ts` を読んでいること。
   * import が消えていれば、どこかに写しが戻ったということである。
   */
  it("3つの画面が、同じ定義を読んでいる", () => {
    const readers = [
      "src/views/termHighlight.ts",
      "src/features/manuscriptEditor.ts",
      "src/views/settingsPanelHtml.ts",
    ];
    for (const file of readers) {
      const body = read(file);
      expect(body, file + " が termColors を読んでいない").toMatch(
        /import \{ TERM_COLORS \} from "\.\.\/core\/termColors";/
      );
    }
  });

  /** 写しが残っていないこと（16進をその場に書き戻さない） */
  it("色の16進は、termColors.ts にしか無い", () => {
    const hexes = Object.values(TERM_COLORS).flatMap((pair) => [
      pair.light,
      pair.dark,
    ]);
    const others = [
      "src/views/termHighlight.ts",
      "src/features/manuscriptEditor.ts",
      "src/views/settingsPanelHtml.ts",
    ];
    for (const file of others) {
      const body = read(file);
      for (const hex of hexes) {
        expect(body, file + " に " + hex + " の写しがある").not.toContain(hex);
      }
    }
  });

  /** 本文の色分けがある4種類ぶん、そろっていること */
  it("色分けするのは、人物・場所・能力・組織の4つ", () => {
    expect(Object.keys(TERM_COLORS).sort()).toEqual([
      "ability",
      "character",
      "location",
      "organization",
    ]);
  });
});

/**
 * 設定資料パネルのタブに、本文と同じ色を付ける。
 *
 * **色を付けるのはタブ名の文字色**（本文の用語も文字色なので、表し方を
 * 揃える）。作品情報・世界観は本文の色分けに無いので色を付けない。
 */
describe("設定資料パネルのタブの色分け", () => {
  const html = buildSettingsPanelHtml("NONCE123", "vscode-resource:");

  it("種類ごとの色が、タブの文字色として入っている", () => {
    for (const kind of Object.keys(TERM_COLORS)) {
      expect(html).toContain(
        `#tabs button[data-kind="${kind}"] { color: var(--novelai-${kind}); }`
      );
    }
    // 色分けの無い種類には規則を作らない
    expect(html).not.toContain('#tabs button[data-kind="work"]');
    expect(html).not.toContain('#tabs button[data-kind="world"]');
  });

  /**
   * **明暗の両方を用意する。** VS Code の WebView は body に
   * `vscode-light` / `vscode-dark` / `vscode-high-contrast` を付ける。
   * 明るいほうを既定に置き、暗いテーマだけを上書きする——class が付かない
   * 場面でも色が消えないようにするため。
   */
  it("明るいテーマと暗いテーマの両方の色がある", () => {
    for (const [kind, color] of Object.entries(TERM_COLORS)) {
      expect(html).toContain(`--novelai-${kind}: ${color.light};`);
      expect(html).toContain(`--novelai-${kind}: ${color.dark};`);
    }
    expect(html).toContain("body.vscode-dark, body.vscode-high-contrast {");
    // 既定（class が付かないとき）は明るいほう
    const light = html.indexOf(
      `--novelai-character: ${TERM_COLORS.character.light};`
    );
    const darkBlock = html.indexOf("body.vscode-dark");
    expect(light).toBeGreaterThan(0);
    expect(light).toBeLessThan(darkBlock);
  });

  /** CSSが引ける印を、タブの要素が持っていること */
  it("タブの要素に、種類の印が付く", () => {
    expect(html).toContain('button.setAttribute("data-kind", entry.kind);');
  });
});
