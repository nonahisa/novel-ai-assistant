import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { tuningScopeTitle } from "../../../src/core/tuningScope";

/**
 * AIチューニングの「何を測りますか」の画面に、測るモデルを出す
 * （実機確認リスト 419 の写真、2026-10-09）。
 *
 * 写真：知らせの［AIチューニングで測る］を押すと4択の画面が出るが、どのモデルを
 * 測るのかがどこにも出ていなかった（測ったあとの知らせで初めて分かる）。
 * 項目の問いは「測る先が、いま割り当てたモデルになっているか」なので、選ぶ前に見せる。
 */
describe("何を測るかの画面の題", () => {
  test("測るモデルが分かれば、題に出す", () => {
    expect(tuningScopeTitle("Ollama / e2e-fake:2b")).toBe(
      "AIチューニング：Ollama / e2e-fake:2b の何を測りますか"
    );
  });

  test("分からなければ（AIが未設定など）、これまでの題のまま", () => {
    expect(tuningScopeTitle(undefined)).toBe("AIチューニング：何を測りますか");
    expect(tuningScopeTitle("")).toBe("AIチューニング：何を測りますか");
  });
});

describe("入口が測るモデルを渡している", () => {
  /** コメントを落とした extension.ts の、AIチューニングのコマンドの登録の中身 */
  function measureCommandBody(): string {
    const source = readFileSync(path.join("src", "extension.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const start = source.indexOf('registerCommand("novelai.measureContext"');
    if (start === -1) throw new Error("AIチューニングのコマンドの登録が見つかりません");
    const end = source.indexOf("registerCommand(", start + 10);
    return source.slice(start, end === -1 ? undefined : end);
  }

  test("選ぶ画面より前に、測る先を副作用の無い resolve で引いて渡す", () => {
    const body = measureCommandBody();
    const ask = body.indexOf("askTuningScope(");
    expect(ask).toBeGreaterThan(-1);
    // 名指しが無ければ割当先（resolve。設定ウィザードも LM Studio の読み込みも起こさない）
    expect(body.indexOf("aiRegistry.resolve(")).toBeGreaterThan(-1);
    expect(body.indexOf("aiRegistry.resolve(")).toBeLessThan(ask);
    // 呼ぶときに何かを渡している（空の括弧で呼ばない）
    expect(body).not.toContain("askTuningScope()");
    // ensureConfigured を選ぶ画面より前へ出さない（設定ウィザードが先に出てしまう）
    const ensure = body.indexOf("ensureConfigured(");
    expect(ensure === -1 || ensure > ask).toBe(true);
  });
});
