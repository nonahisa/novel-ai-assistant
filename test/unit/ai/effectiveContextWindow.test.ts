import { describe, expect, it } from "vitest";
import { effectiveContextWindow } from "../../src/ai/ollamaProvider";

/**
 * **関所・分割・送信の3つが、同じ上限を見る**（設計書6.58.4）。
 *
 * 送る直前の関所（`meteredProvider`）は「モデルの上限」と比べて入るかを
 * 判断し、Ollamaへは `num_ctx` を送る。この2つが別の値だと、
 * **関所は「入る」と言うのに Ollama が黙って切り捨てる**——0.22.14 で
 * 塞いだのと同じ穴が開く。
 *
 * 作者が `novelai.ollama.numCtx` を決めているときは、それがこのモデルの
 * 上限である。0.29.10 でこの設定が全機能へ効くようになったぶん、
 * 揃えておかないと穴も全機能へ広がる。
 */
describe("Ollamaの実効の上限", () => {
  it("指定が無ければ、モデルの申告どおり", () => {
    expect(effectiveContextWindow(262144, undefined)).toBe(262144);
  });

  it("指定があれば、そちらまで絞る", () => {
    // **ここが要点。** 絞らないと、関所は262,144と比べて「入る」と言うのに
    // 送るのは8,192になり、入力が黙って切り捨てられる
    expect(effectiveContextWindow(262144, 8192)).toBe(8192);
  });

  it("指定のほうが大きくても、申告値は超えない", () => {
    // モデルが読めない量を「読める」と扱っても、切り捨てられるだけである
    expect(effectiveContextWindow(8192, 262144)).toBe(8192);
  });

  it("0や壊れた値は「指定なし」として扱う", () => {
    // 設定の既定は0で、説明にも「0で自動」と書いてある
    expect(effectiveContextWindow(262144, 0)).toBe(262144);
    expect(effectiveContextWindow(262144, -1)).toBe(262144);
    expect(effectiveContextWindow(262144, Number.NaN)).toBe(262144);
  });
});
