import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  openGeneratedMarkdown,
  setGeneratedStorageRoot,
  untitledMarkdownUri,
} from "../../src/views/openDocument";
import { FileSystemError, Uri, commands, workspace } from "./support/vscodeStub";

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
   * **例外はもう無い。** 2026-08-29の一時期、生成文書だけは
   * プレビューで開いていた。保存されていない（untitled の）文書を
   * `*.md` の編集画面が「実在するファイル」として解決しようとして
   * 開けなかったためである。**いまは実ファイルとして置く**ので
   * （設計書6.17.7）、その理由ごと無くなった。
   */
  it("開いたあとにプレビューを横取りしていない", () => {
    const offenders = files.filter((file) =>
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

/**
 * 生成文書は、実ファイルとして置いてから開く（設計書6.17.7）。
 *
 * **無題文書を作らないこと自体が仕様である。** 中身を入れた無題文書は
 * 未保存の変更を抱えたまま残り、VS Code を閉じるときに「見た覚えのない
 * 文書を保存しますか」と聞かれる。実ファイルなら `vscode.open` で開け、
 * 作者が `*.md` へ割り当てた画面もそのまま通る。
 */
describe("生成文書の開き方", () => {
  const ROOT = "C:\\storage\\generated";
  const files = new Map<string, Uint8Array>();
  let executeCommand: ReturnType<typeof vi.fn>;
  let openTextDocument: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    files.clear();
    workspace.fs = {
      createDirectory: vi.fn(async () => undefined),
      stat: vi.fn(async (uri: { fsPath: string }) => {
        if (!files.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      }),
      readDirectory: vi.fn(async () =>
        [...files.keys()].map((full) => [
          full.slice(full.lastIndexOf("\\") + 1),
          1,
        ])
      ),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(uri.fsPath, bytes);
      }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = files.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      }),
      rename: vi.fn(
        async (from: { fsPath: string }, to: { fsPath: string }) => {
          const bytes = files.get(from.fsPath);
          if (!bytes) throw new Error("一時ファイルがありません");
          files.set(to.fsPath, bytes);
          files.delete(from.fsPath);
        }
      ),
      delete: vi.fn(async (uri: { fsPath: string }) => {
        files.delete(uri.fsPath);
      }),
    } as never;

    executeCommand = vi.fn(async () => undefined);
    (commands as { executeCommand?: unknown }).executeCommand = executeCommand;
    openTextDocument = vi.fn();
    (workspace as { openTextDocument?: unknown }).openTextDocument =
      openTextDocument;

    setGeneratedStorageRoot(Uri.file(ROOT) as never);
  });

  it("`vscode.open` で開く（無題文書を作らない）", async () => {
    await openGeneratedMarkdown("使い方", "# 使い方\n");

    const call = executeCommand.mock.calls[0];
    expect(call?.[0]).toBe("vscode.open");
    expect(String(call?.[1])).toContain("使い方_");
    expect(openTextDocument).not.toHaveBeenCalled();
  });

  it("開き方の指定（`preview: false`）をそのまま渡す", async () => {
    // 実ファイルになったので、タブを残す指定が効くようになった
    await openGeneratedMarkdown("使い方", "# 使い方\n", { preview: false });

    expect(executeCommand.mock.calls[0]?.[2]).toEqual({ preview: false });
  });
});
