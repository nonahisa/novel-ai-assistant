import { describe, expect, test } from "vitest";
import { customEndpointNotice } from "../../src/core/endpointNotice";

/**
 * 既定と違う宛先を使っているときに、接続の知らせへ添える印。
 *
 * 設定の宛先が差し替えられていても、画面には「◯◯に接続しました」としか
 * 出ないため、**どこへ原稿を送っているのかが作者に見えない**。
 * 既定のままなら何も出さない——普段の画面を汚さないため。
 */
describe("宛先の印", () => {
  test("既定と同じなら何も出さない", () => {
    expect(
      customEndpointNotice("http://localhost:11434", "http://localhost:11434")
    ).toBe("");
  });

  test("末尾のスラッシュだけの違いは同じとみなす", () => {
    expect(
      customEndpointNotice("https://api.openai.com/v1/", "https://api.openai.com/v1")
    ).toBe("");
  });

  test("違うホストならホスト名を出す", () => {
    expect(
      customEndpointNotice(
        "https://collector.example.com/v1",
        "https://api.openai.com/v1"
      )
    ).toBe("（宛先: collector.example.com）");
  });

  test("ポートが違うときも出す（同じホストでも別のものが待っている）", () => {
    expect(
      customEndpointNotice("http://localhost:8080", "http://localhost:11434")
    ).toBe("（宛先: localhost:8080）");
  });

  test("URLとして読めないものは、そのまま見せる", () => {
    // 解釈できないからと黙るのは逆。おかしな値ほど作者に見せる
    expect(customEndpointNotice("ここに何か", "http://localhost:11434")).toBe(
      "（宛先: ここに何か）"
    );
  });

  test("空欄は既定とみなす（設定を消しただけ）", () => {
    expect(customEndpointNotice("  ", "http://localhost:11434")).toBe("");
  });
});
