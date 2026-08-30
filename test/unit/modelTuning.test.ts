import { describe, expect, test } from "vitest";
import {
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  modelTuningKey,
  parseModelTuning,
  recommendTimeoutSeconds,
} from "../../src/core/modelTuning";

/**
 * AIチューニングの台帳（設計書6.49）。
 *
 * 測った値を `sakura.contextWindow` のような**プロバイダ単位の設定1つ**へ
 * 書いていたので、`gpt-oss-120b` で131,072と測ったあと別のモデルへ
 * 切り替えると、その値のまま使われていた。鍵にモデル名を含めるのが要点で、
 * 「モデルを変えたら切り替わる」は仕組みではなく鍵の形で満たす。
 */
describe("台帳の鍵", () => {
  test("プロバイダIDとモデル名を組にする", () => {
    expect(modelTuningKey("ollama", "gemma4:e4b")).toBe("ollama/gemma4:e4b");
    expect(modelTuningKey("sakura", "gpt-oss-120b")).toBe(
      "sakura/gpt-oss-120b"
    );
  });

  test("同じモデル名でもプロバイダが違えば別の鍵になる", () => {
    // 同名モデルが別のサービスで配られることは珍しくない。
    // 混ざると、手元の3Bで測った待ち時間をクラウドの120Bへ当ててしまう
    expect(modelTuningKey("ollama", "gpt-oss-120b")).not.toBe(
      modelTuningKey("sakura", "gpt-oss-120b")
    );
  });
});

describe("台帳の読み取り", () => {
  test("そろった項目をそのまま読む", () => {
    const table = parseModelTuning({
      "ollama/gemma4:e4b": {
        contextWindow: 131072,
        timeoutSeconds: 300,
        measuredChars: 91000,
        measuredAt: "2026-08-30T11:00:00.000Z",
      },
    });

    expect(table.get("ollama/gemma4:e4b")).toEqual({
      contextWindow: 131072,
      timeoutSeconds: 300,
      measuredChars: 91000,
      measuredAt: "2026-08-30T11:00:00.000Z",
    });
  });

  test("壊れた項目だけを捨てて、ほかは読む", () => {
    // **設定は作者が手で編集できる。** 1か所の書き間違いで台帳ごと
    // 読めなくなると、ほかのモデルの測定結果まで巻き添えで消える
    const table = parseModelTuning({
      "ollama/壊れ": "文字列だった",
      "ollama/配列": [1, 2],
      "ollama/空": null,
      "sakura/gpt-oss-120b": { contextWindow: 131072 },
    });

    expect([...table.keys()]).toEqual(["sakura/gpt-oss-120b"]);
    expect(table.get("sakura/gpt-oss-120b")?.contextWindow).toBe(131072);
  });

  test("数が0や負や非数の欄は捨て、同じ項目のほかの欄は残す", () => {
    // 「上限0トークン」は送る前から失敗が決まった値である。
    // だからといって、一緒に入っていた待ち時間まで捨てる理由は無い
    const table = parseModelTuning({
      "ollama/a": { contextWindow: 0, timeoutSeconds: 300 },
      "ollama/b": { contextWindow: -1, timeoutSeconds: 240 },
      "ollama/c": { contextWindow: "131072", timeoutSeconds: 210 },
      "ollama/d": { contextWindow: Number.NaN, timeoutSeconds: 190 },
    });

    for (const key of ["ollama/a", "ollama/b", "ollama/c", "ollama/d"]) {
      expect(table.get(key)?.contextWindow, key).toBeUndefined();
      expect(table.get(key)?.timeoutSeconds, key).toBeGreaterThan(0);
    }
  });

  test("読める欄が1つも残らない項目は落とす", () => {
    const table = parseModelTuning({ "ollama/a": { contextWindow: 0 } });

    expect(table.size).toBe(0);
  });

  test("measuredAt が文字列でなければ捨てるが、測った値は残す", () => {
    // 時刻は「いつ測ったか」を思い出すためだけの欄である。
    // 書き間違いで、測り直さないと戻らない上限まで道連れにしない
    const table = parseModelTuning({
      "ollama/a": { contextWindow: 8192, measuredAt: 20260830 },
      "ollama/b": { contextWindow: 8192, measuredAt: "   " },
    });

    expect(table.get("ollama/a")).toEqual({ contextWindow: 8192 });
    expect(table.get("ollama/b")).toEqual({ contextWindow: 8192 });
  });

  test("配列・null・数・未設定は、台帳ではないので空として読む", () => {
    for (const raw of [[], null, undefined, 42, "文字列"]) {
      expect(parseModelTuning(raw).size, String(raw)).toBe(0);
    }
  });

  test("空の鍵は使えないので落とす", () => {
    // `プロバイダID/モデル名` の形でないものは、引くときに当たらない
    expect(parseModelTuning({ "   ": { timeoutSeconds: 300 } }).size).toBe(0);
  });
});

describe("待ち時間の見立て", () => {
  /**
   * `Math.min(600, Math.max(180, Math.ceil(秒 * 3 / 30) * 30))`。
   *
   * ×3は、測定の出力が合言葉だけで極端に短いため（実際の機能は長い出力を
   * 返し、生成時間の大半は出力側にかかる）。下限180はいまの既定を
   * 下回らせないため。上限600は、それ以上待たせるくらいなら設定を
   * 見直すべきだから。30秒刻みは、設定画面で読みやすくするため。
   */
  test("速すぎても、いまの既定より短くしない", () => {
    expect(recommendTimeoutSeconds(10)).toBe(MIN_TIMEOUT_SECONDS);
    expect(recommendTimeoutSeconds(10)).toBe(180);
  });

  test("実測に3倍の余裕を持たせ、30秒刻みに丸める", () => {
    expect(recommendTimeoutSeconds(70)).toBe(210);
    // 作者のログの90%点。3倍の372秒を30秒刻みへ切り上げる
    expect(recommendTimeoutSeconds(124)).toBe(390);
  });

  test("上限を超えない", () => {
    expect(recommendTimeoutSeconds(300)).toBe(MAX_TIMEOUT_SECONDS);
    expect(recommendTimeoutSeconds(300)).toBe(600);
    expect(recommendTimeoutSeconds(10_000)).toBe(600);
  });

  test("必ず30秒の倍数になる", () => {
    for (const seconds of [61, 70, 99, 124, 150, 199]) {
      expect(recommendTimeoutSeconds(seconds) % 30, `${seconds}秒`).toBe(0);
    }
  });

  test("測れていないときは既定を動かさない", () => {
    // 0や負を掛けて「30秒」にすると、測っていないのに設定を短くしてしまう
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recommendTimeoutSeconds(seconds), String(seconds)).toBe(
        MIN_TIMEOUT_SECONDS
      );
    }
  });
});
