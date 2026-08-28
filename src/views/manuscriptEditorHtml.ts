/**
 * 原稿エディタの画面（設計書6.25）。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （本文の引用符や `<` で画面が壊れるのを防ぐ）。提案パネルと同じ作法。
 *
 * ## 「書く」と「読む」を分けてある理由
 *
 * ルビを出したまま打てる画面（`contenteditable` に組み立てた見た目へ
 * 直接打ち込む形）は作れるが、**日本語の入力（IME）と相性が悪い。**
 * 変換中の文字を差し替えると、確定前の文字が消えたり二重に入ったりする。
 * ここは作者が1日じゅう触るところで、**壊れたときの被害が原稿そのもの**
 * である。
 *
 * そこで、
 *
 * - **書く面**は `<textarea>`。IMEは何も細工しなくても確実に効く。
 *   縦書きは `writing-mode` で効かせる（textareaにも効く）
 * - **読む面**は組み立てたHTML。ルビ・傍点・用語の色分けが出る
 *
 * 切り替えは1つのボタンで、**同じ場所を見続けられるようにする**。
 */

import { MANUSCRIPT_FONTS } from "../core/manuscriptFonts";

/**
 * 測る書体の名前。
 *
 * **一覧は `core/manuscriptFonts.ts` が持つ。** ここへ写すと、
 * 書体を1つ足すたびに2か所を直すことになる（片方が必ず古くなる）。
 *
 * 値をHTMLへ埋め込まない決まりの例外にあたるが、これは**作者の書いたもので
 * はなく、こちらが決めた定数**である（引用符や `<` は入らない）。
 */
const PROBE_FONT_NAMES = MANUSCRIPT_FONTS.map((font) => font.probe).filter(
  (name): name is string => name !== undefined
);

export function buildManuscriptEditorHtml(
  nonce: string,
  cspSource: string
): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>原稿</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}

/* ── 上の帯 ───────────────────────────── */
#bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto;
  flex-wrap: wrap;
}
button {
  font-family: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.on {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
#bar .gap { flex: 1 1 auto; }
#bar .count {
  font-size: 11px;
  opacity: 0.8;
  white-space: nowrap;
}
#bar .sep {
  width: 1px;
  align-self: stretch;
  background: var(--vscode-panel-border);
  margin: 0 2px;
}

/* ── 本文の面 ─────────────────────────── */
/* **下段。** 道具箱（上）とは役目が違う——上は「いま見ている原稿をどう見るか」、
   下は「次に何を書くか」。書いている最中に押すものなので、手の近くへ置く */
#bottom {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--vscode-panel-border, transparent);
  background: var(--vscode-editor-background);
}
#surface {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
}
#write, #read, #marks {
  position: absolute;
  inset: 0;
  padding: 24px 28px;
  overflow: auto;
  line-height: 1.9;
  font-size: var(--novelai-size, 16px);
  /* **小説は明朝で読む。** VS Code の編集用フォント（等幅の欧文書体）は
     縦書きの日本語を想定していないので、仮名の位置が揃わない。
     設定 novelai.manuscriptEditor.fontFamily で変えられる */
  font-family: var(--novelai-font, "Yu Mincho", "YuMincho",
    "Hiragino Mincho ProN", "MS Mincho", serif);
}
/* **打つ面の裏に敷く目印**（設計書6.25.6）。
   打つ面と同じ字送りで同じ本文を置き、用語のところだけ背景を塗る。
   **文字は出さない**（透明）。表の textarea の文字が本物で、
   変換中の文字もそちらに出る */
#marks {
  color: transparent;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 4;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}
/* 打っている間は隠す。**位置のずれた目印を出さない**——
   本文が変わってから新しい目印が届くまでの間、古い位置のまま残るため */
#marks.stale { visibility: hidden; }
/* 読む面・並べる面では、そちらに色が付くので要らない */
body.reading #marks, body.split #marks { display: none; }
.mark { border-radius: 2px; }
.mark-character { background: color-mix(in srgb, var(--novelai-character) 22%, transparent); }
.mark-location { background: color-mix(in srgb, var(--novelai-location) 22%, transparent); }
.mark-ability { background: color-mix(in srgb, var(--novelai-ability) 22%, transparent); }
.mark-organization { background: color-mix(in srgb, var(--novelai-organization) 22%, transparent); }
.mark-world { background: color-mix(in srgb, var(--novelai-world, var(--novelai-character)) 22%, transparent); }
body.plain .mark { background: transparent; }
#write {
  border: none;
  resize: none;
  width: 100%;
  height: 100%;
  color: var(--vscode-editor-foreground);
  background: transparent;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 4;
}
#read { white-space: normal; }
#read p.line {
  margin: 0;
  min-height: 1.9em;
}
/* 縦書き。**行の高さを「幅」として持つ**ので、指定はそのまま効く。
   **#marks（打つ面の裏の目印）も必ず同じ向きにする。** 0.22.24まで
   ここから漏れており、縦書きのとき裏だけ横書きで塗られて、目印が
   本文と無関係な場所（空白）に浮いていた（実機の報告、2026-08-27） */
/* **三点リーダを行の中央に寄せる**（作者の依頼、2026-08-28。読む面だけ）。
   横書き：欧文フォントに落ちると「…」が下に沈むので、中央を明示する。
   縦書き：横書きの向きに固定してから90度回す。フォントが縦用の字形
   （縦3点）を持つかに依存せず、同じ見た目になる。
   書く面（textarea）は文字単位の調整ができないため、フォントの形のまま */
#read .ellipsis {
  vertical-align: middle;
}
/* **箱を1em角の正方形に固定する**（実機の報告、2026-08-28）。
   寸法を決めないと箱の高さが行の高さ（約1.5文字分）になり、
   連続した「……」の間に隙間があく。また縦横比が崩れるため、
   フォントサイズを変えると回転の中心が柱からずれる。
   1em角なら送りは1文字分で、中心はフォントサイズに追従する */
body.vertical #read .ellipsis {
  writing-mode: horizontal-tb;
  display: inline-block;
  width: 1em;
  height: 1em;
  line-height: 1em;
  text-align: center;
  transform: rotate(90deg);
  transform-origin: center;
  vertical-align: baseline;
}
body.vertical #write, body.vertical #read, body.vertical #marks {
  writing-mode: vertical-rl;
  /* **upright にしない。** 全部を立てると、英数字が1文字ずつ縦に
     積まれる（2026 が4行になる）。既定の mixed は日本語の組版と
     同じ扱いで、英数字のまとまりを横に寝かせる */
  text-orientation: mixed;
  /*
    **傍線は行の右へ。**（作者の指示、2026-08-24）

    ただし**変換中の線には効かなかった**（実機で確認、設計書6.25.2）。
    あの線を引いているのは日本語入力の層で、本文の下線とは別の道を通る。
    ここに残してあるのは、本文へ下線を引く日が来たときのためである。

    縦書きの日本語では、傍線（下線）は行の右側に引く。変換中に日本語入力が
    引く線もこれに従う。既定（auto）では左に出ることがあり、**打っている
    文字の左に線が付くと、隣の行に付いているように見える。**

    横書きのときは、この指定は無視される（左右の別が無いため）ので、
    縦書きの指定の中だけに置けばよい。
  */
  text-underline-position: right;
  /* 縦書きでは上下の余白が「行頭・行末」になる */
  padding: 28px 24px;
}
body.vertical #read p.line { min-width: 1.9em; min-height: 0; }
/* 縦書きのときだけ、行の長さを紙のように区切る */
body.vertical.paged #surface { padding: 0; }

body.reading:not(.split) #write { visibility: hidden; pointer-events: none; }
body:not(.reading):not(.split) #read { visibility: hidden; pointer-events: none; }

/*
  並べる。**打つ面はそのまま、見る面を隣に置く。**
  ルビを出したまま打てる画面は日本語入力（IME）を壊すので作らない
  （設計書6.25）。代わりに、打ちながら組み上がりを見られるようにする。
*/
body.split #surface { display: flex; gap: 0; }
body.split #write, body.split #read {
  position: relative;
  inset: auto;
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
}
body.split #read { border-left: 1px solid var(--vscode-panel-border); }

/*
  **いま打っている行の印**（作者の要望、2026-08-28）。
  並べているとき、組み上がりのどこを打っているのかが分かるようにする。

  **背景は塗らない。** 読む面の色は用語の色分けに使っており、そこへ帯を
  敷くと本文の色が読めなくなる。行の始まる側に細い線を引くだけにする。

  **箱の形を変えない**（内側の影で描く）。border を足すと、印が移るたびに
  本文が数ピクセルずれて、行が踊って見える。
*/
body.split #read {
  --novelai-caret-line: color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent);
}
body.split #read p.line.at-caret {
  box-shadow: inset 2px 0 0 0 var(--novelai-caret-line);
}
/* 縦書きでは行は上から始まるので、線も上へ引く */
body.vertical.split #read p.line.at-caret {
  box-shadow: inset 0 2px 0 0 var(--novelai-caret-line);
}

/* ── ルビ・傍点・用語 ─────────────────── */
ruby > rt {
  font-size: 0.5em;
  opacity: 0.85;
  user-select: none;
}
em.emph {
  font-style: normal;
  text-emphasis: filled dot;
  -webkit-text-emphasis: filled dot;
  text-emphasis-position: over right;
  -webkit-text-emphasis-position: over right;
}
.term { cursor: pointer; border-radius: 2px; }
.term:hover { background: var(--vscode-editor-hoverHighlightBackground); }
.term-character { color: var(--novelai-character); }
.term-location { color: var(--novelai-location); }
.term-ability { color: var(--novelai-ability); }
.term-organization { color: var(--novelai-organization); }
body.plain .term { color: inherit; }

/* ── ホバーのチップ（読む面。作者の依頼、2026-08-28） ───── */
#tip {
  position: fixed;
  z-index: 15;
  max-width: 280px;
  padding: 6px 10px;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  color: var(--vscode-foreground);
  font-size: 12px;
  line-height: 1.5;
  /* 縦書きの面の上でも、チップは横書きで読む */
  writing-mode: horizontal-tb;
  display: none;
  /* チップ自身がマウスの当たりを奪うと、外れた瞬間に点滅する */
  pointer-events: none;
  white-space: pre-wrap;
}
#tip.open { display: block; }
#tip .tip-name { font-weight: bold; }
#tip .tip-kind { opacity: 0.7; margin-left: 6px; font-size: 11px; }

/* ── 右クリックの品書き ───────────────── */
#menu {
  position: fixed;
  z-index: 20;
  min-width: 190px;
  padding: 4px 0;
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-menu-background, var(--vscode-editor-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  display: none;
}
#menu.open { display: block; }
#menu .item {
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
#menu .item:hover {
  background: var(--vscode-menu-selectionBackground);
  color: var(--vscode-menu-selectionForeground);
}
#menu .item.disabled { opacity: 0.45; cursor: default; }
#menu .item.disabled:hover { background: transparent; color: inherit; }
#menu .rule {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
}
#menu .head {
  padding: 4px 14px;
  font-size: 11px;
  opacity: 0.7;
}

/* ── 下の帯（凡例と知らせ） ───────────── */
#foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 10px;
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 11px;
  opacity: 0.85;
  flex-wrap: wrap;
}
#foot .swatch::before {
  content: "■";
  margin-right: 3px;
}
#note {
  color: var(--vscode-notificationsInfoIcon-foreground, inherit);
}
</style>
</head>
<body class="vertical">
<div id="bar">
  <button id="mode" title="組み立てた表示と、打てる表示を切り替えます">読む</button>
  <button id="dir" title="縦書きと横書きを切り替えます">横書きにする</button>
  <button id="split" title="打つ面と、組み上がりを並べます">並べる</button>
  <div class="sep"></div>
  <button id="ruby" title="選んだ文字にルビを振ります">ルビ</button>
  <button id="emph" title="選んだ文字に傍点を付けます">傍点</button>
  <div class="sep"></div>
  <button id="copy" title="投稿サイトの記法に直してコピーします">投稿用にコピー</button>
  <button id="font" title="本文の書体を選びます">書体</button>
  <button id="smaller" title="文字を小さく">ー</button>
  <button id="bigger" title="文字を大きく">＋</button>
  <div class="gap"></div>
  <span class="count" id="count"></span>
</div>

<div id="surface">
  <div id="marks" aria-hidden="true"></div>
  <textarea id="write" spellcheck="false" wrap="soft"></textarea>
  <div id="read"></div>
</div>

<div id="bottom">
  <button id="latest" title="いちばん新しい話を開きます。白紙でなければ、次の話を作って開きます">最新話を書く</button>
</div>

<div id="foot">
  <span id="legend"></span>
  <span id="note"></span>
</div>

<div id="menu"></div>
<div id="tip"></div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const write = document.getElementById("write");
  const read = document.getElementById("read");
  /** 打つ面の裏に敷く目印（設計書6.25.6） */
  const marks = document.getElementById("marks");
  /** 用語の位置。右クリックで「どの用語の上か」を引くのに使う */
  let termSpans = [];
  /**
   * 届いた目印と、その元になった本文。**照合してから出す。**
   * 変換中は本文の適用が待たされるのに、目印だけ即座に出すと、
   * 古い本文向けの塗りが新しい本文の上に浮く（0.22.25で塞いだ競合）
   */
  let latestMarks = null;
  const menu = document.getElementById("menu");
  const countLabel = document.getElementById("count");
  const legend = document.getElementById("legend");
  const note = document.getElementById("note");
  const modeButton = document.getElementById("mode");
  const dirButton = document.getElementById("dir");
  const splitButton = document.getElementById("split");

  /** いま画面が持っている本文。拡張機能から来たものと比べるために持つ */
  let current = "";
  /**
   * 最後に自分が送った本文。
   *
   * **これと同じものが返ってきたら、打っている面には触らない。**
   * 自分の書き換えが文書へ入ると、拡張機能はその文書を送り返してくる。
   * それを入れ直すと、カーソルが飛び、変換中なら変換そのものが壊れる。
   */
  let lastSent = null;
  /** 変換中に外から届いた本文。確定してから片づける */
  let pending = null;
  /** 書いている間に届いた「読む面」。切り替えるときに当てる */
  let freshHtml = null;

  /**
   * その書体が、この端末に入っているか。
   *
   * **document.fonts.check は当てにならない。** 入っていない書体名でも
   * 逃げ先で描けてしまうため true を返す。**幅を測って見分ける**——
   * 入っていなければ逃げ先と同じ形で描かれ、幅が一致する。
   *
   * 逃げ先を2つ（serif と monospace）試すのは、**まれに逃げ先そのものと
   * 同じ幅になる**ためである。片方でも違えば、その書体で描かれている。
   */
  function fontInstalled(name) {
    const canvas = fontInstalled.canvas || (fontInstalled.canvas =
      document.createElement("canvas"));
    const context = canvas.getContext("2d");
    if (!context) return true;
    // 仮名と漢字と欧文を混ぜる。欧文だけだと、和文書体の違いが出ない
    const sample = "あ亜Aｱ漢";
    const width = (family) => {
      context.font = '16px ' + family;
      return context.measureText(sample).width;
    };
    return ["serif", "monospace"].some(
      (fallback) =>
        width('"' + name + '", ' + fallback) !== width(fallback)
    );
  }

  /** この端末に入っている書体（測るのは押されたときだけ） */
  function installedFonts(names) {
    try {
      return names.filter(fontInstalled);
    } catch (error) {
      // 測れなかったときは**何も渡さない**。
      // 「測れない」を「入っていない」と読み替えると、選べるものが消える
      return undefined;
    }
  }

  /** 測る書体。**一覧は core/manuscriptFonts.ts が持つ**（写さない） */
  const PROBE_FONTS = ${JSON.stringify(PROBE_FONT_NAMES)};

  /** 入口で決められた向きを、もう当てたか（当てるのは開いた1回だけ） */
  let forcedOnce = false;

  const saved = vscode.getState() || {};
  /** はじめの向きは設定から。**一度切り替えたら、その原稿ではそれを覚える** */
  let vertical = saved.vertical;
  let reading = saved.reading === true;
  /** 打つ面と組み上がりを並べる */
  let split = saved.split === true;
  let size = saved.size || 16;

  function remember() {
    vscode.setState({ vertical, reading, split, size });
  }

  /** 組み上がりが見えている場面か（並べているときも見えている） */
  function showingRead() {
    return reading || split;
  }

  function paint() {
    // 設定がまだ届いていない間は縦書きとして見せる（body の初期値と揃える）
    document.body.classList.toggle("vertical", vertical !== false);
    document.body.classList.toggle("reading", reading);
    document.body.classList.toggle("split", split);
    splitButton.textContent = split ? "並べるのをやめる" : "並べる";
    splitButton.classList.toggle("on", split);
    // 並べているときは、切り替えるものが無い
    modeButton.disabled = split;
    document.documentElement.style.setProperty("--novelai-size", size + "px");
    modeButton.textContent = reading ? "書く" : "読む";
    modeButton.classList.toggle("on", reading);
    dirButton.textContent = vertical !== false ? "横書きにする" : "縦書きにする";
    dirButton.classList.toggle("on", vertical !== false);
    // **書く面では、ルビは記法のまま見える。** そのことを一言添える。
    // 用語の色は6.25.6でこの面にも付くようになったので、無いとは言わない
    note.textContent = showingRead()
      ? ""
      : "ルビ・傍点は「読む」か「並べる」で出ます（この面では記法のまま見えます。用語には色が付き、右クリックで資料を開けます）";
  }

  /** 縦書きでは「上下」ではなく「左右」に流れる。位置合わせもそれに従う */
  function keepPlace(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    if (vertical !== false) {
      const total = fromEl.scrollWidth - fromEl.clientWidth;
      if (total > 0) {
        const ratio = fromEl.scrollLeft / total;
        toEl.scrollLeft = ratio * (toEl.scrollWidth - toEl.clientWidth);
      }
    } else {
      const total = fromEl.scrollHeight - fromEl.clientHeight;
      if (total > 0) {
        const ratio = fromEl.scrollTop / total;
        toEl.scrollTop = ratio * (toEl.scrollHeight - toEl.clientHeight);
      }
    }
  }

  modeButton.addEventListener("click", function () {
    const from = reading ? read : write;
    reading = !reading;
    // 書いている間に溜めておいた分を、ここで当てる
    if (reading) applyFreshHtml();
    paint();
    remember();
    const to = reading ? read : write;
    // 切り替えても同じあたりを見ていられるようにする
    requestAnimationFrame(function () { keepPlace(from, to); });
    if (!reading) write.focus();
  });

  splitButton.addEventListener("click", function () {
    split = !split;
    if (split) {
      // 追いかけの眠りは、並べ直すたびに解く（前回の眠りを持ち越さない）
      wakeFollow();
      applyFreshHtml();
      // 並べたら、打つのはこちら側である
      reading = false;
    } else {
      // 並べるのをやめたら、打っている行の印も消す
      clearCaretMark();
    }
    paint();
    remember();
    if (split) {
      requestAnimationFrame(function () {
        keepPlace(write, read);
        write.focus();
        // 並べた直後は、打っている行が見えているところから始める
        scheduleSync(true);
      });
    }
  });

  dirButton.addEventListener("click", function () {
    vertical = vertical === false;
    paint();
    remember();
  });

  document.getElementById("latest").addEventListener("click", function () {
    vscode.postMessage({ type: "openLatest" });
  });

  document.getElementById("font").addEventListener("click", function () {
    // **押されたときだけ測る。** 開くたびに測ると、その分だけ表示が遅れる
    vscode.postMessage({
      type: "pickFont",
      installed: installedFonts(PROBE_FONTS),
    });
  });

  document.getElementById("bigger").addEventListener("click", function () {
    size = Math.min(40, size + 1);
    paint();
    remember();
  });
  document.getElementById("smaller").addEventListener("click", function () {
    size = Math.max(9, size - 1);
    paint();
    remember();
  });

  document.getElementById("ruby").addEventListener("click", function () {
    askRuby();
  });
  document.getElementById("emph").addEventListener("click", function () {
    askEmphasis();
  });
  document.getElementById("copy").addEventListener("click", function () {
    vscode.postMessage({ type: "copyForPosting" });
  });

  /** 選んでいる文字。読む面では選択範囲、書く面では textarea の選択 */
  function selectionText() {
    if (reading) return String(window.getSelection() || "");
    return write.value.slice(write.selectionStart, write.selectionEnd);
  }

  function askRuby() {
    const text = selectionText();
    vscode.postMessage({
      type: "ruby",
      text: text,
      start: reading ? -1 : write.selectionStart,
      end: reading ? -1 : write.selectionEnd,
    });
  }

  function askEmphasis() {
    const text = selectionText();
    vscode.postMessage({
      type: "emphasis",
      text: text,
      start: reading ? -1 : write.selectionStart,
      end: reading ? -1 : write.selectionEnd,
    });
  }

  /* ── 打たれたら、変わったことだけを伝える ── */
  write.addEventListener("input", function () {
    // **目印は本文が変わった時点でずれる。** 新しいものが届くまで隠す。
    // 出したままにすると、1文字打つたびに色が横へずれて見える
    marks.classList.add("stale");
    // **変換中は送らない。** 確定前の文字を本文へ入れると、
    // 確定のたびに二重に入る
    if (composing) return;
    send();
    // 組み上がりが届くのは少しあと。先に印だけでも打っている行へ移す
    scheduleSync(true);
  });

  // 打つ面と裏地の見えている場所を合わせる。**ずれると色が別の字に付く**
  write.addEventListener("scroll", function () {
    marks.scrollTop = write.scrollTop;
    marks.scrollLeft = write.scrollLeft;
    /*
      並べているときは、組み上がりの側も一緒に動かす（作者の要望、2026-08-28）。
      **合わせるのは書く→読むの一方向だけ。** 逆も繋ぐと、読み返すために
      読む面を動かした瞬間に打つ面まで動き、書きかけの場所を見失う。
    */
    scheduleSync(false);
  });

  let composing = false;
  write.addEventListener("compositionstart", function () { composing = true; });
  write.addEventListener("compositionend", function () {
    composing = false;
    /*
      **確定した文字が入るのは、この直後のことがある。**
      compositionend が先に起き、確定ぶんの input があとから来る組み合わせ
      （Windowsの日本語入力）では、ここで読むとまだ確定前の中身である。
      1周まわしてから読む。
    */
    setTimeout(function () {
      send();
      // 変換中に外から届いていた書き換えは、ここで片づける
      flushPending();
      // 確定したので、追いかけを解禁する（変換中は止めてある）
      scheduleSync(true);
    }, 0);
  });

  /**
   * 打たれた本文を、そのまま文書へ返す。
   *
   * **待たせない。** 以前は200ミリ秒まとめていたが、
   *
   * - 打った直後に Ctrl+S を押すと、**最後の数文字が保存されない**
   * - 待っている間に届いた書き換えと、打った内容がぶつかる
   *
   * 日本語入力では input は変換中にも起きるが、そこは送らない。
   * **実際に送るのは「変換を確定したとき」＝語ごと**なので、
   * 打鍵のたびに送ることにはならない。
   */
  function send() {
    if (write.value === current) return;
    current = write.value;
    lastSent = current;
    vscode.postMessage({ type: "edit", text: current });
    updateCount();
  }

  /**
   * 拡張機能から届いた本文を、打っている面へ入れるかどうか決める。
   *
   * **触ってよい場面のほうが少ない。** 次の3つは触らない。
   *
   * 1. **変換中**（IME）。値を入れ直すと変換そのものが壊れる——
   *    確定前の文字が消える、二重に入る、変換が途中で止まる。
   *    作者が実機で当たったのはこれである（2026-08-24）
   * 2. **自分が送った本文が返ってきただけのとき。** 打つたびに
   *    文書が変わり、その文書がそのまま送り返される。入れ直すと
   *    カーソルが飛ぶ
   * 3. すでに同じ中身のとき
   */
  function takeIncoming(text) {
    if (composing) {
      // 確定するまで覚えておく。**いま入れると変換が壊れる**
      if (text !== lastSent && text !== write.value) pending = text;
      return;
    }
    if (text === lastSent) return;
    if (write.value === text) return;
    replaceKeepingCaret(text);
  }

  /**
   * 目印を、いまの本文と一致するときだけ出す。
   *
   * 一致しないまま出すと、古い位置に塗られて宙に浮く。一致しない場合は
   * 隠したままでよい——本文が変わった直後なら新しい update が向かっているし、
   * 変換待ちなら flushPending のあとにもう一度ここを通る。
   */
  /**
   * 鏡の描ける幅を、打つ面の実測に合わせる。
   *
   * 打つ面には**スクロールバーがあり、その分だけ本文の幅が狭い**。
   * 鏡は overflow:hidden でバーが無く、そのままだと全幅で折り返して
   * 1行の字数が変わり、**目印が1行ずつずれて空行の上に浮く**
   * （実機の報告、2026-08-27。横書きで確認された）。
   * 縦書きでは横のバーの高さぶんが同じ理由でずれる。両方を合わせる。
   */
  function alignMarksBox() {
    marks.style.right = (write.offsetWidth - write.clientWidth) + "px";
    marks.style.bottom = (write.offsetHeight - write.clientHeight) + "px";
  }

  function applyMarksIfMatch() {
    if (!latestMarks) return;
    if (latestMarks.forText !== write.value) return;
    alignMarksBox();
    marks.innerHTML = latestMarks.html;
    marks.scrollTop = write.scrollTop;
    marks.scrollLeft = write.scrollLeft;
    marks.classList.remove("stale");
  }

  // 窓の大きさが変わるとスクロールバーの有無も変わりうる。合わせ直す
  window.addEventListener("resize", function () {
    alignMarksBox();
    marks.scrollTop = write.scrollTop;
    marks.scrollLeft = write.scrollLeft;
  });

  /* ── 並べているときの追いかけ ──────────────────── */

  /**
   * 行の並びのうち、**前後が一致しない中間**を求める。
   *
   * 先頭から一致する数と末尾から一致する数を数え、残りを返す。
   * 同じなら null——「触らない」が正しい答えである。
   *
   * **画面の外から試せるように、印で挟んである**（この印の間を
   * test/unit/manuscriptSplitFollow.test.ts が取り出して動かす）。
   * src/core へ出すと画面側には写しを置くことになり、
   * **片方だけが直る日が必ず来る**ので、置き場はここ1つにした。
   */
  /* changedRange:start */
  function changedRange(before, after) {
    const max = Math.min(before.length, after.length);
    let head = 0;
    while (head < max && before[head] === after[head]) head++;
    let tail = 0;
    while (
      tail < max - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]
    ) {
      tail++;
    }
    const oldEnd = before.length - tail;
    const newEnd = after.length - tail;
    if (head === oldEnd && head === newEnd) return null;
    return { start: head, oldEnd: oldEnd, newEnd: newEnd };
  }
  /* changedRange:end */

  /** 読む面の中身が、想定どおり行の段落だけで出来ているか */
  function allLines(items) {
    for (const item of items) {
      if (item.nodeName !== "P") return false;
      if (!item.classList.contains("line")) return false;
    }
    return true;
  }

  /**
   * 段落を見比べるための文字列。
   *
   * **行番号（data-line）は入れない。** 改行を1つ足すと、それ以降の
   * 番号がすべてずれる。番号まで見比べると、中身の変わっていない段落が
   * 全部「変わった」ことになり、**改行のたびに後ろ全部を作り直す**。
   * 番号は入れ替えたあとで振り直す（renumberLines）。
   */
  function shapeOf(el) {
    return el.className + ">" + el.innerHTML;
  }

  /**
   * 行番号を振り直す。**打っている行を指すのに使う番号**なので、
   * 増減があったら合わせておかないと、追いかけが別の行を指す。
   */
  function renumberLines(from) {
    const items = read.children;
    for (let i = from; i < items.length; i++) {
      items[i].setAttribute("data-line", String(i));
    }
  }

  /**
   * 届いた組み上がりを、**変わった段落だけ**入れ替える。
   *
   * 4万字の本文では段落が千を超える。並べて打っているあいだは
   * 打った少しあとに毎回ここへ届くので、丸ごと作り直すと打つ手が止まり、
   * **読んでいた場所（スクロール）まで毎回飛ぶ。**
   *
   * 想定と違う中身（段落以外が混ざっている）なら false を返し、
   * 呼んだ側が丸ごと入れ替える。**細工より、正しく出ることが先**である。
   */
  function patchRead(html) {
    // 生きた HTMLCollection のまま動かすと、取り出した先から番号がずれる
    const before = Array.prototype.slice.call(read.children);
    if (before.length === 0) return false;
    const holder = document.createElement("template");
    holder.innerHTML = html;
    const after = Array.prototype.slice.call(holder.content.children);
    if (after.length === 0) return false;
    if (!allLines(before) || !allLines(after)) return false;

    const range = changedRange(before.map(shapeOf), after.map(shapeOf));
    // 中身が同じなら**触らない**。入れ直すだけでも読んでいた場所は動く
    if (range === null) return true;

    const fragment = document.createDocumentFragment();
    for (let i = range.start; i < range.newEnd; i++) {
      fragment.appendChild(after[i]);
    }
    // 入れ先は、消す区間のすぐ後ろの段落。末尾まで消すときは null（＝最後尾へ）
    const anchor = before[range.oldEnd] || null;
    for (let i = range.start; i < range.oldEnd; i++) {
      read.removeChild(before[i]);
    }
    read.insertBefore(fragment, anchor);
    // 行が増減したときだけ、後ろの番号がずれている
    if (before.length !== after.length) renumberLines(range.start);
    return true;
  }

  /** 溜めておいた組み上がりを当てる。見えていないときは溜めたままにする */
  function applyFreshHtml() {
    if (freshHtml === null) return;
    const html = freshHtml;
    freshHtml = null;
    /*
      印を外してから当てる。**届いたHTMLに印は付いていない**ので、
      付けたまま比べると、その段落だけ必ず「変わった」と見なされる
    */
    clearCaretMark();
    if (!patchRead(html)) read.innerHTML = html;
    // 1フレームでも印が消えると、打っている間ずっと点滅して見える
    markCaretLine(caretLine());
    if (split) scheduleSync(true);
  }

  /** いま印の付いている段落。付け替えるたびに探し直さないために持つ */
  let markedLine = null;

  /** カーソルのある行（＝カーソルまでにある改行の数） */
  function caretLine() {
    const at = write.selectionStart;
    if (typeof at !== "number") return 0;
    const text = write.value;
    const end = Math.min(at, text.length);
    // slice で切り出すと、打鍵のたびに4万字を写すことになる。その場で数える
    let line = 0;
    for (let i = 0; i < end; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  function lineElement(line) {
    return read.querySelector('[data-line="' + line + '"]');
  }

  function clearCaretMark() {
    if (markedLine) markedLine.classList.remove("at-caret");
    markedLine = null;
  }

  /** 打っている行に印を付ける。**並べているときだけ**（読む面は読むための面） */
  function markCaretLine(line) {
    if (!split) {
      clearCaretMark();
      return;
    }
    const target = lineElement(line);
    if (target === markedLine) return;
    clearCaretMark();
    if (target) {
      target.classList.add("at-caret");
      markedLine = target;
    }
  }

  /**
   * 作者が読む面へ手を出したら、しばらく追いかけない。
   *
   * **読み返している最中に、打っている行へ引き戻されるのがいちばん困る。**
   * 数秒眠り、時間が経つか、**カーソルが行をまたいで動いたら**
   * （＝また書きはじめた合図）その場で起きる。
   *
   * 眠る合図に読む面の scroll を使わないのは、**こちらが動かしたぶんや、
   * 本文が伸びたときの画面側の調整も scroll として届く**ためである。
   * 縦書きでは行が右から左へ伸びるので、1行増えるだけで位置が動く。
   * 車輪・押下・指の動きだけを「手を出した」と数える。
   */
  const FOLLOW_SLEEP_MS = 3000;
  let sleepUntil = 0;
  let sleepLine = -1;

  function wakeFollow() {
    sleepUntil = 0;
    sleepLine = -1;
  }

  function sleepFollow() {
    if (!split) return;
    sleepUntil = Date.now() + FOLLOW_SLEEP_MS;
    sleepLine = caretLine();
  }

  /** いま追いかけてよいか */
  function following(line) {
    if (sleepUntil === 0) return true;
    if (Date.now() >= sleepUntil) {
      wakeFollow();
      return true;
    }
    if (line !== sleepLine) {
      // 行をまたいだ＝また書きはじめた。眠りから起きる
      wakeFollow();
      return true;
    }
    return false;
  }

  /**
   * その段落が読む面からはみ出している量。中に入っていれば 0。
   *
   * **scrollIntoView を使わない。** あれは上の入れ物まで動かすことがあり、
   * #surface は overflow:hidden なので、動くと戻す手立てが無い。
   * はみ出しを足し引きするだけなら、縦書き（左右に流れる）でも
   * 横書き（上下に流れる）でも同じ式で足りる——**割合ではなく差**なので、
   * 縦書きでスクロール値の数え方が違っても効く。
   */
  function offView(el) {
    const box = read.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    // ぎりぎりに寄せると次の行が見えない。少しだけ内側へ入れる
    const slack = 24;
    let left = 0;
    if (rect.left < box.left) left = rect.left - box.left - slack;
    else if (rect.right > box.right) left = rect.right - box.right + slack;
    let top = 0;
    if (rect.top < box.top) top = rect.top - box.top - slack;
    else if (rect.bottom > box.bottom) top = rect.bottom - box.bottom + slack;
    return { left: left, top: top };
  }

  /**
   * 読む面を、その段落が見えるところまで**そっと**動かす。
   *
   * 中央には寄せない。1行動くたびに画面が真ん中まで動くと、
   * **目が付いていけない**（読んでいるほうが疲れる）。
   */
  function nudgeIntoView(el) {
    const off = offView(el);
    if (off.left === 0 && off.top === 0) return;
    if (off.left !== 0) read.scrollLeft += off.left;
    if (off.top !== 0) read.scrollTop += off.top;
  }

  /**
   * 並べているときの追いかけ。**カーソルを優先する。**
   *
   * 割合合わせ（keepPlace）は、カーソルが画面から出るほどの大移動を拾う
   * 補いである。カーソルの行が見えているなら、割合で合わせ直さない——
   * 合わせ直すと、いま打っている行のほうが画面の外へ出ていく。
   */
  function runSync(byCaret) {
    if (!split) return;
    const line = caretLine();
    markCaretLine(line);
    // 変換中は動かさない。画面が跳ねると、変換している文字を目で追えなくなる
    if (composing) return;
    // 手で読み返している最中は、引き戻さない
    if (!following(line)) return;
    const target = lineElement(line);
    if (byCaret) {
      // 行が見つからないのは、組み上がりがまだ届いていないとき。
      // **割合で飛ばさずに待つ**（次に届いたところで、もう一度ここを通る）
      if (target) nudgeIntoView(target);
      return;
    }
    if (target) {
      const off = offView(target);
      if (off.left === 0 && off.top === 0) return;
    }
    keepPlace(write, read);
  }

  /**
   * 追いかけの予約。
   *
   * 打鍵とスクロールの両方から何度も呼ばれるので、**1フレームに1回**へ
   * まとめる。同じフレームで両方が来たら、カーソルのほうを採る。
   */
  let syncTimer = null;
  let syncByCaret = false;
  function scheduleSync(byCaret) {
    if (!split) return;
    if (byCaret) syncByCaret = true;
    if (syncTimer !== null) return;
    syncTimer = requestAnimationFrame(function () {
      syncTimer = null;
      const wanted = syncByCaret;
      syncByCaret = false;
      runSync(wanted);
    });
  }

  // カーソルが動いたら、組み上がりの側も追いかける。
  // **変換中は追いかけない**（変換の途中で画面が動くと、変換が見づらい）
  document.addEventListener("selectionchange", function () {
    if (document.activeElement !== write) return;
    if (composing) return;
    scheduleSync(true);
  });

  /** 変換が確定したあとに、待たせていた書き換えを片づける */
  function flushPending() {
    const text = pending;
    pending = null;
    if (text === null) return;
    // **打った内容のほうを優先する。** 変換している間に外から
    // 書き換えが来たなら、確定した文字を捨てるより送り直すほうがよい
    if (write.value !== current) { send(); return; }
    takeIncoming(text);
    // 待たせていた本文が入ったので、目印も出せるようになったかもしれない
    applyMarksIfMatch();
  }

  /**
   * 外からの書き換えを当てる。**カーソルの位置をできるだけ保つ。**
   *
   * 前から一致する長さを見て、カーソルがそれより前なら動かさない。
   * 後ろなら、増えた（減った）ぶんだけずらす。
   */
  function replaceKeepingCaret(text) {
    const before = write.value;
    const start = write.selectionStart;
    const end = write.selectionEnd;
    let common = 0;
    const max = Math.min(before.length, text.length);
    while (common < max && before[common] === text[common]) common++;
    const delta = text.length - before.length;
    const move = function (at) {
      if (at <= common) return at;
      return Math.max(common, Math.min(text.length, at + delta));
    };
    /*
      **見ている場所も保つ。** 縦書きでは行が右から左へ並ぶので、
      本文が短くなると左端（＝いちばん新しい行）の位置がずれ、
      値を入れ直しただけで画面が飛ぶ（作者の指摘、2026-08-24）。
    */
    const left = write.scrollLeft;
    const top = write.scrollTop;
    write.value = text;
    try {
      write.setSelectionRange(move(start), move(end));
    } catch (e) {
      /* 範囲外なら諦める */
    }
    write.scrollLeft = left;
    write.scrollTop = top;
  }

  function updateCount() {
    // 数え方は拡張機能側に合わせる（ルビの読み仮名は数えない）
    vscode.postMessage({ type: "count", text: write.value });
  }

  /* ── 右クリック ────────────────────── */
  let menuTerm = null;

  function closeMenu() {
    menu.classList.remove("open");
    menuTerm = null;
  }

  function openMenu(x, y, term, hasSelection) {
    menu.innerHTML = "";
    menuTerm = term;

    function add(label, onClick, enabled) {
      const item = document.createElement("div");
      item.className = "item" + (enabled === false ? " disabled" : "");
      item.textContent = label;
      if (enabled !== false) {
        item.addEventListener("click", function () {
          closeMenu();
          onClick();
        });
      }
      menu.appendChild(item);
      return item;
    }
    function rule() {
      const r = document.createElement("div");
      r.className = "rule";
      menu.appendChild(r);
    }

    if (term) {
      const head = document.createElement("div");
      head.className = "head";
      head.textContent = term.name;
      menu.appendChild(head);
      add("設定資料を見る", function () {
        vscode.postMessage({ type: "openTerm", id: term.id, kind: term.kind });
      });
      rule();
    }

    add("ルビを振る", askRuby, hasSelection || !reading);
    add("傍点を付ける", askEmphasis, hasSelection);
    rule();
    add("投稿サイト用にコピー", function () {
      vscode.postMessage({ type: "copyForPosting" });
    });
    add("選んだところをAIに相談", function () {
      vscode.postMessage({
        type: "chat",
        start: reading ? -1 : write.selectionStart,
        end: reading ? -1 : write.selectionEnd,
      });
    }, hasSelection);

    menu.classList.add("open");
    // 画面の外へはみ出さないように収める
    const box = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - box.width - 4);
    const top = Math.min(y, window.innerHeight - box.height - 4);
    menu.style.left = Math.max(0, left) + "px";
    menu.style.top = Math.max(0, top) + "px";
  }

  /**
   * 打つ面で、カーソルの位置にある用語。
   *
   * **当たり判定を要素で取れない**（textarea の中に要素は無い）。
   * 右クリックするとカーソルがそこへ移るので、その文字位置から引く。
   */
  function termAtCaret() {
    const at = write.selectionStart;
    if (typeof at !== "number") return null;
    for (const span of termSpans) {
      // 端は含めない。用語の直後で右クリックして隣の資料が開くと分かりにくい
      if (at >= span.start && at < span.end) {
        return { id: span.id, kind: span.kind, name: span.name };
      }
    }
    return null;
  }

  /**
   * 打つ面で、選択範囲に重なる用語（作者の依頼、2026-08-28）。
   *
   * 点（カーソル位置）だけだと、範囲を選んでから右クリックしたときに
   * 選んだ語の資料が引けない。選択があるときは、範囲に重なる最初の
   * 用語を対象にする（選択内の右クリックは選択を保つので、この順で効く）。
   */
  function termInSelection() {
    const start = write.selectionStart;
    const end = write.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number" || end <= start) {
      return null;
    }
    for (const span of termSpans) {
      if (span.start < end && span.end > start) {
        return { id: span.id, kind: span.kind, name: span.name };
      }
    }
    return null;
  }

  function termFrom(target) {
    // 打つ面には要素が無いので、カーソルの位置から引く。
    // 範囲を選んでいれば、範囲に重なる用語を優先する
    if (target === write) return termInSelection() || termAtCaret();
    const el = target && target.closest ? target.closest(".term") : null;
    if (!el) return null;
    return {
      id: el.getAttribute("data-term-id"),
      kind: el.getAttribute("data-term-kind"),
      name: el.getAttribute("data-term-name"),
    };
  }

  document.addEventListener("contextmenu", function (event) {
    if (event.target === menu || menu.contains(event.target)) return;
    event.preventDefault();
    openMenu(
      event.clientX,
      event.clientY,
      termFrom(event.target),
      selectionText().length > 0
    );
  });

  document.addEventListener("click", function (event) {
    if (!menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  /** 読む面で用語を押したら、そのまま資料を開く */
  read.addEventListener("click", function (event) {
    const term = termFrom(event.target);
    if (term) {
      vscode.postMessage({ type: "openTerm", id: term.id, kind: term.kind });
    }
  });

  /* ── 読む面のホバーのチップ（作者の依頼、2026-08-28） ── */
  const tip = document.getElementById("tip");
  const TIP_KIND_LABELS = {
    character: "人物",
    location: "場所",
    ability: "能力",
    organization: "組織",
  };

  /** 紹介の一文。届いた用語の一覧（termSpans）から同じidを引く */
  function tipSummaryOf(id) {
    for (const span of termSpans) {
      if (span.id === id && span.summary) return span.summary;
    }
    return "";
  }

  read.addEventListener("mouseover", function (event) {
    const el =
      event.target && event.target.closest
        ? event.target.closest(".term")
        : null;
    if (!el) {
      tip.classList.remove("open");
      return;
    }
    tip.innerHTML = "";
    const head = document.createElement("div");
    const nameEl = document.createElement("span");
    nameEl.className = "tip-name";
    nameEl.textContent = el.getAttribute("data-term-name") || "";
    const kindEl = document.createElement("span");
    kindEl.className = "tip-kind";
    kindEl.textContent =
      TIP_KIND_LABELS[el.getAttribute("data-term-kind")] || "";
    head.appendChild(nameEl);
    head.appendChild(kindEl);
    tip.appendChild(head);
    const body = document.createElement("div");
    const summary = tipSummaryOf(el.getAttribute("data-term-id"));
    // 紹介が無くても名前と種別だけのチップを出す（クリックで資料を開ける）
    body.textContent = summary || "（紹介はまだありません）";
    tip.appendChild(body);
    tip.classList.add("open");
    // 用語の近くに出し、画面の外へはみ出さないよう収める
    const rect = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - box.width - 8);
    const below = rect.bottom + 6;
    const top =
      below + box.height > window.innerHeight
        ? rect.top - box.height - 6
        : below;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = Math.max(4, top) + "px";
  });
  read.addEventListener("mouseout", function (event) {
    const el =
      event.target && event.target.closest
        ? event.target.closest(".term")
        : null;
    if (el) tip.classList.remove("open");
  });
  read.addEventListener("scroll", function () {
    tip.classList.remove("open");
  });

  /*
    **読む面へ手を出したら、追いかけを眠らせる**（作者の要望、2026-08-28）。
    読み返しているところへ、打っている行から引き戻されるのが最悪である。

    合図に scroll を使わないのは、追いかけで動かしたぶんも、本文が伸びた
    ときの調整も scroll として届くためで、それだと**自分の動きで自分が
    眠る**。車輪・押下（つまみの掴みを含む）・指の動きだけを数える。
  */
  read.addEventListener("wheel", sleepFollow, { passive: true });
  read.addEventListener("mousedown", sleepFollow);
  read.addEventListener("touchstart", sleepFollow, { passive: true });

  /* ── 拡張機能からの知らせ ──────────── */
  window.addEventListener("message", function (event) {
    const message = event.data;
    if (message.type === "update") {
      current = message.text;
      takeIncoming(message.text);
      /*
        **打っている間は、読む面を組み立て直さない。**
        4万字の本文では段落が千を超える。打つたびにそれを作り直すと、
        画面がつかえて「変換が途中で止まった」ように感じる。
        見えていないのだから、切り替えるときに作ればよい。
      */
      freshHtml = message.html;
      if (showingRead()) applyFreshHtml();
      if (typeof message.marks === "string") {
        latestMarks = { forText: message.text, html: message.marks };
        applyMarksIfMatch();
      }
      if (Array.isArray(message.terms)) termSpans = message.terms;
      if (typeof message.forceVertical === "boolean" && !forcedOnce) {
        // **「原稿（横書）」で開いたなら、その原稿が縦を覚えていても横で開く。**
        // 選んで開いたのに前の向きが勝つと、選んだ意味が無い。
        // 効かせるのは開いた1回だけで、そのあと切り替えればそちらを覚える
        forcedOnce = true;
        vertical = message.forceVertical;
        remember();
        paint();
      } else if (typeof vertical !== "boolean") {
        // まだ切り替えたことがない原稿。設定の向きで開く
        vertical = message.verticalDefault !== false;
        paint();
      }
      if (message.fontFamily) {
        document.documentElement.style.setProperty(
          "--novelai-font",
          message.fontFamily
        );
      }
      if (message.colors) {
        for (const key of Object.keys(message.colors)) {
          document.documentElement.style.setProperty(
            "--novelai-" + key,
            message.colors[key]
          );
        }
      }
      document.body.classList.toggle("plain", message.hasTerms === false);
      legend.innerHTML = "";
      if (message.legend) {
        for (const item of message.legend) {
          const span = document.createElement("span");
          span.className = "swatch";
          span.style.color = "var(--novelai-" + item.kind + ")";
          span.textContent = item.label;
          legend.appendChild(span);
          legend.appendChild(document.createTextNode(" "));
        }
      }
    } else if (message.type === "count") {
      countLabel.textContent = message.label;
    } else if (message.type === "select" && !reading) {
      // ルビを入れたあと、入れた場所を選び直す
      write.focus();
      try { write.setSelectionRange(message.start, message.end); } catch (e) { /* 範囲外 */ }
    }
  });

  paint();
  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
