import { describe, expect, it } from "vitest";
import * as viewport from "../../../src/core/relationGraphViewport";
import { buildRelationGraphPanelHtml } from "../../../src/views/relationGraphPanelHtml";

/**
 * 人物相関図の拡大・縮小と移動（設計書6.38.2）——画面側の写しが、
 * core と同じ答えを返すか。
 *
 * WebView のスクリプトは TypeScript を読めないので、計算の写しを持って
 * いる（viewport:start〜end）。写しは直し忘れで黙って離れるので、
 * 同じ入力で比べて見張る（縦中横の tateChuYoko.test.ts と同じ作法）。
 */

const html = buildRelationGraphPanelHtml("NONCE123", "vscode-resource:");
const script = html.slice(html.indexOf("<script"));
const source = script.slice(
  script.indexOf("/* viewport:start */"),
  script.indexOf("/* viewport:end */")
);

type Api = Pick<
  typeof viewport,
  | "fitViewBox"
  | "zoomOf"
  | "zoomViewBoxAt"
  | "wheelZoomFactor"
  | "clampViewBoxToContent"
  | "panViewBox"
  | "resizeViewBox"
> & { ZOOM_LIMITS: { min: number; max: number } };

const copy = new Function(
  source +
    "\nreturn { ZOOM_LIMITS, fitViewBox, zoomOf, zoomViewBoxAt, wheelZoomFactor," +
    " clampViewBoxToContent, panViewBox, resizeViewBox };"
)() as Api;

const contents = [
  { x: 0, y: 0, w: 980, h: 980 },
  { x: -40, y: -12, w: 1100, h: 1010 },
  { x: 0, y: 0, w: 840, h: 840 },
];
const canvases = [
  { w: 1000, h: 500 },
  { w: 420, h: 760 },
  { w: 731, h: 457 },
  { w: 0, h: 0 },
];

describe("画面側の拡大・縮小は、写しではなく同じ計算で動く", () => {
  it("写しの区切りがある", () => {
    expect(source.length).toBeGreaterThan(100);
  });

  it("倍率の範囲は core から受け取る", () => {
    expect(copy.ZOOM_LIMITS).toEqual(viewport.ZOOM_LIMITS);
  });

  it("全体を合わせる", () => {
    for (const content of contents) {
      for (const canvas of canvases) {
        for (const margin of [0, 12]) {
          expect(copy.fitViewBox(content, canvas, margin)).toEqual(
            viewport.fitViewBox(content, canvas, margin)
          );
        }
      }
    }
  });

  it("マウスの位置を中心に拡大・縮小する（上限下限を含む）", () => {
    for (const content of contents) {
      for (const canvas of canvases) {
        const fit = viewport.fitViewBox(content, canvas, 12);
        let a = fit;
        let b = fit;
        const steps = [2, 3, 0.1, 50, 1.25, 0.8, 0.01, 1];
        for (const factor of steps) {
          const pointer = { x: canvas.w * 0.7, y: canvas.h * 0.2 };
          a = copy.zoomViewBoxAt(a, factor, pointer, canvas, fit);
          b = viewport.zoomViewBoxAt(b, factor, pointer, canvas, fit);
          expect(a).toEqual(b);
          expect(copy.zoomOf(a, fit)).toBe(viewport.zoomOf(b, fit));
        }
      }
    }
  });

  it("ホイールの回し量", () => {
    for (const mode of [0, 1, 2]) {
      for (const delta of [-300, -120, -3, 0, 1, 53, 120, Number.NaN]) {
        expect(copy.wheelZoomFactor(delta, mode)).toBe(
          viewport.wheelZoomFactor(delta, mode)
        );
      }
    }
  });

  it("ドラッグと、図を見失わない枠", () => {
    const content = contents[1];
    const canvas = canvases[2];
    const fit = viewport.fitViewBox(content, canvas, 12);
    const zoomed = viewport.zoomViewBoxAt(fit, 4, { x: 100, y: 100 }, canvas, fit);
    for (const [dx, dy] of [
      [0, 0],
      [80, -30],
      [-100000, 5],
      [100000, 100000],
    ]) {
      expect(copy.panViewBox(zoomed, dx, dy, canvas, content)).toEqual(
        viewport.panViewBox(zoomed, dx, dy, canvas, content)
      );
    }
    expect(copy.clampViewBoxToContent(zoomed, content)).toEqual(
      viewport.clampViewBoxToContent(zoomed, content)
    );
  });

  it("欄の大きさが変わったとき", () => {
    const fit = viewport.fitViewBox(contents[0], canvases[0], 12);
    const zoomed = viewport.zoomViewBoxAt(fit, 2.5, { x: 300, y: 120 }, canvases[0], fit);
    for (const after of canvases) {
      expect(copy.resizeViewBox(zoomed, canvases[0], after)).toEqual(
        viewport.resizeViewBox(zoomed, canvases[0], after)
      );
    }
  });
});
