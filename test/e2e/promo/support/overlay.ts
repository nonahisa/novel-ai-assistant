/**
 * 広報の動画（設計書6.114）で、画面の上に重ねる表題・字幕・矢印のカーソル・押したときの星・キーの札。
 *
 * **製品の画面には混ぜない。** 録っているあいだだけ、VS Code の窓（ワークベンチの
 * 文書）へ Playwright から要素を足す。拡張機能のコードは1行も変えない。
 *
 * ffmpeg の drawtext で後から重ねる手もあるが、Windows では日本語の書体の道を
 * フィルターの文字列へ埋める書き方が壊れやすい（`:` と `\` の扱い）。窓の中に
 * 描けば、VS Code と同じ書体で、同じ解像度で写る。
 *
 * 要素はどれも `pointer-events: none`——押す操作の邪魔をしない。
 */
import type { Locator, Page } from "playwright-core";

const FONT = `"Yu Gothic UI", "Meiryo UI", "Meiryo", sans-serif`;
/** 一番上に重ねる。WebView（原稿エディター・パネル）の iframe より上に出す */
const TOP = "2147483647";

/** 全面白の表題（冒頭・結び）。消すまで出しっぱなし */
export async function showTitleCard(page: Page, title: string, subtitle: string): Promise<void> {
  await page.evaluate(
    ({ title, subtitle, font, top }) => {
      document.getElementById("promo-title")?.remove();
      const card = document.createElement("div");
      card.id = "promo-title";
      card.style.cssText = [
        "position:fixed",
        "inset:0",
        `z-index:${top}`,
        "background:#ffffff",
        "color:#1f1f1f",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:18px",
        `font-family:${font}`,
        "pointer-events:none",
        "transition:opacity 400ms ease",
        "opacity:1",
      ].join(";");
      const main = document.createElement("div");
      main.textContent = title;
      main.style.cssText = "font-size:44px;font-weight:600;letter-spacing:0.04em";
      const sub = document.createElement("div");
      sub.textContent = subtitle;
      sub.style.cssText = "font-size:22px;color:#555555";
      card.append(main, sub);
      document.body.appendChild(card);
    },
    { title, subtitle, font: FONT, top: TOP }
  );
}

/** 表題を薄くして消す（0.4秒） */
export async function hideTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const card = document.getElementById("promo-title");
    if (!card) return;
    card.style.opacity = "0";
    setTimeout(() => card.remove(), 450);
  });
  await page.waitForTimeout(450);
}

/**
 * 下の真ん中に字幕を出す（前の字幕は差し替える）。
 * 原稿の本文の上に乗るので、黒の半透明の帯に白字にして、どの背景でも読めるようにする
 */
export async function showCaption(page: Page, text: string, place: CaptionPlace = {}): Promise<void> {
  await page.evaluate(
    ({ text, font, top, place }) => {
      let bar = document.getElementById("promo-caption");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "promo-caption";
        bar.style.cssText = [
          "position:fixed",
          "left:50%",
          "bottom:28px",
          "transform:translateX(-50%)",
          `z-index:${top}`,
          "max-width:86%",
          "padding:10px 26px",
          "border-radius:10px",
          "background:rgba(20,20,20,0.82)",
          "color:#ffffff",
          `font-family:${font}`,
          "font-size:26px",
          "font-weight:600",
          "letter-spacing:0.03em",
          "white-space:nowrap",
          "pointer-events:none",
          "transition:opacity 250ms ease",
          "opacity:0",
        ].join(";");
        document.body.appendChild(bar);
      }
      bar.style.left = place.left ?? "50%";
      bar.style.bottom = place.bottom ?? "28px";
      bar.textContent = text;
      // 一度描かせてから不透明にする（いきなり出すより目で追いやすい）
      requestAnimationFrame(() => {
        if (bar) bar.style.opacity = "1";
      });
    },
    { text, font: FONT, top: TOP, place }
  );
}

/**
 * 字幕の帯の置き場（CSS の値。帯の中心の横位置 `left` と、下からの距離 `bottom`）。
 * 省けば下の真ん中。場面ごとに、下のボタンや見せたい行にかからない所を選ぶ
 */
export interface CaptionPlace {
  left?: string;
  bottom?: string;
}

export async function hideCaption(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bar = document.getElementById("promo-caption");
    if (bar) bar.style.opacity = "0";
  });
}

/**
 * 描いたカーソルと星は、表題・字幕より1つ下、WebView の iframe より上に重ねる。
 * 表題（白）が出ているあいだは、どの順で足しても隠れる。字幕の帯の上に矢印が
 * 乗ると字が読みにくいので、帯よりも下にする
 */
const BELOW_TITLE = "2147483646";

/**
 * **Playwright の押す操作はマウスの絵（カーソル）を写さない**（OS の入力でなく
 * 画面への合図で押すため）。何も出さないと、見ている人には「勝手に飛んだ」ように
 * 見えるので、ふつうの矢印を描いて、押す前に押す所まで滑らせる。
 *
 * 動かし方：外側の箱が横、内側の箱が縦を受け持ち、**横と縦で緩め方を変える**。
 * 横は早く着いて、縦は少し遅れて着くので、まっすぐでなく緩い弧を描く（人の手の動き）。
 * どちらも終わりで減速する（ease-out）。CSS の transition に任せるのは、画面の外の窓でも
 * こまが落ちにくいため（毎こま JS で位置を計算するより、描く側に任せたほうが滑らか）
 */
const CURSOR_PATH = "M1.5 1.5 L1.5 24 L7.2 18.6 L11 27.5 L14.8 25.9 L11.1 17.2 L18.8 17.2 Z";

/** 1回の移動にかける時間（ミリ秒）＝ base + 距離×perPx を min〜max に収める。近ければ短く、遠くても 0.7 秒まで */
const MOVE_DURATION = { min: 400, max: 700, base: 380, perPx: 0.45 };

/**
 * カーソルを出す（すでにあれば、その場に置き直す）。表題の下に作っておけば、
 * 表題が薄れるのと一緒に見えてくる
 */
export async function showCursor(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y, d, z }) => {
      let outer = document.getElementById("promo-cursor");
      if (!outer) {
        outer = document.createElement("div");
        outer.id = "promo-cursor";
        const inner = document.createElement("div");
        inner.id = "promo-cursor-y";
        // ワークベンチは Trusted Types を求めるので innerHTML は使えない。要素を1つずつ作る
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("width", "22");
        svg.setAttribute("height", "30");
        svg.setAttribute("viewBox", "0 0 22 30");
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "#ffffff");
        path.setAttribute("stroke", "#000000");
        path.setAttribute("stroke-width", "1.6");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        inner.appendChild(svg);
        // 先端（SVG の 1.5,1.5）を指す点に合わせる
        inner.style.cssText = "position:absolute;left:-1.5px;top:-1.5px;line-height:0;filter:drop-shadow(1px 2px 1.5px rgba(0,0,0,0.35))";
        outer.appendChild(inner);
        outer.style.cssText = ["position:fixed", "left:0", "top:0", "width:0", "height:0", `z-index:${z}`, "pointer-events:none"].join(";");
        document.body.appendChild(outer);
      }
      const inner = document.getElementById("promo-cursor-y");
      outer.style.transition = "none";
      if (inner) inner.style.transition = "none";
      outer.style.transform = `translateX(${x}px)`;
      if (inner) inner.style.transform = `translateY(${y}px)`;
      outer.style.display = "block";
      outer.dataset.x = String(x);
      outer.dataset.y = String(y);
    },
    { x, y, d: CURSOR_PATH, z: BELOW_TITLE }
  );
}

export async function hideCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const outer = document.getElementById("promo-cursor");
    if (outer) outer.style.display = "none";
  });
}

/** カーソルを (x, y) まで滑らせ、着くまで待つ。カーソルがまだ無ければ、その場に出す */
export async function moveCursorTo(page: Page, x: number, y: number): Promise<void> {
  const duration = await page.evaluate(
    ({ x, y, durations }) => {
      const outer = document.getElementById("promo-cursor");
      const inner = document.getElementById("promo-cursor-y");
      if (!outer || !inner) return -1;
      const fromX = Number(outer.dataset.x ?? x);
      const fromY = Number(outer.dataset.y ?? y);
      const distance = Math.hypot(x - fromX, y - fromY);
      if (distance < 1) return 0;
      const ms = Math.round(Math.min(durations.max, Math.max(durations.min, durations.base + distance * durations.perPx)));
      outer.style.transition = `transform ${ms}ms cubic-bezier(0.25, 0.9, 0.4, 1)`;
      inner.style.transition = `transform ${ms}ms cubic-bezier(0.5, 0.05, 0.3, 1)`;
      // 置き直した直後に transition を変えても効かせるため、一度だけ描かせる
      void outer.offsetWidth;
      outer.style.transform = `translateX(${x}px)`;
      inner.style.transform = `translateY(${y}px)`;
      outer.dataset.x = String(x);
      outer.dataset.y = String(y);
      return ms;
    },
    { x, y, durations: MOVE_DURATION }
  );
  if (duration < 0) {
    await showCursor(page, x, y);
    return;
  }
  // 着いてから次の操作へ（少しだけ余らせて、着いたこまが写ってから押す）
  if (duration > 0) await page.waitForTimeout(duration + 80);
}

/**
 * 押した所から星を散らす（0.7秒）。黄色〜金色の ★ を7個、放射状に。
 *
 * **角度と距離は決め打ち**——撮り直しても同じ絵になるように（乱数を使わない）。
 * 白地に溶けないよう、薄い影を付ける
 */
export async function burstStarsAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y, z }) => {
      const stars = [
        { angle: -90, distance: 72, size: 26, color: "#ffc107", spin: 140 },
        { angle: -38, distance: 78, size: 22, color: "#ffb300", spin: -120 },
        { angle: 12, distance: 68, size: 24, color: "#ffd54f", spin: 160 },
        { angle: 62, distance: 74, size: 20, color: "#f9a825", spin: -150 },
        { angle: 118, distance: 70, size: 25, color: "#ffca28", spin: 130 },
        { angle: 168, distance: 76, size: 21, color: "#ffb300", spin: -170 },
        { angle: 218, distance: 66, size: 23, color: "#ffd740", spin: 110 },
      ];
      for (const star of stars) {
        const el = document.createElement("div");
        el.textContent = "★";
        el.style.cssText = [
          "position:fixed",
          `left:${x}px`,
          `top:${y}px`,
          `font-size:${star.size}px`,
          "line-height:1",
          `color:${star.color}`,
          "text-shadow:0 0 1px #8a6100, 0 1px 3px rgba(0,0,0,0.35)",
          `z-index:${z}`,
          "pointer-events:none",
          "will-change:transform,opacity",
        ].join(";");
        document.body.appendChild(el);
        const rad = (star.angle * Math.PI) / 180;
        const dx = Math.cos(rad) * star.distance;
        const dy = Math.sin(rad) * star.distance;
        // 中心で小さく生まれ、外へ飛びながら一度大きくなって、薄れて消える
        const animation = el.animate(
          [
            { transform: "translate(-50%, -50%) translate(0px, 0px) scale(0.3) rotate(0deg)", opacity: 1 },
            {
              transform: `translate(-50%, -50%) translate(${dx * 0.7}px, ${dy * 0.7}px) scale(1.15) rotate(${star.spin * 0.6}deg)`,
              opacity: 1,
              offset: 0.6,
            },
            {
              transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.6) rotate(${star.spin}deg)`,
              opacity: 0,
            },
          ],
          { duration: 720, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" }
        );
        animation.onfinish = () => el.remove();
        // 万一 onfinish が来なくても残さない
        setTimeout(() => el.remove(), 1200);
      }
    },
    { x, y, z: BELOW_TITLE }
  );
}

/** 押す所の指定。`offsetX` を省くと、要素の中央（幅が広ければ左から 120px） */
export interface CursorClickOptions {
  offsetX?: number;
}

/**
 * **台本から1行で呼ぶ「ここをカーソルで押す」。**
 * 描いたカーソルを押す所まで滑らせ → 星を散らし → 同じ点を本当に押す。
 * 星とカーソルの先端を、実際に押した点に揃えるため、`click` に位置を渡す
 */
export async function clickWithCursor(page: Page, target: Locator, options: CursorClickOptions = {}): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("押す所が画面に見えていません（boundingBox が取れない）");
  const offsetX = options.offsetX ?? Math.min(box.width / 2, 120);
  const offsetY = box.height / 2;
  await moveCursorTo(page, box.x + offsetX, box.y + offsetY);
  await burstStarsAt(page, box.x + offsetX, box.y + offsetY);
  await target.click({ position: { x: offsetX, y: offsetY } });
}

/** 描いたカーソルを、キー操作の邪魔にならない所（呼び出し側が決めた点）へ退かす */
export async function parkCursor(page: Page, x: number, y: number): Promise<void> {
  await moveCursorTo(page, x, y);
}

/** キーを押したことを示す小さな札（右上）。F8 のように画面に手が写らない操作のため */
export async function showKeyBadge(page: Page, label: string): Promise<void> {
  await page.evaluate(
    ({ label, font, top }) => {
      document.getElementById("promo-key")?.remove();
      const badge = document.createElement("div");
      badge.id = "promo-key";
      badge.textContent = label;
      badge.style.cssText = [
        "position:fixed",
        "right:28px",
        "top:52px",
        `z-index:${top}`,
        "padding:6px 16px",
        "border-radius:8px",
        "border:2px solid #444444",
        "border-bottom-width:5px",
        "background:#ffffff",
        "color:#222222",
        `font-family:${font}`,
        "font-size:24px",
        "font-weight:700",
        "pointer-events:none",
        "transition:opacity 300ms ease",
      ].join(";");
      document.body.appendChild(badge);
      setTimeout(() => {
        badge.style.opacity = "0";
        setTimeout(() => badge.remove(), 350);
      }, 1400);
    },
    { label, font: FONT, top: TOP }
  );
}
