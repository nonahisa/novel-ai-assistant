import { READER_STATS_VISIBLE_ROWS } from "../core/postingSiteRecords";

/**
 * 執筆量パネルの中身（設計書6.3）。
 *
 * **グラフは外部ライブラリを使わずSVGで組み立てる。** 棒グラフと目標線しか
 * 要らないうえ、WebViewは既定で外部への通信を禁じているため、ライブラリを
 * 使うなら同梱してCSPを緩める必要がある。配布物を重くするだけの利点しかない。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （タイトルの引用符で画面が壊れるのを防ぐ）。
 *
 * **全作品の執筆量パネルとこのHTMLを共有する。** グラフ・カード・
 * 内訳テーブルの組み方は1作品でも全作品でも同じで、違うのは
 * 「話ごとの文字数」タブの有無（全作品では話数の単位が作品ごとに
 * バラバラで意味を持たない）だけ。別ファイルに複製すると、
 * グラフの目盛り間引きのような細かい修正が2箇所に必要になる。
 */
export function buildWritingStatsPanelHtml(
  nonce: string,
  cspSource: string,
  options: { hasEpisodesTab?: boolean; unitNoun?: string } = {}
): string {
  const hasEpisodesTab = options.hasEpisodesTab ?? true;
  // SNS記事は「話」ではなく「投稿」。数えるものが違えば呼び方も違う
  const unitNoun = options.unitNoun ?? "話";
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
/* 締切の帯。応募作ではここが最初に目に入る場所になる */
.contest {
  border-left: 3px solid var(--vscode-focusBorder);
  padding: 8px 12px;
  margin-bottom: 16px;
  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
}
.contest.warn { border-left-color: var(--vscode-errorForeground); }
.contest-head { font-weight: 600; margin-bottom: 4px; }
.contest-detail { font-size: 12px; opacity: 0.85; }
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
/* 読者の反応のグラフ（2026-09-23）。棒は執筆量と同じ .bar、基準の話だけ色を変える */
.bar.mark { fill: var(--vscode-charts-orange, #d18616); }
.line { fill: none; stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 1.5; }
.dot { fill: var(--vscode-charts-blue, #3794ff); }
/* 率の表は3行しかない。画面幅いっぱいに広げると、率と式が左右に離れて読みにくい */
table.reader-rates { width: auto; }
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
/* サイトの記録（設計書6.68.5）。作品情報の1行と、その下に順位の履歴 */
.site { margin-bottom: 18px; }
.site-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
.site-name { font-weight: 600; }
.site-meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
.site-latest { font-size: 12px; }
/* 順位の表と読者の反応の表を見分けるための小見出し（設計書6.79.7） */
.site-sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 10px 0 2px; }
/*
  最新の反応（設計書6.79.7）。**数字を先に読めるように**、ラベルは小さく薄く、
  数字は通常の大きさで並べる。1本の長い文字列だと読む気にならない
  （作者の言葉「サイトの記録が読みにくいです」、2026-09-22）
*/
.reader-latest { margin: 8px 0 2px; }
.reader-latest-head { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
/* 折り返しは flex に任せる。狭い画面では縦に積むだけで読める */
.reader-values { display: flex; flex-wrap: wrap; gap: 4px 18px; }
.reader-value { display: flex; align-items: baseline; gap: 5px; font-variant-numeric: tabular-nums; }
.reader-value > .k { font-size: 11px; color: var(--vscode-descriptionForeground); }
/* 古い記録・話ごとの記録は畳んでおく（開いた状態は覚えない） */
details.fold { margin: 4px 0 0; }
details.fold > summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  padding: 4px 0;
}
.site-foot { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 0; }
/* 読者の反応の助言（設計書6.79.7.3）。AIの答えを1件ずつ左に線を引いて、率の表と見分ける */
.advice-item { margin: 6px 0 8px; padding-left: 8px; border-left: 2px solid var(--vscode-panel-border); line-height: 1.6; }
.advice-title { font-weight: 600; font-size: 12px; }
ul.advice-list { margin: 2px 0; padding-left: 18px; }
.advice-ask-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 4px 0; }
.advice-summary { margin: 6px 0; line-height: 1.6; }
/* 記録に無い話数・材料に無い数字の印。読み違いかもしれないことを目立たせる */
.advice-mark { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; }
/* AIへ渡す材料。送る文そのものなので、改行を保って見せる */
.advice-material { white-space: pre-wrap; font-size: 12px; line-height: 1.5; max-height: 320px; overflow: auto; padding: 6px 8px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08)); }
button:disabled { opacity: 0.6; cursor: default; }
a, .link {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  text-decoration: none;
}
a:hover, .link:hover { text-decoration: underline; }
.empty { padding: 24px 0; color: var(--vscode-descriptionForeground); line-height: 1.7; }
.conflicted { color: var(--vscode-editorWarning-foreground, #cca700); }
</style>
</head>
<body>
<header>
  <h1 id="title">執筆量</h1>
  <div class="tabs">
    <div class="tab active" data-page="writing">執筆量</div>
    ${hasEpisodesTab ? `<div class="tab" data-page="episodes">${unitNoun}ごとの文字数</div>` : ''}
  </div>
</header>
<main>
  <section class="page active" id="page-writing">
    <div id="contest"></div>
    <div class="cards" id="cards"></div>
    <div class="controls" id="granularity"></div>
    <div class="chart-wrap"><svg id="chart" width="100%" height="240"></svg></div>
    <div class="note" id="chart-note"></div>
    <div id="devices"></div>
    <div id="site-records"></div>
  </section>
  ${hasEpisodesTab ? `<section class="page" id="page-episodes">
    <div class="cards" id="episode-cards"></div>
    <div id="episode-table"></div>
  </section>` : ''}
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = null;
let granularity = 'daily';
/*
  サイトごとのAIの助言（設計書6.79.7.3）。**画面を描き直しても消えないよう、
  統計の中身（state）とは別に持つ**——本文を保存するたびに統計は送り直される。
*/
const readerAdviceOutcomes = {};
const readerAdviceBusy = {};

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

/**
 * 執筆量の言い方（作者の指定、2026-09-06）。
 *
 * **減った日を「−12字」と出さない。** 推敲で削った日は「書かなかった日」
 * ではないのに、負の数は「マイナス＝良くないこと」と読めてしまう。
 * 記号ではなく言葉で「削った 12字」と言う。
 *
 * 中身は core/writingAmountText.ts の describeWrittenAmount と同じである
 * （WebViewの中からは呼べないので、同じ言い方をここにも置く）。
 * 食い違っていないことは writingStatsPanelHtml.test.ts が見張る。
 * ここはテンプレート文字列の中なので、引用にバッククォートを使わない。
 */
function amount(value) {
  if (value < 0) return '削った ' + formatCount(-value) + '字';
  return (value > 0 ? '+' : '') + formatCount(value) + '字';
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

/**
 * 締切のある作品の帯。
 *
 * **いちばん上に出す。** 応募作を書いているとき、まず知りたいのは
 * 「あと何日で、あと何字か」である。グラフより先に目に入る場所に置く。
 */
function renderContest() {
  const box = document.getElementById('contest');
  const contest = state && state.contest;
  if (!contest) {
    box.innerHTML = '';
    return;
  }

  const rows = [];
  rows.push('<div class="contest-head">' + escapeHtml(contest.headline) + '</div>');

  const detail = [];
  detail.push('締切 ' + escapeHtml(contest.deadline));
  if (contest.targetChars !== null) {
    detail.push('目標 ' + formatCount(contest.targetChars) + '字');
  }
  detail.push('現在 ' + formatCount(contest.written) + '字');
  if (contest.neededPerDay !== null) {
    detail.push('1日 ' + formatCount(contest.neededPerDay) + '字');
  }
  rows.push('<div class="contest-detail">' + detail.join(' ／ ') + '</div>');

  // 募集要項は変わることがある。作者が確かめ直せるように残す
  if (contest.url) {
    rows.push(
      '<div class="contest-detail"><a href="' + escapeHtml(contest.url) + '">募集要項を見る</a></div>'
    );
  }

  const state2 = contest.overdue || contest.overMax ? ' warn' : '';
  box.innerHTML = '<div class="contest' + state2 + '">' + rows.join('') + '</div>';
}

function renderCards() {
  if (!state) return;
  const today = state.today;
  const month = state.month;
  const cards = [];

  cards.push(card(
    '今日', amount(today.progress.written),
    today.progress.goal > 0
      ? (today.progress.achieved
          ? '目標 ' + formatCount(today.progress.goal) + '字を達成'
          : 'あと ' + formatCount(today.progress.remaining) + '字')
      : '目標は未設定',
    today.progress
  ));

  cards.push(card(
    '今月', amount(month.progress.written),
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
    state.totalsCardLabel || '作品の総量', formatCount(state.totals.net) + '字',
    '原稿用紙 約' + formatCount(state.totals.pages) + '枚 / ' + state.totals.files + 'ファイル' +
      (state.totals.workCount !== undefined ? ' / ' + state.totals.workCount + '作品' : '') +
      // 「作品の文字数を表示」を畳んだぶん、あちらにしか無かった2つを添える。
      // 全作品の合計では渡らないので、あるときだけ出す
      (state.totals.gross !== undefined
        ? ' / 総文字数 ' + formatCount(state.totals.gross) + '字'
        : '') +
      (state.totals.paragraphs !== undefined
        ? ' / ' + formatCount(state.totals.paragraphs) + '段落'
        : ''),
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

  // 最新の期間（右端）は常に見せたい。先頭からではなく**末尾から**
  // step間隔で選ぶと、間隔がすべて揃ったまま右端も必ず含められる
  // （先頭基準だと、右端だけ間隔が変わって不揃いに見えていた。2026-08-13）
  const shownIndices = [];
  for (let i = buckets.length - 1; i >= 0; i -= step) shownIndices.push(i);
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
      '<title>' + escapeHtml(bucket.label + '  ' + amount(bucket.net)) + '</title>' +
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
    GRANULARITY_LABELS[granularity] + 'の合計 ' + amount(total) +
    '（書いた日 ' + active + '日）。' + state.notice;
}

function renderDevices() {
  const host = document.getElementById('devices');
  if (!state || !state.devices || state.devices.length <= 1) {
    host.innerHTML = '';
    return;
  }
  const title = state.devicesTitle || '環境ごとの内訳';
  const column = state.devicesColumn || '環境';
  host.innerHTML =
    '<h3>' + escapeHtml(title) + '</h3><table><thead><tr><th>' + escapeHtml(column) +
    '</th><th class="num">字数</th><th class="num">書いた日</th></tr></thead><tbody>' +
    state.devices
      .map((device) =>
        '<tr><td>' + escapeHtml(device.label) + '</td>' +
        '<td class="num">' + amount(device.net) + '</td>' +
        '<td class="num">' + device.activeDays + '</td></tr>'
      )
      .join('') +
    '</tbody></table>';
}

/**
 * サイトの記録（設計書6.68.5）。
 *
 * **1件も無ければ、節ごと出さない。** 空の見出しと空の表が増えるだけで、
 * 執筆量を見にきた人の邪魔になる。
 *
 * 作品ページは**拡張機能側へ頼んで開く**（openExternal）。画面の中から
 * 直接どこかへ繋ぐことはしない。
 */
function renderSiteRecords() {
  const host = document.getElementById('site-records');
  if (!host) return;
  const records = (state && state.siteRecords) || [];
  /*
    **台帳を読めなかったことは、画面で言う**（設計書6.79.7、0.33.9）。
    以前はログへ残すだけだったので、作者からは「サイトの記録」が理由も
    分からず消えたようにしか見えなかった。ほかの統計は従来どおり出す。
  */
  const failure = (state && state.siteRecordsError) || '';
  const failureNote = failure
    ? '<div class="note">サイトの記録を読めませんでした：' +
      escapeHtml(failure) + '</div>'
    : '';
  if (records.length === 0) {
    host.innerHTML = failureNote
      ? '<h3>サイトの記録</h3>' + failureNote
      : '';
    return;
  }

  const blocks = records.map((record) => {
    const meta = [];
    if (record.workId) meta.push('作品ID ' + escapeHtml(record.workId));
    if (record.genre) meta.push('ジャンル ' + escapeHtml(record.genre));
    if (!record.registered) meta.push('いまは投稿先から外しています');
    if (record.note) meta.push(escapeHtml(record.note));

    const head = ['<div class="site-name">' + escapeHtml(record.label) + '</div>'];
    if (meta.length > 0) {
      head.push('<div class="site-meta">' + meta.join(' ／ ') + '</div>');
    }
    const links = [];
    if (record.workUrl) {
      links.push(
        '<span class="link" data-url="' + escapeHtml(record.workUrl) +
        '">作品ページを開く</span>'
      );
    }
    /*
      なろうの分析リンク（設計書6.79.7）。**なろうの行にしか入らない。**
      なろうは規約でAPI以外の自動収集を禁じているので、こちらから読みに
      いく代わりに、公認データの分析サイトへ作者が飛べるようにする。
      ——開くのは作者のブラウザで、この拡張機能はHTTPを発しない。
    */
    if (record.analysisUrl) {
      links.push(
        '<span class="link" data-url="' + escapeHtml(record.analysisUrl) +
        '">分析（Narou.fun）を開く</span>'
      );
    }
    if (links.length > 0) {
      head.push('<div class="site-meta">' + links.join(' ／ ') + '</div>');
    }
    if (record.latest) {
      head.push(
        '<div class="site-latest">最新 ' + escapeHtml(record.latest.board) + ' ' +
        formatCount(record.latest.rank) + '位' +
        '（' + escapeHtml(formatWhen(record.latest.recordedAt)) + '）</div>'
      );
    }
    const rows = record.history.map((row) =>
      '<tr><td>' + escapeHtml(formatWhen(row.recordedAt)) + '</td>' +
      '<td>' + escapeHtml(row.board) + '</td>' +
      '<td class="num">' + formatCount(row.rank) + '</td>' +
      '<td>' + escapeHtml(row.note || '') + '</td></tr>'
    );
    const table = rows.length > 0
      ? '<table><thead><tr><th>日時</th><th>種別</th><th class="num">順位</th>' +
        '<th>メモ</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>'
      : '';

    /*
      読者の反応（設計書6.79.7）。**あるものだけが並んだ値**が届く
      （どの欄が読めたか・どの列が要るかの判断は core 側が持つ）。
    */
    const reader = renderReaderLatest(record.readerLatest) +
      renderReaderRates(record.readerRates) +
      renderReaderAdvice(record.site, record.readerAdvice,
        readerAdviceOutcomes[record.site], readerAdviceBusy[record.site] === true) +
      renderReaderCharts(record.readerCharts) +
      renderReaderStatsTable(record.readerWork, '読者の反応', true) +
      renderReaderEpisodes(record.readerEpisodes);

    return '<div class="site"><div class="site-head">' + head.join('') + '</div>' +
      table + reader + '</div>';
  });

  const note = siteRecordsNote(records);
  host.innerHTML =
    '<h3>サイトの記録</h3>' + failureNote + blocks.join('') +
    // 言うことが無ければ、空の但し書きを置かない（作品情報だけの作品）
    (note ? '<div class="note">' + note + '</div>' : '');

  host.querySelectorAll('[data-url]').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'openExternal', url: el.dataset.url });
    });
  });
  // 「AIに助言をもらう」（設計書6.79.7.3）。**押したときだけ**頼む
  host.querySelectorAll('[data-advice-site]').forEach((el) => {
    el.addEventListener('click', () => {
      const site = el.dataset.adviceSite;
      if (readerAdviceBusy[site]) return;
      readerAdviceBusy[site] = true;
      renderSiteRecords();
      vscode.postMessage({
        type: 'askReaderAdvice',
        site: site,
        force: el.dataset.force === '1',
      });
    });
  });
}

/**
 * 最新の反応を、表の外で大きく見せる（設計書6.79.7）。
 *
 * **数字を先に読めるようにする。** 以前は「最新の反応 PV 1,053,339／
 * ブックマーク 2,814／…（作品全体・その時点 2026/09/22 12:20）」の1行で、
 * 長すぎて読む気にならなかった（作者の言葉、2026-09-22）。
 */
function renderReaderLatest(latest) {
  if (!latest) return '';
  const values = (latest.snapshotValues || []).map((value) =>
    readerValue(value.label, escapeHtml(value.value) + escapeHtml(value.unit || ''))
  );
  // **今日・今月は同じ塊に入れる**（以前は表の別の行に散っていた）
  if (latest.day) values.push(readerValue('今日', escapeHtml(latest.day)));
  if (latest.month) values.push(readerValue('今月', escapeHtml(latest.month)));
  // 年・累計は粒度の名前がすでに入っているので、ラベルを重ねない
  if (latest.other) values.push(readerValue('', escapeHtml(latest.other)));
  if (values.length === 0) return '';

  const head = ['最新の反応'];
  // 範囲は、話ごとのときだけ言う（作品全体は既定なので書かない）
  if (latest.isEpisode) head.push(escapeHtml(latest.scope));
  return '<div class="reader-latest"><div class="reader-latest-head">' +
    head.join(' ') + '（' + escapeHtml(formatWhen(latest.readAt)) + '・' +
    escapeHtml(latest.source) + '）</div>' +
    '<div class="reader-values">' + values.join('') + '</div></div>';
}

/**
 * 離脱率・ブックマーク率・評価率（作者の依頼、2026-09-23）。
 *
 * **式と実際の数を一緒に出す**（「611 ÷ 23,299 = 2.6%」）。率だけだと、
 * どの数を割ったのかを作者が確かめられない。**出せない率は理由を言う**
 * ——0% と出すと、読めなかったのか本当に0なのか区別が付かない。
 *
 * 計算は core 側（readerRates.ts）が済ませてある。ここは並べるだけ。
 */
function renderReaderRates(rates) {
  if (!rates) return '';
  const rows = [rates.dropout, rates.bookmark, rates.rating].map((rate) => {
    const value = rate.percent ? escapeHtml(rate.percent) : '—';
    const detail = rate.expression
      ? escapeHtml(rate.expression)
      : escapeHtml(rate.missing || '');
    // 話ごとと違う回の数を使ったときだけ、いつの数かを添える
    const when = (rate.operands || [])
      .filter((operand) => operand.readAt)
      .map((operand) =>
        escapeHtml(operand.label) + 'は ' +
        escapeHtml(formatWhen(operand.readAt)) + ' の取り込み'
      );
    return '<tr><td>' + escapeHtml(rate.label) + '</td>' +
      '<td class="num">' + value + '</td>' +
      '<td>' + detail +
      '<div class="site-meta">' + escapeHtml(rate.formula) +
      (when.length > 0 ? '（' + when.join('、') + '）' : '') +
      '</div></td></tr>';
  });

  const foot = [];
  if (rates.base) {
    // 3日の境目は「更新から、読んだ時点まで」で見ている。読んだ時点も言う
    foot.push('離脱率の基準は第' + formatCount(rates.base.episode) + '話（' +
      escapeHtml(formatWhen(rates.base.updatedAt)) + ' 更新。' +
      escapeHtml(formatWhen(rates.base.updatedReadAt)) +
      ' に読んだ時点で更新から3日以上たっていた話のうち、いちばん新しい話）。');
  } else if (rates.baseMissing) {
    foot.push('離脱率の基準の話を決められません：' +
      escapeHtml(rates.baseMissing) + '。');
  }
  const sourcesText = readerEpisodeSourcesText(rates.episodeSources || []);
  if (sourcesText) foot.push(sourcesText);
  return '<div class="site-sub">率</div>' +
    '<table class="reader-rates"><tbody>' + rows.join('') + '</tbody></table>' +
    (foot.length > 0 ? '<div class="site-foot">' + foot.join('') + '</div>' : '');
}

/**
 * 読者の反応の助言（残課題 B9。設計書6.79.7.3）。**率のすぐ下に置く**
 * ——助言は率の値から出ているので、離れた場所に置くと何の話か分からない。
 *
 * **決め打ちの助言文は出さない**（作者の方針転換、2026-09-23 朝「これは
 * むしろ例示だけでAIには自由に答えてほしい」）。ここにあるのは
 * 「AIに助言をもらう」のボタンと、その答え、AIへ渡す材料（畳んで）だけ。
 * **押したときだけAIを呼ぶ**——押す前の料金と所要時間の確認は拡張機能側が出す。
 *
 * 答えは core 側（readerAdviceValidation.ts）が確かめ済みのものが届く。
 * 記録に無い話数・材料に無い数字には印が付いてくるので、そのまま並べる。
 */
function renderReaderAdvice(site, advice, outcome, busy) {
  if (!advice) return '';
  const answered = outcome && outcome.kind === 'answer';
  const label = busy
    ? 'AIに聞いています…'
    : (answered ? 'AIに聞き直す' : 'AIに助言をもらう');
  const button = '<button class="advice-ask" data-advice-site="' + escapeHtml(site) + '"' +
    (answered ? ' data-force="1"' : '') + (busy ? ' disabled' : '') + '>' +
    escapeHtml(label) + '</button>';

  const parts = ['<div class="site-sub">助言</div>'];
  parts.push('<div class="advice-ask-row">' + button +
    '<span class="site-meta">押すとAIを1回呼びます。先に料金と所要時間の目安を出します。</span></div>');

  if (outcome && outcome.kind === 'failed') {
    parts.push('<div class="note">' + escapeHtml(outcome.message || '') + '</div>');
  }
  if (answered) parts.push(renderReaderAdviceAnswer(outcome));

  parts.push('<details class="fold"><summary>AIへ渡す材料</summary>' +
    '<div class="advice-material">' + escapeHtml(advice.materialText || '') + '</div>' +
    readerAdviceSources(advice.sources) + '</details>');
  return parts.join('');
}

/** AIの答え（見立てと、見てほしい所） */
function renderReaderAdviceAnswer(outcome) {
  const answer = outcome.answer || {};
  const parts = [];
  if (answer.summary) {
    parts.push('<div class="advice-summary">' + escapeHtml(answer.summary) +
      readerAdviceMarks(answer.summaryMarks) + '</div>');
  }
  (answer.points || []).forEach((point) => {
    parts.push('<div class="advice-item">' +
      (point.title ? '<div class="advice-title">' + escapeHtml(point.title) + '</div>' : '') +
      '<div>' + escapeHtml(point.body) + '</div>' +
      readerAdviceMarks(point.marks) + '</div>');
  });
  const foot = ['AI（' + escapeHtml(outcome.provider || '') + ' / ' +
    escapeHtml(outcome.model || '') + '）の答えです。'];
  if (outcome.fromCache) {
    foot.push('材料が前と同じなので、前の答えを出しています。');
  }
  (answer.notes || []).forEach((note) => foot.push(escapeHtml(note)));
  parts.push('<div class="site-foot">' + foot.join('') + '</div>');
  return parts.join('');
}

/** 照合で見つかったこと（記録に無い話数・材料に無い数字） */
function readerAdviceMarks(marks) {
  if (!marks || marks.length === 0) return '';
  return '<ul class="advice-list advice-mark">' + marks.map((mark) =>
    '<li>' + escapeHtml(mark) + '</li>'
  ).join('') + '</ul>';
}

/** 例示として渡す記事（題と日付）。開けるリンクにする */
function readerAdviceSources(sources) {
  if (!sources || sources.length === 0) return '';
  return '<div class="site-meta">例示として渡す記事：' + sources.map((source) =>
    '<span class="link" data-url="' + escapeHtml(source.url) + '">' +
    escapeHtml(source.label) + '</span>'
  ).join('、') + '</div>';
}

/**
 * 話ごとの数が、いつの取り込みのものか（2026-09-23）。
 *
 * 話ごとの数は**各話の最新の記録**から拾うので、アクセス数ページ（50話ずつ）を
 * あとから取り込むと、話によって取り込みの回が違う。**黙って混ぜない**——
 * 1回ぶんならその日時だけ、複数回にまたがるなら「最新の取り込み（第1〜50話）、
 * それ以前（第51〜219話）」のように、どの話がいつの数かを言う。
 */
function readerEpisodeSourcesText(sources) {
  if (sources.length === 0) return '';
  if (sources.length === 1) {
    return '話ごとの数は ' + escapeHtml(formatWhen(sources[0].readAt)) + ' の取り込み。';
  }
  const parts = sources.map((source, index) =>
    (index === 0 ? '最新の取り込み' : 'それ以前') + '（' +
    escapeHtml(formatWhen(source.readAt)) + '。' + escapeHtml(source.episodes) + '）'
  );
  return '話ごとの数は、' + parts.join('、') + ' のものです。';
}

/**
 * PVのグラフ（作者の依頼、2026-09-23）。**材料のあるグラフだけを出す。**
 *
 * どれも無ければ見出しごと出さない（空の枠を並べない）。年ごとはカクヨムが
 * 出さないので、ふつうは出ない。
 */
function renderReaderCharts(charts) {
  if (!charts) return '';
  const blocks = [];
  if (charts.episodes) {
    const marked = charts.episodes.points.some((point) => point.marked);
    blocks.push(readerChartBlock('話ごとのPV（各話の最新の記録。横は話数）',
      readerBarChart(charts.episodes.points),
      marked ? '色の違う棒が、離脱率の基準の話。' : ''));
  }
  if (charts.day) {
    blocks.push(readerChartBlock('日ごとのPV（作品全体）', readerBarChart(charts.day.points), ''));
  }
  if (charts.month) {
    blocks.push(readerChartBlock('月ごとのPV（作品全体）', readerBarChart(charts.month.points), ''));
  }
  if (charts.year) {
    blocks.push(readerChartBlock('年ごとのPV（作品全体）', readerBarChart(charts.year.points), ''));
  }
  if (charts.total) {
    blocks.push(readerChartBlock('作品全体のPV（取り込みごとの累計）',
      readerLineChart(charts.total.points), ''));
  }
  /*
    ブックマーク・評価ポイントの増減（残課題 B11 の続き。Narou.fun の日ごとの表から）。
    **減った日は0の線より下へ、赤で描く**（執筆量のグラフの「削った日」と同じ描き方）。
    数には符号を付ける——増減のグラフで「1」と書くと、増えたのか減ったのか読めない。
  */
  const periodNames = { day: '日', month: '月', year: '年' };
  (charts.changes || []).forEach((chart) => {
    const name = periodNames[chart.period] || '';
    const suffix = chart.unit ? chart.unit : ' ' + chart.label;
    const fell = chart.points.some((point) => point.value < 0);
    blocks.push(readerChartBlock(name + 'ごとの' + chart.label + 'の増減（作品全体）',
      readerBarChart(chart.points, suffix, true),
      fell ? '0の線より下の赤い棒は、前の' + name + 'より減った' + name + '。' : ''));
  });
  return blocks.join('');
}

/** 増減の数に符号を付ける（「+2」「−1」「0」）。負の記号は全角の幅で読みやすいマイナス */
function readerSignedCount(value) {
  if (value > 0) return '+' + formatCount(value);
  if (value < 0) return '−' + formatCount(-value);
  return '0';
}

function readerChartBlock(title, svgHtml, note) {
  return '<div class="site-sub">' + escapeHtml(title) + '</div>' + svgHtml +
    (note ? '<div class="site-foot">' + escapeHtml(note) + '</div>' : '');
}

/**
 * 目盛りを出す位置。**執筆量のグラフ（renderChart）と同じ間引き方**
 * ——本数とラベルの幅の両方で決め、右端（いちばん新しい点）から数える。
 */
function readerTickIndices(points, slot) {
  const maxLabelWidth = Math.max(1, ...points.map((point) => estimateLabelWidth(point.label)));
  const step = Math.max(
    Math.ceil(points.length / 12),
    Math.ceil((maxLabelWidth + 8) / slot),
    1
  );
  const shown = new Set();
  for (let i = points.length - 1; i >= 0; i -= step) shown.add(i);
  return shown;
}

/**
 * 棒グラフ。**執筆量のグラフと同じ作り**（.chart-wrap・.bar・.axis・.tick）。
 *
 * 話ごとは219本になることがあるので、本数が多いときは棒を細くする
 * （はみ出たぶんは .chart-wrap が横に送れる）。
 *
 * **負の値も描ける**（残課題 B11 の続き。ブックマークの増減）。負の棒は0の線より
 * 下へ、赤（.bar.negative）で描き、0の線はその分だけ上がる。負が無ければ0の線は
 * 下端のままで、PVのグラフはこれまでと同じ見た目になる。
 *
 * @param suffix 数のあとに付ける文字（既定は「 PV」）
 * @param signed 真なら数に符号を付ける（増減のグラフ）
 */
function readerBarChart(points, suffix, signed) {
  const count = points.length;
  const barWidth = count > 60 ? 4 : count > 30 ? 10 : 26;
  const gap = count > 60 ? 1 : count > 30 ? 3 : 6;
  const slot = barWidth + gap;
  const padLeft = 56;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 34;
  const plotHeight = 140;
  const width = padLeft + padRight + count * slot;
  const height = padTop + plotHeight + padBottom;
  const values = points.map((point) => point.value);
  const minValue = Math.min(0, ...values);
  // 負の無いグラフは、これまでどおり上端を1以上にする（0だけの日に高さ0で割らない）
  const maxValue = Math.max(minValue < 0 ? 0 : 1, ...values);
  const span = maxValue - minValue || 1;
  const baseY = padTop + plotHeight;
  // 0の線。負の日があれば、その分だけ上がる
  const zeroY = padTop + (maxValue / span) * plotHeight;
  const tail = suffix === undefined ? ' PV' : suffix;
  const show = (value) => (signed ? readerSignedCount(value) : formatCount(value));

  const parts = [];
  parts.push('<line class="axis" x1="' + padLeft + '" y1="' + zeroY + '" x2="' + width + '" y2="' + zeroY + '" />');
  if (maxValue > 0) {
    parts.push('<text class="tick" x="4" y="' + (padTop + 8) + '">' + show(maxValue) + '</text>');
  }
  parts.push('<text class="tick" x="4" y="' + (zeroY + 3) + '">0</text>');
  if (minValue < 0) {
    parts.push('<text class="tick" x="4" y="' + (baseY + 3) + '">' + show(minValue) + '</text>');
  }

  const shown = readerTickIndices(points, slot);
  points.forEach((point, index) => {
    const x = padLeft + index * slot;
    const barHeight = Math.max(point.value === 0 ? 0 : 1, (Math.abs(point.value) / span) * plotHeight);
    const y = point.value >= 0 ? zeroY - barHeight : zeroY;
    parts.push(
      '<rect class="bar' + (point.value < 0 ? ' negative' : '') + (point.marked ? ' mark' : '') +
      '" x="' + x + '" y="' + y +
      '" width="' + barWidth + '" height="' + barHeight + '" rx="1">' +
      '<title>' + escapeHtml(point.label + '  ' + show(point.value) + tail) + '</title>' +
      '</rect>'
    );
    // 基準の話は、目盛りの間引きに関係なく棒の上へ名前を出す
    if (point.marked) {
      parts.push(
        '<text class="tick" x="' + (x + barWidth / 2) + '" y="' + Math.max(10, y - 3) +
        '" text-anchor="middle">' + escapeHtml(point.label) + '</text>'
      );
    }
    if (shown.has(index)) {
      parts.push(
        '<text class="tick" x="' + (x + barWidth / 2) + '" y="' + (baseY + 16) +
        '" text-anchor="middle">' + escapeHtml(point.label) + '</text>'
      );
    }
  });
  return '<div class="chart-wrap"><svg width="' + width + '" height="' + height +
    '" viewBox="0 0 ' + width + ' ' + height + '">' + parts.join('') + '</svg></div>';
}

/**
 * 折れ線（作品全体のPVの伸び）。**縦軸は最小から最大まで**を使う——累計は
 * 0から引くと、伸びがほとんど平らに見える。上下の端に実際の数を書く。
 */
function readerLineChart(points) {
  const slot = 32;
  const padLeft = 72;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 34;
  const plotHeight = 140;
  const width = padLeft + padRight + points.length * slot;
  const height = padTop + plotHeight + padBottom;
  const values = points.map((point) => point.value);
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const span = maxValue - minValue || 1;
  const baseY = padTop + plotHeight;
  const xOf = (index) => padLeft + index * slot + slot / 2;
  const yOf = (value) => baseY - ((value - minValue) / span) * plotHeight;

  const parts = [];
  parts.push('<line class="axis" x1="' + padLeft + '" y1="' + baseY + '" x2="' + width + '" y2="' + baseY + '" />');
  parts.push('<text class="tick" x="4" y="' + (padTop + 8) + '">' + formatCount(maxValue) + '</text>');
  if (minValue !== maxValue) {
    parts.push('<text class="tick" x="4" y="' + (baseY + 3) + '">' + formatCount(minValue) + '</text>');
  }
  if (points.length > 1) {
    parts.push('<polyline class="line" points="' +
      points.map((point, index) => xOf(index) + ',' + yOf(point.value)).join(' ') + '" />');
  }
  const shown = readerTickIndices(points, slot);
  points.forEach((point, index) => {
    parts.push(
      '<circle class="dot" cx="' + xOf(index) + '" cy="' + yOf(point.value) + '" r="3">' +
      '<title>' + escapeHtml(formatWhen(point.key) + '  ' + formatCount(point.value) + ' PV') + '</title>' +
      '</circle>'
    );
    if (shown.has(index)) {
      parts.push(
        '<text class="tick" x="' + xOf(index) + '" y="' + (baseY + 16) +
        '" text-anchor="middle">' + escapeHtml(point.label) + '</text>'
      );
    }
  });
  return '<div class="chart-wrap"><svg width="' + width + '" height="' + height +
    '" viewBox="0 0 ' + width + ' ' + height + '">' + parts.join('') + '</svg></div>';
}

/** ラベル（小さく薄く）と数字の組。ラベルが空なら数字だけ置く */
function readerValue(label, valueHtml) {
  return '<div class="reader-value">' +
    (label ? '<span class="k">' + escapeHtml(label) + '</span>' : '') +
    '<span class="v">' + valueHtml + '</span></div>';
}

/**
 * 読者の反応の表（設計書6.79.7）。**1回の取り込み＝1行。**
 *
 * **見出しを付ける。** 順位の表と2つ並ぶので、どちらの数字なのかが
 * 列名だけでは分からない。
 *
 * **出す列は core 側が決める**（readerStatsColumns）。全行が同じ値の列は
 * 幅を食うだけで何も伝えず、表を折り返させていた。
 *
 * @param fold 古い記録を畳むか。話ごとの表は1回ぶんしか無いので畳まない
 */
function renderReaderStatsTable(table, title, fold) {
  if (!table || !table.rows || table.rows.length === 0) return '';
  const columns = table.columns || {};
  const head = ['<th>日時</th>'];
  if (columns.scope) head.push('<th>範囲</th>');
  // 粒度の列を無くしたので、「その時点」は見出しに1回だけ書く
  if (columns.snapshot) head.push('<th>反応（その時点）</th>');
  if (columns.day) head.push('<th>今日</th>');
  if (columns.month) head.push('<th>今月</th>');
  if (columns.other) head.push('<th>その他</th>');
  if (columns.source) head.push('<th>出どころ</th>');
  if (columns.note) head.push('<th>メモ</th>');

  const body = table.rows.map((row) => {
    const cells = ['<td>' + escapeHtml(formatWhen(row.readAt)) + '</td>'];
    if (columns.scope) cells.push('<td>' + escapeHtml(row.scope) + '</td>');
    if (columns.snapshot) cells.push('<td>' + escapeHtml(row.snapshot) + '</td>');
    if (columns.day) cells.push('<td>' + escapeHtml(row.day) + '</td>');
    if (columns.month) cells.push('<td>' + escapeHtml(row.month) + '</td>');
    if (columns.other) cells.push('<td>' + escapeHtml(row.other) + '</td>');
    if (columns.source) cells.push('<td>' + escapeHtml(row.source) + '</td>');
    if (columns.note) cells.push('<td>' + escapeHtml(row.note) + '</td>');
    return '<tr>' + cells.join('') + '</tr>';
  });

  const shown = fold ? body.slice(0, ${READER_STATS_VISIBLE_ROWS}) : body;
  const rest = fold ? body.slice(${READER_STATS_VISIBLE_ROWS}) : [];
  let html = title ? '<div class="site-sub">' + escapeHtml(title) + '</div>' : '';
  html += readerTableOf(head, shown);
  if (rest.length > 0) {
    html += '<details class="fold"><summary>これまでの記録（あと ' +
      formatCount(rest.length) + ' 件）</summary>' +
      readerTableOf(head, rest) + '</details>';
  }
  // 出どころが1種類なら、列にせず表の下へ1回だけ書く
  if (columns.onlySource) {
    html += '<div class="site-foot">すべて' + escapeHtml(columns.onlySource) +
      'で取り込んだものです。</div>';
  }
  return html;
}

function readerTableOf(head, body) {
  return '<table><thead><tr>' + head.join('') + '</tr></thead><tbody>' +
    body.join('') + '</tbody></table>';
}

/**
 * 話ごとの記録（設計書6.79.7）。**作品全体とは別の表にして、既定で畳む。**
 *
 * アクセス数のページは1回で50話ぶん入る（219話なら250行）ので、作品全体の
 * 行と混ぜると読めなくなる。**まだ1件も無ければ、この節ごと出さない。**
 */
function renderReaderEpisodes(table) {
  if (!table || !table.rows || table.rows.length === 0) return '';
  return '<details class="fold"><summary>話ごとの記録（' +
    formatCount(table.rows.length) + '話・最新 ' +
    escapeHtml(formatWhen(table.rows[0].readAt)) + '）</summary>' +
    renderReaderStatsTable(table, '', false) + '</details>';
}

/**
 * 表の下の注記。**あるものについてだけ言う**（0.33.9のレビュー）。
 *
 * 順位を1件も記録していない作品でも「順位は…」で始まっていたので、反応だけを
 * 記録している作者には身に覚えのない説明になっていた。どの但し書きも
 * 「サイトから自動で取ってこない」ことを言うためにある（6.68.1の線）。
 */
function siteRecordsNote(records) {
  const notes = [];
  if (records.some((record) => (record.history || []).length > 0)) {
    // 名前はメニューの字面に揃える（0.75.8）。メニューで探すときに
    // 見つからない名前を案内に書くと、押す場所が分からなくなる
    notes.push('順位は「ランキングを記録」で書き足した値。' +
      'サイトから自動で取ってこない。');
  }
  if (records.some((record) => record.readerLatest)) {
    notes.push('読者の反応は、手入力か、ご自身で開いた管理画面から' +
      '貼り付けたものだけ。');
  }
  // 分析リンクも「開くだけ」であることを、その場で言う（6.79.7）
  if (records.some((record) => record.analysisUrl)) {
    notes.push('分析（Narou.fun）はブラウザで開くだけ。' +
      '中身は読み取らない。');
  }
  return notes.join('');
}

/** 記録した日時。読めない値はそのまま出す（作者が手で書いたかもしれない） */
function formatWhen(value) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return when.getFullYear() + '/' + pad(when.getMonth() + 1) + '/' +
    pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes());
}

function renderEpisodes() {
  if (!state || !state.episodes) return;
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
  // **数字の出どころを黙って変えない。** 合本（1ファイルに複数話）は
  // 中の全話の合計なので平均・中央値から外してあり、そのことをその場で断る
  const collectedNote = summary.collectedFiles > 0
    ? '<div class="note">合本の ' + summary.collectedFiles +
      '件は、1話ぶんの長さではないため平均・中央値・長短の印から外しています' +
      '（合計字数には入っています）。</div>'
    : '';
  table.innerHTML = collectedNote +
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
  if (message.type === 'readerAdvice') {
    delete readerAdviceBusy[message.site];
    // 取りやめたときは、前の答えをそのまま残す（消すと見ていたものが消える）
    if (message.outcome && message.outcome.kind !== 'cancelled') {
      readerAdviceOutcomes[message.site] = message.outcome;
    }
    renderSiteRecords();
    return;
  }
  if (message.type !== 'stats') return;
  state = message.data;
  document.getElementById('title').textContent = state.title;
  renderGranularity();
  renderContest();
  renderCards();
  renderChart();
  renderDevices();
  renderSiteRecords();
  renderEpisodes();
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
