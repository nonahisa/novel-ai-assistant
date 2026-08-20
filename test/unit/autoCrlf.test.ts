import { describe, expect, test, vi } from "vitest";
import {
  describeAutoCrlfRisk,
  readAutoCrlf,
  rewritesLineEndings,
} from "../../src/core/git";

/**
 * `core.autocrlf` の警告（設計書5.5.1）。
 *
 * **gitの書き換えは、この拡張機能の管轄外である。**
 * 本拡張機能は「文字コード・改行コードを保持して書き戻す」を最優先の
 * 決まりにしているが、`git pull` は `core.autocrlf` が有効だと
 * **チェックアウトのときに改行を書き換える。**
 *
 * Windowsでは既定で `true` のことが多い。**LFで書いた原稿が、取り込んだ
 * だけでCRLFに変わる。** 止める手立ては無いので、起きうることを伝える。
 */
function runner(code: number, stdout = "") {
  return vi.fn(async () => ({ code, stdout, stderr: "" }));
}

describe("設定を読む", () => {
  test("値をそのまま返す", async () => {
    const run = runner(0, "true\n");

    expect(await readAutoCrlf("C:/works/x", run)).toBe("true");
    expect(run).toHaveBeenCalledWith(
      ["config", "core.autocrlf"],
      "C:/works/x",
      expect.any(Number)
    );
  });

  test("大文字で書かれていても読める", async () => {
    expect(await readAutoCrlf("C:/works/x", runner(0, "TRUE"))).toBe("true");
  });

  test("設定が無ければ undefined", async () => {
    // **未設定は失敗ではない。** git config は非0で返す
    expect(await readAutoCrlf("C:/works/x", runner(1))).toBeUndefined();
  });

  test("空で返っても undefined", async () => {
    expect(await readAutoCrlf("C:/works/x", runner(0, "\n"))).toBeUndefined();
  });
});

describe("書き換わるかの判定", () => {
  test("true なら書き換わる", () => {
    // チェックアウトでCRLFへ、コミットでLFへ変える
    expect(rewritesLineEndings("true")).toBe(true);
  });

  test("input は書き換えない", () => {
    // コミットでLFへ変えるだけ。チェックアウトでは触らない
    expect(rewritesLineEndings("input")).toBe(false);
  });

  test("false と未設定は書き換えない", () => {
    expect(rewritesLineEndings("false")).toBe(false);
    expect(rewritesLineEndings(undefined)).toBe(false);
  });
});

describe("作者への伝え方", () => {
  const message = describeAutoCrlfRisk();

  test("何が起きるかを言う", () => {
    expect(message).toContain("改行コードが書き換わる");
  });

  test("こちらでは止められないことを言う", () => {
    // **できないことを、できるように見せない**
    expect(message).toContain("止められません");
  });

  test("どうすれば止まるかを言う", () => {
    // **理由だけでは動けない**
    expect(message).toContain("git config core.autocrlf false");
  });

  test("投稿サイトの原稿への影響に触れる", () => {
    // ダウンロードした形をそのまま置いている作品がある
    expect(message).toContain("ダウンロード");
  });
});
