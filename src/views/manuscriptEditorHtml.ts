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
import { NOTATION_RULES } from "../core/manuscriptRender";
import { MEMO_LINE_PATTERN, MEMO_TAG_CLASS_MAP } from "../core/sceneMemo";

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
/* **画面の右下へ置く**（作者の依頼、2026-08-28）。
   margin-left: auto にしておくと、この段へ左寄せの要素を足しても
   このボタンだけが右端に残る（並び順で決め打たない） */
#latest { margin-left: auto; }
#surface {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
}
#write, #marks, #compose {
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
/* **色は組んで書く面と同じ変数から取る**（画面ごとに違う色にしない）。
   角丸は塗りのためのものだったので、色にした今は要らない */
.mark-character { color: var(--novelai-character); }
.mark-location { color: var(--novelai-location); }
.mark-ability { color: var(--novelai-ability); }
.mark-organization { color: var(--novelai-organization); }
.mark-world { color: var(--novelai-world, var(--novelai-character)); }
/* 用語が1件も無い作品では、重ねた字を出さない（透明のまま） */
body.plain .mark { color: transparent; }
/* **シーンメモの蛍光ペン**（設計書6.40.3。作者の指示、2026-08-29
   「シーンメモした場所は、蛍光黄色でマーカーしてください」）。

   打つ面（textarea）の**上**に重なる層なので、**半透明の背景だけ**を置く。
   不透明に塗ると、下で打っている字が隠れる。字には触らない（透明のまま）
   ので、変換中の文字もそのまま見える。

   色は core/sceneMemo.ts の1か所（MEMO_MARKER_COLOR）から
   CSS変数で届く。明暗の切り替えは拡張機能側がテーマを見て選ぶ */
#marks .memo-line {
  background: var(--novelai-memo-marker, rgba(255, 235, 59, 0.45));
  border-radius: 2px;
}
/* 用語が無い作品でも、メモの色は消さない（body.plain は用語の話） */
body.plain #marks .memo-line .mark { color: transparent; }
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
/* 縦書き。**行の高さを「幅」として持つ**ので、指定はそのまま効く。
   **#marks（打つ面に重ねる用語の色）も必ず同じ向きにする。** 0.22.24まで
   ここから漏れており、縦書きのとき重ねる面だけ横書きで組まれて、色が
   本文と無関係な場所（空白）に浮いていた（実機の報告、2026-08-27） */
body.vertical #write, body.vertical #marks,
body.vertical #compose {
  writing-mode: vertical-rl;
  /* **upright にしない。** 全部を立てると、英数字が1文字ずつ縦に
     積まれる（2026 が4行になる）。既定の mixed は日本語の組版と
     同じ扱いで、英数字のまとまりを横に寝かせる */
  text-orientation: mixed;
  /*
    **傍線は行の右へ。**（作者の指示、2026-08-24。同じ依頼が2026-08-28にも）

    ただし**変換中の線には効かなかった**（実機で確認、設計書6.25.2）。
    あの線を引いているのは日本語入力の層で、本文の下線とは別の道を通る。
    ここに残してあるのは、本文へ下線を引く日が来たときのためである。

    **この指定は打つ面（#write）と組んで書く面（#compose）の両方に
    かかっている**（下のセレクタに両方が並んでいる）。0.19.3 で確かめたのは
    textarea の側だけなので、contenteditable の側（#compose）で効くかは
    実機で見るまで分からない——描いているのが同じ層なら、やはり効かない。

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
/* 縦書きのときだけ、行の長さを紙のように区切る */
body.vertical.paged #surface { padding: 0; }

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
/* 打つ面（と重ねる目印）は、この面が出ている間は隠す（描かせない） */
body.compose #write, body.compose #marks { display: none; }
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
/* **シーンメモの行（付箋）**（設計書6.40.3）。

   ## かたまりにしない
   contenteditable="false" を付けないのは、**中身を普通に打てる**ことが
   要るからである。行頭の印を消せばただの本文へ戻り、本文へ印を足せば
   付箋になる。往復（記法↔DOM）にも一切関わらない——見た目だけを変える。

   ## 背景は蛍光黄色ひとつ（作者の指示、2026-08-29）
   タグごとに背景を変えない。作者が求めているのは「メモの場所が
   一目で分かる」ことなので、**種類は行頭の小さな丸**で示す。
   丸は ::before（DOMに出ない）で描く——本文のノードを増やすと
   直列化が1文字ずれる */
#compose p.memo, #compose div.memo {
  position: relative;
  background: var(--novelai-memo-marker, rgba(255, 235, 59, 0.45));
  border-radius: 2px;
  /* 付箋は本文より小さく。読み流すときに邪魔をしない */
  font-size: 0.88em;
}
#compose .memo::before {
  content: "";
  position: absolute;
  /* 横書きでは行の左、縦書きでは行の上に置く（下の vertical で差し替える） */
  left: -0.75em;
  top: 0.65em;
  width: 0.42em;
  height: 0.42em;
  border-radius: 50%;
  background: var(--novelai-memo-other, #6b6b6b);
}
body.vertical #compose .memo::before {
  left: auto;
  top: -0.75em;
  right: 0.65em;
}
/* 種類の色。**色の値は core/sceneMemo.ts から変数で届く**（写しを置かない） */
#compose .memo-todo::before { background: var(--novelai-memo-todo, #c01c28); }
#compose .memo-check::before { background: var(--novelai-memo-check, #9a6700); }
#compose .memo-foreshadow::before {
  background: var(--novelai-memo-foreshadow, #1a5fb4);
}
#compose .memo-idea::before { background: var(--novelai-memo-idea, #1c7c3c); }
/* **かたまり（ルビ・傍点）は編集不可**（設計書6.34.2）。中の文字を直接
   直せないので、消すときは1単位で消える。選んだときに1文字のように
   振る舞わせるため、余計な余白は付けない */
#compose ruby[data-src], #compose .emphasis[data-src] {
  /* 選択の見た目を、ふつうの文字と揃える */
  border-radius: 2px;
}
/* **三点リーダを行の中央に寄せる**（作者の依頼、2026-08-28）。
   横書き：欧文フォントに落ちると「…」が下に沈むので、中央を明示する。
   縦書き：横書きの向きに固定してから90度回す。フォントが縦用の字形
   （縦3点）を持つかに依存せず、同じ見た目になる。
   書く面（textarea）は文字単位の調整ができないため、フォントの形のまま。

   **この形は、かつて読む面（#read .ellipsis）で作者が確かめたもの**である
   （0.24.1）。読む面そのものは0.25.2で消したが、確かめた値はここに残る
   ——組み立て側も素の span にしてある。0.24.12 は編集不可のかたまりに
   しており、CSSは同じなのに縦書きで「……」の間に隙間が出た（実機報告、
   2026-08-28） */
#compose .ellipsis {
  vertical-align: middle;
  /* **三点リーダの字だけ、和文の明朝に固定する**（実機の報告、2026-08-29）。
     選んだ書体が「…」を持たないと欧文へ落ち、欧文の三点リーダは下寄りの
     字形なので、中央指定をしても沈んで見える。和文書体は最初から中央に
     描く。1文字だけの固定なので、本文の書体の雰囲気は崩れない */
  font-family: "Yu Mincho", "YuMincho", "Hiragino Mincho ProN",
    "MS Mincho", serif;
}
/* **箱を1em角の正方形に固定する**（実機の報告、2026-08-28）。
   寸法を決めないと箱の高さが行の高さ（約1.5文字分）になり、連続した
   「……」の間に隙間があく。また縦横比が崩れるため、フォントサイズを
   変えると回転の中心が柱からずれる。1em角なら送りは1文字分で、
   中心はフォントサイズに追従する */
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
/* **ダッシュも和文の明朝に固定する**（作者の実機報告、2026-08-29
   「主従の悪だくみが始まった――」の2本のあいだに隙間が見える）。
   選んだ書体が「―」を持たないと欧文へ落ち、欧文のダッシュは字送りより
   線が短いので、隣り合わせても**線がつながらず隙間になる**。
   和文書体のダッシュは字送りいっぱいに引かれるので、並べると1本に見える。

   **縦書きの回転も1em角の固定も付けない**（三点リーダとはここが違う）。
   和文書体はダッシュの縦用の字形を持っているので、縦書きでは何もしなくても
   正しく立つ。回すと、かえって字が切れる。 */
#compose .dash {
  font-family: "Yu Mincho", "YuMincho", "Hiragino Mincho ProN",
    "MS Mincho", serif;
}
/* 圏点は読み物と同じ出し方（em.emph と同じ指定を分け合う） */
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

/* ── ルビ ─────────────────────────── */
/* 組んで書く面は、本物の ruby 要素を組む（#compose ruby[data-src]） */
ruby > rt {
  font-size: 0.5em;
  opacity: 0.85;
  user-select: none;
}
/*
  **用語の印（.term）と圏点（em.emph）の指定は消した**（0.25.2）。
  この2つを出していたのは core/manuscriptRender.ts の renderManuscript で、
  行き先は「読む」面だった。面ごと消したので、当たる要素がもう作られない。
  いまの色分けは、打つ面が重ね敷き（.mark-*）、組んで書く面が
  CSS Custom Highlight API（::highlight）である。
*/

/* ── ホバーのチップ（組んで書く面。作者の依頼、2026-08-28） ───── */
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
/* ── 下の帯（字数と知らせ） ─────────────────── */
/* 色分けの凡例はここに並べていたが、**作者の指示で外した**（2026-08-28
   「文字の色分け説明は不要です」）。色の意味は設定資料パネルのタブが
   同じ色で示す（views/settingsPanelHtml.ts）。

   **面の説明（「組んで書く（実験）：…」）も外した**（作者の指示、
   2026-08-29）。組んで書くが標準になり、切り替えのボタンも無くなったので、
   常に出ている説明は場所を取るだけになった。空いたところへ字数を出す
   （作品／このファイル／今日）。#note は残す——安全弁で面へ入れなかった
   ときなど、**その場で起きたことを伝える口**が無くなると、黙って形が
   変わったようにしか見えない */
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
/* **字数は控えめに出す。** 書いている最中にいつも視界へ入るものなので、
   読みにいったときだけ読める濃さにしておく（数えるのが目的ではない） */
#counts {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
#note {
  color: var(--vscode-notificationsInfoIcon-foreground, inherit);
}
</style>
</head>
<body class="vertical">
<div id="bar">
  <button id="dir" title="縦書きと横書きを切り替えます">横書きにする</button>
  <div class="sep"></div>
  <button id="ruby" title="選んだ文字にルビを振ります">ルビ</button>
  <button id="emph" title="選んだ文字に傍点を付けます">傍点</button>
  <div class="sep"></div>
  <button id="copy" title="投稿サイトの記法に直してコピーします">投稿用にコピー</button>
  <button id="font" title="本文の書体を選びます">書体</button>
  <button id="smaller" title="文字を小さく">ー</button>
  <button id="bigger" title="文字を大きく">＋</button>
  <div class="gap"></div>
</div>

<div id="surface">
  <div id="marks" aria-hidden="true"></div>
  <textarea id="write" spellcheck="false" wrap="soft"></textarea>
  <div id="compose" spellcheck="false"></div>
</div>

<div id="bottom">
  <button id="prev" title="ひとつ前の話を開きます">← 前の話</button>
  <button id="next" title="次の話を開きます。最終話に本文があれば、次の話を作って開きます">次の話 →</button>
  <button id="latest" title="いちばん新しい話を開きます。白紙でなければ、次の話を作って開きます">最新話を書く</button>
</div>

<div id="foot">
  <span id="counts"></span>
  <span id="note"></span>
</div>

<div id="menu"></div>
<div id="tip"></div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const write = document.getElementById("write");
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
  const note = document.getElementById("note");
  /** 下段の字数（作品／このファイル／今日。作者の指示、2026-08-29） */
  const countsLabel = document.getElementById("counts");
  const dirButton = document.getElementById("dir");
  /** 組んで書く（実験。設計書6.34） */
  const compose = document.getElementById("compose");

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
  /*
    **「読む」面と「並べる」面は消した**（0.25.2）。

    0.24.14で「組んで書く」が標準になり、切り替えのボタンを外した時点で
    **この2つの面へ入る道が無くなっていた**（面を表す2つのフラグが、
    どこからも true にならない）。仕掛けだけが約200行残っていたので、
    面・CSS・追いかけ・覚えていた状態ごと消してある。
    組んで書く面の安全弁が落ちる先は、いまも打つ面（textarea）である。
  */

  /**
   * 組んで書く（実験）の面にいるか（設計書6.34）。
   *
   * **覚えていても、すぐには開かない。** この面は本文から組み立てるので、
   * 最初の update が届くまで中身が無い。届いてから開く（composeWanted）。
   */
  let composeOn = false;
  /**
   * **組んで書くを標準にする**（作者の指定、2026-08-29。.txt も .md も）。
   * はじめて開く原稿は組んで書くから始め、作者が「やめる」を押した原稿
   * だけ（saved.compose === false）そのまま「書く」で開く。安全弁で
   * 開けない原稿は、これまでどおり「書く」へ落ちる。
   */
  let composeWanted = saved.compose !== false;
  let size = saved.size || 16;

  function remember() {
    // **まだ開いていないだけの状態を、閉じたことにしない**（composeWanted）。
    // 消した面（reading・split）は書かない——古い state に残っていても読まない
    vscode.setState({ vertical, size, compose: composeOn || composeWanted });
  }

  function paint() {
    // 設定がまだ届いていない間は縦書きとして見せる（body の初期値と揃える）
    document.body.classList.toggle("vertical", vertical !== false);
    document.body.classList.toggle("compose", composeOn);
    document.documentElement.style.setProperty("--novelai-size", size + "px");
    // **大きさも向きもここで変わる。** どちらも折り返し幅を変えるので、
    // 重ねた色の枠を測り直す（実機の報告、2026-08-28）
    scheduleAlignMarks();
    dirButton.textContent = vertical !== false ? "横書きにする" : "縦書きにする";
    dirButton.classList.toggle("on", vertical !== false);
    /*
      **面の説明はここで出さない**（作者の指示、2026-08-29）。
      切り替えのボタンを外したので、「もう一度押して戻してください」は
      押す先が無い案内になる。#note は、その場で起きたこと（安全弁で面へ
      入れなかった、ルビを振る場所が無い）を伝えるためだけに使う。
    */
  }

  dirButton.addEventListener("click", function () {
    vertical = vertical === false;
    paint();
    remember();
  });

  document.getElementById("latest").addEventListener("click", function () {
    vscode.postMessage({ type: "openLatest" });
  });

  /*
    前後の話へ移る（作者の指示、2026-08-29）。
    **どの話なのかを決めるのは拡張機能側**——画面はファイルの並びを
    知らない（走査の結果を持っているのは向こうである）。
  */
  document.getElementById("prev").addEventListener("click", function () {
    vscode.postMessage({ type: "openNeighbor", direction: "prev" });
  });
  document.getElementById("next").addEventListener("click", function () {
    vscode.postMessage({ type: "openNeighbor", direction: "next" });
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

  /** 選んでいる文字。組んで書く面では選択範囲、書く面では textarea の選択 */
  function selectionText() {
    if (composeOn) return String(window.getSelection() || "");
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
      start: write.selectionStart,
      end: write.selectionEnd,
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
      start: write.selectionStart,
      end: write.selectionEnd,
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
  });

  /** 見えている場所を、打つ面から目印へ写す。**ずれると色が別の字に付く** */
  function syncMarksScroll() {
    marks.scrollTop = write.scrollTop;
    marks.scrollLeft = write.scrollLeft;
  }

  write.addEventListener("scroll", syncMarksScroll);

  /*
    **止まったところで、もう一度写す。** scroll の知らせは間引かれることが
    あり（慣性のある動き・ホイールの連打）、最後の1回を取りこぼすと目印だけが
    半端な位置で止まる。**この知らせを持たない環境では、いままでどおり**
    ——無くても scroll のたびに写しているので、取りこぼしたときだけ効く。
  */
  if ("onscrollend" in write) {
    write.addEventListener("scrollend", syncMarksScroll);
  }

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
      syncMarksScroll();
    });
  }

  /**
   * 目印を、いまの本文と一致するときだけ出す。
   *
   * ## 一致しないときは、必ず隠す
   *
   * 作者の実機報告（2026-08-29）「スクロールされるとたまに文字がズレます」。
   * 目印の中身は、打った直後から新しいものが届くまで（往復で120ミリ秒＋）
   * **古い本文のまま**である。0.24.11までは背景の淡い塗りだったので
   * 目立たなかったが、**0.24.12で文字色にしたため、古い位置に色の付いた字が
   * そのまま描かれる**ようになった。動かした拍子にそれが見えると、
   * 「字がズレた」「二重に見える」として読める。
   *
   * ここは長らく**当てるときの照合しか持っていなかった**（一致しなければ
   * 何もせずに戻る）ので、いったん出したものが古くなっても隠す道が無かった。
   * **一致しないと分かった時点で隠す。**
   *
   * 打っている間は色が一瞬（往復のあいだ）消えるが、**ズレた字が見えるより
   * 軽い。** 色は「その語が何か」を教えるためのもので、位置が違えば
   * 教える相手を間違えている。
   */
  function applyMarksIfMatch() {
    if (!latestMarks || latestMarks.forText !== write.value) {
      marks.classList.add("stale");
      return;
    }
    alignMarksBox();
    marks.innerHTML = latestMarks.html;
    syncMarksScroll();
    marks.classList.remove("stale");
  }

  // 窓の大きさが変わるとスクロールバーの有無も変わりうる。合わせ直す
  window.addEventListener("resize", scheduleAlignMarks);

  /**
   * その要素が入れ物からはみ出している量。中に入っていれば 0。
   *
   * **scrollIntoView を使わない。** あれは上の入れ物まで動かすことがあり、
   * #surface は overflow:hidden なので、動くと戻す手立てが無い。
   * はみ出しを足し引きするだけなら、縦書き（左右に流れる）でも
   * 横書き（上下に流れる）でも同じ式で足りる——**割合ではなく差**なので、
   * 縦書きでスクロール値の数え方が違っても効く。
   */
  function offRect(container, rect) {
    const box = container.getBoundingClientRect();
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

  /* ── 下段の字数（作者の指示、2026-08-29） ─────────────
     「作品 ◯◯,◯◯◯字 ／ このファイル ◯,◯◯◯字 ／ 今日 +◯◯◯字」。

     **数えるのは拡張機能側**（画面は受けて出すだけ）。純／総の設定も
     ルビの扱いも向こうが持っているので、ここで数え直すと**上の帯の数字と
     食い違う**——同じ画面に違う字数が2つ出るのがいちばん困る。 */

  /** このファイルの字数（拡張機能が数えた値） */
  let footFile = null;
  /**
   * 作品の合計。**開いたときと保存したときにしか測らない。**
   * 1打鍵ごとに全話を走査すると、打つ手が止まる。
   */
  let footWorkTotal = null;
  /** その合計を測ったときの、このファイルの字数（差を足すための基準） */
  let footWorkBase = null;
  /** このファイルで今日書いた量（純文字数。マイナスもある） */
  let footToday = null;

  function groupDigits(value) {
    return value.toLocaleString("ja-JP");
  }

  function paintCounts() {
    const parts = [];
    if (footWorkTotal !== null) {
      // 測ったときからの増減を足して見せる。**このファイルの増減しか
      // 分からない**が、いま打っているのはこのファイルなので足りる
      const grown =
        footFile !== null && footWorkBase !== null ? footFile - footWorkBase : 0;
      parts.push("作品 " + groupDigits(footWorkTotal + grown) + "字");
    }
    if (footFile !== null) {
      parts.push("このファイル " + groupDigits(footFile) + "字");
    }
    if (footToday !== null) {
      // 増えた日は符号を付ける（減った日は数字そのものに − が付く）
      parts.push(
        "今日 " + (footToday > 0 ? "+" : "") + groupDigits(footToday) + "字"
      );
    }
    countsLabel.textContent = parts.join(" ／ ");
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
   * （組んで書く面の composeNudgeIntoView と同じ考え方）へ切り替えること。
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
      /*
        **選択を置くだけでは、画面が転がらない**（作者の報告、2026-08-29
        「誤字脱字パネルから本文に飛びません」）。打つ面（textarea）は
        焦点を入れ直せばブラウザが選択のところまで送ってくれるが、
        contenteditable ではそれが起きない——カーソルは移っているのに、
        見えている場所は元のままである。**指した行が画面の外なら、
        はみ出したぶんだけ動かす**（中央には寄せない。1行動くたびに画面が
        真ん中まで動くと、目が付いていけない）。
      */
      if (!composeNudgeIntoView(start)) {
        vscode.postMessage({
          type: "log",
          text: "組んで書く：" + line + "行目の位置を測れず、画面を動かせませんでした",
        });
      }
      return;
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
      // **用語の名前は出さない**（作者の依頼、2026-08-28
      // 「右クリックで出てくるメニューの一番上に名称はいりません」）。
      // 右クリックした語は本人がいちばんよく分かっているので、
      // 品書きの上から1行ぶん奪うほどの手がかりではない
      add("設定資料を見る", function () {
        vscode.postMessage({ type: "openTerm", id: term.id, kind: term.kind });
      });
      rule();
    }

    // **ルビは選んでいなくても押せる。** 選択が無ければ拡張機能側が
    // 直前の漢字のまとまりを拾う（傍点は選んだ範囲そのものに付けるので、
    // 選択が要る）
    add("ルビを振る", askRuby);
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
        start: composeOn ? (at ? at.start : -1) : write.selectionStart,
        end: composeOn ? (at ? at.end : -1) : write.selectionEnd,
      });
    }, hasSelection);

    /* ── シーンメモ（設計書6.40.3・6.40.4） ── */
    rule();
    add("ここにメモを足す", function () {
      // **カーソル行の「上」に挿す**（設計書6.40.3）。いま書いている行の
      // 下に入ると、続きを打つたびに付箋が押し下げられる
      vscode.postMessage({ type: "addMemo", line: menuCaretLine() });
    });
    add("シーンメモを横に開く", function () {
      vscode.postMessage({ type: "openMemos" });
    });

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
    const term = composeOn
      ? composeTermAt(event.clientX, event.clientY)
      : termFrom(event.target);
    // **右クリックそのもので、開いている資料パネルを追従させる**
    // （作者の指示、2026-08-28「右クリックした場合で、すでに設定資料
    // パネルが開いている場合は、該当項目の設定資料を表示」）。
    // パネルが開いていなければ拡張機能側が黙って何もしない——開くのは、
    // 品書きの「設定資料を見る」を押したときだけ
    if (term) {
      vscode.postMessage({ type: "previewTerm", id: term.id, kind: term.kind });
    }
    openMenu(event.clientX, event.clientY, term, selectionText().length > 0);
  });

  document.addEventListener("click", function (event) {
    if (!menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  /* ── カーソルの行（シーンメモ。設計書6.40.4） ────────── */

  /** 本文の位置（LF空間）を、1始まりの行番号へ。読めなければ 0 */
  function lineOfOffset(text, offset) {
    if (typeof offset !== "number" || offset < 0) return 0;
    return text.slice(0, offset).split("\\n").length;
  }

  /** 組んで書く面の本文。**位置を数えたのと同じものから作る** */
  function composeTextNow() {
    let text = "";
    for (const atom of composeCurrentAtoms()) text += atom.text;
    return text;
  }

  /** いまカーソルのある行（1始まり）。読めなければ 0 */
  function caretLine() {
    if (composeOn) {
      const at = composeSelectionNow();
      return at ? lineOfOffset(composeTextNow(), at.start) : 0;
    }
    return lineOfOffset(write.value, write.selectionStart);
  }

  /**
   * 品書きから使う行。
   *
   * **組んで書く面では、品書きを開いた時点の選択を使う。** 押した瞬間には
   * 選択が外れている（contenteditable の選択は画面じゅうで1つしかない）。
   */
  function menuCaretLine() {
    if (composeOn) {
      const at = composeMenuAt || composeSelectionNow();
      return at ? lineOfOffset(composeTextNow(), at.start) : 0;
    }
    return lineOfOffset(write.value, write.selectionStart);
  }

  /*
    カーソルが動いたことを、横のパネルへ知らせる（設計書6.40.4）。

    **200ミリ秒まとめる。** 打鍵のたびに送ると、パネルは1文字ごとに
    いちばん近い付箋を数え直すことになる。少し遅れて光っても困らない。

    **片方向である。** パネルは受けて光らせるだけで、本文は動かさない
    （本文が動くのは、パネルの行を押したときだけ）。
  */
  let caretTimer = null;
  let lastCaretLine = 0;
  function notifyCaret() {
    if (caretTimer !== null) return;
    caretTimer = setTimeout(function () {
      caretTimer = null;
      const line = caretLine();
      // 同じ行に居るあいだは送らない（パネルの光る行は変わらない）
      if (line <= 0 || line === lastCaretLine) return;
      lastCaretLine = line;
      vscode.postMessage({ type: "caret", line: line });
    }, 200);
  }
  // textarea と contenteditable で拾える知らせが違うので、両方に付ける
  document.addEventListener("selectionchange", notifyCaret);
  write.addEventListener("click", notifyCaret);
  write.addEventListener("keyup", notifyCaret);
  compose.addEventListener("click", notifyCaret);
  compose.addEventListener("keyup", notifyCaret);

  /* ── ホバーのチップ（作者の依頼、2026-08-28） ── */
  const tip = document.getElementById("tip");
  const TIP_KIND_LABELS = {
    character: "人物",
    location: "場所",
    ability: "能力",
    organization: "組織",
    // 付箋のチップ（設計書6.40.3）。行の中では小さく出ているので、
    // 全文はここで読む
    memo: "シーンメモ",
  };

  /**
   * チップの中身を作って出す。
   *
   * 呼ぶのは組んで書く面（設計書6.34）だけになったが、**組み立てはここに
   * 置いたままにする**——用語の見せ方（名前・種別・紹介の一文）は面が
   * 増えても同じものにしたい。
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

  /* ── 拡張機能からの知らせ ──────────── */
  window.addEventListener("message", function (event) {
    const message = event.data;
    if (message.type === "update") {
      current = message.text;
      /*
        **記法は、組み立てるより先に受け取る**（設計書6.12）。
        .txt は投稿サイトの記法（｜漢字《かんじ》）で書かれているので、
        取り違えると記法が生のまま出るか、平文が記法として畳まれる。
      */
      const notation =
        typeof message.notation === "string" ? message.notation : "curly";
      const notationChanged = notation !== composeNotation;
      composeNotation = notation;
      if (composeOn) {
        // 記法そのものが変わったときは、本文が同じでも組み直す
        // （面を開いたまま原稿の種類が変わるのは稀だが、変わったら組みも変わる）
        if (notationChanged) composeApplyText(message.text);
        else composeTakeIncoming(message.text);
      } else takeIncoming(message.text);
      // 覚えていた「組んで書く」は、本文が届いてから開く。
      // **一度きりにする**——安全弁で断られたときに、届くたび試し直さない
      if (composeWanted && !composeOn) {
        composeWanted = false;
        composeEnter();
      }
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
    } else if (message.type === "count") {
      // 上の帯の字数は消した（作者の指示、2026-08-29「上を消してください」。
      // 下段の「このファイル」と同じ数字が2か所に出ていた）。届いた値は
      // 下段だけが使う
      if (typeof message.value === "number") {
        footFile = message.value;
        paintCounts();
      }
    } else if (message.type === "counts") {
      // 作品の合計と「今日この話で書いた量」。開いたときと保存したときに届く
      if (typeof message.workTotal === "number") {
        footWorkTotal = message.workTotal;
        footWorkBase =
          typeof message.fileAtBase === "number" ? message.fileAtBase : footFile;
      }
      // 記録を止めている作者には届かない。そのときは出さない（0と書かない）
      footToday = typeof message.today === "number" ? message.today : null;
      paintCounts();
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
    } else if (message.type === "select") {
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
  /**
   * いま組んでいる記法（設計書6.12）。**拡張機能側が原稿の種類で決める**
   * （.md は "curly"、.txt は "site"）。最初の update で届く。
   *
   * 届く前に組むことは無い（この面は本文が届いてから開く）が、
   * 万一のときは .md の記法として扱う——.txt の本文に波括弧が
   * 出てくることは稀で、取り違えても平文として素通りする側だから。
   */
  let composeNotation = "curly";

  /* compose:start */
  /**
   * ルビ・傍点の記法。**定義は core/manuscriptRender.ts の1つだけ**で、
   * ここへはその文字列がそのまま埋め込まれる（写しを置かない）。
   *
   * モードが2つある（設計書6.12）。
   *
   * - curly … {漢字|かんじ} と {{強調}}（.md）
   * - site  … ｜漢字《かんじ》 と 《《強調》》（.txt。投稿サイトの形）
   *
   * **どの捕獲番号が親文字なのかもモードで違う**（site は縦線ありと
   * 縦線なしの2通りのルビを持つ）ので、番号も一緒に受け取る。
   */
  const COMPOSE_NOTATION_RULES = ${JSON.stringify(NOTATION_RULES)};

  /**
   * シーンメモの記法とタグの色分け（設計書6.40）。
   *
   * **定義は core/sceneMemo.ts の1つだけ。** ルビの記法と同じで、
   * ここへはその文字列がそのまま埋め込まれる（写しを置くと、
   * 拡張機能側と画面側で「どれがメモか」が食い違う日が来る）。
   */
  const MEMO_LINE_RE = new RegExp(${JSON.stringify(MEMO_LINE_PATTERN)});
  const MEMO_TAG_CLASSES = ${JSON.stringify(MEMO_TAG_CLASS_MAP)};

  /** タグとして読む語の長さの上限（core/sceneMemo.ts と同じ理由・同じ値） */
  const MEMO_TAG_MAX = 12;

  /** その行が付箋か。**行の先頭だけを見る**（途中の // はURL・会話文） */
  function memoIsLine(line) {
    return MEMO_LINE_RE.test(line);
  }

  /**
   * 付箋の行を、タグと本文に分ける。
   *
   * **分け方は core/sceneMemo.ts の parseMemos と同じにする。** 画面の
   * チップに出るタグと、横のパネルに並ぶタグが食い違うと、同じ行が
   * 別のものに見える。日本語には語の切れ目に空白が無いので、
   * **語が1つだけならタグではない**（それが本文である）。
   */
  function memoPartsOf(line) {
    /* 変数を body と名付けない——消したはずの「並べる」面のCSS class
       （body に続けて split と書く形）と同じ並びになり、
       それが残っていないかを見張る試験に当たってしまう */
    const rest = line.replace(MEMO_LINE_RE, "").replace(/^[\\s　]+/, "");
    const words = rest.split(/[\\s　]+/).filter(function (word) {
      return word.length > 0;
    });
    if (words.length === 0) return { tag: "メモ", text: "" };
    const head = words[0];
    if (words.length === 1) {
      // 印とタグだけ書いて、あとから中身を足す書き方がある
      if (MEMO_TAG_CLASSES[head]) return { tag: head, text: "" };
      return { tag: "メモ", text: rest };
    }
    // 長い先頭語はタグではない（文の途中で空けただけ）
    if (head.length > MEMO_TAG_MAX) return { tag: "メモ", text: rest };
    return { tag: head, text: rest.slice(head.length).replace(/^[\\s　]+/, "") };
  }

  /**
   * 付箋の行に付けるクラス。
   *
   * **色分けは読み替え表にある語だけで決める。** 表に無いタグは memo
   * だけになり、灰色の丸が付く（作者が自由に付けたタグを弾かない）。
   */
  function memoClassFor(line) {
    if (!memoIsLine(line)) return "";
    const extra = MEMO_TAG_CLASSES[memoPartsOf(line).tag];
    return extra ? "memo " + extra : "memo";
  }

  /** 知らないモードが来ても、いままでの記法で組む（本文を壊さない側へ倒す） */
  function composeRules(mode) {
    const rules = COMPOSE_NOTATION_RULES[mode];
    return rules ? rules : COMPOSE_NOTATION_RULES.curly;
  }

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
   *
   * @param mode "curly"（.md）か "site"（.txt）。省略すると curly
   */
  function composeParts(line, mode) {
    const rules = composeRules(mode);
    const parts = [];
    const pattern = new RegExp(rules.pattern, "g");
    let last = 0;
    let match = pattern.exec(line);
    while (match !== null) {
      // 長さ0の一致は位置が進まない（無限に回る）。念のため
      if (match[0].length === 0) break;
      if (match.index > last) {
        composePushText(parts, line.slice(last, match.index));
      }
      composePushMatch(parts, match, rules);
      last = match.index + match[0].length;
      match = pattern.exec(line);
    }
    if (last < line.length) composePushText(parts, line.slice(last));
    return parts;
  }

  /**
   * 当たった一致を部品にする。**どの番号が何なのかは rules が持つ。**
   *
   * .txt のルビは縦線あり（｜漢字《かんじ》）と縦線なし（漢字《かんじ》）の
   * 2通りあり、当たったほうの番号にだけ値が入る。
   */
  function composePushMatch(parts, match, rules) {
    for (const at of rules.emphasis) {
      if (match[at] === undefined) continue;
      parts.push({
        kind: "emphasis",
        src: match[0],
        base: match[at],
        reading: "",
      });
      return;
    }
    for (const pair of rules.ruby) {
      const base = match[pair[0]];
      if (base === undefined) continue;
      const reading = match[pair[1]] === undefined ? "" : match[pair[1]];
      if (reading.trim() === "") break;
      parts.push({ kind: "ruby", src: match[0], base: base, reading: reading });
      return;
    }
    // 読みが空のルビ・当たらなかった一致。**記法のまま平文で残す**
    composePushText(parts, match[0]);
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
   * 三点リーダ「…」の印（作者の依頼、2026-08-28）。
   *
   * 位置はフォント任せで、横書きでは下に沈み、縦書きでは縦用の字形を
   * 持たないフォントで横倒しのまま出る。印を付けてCSSで行の中央へ寄せる。
   *
   * **飾りを持たない素の span にする**（作者の実機報告、2026-08-28
   * 「組んで書くの三点リーダーはまだ変です。間を開けないでください」）。
   * 0.24.12 では contenteditable="false" の**かたまり**にしていたが、
   * 編集できない要素は編集領域の中で1文字ぶんの箱として扱われず、
   * 縦書きで「……」の点列のあいだに隙間が出た。**CSSを写しただけでは
   * 同じに見えない**——DOMの作りまで同じにする必要がある。
   *
   * かたまりを外した代わりに、**打鍵の直前にカーソルを span の外へ出す**
   * （composeEscapeEllipsis）。span の中で打つと、回した書式が次の字へ
   * 伝染するためである。伝染しても本文は正しいままで、面を組み直せば直る
   * ので、**常に見える隙間より軽い**という順序で選んだ。
   *
   * **1文字ずつ包む。** 「……」をまとめて回すと、回転の中心が2文字の
   * 真ん中になり、縦書きで点列が柱からはみ出す（読む面と同じ理由）。
   */
  function composeBuildEllipsis(doc) {
    const span = doc.createElement("span");
    span.setAttribute("class", "ellipsis");
    // data-src は付けない。直列化は**中の文字を拾う**経路（知らない要素と
    // 同じ扱い）で「…」に戻る。付けるとかたまりとして数えられてしまう
    span.appendChild(doc.createTextNode("…"));
    return span;
  }

  /**
   * ダッシュに使われる2つの文字。
   *
   * **見た目はほとんど同じだが、別の文字である**（欧文の U+2014 EM DASH と
   * 和文の U+2015 HORIZONTAL BAR）。ソースに直に書くと、どちらを書いたのか
   * 読む人にも分からなくなるので、符号から作る。
   */
  const DASH_CHARS = String.fromCodePoint(0x2014) + String.fromCodePoint(0x2015);

  /**
   * ダッシュの印（作者の実機報告、2026-08-29
   * 「主従の悪だくみが始まった――」の2本のあいだに隙間が見える）。
   *
   * 隙間の正体は**書体の取り違え**である。選んだ書体が「―」を持たないと
   * 欧文へ落ち、欧文のダッシュは字送りより線が短いので、並べても
   * つながらない。CSSで和文の明朝に固定するために印を付ける。
   *
   * **入っていた字をそのまま入れる**（U+2014 なら U+2014 のまま）。
   * ここで字を揃えてしまうと、**打っただけで本文が書き換わる**——
   * 字を揃えるのは、作法チェック（core/writingStyleCheck.ts）の提案を
   * 作者が承認したときだけである。
   *
   * 三点リーダと同じく、**1文字ずつ包んだ素の span** にする
   * （composeBuildEllipsis の但し書きがそのまま当てはまる）。
   */
  function composeBuildDash(doc, char) {
    const span = doc.createElement("span");
    span.setAttribute("class", "dash");
    // data-src は付けない（三点リーダと同じ。中の文字を拾う経路で元へ戻る）
    span.appendChild(doc.createTextNode(char));
    return span;
  }

  /** 平文を段落へ入れる。**三点リーダとダッシュは、揃えるための印で包む** */
  function composeAppendText(parent, value, doc) {
    let last = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      const isEllipsis = char === "…";
      const isDash = DASH_CHARS.indexOf(char) >= 0;
      if (!isEllipsis && !isDash) continue;
      if (i > last) parent.appendChild(doc.createTextNode(value.slice(last, i)));
      parent.appendChild(
        isEllipsis ? composeBuildEllipsis(doc) : composeBuildDash(doc, char)
      );
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
  function composeBuildLine(line, doc, mode) {
    const p = doc.createElement("p");
    // 付箋の行は、見た目だけを変える（設計書6.40.3）。
    // **かたまりにはしない**——中身は普通に打てて、印を消せば本文へ戻る
    const memo = memoClassFor(line);
    p.setAttribute("class", memo ? "line " + memo : "line");
    const parts = composeParts(line, mode);
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
  function composeBuildFragment(text, doc, mode) {
    const fragment = doc.createDocumentFragment();
    const lines = text.split("\\n");
    for (const line of lines) {
      fragment.appendChild(composeBuildLine(line, doc, mode));
    }
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
        // かたまり（ルビ・傍点）。**中は見ない**——記法そのものを持っている。
        // 三点リーダはかたまりではない（素の span なので、下の
        // 「知らない要素は中の文字を拾う」経路で平文として数えられる）
        atoms.push({
          kind: "chunk",
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

  /**
   * その範囲に、かたまり（ルビ・傍点）が重なっているか。
   *
   * 三点リーダは**かたまりではない**（素の span で、平文として数えられる）
   * ので、ここには当たらない。「そう……」に傍点、のような使い方は通る。
   */
  function composeSelectionHasChunk(atoms, start, end) {
    for (const atom of atoms) {
      if (atom.kind !== "chunk") continue;
      if (atom.start < end && atom.end > start) return true;
    }
    return false;
  }

  /**
   * 右クリックで開く品書きが、どの用語を指すか。
   *
   * ## なぜ純粋な関数にしてあるか
   *
   * 判定を間違えると**別人の設定資料が開く**。実機でしか動かない部品
   * （画面の座標→本文の位置、選択範囲）を引数で受け取る形にして、
   * 判定そのものを画面の外から試せるようにした。
   *
   * ## 直した不具合（作者の実機報告、2026-08-29）
   *
   * 「用語の上で右クリックしても設定資料パネルが切り替わらない」。
   * ログには**同じ人物が6回続けて**送られていた。
   *
   * 原因は**残っている選択**である。誤字脱字パネルから本文へ飛ぶと
   * （revealLine）、その行がまるごと選ばれたままになる。以前の判定は
   * 「選択が空でなければ、選択に重なる最初の用語」だったので、
   * **その行に人物が1人いると、以後どこを押してもその人物**になった。
   *
   * ## 決め方
   *
   * 1. 押した位置が**選択の中**なら、選択に重なる最初の用語
   *    （「選んでから右クリック」を守る）
   * 2. そうでなければ、**押した位置**の用語
   * 3. 押した位置が分からないとき（座標を本文の位置に直せない環境。
   *    縦書きで起きているらしい）は、**カーソルの位置**で引く——
   *    右クリックはカーソルを押したところへ動かすので、選択が縮退して
   *    いれば、その start が押した位置である
   *
   * @param clickOffset 画面の座標から求めた本文の位置（求まらなければ null）
   * @param selection いまの選択（{ start, end }。無ければ null）
   * @param spans 用語の位置の一覧
   */
  function pickMenuTerm(clickOffset, selection, spans) {
    const hasRange =
      selection && typeof selection.end === "number" &&
      selection.end > selection.start;

    // 1. 押したところが選択の中なら、選んだものを引く
    if (hasRange && clickOffset !== null &&
        clickOffset >= selection.start && clickOffset <= selection.end) {
      for (const span of spans) {
        if (span.start < selection.end && span.end > selection.start) {
          return span;
        }
      }
      // 選択の中に用語が無いなら、押した位置で引き直す（下へ落ちる）
    }

    // 2・3. 押した位置。取れなければカーソル（縮退した選択）の位置
    let offset = clickOffset;
    if (offset === null && selection && selection.end === selection.start) {
      offset = selection.start;
    }
    if (offset === null) return null;

    // **端は含めない。** 用語の直後で右クリックして隣の資料が開くと分かりにくい
    for (const span of spans) {
      if (offset >= span.start && offset < span.end) return span;
    }
    return null;
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
    // **記法は原稿の種類で決まる**（.txt は投稿サイトの記法で組む）。
    // 安全弁は記法によらず同じ——組み直したものが元と1文字でも違えば入らない
    const built = composeBuildFragment(wanted, document, composeNotation);
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
    /*
      **打つ面の目印は、この面にいる間ずっと古いままだった**（組んで書く面は
      目印を使わないので、更新もされない）。出し直す前に、いまの本文と
      合っているかを確かめる——合っていなければ隠れたままになる
    */
    applyMarksIfMatch();
    write.focus();
    if (at) {
      try {
        write.setSelectionRange(at.start, at.end);
      } catch (error) {
        /* 範囲外なら諦める */
      }
    }
  }

  /*
    **組んで書くをやめるボタンも外した**（作者の指示、2026-08-29。
    組んで書くが標準）。composeLeave は残す——安全弁が届いた本文を
    組み直せないと判断したとき（composeApplyText）に、この面から
    「書く」面へ落とすのに要る。落ちた先の textarea では、これまでどおり
    普通に打てる。
  */

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
    composeRepaintMemos();
  });

  /**
   * 行の付箋らしさを付け直す（設計書6.40.3）。
   *
   * **class 属性しか触らない。** ノードを足したり消したりすると
   * DOM→記法の直列化がずれる（＝本文が壊れる）。見た目だけを変える。
   *
   * **打たれるたびに呼ぶ。** 組み直し（composeApplyText）は、打った本文が
   * 返ってきたときには走らない（往復が一致するので早く戻る）ので、
   * ここで当て直さないと、印を打っても色が付かないまま残る。
   *
   * **変換中は呼ばない**（呼び出し側が確定を待つ）。確定前の文字を含む
   * 行の属性を書き換えると、変換そのものに障ることがある。
   */
  function composeRepaintMemos() {
    const lines = compose.querySelectorAll("p, div");
    for (const element of lines) {
      // 行の入れ物だけを見る（ルビの中の要素は行ではない）
      if (element.parentNode !== compose) continue;
      const memo = memoClassFor(element.textContent || "");
      element.setAttribute("class", memo ? "line " + memo : "line");
    }
  }

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
      // 変換で確定した行が付箋になったかもしれない（設計書6.40.3）
      composeRepaintMemos();
    }, 0);
  });

  /**
   * カーソルが**字を揃えるための印**の中にいるなら、その印を返す。
   *
   * 印は2種類ある——三点リーダ（span.ellipsis）とダッシュ（span.dash）。
   * **どちらも素の span なので、中へカーソルが入る**（かたまりにすると
   * 縦書きで隙間が出るため、そうしてある）。逃がす扱いは同じでよい。
   */
  function composeEllipsisAncestor(node) {
    let at = node;
    while (at && at !== compose) {
      const name =
        at.nodeType === 1 && at.getAttribute ? at.getAttribute("class") : null;
      if (name === "ellipsis" || name === "dash") return at;
      at = at.parentNode;
    }
    return null;
  }

  /**
   * 打つ前に、カーソルを**字を揃えるための印**（三点リーダ・ダッシュ）の
   * 外へ出す。
   *
   * どちらも素の span で出している（かたまりにすると縦書きで隙間が出る。
   * composeBuildEllipsis 参照）。素の span は中へカーソルが入るので、
   * **そこで打った字が、印に掛けた書式（回転・書体）を受け継ぐ。**
   *
   * 打った字が本文として正しいことは変わらない（直列化は中の文字も拾う）
   * ので、**これは見た目だけの話**で、面を組み直せば直る。それでも、
   * 打つたびに字が横倒しになるのは目障りなので、先に外へ逃がしておく。
   *
   * **変換中（IME）は触らない。** 変換の途中で選択を動かすと、日本語入力の
   * 側が持っている位置とずれて、変換そのものが壊れる。
   */
  function composeEscapeEllipsis(kind) {
    if (composing) return;
    // 文字を入れる操作だけ。消す操作でずらすと、消える字が変わってしまう
    if (kind.indexOf("insert") !== 0) return;
    if (kind === "insertCompositionText") return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return;
    const span = composeEllipsisAncestor(range.startContainer);
    if (!span || !span.parentNode) return;
    // 先頭にいるなら手前へ、それ以外は後ろへ出す（打った字が同じ側に残る）
    const atHead =
      range.startOffset === 0 &&
      (range.startContainer === span ||
        range.startContainer === span.firstChild);
    const moved = document.createRange();
    if (atHead) moved.setStartBefore(span);
    else moved.setStartAfter(span);
    moved.collapse(true);
    selection.removeAllRanges();
    selection.addRange(moved);
  }

  /**
   * **装飾のコマンドは通さない。** Ctrl+B などは記法に無いものを
   * DOMへ入れる（太字の要素）ので、直列化がそこで崩れる。
   */
  compose.addEventListener("beforeinput", function (event) {
    const kind = event.inputType || "";
    if (kind.indexOf("format") === 0) {
      event.preventDefault();
      return;
    }
    composeEscapeEllipsis(kind);
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

  /**
   * 組んで書く面を、その位置が見えるところまで動かす。
   *
   * **#compose 自身が転がる入れ物**（position:absolute + overflow:auto）
   * なので、動かすのはこの要素の scrollLeft/scrollTop である。
   * 縦書き（左右に流れる）と横書き（上下に流れる）で式を分けないのは、
   * **割合ではなく「はみ出した差」だけを足す**ためである（offRect）。
   *
   * 動かせたら true。位置を測れなければ false（呼んだ側が記録に残す）。
   */
  function composeNudgeIntoView(offset) {
    const atoms = composeCurrentAtoms();
    const head = composeOffsetToPoint(atoms, offset);
    if (!head) return false;
    try {
      const range = document.createRange();
      range.setStart(head.node, head.offset);
      range.setEnd(head.node, head.offset);
      let rect = range.getBoundingClientRect();
      // 幅も高さも0で返る場面がある（行の頭・空行）。入れ物の側で測り直す
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        const host =
          head.node.nodeType === 1 ? head.node : head.node.parentElement;
        if (!host) return false;
        rect = host.getBoundingClientRect();
      }
      const off = offRect(compose, rect);
      if (off.left !== 0) compose.scrollLeft += off.left;
      if (off.top !== 0) compose.scrollTop += off.top;
      return true;
    } catch (error) {
      return false;
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
   * 押されたところの用語。**決め方は pickMenuTerm が持つ**（試せる形）。
   *
   * ここがやるのは、実機でしか取れない2つ——画面の座標を本文の位置に
   * 直すことと、いまの選択を読むこと——を渡すところまでである。
   */
  function composeTermAt(x, y) {
    const clickOffset = composeOffsetAtPoint(x, y);
    if (clickOffset === null) {
      /*
        **縦書きで座標を本文の位置に直せない**という報告がある
        （作者の実機報告、2026-08-29「右クリックしても設定資料を見るが
        出ない」）。caretRangeFromPoint の縦書きでの振る舞いは実機でしか
        確かめられないので、切り分けの手がかりを残す。

        出るのは品書きを開く1回につき1行だけで、**正常なら出ない**ので
        記録が溢れることはない。
      */
      vscode.postMessage({
        type: "log",
        text:
          "原稿エディタ：右クリックの位置を本文の位置に直せませんでした（縦書き=" +
          (vertical !== false) + "）",
      });
    }
    return pickMenuTerm(clickOffset, composeMenuAt, termSpans);
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
      /*
        **付箋を先に見る**（設計書6.40.3）。付箋の行は小さい字で組んで
        いるので、長いメモは行内で読み切れない。載せたら全文をチップに出す。
        こちらは要素があるので、位置ではなく当たり判定で引ける。
      */
      const memo = memoElementAt(at.x, at.y);
      if (memo) {
        const parts = memoPartsOf(memo.textContent || "");
        fillTip(parts.tag, "memo", parts.text || "（メモの中身がありません）");
        placeTip({ left: at.x, right: at.x, top: at.y, bottom: at.y });
        return;
      }
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

  /** その座標にある付箋の行。無ければ null */
  function memoElementAt(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target || !target.closest) return null;
    const found = target.closest(".memo");
    // 組んで書く面の外（品書き・帯）に .memo は無いが、念のため囲いを確かめる
    return found && compose.contains(found) ? found : null;
  }
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
