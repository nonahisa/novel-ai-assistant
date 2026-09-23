import { describe, expect, it } from "vitest";
import {
  canRunProcesses,
  hostTag,
  isWebRuntime,
  randomHex,
  randomUuid,
} from "../../src/core/runtime";

/**
 * 実行環境の判定（設計書5.8）。
 *
 * **単体テストはNodeの上で動く。** ブラウザ側の分岐そのものは
 * ここでは確かめられない（`isWebRuntime()` は `process` の有無を見るが、
 * テスト実行中は常にNodeなので常に false になる）。ここで確かめるのは
 * 「Node上では正しく `false` を返す」ことと、他の部品が使う値を
 * 壊れずに作れることだけ。ブラウザ側の分岐は、`canRun` を直接渡す形の
 * テストへ切り出してある（`providerRuntimeFilter.test.ts` など）。
 */

describe("実行環境の判定", () => {
  it("単体テストの実行環境（Node）では、ブラウザ扱いしない", () => {
    expect(isWebRuntime()).toBe(false);
  });

  it("Nodeでは外部プロセスを起動できる扱いにする", () => {
    expect(canRunProcesses()).toBe(true);
  });
});

describe("一意な文字列", () => {
  it("randomUuid はUUID形式で、呼ぶたびに変わる", () => {
    const a = randomUuid();
    const b = randomUuid();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(a).not.toBe(b);
  });

  it("randomHex は指定した長さの16進文字列を作る", () => {
    expect(randomHex(2)).toMatch(/^[0-9a-f]{4}$/);
    expect(randomHex(3)).toMatch(/^[0-9a-f]{6}$/);
  });

  it("hostTag は、毎回呼んでも同じ値を返す", () => {
    // 一時ファイル名の衝突を避けるための札。呼ぶたびに変わっては意味が無い
    expect(hostTag()).toBe(hostTag());
  });
});
