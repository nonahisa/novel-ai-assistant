/**
 * 執筆量パネルの中身（設計書6.3）。
 *
 * **グラフは外部ライブラリを使わずSVGで組み立てる。** 棒グラフと目標線しか
 * 要らないうえ、WebViewは既定で外部への通信を禁じているため、ライブラリを
 * 使うなら同梱してCSPを緩める必要がある。配布物を重くするだけの利点しかない。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （タイトルの引用符で画面が壊れるのを防ぐ）。
 */
export function buildWritingStatsPanelHtml(
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
<title>執筆量</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 24px;
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
  padding: 10px 16px 0;
}
h1 { font-size: 1.2em; margin: 0 0 8px; }
.tabs { display: flex; gap: 4px; }
.tab {
  padding: 6px 14px;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  color: var(--vscode-descriptionForeground);
}
.tab.active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background, transparent);
}
main { padding: 16px; }
section.page { display: none; }
section.page.active { display: block; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
.card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 10px 14px;
  min-width: 150px;
}
.card .label { font-size: 12px; color: var(--vscode-descriptionForeground); }
.card .value { font-size: 1.5em; margin-top: 2px; }
.card .sub { font-size: 12px; color: var(--vscode-descriptionForeground); }
.card.achieved .value { color: var(--vscode-testing-iconPassed, #4caf50); }
.bar-outer {
  height: 6px;
  border-radius: 3px;
  background: var(--vscode-panel-border);
  margin-top: 6px;
  overflow: hidden;
}
.bar-inner { height: 100%; background: var(--vscode-charts-blue, #3794ff); }
.bar-inner.achieved { background: var(--vscode-testing-iconPassed, #4caf50); }
.controls { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
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
button.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.chart-wrap { overflow-x: auto; }
svg { display: block; }
.axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
.bar { fill: var(--vscode-charts-blue, #3794ff); }
.bar.negative { fill: var(--vscode-charts-red, #f14c4c); }
.bar.today { fill: var(--vscode-charts-green, #89d185); }
.goal-line { stroke: var(--vscode-charts-orange, #d18616); stroke-dasharray: 4 3; stroke-width: 1; }
.tick { fill: var(--vscode-descriptionForeground); font-size: 10px; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
th { color: var(--vscode-descriptionForeground); font-weight: normal; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.clickable { cursor: pointer; }
tr.clickable:hover { background: var(--vscode-list-hoverBackground); }
.flag { font-size: 11px; border-radius: 10px; padding: 0 8px; border: 1px solid var(--vscode-panel-border); }
.flag.short { border-color: var(--vscode-editorWarning-foreground, #cca700); }
.flag.long { border-color: var(--vscode-charts-blue, #3794ff); }
.mini { position: relative; height: 8px; background: var(--vscode-panel-border); border-radius: 4px; min-width: 60px; }
.mini > span { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--vscode-charts-blue, #3794ff); }
.note { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 12px 0; line-height: 1.6; }
.empty { padding: 24px 0; color: var(--vscode-descriptionForeground); line-height: 1.7; }
.conflicted { color: var(--vscode-editorWarning-foreground, #cca700); }
</style>
</head>
<body>
<header>
  <h1 id="title">執筆量</h1>
  <div class="tabs">
    <div class="tab active" data-page="writing">執筆量</div>
    <div class="tab" data-page="episodes">話ごとの文字数</div>
  </div>
</header>
<main>
  <section class="page active" id="page-writing">
    <div class="cards" id="cards"></div>
    <div class="controls" id="granularity"></div>
    <div class="chart-wrap"><svg id="chart" width="100%" height="240"></svg></div>
    <div class="note" id="chart-note"></div>
    <div id="devices"></div>
  </section>
  <section class="page" id="page-episodes">
    <div class="cards" id="episode-cards"></div>
    <div id="episode-table"></div>
  </section>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = null;
let granularity = 'daily';

const GRANULARITY_LABELS = { daily: '日次', weekly: '週次', monthly: '月次', yearly: '年次' };

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCount(value) {
  return Number(value).toLocaleString('ja-JP');
}

// 目盛りの間引き幅を決めるための概算。全角（漢字・全角スペース等）は
// 半角の倍近い幅になるため、文字種で分けないと「2025年10月」のような
// ラベルの必要幅を大きく見誤り、間引きが効かず重なって表示される
function estimateLabelWidth(label) {
  let width = 0;
  for (const ch of String(label)) {
    width += /[　-鿿＀-￯]/.test(ch) ? 10 : 6;
  }
  return width;
}

function signed(value) {
  return (value > 0 ? '+' : '') + formatCount(value);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.page').forEach((el) => el.classList.remove('active'));
    document.getElementById('page-' + tab.dataset.page).classList.add('active');
  });
});

function renderGranularity() {
  const host = document.getElementById('granularity');
  host.innerHTML = Object.keys(GRANULARITY_LABELS)
    .map((key) =>
      '<button data-granularity="' + key + '"' +
      (key === granularity ? ' class="active"' : '') + '>' +
      GRANULARITY_LABELS[key] + '</button>'
    )
    .join('');
  host.querySelectorAll('[data-granularity]').forEach((el) => {
    el.addEventListener('click', () => {
      granularity = el.dataset.granularity;
      renderGranularity();
      renderChart();
    });
  });
}

function renderCards() {
  if (!state) return;
  const today = state.today;
  const month = state.month;
  const cards = [];

  cards.push(card(
    '今日', signed(today.progress.written) + '字',
    today.progress.goal > 0
      ? (today.progress.achieved
          ? '目標 ' + formatCount(today.progress.goal) + '字を達成'
          : 'あと ' + formatCount(today.progress.remaining) + '字')
      : '目標は未設定',
    today.progress
  ));

  cards.push(card(
    '今月', signed(month.progress.written) + '字',
    month.progress.goal > 0
      ? (month.progress.achieved
          ? '目標 ' + formatCount(month.progress.goal) + '字を達成'
          : 'あと ' + formatCount(month.progress.remaining) + '字' +
            (month.paceNeeded ? '（1日 ' + formatCount(month.paceNeeded) + '字ずつ）' : ''))
      : month.activeDays + '日書きました',
    month.progress
  ));

  cards.push(card(
    '連続', state.streak + '日',
    state.streak > 0 ? '書き続けています' : '今日から数え直します',
    null
  ));

  cards.push(card(
    '作品の総量', formatCount(state.totals.net) + '字',
    '原稿用紙 約' + formatCount(state.totals.pages) + '枚 / ' + state.totals.files + 'ファイル',
    null
  ));

  document.getElementById('cards').innerHTML = cards.join('');
}

function card(label, value, sub, progress) {
  const achieved = progress && progress.achieved;
  const bar = progress && progress.goal > 0
    ? '<div class="bar-outer"><div class="bar-inner' + (achieved ? ' achieved' : '') +
      '" style="width:' + Math.max(0, Math.min(100, progress.rate)) + '%"></div></div>'
    : '';
  return (
    '<div class="card' + (achieved ? ' achieved' : '') + '">' +
    '<div class="label">' + escapeHtml(label) + '</div>' +
    '<div class="value">' + escapeHtml(value) + '</div>' +
    '<div class="sub">' + escapeHtml(sub) + '</div>' +
    bar +
    '</div>'
  );
}

function renderChart() {
  const svg = document.getElementById('chart');
  const note = document.getElementById('chart-note');
  if (!state) return;
  const buckets = state.buckets[granularity] || [];

  const barWidth = 26;
  const gap = 6;
  const padLeft = 56;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 34;
  const plotHeight = 180;
  const width = padLeft + padRight + buckets.length * (barWidth + gap);
  const height = padTop + plotHeight + padBottom;

  // 目標線は日次のときだけ意味がある（週次以降は目標の単位が変わる）
  const goal = granularity === 'daily' ? state.goal.daily : 0;
  const values = buckets.map((b) => b.net);
  const maxValue = Math.max(goal, 0, ...values);
  const minValue = Math.min(0, ...values);
  const span = maxValue - minValue || 1;
  const zeroY = padTop + (maxValue / span) * plotHeight;
  const scale = (value) => (Math.abs(value) / span) * plotHeight;

  const parts = [];
  // 0の線。消した日を下向きに出すため、上端固定にはしない
  parts.push('<line class="axis" x1="' + padLeft + '" y1="' + zeroY + '" x2="' + width + '" y2="' + zeroY + '" />');

  if (goal > 0) {
    const goalY = padTop + ((maxValue - goal) / span) * plotHeight;
    parts.push('<line class="goal-line" x1="' + padLeft + '" y1="' + goalY + '" x2="' + width + '" y2="' + goalY + '" />');
    parts.push('<text class="tick" x="4" y="' + (goalY + 3) + '">目標 ' + formatCount(goal) + '</text>');
  }
  parts.push('<text class="tick" x="4" y="' + (padTop + 8) + '">' + formatCount(maxValue) + '字</text>');
  parts.push('<text class="tick" x="4" y="' + (zeroY + 3) + '">0</text>');

  // 目盛りが詰まると読めない。本数に応じて間引くだけでなく、
  // ラベルの実際の幅（「2025年10月」のような全角混じりの文字列）も
  // 考慮しないと、本数が少なくても文字が重なって表示される
  // （実機で発覚：月次12件でも重なって読めなかった。2026-08-13）
  const maxLabelWidth = Math.max(1, ...buckets.map((b) => estimateLabelWidth(b.label)));
  const stepByCount = Math.ceil(buckets.length / 12);
  const stepByWidth = Math.ceil((maxLabelWidth + 8) / (barWidth + gap));
  const step = Math.max(stepByCount, stepByWidth, 1);

  // 最新の期間（右端）は常に見せたいが、間引きの都合でその1つ手前と
  // 近すぎる場合は、手前の目盛りを右端に差し替える（両方出して重ねない）
  const shownIndices = [];
  for (let i = 0; i < buckets.length; i += step) shownIndices.push(i);
  const lastIndex = buckets.length - 1;
  if (shownIndices.length === 0 || shownIndices[shownIndices.length - 1] !== lastIndex) {
    const prev = shownIndices[shownIndices.length - 1] ?? -Infinity;
    if ((lastIndex - prev) * (barWidth + gap) >= maxLabelWidth) {
      shownIndices.push(lastIndex);
    } else if (shownIndices.length > 0) {
      shownIndices[shownIndices.length - 1] = lastIndex;
    } else {
      shownIndices.push(lastIndex);
    }
  }
  const shownSet = new Set(shownIndices);

  buckets.forEach((bucket, index) => {
    const x = padLeft + index * (barWidth + gap);
    const barHeight = Math.max(bucket.net === 0 ? 0 : 1, scale(bucket.net));
    const y = bucket.net >= 0 ? zeroY - barHeight : zeroY;
    const classes = ['bar'];
    if (bucket.net < 0) classes.push('negative');
    if (bucket.key === state.currentBucketKey[granularity]) classes.push('today');
    parts.push(
      '<rect class="' + classes.join(' ') + '" x="' + x + '" y="' + y +
      '" width="' + barWidth + '" height="' + barHeight + '" rx="2">' +
      '<title>' + escapeHtml(bucket.label + '  ' + signed(bucket.net) + '字') + '</title>' +
      '</rect>'
    );
    if (shownSet.has(index)) {
      parts.push(
        '<text class="tick" x="' + (x + barWidth / 2) + '" y="' + (padTop + plotHeight + 16) +
        '" text-anchor="middle">' + escapeHtml(bucket.label) + '</text>'
      );
    }
  });

  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.innerHTML = parts.join('');

  const total = buckets.reduce((sum, bucket) => sum + bucket.net, 0);
  const active = buckets.reduce((sum, bucket) => sum + bucket.activeDays, 0);
  note.textContent =
    GRANULARITY_LABELS[granularity] + 'の合計 ' + signed(total) + '字' +
    '（書いた日 ' + active + '日）。' + state.notice;
}

function renderDevices() {
  const host = document.getElementById('devices');
  if (!state || state.devices.length <= 1) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML =
    '<h3>環境ごとの内訳</h3><table><thead><tr><th>環境</th><th class="num">字数</th>' +
    '<th class="num">書いた日</th></tr></thead><tbody>' +
    state.devices
      .map((device) =>
        '<tr><td>' + escapeHtml(device.deviceId) + '</td>' +
        '<td class="num">' + signed(device.net) + '</td>' +
        '<td class="num">' + device.activeDays + '</td></tr>'
      )
      .join('') +
    '</tbody></table>';
}

function renderEpisodes() {
  if (!state) return;
  const summary = state.episodes.summary;
  document.getElementById('episode-cards').innerHTML = [
    card('話数', formatCount(summary.countedFiles) + '話',
      summary.conflictedFiles > 0 ? '競合 ' + summary.conflictedFiles + '件は未集計' : '合計 ' + formatCount(summary.totalNet) + '字', null),
    card('平均', formatCount(summary.averageNet) + '字',
      '中央値 ' + formatCount(summary.medianNet) + '字', null),
    card('いちばん長い話', summary.longest ? formatCount(summary.longest.net) + '字' : '—',
      summary.longest ? (summary.longest.chapterLabel || summary.longest.fileName) : '', null),
    card('いちばん短い話', summary.shortest ? formatCount(summary.shortest.net) + '字' : '—',
      summary.shortest ? (summary.shortest.chapterLabel || summary.shortest.fileName) : '', null),
  ].join('');

  const rows = state.episodes.rows;
  const maxNet = rows.reduce((max, row) => Math.max(max, row.net), 0) || 1;
  const table = document.getElementById('episode-table');
  if (rows.length === 0) {
    table.innerHTML = '<div class="empty">本文ファイルがありません。</div>';
    return;
  }
  table.innerHTML =
    '<table><thead><tr>' +
    '<th>話</th><th>タイトル</th><th class="num">純文字数</th><th class="num">原稿用紙</th>' +
    '<th class="num">平均比</th><th>長さ</th></tr></thead><tbody>' +
    rows.map((row) => {
      if (row.conflicted) {
        return '<tr class="clickable" data-path="' + escapeHtml(row.filePath) + '">' +
          '<td>' + escapeHtml(row.chapterLabel || '—') + '</td>' +
          '<td>' + escapeHtml(row.title || row.fileName) + '</td>' +
          '<td class="num conflicted" colspan="4">⚠ 未解決の競合（未集計）</td></tr>';
      }
      const flag = row.flag === 'short'
        ? '<span class="flag short">短い</span>'
        : row.flag === 'long' ? '<span class="flag long">長い</span>' : '';
      const collected = row.collectedCount !== null
        ? ' <span class="flag">' + row.collectedCount + '話ぶん</span>' : '';
      return '<tr class="clickable" data-path="' + escapeHtml(row.filePath) + '">' +
        '<td>' + escapeHtml(row.chapterLabel || '—') + '</td>' +
        '<td>' + escapeHtml(row.title || row.fileName) + collected + '</td>' +
        '<td class="num">' + formatCount(row.net) + '</td>' +
        '<td class="num">約' + formatCount(row.pages) + '枚</td>' +
        '<td class="num">' + Math.round(row.ratio * 100) + '%</td>' +
        '<td><div class="mini"><span style="width:' +
        Math.round((row.net / maxNet) * 100) + '%"></span></div>' + flag + '</td></tr>';
    }).join('') +
    '</tbody></table>';

  table.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'open', filePath: el.dataset.path });
    });
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type !== 'stats') return;
  state = message.data;
  document.getElementById('title').textContent = state.workTitle + ' の執筆量';
  renderGranularity();
  renderCards();
  renderChart();
  renderDevices();
  renderEpisodes();
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
