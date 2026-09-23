import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { checkDictionaryFreshness } from "../../src/core/imeDictionaryStatus";
import { FileType, Uri, workspace } from "./support/vscodeStub";

/**
 * 「書き出したIME辞書が古くなっていないか」の判定（設計書6.13）。
 *
 * 辞書を取り込むのは作者の手作業で、自動化する手段がどのIMEにも無い。
 * 設定資料を増やしても書き出し直すまで新しい語は変換に出ないので、
 * 作者から見ると「抽出したのに変換に出ない」としか見えない。
 */

const settingsDir = "C:\\novels\\work\\設定";

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

describe("IME辞書の新しさ", () => {
  /** パス -> 更新時刻。フォルダは末尾なしで持つ */
  const files = new Map<string, number>();

  beforeEach(() => {
    files.clear();

    workspace.fs.stat = (async (uri: { fsPath: string }) => {
      const mtime = files.get(uri.fsPath);
      if (mtime === undefined) throw new Error("FileNotFound");
      return { mtime };
    }) as never;

    workspace.fs.readDirectory = (async (uri: { fsPath: string }) => {
      const prefix = `${uri.fsPath}\\`;
      const entries: Array<[string, FileType]> = [];
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const name = filePath.slice(prefix.length);
        if (name.includes("\\")) continue; // 直下だけ
        entries.push([name, FileType.File]);
      }
      if (entries.length === 0) throw new Error("FileNotFound");
      return entries;
    }) as never;
  });

  /** 設定資料のJSONを1件置く */
  function putSetting(directory: string, name: string, mtime: number): void {
    files.set(diskPath(path.join(settingsDir, directory, name)), mtime);
  }

  /** 書き出し済みの辞書を置く */
  function putDictionary(name: string, mtime: number): void {
    files.set(diskPath(path.join(settingsDir, name)), mtime);
  }

  test("一度も書き出していなければ「古い」と言わない", () => {
    // 使っていない作者を催促しない
    putSetting("characters", "char_001_灯.json", 300);

    return expect(checkDictionaryFreshness(settingsDir)).resolves.toEqual({
      exported: false,
      stale: false,
    });
  });

  test("辞書のほうが新しければ、古くない", async () => {
    putSetting("characters", "char_001_灯.json", 100);
    putDictionary("ime辞書_MSIME.txt", 200);

    const result = await checkDictionaryFreshness(settingsDir);

    expect(result).toEqual({ exported: true, stale: false });
  });

  test("設定資料のほうが新しければ、古い", async () => {
    putDictionary("ime辞書_MSIME.txt", 200);
    putSetting("characters", "char_001_灯.json", 300);

    const result = await checkDictionaryFreshness(settingsDir);

    expect(result).toEqual({ exported: true, stale: true });
  });

  test("世界観だけを直した場合も気づく", async () => {
    // 種別の足し忘れが繰り返し起きているので、人物以外でも確かめる。
    // 造語（world）はIME辞書に載る種別である
    putDictionary("ime辞書_MSIME.txt", 200);
    putSetting("world", "world_001_聖言.json", 300);

    const result = await checkDictionaryFreshness(settingsDir);

    expect(result.stale).toBe(true);
  });

  test("複数の形式のうち、いちばん新しい辞書と比べる", async () => {
    // 古い形式が残っていても、新しく書き出した形式があれば古くない
    putDictionary("ime辞書_MSIME.txt", 100);
    putDictionary("ime辞書_Google.txt", 400);
    putSetting("characters", "char_001_灯.json", 300);

    const result = await checkDictionaryFreshness(settingsDir);

    expect(result.stale).toBe(false);
  });

  test("設定資料が1件も無ければ、古くない", async () => {
    putDictionary("ime辞書_MSIME.txt", 200);

    const result = await checkDictionaryFreshness(settingsDir);

    expect(result).toEqual({ exported: true, stale: false });
  });

  test("JSON以外のファイルは比べる材料にしない", async () => {
    // 設定フォルダには資料集のMarkdownなど生成物も置かれる。
    // それが新しいだけで「辞書が古い」と言うと、印が消えなくなる
    putDictionary("ime辞書_MSIME.txt", 200);
    files.set(
      diskPath(path.join(settingsDir, "characters", "メモ.md")),
      900
    );

    const result = await checkDictionaryFreshness(settingsDir);

    expect(result.stale).toBe(false);
  });
});
