/**
 * WebView の「窓の中で見えている幅」の観測（`views/visibleWidthScript.ts`。設計書6.11.7・6.25）。
 *
 * 再現（2026-10-10、ノートPCの VS Code 1.141.0）：画面の拡大率が 150% の機械では、広い窓でも
 * 原稿エディターの下の段に `max-width: 1222px` が書き込まれ、`body.clipped` が付いた。
 * 拡大率が端数だと、CSS の1px が実際の画素の端数になり、交差の幅（見えている幅）と
 * 要素の幅が1px足らずずれる（測った値：見えている幅 1242.67・要素の幅 1243.33）。
 * 見えている幅を切り捨ててから「要素の幅 − 1」と比べていたので、切れていない列を
 * 切れていると判定していた。
 *
 * 埋め込む JavaScript を、作り物の IntersectionObserver の上で動かして確かめる。
 */
import { describe, expect, it } from "vitest";
import { OBSERVE_VISIBLE_WIDTH_SOURCE } from "../../../src/views/visibleWidthScript";

interface FakeEntry {
  intersectionRect: { width: number };
  boundingClientRect: { width: number };
}

/** 埋め込みの関数を動かし、1回の交差の知らせで onChange へ渡った値を返す */
function report(entry: FakeEntry): number[] {
  const calls: number[] = [];
  let callback: ((entries: FakeEntry[]) => void) | undefined;
  class FakeObserver {
    constructor(cb: (entries: FakeEntry[]) => void) {
      callback = cb;
    }
    observe(): void {}
    unobserve(): void {}
  }
  const fakeElement = { setAttribute() {}, style: {} as Record<string, string> };
  const fakeDocument = { createElement: () => fakeElement, body: { appendChild() {} } };
  const fakeWindow = { addEventListener() {} };
  const run = new Function(
    "IntersectionObserver",
    "document",
    "window",
    "onChange",
    `${OBSERVE_VISIBLE_WIDTH_SOURCE}\nobserveVisibleWidth(onChange);`
  ) as (observer: unknown, document: unknown, window: unknown, onChange: (width: number) => void) => void;
  run(FakeObserver, fakeDocument, fakeWindow, (width) => calls.push(width));
  if (!callback) throw new Error("観測が張られていません");
  callback([entry]);
  return calls;
}

describe("observeVisibleWidth", () => {
  it("拡大率が端数で、見えている幅が要素の幅より1px足らず狭いだけなら、切れていないとする（0を知らせる）", () => {
    // 拡大率 150% の 1.141.0 で測った値そのもの
    expect(report({ intersectionRect: { width: 1242.666748046875 }, boundingClientRect: { width: 1243.3333740234375 } })).toEqual([0]);
  });

  it("ぴったり同じ幅なら切れていない", () => {
    expect(report({ intersectionRect: { width: 800 }, boundingClientRect: { width: 800 } })).toEqual([0]);
  });

  it("列の右端が窓の外へ出て数十px切れているときは、見えている幅を知らせる", () => {
    expect(report({ intersectionRect: { width: 200.4 }, boundingClientRect: { width: 220 } })).toEqual([200]);
  });

  it("見えている幅が0（隠れた面）なら詰めない", () => {
    expect(report({ intersectionRect: { width: 0 }, boundingClientRect: { width: 220 } })).toEqual([0]);
  });
});
