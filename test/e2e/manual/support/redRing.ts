/**
 * 手順書の画面ショットで、**読み手が次に押す所を赤い楕円で囲む**
 * （作者の指示 2026-11-01「選択メニューはわかりやすく〇で囲ってください」）。
 *
 * 囲みは撮るあいだだけ、VS Code の窓（ワークベンチの文書）へ Playwright から重ねる。
 * 製品の画面には混ぜない（拡張機能のコードは1行も変えない）。WebView（原稿エディター・
 * 提案パネル）の中の要素も、`locator.boundingBox()` は窓の座標で返るので、本体の文書の
 * 一番上に描けば iframe の上に重なる。
 *
 * **囲みが目標の上にあることを、描いたあとに機械で確かめる**（広報の動画の
 * `assertCursorOn` と同じ考え方）。外れていたら撮影を失敗にする：
 * 1. 描いた楕円を DOM から読み直し、その中心が、測り直した目標の箱の中心から数px以内か
 * 2. 目標の箱の四隅（2px 内側）と真ん中が、楕円の内側か
 * 3. 目標の真ん中で一番上にある要素が、目標かその中身か（別のものが重なっていないか。
 *    楕円は pointer-events: none なので `elementFromPoint` に拾われない）
 *
 * 囲むのは押す所だけ、1枚に2つまで（作者の指示）。
 */
import type { Locator, Page } from "playwright-core";

/** 囲みの色（赤）と太さ */
const RING_COLOR = "#e53935";
const RING_WIDTH = 4;
/** 一番上に重ねる。WebView の iframe より上 */
const TOP = "2147483647";
/** 1枚に置ける囲みの数（作者の指示） */
export const MAX_RINGS = 2;

export interface RingTarget {
  locator: Locator;
  /** 失敗の文に出す名前（「［返す］」など） */
  label: string;
  /**
   * 囲む位置を、目標の箱から変えたいとき（窓の端で楕円が切れるので内側へずらす、字の幅だけに絞る）。
   * 目標の四隅と真ん中が囲みの内側にあることは、ずらしたあとも確かめる
   */
  fit?: (box: Clip) => Clip;
}

interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * 箱を囲む楕円。四隅が内側に入るよう、半径は箱の半分より少し大きく取る
 * （横に長い入力欄でも縦に間延びしないよう、縦の足し分は控えめにする）
 */
function ellipseAround(box: { x: number; y: number; width: number; height: number }): Ellipse {
  return {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    rx: (box.width / 2) * 1.12 + 14,
    ry: (box.height / 2) * 1.45 + 8,
  };
}

/** 前に描いた囲みを消す */
export async function clearRings(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("manual-rings")?.remove());
}

/**
 * `targets` を赤い楕円で囲み、囲みが目標の上にあることを確かめる。
 * 前の囲みは消してから描く。0 個なら消すだけ
 */
export async function drawRings(page: Page, targets: readonly RingTarget[]): Promise<void> {
  await clearRings(page);
  if (targets.length > MAX_RINGS) {
    throw new Error(`囲みは1枚に${MAX_RINGS}つまでです（${targets.map((t) => t.label).join("・")}）`);
  }
  if (targets.length === 0) return;
  const ellipses: Array<Ellipse & { label: string }> = [];
  for (const target of targets) {
    await target.locator.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    const box = await target.locator.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error(`囲む「${target.label}」が画面に見えていません（boundingBox が取れない）`);
    }
    ellipses.push({ ...ellipseAround(target.fit ? target.fit(box) : box), label: target.label });
  }
  await page.evaluate(
    ({ ellipses, color, width, top }) => {
      // ワークベンチは Trusted Types を求めるので innerHTML は使えない。要素を1つずつ作る
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.id = "manual-rings";
      svg.setAttribute("width", String(window.innerWidth));
      svg.setAttribute("height", String(window.innerHeight));
      svg.style.cssText = `position:fixed;left:0;top:0;z-index:${top};pointer-events:none;overflow:visible`;
      for (const e of ellipses) {
        const ring = document.createElementNS(ns, "ellipse");
        ring.setAttribute("cx", String(e.cx));
        ring.setAttribute("cy", String(e.cy));
        ring.setAttribute("rx", String(e.rx));
        ring.setAttribute("ry", String(e.ry));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", String(width));
        ring.setAttribute("data-label", e.label);
        svg.appendChild(ring);
      }
      document.body.appendChild(svg);
    },
    { ellipses, color: RING_COLOR, width: RING_WIDTH, top: TOP }
  );
  await verifyRings(page, targets);
}

/** 描いた囲みが、それぞれの目標の上にあるかを確かめる（上の 1〜3） */
async function verifyRings(page: Page, targets: readonly RingTarget[]): Promise<void> {
  // 描いたものを DOM から読み直す（計算した値でなく、実際に置かれた楕円で確かめる）
  const drawn = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#manual-rings ellipse")).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: element.getAttribute("data-label") ?? "",
        // SVG の図形の箱は線の太さを含まない（線の真ん中の形）。それを楕円の半径とみなす
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
        rx: rect.width / 2,
        ry: rect.height / 2,
      };
    })
  );
  if (drawn.length !== targets.length) {
    throw new Error(`囲みが ${targets.length} つ描かれていません（描かれたのは ${drawn.length} つ）`);
  }
  for (const [index, target] of targets.entries()) {
    const ring = drawn[index];
    const box = await target.locator.boundingBox();
    if (!ring || !box) throw new Error(`「${target.label}」の囲みか目標が消えました`);
    const ringBox = target.fit ? target.fit(box) : box;
    const center = { x: ringBox.x + ringBox.width / 2, y: ringBox.y + ringBox.height / 2 };
    const targetCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (Math.abs(ring.cx - center.x) > 4 || Math.abs(ring.cy - center.y) > 4) {
      throw new Error(
        `「${target.label}」の囲みの中心 (${ring.cx.toFixed(1)}, ${ring.cy.toFixed(1)}) が目標の中心 (${center.x.toFixed(1)}, ${center.y.toFixed(1)}) からずれています`
      );
    }
    const inset = 2;
    const points = [
      targetCenter,
      { x: box.x + inset, y: box.y + inset },
      { x: box.x + box.width - inset, y: box.y + inset },
      { x: box.x + inset, y: box.y + box.height - inset },
      { x: box.x + box.width - inset, y: box.y + box.height - inset },
    ];
    for (const point of points) {
      const value = ((point.x - ring.cx) / ring.rx) ** 2 + ((point.y - ring.cy) / ring.ry) ** 2;
      if (value > 1) {
        throw new Error(`「${target.label}」の箱 ${JSON.stringify(box)} の点 (${point.x}, ${point.y}) が囲みの外です`);
      }
    }
    // 目標の真ん中で一番上にあるのが目標そのものか（WebView の中なら、その文書の中で見る）
    const covering = await target.locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top) return "（何も無い）";
      if (element.contains(top) || top.contains(element)) return undefined;
      return `${top.tagName.toLowerCase()}.${String(top.className)}「${(top.textContent ?? "").trim().slice(0, 30)}」`;
    });
    if (covering) throw new Error(`「${target.label}」の上に別のものが重なっています：${covering}`);
  }
}

/** 窓の中の長方形（切り出しの範囲） */
export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `locators` の箱と、描いた囲みを全部含む長方形（`margin` だけ広げ、窓の中に収める）。
 * 押す所の周りを切り出した2枚目に使う
 */
export async function clipAround(page: Page, locators: readonly Locator[], margin = 24): Promise<Clip> {
  const boxes: Clip[] = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    if (box) boxes.push(box);
  }
  const rings = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#manual-rings ellipse")).map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })
  );
  boxes.push(...rings);
  if (boxes.length === 0) throw new Error("切り出す範囲がありません");
  const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin);
  const right = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + margin);
  const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + margin);
  return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}
