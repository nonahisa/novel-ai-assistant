import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { untitledMarkdownUri } from "../../src/views/openDocument";

/**
 * ファイルは、作者の既定のエディターで開く（設計書6.17.6）。
 *
 * **`openTextDocument(Uri) + showTextDocument` は、常に素のテキスト
 * エディターで開く。** 作者が `workbench.editorAssociations` で `*.md` に
 * Markdown のエディターを割り当てていても無視される。
 *
 * 実際に起きた（2026-08-21、作者が実機で発見）。`plot.md` だけが
 * 「テキスト エディター」で開き、記法がそのまま並んでいた。作品一覧から
 * 開いた `.md` は Markdown のエディターで出るのに、こちらだけ違っていた。
 *
 * **画面上で作る文書も対象である**（2026-08-27に直した）。以前ここには
 * 「`openTextDocument({content, language})` はURIを持たないので対象外」と
 * 書いてあったが、**間違いだった**——`untitled:` のURIを持っている。
 * 作者から「反映待ちの更新がデフォルトで開かない」と報告があり、それが
 * まさにこの形だった。
 *
 * ただし `vscode.open` へ渡すだけでは足りない。**名前が `Untitled-1` だと、
 * `*.md` の割り当てに当たらない。** 名前を付けて作る必要がある
 * （`views/openDocument.ts` の `openGeneratedMarkdown`）。
 */

/**
 * エディターの実体（`TextEditor`）が要るので、そのままにしてよい場所。
 *
 * 該当行へ飛ぶ・選択範囲を作る操作には返り値が要る。`vscode.open` は
 * 何も返さないので置き換えられない。**なぜ例外なのかを、ここに書いておく。**
 */
const NEEDS_EDITOR = new Map([
  ["src/features/proposalPanel.ts", "指摘の該当行へ飛び、そこを選択する"],
  ["src/features/ruby.ts", "選んだ範囲へルビを差し込む"],
  ["src/features/workChatPanel.ts", "相談で引用した箇所を選択する"],
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith(".ts")) out.push(path.split("\\").join("/"));
  }
  return out;
}

describe("ファイルは既定のエディターで開く", () => {
  const files = sources("src");

  it("走査する対象がある", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("実ファイルを openTextDocument で開いていない", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (NEEDS_EDITOR.has(file)) continue;
      const text = readFileSync(file, "utf-8");
      // `openTextDocument(` のあとに `vscode.Uri` が続く形だけを見る。
      // `openTextDocument({content, language})` は画面上の文書なので対象外
      if (/openTextDocument\(\s*\r?\n?\s*vscode\.Uri/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("例外の一覧が、実在するファイルを指している", () => {
    // 消えたファイルを許し続けると、一覧が形だけになる
    for (const file of NEEDS_EDITOR.keys()) {
      expect(files, file).toContain(file);
    }
  });

  /**
   * その場で作るMarkdownは、`openGeneratedMarkdown` を通す。
   *
   * `openTextDocument({content, language: "markdown"})` は名前を付けられず、
   * `Untitled-1` になる。**それでは `*.md` の割り当てに当たらない**ので、
   * `vscode.open` へ渡しても直らない。名前付きで作る道は助けの中だけにある。
   *
   * **1か所に寄せておかないと、次にMarkdownを見せる場面を足した人が同じ
   * 書き方をする**（`plot.md` の件のあと、4か所に増えていた）。
   */
  it("画面上で作るMarkdownが、開き方の助けを通っている", () => {
    const offenders = files.filter((file) =>
      /language:\s*"markdown"/.test(readFileSync(file, "utf-8"))
    );
    expect(offenders).toEqual([]);
  });

  /**
   * どの画面で読むかは作者が決める。
   *
   * `markdown.showPreview` を後から呼ぶと、作者が既定にした画面を
   * 開いた直後に押しのけることになる（`generateSettingsDocs.ts` に
   * 同じ趣旨が書いてある）。
   *
   * **例外は `openDocument.ts` の生成文書だけ。** 保存されていない
   * （untitled の）生成Markdownは、`*.md` に割り当てられた編集画面が
   * 「実在するファイル」として解決しようとして**開くこと自体に失敗する**
   * （作者の実機報告、2026-08-29——執筆再開・マニュアルが全滅した）。
   * 選んだ画面で開けない以上「押しのけ」ではなく、読むための文書を
   * 組んだ表示（プレビュー）で確実に開く。実ファイルを開く経路
   * （`openInDefaultEditor`）は引き続きこの決まりの対象である。
   */
  it("開いたあとにプレビューを横取りしていない（生成文書の例外を除く）", () => {
    const allowed = "src/views/openDocument.ts";
    const offenders = files.filter(
      (file) =>
        !file.endsWith(allowed.split("/").pop() as string) &&
        /executeCommand\(\s*"markdown\.showPreview"/.test(
          readFileSync(file, "utf-8")
        )
    );
    expect(offenders).toEqual([]);
  });

  it("例外のファイルは、本当にエディターの実体を使っている", () => {
    for (const [file, why] of NEEDS_EDITOR) {
      const text = readFileSync(file, "utf-8");
      // 返り値を受けずに showTextDocument だけ呼んでいるなら、例外の必要が無い。
      // 変数へ入れる形と、そのまま返す形の両方がある
      const usesEditor =
        /(?:const|let)\s+\w+\s*=\s*(?:\(?await\s+)?vscode\.window\.showTextDocument/.test(
          text
        ) || /return\s+vscode\.window\.showTextDocument/.test(text);
      expect(usesEditor, `${file}（${why}）`).toBe(true);
    }
  });
});

/**
 * 保存されていない文書にも、`.md` の名前を付ける。
 *
 * **ここが `Untitled-1` だと、直したことにならない。** 作者が `*.md` へ
 * 割り当てたエディターは名前のかたちで選ばれるので、拡張子が無ければ
 * 当たらず、`vscode.open` に渡しても素のテキストのままになる。
 */
describe("その場で作るMarkdownの名前", () => {
  it("`.md` で終わる untitled のURIになる", () => {
    const uri = untitledMarkdownUri("反映待ちの更新", []);
    expect(uri.scheme).toBe("untitled");
    expect(uri.path).toBe("反映待ちの更新.md");
  });

  it("同じ名前が開いていたら、番号を振って避ける", () => {
    // 避けないと `openTextDocument` が前の文書を返し、
    // そこへ中身を差し込むことになる（前回の内容と混ざる）
    const taken = ["反映待ちの更新.md", "反映待ちの更新-2.md"];
    expect(untitledMarkdownUri("反映待ちの更新", taken).path).toBe(
      "反映待ちの更新-3.md"
    );
  });

  it("URIの区切りと混ざる文字を落とす", () => {
    expect(untitledMarkdownUri("A/B:C?D#E", []).path).toBe("ABCDE.md");
  });

  it("名前が空になっても、拡張子は残る", () => {
    // 表示名は呼び出し側が決めるが、万一空でも `.md` を失わない
    expect(untitledMarkdownUri("///", []).path).toBe("無題.md");
  });
});
