import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 作品の種類（設計書6.109）の配線。
 *
 * 純関数のテスト（`test/unit/core/workKind.test.ts` ほか）は「種類が
 * 分かれば正しく振る舞う」までしか言っていない。**種類を読んで渡して
 * いるか**は、呼ぶ側のコードにしか無い。渡し忘れると、小説と同じ画面・
 * 同じ紙になるだけで何も落ちないので、気づかれにくい。
 */

const read = (file: string): string => readFileSync(file, "utf8");

/** 関数の頭から n 文字（その関数の中を見るため） */
function body(source: string, head: string, length: number): string {
  const at = source.indexOf(head);
  expect(at, `見つからない: ${head}`).toBeGreaterThanOrEqual(0);
  return source.slice(at, at + length);
}

describe("新規作成", () => {
  const create = () => body(read("src/extension.ts"), "async function createNewWork", 5000);

  test("種類を訊き、作品の設定と最初の話へ渡す", () => {
    expect(create()).toContain("chooseWorkKind(");
    // 設定ファイルへ書き、プロットの書き出しも種類で変える
    expect(create()).toMatch(/scaffoldWorkFolder\([\s\S]*?kind,[\s\S]*?\}\);/);
    // 最初の話の雛形と開く向き
    expect(create()).toMatch(/createFirstEpisodeFile\([\s\S]*?format,\s*kind\s*\)/);
  });
});

describe("話を足す", () => {
  test("雛形と開く向きは種類で決める", () => {
    const add = body(read("src/extension.ts"), "新規話数ファイルの名前", 3000);
    expect(add).toContain("readWorkKind(work)");
    expect(add).toContain("newEpisodeTemplate(kind)");
    expect(add).toContain("manuscriptViewTypeFor(kind)");
  });
});

describe("あとから変える", () => {
  test("コマンドを登録し、一覧を描き直す", () => {
    const command = body(read("src/extension.ts"), '"novelai.setWorkKind"', 1200);
    expect(command).toContain("setWorkKind(work)");
    expect(command).toContain("treeProvider.refresh(work.id)");
  });

  test("形式を決め直すとき、形式「脚本」の作品は台本を設定へ移してから書き換える", () => {
    const source = read("src/features/setPlotBasics.ts");
    const main = body(source, "export async function setPlotBasics", 1200);
    expect(main.indexOf("keepScriptKind(")).toBeGreaterThan(-1);
    expect(main.indexOf("keepScriptKind(")).toBeLessThan(
      main.indexOf("writePlotSections(")
    );
  });
});

describe("原稿エディタ", () => {
  const editor = () => read("src/features/manuscriptEditor.ts");

  test("画面は種類で組み立てる", () => {
    const resolve = body(editor(), "async resolveCustomTextEditor(", 2500);
    expect(resolve).toContain("this.kindOfDocument(document)");
  });

  test("下段の字数に、種類の目安を添えて送る", () => {
    const send = body(editor(), "private async sendCount(", 1500);
    expect(send).toContain("measureKindText(");
    expect(send).toContain("measure");
  });
});

describe("出力", () => {
  test("PDFは種類を渡す", () => {
    const pdf = read("src/features/exportPdf.ts");
    expect(pdf).toContain("readWorkKind(work)");
    expect(body(pdf, "buildPrintHtml({", 600)).toContain("kind,");
  });

  test("EPUBは書き出しも画面も種類を渡す", () => {
    expect(body(read("src/features/exportEpub.ts"), "epub = buildEpub({", 800)).toContain(
      "kind: await readWorkKind(work)"
    );
    const panel = read("src/features/epubEditorPanel.ts");
    expect(body(panel, "buildEpubCss(", 600)).toContain("state.source.kind");
    expect(body(panel, "function bodyPage(", 1200)).toContain("kind: source.kind");
  });
});
