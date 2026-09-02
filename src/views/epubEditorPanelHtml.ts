/**
 * EPUBエディターの画面（設計書6.65.6）。
 *
 * 左に設定の欄、右にプレビュー。**プレビューの中身は組み立てない。**
 * 面のXHTML断片と本のCSSは拡張機能側（`core/epubPackage.ts`）が作り、
 * ここは受け取って並べるだけである。画面で組み直した時点で、
 * 「見た目どおりに編集できる」という要件が壊れる。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （題名の引用符で画面が壊れるのを防ぐ。ほかのパネルと同じ）。
 */
export function buildEpubEditorPanelHtml(
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
#form { width: 320px; flex: none; }
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
    <label class="check"><input id="collapseBlankLines" type="checkbox">続いた空行を1つ減らす</label>

    <h2>目次</h2>
    <label class="check"><input id="tocEnabled" type="checkbox">読み物としての目次ページを入れる</label>
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

function fillForm(config) {
  field('bookTitle').value = config.title || '';
  field('author').value = config.author || '';
  field('illustrator').value = config.illustrator || '';
  field('label').value = config.label || '';
  CHOICES.forEach(function (id) { field(id).value = config[id]; });
  CHECKS.forEach(function (id) { field(id).checked = config[id] === true; });
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

TEXTS.forEach(function (id) {
  field(id).addEventListener('input', scheduleChange);
});
CHOICES.concat(CHECKS).forEach(function (id) {
  field(id).addEventListener('change', scheduleChange);
});

field('save').addEventListener('click', function () {
  post('save', { config: readForm() });
});
field('export').addEventListener('click', function () {
  post('export', { config: readForm() });
});

function setStatus(text, isError) {
  const status = field('status');
  status.textContent = text || '';
  status.className = isError ? 'error' : '';
}

/**
 * 面を並べる。
 *
 * **中身は拡張機能側で組んだ断片をそのまま置く。** 書き出しと同じものを
 * 見せるのが要件なので、ここで組み立て直さない（設計書6.65.6）。
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
    sheet.innerHTML = page.html;
    frame.appendChild(sheet);

    if (page.note) {
      const note = document.createElement('div');
      note.className = 'page-note';
      note.innerHTML = escapeHtml(page.note);
      frame.appendChild(note);
    }

    host.appendChild(frame);
    // 縦組みは右端から始まる。左端のまま見せると、本文が無いように見える
    if (page.vertical) sheet.scrollLeft = sheet.scrollWidth;
  });

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
    renderPages(data);
    setStatus(data.dirty ? '未保存の変更があります' : '', false);
    return;
  }
  if (message.type === 'preview') {
    renderPages(message.data);
    setStatus(message.data.dirty ? '未保存の変更があります' : '', false);
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
