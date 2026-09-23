import { describe, expect, test } from "vitest";
import {
  probeCharsPerToken,
  probeCharsToTokens,
  probeTokensPerChar,
} from "../../src/core/contextProbe";
import { ceilingCharsFor } from "../../src/features/measureContext";
import {
  CHARS_PER_TOKEN,
  CHARS_PER_TOKEN_MARGIN,
  resolveCharsPerToken,
} from "../../src/core/sizeBudget";
import { decideChunkSize } from "../../src/core/chunker";

/**
 * 読める長さの測定の**天井**を、当て推量ではなく実測の換算で置く
 * （設計書6.77。作者の依頼、2026-09-13）。
 *
 * 天井はモデルの文脈長（トークン）を字数へ直して決めていたが、換算が
 * `TOKENS_PER_CHAR`（＝1字1.43トークン）という当て推量だった。日本語の
 * 実測は1トークンあたり1.2〜1.4字あるので、**天井が窓の半分あたりに
 * 置かれていた。**
 *
 * | モデル | 窓 | 天井 | 実測換算での中身 | 使えた割合 |
 * |---|---|---|---|---|
 * | ollama/qwen3:8b | 40,960 | 28,405字 | 約23,000トークン | 56% |
 * | ollama/gemma4:12b | 262,144 | 183,234字 | 約132,000トークン | 50% |
 *
 * どちらも「天井まで伸びが止まらなかった」と出たが、**その天井が窓の
 * 半分だった**のだから、限界を測れてはいない。
 *
 * ここで見るのは3つ。
 *
 * 1. **実測が無ければ、1字も変わらない**（回帰）
 * 2. 天井は**気前のよい換算**で置く（1件から使う／余白を掛けない）
 * 3. 台帳へ書く値・画面に出す値は、これまでどおり**安全側**のまま
 *    ——`decideChunkSize` と行き帰りで同じ換算を使う
 */

/** 実機で測った、そのモデルの字/トークン（`charsPerTokenFromProbe` の値） */
const qwen3の実測 = { charsPerToken: 1.234, charsPerTokenSamples: 3 };
const gemma4の実測 = { charsPerToken: 1.383, charsPerTokenSamples: 3 };

/** 実機のモデルの窓（トークン） */
const qwen3の窓 = 40_960;
const gemma4の窓 = 262_144;

describe("実測が無ければ、天井は1字も変わらない", () => {
  /*
    **ここが崩れたら、実測を持たない全モデルの測定が動いている。**
    下の2つの数字は、作者の実機がそのまま出していた値である。
  */
  test("qwen3:8b の窓（40,960トークン）→ 28,405字（これまでどおり）", () => {
    expect(ceilingCharsFor(qwen3の窓, true)).toBe(28_405);
    expect(ceilingCharsFor(qwen3の窓, true, undefined)).toBe(28_405);
  });

  test("gemma4:12b の窓（262,144トークン）→ 183,234字（これまでどおり）", () => {
    expect(ceilingCharsFor(gemma4の窓, true)).toBe(183_234);
  });

  test("換算そのものも、渡されなければ 0.7 のまま", () => {
    expect(probeCharsPerToken()).toBe(CHARS_PER_TOKEN);
    expect(probeCharsPerToken(undefined)).toBe(CHARS_PER_TOKEN);
    // 逆数も、従来の `TOKENS_PER_CHAR` と同じ値でなければならない
    // （丸めがずれると、天井が1字動く）
    expect(probeTokensPerChar()).toBe(1 / CHARS_PER_TOKEN);
  });
});

describe("実測があれば、天井はそのぶん広がる", () => {
  test("qwen3:8b は 28,405字 → 50,209字（窓のほぼ全部を使う）", () => {
    expect(ceilingCharsFor(qwen3の窓, true, qwen3の実測)).toBe(50_209);

    // **広がった天井が、本当に窓に見合っているか**を実測で数え直す。
    // これまでは23,000トークン（窓の56%）で打ち切っていた
    const 実際のトークン = 50_209 / qwen3の実測.charsPerToken;
    expect(実際のトークン / qwen3の窓).toBeGreaterThan(0.95);
  });

  test("gemma4:12b は 183,234字 → 362,191字", () => {
    expect(ceilingCharsFor(gemma4の窓, true, gemma4の実測)).toBe(362_191);

    const 実際のトークン = 362_191 / gemma4の実測.charsPerToken;
    expect(実際のトークン / gemma4の窓).toBeGreaterThan(0.95);
  });

  test("1件でも実測を使う（5件を待たない）", () => {
    /*
      **測りすぎても壊れない。** 窓に入らない長さを送れば、AIは黙って
      切り捨て、入力トークン数の伸びが止まる——それは新しい測り方が
      正しく「限界」と読む信号である。1回ぶん余計に送るだけで済む。

      いっぽう測り足りないと、天井に当たって終わるだけで、作者には
      「これ以上は試していません」としか出ない。だから1件から使う。
    */
    const 一件 = { charsPerToken: 1.234, charsPerTokenSamples: 1 };
    expect(probeCharsPerToken(一件)).toBe(1.234);
    expect(ceilingCharsFor(qwen3の窓, true, 一件)).toBe(50_209);
  });

  test("余白（0.9）は掛けない", () => {
    expect(probeCharsPerToken(qwen3の実測)).toBe(1.234);
  });
});

describe("実測を使わない場面", () => {
  test("0.7 を下回る実測は、0.7 のまま（これまでより不利にしない）", () => {
    // 実測のほうが辛いモデルでも、いまの値で動いてきた実績があるほうへ
    // 倒す（`resolveCharsPerToken` と同じ約束）
    const 辛い実測 = { charsPerToken: 0.5, charsPerTokenSamples: 5 };
    expect(probeCharsPerToken(辛い実測)).toBe(CHARS_PER_TOKEN);
    expect(ceilingCharsFor(qwen3の窓, true, 辛い実測)).toBe(28_405);
  });

  test("回数が0なら使わない（欄はあっても、測ったことにならない）", () => {
    const 零件 = { charsPerToken: 1.234, charsPerTokenSamples: 0 };
    expect(probeCharsPerToken(零件)).toBe(CHARS_PER_TOKEN);
    expect(ceilingCharsFor(qwen3の窓, true, 零件)).toBe(28_405);
  });

  test("壊れた値は使わない（0・負・NaN・Infinity）", () => {
    // **AIや設定から来た数をそのまま信じない**（実装ルール3）。
    // ここを素通りさせると、天井が 0 字や NaN 字になって測定が壊れる
    for (const 壊れた値 of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const 台帳 = { charsPerToken: 壊れた値, charsPerTokenSamples: 5 };
      expect(probeCharsPerToken(台帳), `charsPerToken=${壊れた値}`).toBe(
        CHARS_PER_TOKEN
      );
      expect(ceilingCharsFor(qwen3の窓, true, 台帳)).toBe(28_405);
    }
  });

  test("回数が壊れていても使わない", () => {
    const 台帳 = { charsPerToken: 1.234, charsPerTokenSamples: Number.NaN };
    expect(probeCharsPerToken(台帳)).toBe(CHARS_PER_TOKEN);
  });
});

describe("天井の換算と、台帳へ書く換算は別物である", () => {
  /*
    **同じ実測から、わざと違う値を作る。** 判断が逆だからである。

    - 天井……測りすぎても壊れない／測り足りないと見えない → 気前よく
    - 台帳……`decideChunkSize` が読んで本文を切る → 安全側（5件・0.9の余白）

    片方を直したときに、もう片方まで動かしていないかを見張る。
  */
  const 五件の実測 = { charsPerToken: 1.234, charsPerTokenSamples: 5 };

  test("天井は 1.234、台帳は 1.234×0.9＝1.1106", () => {
    expect(probeCharsPerToken(五件の実測)).toBe(1.234);
    expect(resolveCharsPerToken(五件の実測)).toBeCloseTo(
      1.234 * CHARS_PER_TOKEN_MARGIN,
      10
    );
    expect(probeCharsPerToken(五件の実測)).toBeGreaterThan(
      resolveCharsPerToken(五件の実測)
    );
  });

  test("台帳へ書くトークン数は、安全側の換算で数える", () => {
    // 天井の換算で数えると、実際に送るより小さい数字を台帳と画面に出す
    const 安全側 = probeCharsToTokens(50_209, 五件の実測);
    expect(安全側).toBe(Math.round(50_209 / resolveCharsPerToken(五件の実測)));
    expect(安全側).toBeGreaterThan(Math.round(50_209 / 1.234));
  });

  test("渡されなければ、トークン数もこれまでどおり", () => {
    expect(probeCharsToTokens(22_400)).toBe(
      Math.round(22_400 / CHARS_PER_TOKEN)
    );
  });
});

describe("台帳へ書く値と、チャンクの大きさは、同じ換算で往復する", () => {
  /*
    測定は「字」で測り、台帳へは「トークン」で書く（`contextWindow`）。
    その欄を読むのは `decideChunkSize` / `planChunkBudget` で、あちらは
    `resolveCharsPerToken` で字へ戻す。**行きと帰りで違う換算を使うと、
    二重にずれる**——いまは両方が 0.7 なので誤差が打ち消し合っているが、
    片方だけ実測にすると崩れる。
  */
  const 五件の実測 = { charsPerToken: 1.234, charsPerTokenSamples: 5 };

  test("字 → トークン → 字 で、元の字数へ戻る", () => {
    const 測った字数 = 50_209;
    const 台帳のトークン = probeCharsToTokens(測った字数, 五件の実測);
    const 戻した字数 = Math.floor(
      台帳のトークン * resolveCharsPerToken(五件の実測)
    );
    // 丸めのぶん（1字）しかずれない
    expect(Math.abs(戻した字数 - 測った字数)).toBeLessThanOrEqual(1);
  });

  test("チャンクの大きさは、台帳のトークン数の35%ぶんの字数になる", () => {
    const 台帳のトークン = probeCharsToTokens(50_209, 五件の実測);
    const 換算 = resolveCharsPerToken(五件の実測);

    expect(decideChunkSize(台帳のトークン, 五件の実測)).toBe(
      Math.floor(Math.floor(台帳のトークン * 0.35) * 換算)
    );
  });

  test("片道だけ実測にすると歪む（だから両方を同時に直した）", () => {
    // 台帳へ**天井の換算**で書いてしまうと、読み戻した字数が1割ほど
    // 小さくなる。この差が「二重にずれる」の正体である
    const 測った字数 = 50_209;
    const 歪んだ台帳 = Math.round(測った字数 / probeCharsPerToken(五件の実測));
    const 戻した字数 = Math.floor(歪んだ台帳 * resolveCharsPerToken(五件の実測));

    expect(戻した字数).toBeLessThan(測った字数 * 0.95);
  });
});
