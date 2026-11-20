import { describe, expect, test } from "vitest";
import { shellOpenCommand, shellOpenSucceeded } from "../../../src/core/openExternalFile";

/**
 * 書き出したファイルをOSの既定のアプリで開く（設計書6.43）。
 *
 * 作者の報告（2026-08-30）：PDF出力で
 * 「Failed to open: 指定されたファイルが見つかりません。(0x2)」が出るのに
 * 「ブラウザで開きました」と告げていた。
 *
 * セキュリティ点検（2026-11-21）：Windows で `cmd /c start "" <パス>` を使っていた。
 * ファイル名は書き出しの題から来て、`sanitizeFileName` は `&` `%` `^` を落とさない。
 * cmd はそれを命令の区切り・変数として読むので、題に `&calc` と書けば別の命令が動く。
 */
describe("既定のアプリで開くコマンド", () => {
  const japanese =
    "C:\\Users\\nonah\\Documents\\novel\\ハイエルフ未亡人のお気楽資産運用～食っちゃ寝しているだけなのに、金融の女王と呼ばれてます～\\.aiwriter\\exports\\print.html";

  test("Windowsは cmd を通さず、explorer.exe に渡す", () => {
    const command = shellOpenCommand("C:\\x\\y.html", "win32", "C:\\Users\\a");
    expect(command?.file).toBe("explorer.exe");
    expect(command?.args).not.toContain("/c");
  });

  test("作業フォルダーはホームにする（作品フォルダーに置かれた explorer.exe を起こさない）", () => {
    // 名前で起こすと、Windows は作業フォルダーを PATH より先に探す
    expect(shellOpenCommand("C:\\x\\y.html", "win32", "C:\\Users\\a")?.cwd).toBe("C:\\Users\\a");
  });

  test("cmd が特別に読む文字（& % ^）が入っていても、パス1つとして渡す", () => {
    const risky = "C:\\書き出し\\題&calc %PATH% ^x,y.pdf";
    const command = shellOpenCommand(risky, "win32", "C:\\Users\\a");
    // **引用符で必ず囲む。** 空白もカンマも無い名前では Node が囲まないので、
    // explorer がカンマで区切って読むのを防ぐため、こちらで囲み、そのまま渡させる
    expect(command?.args).toEqual([`"${risky}"`]);
    expect(command?.windowsVerbatimArguments).toBe(true);
  });

  test("引用符の入ったパスは開かない（Windows のファイル名には入らないので、作り物である）", () => {
    expect(shellOpenCommand('C:\\x\\"y.html', "win32", "C:\\Users\\a")).toBeUndefined();
  });

  test("日本語を含むパスを、符号化せずそのまま渡す", () => {
    // これが 2026-08-30 の不具合の芯である。`openExternal` は Uri をパーセント符号化して
    // OSへ渡すので、日本語のフォルダ名が見つからなくなる
    const command = shellOpenCommand(japanese, "win32", "C:\\Users\\a");
    expect(command?.args.at(-1)).toBe(`"${japanese}"`);
    expect(command?.args.at(-1)).not.toContain("%");
  });

  test("macOSは open、Linuxは xdg-open", () => {
    expect(shellOpenCommand("/tmp/a.html", "darwin")).toEqual({
      file: "open",
      args: ["/tmp/a.html"],
    });
    expect(shellOpenCommand("/tmp/a.html", "linux")).toEqual({
      file: "xdg-open",
      args: ["/tmp/a.html"],
    });
  });

  test("知らないOSでは何も返さない（openExternal へ落とす）", () => {
    expect(shellOpenCommand("/tmp/a.html", "aix")).toBeUndefined();
  });
});

describe("開けたかの判定", () => {
  test("explorer.exe は開けても 1 を返すので、終わり方では決めない（在ることは先に確かめる）", () => {
    expect(shellOpenSucceeded(0, "win32")).toBe(true);
    expect(shellOpenSucceeded(1, "win32")).toBe(true);
  });

  test("macOS・Linux は 0 のときだけ開けた", () => {
    expect(shellOpenSucceeded(0, "darwin")).toBe(true);
    expect(shellOpenSucceeded(1, "darwin")).toBe(false);
    expect(shellOpenSucceeded(4, "linux")).toBe(false);
  });

  test("止められた（終了コードが無い）なら開けていない", () => {
    expect(shellOpenSucceeded(null, "win32")).toBe(false);
    expect(shellOpenSucceeded(null, "linux")).toBe(false);
  });
});
