import { describe, expect, it } from "vitest";
import {
  ZOOM_LIMITS,
  clampViewBoxToContent,
  fitViewBox,
  panViewBox,
  resizeViewBox,
  wheelZoomFactor,
  zoomOf,
  zoomViewBoxAt,
} from "../../../src/core/relationGraphViewport";

/**
 * 人物相関図の拡大・縮小と移動（設計書6.38.2。作者の要望、2026-10-03
 * 「相関図の図を拡大したい」）。
 *
 * 見せる範囲は SVG の viewBox だけで決める。ここで見るのは、その数の
 * 計算——全体を合わせる・マウスの下の点を動かさない・倍率の上限下限。
 */

const content = { x: 0, y: 0, w: 980, h: 980 };

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

describe("全体を合わせる", () => {
  it("横長の欄では、高さに合わせて左右を空ける", () => {
    const vb = fitViewBox(content, { w: 1000, h: 500 }, 0);
    // 縦が詰まるので、1画素あたり 980/500 単位
    near(vb.h, 980);
    near(vb.w, 1960);
    // 図は真ん中に来る
    near(vb.x, -490);
    near(vb.y, 0);
  });

  it("縦長の欄では、幅に合わせて上下を空ける", () => {
    const vb = fitViewBox(content, { w: 400, h: 800 }, 0);
    near(vb.w, 980);
    near(vb.h, 1960);
    near(vb.x, 0);
    near(vb.y, -490);
  });

  it("viewBox の縦横比は欄と同じ（余白で座標がずれない）", () => {
    const canvas = { w: 731, h: 457 };
    const vb = fitViewBox(content, canvas, 12);
    near(vb.w / vb.h, canvas.w / canvas.h);
  });

  it("余白のぶんだけ外側を含める", () => {
    const vb = fitViewBox(content, { w: 500, h: 500 }, 20);
    near(vb.x, -20);
    near(vb.y, -20);
    near(vb.w, 1020);
  });

  it("合わせた状態の倍率は 1", () => {
    const canvas = { w: 600, h: 400 };
    const fit = fitViewBox(content, canvas, 0);
    near(zoomOf(fit, fit), 1);
  });

  it("欄の大きさが0のときは、図の大きさのまま返す（描く前で寸法が取れない）", () => {
    const vb = fitViewBox(content, { w: 0, h: 0 }, 0);
    expect(vb).toEqual({ x: 0, y: 0, w: 980, h: 980 });
  });
});

describe("マウスの位置を中心に拡大・縮小する", () => {
  const canvas = { w: 800, h: 600 };
  const fit = fitViewBox(content, canvas, 0);

  /** 画面の点が指す図の座標 */
  function pointOf(vb: { x: number; y: number; w: number; h: number }, px: number, py: number) {
    return { x: vb.x + (px * vb.w) / canvas.w, y: vb.y + (py * vb.h) / canvas.h };
  }

  it("マウスの下の図の点が動かない", () => {
    const pointer = { x: 610, y: 120 };
    const before = pointOf(fit, pointer.x, pointer.y);
    const zoomed = zoomViewBoxAt(fit, 2, pointer, canvas, fit);
    const after = pointOf(zoomed, pointer.x, pointer.y);
    near(after.x, before.x);
    near(after.y, before.y);
    near(zoomOf(zoomed, fit), 2);
  });

  it("縮小でもマウスの下の点が動かない", () => {
    const start = zoomViewBoxAt(fit, 4, { x: 400, y: 300 }, canvas, fit);
    const pointer = { x: 50, y: 580 };
    const before = pointOf(start, pointer.x, pointer.y);
    const out = zoomViewBoxAt(start, 0.5, pointer, canvas, fit);
    const after = pointOf(out, pointer.x, pointer.y);
    near(after.x, before.x);
    near(after.y, before.y);
    near(zoomOf(out, fit), 2);
  });

  it("縦横比を保つ", () => {
    const zoomed = zoomViewBoxAt(fit, 3, { x: 10, y: 10 }, canvas, fit);
    near(zoomed.w / zoomed.h, canvas.w / canvas.h);
  });

  it("上限を超えて大きくしない", () => {
    let vb = fit;
    for (let i = 0; i < 40; i++) vb = zoomViewBoxAt(vb, 1.5, { x: 400, y: 300 }, canvas, fit);
    near(zoomOf(vb, fit), ZOOM_LIMITS.max);
  });

  it("下限を超えて小さくしない", () => {
    let vb = fit;
    for (let i = 0; i < 40; i++) vb = zoomViewBoxAt(vb, 0.5, { x: 400, y: 300 }, canvas, fit);
    near(zoomOf(vb, fit), ZOOM_LIMITS.min);
  });

  it("上限に張り付いているときは、マウスの位置がずれても図を動かさない", () => {
    let vb = fit;
    for (let i = 0; i < 40; i++) vb = zoomViewBoxAt(vb, 1.5, { x: 400, y: 300 }, canvas, fit);
    const again = zoomViewBoxAt(vb, 1.5, { x: 10, y: 590 }, canvas, fit);
    near(again.x, vb.x);
    near(again.y, vb.y);
  });

  it("範囲は、全体を合わせた倍率をはさむ", () => {
    expect(ZOOM_LIMITS.min).toBeLessThan(1);
    expect(ZOOM_LIMITS.max).toBeGreaterThan(1);
  });
});

describe("ホイールの回し量を倍率へ直す", () => {
  it("手前へ回す（deltaY が負）と大きくなる", () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
  });

  it("行き来すると元へ戻る", () => {
    near(wheelZoomFactor(-120, 0) * wheelZoomFactor(120, 0), 1);
  });

  it("行の単位（deltaMode 1）は画素へ直す", () => {
    near(wheelZoomFactor(-3, 1), wheelZoomFactor(-120, 0));
  });

  it("回していないときは 1", () => {
    expect(wheelZoomFactor(0, 0)).toBe(1);
    expect(wheelZoomFactor(Number.NaN, 0)).toBe(1);
  });
});

describe("ドラッグで動かす", () => {
  const canvas = { w: 800, h: 600 };
  const fit = fitViewBox(content, canvas, 0);
  const zoomed = zoomViewBoxAt(fit, 4, { x: 400, y: 300 }, canvas, fit);

  it("右へ引くと、図も右へ動く（見ている範囲は左へずれる）", () => {
    const moved = panViewBox(zoomed, 80, 0, canvas, content);
    // 画面の80画素ぶん。拡大中なので図の単位では小さい
    near(moved.x, zoomed.x - (80 * zoomed.w) / canvas.w);
    near(moved.y, zoomed.y);
  });

  it("図を見失うほど遠くへは行かない（欄の真ん中が図の外へ出ない）", () => {
    const far = panViewBox(zoomed, -100000, -100000, canvas, content);
    near(far.x + far.w / 2, content.x + content.w);
    near(far.y + far.h / 2, content.y + content.h);
    const other = panViewBox(zoomed, 100000, 100000, canvas, content);
    near(other.x + other.w / 2, content.x);
    near(other.y + other.h / 2, content.y);
  });

  it("中に収まっているあいだは、そのまま返す", () => {
    expect(clampViewBoxToContent(zoomed, content)).toEqual(zoomed);
  });
});

describe("欄の大きさが変わったとき", () => {
  it("拡大の具合（1画素あたりの単位）と真ん中を保つ", () => {
    const before = { w: 800, h: 600 };
    const after = { w: 1200, h: 500 };
    const fit = fitViewBox(content, before, 0);
    const zoomed = zoomViewBoxAt(fit, 2, { x: 400, y: 300 }, before, fit);
    const resized = resizeViewBox(zoomed, before, after);
    near(resized.w / after.w, zoomed.w / before.w);
    near(resized.h / after.h, zoomed.h / before.h);
    near(resized.x + resized.w / 2, zoomed.x + zoomed.w / 2);
    near(resized.y + resized.h / 2, zoomed.y + zoomed.h / 2);
  });
});
