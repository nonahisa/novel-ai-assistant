/**
 * 名前の点検の画面（設計書6.37.5）。
 *
 * 上に衝突の組、下に人物一覧を1枚で見せる。**外部ライブラリを使わない**——
 * WebView は既定で外部への通信を禁じており、同梱してCSPを緩めるほどの
 * 見た目は要らない（執筆量パネルと同じ判断）。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （人物名の引用符で画面が壊れるのを防ぐ）。
 *
 * **この画面は何も書き換えない。** 押せるのは「候補を出す」「付け替える」
 * 「登場箇所へ飛ぶ」の3つで、どれも本体側の確認を通ってから動く。
 */
export function buildNameCheckPanelHtml(
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
<title>名前の点検</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 32px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
header {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
h1 { font-size: 1.2em; margin: 0; flex: 1; }
h2 {
  font-size: 1em;
  margin: 20px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
main { padding: 0 16px; }
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
button:disabled { opacity: 0.5; cursor: default; }
button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.notice {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 10px 0;
}
.empty { color: var(--vscode-descriptionForeground); padding: 6px 0; }
.row {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 6px;
}
.collision { cursor: pointer; }
.collision:hover { background: var(--vscode-list-hoverBackground); }
.collision-head { display: flex; align-items: center; gap: 8px; }
.pair { font-weight: 600; }
.reason { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
.badge {
  font-size: 11px;
  border-radius: 3px;
  padding: 1px 7px;
  border: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
}
.badge.strong {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-errorForeground);
}
.badge.medium { color: var(--vscode-charts-yellow, #d7ba7d); }
.badge.weak { color: var(--vscode-descriptionForeground); }
.person-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.person-name { font-weight: 600; font-size: 1.05em; }
.person-sub { font-size: 12px; color: var(--vscode-descriptionForeground); }
.person-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.person.flash { outline: 1px solid var(--vscode-focusBorder); }
.places { margin-top: 8px; border-top: 1px dashed var(--vscode-panel-border); padding-top: 6px; }
.place {
  font-size: 12px;
  padding: 3px 4px;
  cursor: pointer;
  border-radius: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.place:hover { background: var(--vscode-list-hoverBackground); }
.place .where { color: var(--vscode-descriptionForeground); margin-right: 8px; }
.place .hit { color: var(--vscode-charts-blue, #3794ff); font-weight: 600; }
.candidates { margin-top: 8px; border-top: 1px dashed var(--vscode-panel-border); padding-top: 6px; }
.candidate { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.candidate .meta { font-size: 12px; color: var(--vscode-descriptionForeground); flex: 1; }
.dropped { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 2px 0; }
.ai-note { font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <h1 id="title">名前の点検</h1>
  <button id="refresh">更新</button>
</header>
<main>
  <div class="notice" id="notice"></div>
  <h2 id="collision-heading">響きが重なっている組</h2>
  <div id="collisions"></div>
  <h2 id="unreadable-heading">読みが無いので見ていない名前</h2>
  <div id="unreadable"></div>
  <h2>登場人物</h2>
  <div id="people"></div>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = null;
/** 展開している人物のid。更新しても開いたままにするため覚えておく */
const openPlaces = new Set();
/** 人物ごとのAI候補。届いた順に上書きする */
const candidates = new Map();
/** いまAIを待っている人物のid */
let busyId = null;

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

function strengthLabel(strength) {
  if (strength === 'strong') return '強';
  if (strength === 'medium') return '中';
  return '弱';
}

/** 正式名と、当たった呼び方。別名や姓で当たったときに、それを添える */
function sideText(side) {
  if (!side.part) return side.name;
  return side.name + '（' + side.part + '）';
}

function renderCollisions() {
  const host = document.getElementById('collisions');
  const list = state.collisions;
  document.getElementById('collision-heading').textContent =
    '響きが重なっている組（' + list.length + '組）';

  if (list.length === 0) {
    host.innerHTML = '<div class="empty">重なっている名前は見つかりませんでした。</div>';
    return;
  }

  host.innerHTML = list.map((collision) =>
    '<div class="row collision" data-a="' + escapeHtml(collision.a.id) +
    '" data-b="' + escapeHtml(collision.b.id) + '">' +
    '<div class="collision-head">' +
    '<span class="badge ' + collision.strength + '">' +
    strengthLabel(collision.strength) + '</span>' +
    '<span class="pair">' + escapeHtml(sideText(collision.a)) + ' ／ ' +
    escapeHtml(sideText(collision.b)) + '</span>' +
    '</div>' +
    '<div class="reason">' + escapeHtml(collision.reason) + '</div>' +
    '</div>'
  ).join('');

  const rows = host.querySelectorAll('.collision');
  for (const row of rows) {
    row.addEventListener('click', () => {
      focusPerson(row.dataset.a);
    });
  }
}

function renderUnreadable() {
  const host = document.getElementById('unreadable');
  const list = state.unreadable;
  const heading = document.getElementById('unreadable-heading');

  if (list.length === 0) {
    heading.textContent = '読みが無いので見ていない名前（0件）';
    host.innerHTML = '<div class="empty">すべての名前に読みがあります。</div>';
    return;
  }

  heading.textContent = '読みが無いので見ていない名前（' + list.length + '件）';
  host.innerHTML =
    '<div class="notice">漢字だけの名前は、読みが無いと響きを比べられません。' +
    '設定資料パネルで読みを入れると、次の更新から点検の対象になります。</div>' +
    list.map((entry) =>
      '<div class="row">' + escapeHtml(entry.name) + '</div>'
    ).join('');
}

function placesHtml(person) {
  if (!openPlaces.has(person.id)) return '';
  if (person.places.length === 0) {
    return '<div class="places"><div class="empty">本文には出てきません。</div></div>';
  }

  const rows = person.places.map((place, index) =>
    '<div class="place" data-person="' + escapeHtml(person.id) +
    '" data-index="' + index + '">' +
    '<span class="where">' + escapeHtml(place.fileName) + ' ' + place.line + '行</span>' +
    escapeHtml(place.before) +
    '<span class="hit">' + escapeHtml(place.name) + '</span>' +
    escapeHtml(place.after) +
    '</div>'
  ).join('');

  const more = person.occurrences > person.places.length
    ? '<div class="empty">ほか ' + (person.occurrences - person.places.length) +
      '件（多いので先頭だけ出しています）</div>'
    : '';
  return '<div class="places">' + rows + more + '</div>';
}

function candidatesHtml(person) {
  if (busyId === person.id) {
    return '<div class="candidates"><div class="empty">候補を考えています…</div></div>';
  }
  const found = candidates.get(person.id);
  if (!found) return '';

  const kept = found.kept.map((candidate, index) =>
    '<div class="candidate">' +
    '<button class="primary" data-pick="' + escapeHtml(person.id) +
    '" data-index="' + index + '">この名前にする</button>' +
    '<span class="meta"><b>' + escapeHtml(candidate.name) + '</b>' +
    (candidate.reading ? '（' + escapeHtml(candidate.reading) + '）' : '') +
    ' ' + escapeHtml(candidate.origin) +
    (candidate.note ? ' — ' + escapeHtml(candidate.note) : '') +
    '</span></div>'
  ).join('');

  // **落とした候補も見せる。** 黙って減らすと、何件出たのか分からない
  const dropped = found.dropped.map((candidate) =>
    '<div class="dropped">落としました：' + escapeHtml(candidate.name) +
    ' — ' + escapeHtml(candidate.reason) + '</div>'
  ).join('');

  const empty = found.kept.length === 0
    ? '<div class="empty">残った候補がありませんでした。もう一度出すか、系統を変えてください。</div>'
    : '';

  return '<div class="candidates">' + kept + empty + dropped + '</div>';
}

function renderPeople() {
  const host = document.getElementById('people');
  if (state.people.length === 0) {
    host.innerHTML = '<div class="empty">登場人物が登録されていません。</div>';
    return;
  }

  host.innerHTML = state.people.map((person) =>
    '<div class="row person" id="person-' + escapeHtml(person.id) + '">' +
    '<div class="person-head">' +
    '<span class="person-name">' + escapeHtml(person.name) + '</span>' +
    '<span class="person-sub">' +
    (person.reading ? escapeHtml(person.reading) : '読み未設定') +
    (person.aliases.length > 0 ? ' ／ 別名: ' + escapeHtml(person.aliases.join('、')) : '') +
    ' ／ 本文に ' + person.occurrences + '回' +
    '</span>' +
    '</div>' +
    '<div class="person-actions">' +
    '<button data-suggest="' + escapeHtml(person.id) + '"' +
    (busyId ? ' disabled' : '') + '>候補を出す（AI）</button>' +
    '<button data-rename="' + escapeHtml(person.id) + '">付け替える</button>' +
    '<button data-places="' + escapeHtml(person.id) + '">' +
    (openPlaces.has(person.id) ? '登場箇所を閉じる' : '登場箇所') + '</button>' +
    '<span class="ai-note">「候補を出す（AI）」だけがAIを使います</span>' +
    '</div>' +
    placesHtml(person) +
    candidatesHtml(person) +
    '</div>'
  ).join('');

  bindPeopleEvents(host);
}

function bindPeopleEvents(host) {
  for (const button of host.querySelectorAll('[data-suggest]')) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'suggest', id: button.dataset.suggest });
    });
  }
  for (const button of host.querySelectorAll('[data-rename]')) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'rename', id: button.dataset.rename });
    });
  }
  for (const button of host.querySelectorAll('[data-places]')) {
    button.addEventListener('click', () => {
      const id = button.dataset.places;
      if (openPlaces.has(id)) openPlaces.delete(id);
      else openPlaces.add(id);
      renderPeople();
    });
  }
  for (const place of host.querySelectorAll('.place')) {
    place.addEventListener('click', () => {
      const person = state.people.find((entry) => entry.id === place.dataset.person);
      if (!person) return;
      const target = person.places[Number(place.dataset.index)];
      if (!target) return;
      vscode.postMessage({
        type: 'jump',
        filePath: target.filePath,
        line: target.line
      });
    });
  }
  for (const button of host.querySelectorAll('[data-pick]')) {
    button.addEventListener('click', () => {
      const id = button.dataset.pick;
      const found = candidates.get(id);
      if (!found) return;
      const candidate = found.kept[Number(button.dataset.index)];
      if (!candidate) return;
      vscode.postMessage({
        type: 'rename',
        id: id,
        name: candidate.name,
        reading: candidate.reading
      });
    });
  }
}

/** 衝突の組から人物へ移る。押した先が見えないと、組と人物がつながらない */
function focusPerson(id) {
  const target = document.getElementById('person-' + id);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('flash');
  setTimeout(() => { target.classList.remove('flash'); }, 1200);
}

function render() {
  if (!state) return;
  document.getElementById('title').textContent = state.title;
  document.getElementById('notice').textContent = state.notice;
  renderCollisions();
  renderUnreadable();
  renderPeople();
}

document.getElementById('refresh').addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'names') {
    state = message.data;
    render();
    return;
  }
  if (message.type === 'candidates') {
    candidates.set(message.data.characterId, message.data);
    busyId = null;
    renderPeople();
    return;
  }
  if (message.type === 'busy') {
    busyId = message.id;
    renderPeople();
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
