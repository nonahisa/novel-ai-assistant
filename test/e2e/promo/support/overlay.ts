/**
 * 広報の動画（設計書6.114）で、画面の上に重ねる表題・字幕・押した印。
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
import type { Page } from "playwright-core";

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
export async function showCaption(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ text, font, top }) => {
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
      bar.textContent = text;
      // 一度描かせてから不透明にする（いきなり出すより目で追いやすい）
      requestAnimationFrame(() => {
        if (bar) bar.style.opacity = "1";
      });
    },
    { text, font: FONT, top: TOP }
  );
}

export async function hideCaption(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bar = document.getElementById("promo-caption");
    if (bar) bar.style.opacity = "0";
  });
}

/**
 * 押した所に輪を一瞬出す。
 *
 * **Playwright の押す操作はマウスの絵（カーソル）を写さない**（OS の入力でなく
 * 画面への合図で押すため）。何も出さないと、見ている人には「勝手に飛んだ」ように
 * 見えるので、押す所を輪で示す。
 */
export async function pulseAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y, top }) => {
      const ring = document.createElement("div");
      ring.style.cssText = [
        "position:fixed",
        `left:${x - 22}px`,
        `top:${y - 22}px`,
        "width:44px",
        "height:44px",
        "border-radius:50%",
        "border:4px solid #1a73e8",
        "background:rgba(26,115,232,0.18)",
        `z-index:${top}`,
        "pointer-events:none",
        "transition:transform 600ms ease-out, opacity 600ms ease-out",
        "transform:scale(0.6)",
        "opacity:1",
      ].join(";");
      document.body.appendChild(ring);
      requestAnimationFrame(() => {
        ring.style.transform = "scale(1.3)";
        ring.style.opacity = "0";
      });
      setTimeout(() => ring.remove(), 900);
    },
    { x, y, top: TOP }
  );
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
