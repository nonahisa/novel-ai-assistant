/**
 * 人物相関図の拡大・縮小と移動（設計書6.38.2。作者の要望、2026-10-03
 * 「相関図の図を拡大したい」）。
 *
 * 見せる範囲は SVG の viewBox だけで決める。SVG 自体は欄いっぱいに広げた
 * まま動かさないので、拡大すれば線も円も名前の字も同じ割合で大きくなる
 * （字だけ小さいまま、ということが起きない）。
 *
 * **viewBox の縦横比は、いつも欄の縦横比に揃える。** 揃っていれば
 * preserveAspectRatio の余白が生じず、画面の1画素が図の何単位かが
 * `vb.w / 欄の幅` の1つの数で決まる。マウスの位置を中心にした拡大は
 * この換算が単純でないと狂う。
 *
 * 画面（WebView）のスクリプトは TypeScript を読めないので、同じ計算の
 * 写しを持つ（`views/relationGraphPanelHtml.ts` の viewport:start〜end）。
 * 写しが離れていないことは `test/unit/cross/relationGraphViewportCopy.test.ts`
 * が同じ入力で比べて見張る。ここを直したら、写しも同じに直すこと。
 */

/** 図の座標での四角。viewBox と同じ並び */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 欄の大きさ（画面の画素） */
export interface CanvasSize {
  w: number;
  h: number;
}

/**
 * 倍率の範囲。**「全体を合わせる」を 1 とした割合**で持つ。
 *
 * 絶対の倍率にしないのは、欄の広さで「ちょうど収まる倍率」が変わるため。
 * 作者に分かりやすいのは「全体からどれだけ寄ったか」のほう。
 *
 * - 下限 0.5：全体の半分まで。それより小さくしても点が潰れるだけ
 * - 上限 8：31人の全体図（980単位）を幅500画素ほどの欄に収めると、
 *   名前の字（12単位）は6画素ほどになる。8倍で約50画素——読める大きさを
 *   十分に越える
 */
export const ZOOM_LIMITS = { min: 0.5, max: 8 } as const;

/** ホイール1画素あたりの効き。1目盛り（約100画素）でおよそ2割 */
const WHEEL_SENSITIVITY = 0.002;

/** 行・頁の単位で来る環境（deltaMode 1・2）を画素へ直す。原稿エディターと同じ値 */
const WHEEL_LINE_PX = 40;
const WHEEL_PAGE_PX = 800;

/**
 * 図の全体（`content`）が欄にちょうど収まる viewBox。
 *
 * 足りないほうの向きに合わせ、余った向きは左右（上下）へ等分に空ける。
 * `margin` は図の単位で、外周の名前が縁に貼り付かないための余白。
 */
export function fitViewBox(
  content: ViewBox,
  canvas: CanvasSize,
  margin: number
): ViewBox {
  const w = content.w + margin * 2;
  const h = content.h + margin * 2;
  // 隠れた欄（背面のタブ）では寸法が0になる。割り算をせず、図の大きさのまま返す
  if (!(canvas.w > 0) || !(canvas.h > 0)) {
    return { x: content.x - margin, y: content.y - margin, w: w, h: h };
  }
  // 1画素あたりの単位。大きいほうに合わせれば、もう片方は必ず収まる
  const unit = Math.max(w / canvas.w, h / canvas.h);
  const vw = canvas.w * unit;
  const vh = canvas.h * unit;
  return {
    x: content.x - margin - (vw - w) / 2,
    y: content.y - margin - (vh - h) / 2,
    w: vw,
    h: vh,
  };
}

/** 「全体を合わせる」に比べて、いまどれだけ寄っているか */
export function zoomOf(vb: ViewBox, fit: ViewBox): number {
  if (!(vb.w > 0)) return 1;
  return fit.w / vb.w;
}

/**
 * `pointer`（欄の左上からの画素）の下にある図の点を動かさずに、
 * 倍率を `factor` 倍する。範囲（ZOOM_LIMITS）で頭打ちにする。
 *
 * 頭打ちのときは、マウスがどこにあっても図を動かさない——倍率が変わら
 * ないのに見ている所がずれると、作者には図が勝手に滑ったように見える。
 */
export function zoomViewBoxAt(
  vb: ViewBox,
  factor: number,
  pointer: { x: number; y: number },
  canvas: CanvasSize,
  fit: ViewBox
): ViewBox {
  if (!(canvas.w > 0) || !(canvas.h > 0) || !(factor > 0)) return vb;
  const current = zoomOf(vb, fit);
  const target = Math.min(
    ZOOM_LIMITS.max,
    Math.max(ZOOM_LIMITS.min, current * factor)
  );
  if (Math.abs(target - current) < 1e-9) return vb;
  const w = fit.w / target;
  const h = (w * canvas.h) / canvas.w;
  // マウスの下の図の点。拡大の前後でここが同じ画素に来るように左上を決める
  const gx = vb.x + (pointer.x * vb.w) / canvas.w;
  const gy = vb.y + (pointer.y * vb.h) / canvas.h;
  return {
    x: gx - (pointer.x * w) / canvas.w,
    y: gy - (pointer.y * h) / canvas.h,
    w: w,
    h: h,
  };
}

/**
 * ホイールの回し量を倍率へ直す。手前へ回す（deltaY が負）と大きく——
 * ふつうのズームと原稿エディターの Ctrl+ホイールと同じ向き。
 *
 * 指数で直すので、同じだけ行って戻れば元の倍率に戻る。トラックパッドの
 * ピンチは Chromium では Ctrl 付きの小さな wheel で届くので、同じ式で
 * 滑らかに効く。
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const unit = deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const delta = (Number(deltaY) || 0) * unit;
  if (delta === 0) return 1;
  return Math.exp(-delta * WHEEL_SENSITIVITY);
}

/**
 * 欄の真ん中が、図の全体（`content`）の外へ出ないようにする。
 *
 * 引きすぎて図が欄から消えると、作者には「図が無くなった」と見える。
 * 真ん中が図の上にあれば、どれだけ寄っていても図の一部は必ず見えている。
 */
export function clampViewBoxToContent(vb: ViewBox, content: ViewBox): ViewBox {
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const nx = Math.min(content.x + content.w, Math.max(content.x, cx));
  const ny = Math.min(content.y + content.h, Math.max(content.y, cy));
  if (nx === cx && ny === cy) return vb;
  return { x: nx - vb.w / 2, y: ny - vb.h / 2, w: vb.w, h: vb.h };
}

/**
 * 画面で `dx`・`dy` 画素引いたぶん、図を動かす。図は指に付いてくる
 * （右へ引けば図も右へ動き、見ている範囲は左へずれる）。
 */
export function panViewBox(
  vb: ViewBox,
  dx: number,
  dy: number,
  canvas: CanvasSize,
  content: ViewBox
): ViewBox {
  if (!(canvas.w > 0) || !(canvas.h > 0)) return vb;
  return clampViewBoxToContent(
    {
      x: vb.x - (dx * vb.w) / canvas.w,
      y: vb.y - (dy * vb.h) / canvas.h,
      w: vb.w,
      h: vb.h,
    },
    content
  );
}

/**
 * 欄の大きさが変わったとき（窓の大きさ・「図を広く」）。手で寄せて
 * いるあいだは、1画素あたりの単位と見ている真ん中を保つ——広げた
 * ぶんだけ周りが見えるようになり、見ていた所は動かない。
 */
export function resizeViewBox(
  vb: ViewBox,
  before: CanvasSize,
  after: CanvasSize
): ViewBox {
  if (!(before.w > 0) || !(after.w > 0) || !(after.h > 0)) return vb;
  const unit = vb.w / before.w;
  const w = after.w * unit;
  const h = after.h * unit;
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
}
