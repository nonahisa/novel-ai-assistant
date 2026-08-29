import { describe, expect, test } from "vitest";
import { shellOpenCommand } from "../../src/core/openExternalFile";

/**
 * 書き出したファイルをOSの既定のアプリで開く（設計書6.43）。
 *
 * 作者の報告（2026-08-30）：PDF出力で
 * 「Failed to open: 指定されたファイルが見つかりません。(0x2)」が出るのに
 * 「ブラウザで開きました」と告げていた。
 */
describe("既定のアプリで開くコマンド", () => {
  const japanese =
    "C:\\Users\\nonah\\Documents\\novel\\ハイエルフ未亡人のお気楽資産運用～食っちゃ寝しているだけなのに、金融の女王と呼ばれてます～\\.aiwriter\\exports\\print.html";

  test("Windowsは cmd /c start に、題名の空文字を挟んで渡す", () => {
    // **`start` は cmd の内蔵命令**なので、実行ファイルとしては起動できない。
    // 第1引数の "" はウィンドウ題名で、省くとパスが題名と解釈されて開かない
    expect(shellOpenCommand("C:\\x\\y.html", "win32")).toEqual({
      file: "cmd",
      args: ["/c", "start", "", "C:\\x\\y.html"],
    });
  });

  test("日本語を含むパスを、符号化せずそのまま渡す", () => {
    // これが不具合の芯である。`openExternal` は Uri をパーセント符号化して
    // OSへ渡すので、日本語のフォルダ名が見つからなくなる
    const command = shellOpenCommand(japanese, "win32");
    expect(command?.args.at(-1)).toBe(japanese);
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
