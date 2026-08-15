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
 */
export function buildWorkChatPanelHtml(
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
  border-radius: 2px;
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
</style>
</head>
<body>
<div id="context"><span class="label">相談の対象:</span><span class="what" id="context-what">—</span><span id="context-provider"></span></div>
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

/** 直前の返事に付いていた選択肢。番号入力で選べるようにする */
let currentOptions = [];
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

function appendTurn(who, text, kind) {
  emptyEl.hidden = true;
  const turn = document.createElement('div');
  turn.className = 'turn ' + (kind || '');
  turn.innerHTML =
    '<div class="who">' + escapeHtml(who) + '</div>' +
    '<div class="body">' + escapeHtml(text) + '</div>';
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
  logEl.innerHTML = '';
  logEl.appendChild(emptyEl);
  emptyEl.hidden = false;
  currentOptions = [];
  updateHint();
  vscode.postMessage({ type: 'clear' });
});

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
    document.getElementById('context-provider').textContent =
      message.provider ? '／ ' + message.provider : '';
    return;
  }
  if (message.type === 'reading') {
    // 材料が足りず、AIが別のファイルを求めた。何を見ているかを伝える
    thinkingEl.textContent =
      (message.files || []).join('・') + ' を読んでいます…';
    return;
  }
  if (message.type === 'answer') {
    setBusy(false);
    thinkingEl.textContent = '考えています…';
    const turn = appendTurn('AI', message.reply);
    if (message.edit) appendEdit(turn, message.edit);
    appendOptions(turn, message.options || []);
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
