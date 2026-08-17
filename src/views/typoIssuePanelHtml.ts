/**
 * AI指摘パネル（下段・誤字脱字）の中身。
 *
 * 設定資料パネルと同じく、値はすべて postMessage で渡し、
 * HTMLへ文字列として埋め込まない（本文の引用符で画面が壊れるのを防ぐ）。
 */
export function buildTypoIssuePanelHtml(
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
<title>AI指摘</title>
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
#toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  position: sticky;
  top: 0;
  background: var(--vscode-editor-background);
}
#toolbar .title { font-weight: bold; }
#toolbar .count { color: var(--vscode-descriptionForeground); }
#toolbar label { display: flex; align-items: center; gap: 4px; margin-left: auto; }
button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 2px;
  padding: 3px 10px;
  cursor: pointer;
  font-size: inherit;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
#empty {
  padding: 24px 16px;
  color: var(--vscode-descriptionForeground);
}
#list { padding: 4px 0; }
.issue {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.issue.low { display: none; }
body.show-low .issue.low { display: flex; }
.issue.applied { opacity: 0.55; }
.issue.dismissed { display: none; }
.issue-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.location {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
.location:hover { text-decoration: underline; }
.badge {
  border-radius: 10px;
  padding: 0 8px;
  font-size: 11px;
  border: 1px solid var(--vscode-panel-border);
}
.badge.high { border-color: var(--vscode-testing-iconPassed, #4caf50); }
.badge.medium { border-color: var(--vscode-editorWarning-foreground, #cca700); }
.badge.low { border-color: var(--vscode-descriptionForeground); }
.diff { font-family: var(--vscode-editor-font-family, monospace); }
.diff .from { color: var(--vscode-errorForeground); text-decoration: line-through; }
.diff .to { color: var(--vscode-terminal-ansiGreen, #4caf50); }
.reason { color: var(--vscode-descriptionForeground); font-size: 12px; }
.actions { display: flex; gap: 6px; }
.status-detail { font-size: 12px; color: var(--vscode-errorForeground); }
/* 矛盾。置き換えではなく食い違いを並べる */
.contradiction .quote {
  font-size: 12px;
  opacity: 0.85;
  border-left: 2px solid var(--vscode-panel-border);
  padding-left: 8px;
  margin: 4px 0;
}
.contradiction .compare { font-size: 13px; line-height: 1.7; }
.contradiction .side {
  display: inline-block;
  min-width: 4.5em;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
.contradiction .note {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
}
.badge.cat { border-color: var(--vscode-focusBorder); }
</style>
</head>
<body>
<div id="toolbar">
  <span class="title" id="category">誤字脱字</span>
  <span class="count" id="count">0件</span>
  <label><input type="checkbox" id="showLow"> 確信度が低いものも表示</label>
  <button class="secondary" id="applyAll">表示中をまとめて適用</button>
</div>
<div id="empty">まだ検知結果がありません。「誤字脱字を検知」または「表記ゆれを検知」を実行してください。</div>
<div id="list"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const showLowEl = document.getElementById('showLow');
const applyAllEl = document.getElementById('applyAll');

showLowEl.addEventListener('change', () => {
  document.body.classList.toggle('show-low', showLowEl.checked);
});
applyAllEl.addEventListener('click', () => {
  vscode.postMessage({ type: 'applyAll' });
});

const CONFIDENCE_LABEL = { high: '確信度: 高', medium: '確信度: 中', low: '確信度: 低' };
const STATUS_LABEL = { applied: '適用済み', dismissed: '無視しました', failed: '失敗' };

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(workTitle, items) {
  const pending = items.filter((item) => item.status !== 'dismissed');
  countEl.textContent = pending.length + '件';
  emptyEl.style.display = items.length === 0 ? 'block' : 'none';
  listEl.innerHTML = items.map(renderItem).join('');

  listEl.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: el.dataset.action, id: el.dataset.id });
    });
  });
}

/**
 * 矛盾の1件。
 *
 * **適用ボタンを出さない。** 誤字脱字と違い、設定と本文のどちらが
 * 正しいかは作者にしか決められない（設定側が古いことがある）。
 * 「設定ではこう／本文ではこう」を並べ、見に行く先を2つ出すだけにする。
 */
function renderContradiction(item) {
  const classes = ['issue', 'contradiction'];
  if (item.confidence === 'low') classes.push('low');
  if (item.status === 'dismissed') classes.push('dismissed');

  const canAct = item.status === 'pending';
  const note = item.note
    ? '<div class="note">' + escapeHtml(item.note) + '</div>'
    : '';

  return (
    '<div class="' + classes.join(' ') + '">' +
    '<div class="issue-head">' +
    '<span class="location" data-action="jump" data-id="' + item.id + '">' +
    escapeHtml(item.fileName) + ' ' + item.line + '行目</span>' +
    '<span class="badge cat">' + escapeHtml(item.category) + '</span>' +
    '<span class="badge ' + item.confidence + '">' + CONFIDENCE_LABEL[item.confidence] + '</span>' +
    (item.status === 'dismissed' ? '<span class="reason">無視しました</span>' : '') +
    '</div>' +
    '<div class="quote">' + escapeHtml(item.excerpt) + '</div>' +
    '<div class="compare">' +
    '<div><span class="side">' + escapeHtml(item.leftLabel || '設定では') + '</span>' + escapeHtml(item.settingSays) + '</div>' +
    '<div><span class="side">' + escapeHtml(item.rightLabel || '本文では') + '</span>' + escapeHtml(item.textSays) + '</div>' +
    '</div>' +
    note +
    (canAct
      ? '<div class="actions">' +
        '<button data-action="jump" data-id="' + item.id + '">本文を見る</button>' +
        '<button class="secondary" data-action="openSettings" data-id="' + item.id + '">' + (item.openTarget === 'plot' ? 'プロットを見る' : '設定資料を見る') + '</button>' +
        '<button class="secondary" data-action="dismiss" data-id="' + item.id + '">無視</button>' +
        '</div>'
      : '') +
    '</div>'
  );
}

function renderItem(item) {
  // 矛盾は形が違う。並べるものが「置き換え」ではなく「食い違い」である
  if (item.excerpt !== undefined) return renderContradiction(item);

  const classes = ['issue'];
  if (item.confidence === 'low') classes.push('low');
  if (item.status === 'applied') classes.push('applied');
  if (item.status === 'dismissed') classes.push('dismissed');

  // **修正案の無い指摘がある**（推敲）。長すぎる文をどう割るかは
  // 文体の書き換えになるので、直し方は作者が決める。
  // 押しても何も起きないボタンを出さない
  const hasFix = Boolean(item.suggestion);
  const canAct = item.status === 'pending' || item.status === 'failed';
  const statusText = STATUS_LABEL[item.status]
    ? '<span class="reason">' + STATUS_LABEL[item.status] + '</span>'
    : '';
  const statusDetail = item.statusDetail
    ? '<div class="status-detail">' + escapeHtml(item.statusDetail) + '</div>'
    : '';

  const body = hasFix
    ? '<div class="diff">' +
      '<span class="from">' + escapeHtml(item.target) + '</span> → ' +
      '<span class="to">' + escapeHtml(item.suggestion) + '</span>' +
      '</div>' +
      '<div class="reason">' + escapeHtml(item.original) + '（' + escapeHtml(item.reason) + '）</div>'
    : '<div class="quote">' + escapeHtml(item.original) + '</div>' +
      '<div class="reason">' + escapeHtml(item.reason) +
      '（直し方は作者が決めてください）</div>';

  return (
    '<div class="' + classes.join(' ') + '">' +
    '<div class="issue-head">' +
    '<span class="location" data-action="jump" data-id="' + item.id + '">' +
    escapeHtml(item.fileName) + ' ' + item.line + '行目</span>' +
    '<span class="badge ' + item.confidence + '">' + CONFIDENCE_LABEL[item.confidence] + '</span>' +
    statusText +
    '</div>' +
    body +
    statusDetail +
    (canAct
      ? '<div class="actions">' +
        (hasFix
          ? '<button data-action="apply" data-id="' + item.id + '">適用</button>'
          : '<button data-action="jump" data-id="' + item.id + '">本文を見る</button>') +
        '<button class="secondary" data-action="dismiss" data-id="' + item.id + '">無視</button>' +
        (canKeep(item)
          ? '<button class="secondary" data-action="keepWord" data-id="' + item.id + '" title="この語を今後どの話でも指摘しません">今後直さない</button>'
          : '') +
        '</div>'
      : '') +
    '</div>'
  );
}

// **方言や口癖は、指摘を見たその場で守れるのがいちばん自然。**
// 語として登録できる長さのときだけ出す（推敲は一文まるごとを指すので出ない）
function canKeep(item) {
  const word = (item.target || '').trim();
  return word.length >= 2 && word.length <= 20;
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'issues') {
    // 見出しは検知の種類で変わる（誤字脱字／表記ゆれ）
    document.getElementById('category').textContent = message.category || '誤字脱字';
    // 矛盾には「まとめて適用」が無い。どちらが正しいか決められないため
    applyAllEl.style.display = message.canApplyAll === false ? 'none' : '';
    render(message.workTitle, message.items);
  }
});
</script>
</body>
</html>`;
}
