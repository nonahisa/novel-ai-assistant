/**
 * EPUBエディターの画面（設計書6.65.6・6.65.8）。
 *
 * 左に設定の欄、右にプレビュー。**本の面の中身は組み立てない。**
 * 面のXHTML断片と本のCSSは拡張機能側（`core/epubPackage.ts`）が作り、
 * ここは受け取って並べるだけである。画面で組み直した時点で、
 * 「見た目どおりに編集できる」という要件が壊れる。
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
 * 表紙・裏表紙1面ぶんの欄。
 *
 * **元イラストが無いときは、この塊ごと畳んで理由を出す**（`hidden`）。
 * 消してしまうと「なぜ合成の欄が無いのか」が分からない
 * （`processAvailability.ts` と同じ流儀）。
 */
function coverSection(
  side: string,
  heading: string,
  pathFieldId: string,
  pathLabel: string,
  bakeButtonId: string,
  bakeLabel: string
): string {
  return [
    `    <h2>${heading}</h2>`,
    `    <label><span>${pathLabel}</span><input id="${pathFieldId}" type="text"></label>`,
    `    <p class="note" id="${side}-bake-note"></p>`,
    `    <div id="${side}-compose">`,
    ...COVER_ELEMENTS.map((element) =>
      coverElementRow(side, element.key, element.label)
    ),
    `      <div class="cover-actions"><button id="${bakeButtonId}">${bakeLabel}</button></div>`,
    "    </div>",
  ].join("\n");
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
      content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
#form { width: 360px; flex: none; }
#preview { flex: 1; min-width: 0; }
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
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
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
  <section id="form">
    <h2>書誌情報</h2>
    <label><span>題名</span><input id="bookTitle" type="text"></label>
    <label><span>作者名</span><input id="author" type="text"></label>
    <label><span>イラストレーター名</span><input id="illustrator" type="text"></label>
    <label><span>レーベル名</span><input id="label" type="text"></label>

    <h2>組み方</h2>
    <label><span>綴じ方向</span><select id="writingMode">
      <option value="vertical">縦書き（右から左へ開く）</option>
      <option value="horizontal">横書き（左から右へ開く）</option>
    </select></label>
    <label class="check"><input id="collapseBlankLines" type="checkbox"><span>続いた空行を1つ減らす</span></label>

    <h2>目次</h2>
    <label class="check"><input id="tocEnabled" type="checkbox"><span>読み物としての目次ページを入れる</span></label>
    <label><span>並べ方</span><select id="tocPattern">
      <option value="vertical">一覧（本文と同じ流れ）</option>
      <option value="horizontal">一覧（目次だけ横組み）</option>
      <option value="chapters">章ごとに区切る</option>
    </select></label>
    <label><span>飾り</span><select id="tocOrnament">
      <option value="none">なし</option>
      <option value="rule">罫線</option>
      <option value="center">中央飾り</option>
    </select></label>

    <h2>奥付</h2>
    <label><span>飾り</span><select id="colophonOrnament">
      <option value="none">なし</option>
      <option value="rule">罫線</option>
      <option value="center">中央飾り</option>
    </select></label>

${coverSection(
  "front",
  "表紙",
  "coverImagePath",
  "元イラストの場所（作品フォルダからの相対パス）",
  "bakeFront",
  "表紙を焼く"
)}

${coverSection(
  "back",
  "裏表紙",
  "backCoverImagePath",
  "元イラストの場所（作品フォルダからの相対パス）",
  "bakeBack",
  "裏表紙を焼く"
)}

    <h2>挿絵とページ分割</h2>
    <label><span>話</span><select id="episodeSelect"></select></label>
    <p class="note" id="placementNotice"></p>
    <p class="note error" id="placementWarnings"></p>
    <div id="paragraphList"></div>

    <p class="note" id="filePath"></p>
  </section>
  <section id="preview">
    <p class="note" id="notice"></p>
    <div id="pages"></div>
  </section>
</main>
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
const CHOICES = ['writingMode', 'tocPattern', 'tocOrnament', 'colophonOrnament'];
const CHECKS = ['collapseBlankLines', 'tocEnabled'];
const PATHS = ['coverImagePath', 'backCoverImagePath'];

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
const PATH_KEYS = { front: 'coverImagePath', back: 'backCoverImagePath' };

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
  return layout;
}

/* ---- 挿絵とページ分割（設計書6.65.10） ----------------------------- */

/**
 * 設計図の指定の写し。**話を選び直しても消えない**ように外に持つ。
 * 画像の場所を書く前の挿絵もここには残る（設計図へは載せない）。
 */
let illustrations = [];
let pageBreaks = [];
/** いま選んでいる話と、その段落の冒頭（拡張機能から貰う） */
let episodePath = '';
let paragraphs = [];

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

/** 話の一覧。選んでいた話が残っていればそのまま、無ければ先頭にする */
function fillEpisodes(list) {
  const select = field('episodeSelect');
  const previous = episodePath;
  const episodes = list || [];
  select.textContent = '';

  let found = false;
  episodes.forEach(function (episode) {
    const option = document.createElement('option');
    option.value = episode.path;
    option.textContent = episode.label;
    select.appendChild(option);
    if (episode.path === previous) found = true;
  });

  episodePath = found ? previous : (episodes[0] ? episodes[0].path : '');
  select.value = episodePath;
  paragraphs = [];
  renderParagraphs();
  if (episodePath) post('episode', { episodePath: episodePath });
}

function applyWarnings(data) {
  field('placementWarnings').textContent =
    (data.placementWarnings || []).join('\\n');
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

TEXTS.concat(PATHS).forEach(function (id) {
  field(id).addEventListener('input', scheduleChange);
});
CHOICES.concat(CHECKS).forEach(function (id) {
  field(id).addEventListener('change', scheduleChange);
});
SIDES.forEach(function (side) {
  ELEMENTS.forEach(function (key) {
    ['visible', 'anchor', 'size', 'color', 'colorPick', 'vertical']
      .forEach(function (part) {
        field(styleId(side, key, part)).addEventListener('change', scheduleChange);
      });
  });
});

field('save').addEventListener('click', function () {
  post('save', { config: readForm() });
});
field('export').addEventListener('click', function () {
  post('export', { config: readForm() });
});
field('bakeFront').addEventListener('click', function () { bake('front'); });
field('bakeBack').addEventListener('click', function () { bake('back'); });
field('episodeSelect').addEventListener('change', function () {
  episodePath = field('episodeSelect').value;
  // 段落は話ごとに違う。貰い直すまでは空にしておく（前の話の段落へ
  // 挿絵を付けてしまわないため）
  paragraphs = [];
  renderParagraphs();
  post('episode', { episodePath: episodePath });
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
/** 焼くPNGの上限。大きすぎると受け取り側で断られる */
const MAX_EDGE = 2400;
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

function drawCover(side) {
  const canvas = document.getElementById('canvas-' + side);
  if (!canvas) return;
  const image = images[side];
  if (!image) return;

  const longest = Math.max(image.naturalWidth, image.naturalHeight) || 1;
  const scale = Math.min(1, MAX_EDGE / longest);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
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

    const source = info.uri || null;
    if (source === sources[side]) return;
    sources[side] = source;
    images[side] = null;
    fromData[side] = false;
    pending[side] = false;
    if (source) loadImage(side, source, false);
  });
}

/* ---- 面を並べる ---------------------------------------------------- */

/**
 * 面を並べる。
 *
 * **中身は拡張機能側で組んだ断片をそのまま置く。** 書き出しと同じものを
 * 見せるのが要件なので、ここで組み立て直さない（設計書6.65.6）。
 * 合成の面だけは canvas を置き、焼くときと同じ関数で描く。
 */
function renderPages(data) {
  const host = field('pages');
  host.textContent = '';
  const style = field('book-style');
  if (typeof data.css === 'string') style.textContent = data.css;

  (data.pages || []).forEach(function (page) {
    const frame = document.createElement('div');
    frame.className = 'page-frame';

    const caption = document.createElement('div');
    caption.className = 'page-label';
    caption.innerHTML = escapeHtml(page.label);
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
    fillEpisodes(data.episodes);
    applyCompose(data);
    applyWarnings(data);
    renderPages(data);
    setStatus(data.dirty ? '未保存の変更があります' : '', false);
    return;
  }
  if (message.type === 'preview') {
    applyCompose(message.data);
    applyWarnings(message.data);
    renderPages(message.data);
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
