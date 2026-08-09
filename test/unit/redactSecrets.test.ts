import { afterEach, describe, expect, test } from "vitest";
import {
  clearSecrets,
  forgetSecret,
  redactSecrets,
  registerSecret,
} from "../../src/core/logger";

/**
 * ログはファイルにも残るようになったので、伏せ字の取りこぼしは
 * その場限りでは済まず、ディスク上に残り続ける。
 *
 * このプロジェクトは以前、接頭辞（`AIza`）でキーの形式を検証して、
 * Googleが形式を変えた結果、正しいキーを弾いた。
 * 同じ理屈で、接頭辞での伏せ字も将来外れる。
 */

afterEach(() => clearSecrets());

describe("接頭辞での伏せ字", () => {
  test("知っている形式は伏せる", () => {
    expect(redactSecrets("key=sk-ant-api03-abcdefgh1234")).toBe("key=sk-***");
    expect(redactSecrets("key=AIzaSyABCDEFGH1234")).toBe("key=AIza***");
    expect(redactSecrets("key=AQ.Ab8RN6JuQEwhj-nHcg")).toBe("key=AQ.***");
  });

  test("知らない形式は伏せられない（だから値でも消す）", () => {
    // 接頭辞の一覧に無い形式は素通りする。これが接頭辞頼みの限界
    expect(redactSecrets("key=zz9-unknown-format-key")).toContain("zz9-");
  });
});

describe("実際のキーの値で伏せ字にする", () => {
  test("形式が何であれ消す", () => {
    registerSecret("zz9-unknown-format-key");

    expect(redactSecrets("key=zz9-unknown-format-key です")).toBe(
      "key=*** です"
    );
  });

  test("同じ行に複数出ても全部消す", () => {
    registerSecret("zz9-unknown-format-key");

    const text = "zz9-unknown-format-key と zz9-unknown-format-key";
    expect(redactSecrets(text)).toBe("*** と ***");
  });

  test("短い値は登録しない", () => {
    // ありふれた文字列を消すと、ログが伏せ字だらけで読めなくなる
    registerSecret("abc");

    expect(redactSecrets("abc は普通の語")).toBe("abc は普通の語");
  });

  test("前後の空白は無視して登録する", () => {
    registerSecret("  zz9-unknown-format-key  ");

    expect(redactSecrets("zz9-unknown-format-key")).toBe("***");
  });

  test("空やundefinedを登録しない", () => {
    registerSecret(undefined);
    registerSecret("");
    registerSecret("   ");

    // 空文字を登録していたら、あらゆる文字列が壊れる
    expect(redactSecrets("なんでもない文章")).toBe("なんでもない文章");
  });

  test("キーを消したら控えも捨てる", () => {
    registerSecret("zz9-unknown-format-key");
    forgetSecret("zz9-unknown-format-key");

    expect(redactSecrets("zz9-unknown-format-key")).toContain("zz9-");
  });
});

describe("本文は壊さない", () => {
  test("関係のない文章はそのまま残す", () => {
    const text = "第12話で嘘をついた理由は本文から読み取れますか？";
    expect(redactSecrets(text)).toBe(text);
  });
});
