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
 *
 * ## 第4の面「組んで書く（実験）」（設計書6.34）
 *
 * 打つ面そのものにルビ・傍点が組まれて出る `contenteditable` の面を、
 * **実験として別に足した**。上の3面（書く・読む・並べる）には手を入れて
 * いない——実験が壊れても、いままでの書き方は無傷で残る。
 *
 * この面でいちばん危ないのは、DOMから記法テキストへ戻すところである。
 * ずれた瞬間に本文が壊れるので、
 *
 * - 面に入るとき **`記法→DOM→記法` が元の本文と一致するかを確かめる**
 *   （一致しなければ入らない）
 * - 貼り付けは**平文だけ**を入れる（外のHTMLが混ざると直列化が壊れる）
 * - 用語の色付けは **CSS Custom Highlight API**（DOMを書き換えない）
 *
 * を守る。
 */

import { MANUSCRIPT_FONTS } from "../core/manuscriptFonts";
import { NOTATION_PATTERN } from "../core/manuscriptRender";

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
#write, #read, #marks, #compose {
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
/* **打つ面に重ねる用語の色**（設計書6.25.6）。
   打つ面と同じ字送りで同じ本文を置き、用語のところだけ色を付ける。
   用語以外の文字は透明のまま——見えている字は textarea のものである。

   ## なぜ「上」に重ねるのか（作者の依頼、2026-08-28）
   マーカー（背景の塗り）ではなく**文字色**にしてほしい、という指示による。
   背景なら裏に敷けば足りたが、色は文字そのものに乗せないと出ない。
   同じ字形が同じ位置に重なるので、色の付いた字が黒字の上へぴったり載り、
   「その語だけ色が変わった」ように見える。

   ## なぜ textarea 側の字を透明にしないのか
   **変換中（IME）の文字は textarea にしか無い。** 打っている最中の文字は
   まだ本文へ入っておらず、こちらの目印にも現れない。textarea を透明に
   すると、**打っている字が見えなくなる。** */
#marks {
  color: transparent;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 4;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  /* 打つ面より上へ。DOMの並びでは textarea が後ろにいるので、明示する */
  z-index: 2;
}
/* 打っている間は隠す。**位置のずれた目印を出さない**——
   本文が変わってから新しい目印が届くまでの間、古い位置のまま残るため */
#marks.stale { visibility: hidden; }
/* 読む面・並べる面では、そちらに色が付くので要らない */
body.reading #marks, body.split #marks { display: none; }
/* **色は読む面・組んで書く面と同じ変数から取る**（画面ごとに違う色にしない）。
   角丸は塗りのためのものだったので、色にした今は要らない */
.mark-character { color: var(--novelai-character); }
.mark-location { color: var(--novelai-location); }
.mark-ability { color: var(--novelai-ability); }
.mark-organization { color: var(--novelai-organization); }
.mark-world { color: var(--novelai-world, var(--novelai-character)); }
/* 用語が1件も無い作品では、重ねた字を出さない（透明のまま） */
body.plain .mark { color: transparent; }
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
   **#marks（打つ面に重ねる用語の色）も必ず同じ向きにする。** 0.22.24まで
   ここから漏れており、縦書きのとき重ねる面だけ横書きで組まれて、色が
   本文と無関係な場所（空白）に浮いていた（実機の報告、2026-08-27） */
/* **三点リーダを行の中央に寄せる**（作者の依頼、2026-08-28）。
   横書き：欧文フォントに落ちると「…」が下に沈むので、中央を明示する。
   縦書き：横書きの向きに固定してから90度回す。フォントが縦用の字形
   （縦3点）を持つかに依存せず、同じ見た目になる。
   ここは読む面ぶん。組んで書く面は #compose .ellipsis で同じ形にしてある。
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
body.vertical #write, body.vertical #read, body.vertical #marks,
body.vertical #compose {
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

/* ── 組んで書く（実験）（設計書6.34） ─────────────
   **この面だけを出す。** 打ちながらルビ・傍点が組まれて見える代わりに、
   contenteditable の地雷（変換中のDOM書き換え・カーソルの崩壊）を踏む
   可能性がある実験の面なので、**いつでも上の3面へ戻れる**ことを優先する */
#compose {
  display: none;
  outline: none;
  /* **空白を潰さない。** 原稿の字下げ（全角空白）や連続した空白がそのまま
     見えることに加え、pre-wrap では**打った空白がそのまま空白で入る**——
     潰れる指定だと、ブラウザが代わりに &nbsp;（U+00A0）を差し込む */
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 4;
  color: var(--vscode-editor-foreground);
}
body.compose #compose { display: block; }
/* 上の3面は、この面が出ている間は隠す（描かせない） */
body.compose #write, body.compose #read, body.compose #marks { display: none; }
/* 行の段落。**打っている間に増える入れ物にも効かせる**——改行で作られる
   入れ物は環境によって p と div のどちらにもなりうる（直列化の側は
   どちらも行の切れ目として読む） */
#compose p, #compose div {
  margin: 0;
  min-height: 1.9em;
}
body.vertical #compose p, body.vertical #compose div {
  min-width: 1.9em;
  min-height: 0;
}
/* **かたまり（ルビ・傍点）は編集不可**（設計書6.34.2）。中の文字を直接
   直せないので、消すときは1単位で消える。選んだときに1文字のように
   振る舞わせるため、余計な余白は付けない */
#compose ruby[data-src], #compose .emphasis[data-src] {
  /* 選択の見た目を、ふつうの文字と揃える */
  border-radius: 2px;
}
/* **三点リーダを行の中央に寄せる**（作者の依頼、2026-08-28）。
   読む面（#read .ellipsis）で作者が確かめた形をそのまま使う——
   同じ本文が面によって違って見えるのは、それ自体が不具合である。
   組み立て側は composeBuildEllipsis が「…」1文字ずつを
   **編集不可のかたまり**にしている（書式が次の字へ伝染しないように） */
#compose .ellipsis {
  vertical-align: middle;
}
/* **箱を1em角の正方形に固定する。** 寸法を決めないと箱の高さが行の高さに
   なって「……」の間に隙間があき、フォントサイズを変えると回転の中心が
   柱からずれる（読む面と同じ理由） */
body.vertical #compose .ellipsis {
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
/* 圏点は読む面と同じ出し方（em.emph と同じ指定を分け合う） */
#compose .emphasis {
  font-style: normal;
  text-emphasis: filled dot;
  -webkit-text-emphasis: filled dot;
  text-emphasis-position: over right;
  -webkit-text-emphasis-position: over right;
}
/* **用語の色付けは CSS Custom Highlight API で行う**（設計書6.34.3）。
   重ね敷き（#marks）も印の要素も使わないので、色を付けてもDOMは変わらず、
   カーソルも取り消し履歴も動かない。使えない環境では色が出ないだけ */
::highlight(novelai-term-character) { color: var(--novelai-character); }
::highlight(novelai-term-location) { color: var(--novelai-location); }
::highlight(novelai-term-ability) { color: var(--novelai-ability); }
::highlight(novelai-term-organization) { color: var(--novelai-organization); }

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
  <button id="composeMode" title="ルビ・傍点を組んだまま打ちます（実験。うまく打てないときは戻してください）">組んで書く（実験）</button>
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
  <div id="compose" spellcheck="false"></div>
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
  /** 打つ面に重ねる用語の色（設計書6.25.6） */
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
  /** 組んで書く（実験。設計書6.34） */
  const compose = document.getElementById("compose");
  const composeButton = document.getElementById("composeMode");

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
  /**
   * 組んで書く（実験）の面にいるか（設計書6.34）。
   *
   * **覚えていても、すぐには開かない。** この面は本文から組み立てるので、
   * 最初の update が届くまで中身が無い。届いてから開く（composeWanted）。
   */
  let composeOn = false;
  let composeWanted = saved.compose === true;
  let size = saved.size || 16;

  function remember() {
    // **まだ開いていないだけの状態を、閉じたことにしない**（composeWanted）
    vscode.setState({ vertical, reading, split, size, compose: composeOn || composeWanted });
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
    document.body.classList.toggle("compose", composeOn);
    splitButton.textContent = split ? "並べるのをやめる" : "並べる";
    splitButton.classList.toggle("on", split);
    // 並べているときは、切り替えるものが無い
    modeButton.disabled = split || composeOn;
    // **組んで書く面は、いままでの3面とは別物である。** 混ぜて見せると、
    // どちらの面で打っているのか分からなくなる
    splitButton.disabled = composeOn;
    composeButton.textContent = composeOn
      ? "組んで書くのをやめる"
      : "組んで書く（実験）";
    composeButton.classList.toggle("on", composeOn);
    document.documentElement.style.setProperty("--novelai-size", size + "px");
    // **大きさも向きもここで変わる。** どちらも折り返し幅を変えるので、
    // 重ねた色の枠を測り直す（実機の報告、2026-08-28）
    scheduleAlignMarks();
    modeButton.textContent = reading ? "書く" : "読む";
    modeButton.classList.toggle("on", reading);
    dirButton.textContent = vertical !== false ? "横書きにする" : "縦書きにする";
    dirButton.classList.toggle("on", vertical !== false);
    // **書く面では、ルビは記法のまま見える。** そのことを一言添える。
    // 用語の色は6.25.6でこの面にも付くようになったので、無いとは言わない
    if (composeOn) {
      note.textContent =
        "組んで書く（実験）：ルビ・傍点は1つのかたまりとして扱います" +
        "（中の文字は直接直せません。消すときは1単位で消えます）。" +
        "うまく打てないときは、もう一度押して「書く」へ戻してください";
    } else {
      note.textContent = showingRead()
        ? ""
        : "ルビ・傍点は「読む」か「並べる」で出ます（この面では記法のまま見えます。用語には色が付き、右クリックで資料を開けます）";
    }
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
    if (composeOn || reading) return String(window.getSelection() || "");
    return write.value.slice(write.selectionStart, write.selectionEnd);
  }

  function askRuby() {
    if (composeOn) {
      composeAskNotation("ruby");
      return;
    }
    const text = selectionText();
    vscode.postMessage({
      type: "ruby",
      text: text,
      start: reading ? -1 : write.selectionStart,
      end: reading ? -1 : write.selectionEnd,
    });
  }

  function askEmphasis() {
    if (composeOn) {
      composeAskNotation("emphasis");
      return;
    }
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
   * 1行の字数が変わり、**色の付く字が1行ずつずれる**
   * （実機の報告、2026-08-27。横書きで確認された）。
   * 縦書きでは横のバーの高さぶんが同じ理由でずれる。両方を合わせる。
   *
   * **測り直す機会が足りていなかった**（実機の報告、2026-08-28
   * 「文字サイズを変えるとマーカーが追随しません」）。ここを呼んでいたのは
   * 目印が届いたときだけで、目印が届くのは**本文が変わったとき**である。
   * 文字の大きさを変えるとスクロールバーが出たり消えたりして折り返し幅が
   * 変わるのに、本文は変わらないので測り直されなかった。
   */
  function alignMarksBox() {
    marks.style.right = (write.offsetWidth - write.clientWidth) + "px";
    marks.style.bottom = (write.offsetHeight - write.clientHeight) + "px";
  }

  /**
   * 測り直しの予約。**1フレームに1回**へまとめる。
   *
   * 大きさ・向き・本文の伸び縮み・窓の大きさと、きっかけが4つあって
   * 同じ瞬間に重なる（向きを変えれば本文の折り返しも変わる）。
   * まとめずに呼ぶと、1回の操作で何度も採寸が走る。
   *
   * **フレームまで待つのにも意味がある。** クラスや CSS 変数を変えた直後は、
   * まだ新しい大きさで組み直されていないことがある。
   */
  let alignTimer = null;
  function scheduleAlignMarks() {
    if (alignTimer !== null) return;
    alignTimer = requestAnimationFrame(function () {
      alignTimer = null;
      alignMarksBox();
      marks.scrollTop = write.scrollTop;
      marks.scrollLeft = write.scrollLeft;
    });
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
  window.addEventListener("resize", scheduleAlignMarks);

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

  /**
   * その行を打つ面で示す（提案パネルの「飛ぶ」。作者の依頼、2026-08-28）。
   *
   * **選び直してから焦点を当て直す。** Chromium は焦点を受け取るときに、
   * 選択のあるところまで面を転がす。縦書き（左右に流れる）と横書き
   * （上下に流れる）で「どちらへ動かすか」が違うのを、その振る舞いに
   * まかせて吸収している——自前で scrollLeft/scrollTop を出すと、
   * 向きごとに別の式を持つことになる。
   *
   * この手が効かない環境が出たら、その行の頭に範囲を作って
   * getBoundingClientRect で測り、はみ出しぶんを足し引きする手
   * （並べる面の nudgeIntoView と同じ考え方）へ切り替えること。
   */
  function revealLine(line) {
    const text = write.value;
    // 行番号は1始まり（拡張機能側の指摘と同じ数え方）
    const wanted = Math.max(0, (typeof line === "number" ? line : 1) - 1);
    let start = 0;
    for (let seen = 0; seen < wanted; seen++) {
      const at = text.indexOf("\\n", start);
      // 指摘より本文が短いことがある（外で削られたあと）。末尾で止める
      if (at < 0) {
        start = text.length;
        break;
      }
      start = at + 1;
    }
    let end = text.indexOf("\\n", start);
    if (end < 0) end = text.length;

    if (composeOn) {
      // 組んで書く面には textarea が無い。**記法の位置は同じ**なので、
      // カーソルの置き直しはこちらの道具（設計書6.34）をそのまま使う
      compose.focus();
      composeRestoreCaret({ start: start, end: end });
      return;
    }

    // 読む面だけを出していると、示した先（カーソル）が見えない。書く面へ戻す
    if (reading && !split) {
      reading = false;
      paint();
      remember();
    }
    write.focus();
    try {
      write.setSelectionRange(start, end);
    } catch (e) {
      /* 範囲外なら諦める（本文は壊れない） */
    }
    // 焦点を入れ直して、選んだところまで転がしてもらう
    write.blur();
    write.focus();
    // 並べているときは、組み上がりの側も同じ行へ寄せる
    scheduleSync(true);
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
      // 組んで書く面では、品書きを開いた時点の選択を使う。
      // **押した瞬間には選択が消えている**（画面の他所を押すと外れる）ので、
      // textarea のように押されてから読むことができない
      const at = composeOn ? composeMenuAt : null;
      vscode.postMessage({
        type: "chat",
        start: composeOn
          ? at
            ? at.start
            : -1
          : reading
            ? -1
            : write.selectionStart,
        end: composeOn ? (at ? at.end : -1) : reading ? -1 : write.selectionEnd,
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
    // **選択は、押された時点で読んでおく**（組んで書く面。上の相談・ルビで使う）
    if (composeOn) composeMenuAt = composeSelectionNow();
    openMenu(
      event.clientX,
      event.clientY,
      composeOn
        ? composeTermAt(event.clientX, event.clientY)
        : termFrom(event.target),
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

  /**
   * チップの中身を作って出す。
   *
   * **組んで書く面（設計書6.34）とここで分け合う。** あちらは要素ではなく
   * 位置から用語を引くが、**出すものは同じ**である（同じ見た目のチップが
   * 2つの作りで別々に育つのを避ける）。
   */
  function fillTip(name, kind, summary) {
    tip.innerHTML = "";
    const head = document.createElement("div");
    const nameEl = document.createElement("span");
    nameEl.className = "tip-name";
    nameEl.textContent = name || "";
    const kindEl = document.createElement("span");
    kindEl.className = "tip-kind";
    kindEl.textContent = TIP_KIND_LABELS[kind] || "";
    head.appendChild(nameEl);
    head.appendChild(kindEl);
    tip.appendChild(head);
    const body = document.createElement("div");
    // 紹介が無くても名前と種別だけのチップを出す（クリックで資料を開ける）
    body.textContent = summary || "（紹介はまだありません）";
    tip.appendChild(body);
    tip.classList.add("open");
  }

  /** 用語の近くに出し、画面の外へはみ出さないよう収める */
  function placeTip(rect) {
    const box = tip.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - box.width - 8);
    const below = rect.bottom + 6;
    const top =
      below + box.height > window.innerHeight
        ? rect.top - box.height - 6
        : below;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = Math.max(4, top) + "px";
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
    fillTip(
      el.getAttribute("data-term-name"),
      el.getAttribute("data-term-kind"),
      tipSummaryOf(el.getAttribute("data-term-id"))
    );
    placeTip(el.getBoundingClientRect());
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
      if (composeOn) composeTakeIncoming(message.text);
      else takeIncoming(message.text);
      // 覚えていた「組んで書く」は、本文が届いてから開く。
      // **一度きりにする**——安全弁で断られたときに、届くたび試し直さない
      if (composeWanted && !composeOn) {
        composeWanted = false;
        composeEnter();
      }
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
        // 本文が伸び縮みするとスクロールバーが出入りする。
        // **当てられなかったときにも測り直す**（次に出すときのため）
        scheduleAlignMarks();
      }
      if (Array.isArray(message.terms)) {
        termSpans = message.terms;
        /*
          **どの本文に対する位置なのかを覚えておく**（組んで書く面の色付け）。
          打った直後は本文のほうが先に進んでいるので、そのまま色を置くと
          1文字ずれた場所が塗られる。打つ面の目印（applyMarksIfMatch）と
          同じ考え方で、一致するときだけ出す
        */
        termsForText = message.text;
        composeScheduleHighlight();
      }
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
    } else if (message.type === "revealLine") {
      revealLine(message.line);
    } else if (message.type === "select" && composeOn) {
      /*
        ルビを入れたあと、入れた場所を選び直す（組んで書く面）。
        **組み直しはこのあとに届く**（文書の書き換えが返ってくるのは少し先）
        ので、覚えておいて組み直したあとにも当て直す
      */
      composeWantSelect = { start: message.start, end: message.end };
      composeRestoreCaret(composeWantSelect);
    } else if (message.type === "select" && !reading) {
      // ルビを入れたあと、入れた場所を選び直す
      write.focus();
      try { write.setSelectionRange(message.start, message.end); } catch (e) { /* 範囲外 */ }
    }
  });

  /* ══ 組んで書く（実験。設計書6.34） ══════════════════════ */

  /**
   * 打つ面そのものに、ルビ・傍点が組まれて出る面。
   *
   * **いちばん危ないのは DOM→記法の直列化である。** ここが1文字でも
   * ずれると本文が壊れるので、
   *
   * 1. 面に入るとき、**記法→DOM→記法 が元の本文と一致するか**を確かめる
   *    （一致しなければ入らない）
   * 2. 貼り付けは**平文だけ**（外のHTMLが入ると直列化が壊れる）
   * 3. 用語の色付けは **CSS Custom Highlight API**（DOMを書き換えない）
   *
   * を守る。**取り消し（Ctrl+Z）はブラウザ任せ**——自分の入力では組み直さ
   * ないので素の履歴が効くはずで、**これが実験の検証項目**である。
   */

  /** 品書きを開いた時点の選択（押した瞬間には外れているので、先に読む） */
  let composeMenuAt = null;
  /** 組み直したあとに選び直したい範囲（ルビを入れた直後） */
  let composeWantSelect = null;
  /** 届いている用語の位置（termSpans）が、どの本文に対するものか */
  let termsForText = null;
  /** 変換中に外から届いた本文。確定してから片づける */
  let composePending = null;

  /* compose:start */
  /**
   * ルビ・傍点の記法。**定義は core/manuscriptRender.ts の1つだけ**で、
   * ここへはその文字列がそのまま埋め込まれる（写しを置かない）。
   */
  const COMPOSE_NOTATION = ${JSON.stringify(NOTATION_PATTERN)};

  /** 平文はつなげて1つにする（テキストノードを無駄に増やさない） */
  function composePushText(parts, text) {
    if (text === "") return;
    const last = parts.length > 0 ? parts[parts.length - 1] : null;
    if (last && last.kind === "text") {
      last.src += text;
      return;
    }
    parts.push({ kind: "text", src: text, base: text, reading: "" });
  }

  /**
   * 記法つきの1行を、部品へ割る。
   *
   * **どの部品も src（元の記法そのもの）を持つ。** 読む面の tokenizeLine は
   * 読み仮名が空のルビを平文（親文字だけ）へ落とすが、それをこの面でやると
   * **記法が消えて本文が書き換わる**。ここでは元の文字列のまま平文として
   * 残す（書きかけのルビは記法のまま見えて、そのまま直せる）。
   */
  function composeParts(line) {
    const parts = [];
    const pattern = new RegExp(COMPOSE_NOTATION, "g");
    let last = 0;
    let match = pattern.exec(line);
    while (match !== null) {
      // 長さ0の一致は位置が進まない（無限に回る）。念のため
      if (match[0].length === 0) break;
      if (match.index > last) {
        composePushText(parts, line.slice(last, match.index));
      }
      if (match[1] !== undefined) {
        parts.push({
          kind: "emphasis",
          src: match[0],
          base: match[1],
          reading: "",
        });
      } else if (match[3] !== undefined && match[3].trim() !== "") {
        parts.push({
          kind: "ruby",
          src: match[0],
          base: match[2],
          reading: match[3],
        });
      } else {
        composePushText(parts, match[0]);
      }
      last = match.index + match[0].length;
      match = pattern.exec(line);
    }
    if (last < line.length) composePushText(parts, line.slice(last));
    return parts;
  }

  /** 部品を記法へ戻す。並べ直すだけ（ここが崩れると本文が壊れる） */
  function composePartsToNotation(parts) {
    let text = "";
    for (const part of parts) text += part.src;
    return text;
  }

  /**
   * 改行の種類を揃える。
   *
   * **textarea が値へ行うのと同じこと**をする（打つ面は CRLF の原稿でも
   * LF として持つ）。ここで揃えておかないと、面ごとに送る本文が変わる。
   */
  function composeNormalizeNewlines(text) {
    return text.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
  }

  /**
   * contenteditable が入れる揺れを、原稿の文字へ戻す。
   *
   * **&nbsp;（U+00A0）を普通の空白に戻す。** 見た目が同じなので気づかず、
   * 原稿へ混ざると検索・文字数・投稿サイトで事故る。
   */
  function composeNormalizeText(text) {
    return composeNormalizeNewlines(text).replace(/\\u00A0/g, " ");
  }

  /**
   * 三点リーダ「…」のかたまり（作者の依頼、2026-08-28）。
   *
   * 位置はフォント任せで、横書きでは下に沈み、縦書きでは縦用の字形を
   * 持たないフォントで横倒しのまま出る。読む面（#read .ellipsis）と同じく、
   * 印を付けてCSSで行の中央へ寄せる。
   *
   * **編集不可のかたまりにする**（ルビ・傍点と同じ扱い）。ただの span に
   * すると、**その直後に打った文字へ書式が伝染する**——この面は自分の入力で
   * DOMを組み直さないので、伝染した回転が消えないまま出続ける。
   * かたまりなら伝染せず、消すときも「…」1文字ぶんで消える。
   *
   * **1文字ずつ包む。** 「……」をまとめて回すと、回転の中心が2文字の
   * 真ん中になり、縦書きで点列が柱からはみ出す（読む面と同じ理由）。
   */
  function composeBuildEllipsis(doc) {
    const span = doc.createElement("span");
    span.setAttribute("class", "ellipsis");
    span.setAttribute("contenteditable", "false");
    // 直列化は data-src を見る。ここが「…」なので、本文は1文字のまま戻る
    span.setAttribute("data-src", "…");
    span.appendChild(doc.createTextNode("…"));
    return span;
  }

  /** 平文を段落へ入れる。**三点リーダだけは、かたまりとして入れる** */
  function composeAppendText(parent, value, doc) {
    let last = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== "…") continue;
      if (i > last) parent.appendChild(doc.createTextNode(value.slice(last, i)));
      parent.appendChild(composeBuildEllipsis(doc));
      last = i + 1;
    }
    if (last < value.length) {
      parent.appendChild(doc.createTextNode(value.slice(last)));
    }
  }

  /**
   * 1行ぶんの段落を作る。**かたまり（ルビ・傍点）は編集不可**（設計書6.34.2）。
   *
   * doc を引数で受けるのは、**画面の外から試せるようにする**ためである
   * （test/unit/composeFace.test.ts が偽の document を渡して往復を確かめる）。
   */
  function composeBuildLine(line, doc) {
    const p = doc.createElement("p");
    p.setAttribute("class", "line");
    const parts = composeParts(line);
    if (parts.length === 0) {
      // 空行。高さを保つための詰め物（読む面の br と同じ役目）
      p.appendChild(doc.createElement("br"));
      return p;
    }
    for (const part of parts) {
      if (part.kind === "text") {
        composeAppendText(p, part.src, doc);
      } else if (part.kind === "ruby") {
        const ruby = doc.createElement("ruby");
        ruby.setAttribute("contenteditable", "false");
        ruby.setAttribute("data-src", part.src);
        ruby.appendChild(doc.createTextNode(part.base));
        const rt = doc.createElement("rt");
        rt.appendChild(doc.createTextNode(part.reading));
        ruby.appendChild(rt);
        p.appendChild(ruby);
      } else {
        const em = doc.createElement("span");
        em.setAttribute("class", "emphasis");
        em.setAttribute("contenteditable", "false");
        em.setAttribute("data-src", part.src);
        em.appendChild(doc.createTextNode(part.base));
        p.appendChild(em);
      }
    }
    return p;
  }

  /** 本文まるごとを、行の段落へ組む（渡す本文は改行を揃えてあること） */
  function composeBuildFragment(text, doc) {
    const fragment = doc.createDocumentFragment();
    const lines = text.split("\\n");
    for (const line of lines) fragment.appendChild(composeBuildLine(line, doc));
    return fragment;
  }

  /** 行の切れ目になる入れ物か */
  function composeIsBlock(name) {
    return name === "P" || name === "DIV" || name === "LI" || name === "SECTION";
  }

  function composePutBreak(atoms, state, node, parent, index) {
    atoms.push({
      kind: "break",
      node: node,
      parent: parent,
      index: index,
      text: "\\n",
      start: state.at,
      end: state.at + 1,
    });
    state.at += 1;
    state.open = true;
  }

  function composePutText(atoms, state, node, parent, index) {
    const raw = node.nodeValue === undefined || node.nodeValue === null
      ? ""
      : node.nodeValue;
    const text = composeNormalizeText(raw);
    if (text === "") return;
    atoms.push({
      kind: "text",
      node: node,
      parent: parent,
      index: index,
      text: text,
      start: state.at,
      end: state.at + text.length,
    });
    state.at += text.length;
    state.open = true;
  }

  function composeCollect(node, atoms, state) {
    const kids = node.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (kid.nodeType === 3) {
        composePutText(atoms, state, kid, node, i);
        continue;
      }
      if (kid.nodeType !== 1) continue;
      const src = kid.getAttribute ? kid.getAttribute("data-src") : null;
      if (src !== null && src !== undefined && src !== "") {
        // かたまり（ルビ・傍点・三点リーダ）。**中は見ない**——記法そのものを持っている
        atoms.push({
          kind: "chunk",
          // 三点リーダは**見た目のためのかたまり**で、記法ではない。
          // 「そう……」に傍点、のように**上へ記法を重ねてよい**——
          // ルビ・傍点と同じに数えると、…を含む範囲へ何も振れなくなる。
          // classList ではなく属性で見る（試験の偽DOMは属性しか持たない）
          decor:
            (kid.getAttribute ? kid.getAttribute("class") : null) ===
            "ellipsis",
          node: kid,
          parent: node,
          index: i,
          text: src,
          start: state.at,
          end: state.at + src.length,
        });
        state.at += src.length;
        state.open = true;
        continue;
      }
      if (kid.nodeName === "BR") {
        /*
          **入れ物の最後の br は詰め物**である。ブラウザが空の行の高さを
          保つために置くもので、本文の改行ではない。数えると、行を打つたびに
          空行が増えていく
        */
        if (i === kids.length - 1) continue;
        composePutBreak(atoms, state, kid, node, i);
        continue;
      }
      if (composeIsBlock(kid.nodeName)) {
        // 2つめ以降の入れ物の手前が、行の切れ目にあたる
        if (state.open) composePutBreak(atoms, state, kid, node, i);
        state.open = true;
        composeCollect(kid, atoms, state);
        continue;
      }
      composeCollect(kid, atoms, state);
    }
  }

  /**
   * DOMの中身を「かたまり（atom）」の並びへ割る。
   *
   * **直列化と位置の対応を、同じ1つの走査から作る。** 別々に書くと、
   * 片方だけが正しい状態（本文は合っているのに色が1文字ずれる、
   * カーソルが別の行へ飛ぶ）が生まれる。
   *
   * - text  … テキストノード（中身は正規化済み）
   * - chunk … ルビ・傍点。**data-src の文字数ぶんを占める**
   * - break … 行の切れ目。改行1文字ぶん
   */
  function composeAtoms(root) {
    const atoms = [];
    composeCollect(root, atoms, { at: 0, open: false });
    return atoms;
  }

  /** DOM → 記法テキスト。**本文の正しさは、この関数がすべて背負う** */
  function composeDomToNotation(root) {
    let text = "";
    for (const atom of composeAtoms(root)) text += atom.text;
    return text;
  }

  /** その atom の終わりを指す DOM の位置 */
  function composeEndPoint(atom) {
    if (atom.kind === "text") {
      return { node: atom.node, offset: atom.text.length };
    }
    if (atom.kind === "chunk") {
      return { node: atom.parent, offset: atom.index + 1 };
    }
    return composeAfterBreak(atom);
  }

  /** 行の切れ目の直後（＝次の行の頭） */
  function composeAfterBreak(atom) {
    if (atom.node.nodeName === "BR") {
      return { node: atom.parent, offset: atom.index + 1 };
    }
    return { node: atom.node, offset: 0 };
  }

  /**
   * 記法の位置 → DOM の位置。
   *
   * **かたまりの中へは入らない**（編集できないので、手前か後ろの境目へ寄せる）。
   */
  function composeOffsetToPoint(atoms, offset) {
    let lastAtom = null;
    for (const atom of atoms) {
      const previous = lastAtom;
      lastAtom = atom;
      if (offset >= atom.end) continue;
      const at = offset < atom.start ? atom.start : offset;
      if (atom.kind === "text") {
        return { node: atom.node, offset: at - atom.start };
      }
      if (atom.kind === "chunk") {
        return at <= atom.start
          ? { node: atom.parent, offset: atom.index }
          : { node: atom.parent, offset: atom.index + 1 };
      }
      /*
        行の切れ目そのもの。**改行の手前は「前の行の終わり」である。**
        次の行の頭へ置くと、行末で組み直すたびにカーソルが1行下がる
      */
      if (at === atom.start && previous !== null) return composeEndPoint(previous);
      return composeAfterBreak(atom);
    }
    if (lastAtom === null) return null;
    return composeEndPoint(lastAtom);
  }

  /** その節点を含んでいるか（親をたどれない偽のDOMでも動くように、子から探す） */
  function composeContains(ancestor, node) {
    if (ancestor === node) return true;
    const kids = ancestor.childNodes;
    if (!kids) return false;
    for (let i = 0; i < kids.length; i++) {
      if (composeContains(kids[i], node)) return true;
    }
    return false;
  }

  /**
   * DOM の位置 → 記法の位置。
   *
   * 当たらない位置（かたまりの中、空の行）は**手前の境目へ寄せる**。
   * カーソルの置き直しに使うので、**外すより寄せるほうがよい**。
   */
  function composePointToOffset(atoms, node, offset) {
    if (!node || atoms.length === 0) return 0;
    if (node.nodeType === 3) {
      for (const atom of atoms) {
        if (atom.kind === "text" && atom.node === node) {
          const within = offset > atom.text.length ? atom.text.length : offset;
          return atom.start + within;
        }
      }
    }
    // 要素の「何番目の子の手前か」で指されている
    const kids = node.childNodes;
    if (kids && offset < kids.length) {
      const target = kids[offset];
      for (const atom of atoms) {
        if (composeContains(target, atom.node)) return atom.start;
      }
    }
    // その先に atom が無い。入れ物の中の最後尾へ
    let end = null;
    for (const atom of atoms) {
      if (composeContains(node, atom.node)) end = atom.end;
    }
    if (end !== null) return end;
    return offset > 0 ? atoms[atoms.length - 1].end : 0;
  }

  /** その範囲に、かたまり（ルビ・傍点）が重なっているか */
  function composeSelectionHasChunk(atoms, start, end) {
    for (const atom of atoms) {
      // 三点リーダ（decor）は見逃す。見た目のためのかたまりであって
      // 記法ではないので、その上へルビ・傍点を重ねてよい
      if (atom.kind !== "chunk" || atom.decor) continue;
      if (atom.start < end && atom.end > start) return true;
    }
    return false;
  }
  /* compose:end */

  /**
   * 位置の一覧は、変わるまで使い回す。
   *
   * 4万字の原稿ではかたまりが数千になる。マウスを動かすたび・色を置くたびに
   * 数え直すと、**打つ手より先に画面が重くなる**。DOMを変えるのは入力と
   * 組み直しだけなので、そこで捨てれば古いものは残らない。
   */
  let composeAtomsCache = null;
  function composeCurrentAtoms() {
    if (composeAtomsCache === null) composeAtomsCache = composeAtoms(compose);
    return composeAtomsCache;
  }
  function composeInvalidate() {
    composeAtomsCache = null;
  }

  /* ── 面の出し入れ ──────────────────────────── */

  /** 中身を空にする（innerHTML を使わない。組み立ては節点で行う） */
  function composeClear() {
    while (compose.firstChild) compose.removeChild(compose.firstChild);
  }

  /**
   * **安全弁。** 記法→DOM→記法 が元の本文と一致するときだけ、組んだものを返す。
   *
   * 一致しないまま面へ入れると、次に打った瞬間に**壊れた本文が文書へ入る**。
   * 一致しないのは、この面が扱えない文字（U+00A0 など）が原稿にあるとき。
   * **黙って直さずに、入らない。**
   */
  function composeBuildChecked(text) {
    const wanted = composeNormalizeNewlines(text);
    const built = composeBuildFragment(wanted, document);
    if (composeDomToNotation(built) !== wanted) return null;
    return { fragment: built, text: wanted };
  }

  function composeEnter() {
    const built = composeBuildChecked(write.value);
    if (!built) {
      note.textContent =
        "組んで書く（実験）は、この原稿では開けませんでした。" +
        "組み直したものが元の本文と一致しないため、書き換わる恐れがあります" +
        "（「書く」面はこれまでどおり使えます）";
      vscode.postMessage({
        type: "log",
        text: "組んで書く（実験）：記法→DOM→記法 の往復が一致しないため開きませんでした",
      });
      return;
    }
    // カーソルは、打つ面で見ていたところから続ける
    const at = write.selectionStart;
    composeOn = true;
    // **この面だけを出す。** 3つの面と混ぜない（どこで打っているか分からなくなる）
    reading = false;
    split = false;
    clearCaretMark();
    compose.setAttribute("contenteditable", "true");
    try {
      // 改行で作られる入れ物を p に揃える（既定は環境によって違う）
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (error) {
      /* 効かない環境でも、直列化の側で入れ物の違いを吸収する */
    }
    composeClear();
    compose.appendChild(built.fragment);
    composeInvalidate();
    paint();
    remember();
    compose.focus();
    composeRestoreCaret({ start: at, end: at });
    composeScheduleHighlight();
  }

  /** 打つ面へ戻す。**実験が転んでも、いままでの書き方は無傷で残る** */
  function composeLeave() {
    if (!composeOn) return;
    const at = composeSelectionNow();
    composeOn = false;
    composeMenuAt = null;
    composeWantSelect = null;
    composePending = null;
    composeClearHighlights();
    compose.setAttribute("contenteditable", "false");
    composeClear();
    paint();
    remember();
    write.focus();
    if (at) {
      try {
        write.setSelectionRange(at.start, at.end);
      } catch (error) {
        /* 範囲外なら諦める */
      }
    }
  }

  composeButton.addEventListener("click", function () {
    if (composeOn) composeLeave();
    else composeEnter();
  });

  /* ── 本文の往復 ────────────────────────────── */

  /**
   * 打たれた本文を、そのまま文書へ返す（打つ面の send と同じ流儀）。
   *
   * **打つ面の値も揃えておく。** 面を出たあと、そのまま続けて打てるように
   * するためで、字数の数え直し（updateCount）もこの値を見ている。
   */
  function composeSend() {
    // DOMは打たれるたびに変わる。**位置の一覧は必ず数え直す**
    composeInvalidate();
    const text = composeDomToNotation(compose);
    if (text === current) return;
    current = text;
    lastSent = text;
    write.value = text;
    vscode.postMessage({ type: "edit", text: text });
    updateCount();
  }

  /**
   * 外から届いた本文を当てる。
   *
   * **自分の書き換えが返ってきたら触らない。** 組み直すとカーソルが飛び、
   * ブラウザの取り消し履歴（Ctrl+Z）まで壊れる。
   */
  function composeTakeIncoming(text) {
    if (composing) {
      // 確定するまで覚えておく。**いま組み直すと変換が壊れる**
      composePending = text;
      return;
    }
    if (text === lastSent) return;
    if (composeNormalizeNewlines(text) === composeDomToNotation(compose)) return;
    write.value = text;
    composeApplyText(text);
  }

  /**
   * 組み直す。**カーソルは記法の位置で覚えて、位置で戻す**（最善努力）。
   *
   * ルビの前後や行の頭など、同じ位置に戻せないことはある。完全でなくてよい
   * ——**外からの書き換えは頻繁には来ない**（AIの適用・別の窓での編集）。
   */
  function composeApplyText(text) {
    const at = composeWantSelect || composeSelectionNow();
    composeWantSelect = null;
    const built = composeBuildChecked(text);
    if (!built) {
      // 組み直せない本文が届いた。**この面に留まらない**
      composeLeave();
      note.textContent =
        "組んで書く（実験）を閉じました。届いた本文をそのまま組み直せないため、" +
        "「書く」面へ戻しています";
      vscode.postMessage({
        type: "log",
        text: "組んで書く（実験）：届いた本文の往復が一致しないため面を閉じました",
      });
      return;
    }
    composeClear();
    compose.appendChild(built.fragment);
    composeInvalidate();
    composeRestoreCaret(at);
    composeScheduleHighlight();
  }

  compose.addEventListener("input", function () {
    composeInvalidate();
    // **変換中は送らない**（確定前の文字を本文へ入れると二重に入る）
    if (composing) return;
    composeSend();
    composeScheduleHighlight();
  });

  compose.addEventListener("compositionstart", function () {
    composing = true;
  });
  compose.addEventListener("compositionend", function () {
    composing = false;
    // 確定ぶんが入るのは、この直後のことがある（打つ面と同じ理由）
    setTimeout(function () {
      composeSend();
      const waiting = composePending;
      composePending = null;
      if (waiting !== null) composeTakeIncoming(waiting);
      composeScheduleHighlight();
    }, 0);
  });

  /**
   * **装飾のコマンドは通さない。** Ctrl+B などは記法に無いものを
   * DOMへ入れる（太字の要素）ので、直列化がそこで崩れる。
   */
  compose.addEventListener("beforeinput", function (event) {
    const kind = event.inputType || "";
    if (kind.indexOf("format") === 0) event.preventDefault();
  });

  /**
   * **貼り付けは平文だけ。** 外のHTMLがDOMへ入ると直列化が壊れる
   * （色・書体・表・画像は、この面が扱えるものではない）。
   */
  function composeInsertPlain(text) {
    if (!text) return;
    const plain = composeNormalizeText(text);
    try {
      // **execCommand を使う。** 自前で節点を差し込むと、
      // ブラウザの取り消し履歴（Ctrl+Z）から外れる
      if (document.execCommand("insertText", false, plain)) return;
    } catch (error) {
      /* 使えない環境では、下の手で入れる */
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(plain));
    selection.collapseToEnd();
    composeSend();
  }

  compose.addEventListener("paste", function (event) {
    event.preventDefault();
    const data = event.clipboardData;
    composeInsertPlain(data ? data.getData("text/plain") : "");
  });
  compose.addEventListener("drop", function (event) {
    // 落とされたものも同じ（HTMLのまま入れない）
    event.preventDefault();
    const data = event.dataTransfer;
    composeInsertPlain(data ? data.getData("text/plain") : "");
  });

  /**
   * **写すときは、記法で写す。**
   *
   * 見えている字をそのまま写すと、ルビは「親文字＋読み仮名」の並びになる
   * （組んで見せているだけで、間に区切りが無い）。それを貼り戻すと
   * **読み仮名が本文へ混ざる**。かたまりは記法（data-src）で写す。
   */
  function composeCopyNotation(event, andDelete) {
    const at = composeSelectionNow();
    if (!at || at.end <= at.start) return;
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    let text = "";
    for (const atom of composeCurrentAtoms()) text += atom.text;
    data.setData("text/plain", text.slice(at.start, at.end));
    if (!andDelete) return;
    try {
      // 消すのはブラウザに任せる（自前で消すと取り消し履歴から外れる）
      document.execCommand("delete");
    } catch (error) {
      /* 消せない環境では、選んだまま残る（本文は壊れない） */
    }
  }

  compose.addEventListener("copy", function (event) {
    composeCopyNotation(event, false);
  });
  compose.addEventListener("cut", function (event) {
    composeCopyNotation(event, true);
  });

  /* ── カーソルと選択 ───────────────────────── */

  /** いまの選択を、記法の位置で返す */
  function composeSelectionNow() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!compose.contains(range.startContainer)) return null;
    const atoms = composeCurrentAtoms();
    const start = composePointToOffset(
      atoms,
      range.startContainer,
      range.startOffset
    );
    const end = composePointToOffset(atoms, range.endContainer, range.endOffset);
    return start <= end ? { start: start, end: end } : { start: end, end: start };
  }

  /** 記法の位置で、選択を置き直す */
  function composeRestoreCaret(at) {
    if (!at) return;
    const atoms = composeCurrentAtoms();
    const head = composeOffsetToPoint(atoms, at.start);
    const tail = composeOffsetToPoint(atoms, at.end);
    if (!head || !tail) return;
    try {
      const range = document.createRange();
      range.setStart(head.node, head.offset);
      range.setEnd(tail.node, tail.offset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      /* 置けなければ諦める（最善努力。本文は壊れない） */
    }
  }

  /* ── 用語の色付け（CSS Custom Highlight API。設計書6.34.3） ── */

  const COMPOSE_HIGHLIGHTS = [
    "character",
    "location",
    "ability",
    "organization",
  ];

  function composeHighlightsUsable() {
    return (
      typeof CSS !== "undefined" &&
      CSS.highlights &&
      typeof Highlight !== "undefined"
    );
  }

  function composeClearHighlights() {
    if (!composeHighlightsUsable()) return;
    try {
      for (const kind of COMPOSE_HIGHLIGHTS) {
        CSS.highlights.delete("novelai-term-" + kind);
      }
    } catch (error) {
      /* 消せなくても入力は動く */
    }
  }

  /**
   * 用語のところへ色を置く。**DOMは書き換えない**（設計書6.34.3）。
   *
   * 重ね敷き方式（打つ面の #marks）は textarea の制約から生まれた迂回であり、
   * この面では要らない。印の要素を入れる方式だと、色を付け直すたびに
   * カーソルが飛び、取り消し履歴も汚れる。
   *
   * **位置が今の本文のものだと確かめてから置く**（打つ面の
   * applyMarksIfMatch と同じ）。ずれた色は、無い色より分かりにくい。
   */
  function composeApplyHighlights() {
    if (!composeOn) return;
    if (!composeHighlightsUsable()) return;
    try {
      /*
        **同じ本文に対する位置でなければ、色を出さない。** 改行の種類まで
        含めて見るのは、位置が文書の本文（CRLFならCRLF）で数えられている
        ためで、揃えて比べると1行ごとに1文字ずつずれた色が出る
      */
      if (termsForText === null || termsForText !== composeDomToNotation(compose)) {
        composeClearHighlights();
        return;
      }
      const atoms = composeCurrentAtoms();
      const buckets = {};
      for (const kind of COMPOSE_HIGHLIGHTS) buckets[kind] = [];
      for (const span of termSpans) {
        const bucket = buckets[span.kind];
        if (!bucket) continue;
        const head = composeOffsetToPoint(atoms, span.start);
        const tail = composeOffsetToPoint(atoms, span.end);
        if (!head || !tail) continue;
        const range = document.createRange();
        range.setStart(head.node, head.offset);
        range.setEnd(tail.node, tail.offset);
        bucket.push(range);
      }
      for (const kind of COMPOSE_HIGHLIGHTS) {
        const ranges = buckets[kind];
        if (ranges.length === 0) {
          CSS.highlights.delete("novelai-term-" + kind);
          continue;
        }
        CSS.highlights.set("novelai-term-" + kind, new Highlight(...ranges));
      }
    } catch (error) {
      // **色が出ないだけで、入力は動く。** ここで止めない
      composeClearHighlights();
    }
  }

  /** 色付けは1フレームに1回へまとめる（打鍵のたびに数千の範囲を作らない） */
  let composeHighlightTimer = null;
  function composeScheduleHighlight() {
    if (!composeOn) return;
    if (composeHighlightTimer !== null) return;
    composeHighlightTimer = requestAnimationFrame(function () {
      composeHighlightTimer = null;
      composeApplyHighlights();
    });
  }

  /* ── 設定資料の操作（作者の指定。設計書6.34.3） ────── */

  /** 画面の座標 → 記法の位置。用語の当たり判定に使う */
  function composeOffsetAtPoint(x, y) {
    let node = null;
    let offset = 0;
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) return null;
      node = range.startContainer;
      offset = range.startOffset;
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (!position) return null;
      node = position.offsetNode;
      offset = position.offset;
    } else {
      return null;
    }
    if (!node || !compose.contains(node)) return null;
    return composePointToOffset(composeCurrentAtoms(), node, offset);
  }

  /** その位置にある用語（端は含めない。打つ面の termAtCaret と同じ扱い） */
  function composeTermSpanAt(offset) {
    if (offset === null) return null;
    for (const span of termSpans) {
      if (offset >= span.start && offset < span.end) return span;
    }
    return null;
  }

  /**
   * 押されたところの用語。
   *
   * **範囲を選んでいれば、そちらに重なる用語を優先する**（打つ面と同じ）。
   * 点だけだと、選んでから右クリックしたときに選んだ語を引けない。
   */
  function composeTermAt(x, y) {
    const at = composeMenuAt;
    if (at && at.end > at.start) {
      for (const span of termSpans) {
        if (span.start < at.end && span.end > at.start) return span;
      }
    }
    return composeTermSpanAt(composeOffsetAtPoint(x, y));
  }

  /**
   * 読む面と同じチップを出す。**引き方だけが違う**——この面には用語の要素が
   * 無いので（色は Highlight API で置いている）、位置から引く。
   *
   * **1フレームに1回にまとめる。** マウスを動かすたびに本文じゅうの位置を
   * 数え直すと、指の動きに画面が付いてこない。
   */
  let composeTipTimer = null;
  let composeTipAt = null;
  compose.addEventListener("mousemove", function (event) {
    if (!composeOn) return;
    composeTipAt = { x: event.clientX, y: event.clientY };
    if (composeTipTimer !== null) return;
    composeTipTimer = requestAnimationFrame(function () {
      composeTipTimer = null;
      const at = composeTipAt;
      if (!at) return;
      const span = composeTermSpanAt(composeOffsetAtPoint(at.x, at.y));
      if (!span) {
        tip.classList.remove("open");
        return;
      }
      fillTip(span.name, span.kind, span.summary);
      // 要素が無いので、指の先を用語の箱の代わりにする
      placeTip({ left: at.x, right: at.x, top: at.y, bottom: at.y });
    });
  });
  compose.addEventListener("mouseleave", function () {
    composeTipAt = null;
    tip.classList.remove("open");
  });
  compose.addEventListener("scroll", function () {
    tip.classList.remove("open");
  });

  /**
   * ルビ・傍点を振る先。
   *
   * **品書きから押されたときは、開いた時点の選択を使う。** 品書きを押した
   * 瞬間に選択は外れているので、いまの選択だけを見ると「選んでいない」に
   * なってしまう（textarea は焦点が移っても選択を覚えているが、
   * contenteditable の選択は画面じゅうで1つしかない）。
   */
  function composeTargetRange() {
    const live = composeSelectionNow();
    if (live && live.end > live.start) return live;
    if (composeMenuAt && composeMenuAt.end > composeMenuAt.start) {
      return composeMenuAt;
    }
    return live || composeMenuAt;
  }

  /**
   * ルビ・傍点を、この面から振る。**振るのは打つ面と同じ道**である
   * （記法の位置で頼み、入れるのは拡張機能側）。
   *
   * **かたまりの上には重ねない。** ルビの中へルビを入れると記法が入れ子に
   * なり、読む面でも投稿サイトでも壊れる。
   */
  function composeAskNotation(kind) {
    const label = kind === "ruby" ? "ルビ" : "傍点";
    const at = composeTargetRange();
    if (!at) {
      note.textContent = label + "を振る場所を、この面で選んでください";
      return;
    }
    const atoms = composeCurrentAtoms();
    if (composeSelectionHasChunk(atoms, at.start, at.end)) {
      note.textContent =
        "ルビや傍点の上には重ねられません。いったん外してから振り直してください";
      return;
    }
    // **位置を数えたのと同じものから本文を作る**（切り出す先がずれない）
    let text = "";
    for (const atom of atoms) text += atom.text;
    vscode.postMessage({
      type: kind,
      text: text.slice(at.start, at.end),
      start: at.start,
      end: at.end,
    });
  }

  paint();
  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
