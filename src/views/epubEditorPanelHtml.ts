/**
 * EPUBエディターの画面（設計書6.65.6・6.65.8・6.65.15）。
 *
 * **右が本の並び、左が「いま編んでいる1つ」の画面**（段D。作者の指定）。
 * 右の狭い列にはいまの本の構成をアイコンの縦列で出し、左には**選んだ
 * ブロックだけの編集画面**（そのブロックの設定と、そのブロックのプレビュー）
 * を出す。全部の設定を縦に積んだ長い1ページにしない——設定の欄が並ぶだけの
 * 画面では、本の構造も、いま何を触っているのかも見えなかった。
 *
 * **本全体の設定は、並びの外の1画面**である（書誌情報・綴じ方向・空行の詰め・
 * 書体）。どのブロックにも属さないので、右の列の最上部に**並びとは区別した
 * 固定の入口**を置き、そこから開く（ドラッグの対象にも、削除の対象にもしない）。
 *
 * **本の面の中身は組み立てない。** 面のXHTML断片と本のCSSは拡張機能側
 * （`core/epubPackage.ts`）が作り、ここは受け取って並べるだけである。
 * 画面で組み直した時点で、「見た目どおりに編集できる」という要件が壊れる。
 *
 * ## 並べ替えのドラッグと、右クリックのメニュー（段D）
 *
 * 段Cでは「ドラッグは作らない」と決めていた（webviewでの検証が重い）が、
 * **作者の指定でドラッグを入れた**。縦1列の並べ替えに限れば、確かめるべき
 * ことは「どの隙間へ落ちたか」だけに絞れる——そこで、**並びの計算は
 * 拡張機能側の純関数（`dropBookBlock`）に置き、画面は掴んだ行と落とした
 * 隙間だけを知らせる**。取りやめ（Escや枠の外で離す）では何も知らせない
 * ので、並びは変わらない。
 *
 * 挿入・上下・削除は**右クリックの自前のメニュー**へ畳んだ（行がすっきりし、
 * ドラッグが苦手な人の道も残る）。webviewにはVS Codeのメニューが出ないので、
 * 小さなメニューを自分で描く（クリック外し・Escで閉じる）。
 *
 * ## 合成だけは、ここが描く
 *
 * 表紙・裏表紙は例外である。本へ入るのは**画像1枚**なので、そこには
 * 「書き出しと同じ組版」というものが無い。合成できるのは canvas だけ
 * なので、プレビューも焼くのも**同じ canvas・同じ描画関数**にした。
 * プレビューをCSSで、焼くのを canvas でと分けると、見えているものと
 * 焼けたものがずれる（これは6.65.6が禁じている「2つ持つ」と同じ形）。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （題名の引用符で画面が壊れるのを防ぐ。ほかのパネルと同じ）。
 */

/** 合成できる要素と、その値をどの欄から取るか（設計書6.65.8） */
const COVER_ELEMENTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "title", label: "題名" },
  { key: "author", label: "作者名" },
  { key: "illustrator", label: "イラストレーター名" },
  { key: "label", label: "レーベル名" },
];

/** 置き場所の9つのプリセット。座標は持たない（設計書6.65.8） */
const COVER_ANCHOR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "top-left", label: "上・左" },
  { value: "top-center", label: "上・中央" },
  { value: "top-right", label: "上・右" },
  { value: "middle-left", label: "中・左" },
  { value: "middle-center", label: "中・中央" },
  { value: "middle-right", label: "中・右" },
  { value: "bottom-left", label: "下・左" },
  { value: "bottom-center", label: "下・中央" },
  { value: "bottom-right", label: "下・右" },
];

const COVER_SIZE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "large", label: "大" },
  { value: "medium", label: "中" },
  { value: "small", label: "小" },
];

function options(
  list: ReadonlyArray<{ value: string; label: string }>
): string {
  return list
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join("");
}

/** 1要素ぶんの欄。IDは `front-title-anchor` の形で組み立てる */
function coverElementRow(side: string, key: string, label: string): string {
  const id = `${side}-${key}`;
  return [
    '    <div class="cover-row">',
    `      <label class="check"><input id="${id}-visible" type="checkbox"><span>${label}</span></label>`,
    '      <div class="cover-controls">',
    `        <select id="${id}-anchor" title="置き場所">${options(
      COVER_ANCHOR_OPTIONS
    )}</select>`,
    `        <select id="${id}-size" title="字の大きさ">${options(
      COVER_SIZE_OPTIONS
    )}</select>`,
    `        <select id="${id}-color" title="色">` +
      '<option value="#ffffff">白</option>' +
      '<option value="#000000">黒</option>' +
      '<option value="custom">任意</option>' +
      "</select>",
    `        <input id="${id}-colorPick" type="color" title="任意の色">`,
    `        <label class="check"><input id="${id}-vertical" type="checkbox"><span>縦</span></label>`,
    "      </div>",
    "    </div>",
  ].join("\n");
}

/**
 * 枠の余白の色を選ぶ欄（設計書6.65.15の3）。
 *
 * 表紙・裏表紙の枠は横1：縦1.4に固定してあり、元イラストが違う比率のときは
 * 縮めて中央に納め、余った部分をこの色で塗る。文字要素の色（白・黒・任意）と
 * まったく同じ選び方にする——色の選び方を2通り作らない。
 */
function frameBackgroundRow(side: string): string {
  const id = `${side}-frameBackground`;
  return [
    '    <div class="cover-row">',
    "      <span>枠の余白の色（元イラストが枠と違う比率のとき）</span>",
    '      <div class="cover-controls">',
    `        <select id="${id}-color" title="色">` +
      '<option value="#000000">黒</option>' +
      '<option value="#ffffff">白</option>' +
      '<option value="custom">任意</option>' +
      "</select>",
    `        <input id="${id}-colorPick" type="color" title="任意の色">`,
    "      </div>",
    "    </div>",
  ].join("\n");
}

/**
 * 表紙・裏表紙1面ぶんの欄（設計書6.65.8）。
 *
 * **元イラストが無いときは、合成の塊ごと畳んで理由を出す**（`hidden`）。
 * 消してしまうと「なぜ合成の欄が無いのか」が分からない
 * （`processAvailability.ts` と同じ流儀）。
 */
function coverSection(
  side: string,
  pathFieldId: string,
  bakeButtonId: string,
  bakeLabel: string,
  unbakeButtonId: string
): string {
  return [
    `    <label><span>元イラストの場所（作品フォルダからの相対パス）</span><input id="${pathFieldId}" type="text"></label>`,
    `    <p class="note" id="${side}-bake-note"></p>`,
    // **焼いた画像の話は、合成の欄の外に置く。** 元イラストの指定を
    // 消しても焼いた画像は残り（本にも入り）、そのとき合成の欄は畳まれる。
    // 中に入れると、消す手立てごと見えなくなる（設計書6.65.8）
    `    <p class="note" id="${side}-baked-note"></p>`,
    `    <div class="cover-actions" id="${side}-baked-actions" hidden>`,
    `      <button id="${unbakeButtonId}">焼いた画像を消す</button>`,
    "    </div>",
    `    <div id="${side}-compose">`,
    ...COVER_ELEMENTS.map((element) =>
      coverElementRow(side, element.key, element.label)
    ),
    frameBackgroundRow(side),
    `      <div class="cover-actions"><button id="${bakeButtonId}">${bakeLabel}</button></div>`,
    "    </div>",
  ].join("\n");
}

/**
 * 面ごとの設定の欄1つ。**選んだ面のものだけを出す**（`hidden` の付け外し）。
 *
 * `name` は種類そのものではなく「欄の名前」である——口絵と扉絵は置ける場所
 * だけが違い、設定は同じなので、1つの欄（`image`）を使い回す。
 */
function pane(name: string, body: readonly string[]): string {
  return [`  <div class="pane" id="pane-${name}" hidden>`, ...body, "  </div>"].join(
    "\n"
  );
}

export function buildEpubEditorPanelHtml(
  nonce: string,
  cspSource: string
): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EPUBエディター</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
h1 { font-size: 1.1em; margin: 0; flex: 1; }
h2 {
  font-size: 0.95em;
  margin: 18px 0 6px;
  color: var(--vscode-descriptionForeground);
  font-weight: normal;
}
main { display: flex; align-items: flex-start; gap: 16px; padding: 16px; }
/* 左が「いま編んでいる1つ」の画面、右が本の並び（設計書6.65.15の段D） */
#workspace { flex: 1; min-width: 0; }
#rail {
  width: 104px;
  flex: none;
  position: sticky;
  top: 56px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}
.rail-title { font-size: 11px; color: var(--vscode-descriptionForeground); }
.rail-hint {
  font-size: 10px;
  line-height: 1.5;
  margin: 6px 0 0;
  color: var(--vscode-descriptionForeground);
}
#blockList { display: flex; flex-direction: column; gap: 4px; }
/* アイコンと短いラベルを縦に積む。狭い列なので横に並べると読めない */
.rail-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  width: 100%;
  text-align: center;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  cursor: pointer;
  /* 掴んでいる最中に文字が選択されると、行き先の線が見えなくなる */
  user-select: none;
}
/* 本の設定は並びの外にある固定の入口。並びの行と見分けが付くようにする */
.rail-fixed {
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 8px;
  margin-bottom: 4px;
  border-radius: 2px 2px 0 0;
}
.rail-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.rail-icon { font-size: 18px; line-height: 1.1; }
.rail-label { font-size: 11px; }
/*
 * 保留の面（設計書6.65.15の段D）。**薄くするだけで、消さない。**
 * 比較のために置いてあるものなので、並びの中の位置が見えていないと困る。
 */
.rail-row.suspended { opacity: 0.45; }
.rail-badge {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid var(--vscode-panel-border);
}
/* 落とし先の線。掴んだ行がどこへ入るのかを、離す前に見せる */
.rail-row.drop-before { box-shadow: 0 -2px 0 0 var(--vscode-focusBorder) inset; }
.rail-row.drop-after { box-shadow: 0 2px 0 0 var(--vscode-focusBorder) inset; }
/*
 * 右クリックの自前メニュー（設計書6.65.15の段D）。
 * **webviewにVS Codeのメニューは出ない**ので、自分で描く。
 */
.menu {
  position: fixed;
  z-index: 10;
  min-width: 168px;
  padding: 4px 0;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  border-radius: 4px;
}
.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 4px 12px;
  background: transparent;
  color: inherit;
  border-radius: 0;
}
.menu-item:hover:enabled { background: var(--vscode-list-hoverBackground); }
.menu-item:disabled { opacity: 0.4; cursor: default; }
/* ぶら下げずに開く。狭い場所に浮かせると、画面の端で切れて選べなくなる */
.submenu {
  border-top: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  border-bottom: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  margin: 2px 0;
  max-block-size: 240px;
  overflow: auto;
}
.submenu .menu-item { padding-inline-start: 24px; }
label { display: block; margin: 6px 0; }
label span { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); }
input[type="text"], select {
  width: 100%;
  padding: 4px 6px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  font-family: inherit;
  font-size: inherit;
}
label.check { display: flex; align-items: center; gap: 6px; }
label.check input { margin: 0; }
label.check span { display: inline; color: inherit; font-size: inherit; }
button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: inherit;
  font-family: inherit;
}
button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground); }
button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
#status { font-size: 12px; color: var(--vscode-descriptionForeground); }
#status.error { color: var(--vscode-errorForeground); }
.note { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
.page-frame { margin-bottom: 18px; }
.page-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.page-note { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
/* 面そのもの。中の体裁は本のCSS（#book-style）が決める */
.epub-page {
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
  block-size: 320px;
  overflow: auto;
  padding: 16px;
}
.cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  block-size: 100%;
  border: 1px dashed var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-font-family);
  text-align: center;
  line-height: 1.8;
}
/* 合成の面。canvasの中身は焼いたPNGとまったく同じものである */
.cover-canvas {
  display: block;
  margin: 0 auto;
  max-inline-size: 100%;
  max-block-size: 100%;
}
.cover-row { margin: 8px 0; }
/* 欄が5つ並ぶ。狭い画面では折り返させる（横に潰れて読めなくなるより良い） */
.cover-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}
.cover-controls select { width: auto; flex: 1 1 5em; min-width: 0; }
.cover-controls label.check { margin: 0; flex: none; }
.cover-controls input[type="color"] {
  inline-size: 28px;
  block-size: 24px;
  padding: 0;
  border: 1px solid var(--vscode-input-border, transparent);
  background: var(--vscode-input-background);
}
.cover-actions { margin-top: 10px; }
/* 話と章の一覧（設計書6.65.15の段C）。章の行は読み取り専用である */
#episodeList {
  max-block-size: 220px;
  overflow: auto;
  border: 1px solid var(--vscode-panel-border);
  margin-bottom: 8px;
}
.episode-row { display: block; width: 100%; text-align: left; background: transparent; color: var(--vscode-foreground); }
.episode-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.chapter-row {
  padding: 4px 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background, transparent);
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
}
/* 挿絵とページ分割の欄（設計書6.65.10）。段落は数が多いので枠の中で送る */
#paragraphList {
  max-block-size: 340px;
  overflow: auto;
  border: 1px solid var(--vscode-panel-border);
}
.para-row {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.para-row:last-child { border-bottom: none; }
.para-head { font-size: 12px; line-height: 1.5; margin-bottom: 4px; }
.para-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.para-actions label.check { margin: 0; }
.para-illust { margin-top: 6px; }
/* 位置のずれは、書き出す前にここで見える（複数行で並べる） */
#placementWarnings { white-space: pre-line; }
.note.error { color: var(--vscode-errorForeground); }
/*
 * プレビューにだけ出る改ページの印（core/epubXhtml.ts が組む）。
 * **本には入らない。** 画面は1枚の面なので実際には割れず、印が無いと
 * 「指定が効いていない」と読めてしまう。縦組みの面でも読めるよう横組みで出す
 */
.epub-page .page-break-mark {
  writing-mode: horizontal-tb;
  margin: 1em 0;
  padding: 2px 6px;
  border: 1px dashed var(--vscode-descriptionForeground);
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-font-family);
  font-size: 11px;
  text-align: center;
}
</style>
<style nonce="${nonce}" id="book-style"></style>
</head>
<body>
<header>
  <h1 id="title">EPUBエディター</h1>
  <span id="status"></span>
  <button id="save">保存</button>
  <button id="export" class="primary">EPUBを書き出す</button>
</header>
<main>
  <section id="workspace">
    <!--
      **本全体の設定は、それだけで1画面**（設計書6.65.15の段D。作者の指定）。
      どのブロックにも属さない設定（書誌情報・綴じ方向・空行の詰め・書体）を
      ここへ集め、ブロックの編集画面とは入れ替えで出す
    -->
    <div id="pane-bookSettings">
    <h2>本の設定</h2>
    <label><span>題名</span><input id="bookTitle" type="text"></label>
    <label><span>作者名</span><input id="author" type="text"></label>
    <label><span>イラストレーター名</span><input id="illustrator" type="text"></label>
    <label><span>レーベル名</span><input id="label" type="text"></label>
    <label><span>綴じ方向</span><select id="writingMode">
      <option value="vertical">縦書き（右から左へ開く）</option>
      <option value="horizontal">横書き（左から右へ開く）</option>
    </select></label>
    <label class="check"><input id="collapseBlankLines" type="checkbox"><span>続いた空行を1つ減らす</span></label>
    <label><span>本文用の書体（作品フォルダからの相対パス。.ttf / .otf）</span><input id="fontBody" type="text"></label>
    <label><span>見出し用の書体（同上）</span><input id="fontHeading" type="text"></label>
    <!--
      **ライセンスの注意書きは常に出す**（設計書6.65.3・6.65.11）。
      埋め込みが許諾されているかを確かめられるのは作者だけであり、
      畳んだり、指定したときだけ出したりはしない
    -->
    <p class="note">フォントの埋め込みが許諾されているかは、作者の責任でご確認ください（フォントのライセンスをご覧ください）。</p>
    </div>

    <!--
      **選んだブロックだけの編集画面**（設計書6.65.15の段D）。
      いま何を編んでいるかの見出し・その設定・その面のプレビューで1画面
    -->
    <div id="blockScreen" hidden>
    <h2 id="blockHeading">選んだ面</h2>
    <div id="blockSettings">
${pane("cover", [
  coverSection("front", "coverImagePath", "bakeFront", "表紙を焼く", "unbakeFront"),
])}
${pane("backCover", [
  '    <p class="note">本の最終面（奥付の後ろ）です。画像が無ければ、並びに置いてあっても面は出ません。</p>',
  coverSection(
    "back",
    "backCoverImagePath",
    "bakeBack",
    "裏表紙を焼く",
    "unbakeBack"
  ),
])}
${pane("halfTitle", [
  '    <p class="note">題名と作者名だけの面です。中身は「本の設定」の画面の書誌情報から組みます。</p>',
])}
${pane("toc", [
  '    <label><span>並べ方</span><select id="tocPattern">',
  '      <option value="vertical">一覧（本文と同じ流れ）</option>',
  '      <option value="horizontal">一覧（目次だけ横組み）</option>',
  '      <option value="chapters">章ごとに区切る</option>',
  "    </select></label>",
  '    <label><span>見出しの形</span><select id="tocEntryStyle">',
  '      <option value="numberAndTitle">番号＋題</option>',
  '      <option value="titleOnly">題だけ</option>',
  '      <option value="numberOnly">番号だけ</option>',
  "    </select></label>",
  '    <label><span>飾り</span><select id="tocOrnament">',
  '      <option value="none">なし</option>',
  '      <option value="rule">罫線</option>',
  '      <option value="center">中央飾り</option>',
  "    </select></label>",
  '    <p class="note">この面を本から外すときは、右の並びでこの面を右クリックして「削除」を選んでください。</p>',
])}
${pane("characters", [
  '    <label class="check"><input id="characterPageIcons" type="checkbox"><span>人物イラストを添える</span></label>',
  '    <p class="note">載るのは「登場済み・モブでない・公開」の人物の、名前と紹介文だけです。並びは設定資料の順になります。</p>',
  '    <p class="note" id="characterNotice"></p>',
])}
${pane("image", [
  '    <label><span>画像の場所（作品フォルダからの相対パス）</span><input id="blockImagePath" type="text"></label>',
  '    <label><span>解説文（省略できます）</span><input id="blockCaption" type="text"></label>',
  '    <p class="note">1枚で1つの面になります（本文の組み方には入りません）。扉絵は何枚でも、好きな位置に挿せます。</p>',
])}
${pane("body", [
  '    <p class="note">話と章の一覧です。章の行は章立ての台帳から出しています——章の追加・名前の変更・取り外しは、作品一覧の右クリックから行ってください。</p>',
  '    <div id="episodeList"></div>',
  '    <p class="note" id="placementNotice"></p>',
  '    <div id="paragraphList"></div>',
])}
${pane("afterword", [
  '    <p class="note">本文の後ろに1面として入ります。原稿は 設定/書籍/あとがき.md に書きます（まだ無ければ作ります）。書いていなければ、並びに置いてあっても面は出ません。</p>',
  '    <div class="cover-actions"><button id="openAfterword">あとがきを書く</button></div>',
])}
${pane("colophon", [
  '    <label><span>飾り</span><select id="colophonOrnament">',
  '      <option value="none">なし</option>',
  '      <option value="rule">罫線</option>',
  '      <option value="center">中央飾り</option>',
  "    </select></label>",
])}
    </div>

    <div id="pages"></div>
    </div>

    <!--
      本全体に関わる知らせは、どちらの画面でも見えるところへ置く
      （位置のずれは書き出す前に気づけないと意味がない）
    -->
    <p class="note error" id="placementWarnings"></p>
    <p class="note" id="notice"></p>
    <p class="note" id="filePath"></p>
  </section>
  <nav id="rail">
    <div class="rail-title">本の並び</div>
    <!--
      **並びの外にある固定の入口**（設計書6.65.15の段D）。ドラッグの対象にも
      削除の対象にもしない——本全体の設定は、本の面ではないからである
    -->
    <button id="railBook" class="rail-row rail-fixed">
      <span class="rail-icon">⚙</span>
      <span class="rail-label">本の設定</span>
    </button>
    <div id="blockList"></div>
    <p class="rail-hint">ドラッグで並べ替え。右クリックで挿入・上へ・下へ・削除。</p>
  </nav>
</main>
<!-- 右クリックの自前メニュー（webviewにVS Codeのメニューは出ない） -->
<div id="blockMenu" class="menu" hidden></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let sending = null;

function post(type, payload) {
  vscode.postMessage(Object.assign({ type: type }, payload || {}));
}

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function field(id) {
  return document.getElementById(id);
}

const TEXTS = ['bookTitle', 'author', 'illustrator', 'label'];
const CHOICES = ['writingMode', 'tocPattern', 'tocEntryStyle', 'tocOrnament', 'colophonOrnament'];
/*
 * 目次・人物紹介の「入れる」チェックは持たない（設計書6.65.15の段C）。
 * **並びに置いてあるかどうかが決める。** 設計図に残っている「入れるか」の
 * 2項目は古い設計図を読むためだけのもので、画面からは送らない
 * （送ると、作者が手で書いた値を塗り替えてしまう）。
 */
const CHECKS = ['collapseBlankLines'];
const PATHS = ['coverImagePath', 'backCoverImagePath'];
/** 書体の2枠。欄の中身は作品フォルダからの相対パス（空なら同梱しない） */
const FONT_FIELDS = { fontBody: 'body', fontHeading: 'heading' };

/** 合成の面は2つだけ。IDの前半に使う */
const SIDES = ['front', 'back'];
const ELEMENTS = ['title', 'author', 'illustrator', 'label'];
/** 合成に使う文字は、書誌情報の欄から取る（二重に持たない） */
const ELEMENT_FIELDS = {
  title: 'bookTitle',
  author: 'author',
  illustrator: 'illustrator',
  label: 'label'
};
const LAYOUT_KEYS = { front: 'coverLayout', back: 'backCoverLayout' };

/**
 * 面の種類 → 設定の欄の名前。**口絵と扉絵は同じ欄**（置ける場所だけが違う）。
 * 面の呼び名や順序は持たない——それは拡張機能側が決める。
 */
const PANES = {
  cover: 'cover',
  halfTitle: 'halfTitle',
  frontIllustration: 'image',
  sectionArt: 'image',
  toc: 'toc',
  characters: 'characters',
  body: 'body',
  afterword: 'afterword',
  colophon: 'colophon',
  backCover: 'backCover'
};
const PANE_NAMES = ['cover', 'backCover', 'halfTitle', 'toc', 'characters', 'image', 'body', 'afterword', 'colophon'];

function styleId(side, key, part) {
  return side + '-' + key + '-' + part;
}

/** 3桁の16進を6桁へ伸ばす（色の欄は6桁しか受け取らない） */
function expandHex(color) {
  const value = String(color || '').toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) {
    return '#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3];
  }
  return /^#[0-9a-f]{6}$/.test(value) ? value : '#ffffff';
}

/**
 * 枠の余白の色（設計書6.65.15の3）。**既定は黒**——書いてなければ
 * 拡張機能側の既定と合わせる（defaultCoverLayout と同じ値）。
 */
const DEFAULT_FRAME_BACKGROUND = '#000000';

function fillLayout(side, layout) {
  const source = layout || {};
  ELEMENTS.forEach(function (key) {
    const style = source[key] || {};
    field(styleId(side, key, 'visible')).checked = style.visible === true;
    field(styleId(side, key, 'anchor')).value = style.anchor || 'top-center';
    field(styleId(side, key, 'size')).value = style.size || 'medium';
    field(styleId(side, key, 'vertical')).checked = style.vertical === true;
    const color = expandHex(style.color);
    const named = color === '#ffffff' || color === '#000000';
    field(styleId(side, key, 'color')).value = named ? color : 'custom';
    field(styleId(side, key, 'colorPick')).value = color;
  });

  const frame = expandHex(source.frameBackground || DEFAULT_FRAME_BACKGROUND);
  const frameNamed = frame === '#ffffff' || frame === '#000000';
  field(styleId(side, 'frameBackground', 'color')).value =
    frameNamed ? frame : 'custom';
  field(styleId(side, 'frameBackground', 'colorPick')).value = frame;
}

function readLayout(side) {
  const layout = {};
  ELEMENTS.forEach(function (key) {
    const choice = field(styleId(side, key, 'color')).value;
    layout[key] = {
      visible: field(styleId(side, key, 'visible')).checked,
      anchor: field(styleId(side, key, 'anchor')).value,
      size: field(styleId(side, key, 'size')).value,
      color: choice === 'custom'
        ? field(styleId(side, key, 'colorPick')).value
        : choice,
      vertical: field(styleId(side, key, 'vertical')).checked
    };
  });

  const frameChoice = field(styleId(side, 'frameBackground', 'color')).value;
  layout.frameBackground = frameChoice === 'custom'
    ? field(styleId(side, 'frameBackground', 'colorPick')).value
    : frameChoice;

  return layout;
}

/** 枠の余白の色を読む。欄が見つからない・空なら既定（黒）にする */
function frameBackgroundOf(side) {
  const value = readLayout(side).frameBackground;
  return value ? value : DEFAULT_FRAME_BACKGROUND;
}

/* ---- 右の縦の並び（設計書6.65.15の段D） ---------------------------- */

/**
 * いまの並びと、選んでいる面。**中身は拡張機能側が組んだものを受け取る**
 * ——ここで面の呼び名や順序を持つと、二重管理になる。
 */
let blocks = [];
let selected = 0;
/**
 * いま出している画面（作者の指定、段D）。book は本全体の設定で、
 * **並びの外にある固定の入口**から開く。
 */
let currentScreen = 'block';
/** 「この後ろに挿入」に出せる種類。判断も呼び名も拡張機能側が持つ */
let insertTypes = [];
/** 最後に届いた面（プレビュー）。選び直しでは貰い直さずに出し分ける */
let pages = [];

/**
 * 面の絵柄。**呼び名は持たない**（拡張機能側の BOOK_BLOCK_LABELS が1か所）。
 * 知らない種類でも行が消えないよう、既定の絵柄を置いてある。
 */
const ICONS = {
  cover: '📕',
  halfTitle: '📄',
  frontIllustration: '🖼',
  sectionArt: '🎴',
  toc: '🗂',
  characters: '👤',
  body: '📖',
  afterword: '✍',
  colophon: '🏷',
  backCover: '📗',
  chapter: '🔖'
};
const DEFAULT_ICON = '📄';

function iconOf(type) {
  return ICONS[type] || DEFAULT_ICON;
}

/** 掴んでいる行。**-1 は掴んでいない**（取りやめると必ずここへ戻る） */
let dragFrom = -1;

/**
 * 落とし先の隙間（設計書6.65.15の段D）。行の高さの半分より上で離したら
 * 「その行の手前」、どの行より下なら末尾である。
 * **番号を出すだけで、並びは組み替えない**——計算は拡張機能側が持つ。
 */
function dropSlotAt(y) {
  const rows = field('blockList').children;
  for (let index = 0; index < rows.length; index++) {
    const rect = rows[index].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return index;
  }
  return rows.length;
}

/** 行き先の線。負の値なら消すだけ（掴んでいないときと取りやめのとき） */
function markDropSlot(slot) {
  const rows = field('blockList').children;
  for (let index = 0; index < rows.length; index++) {
    rows[index].classList.remove('drop-before');
    rows[index].classList.remove('drop-after');
  }
  if (slot < 0 || rows.length === 0) return;
  if (slot < rows.length) rows[slot].classList.add('drop-before');
  else rows[rows.length - 1].classList.add('drop-after');
}

/**
 * 掴んでいる印を消す。**知らせは送らない。**
 *
 * Escや枠の外で離したときにここへ来る——何も送らないので、並びは変わらない
 * （落としたときだけ dropBlock を送る一本道にしてある）。
 */
function clearDrag() {
  dragFrom = -1;
  markDropSlot(-1);
}

function renderBlocks() {
  const host = field('blockList');
  host.textContent = '';

  blocks.forEach(function (block, index) {
    // **行はボタンにする。** ドラッグできる div にすると、キーボードだけで
    // 面を選ぶ道が消える（掴めない人の道を残すのが段Dの趣旨である）
    const row = document.createElement('button');
    row.className = (index === selected && currentScreen === 'block'
      ? 'rail-row selected'
      : 'rail-row') + (block.suspended ? ' suspended' : '');
    row.draggable = true;
    // 呼び名も添え書きも拡張機能側の言葉である（画面で組み立てない）
    row.title = (block.detail ? block.label + '　' + block.detail : block.label)
      + (block.suspended ? '（保留中：本には入りません）' : '');

    const icon = document.createElement('span');
    icon.className = 'rail-icon';
    icon.textContent = iconOf(block.type);
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'rail-label';
    label.textContent = block.label;
    row.appendChild(label);

    // 保留の印（設計書6.65.15の段D）。**薄いだけでは気づけない**ので、
    // 言葉でも出す（本に入らないことは、黙って起きてはいけない）
    if (block.suspended) {
      const badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.textContent = '保留';
      row.appendChild(badge);
    }

    row.addEventListener('click', function () { selectBlock(index); });
    row.addEventListener('contextmenu', function (event) {
      // webviewにVS Codeのメニューは出ないので、自前のものを開く
      event.preventDefault();
      selectBlock(index);
      openMenu(index, event.clientX, event.clientY);
    });
    row.addEventListener('dragstart', function (event) {
      dragFrom = index;
      closeMenu();
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        // 中身を入れないと、ドラッグが始まらないブラウザがある
        event.dataTransfer.setData('text/plain', String(index));
      }
    });
    row.addEventListener('dragend', clearDrag);

    host.appendChild(row);
  });

  field('railBook').className = currentScreen === 'book'
    ? 'rail-row rail-fixed selected'
    : 'rail-row rail-fixed';
}

/**
 * いま編んでいる1つだけを出す（作者の指定、設計書6.65.15の段D）。
 *
 * **欄そのものは作り直さず、畳むだけ**である。作り直すと、打ちかけの字が
 * 画面を切り替えるたびに消える。
 */
function renderScreen() {
  const block = currentScreen === 'block' ? (blocks[selected] || null) : null;
  field('pane-bookSettings').hidden = currentScreen !== 'book';
  field('blockScreen').hidden = currentScreen === 'book';

  const wanted = block ? PANES[block.type] : null;
  PANE_NAMES.forEach(function (name) {
    field('pane-' + name).hidden = name !== wanted;
  });
  if (block) field('blockHeading').textContent = block.label + 'の編集';

  if (block && wanted === 'image') {
    field('blockImagePath').value = block.imagePath || '';
    field('blockCaption').value = block.caption || '';
  }
}

/**
 * 打ちかけの値を、いますぐ拡張機能へ渡す（作者の指定、段D）。
 *
 * 画面を切り替える前に必ず通す。待ち合わせ（scheduleChange）のままだと、
 * **切り替えの拍子に打ちかけの1文字が落ちる**。
 */
function flushChange() {
  if (sending) {
    clearTimeout(sending);
    sending = null;
  }
  post('change', { config: readForm() });
}

function selectBlock(index) {
  flushChange();
  currentScreen = 'block';
  selected = index;
  renderBlocks();
  renderScreen();
  renderPages();
}

/** 本全体の設定へ移る。並びの外なので、選んでいた面はそのまま覚えておく */
function selectBookScreen() {
  flushChange();
  currentScreen = 'book';
  renderBlocks();
  renderScreen();
}

/* ---- 右クリックの自前メニュー（設計書6.65.15の段D） ---------------- */

function menuItem(text, disabled, onPick) {
  const button = document.createElement('button');
  button.className = 'menu-item';
  button.textContent = text;
  button.disabled = disabled === true;
  if (!disabled) {
    button.addEventListener('click', function () {
      closeMenu();
      onPick();
    });
  }
  return button;
}

/**
 * 「この後ろに挿入」に並べる種類。
 *
 * **置ける種類だけを出す**（作者の指定）——もう置けない面は行ごと出さない。
 * 何が置けるかの判断も、呼び名も拡張機能側が持つ。
 */
function insertSubmenu(index) {
  const box = document.createElement('div');
  box.className = 'submenu';
  insertTypes.forEach(function (entry) {
    if (entry.enabled !== true) return;
    const item = menuItem(
      iconOf(entry.key) + '　' + entry.label,
      false,
      function () {
        // 章区切りは面ではない。台帳（設計書6.66）が正なので並びへは入れず、
        // 「どの話から始めるか」を拡張機能側に訊いてもらう
        if (entry.key === 'chapter') {
          post('addChapter', { config: readForm() });
          return;
        }
        post('insertBlock', {
          blockType: entry.key,
          index: index,
          config: readForm()
        });
      }
    );
    item.title = entry.reason || '';
    box.appendChild(item);
  });
  return box;
}

function openMenu(index, x, y) {
  const block = blocks[index];
  if (!block) return;

  const menu = field('blockMenu');
  menu.textContent = '';

  const submenu = insertSubmenu(index);
  submenu.hidden = true;
  const opener = document.createElement('button');
  opener.className = 'menu-item';
  opener.textContent = 'この後ろに挿入 ▶';
  opener.addEventListener('click', function () {
    submenu.hidden = !submenu.hidden;
  });
  opener.addEventListener('mouseenter', function () {
    submenu.hidden = false;
  });
  menu.appendChild(opener);
  menu.appendChild(submenu);

  menu.appendChild(menuItem('上へ', index === 0, function () {
    post('moveBlock', { index: index, direction: -1, config: readForm() });
  }));
  menu.appendChild(menuItem('下へ', index === blocks.length - 1, function () {
    post('moveBlock', { index: index, direction: 1, config: readForm() });
  }));
  // 保留（設計書6.65.15の段D）。**いまの状態に対する1行だけ**を出す。
  // 「保留にできるか」は拡張機能側の判断（本文には出ない）。解除できるか
  // は押したときに見て、同じ種類の有効な面が居れば理由を言って断る
  if (block.suspended) {
    menu.appendChild(menuItem('保留を解除', false, function () {
      post('suspendBlock', { index: index, suspended: false, config: readForm() });
    }));
  } else if (block.suspendable) {
    menu.appendChild(menuItem('保留にする', false, function () {
      post('suspendBlock', { index: index, suspended: true, config: readForm() });
    }));
  }
  // **消せない面には、削除の行そのものを出さない。** 押してから断られるより、
  // 初めから無いほうが分かりやすい（本文がこれに当たる）
  if (block.removable) {
    menu.appendChild(menuItem('削除', false, function () {
      post('removeBlock', { index: index, config: readForm() });
    }));
  }

  menu.hidden = false;
  // 画面の外へはみ出させない（右端・下端で右クリックしても全部見える）
  const width = menu.offsetWidth || 168;
  const height = menu.offsetHeight || 120;
  menu.style.left = Math.max(0, Math.min(x, window.innerWidth - width)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, window.innerHeight - height)) + 'px';
}

function closeMenu() {
  const menu = field('blockMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  menu.textContent = '';
}

/** 画像の面の欄を変えたら、その面だけを直してもらう（設計図は拡張機能側） */
function sendBlockEdit() {
  post('blockEdit', {
    index: selected,
    imagePath: field('blockImagePath').value,
    caption: field('blockCaption').value,
    config: readForm()
  });
}

/* ---- 話と章の一覧（設計書6.65.15の段C） ---------------------------- */

/**
 * 設計図の指定の写し。**話を選び直しても消えない**ように外に持つ。
 * 画像の場所を書く前の挿絵もここには残る（設計図へは載せない）。
 */
let illustrations = [];
let pageBreaks = [];
/** いま選んでいる話と、その段落の冒頭（拡張機能から貰う） */
let episodePath = '';
let paragraphs = [];
/** 話と章の並び。章の行は読み取り専用（台帳が正。設計書6.66） */
let outline = [];

function samePlace(item, number) {
  return item.episodePath === episodePath && item.afterParagraph === number;
}

function illustrationAt(number) {
  for (let index = 0; index < illustrations.length; index++) {
    if (samePlace(illustrations[index], number)) return illustrations[index];
  }
  return null;
}

function hasBreak(number) {
  return pageBreaks.some(function (item) { return samePlace(item, number); });
}

function toggleBreak(number, on) {
  pageBreaks = pageBreaks.filter(function (item) {
    return !samePlace(item, number);
  });
  if (on) pageBreaks.push({ episodePath: episodePath, afterParagraph: number });
  scheduleChange();
}

function toggleIllustration(number, on) {
  illustrations = illustrations.filter(function (item) {
    return !samePlace(item, number);
  });
  if (on) {
    illustrations.push({
      episodePath: episodePath,
      afterParagraph: number,
      imagePath: '',
      caption: ''
    });
  }
  // 場所を書く欄が増える（減る）ので、この行だけでなく一覧を組み直す
  renderParagraphs();
  scheduleChange();
}

function toggleField(label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', function () { onChange(box.checked); });
  const text = document.createElement('span');
  text.textContent = label;
  wrap.appendChild(box);
  wrap.appendChild(text);
  return wrap;
}

function textField(label, value, onInput) {
  const wrap = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  // **打っている途中で組み直さない**（打鍵のたびに欄から指が離れる）
  input.addEventListener('input', function () { onInput(input.value); });
  wrap.appendChild(caption);
  wrap.appendChild(input);
  return wrap;
}

function illustrationFields(item) {
  const box = document.createElement('div');
  box.className = 'para-illust';
  box.appendChild(textField(
    '画像の場所（作品フォルダからの相対パス）',
    item.imagePath,
    function (value) { item.imagePath = value; scheduleChange(); }
  ));
  box.appendChild(textField(
    '解説文（省略できます）',
    item.caption,
    function (value) { item.caption = value; scheduleChange(); }
  ));
  return box;
}

/**
 * 段落の一覧。番号だけでは、どこを指しているのか作者に分からないので
 * 冒頭を添える。**本文は textContent で入れる**（原稿をHTMLとして
 * 解釈させない）。
 */
function renderParagraphs() {
  const host = field('paragraphList');
  host.textContent = '';

  paragraphs.forEach(function (text, index) {
    const number = index + 1;
    const row = document.createElement('div');
    row.className = 'para-row';

    const head = document.createElement('div');
    head.className = 'para-head';
    head.textContent = number + '　' + text;
    row.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'para-actions';
    const illustration = illustrationAt(number);
    actions.appendChild(toggleField('ここに挿絵', illustration !== null,
      function (on) { toggleIllustration(number, on); }));
    actions.appendChild(toggleField('ここで改ページ', hasBreak(number),
      function (on) { toggleBreak(number, on); }));
    row.appendChild(actions);

    if (illustration) row.appendChild(illustrationFields(illustration));
    host.appendChild(row);
  });
}

/**
 * 話と章の一覧。**章の行は押せない**（台帳が正。直すのは作品一覧の
 * 右クリックからで、その案内は欄の上に常に出してある）。
 */
function renderOutline() {
  const host = field('episodeList');
  host.textContent = '';

  outline.forEach(function (entry) {
    if (entry.kind === 'chapter') {
      const row = document.createElement('div');
      row.className = 'chapter-row';
      row.textContent = entry.label;
      host.appendChild(row);
      return;
    }
    const row = document.createElement('button');
    row.className = entry.path === episodePath
      ? 'episode-row selected'
      : 'episode-row';
    row.textContent = entry.label;
    row.addEventListener('click', function () { selectEpisode(entry.path); });
    host.appendChild(row);
  });
}

function selectEpisode(path) {
  episodePath = path;
  // 段落は話ごとに違う。貰い直すまでは空にしておく（前の話の段落へ
  // 挿絵を付けてしまわないため）
  paragraphs = [];
  renderOutline();
  renderParagraphs();
  post('episode', { episodePath: episodePath });
}

/** 一覧を貰い直す。選んでいた話が残っていればそのまま、無ければ先頭にする */
function fillOutline(list) {
  outline = list || [];
  const episodes = outline.filter(function (entry) {
    return entry.kind === 'episode';
  });
  const found = episodes.some(function (entry) {
    return entry.path === episodePath;
  });
  const next = found ? episodePath : (episodes[0] ? episodes[0].path : '');

  if (next !== episodePath) {
    episodePath = next;
    paragraphs = [];
    renderOutline();
    renderParagraphs();
    if (episodePath) post('episode', { episodePath: episodePath });
    return;
  }
  renderOutline();
}

function applyWarnings(data) {
  field('placementWarnings').textContent =
    (data.placementWarnings || []).join('\\n');
  // 人物紹介は面を置いても空のことがある。理由は拡張機能側が持つ
  field('characterNotice').textContent = data.characterNotice || '';
}

function fillForm(config) {
  illustrations = (config.illustrations || []).map(function (item) {
    return {
      episodePath: item.episodePath,
      afterParagraph: item.afterParagraph,
      imagePath: item.imagePath,
      caption: item.caption
    };
  });
  pageBreaks = (config.pageBreaks || []).map(function (item) {
    return {
      episodePath: item.episodePath,
      afterParagraph: item.afterParagraph
    };
  });
  field('bookTitle').value = config.title || '';
  field('author').value = config.author || '';
  field('illustrator').value = config.illustrator || '';
  field('label').value = config.label || '';
  CHOICES.forEach(function (id) { field(id).value = config[id]; });
  CHECKS.forEach(function (id) { field(id).checked = config[id] === true; });
  PATHS.forEach(function (id) { field(id).value = config[id] || ''; });
  const characterPage = config.characterPage || {};
  field('characterPageIcons').checked = characterPage.showIcons === true;
  const fonts = config.fonts || {};
  Object.keys(FONT_FIELDS).forEach(function (id) {
    field(id).value = fonts[FONT_FIELDS[id]] || '';
  });
  SIDES.forEach(function (side) {
    fillLayout(side, config[LAYOUT_KEYS[side]]);
  });
}

function readForm() {
  const config = {
    title: field('bookTitle').value,
    author: field('author').value,
    illustrator: field('illustrator').value,
    label: field('label').value
  };
  CHOICES.forEach(function (id) { config[id] = field(id).value; });
  CHECKS.forEach(function (id) { config[id] = field(id).checked; });
  PATHS.forEach(function (id) {
    const value = field(id).value.trim();
    config[id] = value ? value : null;
  });
  // **「入れるか」は送らない**（設計書6.65.15の段C）。並びが正なので、
  // 送ると作者が手で書いた「入れるか」の値を塗り替えてしまう
  config.characterPage = { showIcons: field('characterPageIcons').checked };
  // 書体は空欄なら null（同梱しない）。**空文字を送らない**——
  // 拡張機能側の検証は「書いてあるが読めない場所」として叱ってしまう
  const fonts = {};
  Object.keys(FONT_FIELDS).forEach(function (id) {
    const value = field(id).value.trim();
    fonts[FONT_FIELDS[id]] = value ? value : null;
  });
  config.fonts = fonts;
  SIDES.forEach(function (side) {
    config[LAYOUT_KEYS[side]] = readLayout(side);
  });
  // **場所を書く前の挿絵は、設計図へ載せない。** 絵の無い挿絵は
  // 受け取ってもらえないので、書き終わるまで欄の中だけで待たせる
  config.illustrations = illustrations
    .filter(function (item) { return (item.imagePath || '').trim(); })
    .map(function (item) {
      return {
        episodePath: item.episodePath,
        afterParagraph: item.afterParagraph,
        imagePath: item.imagePath.trim(),
        caption: (item.caption || '').trim()
      };
    });
  config.pageBreaks = pageBreaks.map(function (item) {
    return {
      episodePath: item.episodePath,
      afterParagraph: item.afterParagraph
    };
  });
  return config;
}

/**
 * 欄を変えたら、少し待ってから拡張機能へ渡す。
 * 1文字ごとに組み直すと、題名を打つあいだ画面がちらつく。
 */
function scheduleChange() {
  if (sending) clearTimeout(sending);
  sending = setTimeout(function () {
    sending = null;
    post('change', { config: readForm() });
  }, 200);
}

TEXTS.concat(PATHS).concat(Object.keys(FONT_FIELDS)).forEach(function (id) {
  field(id).addEventListener('input', scheduleChange);
});
CHOICES.concat(CHECKS).concat(['characterPageIcons']).forEach(function (id) {
  field(id).addEventListener('change', scheduleChange);
});
SIDES.forEach(function (side) {
  ELEMENTS.forEach(function (key) {
    ['visible', 'anchor', 'size', 'color', 'colorPick', 'vertical']
      .forEach(function (part) {
        field(styleId(side, key, part)).addEventListener('change', scheduleChange);
      });
  });
  ['color', 'colorPick'].forEach(function (part) {
    field(styleId(side, 'frameBackground', part))
      .addEventListener('change', scheduleChange);
  });
});
['blockImagePath', 'blockCaption'].forEach(function (id) {
  field(id).addEventListener('change', sendBlockEdit);
});

/*
 * ドラッグでの並べ替え（設計書6.65.15の段D。作者の指定）。
 *
 * 受け取り手は**並びの箱そのもの**に付ける。行ごとに付けると、いちばん下の
 * 行より下（＝末尾へ落とす）で離したときに誰も受け取らない。
 *
 * **箱の外では preventDefault をしない**ので、枠の外で離しても drop は
 * 起きない＝知らせも送らない＝並びは変わらない。
 */
field('blockList').addEventListener('dragover', function (event) {
  if (dragFrom < 0) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  markDropSlot(dropSlotAt(event.clientY));
});
field('blockList').addEventListener('dragleave', function (event) {
  // 行から行へ移るときにも起きる。**箱そのものから出たときだけ**消す
  // （毎回消すと、線が点滅して行き先が読めない）
  const host = field('blockList');
  if (event.relatedTarget && host.contains(event.relatedTarget)) return;
  markDropSlot(-1);
});
field('blockList').addEventListener('drop', function (event) {
  if (dragFrom < 0) return;
  event.preventDefault();
  const from = dragFrom;
  const before = dropSlotAt(event.clientY);
  clearDrag();
  // **並びの計算は拡張機能側**（dropBookBlock）。同じ場所・範囲の外なら
  // 向こうで何も起きない——画面が並びを組み替えることはしない
  post('dropBlock', { from: from, before: before, config: readForm() });
});

/** 本全体の設定は、並びの外の1画面（作者の指定、段D） */
field('railBook').addEventListener('click', selectBookScreen);

/* メニューは、外を押しても Esc でも閉じる（自前なので自分で閉じる） */
document.addEventListener('click', function (event) {
  const menu = field('blockMenu');
  if (menu.hidden) return;
  if (!menu.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  closeMenu();
  // ドラッグ中のEscは、掴んでいる印を消すだけ（並びは変えない）
  clearDrag();
});
window.addEventListener('scroll', closeMenu, true);

field('save').addEventListener('click', function () {
  post('save', { config: readForm() });
});
field('export').addEventListener('click', function () {
  post('export', { config: readForm() });
});
/* あとがきの原稿を開く。作るのも開くのも拡張機能側の仕事（場所を画面で組み立てない） */
field('openAfterword').addEventListener('click', function () {
  post('openAfterword', { config: readForm() });
});
field('bakeFront').addEventListener('click', function () { bake('front'); });
field('bakeBack').addEventListener('click', function () { bake('back'); });
// 消すのは拡張機能側の仕事（場所を画面で組み立てない）
field('unbakeFront').addEventListener('click', function () {
  post('unbake', { side: 'front', config: readForm() });
});
field('unbakeBack').addEventListener('click', function () {
  post('unbake', { side: 'back', config: readForm() });
});

function setStatus(text, isError) {
  const status = field('status');
  status.textContent = text || '';
  status.className = isError ? 'error' : '';
}

/* ---- 合成 ---------------------------------------------------------- */

/** 読み終えた元絵。面を組み直しても捨てないよう、外に持つ */
const images = { front: null, back: null };
/** いま読んでいる元絵の在りか。変わったときだけ読み直す */
const sources = { front: null, back: null };
/** 拡張機能から中身を貰って読んだか（貰い直しの無限往復を止める） */
const fromData = { front: false, back: false };
/** 押されたまま待っている合成 */
const pending = { front: false, back: false };

/** 字の大きさは、絵の短い辺からの割合で決める（寸法が作品ごとに違うため） */
const SIZE_RATIO = { large: 0.1, medium: 0.065, small: 0.045 };
/**
 * 合成の面の枠（設計書6.65.15の3、2026-09-03に作者の指示で4:3から変更）。
 *
 * **横1：縦1.4に固定する。** 一般的な書籍の判型に近い縦長の比率。
 * プレビューも焼きも、この枠を前提に組む——別々の比率で持つと、
 * 見えているものと焼けたものがずれる（6.65.6が禁じている「2つ持つ」と同じ形）。
 */
const FRAME_RATIO = 1.4;
/** 焼くPNGの長辺の上限。大きすぎると受け取り側で断られる */
const MAX_EDGE = 2400;
/** 枠の寸法。長辺（縦）を上限に合わせ、横をそこから割り出す */
const FRAME_WIDTH = Math.round(MAX_EDGE / FRAME_RATIO);
const FRAME_HEIGHT = MAX_EDGE;
const FONT_STACK = '"Yu Mincho", "游明朝", "Hiragino Mincho ProN", serif';

function loadImage(side, src, retried) {
  const image = new Image();
  // 別の在りかから読んだ絵は canvas を汚し、読み出せなくなる。
  // これを付けておくと、汚れる代わりに読み込みが失敗してくれる
  if (!retried) image.crossOrigin = 'anonymous';
  image.onload = function () {
    images[side] = image;
    fromData[side] = retried === true;
    drawCover(side);
    if (pending[side]) {
      pending[side] = false;
      bake(side);
    }
  };
  image.onerror = function () {
    images[side] = null;
    // 読めない理由は「無い」か「別の在りかだから拒まれた」。
    // どちらも、拡張機能に中身そのものを貰えば解ける
    if (!retried) post('imageData', { side: side, config: readForm() });
    else pending[side] = false;
  };
  image.src = src;
}

/**
 * 合成の面を描く（設計書6.65.15の3）。
 *
 * **canvasの大きさは、常に横1：縦1.4の枠で固定する。** 元イラストの
 * 寸法をそのまま使っていたので、比率の違う絵がそのまま面いっぱいの形に
 * なっていた。ここからは、枠の中へ**はみ出させず縮めて中央に納め**、
 * 余った部分を frameBackground の色で塗る（作者の色選びの既定は黒）。
 */
function drawCover(side) {
  const canvas = document.getElementById('canvas-' + side);
  if (!canvas) return;
  const image = images[side];
  if (!image) return;

  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = frameBackgroundOf(side);
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const scale = Math.min(
    canvas.width / (image.naturalWidth || 1),
    canvas.height / (image.naturalHeight || 1)
  );
  const drawWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const drawHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const offsetX = Math.round((canvas.width - drawWidth) / 2);
  const offsetY = Math.round((canvas.height - drawHeight) / 2);
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);

  drawTexts(ctx, canvas, readLayout(side));
}

/**
 * 文字を重ねる。置き場所は9つのプリセットで、座標は持たない。
 * 同じ場所に2つ置かれたら、重ねずに順にずらす。
 */
function drawTexts(ctx, canvas, layout) {
  const base = Math.min(canvas.width, canvas.height);
  const margin = base * 0.07;
  const used = {};

  ELEMENTS.forEach(function (key) {
    const style = layout[key];
    if (!style || !style.visible) return;
    const text = field(ELEMENT_FIELDS[key]).value.trim();
    if (!text) return;

    const fontSize = base * (SIZE_RATIO[style.size] || SIZE_RATIO.medium);
    ctx.font = fontSize + 'px ' + FONT_STACK;
    ctx.fillStyle = style.color;

    const chars = Array.from(text);
    const blockW = style.vertical ? fontSize * 1.2 : ctx.measureText(text).width;
    const blockH = style.vertical ? chars.length * fontSize * 1.05 : fontSize * 1.2;

    const parts = String(style.anchor || 'top-center').split('-');
    const row = parts[0];
    const column = parts[1];

    let x = column === 'left'
      ? margin
      : (column === 'right' ? canvas.width - margin - blockW : (canvas.width - blockW) / 2);
    let y = row === 'top'
      ? margin
      : (row === 'bottom' ? canvas.height - margin - blockH : (canvas.height - blockH) / 2);

    const slot = style.anchor + (style.vertical ? '|v' : '|h');
    const offset = used[slot] || 0;
    // 縦は左へ、横は下へ（下寄せのときだけ上へ）逃がす
    if (style.vertical) x += column === 'left' ? offset : -offset;
    else y += row === 'bottom' ? -offset : offset;
    used[slot] = offset + (style.vertical ? blockW * 1.15 : blockH * 1.15);

    ctx.textBaseline = 'top';
    if (style.vertical) {
      ctx.textAlign = 'center';
      chars.forEach(function (character, index) {
        ctx.fillText(character, x + blockW / 2, y + index * fontSize * 1.05);
      });
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(text, x, y);
    }
  });
}

function bake(side) {
  const canvas = document.getElementById('canvas-' + side);
  if (!canvas) return;
  if (!images[side]) {
    // 元絵をまだ読めていない。読めたら続きをやる
    pending[side] = true;
    if (sources[side]) loadImage(side, sources[side], false);
    return;
  }

  drawCover(side);
  let dataUrl = null;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (error) {
    // 汚れた canvas は読み出せない。中身を貰って描き直してから焼く
    if (!fromData[side]) {
      pending[side] = true;
      post('imageData', { side: side, config: readForm() });
    } else {
      post('bakeFailed', { side: side, config: readForm() });
    }
    return;
  }
  post('bake', { side: side, dataUrl: dataUrl, config: readForm() });
}

function applyCompose(data) {
  SIDES.forEach(function (side) {
    const info = (data.compose || {})[side] || {};
    field(side + '-compose').hidden = info.enabled !== true;
    field(side + '-bake-note').textContent = info.reason || '';

    // 焼いた画像があるときだけ、その注記と「消す」を出す。
    // 中身の言葉は拡張機能側が持つ（画面では組み立てない）
    const baked = info.baked || null;
    field(side + '-baked-note').textContent = baked ? baked.note : '';
    field(side + '-baked-actions').hidden = !baked;

    const source = info.uri || null;
    if (source === sources[side]) return;
    sources[side] = source;
    images[side] = null;
    fromData[side] = false;
    pending[side] = false;
    if (source) loadImage(side, source, false);
  });
}

/* ---- 面を出す ------------------------------------------------------ */

/**
 * 選んだ面のプレビューを出す。
 *
 * **中身は拡張機能側で組んだ断片をそのまま置く。** 書き出しと同じものを
 * 見せるのが要件なので、ここで組み立て直さない（設計書6.65.6）。
 * 合成の面だけは canvas を置き、焼くときと同じ関数で描く。
 */
function renderPages() {
  const host = field('pages');
  host.textContent = '';

  const shown = pages.filter(function (page) {
    return page.blockIndex === selected;
  });

  if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    // 出ない理由は上の警告と面の注記が言う。ここは「出ない」ことだけ
    empty.textContent = 'この面は、いまのままでは本に入りません。';
    host.appendChild(empty);
    return;
  }

  shown.forEach(function (page) {
    const frame = document.createElement('div');
    frame.className = 'page-frame';

    const caption = document.createElement('div');
    caption.className = 'page-label';
    // 保留の面は見えるが、本には入らない（設計書6.65.15の段D）。
    // **見ているものが本に入らないことを、その場で言う。**
    // 添える言葉はここに書いた定文（記号を含まない）なので、
    // エスケープを通すのは拡張機能側から届く見出しだけでよい
    caption.innerHTML = escapeHtml(page.label)
      + (page.suspended ? '（保留中：本には入りません）' : '');
    frame.appendChild(caption);

    const sheet = document.createElement('div');
    sheet.className = 'epub-page ' + (page.vertical ? 'vertical' : 'horizontal');
    if (page.compose) {
      const canvas = document.createElement('canvas');
      canvas.id = 'canvas-' + page.compose;
      canvas.className = 'cover-canvas';
      sheet.appendChild(canvas);
    } else {
      sheet.innerHTML = page.html;
    }
    frame.appendChild(sheet);

    if (page.note) {
      const note = document.createElement('div');
      note.className = 'page-note';
      note.innerHTML = escapeHtml(page.note);
      frame.appendChild(note);
    }

    host.appendChild(frame);
    // 縦組みは右端から始まる。左端のまま見せると、本文が無いように見える
    if (page.vertical && !page.compose) sheet.scrollLeft = sheet.scrollWidth;
  });

  SIDES.forEach(drawCover);
}

/** 面の並びとプレビューを受け取る。選びは拡張機能が言うときだけ動かす */
function applyPages(data) {
  const style = field('book-style');
  if (typeof data.css === 'string') style.textContent = data.css;
  pages = data.pages || [];
  blocks = data.blocks || [];
  insertTypes = data.insertTypes || [];

  if (typeof data.selectBlock === 'number') {
    selected = data.selectBlock;
    // 挿した・動かした面をそのまま編めるよう、その面の画面へ移る
    currentScreen = 'block';
  }
  if (selected >= blocks.length) selected = blocks.length - 1;
  if (selected < 0) selected = 0;

  renderBlocks();
  renderScreen();
  renderPages();
  field('notice').textContent = data.notice || '';
}

window.addEventListener('message', function (event) {
  const message = event.data;
  if (!message) return;
  if (message.type === 'book') {
    const data = message.data;
    field('title').textContent = data.title;
    field('filePath').textContent = data.filePath;
    fillForm(data.config);
    fillOutline(data.outline);
    applyCompose(data);
    applyWarnings(data);
    applyPages(data);
    setStatus(data.dirty ? '未保存の変更があります' : '', false);
    return;
  }
  if (message.type === 'preview') {
    fillOutline(message.data.outline);
    applyCompose(message.data);
    applyWarnings(message.data);
    applyPages(message.data);
    setStatus(message.data.dirty ? '未保存の変更があります' : '', false);
    return;
  }
  if (message.type === 'paragraphs') {
    // 選び直したあとに古い返事が届くことがある。**いまの話のものだけ**採る
    if (message.episodePath !== episodePath) return;
    paragraphs = message.items || [];
    field('placementNotice').textContent = message.notice || '';
    renderParagraphs();
    return;
  }
  if (message.type === 'imageData') {
    const side = message.side;
    if (SIDES.indexOf(side) < 0) return;
    if (!message.dataUrl) {
      pending[side] = false;
      return;
    }
    loadImage(side, message.dataUrl, true);
    return;
  }
  if (message.type === 'status') {
    setStatus(message.text, message.isError === true);
  }
});

post('ready');
</script>
</body>
</html>`;
}
