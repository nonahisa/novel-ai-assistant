/**
 * 相談パネルの中身。
 *
 * 作者の要望は「Claude Code for VS Code のように、自然文で質問でき、
 * 選択肢を押して進められる画面」だった。そのため次の3つを揃える。
 *
 * 1. 縦に伸びる会話ログ
 * 2. **番号付きの選択肢**。押しても、番号を打っても選べる
 * 3. 選択肢とは別に、いつでも使える自由入力
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （作品名や本文の引用符で画面が壊れるのを防ぐ）。
 *
 * ## 同じ画面を2か所へ出す（作者の要望、2026-08-28）
 *
 * 「メニューのAI相談を大きいパネルにして」「本文領域に大きく表示できる
 * ようにすること。現在の領域は残してください」。そこで**画面の組み立ては
 * 1つのまま**にして、`large` で見た目だけを変える。2つ書くと、
 * 片方だけ直したときに「横では出るのに大きい画面では出ない」が起きる。
 *
 * `large` のときだけツールバー（作品を選ぶ・会話をメモに保存・できること）を
 * 出す。横の狭いパネルに同じものを置くと、肝心の会話が押し出される。
 */
/**
 * 大きく開いたときだけ出すツールバー。
 *
 * **「できること」は畳んでおく。** 21個の札を最初から広げると、
 * 会話の場が下へ押し出される。中身は拡張機能側から届いたものを
 * その都度作り直すので、ここには入れ物だけを置く。
 */
const TOOLBAR_HTML = `<div id="toolbar">
  <div class="row">
    <button class="action secondary" id="choose-work">作品を選ぶ</button>
    <button class="action secondary" id="save-note">会話をメモに保存</button>
    <button class="action secondary" id="open-manual">使い方を開く</button>
  </div>
  <details>
    <summary>できること</summary>
    <div id="quickrun-list"></div>
  </details>
</div>`;

export function buildWorkChatPanelHtml(
  nonce: string,
  cspSource: string,
  options: { large?: boolean } = {}
): string {
  const large = options.large === true;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AIに相談</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  display: flex;
  flex-direction: column;
  height: 100vh;
}
#context {
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}
#context .what { color: var(--vscode-foreground); }
#context .paid { color: var(--vscode-editorWarning-foreground, #cca700); }
#log { flex: 1; overflow-y: auto; padding: 10px; }
.turn { margin-bottom: 14px; }
.turn .who {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 3px;
}
.turn .body { white-space: pre-wrap; line-height: 1.7; word-break: break-word; }
.turn.author .body {
  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
  border-left: 2px solid var(--vscode-focusBorder);
  padding: 6px 8px;
  border-radius: 2px;
}
.turn.error .body { color: var(--vscode-errorForeground); }
/*
 * 独り言。**聞かれてもいないのに出るもの**なので、
 * 答えと同じ見た目にしない。控えめな字にして左に線を引き、
 * 読み飛ばせるようにする。
 */
.turn.chatter .body {
  color: var(--vscode-descriptionForeground);
  border-left: 2px solid var(--vscode-descriptionForeground);
  padding: 2px 0 2px 8px;
  font-size: 12px;
}
.options { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.option {
  display: flex;
  gap: 8px;
  align-items: baseline;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  line-height: 1.5;
}
.option:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
}
.option:disabled { opacity: 0.5; cursor: default; }
.option .num {
  flex: 0 0 auto;
  min-width: 16px;
  color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums;
}
#thinking { padding: 0 10px 10px; color: var(--vscode-descriptionForeground); font-size: 12px; }
#composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 10px; }
/* この画面の入力欄は相談の入力だけ。増えたらここへ足す */
textarea {
  width: 100%;
  resize: vertical;
  min-height: 54px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  /* 角を丸くする（作者の依頼、2026-08-28。入力欄すべて） */
  border-radius: 4px;
}
textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
#composer .row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
#composer .hint {
  flex: 1;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
button.action {
  border: none;
  border-radius: 2px;
  padding: 4px 12px;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.action:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.action:disabled { opacity: 0.5; cursor: default; }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
#empty { padding: 16px 10px; color: var(--vscode-descriptionForeground); line-height: 1.8; }
#empty ul { margin: 6px 0 0; padding-left: 18px; }
.note { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.edit {
  margin-top: 8px;
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 3px;
  padding: 8px;
}
.edit .what { font-size: 12px; margin-bottom: 4px; }
.edit .preview {
  white-space: pre-wrap;
  max-height: 160px;
  overflow-y: auto;
  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
  padding: 6px 8px;
  border-radius: 2px;
  line-height: 1.6;
}
.edit .done { color: var(--vscode-testing-iconPassed, #4caf50); font-size: 12px; }
.edit .failed { color: var(--vscode-errorForeground); font-size: 12px; }
/*
 * 本文の領域に大きく開いたとき。
 *
 * **画面いっぱいの幅で文章を流さない。** 横に長い行は目が戻る場所を
 * 見失う。読みやすい幅で中央に寄せ、入力欄も少し高くする
 * （大きく開いたということは、長めに書きたいということである）。
 */
body.large #log > *,
body.large #composer > * {
  max-width: 62em;
  margin-left: auto;
  margin-right: auto;
}
body.large #log { padding: 16px 10px; }
body.large textarea { min-height: 72px; }
#toolbar {
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
#toolbar .row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
#toolbar details { margin-top: 6px; font-size: 12px; }
#toolbar summary {
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
}
#quickrun-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* 一覧の札は横に並べる（.option は縦積みで幅いっぱいになる） */
.quickrun { width: auto; }
</style>
</head>
<body${large ? ` class="large"` : ""}>
<div id="context"><span class="label">相談の対象:</span><span class="what" id="context-what">—</span><span id="context-provider"></span></div>
${large ? TOOLBAR_HTML : ""}
<div id="log">
  <div id="empty">
    作品について、思いついたまま日本語で聞いてください。<br>
    いま開いているファイルを見ながら答えます。
    <ul>
      <li>このテーマの案を3つ出して</li>
      <li>この場面、説明が多すぎない？</li>
      <li>この人物の動機がぼやけている気がする</li>
    </ul>
  </div>
</div>
<div id="thinking" hidden>考えています…</div>
<div id="composer">
  <textarea id="input" placeholder="聞きたいことを書いてください（Ctrl+Enterで送信）"></textarea>
  <div class="row">
    <span class="hint" id="hint"></span>
    <button class="action secondary" id="clear">最初から</button>
    <button class="action" id="send">送る</button>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const logEl = document.getElementById('log');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const clearEl = document.getElementById('clear');
const thinkingEl = document.getElementById('thinking');
const hintEl = document.getElementById('hint');
// ツールバーは大きく開いたときにしか無い。**必ず有無を確かめてから使う**
const chooseWorkEl = document.getElementById('choose-work');
const saveNoteEl = document.getElementById('save-note');
const openManualEl = document.getElementById('open-manual');
const quickRunListEl = document.getElementById('quickrun-list');

/** 直前の返事に付いていた選択肢。番号入力で選べるようにする */
let currentOptions = [];
/** 「できること」に並べる機能。拡張機能側から届く */
let quickRuns = [];
let busy = false;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setBusy(value) {
  busy = value;
  thinkingEl.hidden = !value;
  sendEl.disabled = value;
  document.querySelectorAll('.option').forEach((el) => {
    el.disabled = value;
  });
}

/**
 * ログを空に戻す。
 *
 * 「最初から」を押したときと、もう片方の画面で押されたとき（cleared）の
 * 両方から呼ぶ。**ここでは拡張機能へ送らない。** 受け取った側が送り返すと、
 * 2つの画面のあいだで行ったり来たりする。
 */
function resetLog() {
  logEl.innerHTML = '';
  logEl.appendChild(emptyEl);
  emptyEl.hidden = false;
  currentOptions = [];
  updateHint();
}

/**
 * 「できること」の一覧を作り直す。
 *
 * **一覧は拡張機能側から届いたものだけを出す。** 画面に
 * 書き写すと、機能を足したときに「押しても何も起きない札」が並ぶ。
 * 押した先でも許可した一覧と突き合わせている（AIの提案と同じ関門）。
 */
function renderQuickRuns() {
  if (!quickRunListEl) return;
  quickRunListEl.replaceChildren();
  quickRuns.forEach((run) => {
    const button = document.createElement('button');
    button.className = 'option quickrun';
    // 料金がかかるかどうかは、押す前に見えている必要がある
    button.textContent = run.label + (run.usesAI ? '（AIを使います）' : '');
    button.disabled = busy;
    button.addEventListener('click', () => {
      if (busy) return;
      vscode.postMessage({ type: 'quickRun', kind: run.kind });
    });
    quickRunListEl.appendChild(button);
  });
}

/**
 * 1回ぶんの発言を足す。
 *
 * AIはMarkdownで返してくる。**記号のまま見せない。**
 * 「**強調**」がそのまま星印として並ぶと読みにくい。
 * 整形済みのHTML（html）が来ていればそれを使い、
 * 無ければ（作者の発言など）記号を落として素の文として出す。
 */
function appendTurn(who, text, kind, html) {
  emptyEl.hidden = true;
  const turn = document.createElement('div');
  turn.className = 'turn ' + (kind || '');
  turn.innerHTML =
    '<div class="who">' + escapeHtml(who) + '</div>' +
    '<div class="body">' + (html || escapeHtml(text)) + '</div>';
  logEl.appendChild(turn);
  return turn;
}

function appendOptions(turn, options) {
  currentOptions = options;
  if (options.length === 0) return;

  const box = document.createElement('div');
  box.className = 'options';
  options.forEach((option, index) => {
    const button = document.createElement('button');
    button.className = 'option';
    button.innerHTML =
      '<span class="num">' + (index + 1) + '</span>' +
      '<span>' + escapeHtml(option) + '</span>';
    button.addEventListener('click', () => {
      if (busy) return;
      send(option);
    });
    box.appendChild(button);
  });
  turn.appendChild(box);
  updateHint();
}

/**
 * 書き込みの提案を出す。
 *
 * **押すまで何も起きない。** 何をどこへ書くかと、書く中身を先に見せる。
 * 中身を見ずに押せる作りにすると、作者は自分の文書に何が入るのか
 * 分からないまま同意することになる。
 */
function appendEdit(turn, edit) {
  const box = document.createElement('div');
  box.className = 'edit';

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = edit.label;
  box.appendChild(what);

  const preview = document.createElement('div');
  preview.className = 'preview';
  preview.textContent = edit.preview;
  box.appendChild(preview);

  const row = document.createElement('div');
  row.className = 'options';
  const apply = document.createElement('button');
  apply.className = 'option';
  apply.innerHTML = '<span class="num">✓</span><span>' + escapeHtml(edit.label) + '</span>';
  apply.addEventListener('click', () => {
    if (busy) return;
    apply.disabled = true;
    vscode.postMessage({ type: 'applyEdit', id: edit.id });
  });
  row.appendChild(apply);
  box.appendChild(row);

  box.dataset.editId = edit.id;
  turn.appendChild(box);
}

/**
 * 標準機能の起動を勧める。
 *
 * **押すまで動かない。** AIを呼ぶ機能は料金がかかるので、
 * 押す前にそれが分かるようにする。
 */
function appendRun(turn, run) {
  const box = document.createElement('div');
  box.className = 'edit';
  box.dataset.editId = run.id;

  const row = document.createElement('div');
  row.className = 'options';
  const button = document.createElement('button');
  button.className = 'option';
  button.innerHTML =
    '<span class="num">▶</span><span>' +
    escapeHtml(run.label) +
    (run.usesAI ? '（AIを使います）' : '（AIを使いません）') +
    '</span>';
  button.addEventListener('click', () => {
    if (busy) return;
    button.disabled = true;
    vscode.postMessage({ type: 'run', id: run.id });
  });
  row.appendChild(button);
  box.appendChild(row);
  turn.appendChild(box);
}

/**
 * 「AIで再読込」を勧める（設計書6.31.3）。
 *
 * **押すまで何も起きない。** 書き込みの提案と同じ作法で、どの記録を
 * どんな留意点で読み直すのかを先に見せる。読み直した結果もそのまま
 * 保存されるわけではなく、設定資料の画面に項目ごとの提案として並ぶ。
 */
function appendReload(turn, reload) {
  const box = document.createElement('div');
  box.className = 'edit';
  box.dataset.editId = reload.id;

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = reload.kindLabel + '「' + reload.name + '」を本文から読み直します';
  box.appendChild(what);

  // 留意点は、押す前に読めるようにする。何を申し送るのか見えないまま
  // 押すと、出てきた提案の理由が分からない
  if (reload.notes) {
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.textContent = '留意点: ' + reload.notes;
    box.appendChild(preview);
  }

  const row = document.createElement('div');
  row.className = 'options';
  const button = document.createElement('button');
  button.className = 'option';
  button.innerHTML =
    '<span class="num">↻</span><span>' +
    escapeHtml(reload.label) +
    '（AIを使います）</span>';
  button.addEventListener('click', () => {
    if (busy) return;
    button.disabled = true;
    vscode.postMessage({ type: 'reload', id: reload.id });
  });
  row.appendChild(button);
  box.appendChild(row);
  turn.appendChild(box);
}

/** 「そこを見せて」。押すとファイルを開き、該当箇所を光らせる */
function appendLocate(turn, locate) {
  const box = document.createElement('div');
  box.className = 'edit';
  box.dataset.editId = locate.id;

  const row = document.createElement('div');
  row.className = 'options';
  const button = document.createElement('button');
  button.className = 'option';
  button.innerHTML =
    '<span class="num">◎</span><span>' + escapeHtml(locate.label) + '</span>';
  button.addEventListener('click', () => {
    vscode.postMessage({ type: 'locate', id: locate.id });
  });
  row.appendChild(button);
  box.appendChild(row);
  turn.appendChild(box);
}

function markEdit(id, message, ok) {
  const box = document.querySelector('[data-edit-id="' + id + '"]');
  if (!box) return;
  box.querySelectorAll('.options').forEach((el) => el.remove());
  const line = document.createElement('div');
  line.className = ok ? 'done' : 'failed';
  line.textContent = message;
  box.appendChild(line);
}

function updateHint() {
  hintEl.textContent =
    currentOptions.length > 0
      ? '番号（1〜' + currentOptions.length + '）を打って選ぶこともできます'
      : '';
}

function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
}

function send(question) {
  if (busy) return;
  const text = question.trim();
  if (!text) return;

  appendTurn('あなた', text, 'author');
  // 選択肢は一度使ったら消す。古い選択肢が残ると、
  // どの返事に対する選択なのか分からなくなる
  document.querySelectorAll('.options').forEach((el) => el.remove());
  currentOptions = [];
  updateHint();
  scrollToBottom();

  inputEl.value = '';
  setBusy(true);
  vscode.postMessage({ type: 'ask', question: text });
}

sendEl.addEventListener('click', () => send(inputEl.value));

clearEl.addEventListener('click', () => {
  if (busy) return;
  resetLog();
  vscode.postMessage({ type: 'clear' });
});

// ツールバーは大きく開いたときにしか無い
if (chooseWorkEl) {
  chooseWorkEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'chooseWork' });
  });
}
if (saveNoteEl) {
  saveNoteEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveNote' });
  });
}
if (openManualEl) {
  openManualEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'openManual' });
  });
}

inputEl.addEventListener('keydown', (event) => {
  // Ctrl+Enter で送る。Enterだけだと改行が打てない
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send(inputEl.value);
    return;
  }
  // 番号だけを打って選択肢を選ぶ。入力欄が空のときだけ効かせる
  if (
    currentOptions.length > 0 &&
    !busy &&
    inputEl.value === '' &&
    /^[1-9]$/.test(event.key)
  ) {
    const index = Number(event.key) - 1;
    if (index < currentOptions.length) {
      event.preventDefault();
      send(currentOptions[index]);
    }
  }
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'context') {
    document.getElementById('context-what').textContent = message.label;
    const providerEl = document.getElementById('context-provider');
    // 有料かどうかは、送る前に常に見えている必要がある
    providerEl.textContent = message.provider
      ? '／ ' + message.provider + (message.paid ? '（有料・送るたびに課金）' : '')
      : '';
    providerEl.className = message.paid ? 'paid' : '';
    // 起動できる機能は、届くたびに作り直す（機能が増減しても写しが残らない）
    quickRuns = message.quickRuns || [];
    renderQuickRuns();
    return;
  }
  if (message.type === 'history') {
    // 後から開いた画面にも、これまでの会話を積む。
    // **押されるのを待っているボタンは作り直さない。** 提案は出た側の画面に
    // 残っており、同じものが2つ並ぶと、どちらを押したのか分からなくなる
    (message.turns || []).forEach((turn) => {
      if (turn.role === 'author') {
        appendTurn('あなた', turn.text, 'author');
      } else {
        appendTurn('AI', turn.text, undefined, turn.html);
      }
    });
    scrollToBottom();
    return;
  }
  if (message.type === 'asked') {
    // もう片方の画面から質問が送られた。こちらにも積んで、待ち状態にする
    appendTurn('あなた', message.question, 'author');
    document.querySelectorAll('.options').forEach((el) => el.remove());
    currentOptions = [];
    updateHint();
    setBusy(true);
    scrollToBottom();
    return;
  }
  if (message.type === 'cleared') {
    // もう片方の画面で「最初から」が押された
    resetLog();
    return;
  }
  if (message.type === 'cancelled') {
    // 料金の確認で取りやめた。送っていないので、入力を戻して待つ
    setBusy(false);
    return;
  }
  if (message.type === 'reading') {
    // 材料が足りず、AIが別のファイルを求めた。何を見ているかを伝える
    thinkingEl.textContent =
      (message.files || []).join('・') + ' を読んでいます…';
    return;
  }
  if (message.type === 'searched') {
    // 質問に近い場面を探した。**どこから拾ったかを見せる。**
    // 設定資料やあらすじは本文からAIが作ったものなので、
    // 何由来の答えなのかが分からないと作者が確かめようがない
    thinkingEl.textContent = message.summary + '。考えています…';
    return;
  }
  if (message.type === 'answer') {
    setBusy(false);
    thinkingEl.textContent = '考えています…';
    const turn = appendTurn('AI', message.reply, undefined, message.html);
    if (message.locate) appendLocate(turn, message.locate);
    if (message.edit) appendEdit(turn, message.edit);
    if (message.run) appendRun(turn, message.run);
    if (message.reload) appendReload(turn, message.reload);
    appendOptions(turn, message.options || []);
    scrollToBottom();
    return;
  }
  if (message.type === 'chatter') {
    // 独り言。**考え中の表示は触らない。** 質問の答えを待っている最中に
    // 割り込むことがあり、そこで「考えています…」を消すと待ちが止まって見える
    const turn = appendTurn(message.who || 'AI', message.text, 'chatter');
    if (message.run) appendRun(turn, message.run);
    if (message.options && message.options.length > 0) {
      appendOptions(turn, message.options);
    }
    scrollToBottom();
    return;
  }
  if (message.type === 'note') {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = message.message;
    logEl.appendChild(note);
    scrollToBottom();
    return;
  }
  if (message.type === 'editApplied') {
    markEdit(message.id, message.message, true);
    scrollToBottom();
    return;
  }
  if (message.type === 'editFailed') {
    markEdit(message.id, message.message, false);
    scrollToBottom();
    return;
  }
  if (message.type === 'runDone') {
    markEdit(message.id, message.message, true);
    scrollToBottom();
    return;
  }
  if (message.type === 'runFailed') {
    markEdit(message.id, message.message, false);
    scrollToBottom();
    return;
  }
  if (message.type === 'reloadDone') {
    markEdit(message.id, message.message, true);
    scrollToBottom();
    return;
  }
  if (message.type === 'reloadFailed') {
    markEdit(message.id, message.message, false);
    scrollToBottom();
    return;
  }
  if (message.type === 'locateDone') {
    markEdit(message.id, message.message, true);
    scrollToBottom();
    return;
  }
  if (message.type === 'locateFailed') {
    markEdit(message.id, message.message, false);
    scrollToBottom();
    return;
  }
  if (message.type === 'error') {
    setBusy(false);
    thinkingEl.textContent = '考えています…';
    appendTurn('エラー', message.message, 'error');
    scrollToBottom();
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
