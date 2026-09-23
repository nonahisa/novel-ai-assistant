import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `.txt` を `.md` にしたら、元の名前で開いている面を閉じる（設計書6.12.1）。
 *
 * ## 何が起きていたか
 *
 * **閉じていたのは「MD化の促し」だけだった**（6.12.6）。詳細メニューの
 * 「本文を .md にする」や、作品一覧の右クリックから変換したときは、
 * 元の `.txt` を指したままの面が残っていた（0.75.3 の記録で照合）。
 *
 * 残った面はもう無いファイルを指している。作者がそこへ戻って打ち、保存した
 * 瞬間に**消えたはずの `.txt` が復活する**（VS Code は無くなったファイルへも
 * 保存できる）。同じ話が `.txt` と `.md` の2つになり、走査は両方を話として
 * 数える。**原稿が二重になる**ので、危なさは見た目の引き継ぎより重い。
 *
 * ## このテストの性質
 *
 * 直したのは画面と変換のあいだの配線で、純粋な関数ではない。
 * `renameCarriesAppearance.test.ts` と同じく、**配線が戻っていないこと**を
 * ソースの形で押さえる。
 */

const editor = readFileSync(
  resolve(__dirname, "../../src/features/manuscriptEditor.ts"),
  "utf8"
);
const convert = readFileSync(
  resolve(__dirname, "../../src/features/markdownConvert.ts"),
  "utf8"
);

describe("名前が変わったら、元の名前の面を閉じる", () => {
  test("閉じる口があり、未保存なら閉じない", () => {
    expect(editor).toContain(
      "export function closeRenamedManuscript(from: string): void {"
    );
    const body = editor.slice(
      editor.indexOf("export function closeRenamedManuscript("),
      editor.indexOf("/** 「← 前の話」「次の話 →」を押したときに、次に何をするか */")
    );
    // 開いている面を台帳から引き、閉じるのはその面だけ
    expect(body).toContain("openManuscripts.get(manuscriptLedgerKey(from))");
    expect(body).toContain("open.panel.dispose()");
    // **打ちかけを巻き添えにしない**（未保存なら残す）
    expect(body).toContain("document.isDirty");
  });

  test("**変換の唯一の口から呼ぶ**（1件でもフォルダーまるごとでも通る）", () => {
    const body = convert.slice(
      convert.indexOf("export async function renamePreservingContent("),
      convert.indexOf("export async function importNotation(")
    );
    expect(body).toContain("closeRenamedManuscript(plan.from)");

    // **名前を変えたあとに閉じる。** 前に閉じると、`fs.rename` が失敗した
    // ときに面だけが消える
    const rename = body.indexOf("vscode.workspace.fs.rename(");
    const close = body.indexOf("closeRenamedManuscript(plan.from)");
    expect(rename).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(rename);

    // 呼び出し側それぞれに書かない（片方だけ直る日が来る）
    expect(convert.split("closeRenamedManuscript(").length - 1).toBe(1);
  });

  test("促し側に写しを残さない（始末は1か所）", () => {
    // 促しは `convertToMarkdown`（= `convertOne`）を通るので、
    // そこで閉じ終わっている。ここに写しがあると、片方だけが直る
    expect(editor).not.toContain("stale.panel.dispose()");
  });
});
