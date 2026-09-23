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
/* 棒の中身は SVG（meterSvg）。style 属性の幅は CSP に捨てられるため */
.meter { display: block; }
.meter-fill { fill: var(--vscode-charts-blue, #3794ff); }
.meter-fill.achieved { fill: var(--vscode-testing-iconPassed, #4caf50); }
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
.mini { height: 8px; background: var(--vscode-panel-border); border-radius: 4px; min-width: 60px; overflow: hidden; }
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
/* 達成の記録（設計書6.3.8）。どの目標をいつ達成したかを、控えめに並べる */
.achievements { margin: 0 0 18px; }
.achievements-head { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 4px; }
.achievement-row { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; padding: 2px 0; }
.achievement-row .mark {
  color: var(--vscode-testing-iconPassed, #4caf50);
  border: 1px solid var(--vscode-testing-iconPassed, #4caf50);
  border-radius: 10px;
  padding: 0 7px;
  font-size: 11px;
}
.achievement-row .day { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.achievement-row .streak { color: var(--vscode-descriptionForeground); }
.achievements-head .best { margin-left: 10px; }
/*
  祝い（設計書6.3.8）。**画面の操作を妨げない**——重ねる層は pointer-events: none
  にして、下のボタンやグラフはそのまま押せるようにする。数秒で消える。
*/
.celebrate-layer { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 20; }
.celebrate-banner {
  position: fixed;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 32px);
  pointer-events: none;
  z-index: 21;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid var(--vscode-testing-iconPassed, #4caf50);
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  text-align: center;
  line-height: 1.6;
  transition: opacity 0.6s;
}
.celebrate-banner .head { font-weight: 600; color: var(--vscode-testing-iconPassed, #4caf50); }
.celebrate-banner.fade { opacity: 0; }
/* 動きを減らす設定では、動かさずに「達成」の印だけを出す */
@media (prefers-reduced-motion: reduce) {
  .celebrate-banner { transition: none; }
}
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
    <div class="note" id="goal-link"></div>
    <div id="achievements"></div>
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

  // 募集要項は変わることがある。作者が確かめ直せるように残す。
  // 公募の一覧から入れた応募先は、いつの情報かを添える（設計書6.3.6.1）
  const links = [];
  if (contest.url) {
    // **拡張機能側へ頼んで開く**（openExternal）。画面の中から直接どこかへ繋がない
    links.push(
      '<a href="#" class="contest-link" data-contest-url="' + escapeHtml(contest.url) + '">募集要項を開く</a>'
    );
  }
  if (contest.asOf) {
    links.push(escapeHtml(contest.asOf) + '（応募の前に募集要項で確かめてください）');
  }
  if (links.length > 0) {
    rows.push('<div class="contest-detail">' + links.join(' ／ ') + '</div>');
  }

  const state2 = contest.overdue || contest.overMax ? ' warn' : '';
  box.innerHTML = '<div class="contest' + state2 + '">' + rows.join('') + '</div>';
  box.querySelectorAll('[data-contest-url]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: el.dataset.contestUrl });
    });
  });
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
        : '') +
      // 種類の目安（設計書6.109.7。読了 約12分・2ページ・3コマなど）。小説では来ない
      (state.totals.measure ? ' / ' + state.totals.measure : ''),
    null
  ));

  document.getElementById('cards').innerHTML = cards.join('');

  // 1日・1か月の目標を決める入口（作者の指摘、2026-09-23。設定画面で探させない）。
  // **拡張機能側へ頼んで開く**（画面の中で設定を書かない。書き先はユーザー全体の設定）
  const hasGoal = today.progress.goal > 0 || month.progress.goal > 0;
  const goalLink = document.getElementById('goal-link');
  goalLink.innerHTML =
    '<a href="#" data-common-goals="1">' +
    (hasGoal ? '1日・1か月の目標を変える' : '目標を決める（1日・1か月）') +
    '</a>（全作品共通）';
  goalLink.querySelectorAll('[data-common-goals]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'editCommonGoals' });
    });
  });
}

/**
 * 割合の棒（0〜100）。**幅を SVG の属性で持たせる。**
 *
 * この画面の CSP は style-src が nonce だけなので、HTML に書いた
 * style 属性（幅の指定）は捨てられる。0.83.4 まではそのせいで、今日の欄の棒が
 * 割合に関係なくいつも満杯の青に描かれ、話ごとの一覧の棒は何も出ていなかった
 * （ノートPCの実機確認、2026-09-23〜24。今日0字・あと10字で満杯）。
 * SVG の width 属性は CSP の対象外なので、呼ぶ側が後から幅を付け直す
 * 必要も無い（付け忘れれば同じ不具合に戻る）。
 *
 * @param percent 塗る割合。0未満は0、100超は100で止める
 * @param extraClass 塗りに足す class（達成の色など）
 */
function meterSvg(percent, extraClass) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  return (
    '<svg class="meter" viewBox="0 0 100 1" preserveAspectRatio="none" width="100%" height="100%">' +
    '<rect class="meter-fill' + (extraClass ? ' ' + extraClass : '') +
    '" x="0" y="0" width="' + value + '" height="1"></rect></svg>'
  );
}

function card(label, value, sub, progress) {
  const achieved = progress && progress.achieved;
  const bar = progress && progress.goal > 0
    ? '<div class="bar-outer">' + meterSvg(progress.rate, achieved ? 'achieved' : '') + '</div>'
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

/**
 * 目標の線の札（「目標 10」）をどこに置くか。
 *
 * 左の縦軸の位置が既定だが、**縦軸の数字と同じ高さに来ると重なって読めない**
 * （ノートPCの実機確認、2026-09-23〜24。目標10字で、どの日も10字未満だと
 * 目標の線がいちばん上になり、「目標 10」と「10字」が重なった）。
 * 目標が小さく0の線に近いときも同じことが起きる。
 * そのときと、札が左の余白に収まらない長さのときは、**右端へ寄せて線の上に
 * 載せる**（線の下だと、棒の頭と重なりやすい）。
 *
 * @param input.goalY 目標の線の高さ
 * @param input.occupiedYs 左に既に置いてある数字の高さ（文字の下端）
 * @param input.padLeft 左の余白（縦軸の数字の置き場）
 * @param input.width グラフ全体の幅
 * @param input.labelWidth 札の幅の見積もり（estimateLabelWidth）
 */
function goalLabelPlacement(input) {
  const leftY = input.goalY + 3;
  // 目盛りの字は10px。上下12px以内なら重なって見える
  const collides = input.occupiedYs.some((y) => Math.abs(y - leftY) < 12);
  const fits = 4 + input.labelWidth <= input.padLeft - 2;
  if (!collides && fits) return { x: 4, y: leftY, anchor: 'start' };
  return { x: input.width - 4, y: input.goalY - 3, anchor: 'end' };
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

  const topLabelY = padTop + 8;
  const zeroLabelY = zeroY + 3;
  const goalY = goal > 0 ? padTop + ((maxValue - goal) / span) * plotHeight : 0;
  if (goal > 0) {
    parts.push('<line class="goal-line" x1="' + padLeft + '" y1="' + goalY + '" x2="' + width + '" y2="' + goalY + '" />');
  }
  parts.push('<text class="tick" x="4" y="' + topLabelY + '">' + formatCount(maxValue) + '字</text>');
  parts.push('<text class="tick" x="4" y="' + zeroLabelY + '">0</text>');

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

  // 目標の札は**棒のあとに描く**。右端へ寄せたとき、棒に隠れないように
  if (goal > 0) {
    const goalText = '目標 ' + formatCount(goal);
    const spot = goalLabelPlacement({
      goalY: goalY,
      occupiedYs: [topLabelY, zeroLabelY],
      padLeft: padLeft,
      width: width,
      labelWidth: estimateLabelWidth(goalText),
    });
    parts.push(
      '<text class="tick goal-label" x="' + spot.x + '" y="' + spot.y +
      '" text-anchor="' + spot.anchor + '">目標 ' + formatCount(goal) + '</text>'
    );
  }

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

/**
 * AIの答え（見立て・良いところ・見てほしい所）。
 *
 * 良いところを見てほしい所より先に出し、折りたたまない（プロンプト設計書1.9、
 * 作者の方針 2026-09-24「ほめることができる場所は、省略せずきちんとほめて」）。
 * 見てほしい所が0件なら、そう明記する——空の欄を黙って消すと、
 * AIが答えなかったのか、直す所が無いのかが作者に分からない。
 */
function renderReaderAdviceAnswer(outcome) {
  const answer = outcome.answer || {};
  const parts = [];
  if (answer.summary) {
    parts.push('<div class="advice-summary">' + escapeHtml(answer.summary) +
      readerAdviceMarks(answer.summaryMarks) + '</div>');
  }
  const strengths = answer.strengths || [];
  if (strengths.length > 0) {
    parts.push('<div class="advice-title">良いところ</div>');
    strengths.forEach((item) => {
      parts.push('<div class="advice-item advice-strength">' +
        (item.title ? '<div class="advice-title">' + escapeHtml(item.title) + '</div>' : '') +
        '<div>' + escapeHtml(item.body) + '</div></div>');
    });
  }
  const points = answer.points || [];
  parts.push('<div class="advice-title">確かめてほしい所</div>');
  if (points.length === 0) {
    parts.push('<div class="advice-item">直すべき所は見当たりません。</div>');
  }
  points.forEach((point) => {
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
    notes.push('順位は「ランキング記録」で書き足した値。' +
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
  ].concat(
    // 種類の目安（設計書6.109.7）。小説では来ないので、カードは4枚のまま
    summary.totalMeasureShort
      ? [card('種類の目安', summary.totalMeasureShort, summary.totalMeasure || '', null)]
      : []
  ).join('');

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
  // 種類の目安の列（設計書6.109.7）。**どの話にも目安が無ければ列ごと出さない**
  // ——小説の一覧は、これまでと同じ列のまま
  const hasMeasure = rows.some((row) => row.measure);
  table.innerHTML = collectedNote +
    '<table><thead><tr>' +
    '<th>話</th><th>タイトル</th><th class="num">純文字数</th><th class="num">原稿用紙</th>' +
    (hasMeasure ? '<th class="num">目安</th>' : '') +
    '<th class="num">平均比</th><th>長さ</th></tr></thead><tbody>' +
    rows.map((row) => {
      if (row.conflicted) {
        return '<tr class="clickable" data-path="' + escapeHtml(row.filePath) + '">' +
          '<td>' + escapeHtml(row.chapterLabel || '—') + '</td>' +
          '<td>' + escapeHtml(row.title || row.fileName) + '</td>' +
          '<td class="num conflicted" colspan="' + (hasMeasure ? 5 : 4) + '">⚠ 未解決の競合（未集計）</td></tr>';
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
        (hasMeasure ? '<td class="num">' + escapeHtml(row.measure || '—') + '</td>' : '') +
        '<td class="num">' + Math.round(row.ratio * 100) + '%</td>' +
        '<td><div class="mini">' + meterSvg(Math.round((row.net / maxNet) * 100), '') +
        '</div>' + flag + '</td></tr>';
    }).join('') +
    '</tbody></table>';

  table.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'open', filePath: el.dataset.path });
    });
  });
}

/* ── 目標の達成を祝う（設計書6.3.8） ── */

/**
 * 達成の記録。**どの目標をいつ達成したか**を残す。
 * 風船は数秒で消えるが、この印は残る（動きを減らす設定では、印だけになる）。
 */
function renderAchievements() {
  const host = document.getElementById('achievements');
  const rows = (state && state.achievements) || [];
  if (rows.length === 0) {
    host.innerHTML = '';
    return;
  }
  const best = streakHeadline(state.achievementStreaks);
  host.innerHTML =
    '<div class="achievements"><div class="achievements-head">達成の記録' +
    (best ? '<span class="best">' + escapeHtml(best) + '</span>' : '') +
    '</div>' +
    rows.map((row) =>
      '<div class="achievement-row"><span class="mark">達成</span>' +
      '<span class="day">' + escapeHtml(row.day) + '</span>' +
      '<span>' + escapeHtml(row.text) + '</span>' +
      (row.streak ? '<span class="streak">' + escapeHtml(row.streak) + '</span>' : '') +
      '</div>'
    ).join('') +
    '</div>';
}

/**
 * 最長の連続（1日・1か月）。**途切れたことは言わない**——いまの連続ではなく
 * これまでの最長だけを出す（作者の裁定、2026-09-23）。拡張機能は2以上のときだけ送る。
 */
function streakHeadline(streaks) {
  if (!streaks) return '';
  const parts = [];
  if (typeof streaks.dailyBest === 'number') parts.push('最長 ' + streaks.dailyBest + '日連続');
  if (typeof streaks.monthlyBest === 'number') parts.push('最長 ' + streaks.monthlyBest + 'か月連続');
  return parts.join('・');
}

/**
 * 上げ終えた祝いの鍵。**同じ祝いを二度上げない。** 保存が続くと、
 * 「見せ終えた」が拡張機能へ届く前に同じ祝いがもう一度送られてくることがある。
 */
const playedCelebrations = new Set();
/** 風船と花火を出しておく長さ。数秒で消え、書く手を待たせない */
const CELEBRATION_MS = 4500;
const CELEBRATION_COLORS = ['#f25f5c', '#ffcf3f', '#4cc9a0', '#4ea8ff', '#b983ff', '#ff8c42'];

function reducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function celebrate(payload) {
  if (!payload || !Array.isArray(payload.ids)) return;
  const fresh = payload.ids.filter((id) => !playedCelebrations.has(id));
  if (fresh.length === 0) return;
  fresh.forEach((id) => playedCelebrations.add(id));
  showCelebrationBanner(Array.isArray(payload.lines) ? payload.lines : []);
  if (!reducedMotion()) runCelebration(payload.size, payload.balloons);
  vscode.postMessage({ type: 'celebrated', ids: payload.ids });
}

/** 何を達成したかの札。動きを減らす設定でも出す（これが「達成」の印になる） */
function showCelebrationBanner(lines) {
  const banner = document.createElement('div');
  banner.className = 'celebrate-banner';
  banner.setAttribute('role', 'status');
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = 'おめでとうございます';
  banner.appendChild(head);
  lines.forEach((line) => {
    const row = document.createElement('div');
    row.textContent = line;
    banner.appendChild(row);
  });
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add('fade'), CELEBRATION_MS);
  setTimeout(() => banner.remove(), CELEBRATION_MS + 800);
}

/** 終わり際は全体を薄くして消す（ぱっと消えると、かえって目が引かれる） */
function celebrationAlpha(elapsed) {
  return elapsed > CELEBRATION_MS - 600
    ? Math.max(0, (CELEBRATION_MS - elapsed) / 600)
    : 1;
}

/**
 * 描く風船の数。拡張機能から届いた数を使い、届かない・壊れていれば
 * 大きさから決める（size === 'small' ? 5 : 12。連続を数える前の版と同じ）。
 * **40個で止める**——拡張機能側の上限（1日24個・1か月30個）より余裕を持たせた
 * 画面側の歯止めで、届いた値がどうであれ画面を埋め尽くさない。
 */
function balloonCountFor(size, balloons) {
  if (typeof balloons !== 'number' || !Number.isFinite(balloons)) {
    return size === 'small' ? 5 : 12;
  }
  return Math.max(1, Math.min(40, Math.round(balloons)));
}

/**
 * 風船（と花火）を描く。**外部のライブラリは使わず Canvas で描く**
 * （WebView の CSP を緩めずに済み、配布物も重くならない）。
 *
 * - small（1日の目標）：風船を少し
 * - balloons（1か月の目標）：風船をたくさん
 * - fireworks（作品の文字量・締切、連続の節目・最長を超えた日）：風船に花火を足す
 *
 * 風船の数は拡張機能が決めて送る（連続が続くほど増える。core/celebrationStreaks.ts）。
 */
function runCelebration(size, balloons) {
  const canvas = document.createElement('canvas');
  canvas.className = 'celebrate-layer';
  canvas.setAttribute('aria-hidden', 'true');
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  document.body.appendChild(canvas);
  ctx.scale(ratio, ratio);

  const pick = () => CELEBRATION_COLORS[Math.floor(Math.random() * CELEBRATION_COLORS.length)];
  const balloonCount = balloonCountFor(size, balloons);
  const flock = [];
  for (let index = 0; index < balloonCount; index++) {
    const radius = 14 + Math.random() * 10;
    flock.push({
      x: (width * (index + 0.5)) / balloonCount + (Math.random() - 0.5) * 40,
      y: height + radius * 2 + Math.random() * height * 0.35,
      radius,
      // 画面の下から上まで、3〜4秒ほどで抜ける速さ
      speed: (height + 200) / (3000 + Math.random() * 1200),
      phase: Math.random() * Math.PI * 2,
      color: pick(),
    });
  }

  const bursts = [];
  if (size === 'fireworks') {
    for (let index = 0; index < 5; index++) {
      bursts.push({
        at: 250 + index * 550,
        x: width * (0.2 + Math.random() * 0.6),
        y: height * (0.15 + Math.random() * 0.3),
        color: pick(),
        done: false,
      });
    }
  }
  const sparks = [];

  const start = performance.now();
  let last = start;
  function frame(now) {
    const elapsed = now - start;
    const step = Math.min(50, now - last);
    last = now;
    ctx.clearRect(0, 0, width, height);
    const alpha = celebrationAlpha(elapsed);
    ctx.globalAlpha = alpha;

    flock.forEach((balloon) => {
      const y = balloon.y - balloon.speed * elapsed;
      const x = balloon.x + Math.sin(elapsed / 650 + balloon.phase) * 12;
      const r = balloon.radius;
      // 糸
      ctx.strokeStyle = 'rgba(127, 127, 127, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + r * 1.15);
      ctx.quadraticCurveTo(x + Math.sin(elapsed / 300 + balloon.phase) * 5, y + r * 1.15 + 18, x, y + r * 1.15 + 36);
      ctx.stroke();
      // 風船
      ctx.fillStyle = balloon.color;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.85, r * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      // 結び目
      ctx.beginPath();
      ctx.moveTo(x - 3, y + r * 1.18);
      ctx.lineTo(x + 3, y + r * 1.18);
      ctx.lineTo(x, y + r * 1.05);
      ctx.fill();
      // 光
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.beginPath();
      ctx.ellipse(x - r * 0.3, y - r * 0.4, r * 0.18, r * 0.3, -0.5, 0, Math.PI * 2);
      ctx.fill();
    });

    bursts.forEach((burst) => {
      if (burst.done || elapsed < burst.at) return;
      burst.done = true;
      const count = 36;
      for (let index = 0; index < count; index++) {
        const angle = (Math.PI * 2 * index) / count;
        const power = 0.12 + Math.random() * 0.08;
        sparks.push({
          x: burst.x,
          y: burst.y,
          vx: Math.cos(angle) * power,
          vy: Math.sin(angle) * power,
          born: elapsed,
          life: 1100 + Math.random() * 500,
          color: Math.random() < 0.7 ? burst.color : pick(),
        });
      }
    });
    for (let index = sparks.length - 1; index >= 0; index--) {
      const spark = sparks[index];
      const age = elapsed - spark.born;
      if (age > spark.life) {
        sparks.splice(index, 1);
        continue;
      }
      spark.vy += 0.00012 * step;
      spark.x += spark.vx * step;
      spark.y += spark.vy * step;
      ctx.globalAlpha = Math.min(alpha, 1 - age / spark.life);
      ctx.fillStyle = spark.color;
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (elapsed < CELEBRATION_MS) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'celebrate') {
    celebrate(message.payload);
    return;
  }
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
  renderAchievements();
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
