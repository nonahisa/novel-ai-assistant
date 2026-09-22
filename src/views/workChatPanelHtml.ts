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
 *
 * ## 面の行き来（作者の指定、2026-09-03）
 *
 * 詳細メニューから相談の項目を消したので、**画面の中で行き来できないと
 * 大きく開く道が無くなる**。入力欄の下に、いま居ない側へ移るボタンを
 * 1つだけ出す（横なら「メインに表示」、大きい画面なら「サブに戻す」）。
 * 両方に両方を出すと、どちらが今の面なのか読めなくなる。
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
/*
  いま使っているAIの名前。**押すとAI設定が開く**（作者の指摘、2026-09-06）。
  リンクの色で出ているのに押せなかったので、見た目どおりに押せるようにした。
*/
#context-provider {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
#context-provider:hover { text-decoration: underline; }
/* 有料のときは警告の色を優先する（課金の注意は、リンクより先に伝える） */
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
/*
  **番号の枠を記号に流用しない**（作者の指摘、2026-09-07）。

  「↻」「▶」を .num（番号の枠）に入れていたため、幅の決まった小さな枠に
  押し込まれて**「ひ」のように潰れて見えた**。記号は幅を決めず、
  数字揃え（tabular-nums）も掛けない。
*/
.option .mark {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
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
  /* 横の細いパネルではボタンが収まらない。折り返して全部見せる */
  flex-wrap: wrap;
}
#composer .hint {
  flex: 1;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
/*
 * 聞き方の例（作者の要望、2026-09-22）。
 *
 * **入力欄のすぐ上に、小さく横並びで置く。** 空の入力欄の前では、
 * 何を打てば何が返るのかが分からない。**押しても送らない**ので、
 * 実行の色（button.action）は使わず、控えめな枠だけにする。
 * 横の細いパネルでも折り返して全部見せる。
 */
#examples {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.example {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  padding: 2px 10px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
}
.example:hover {
  color: var(--vscode-foreground);
  border-color: var(--vscode-focusBorder);
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
 * 「ほかにできること」——作業の提案を畳んでおく枠（作者の指摘、2026-09-08
 * 「AIの相談の青枠部分は何を意図しているのかわかりにくいです。
 * 求めていないので、頼まれてからやればいい気がします」）。
 *
 * 質問1つに対して、資料を書き換える提案とAIを回す提案が3つ並んでいた。
 * **押す前に読める形にはなったが、そもそも出さないほうがよい。**
 * 1行だけ置いて、作者が押したときに並べる。
 *
 * 見出しの1行は**ボタンだが、ボタンに見せない**。答えのすぐ下で
 * 目立たせると、畳んだ意味が無くなる。
 */
.more { margin-top: 8px; }
.more-toggle {
  background: none;
  border: none;
  padding: 0;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  text-align: left;
}
.more-toggle:hover { text-decoration: underline; }
/*
 * 読者タイプの区分（設計書6.91.9.2）。
 *
 * **畳んで置く。** AIへ添えた回にだけ出るとはいえ、11行の一覧が
 * 答えの下に開いたまま並ぶと、答えそのものが押し下げられる。
 */
.glossary { margin-top: 8px; font-size: 12px; }
.glossary summary {
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
}
.glossary ul { margin: 6px 0 0; padding-left: 18px; }
.glossary li { margin-bottom: 4px; }
/* この作品の区分だけ、目で拾えるようにする（色だけに頼らない） */
.glossary li.mine { font-weight: 600; }
/*
 * 画面で指しながらの案内（設計書6.104）。
 *
 * **1段につき1枚の札を積む。** 差し替えにすると、どこまで進んだかが
 * 会話から消える。済んだ札は色を落として押せなくする（同じ札が2枚
 * 押せる状態で並ぶと、どちらを押したのか分からなくなる）。
 *
 * 枠の色は「書き終えた結果」（.edit）と分ける。**あちらは済んだこと、
 * こちらはこれから押すこと**なので、同じ見た目にすると混ざる。
 */
.tour {
  margin-top: 8px;
  border: 1px solid var(--vscode-textLink-foreground);
  border-left-width: 3px;
  border-radius: 3px;
  padding: 8px;
}
.tour .position {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}
.tour .what { font-weight: 600; margin-bottom: 4px; }
.tour .why, .tour .check, .tour .needs, .tour .where {
  font-size: 12px;
  line-height: 1.6;
  color: var(--vscode-foreground);
}
.tour .where, .tour .needs {
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
}
.tour .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
/* 済んだ札。**消さずに残す**——どこを通ってきたかが会話に残る */
.tour.sealed { opacity: 0.55; border-left-color: var(--vscode-panel-border); }
/*
 * 本文の領域に大きく開いたとき。
 *
 * **画面いっぱいの幅で文章を流さない。** 横に長い行は目が戻る場所を
 * 見失う。読みやすい幅に抑えつつ、**左へ寄せる**（作者の指定、2026-08-29
 * 「回答は左寄せにしてください」——中央寄せは読み出しの位置が
 * 画面の途中から始まり、視線の起点が定まらなかった）。
 * 入力欄は少し高くする（大きく開いた＝長めに書きたい、ということである）。
 */
body.large #log > *,
body.large #composer > * {
  max-width: 62em;
  margin-left: 0;
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
  <!-- 聞き方の例。中身は拡張機能側から届いたものをその都度作り直す
       （読者像が決まっていれば札が1つ減る）ので、入れ物だけ置く -->
  <div id="examples"></div>
  <textarea id="input" placeholder="聞きたいことを書いてください（Ctrl+Enterで送信）"></textarea>
  <div class="row">
    ${
      large
        ? `<button class="action secondary" id="to-sub">サブに戻す</button>`
        : `<button class="action secondary" id="to-main">メインに表示</button>`
    }
    <button class="action secondary" id="apply-settings" disabled>相談を資料へ反映</button>
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
/** 流れてきた思考。答えが出たら捨てる */
let thought = '';
/** 画面に出す思考の長さ。長すぎると入力欄まで押し下げる */
const THOUGHT_TAIL = 120;
const hintEl = document.getElementById('hint');
// ツールバーは大きく開いたときにしか無い。**必ず有無を確かめてから使う**
const chooseWorkEl = document.getElementById('choose-work');
const saveNoteEl = document.getElementById('save-note');
const openManualEl = document.getElementById('open-manual');
const quickRunListEl = document.getElementById('quickrun-list');
// 聞き方の例。**両方の面に出す**（横のパネルでこそ、何を聞けるか分からない）
const examplesEl = document.getElementById('examples');
// 面を移るボタンは、いま居ない側のぶんが1つだけ在る。
// **どちらの面でも同じ書き方で扱う**ので、片方は必ず null になる
const toMainEl = document.getElementById('to-main');
const toSubEl = document.getElementById('to-sub');
// 「相談を資料へ反映」（設計書6.72）。**両方の面に置く**——
// 横のパネルで相談を終えたときに、大きく開き直させない
const applyToSettingsEl = document.getElementById('apply-settings');

/** 直前の返事に付いていた選択肢。番号入力で選べるようにする */
let currentOptions = [];
/** 「できること」に並べる機能。拡張機能側から届く */
let quickRuns = [];
/** 聞き方の例。拡張機能側から届く（core/chatExamples.ts） */
let examples = [];
let busy = false;
/**
 * これまでに返ってきた答えの数（設計書6.72）。
 *
 * **1往復も無い会話は資料へ反映できない。** 押せてしまうと、AIを呼んで
 * 「何も見つかりませんでした」と返るだけの空振りになる。
 */
let exchanges = 0;
/** 資料へ反映している最中か。**返事が来るまで二度押しさせない** */
let applying = false;

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
  /*
    **答えを待っている間は、面を移らせない。**

    会話そのものは拡張機能側が1つだけ持っているので失われないが、
    横へ戻すほうはこの画面を閉じる。返事が届く前に閉じると、
    まだ履歴に積まれていない今の質問だけが、移った先に出ない。
  */
  if (toMainEl) toMainEl.disabled = value;
  if (toSubEl) toSubEl.disabled = value;
  updateApplyState();
  document.querySelectorAll('.option').forEach((el) => {
    el.disabled = value;
  });
}

/**
 * 「相談を資料へ反映」が押せるかを決める。
 *
 * 押せるのは**答えが1つ以上あって、いま何も走っていないとき**だけ。
 * 3つの条件を1か所で見るのは、押せる・押せないの判断が散らばると
 * 「考え中なのに押せる」ような取りこぼしが必ず出るためである。
 */
function updateApplyState() {
  if (!applyToSettingsEl) return;
  applyToSettingsEl.disabled = busy || applying || exchanges === 0;
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
  // 会話が消えたのだから、資料へ反映するものも無くなる
  exchanges = 0;
  updateApplyState();
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
 * 聞き方の例を作り直す（作者の要望、2026-09-22）。
 *
 * **押しても送らない。** 入力欄へ入れて、焦点を移すだけである。
 * そのまま送ると、直す気の無い言い回しでAIを呼ぶことになり
 * （クラウドならそのまま料金になる）、自分の作品の言葉へ書き換える
 * 隙も無くなる。
 *
 * **一覧は拡張機能側から届いたものだけを出す**（「できること」と同じ）。
 * 画面へ書き写すと、当たらない言い方になったときに気づけない
 * ——どの例も手順書きに当たることは core/chatExamples.ts の試験が見る。
 */
function renderExamples() {
  if (!examplesEl) return;
  examplesEl.replaceChildren();
  examples.forEach((text) => {
    const button = document.createElement('button');
    button.className = 'example';
    button.textContent = text;
    button.title = '入力欄に入れます（送りません）';
    button.addEventListener('click', () => {
      inputEl.value = text;
      // 書き換えてから送れるように、焦点は入力欄へ渡す
      inputEl.focus();
      updateHint();
    });
    examplesEl.appendChild(button);
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

/**
 * エラーの下に「直し方」の札を並べる（2026-09-23）。
 *
 * **文章で設定の場所を説明しても、作者は辿り着けていなかった。**
 * 実際、待ち時間を延ばしてあるAIと既定のままのAIが混ざっていた。
 * 押すと拡張機能側が設定を書く——**押されるまでは何も変わらない。**
 */
function appendErrorActions(turn, actions) {
  if (!actions.length) return;
  const box = document.createElement('div');
  box.className = 'options';
  actions.forEach((action) => {
    const button = document.createElement('button');
    button.className = 'option';
    button.innerHTML =
      '<span class="mark">設定</span>' +
      '<span>' + escapeHtml(action.label) + '</span>';
    button.addEventListener('click', () => {
      // 一度きり。二度押しで同じ設定をもう一度書かせない
      button.disabled = true;
      vscode.postMessage({ type: 'errorAction', command: action.command });
    });
    box.appendChild(button);
  });
  turn.appendChild(box);
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
 * **書き終えた結果**を出す（作者の裁定、2026-09-21）。
 *
 * 以前はここで「書き込みの提案」を出し、押されてから書いていた。
 * 実機で通したところ、作者が「これで書いてください」と頼んだあとに
 * 畳まれたボタンを開いて押し、さらに確認へ答える形になっていた。
 * 「頼んでいるのだから、書き込みはした上で次へ行くべきでは？」
 *
 * **押させるのは「取り消す」のほうである。** 訊かずに書くのだから、
 * 何が入ったのかと、戻す道を同じ場所に出す。
 */
function appendEditDone(message) {
  const box = document.createElement('div');
  box.className = 'edit';
  box.dataset.editId = message.id;

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = message.label;
  box.appendChild(what);

  // **入った中身は全文を出す。** 訊かずに書くのだから、
  // 何が入ったのかを読めないままにはしない
  const preview = document.createElement('div');
  preview.className = 'preview';
  preview.textContent = message.preview;
  box.appendChild(preview);

  const done = document.createElement('div');
  done.className = 'done';
  done.textContent = message.message;
  box.appendChild(done);

  const row = document.createElement('div');
  row.className = 'options';
  const undo = document.createElement('button');
  undo.className = 'option';
  undo.innerHTML = '<span class="mark">↺</span><span>取り消す</span>';
  undo.addEventListener('click', () => {
    if (busy) return;
    undo.disabled = true;
    vscode.postMessage({ type: 'undoEdit', id: message.id });
  });
  row.appendChild(undo);
  box.appendChild(row);

  logEl.appendChild(box);
}

/**
 * 標準機能の起動を勧める。
 *
 * **押すまで動かない。** AIを呼ぶ機能は料金がかかるので、
 * 押す前にそれが分かるようにする。
 */
function appendRun(host, run) {
  const box = document.createElement('div');
  box.className = 'edit';
  box.dataset.editId = run.id;

  const row = document.createElement('div');
  row.className = 'options';
  const button = document.createElement('button');
  button.className = 'option';
  button.innerHTML =
    '<span class="mark">▶</span><span>' +
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
  host.appendChild(box);
}

/**
 * 「AIで再読込」を勧める（設計書6.31.3）。
 *
 * **押すまで何も起きない。** 書き込みの提案と同じ作法で、どの記録を
 * どんな留意点で読み直すのかを先に見せる。読み直した結果もそのまま
 * 保存されるわけではなく、設定資料の画面に項目ごとの提案として並ぶ。
 */
function appendReload(host, reload) {
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
    // 「↻」は作者の環境で潰れて見えた。**漢字は必ず描ける**
    '<span class="mark">再</span><span>' +
    escapeHtml(reload.label) +
    '（AIを使います）</span>';
  button.addEventListener('click', () => {
    if (busy) return;
    button.disabled = true;
    vscode.postMessage({ type: 'reload', id: reload.id });
  });
  row.appendChild(button);
  box.appendChild(row);
  host.appendChild(box);
}

/**
 * 作業の提案（書き込み・機能の起動・資料の読み直し）を**畳んで**置く。
 *
 * 作者の指摘（2026-09-08）「求めていないので、頼まれてからやればいい
 * 気がします」。答えの下に、資料を書き換える提案とAIを回す提案が
 * 3つ並んでいた。**出さないのではなく、1行にして押されるまで開かない。**
 * 拡張機能側の staged の仕組み（何を提案するか・押したら何が起きるか）は
 * そのままなので、押せば従来どおり動く。
 *
 * **「そこを見せて」（locate）はここへ入れない。** あれは作業ではなく
 * 「その根拠を見せて」という参照であり、答えを読むための道具である。
 */
function appendStagedActions(turn, message) {
  const adders = [];
  // **書き込み（edit）はここへ入れない**（2026-09-21の裁定）。頼まれた
  // 作業なので、押させずにその場で書き、結果を editDone で出す
  if (message.run) adders.push((host) => appendRun(host, message.run));
  if (message.reload) adders.push((host) => appendReload(host, message.reload));
  if (adders.length === 0) return;

  const box = document.createElement('div');
  box.className = 'more';

  const body = document.createElement('div');
  body.className = 'more-body';
  body.hidden = true;
  adders.forEach((add) => add(body));

  const toggle = document.createElement('button');
  toggle.className = 'more-toggle';
  toggle.type = 'button';
  const caption = (open) =>
    'ほかにできること（' + adders.length + '件）を' + (open ? '隠す' : '見る');
  toggle.textContent = caption(false);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = caption(!body.hidden);
    toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    scrollToBottom();
  });

  box.appendChild(toggle);
  box.appendChild(body);
  turn.appendChild(box);
}

/**
 * 読者タイプの区分の一覧を、答えの下に**畳んで**置く（設計書6.91.9.2）。
 *
 * 作者の実機報告、2026-09-22「相談で読者タイプの一覧が添えられていません」
 * ——AIへは渡していた（questionMentionsReader）が、**作者の目には
 * 見えていなかった。** 一覧はこの拡張機能が持っている決まりなので、
 * AIに書かせず、拡張機能側が READER_TYPES から並べて送ってくる。
 *
 * 診断済みなら、その作品の区分に印を付ける（どれが自分か分からないと、
 * 並べただけでは比べられない）。
 */
function appendReaderGlossary(turn, entries) {
  if (!entries || entries.length === 0) return;
  const box = document.createElement('details');
  box.className = 'glossary';

  const head = document.createElement('summary');
  head.textContent = '読者タイプの区分（' + entries.length + '）';
  box.appendChild(head);

  const list = document.createElement('ul');
  entries.forEach((entry) => {
    const item = document.createElement('li');
    if (entry.mine) item.className = 'mine';
    item.textContent =
      entry.label + '……' + entry.summary + (entry.mine ? ' ← この作品' : '');
    list.appendChild(item);
  });
  box.appendChild(list);
  turn.appendChild(box);
}

/*
  答えの中で名指しされたメニュー項目の札（設計書6.104。0.75.6。
  作者の指示、2026-09-22「AIからの回答で点滅すると良い」）。

  **何度でも押せる。** 目を離している間にツリーの選択が動くので、
  無効化すると見失ったときに戻れなくなる（「もう一度光らせる」と同じ考え）。
  **押しても操作は走らない**——光るだけである。
*/
function appendSpotlight(turn, entries) {
  if (!entries || entries.length === 0) return;
  const box = document.createElement('div');
  box.className = 'options';
  entries.forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'option';
    button.innerHTML =
      '<span class="mark">▶</span><span>光らせる：' +
      escapeHtml(entry.label) +
      '</span>';
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'spotlight', command: entry.command });
    });
    box.appendChild(button);
  });
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
    '<span class="mark">◎</span><span>' + escapeHtml(locate.label) + '</span>';
  button.addEventListener('click', () => {
    vscode.postMessage({ type: 'locate', id: locate.id });
  });
  row.appendChild(button);
  box.appendChild(row);
  turn.appendChild(box);
}

/*
  画面で指しながらの案内（設計書6.104）。

  **誘うところと、案内そのものを分ける。** 答えのすぐ下に出るのは
  「案内しましょうか」の1行だけで、押されて初めて段の札が出る。
  聞いただけの回にサイドバーが動くと、作者の手元を横取りすることになる。
*/
function appendTourOffer(turn, tour) {
  const box = document.createElement('div');
  box.className = 'options';
  const button = document.createElement('button');
  button.className = 'option';
  button.innerHTML =
    '<span class="mark">▶</span><span>画面で案内してもらう：' +
    escapeHtml(tour.title) +
    '（' + tour.steps + '手順）</span>';
  button.addEventListener('click', () => {
    if (busy) return;
    button.disabled = true;
    vscode.postMessage({ type: 'startTour', key: tour.key });
  });
  box.appendChild(button);
  turn.appendChild(box);
}

/**
 * 済んだ札を押せなくする。
 *
 * **消さない。** どこを通ってきたかが会話に残るほうが、あとで
 * 同じことをするときに役に立つ。
 */
function sealTourCards() {
  document.querySelectorAll('.tour:not(.sealed)').forEach((box) => {
    box.classList.add('sealed');
    box.querySelectorAll('button').forEach((el) => { el.disabled = true; });
  });
}

/**
 * 案内の1段を出す。
 *
 * 出すのは6つ——**いま何番目か／何をするか／次へ進む前に何を見るか／
 * 代わりに押して／もう一度光らせる／やめる**。「やめる」を毎段に置くのは、
 * **途中でいつでも抜けられること**が見えていないと、始めるのが怖いからである。
 */
function appendTourStep(step, where) {
  sealTourCards();
  emptyEl.hidden = true;

  const box = document.createElement('div');
  box.className = 'tour';

  const position = document.createElement('div');
  position.className = 'position';
  position.textContent = step.title + '｜' + step.position;
  box.appendChild(position);

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = step.number + '. ' + step.label;
  box.appendChild(what);

  const why = document.createElement('div');
  why.className = 'why';
  why.textContent = step.why;
  box.appendChild(why);

  const check = document.createElement('div');
  check.className = 'check';
  check.textContent = '次へ進む前に：' + step.check;
  box.appendChild(check);

  // 前提（「先に『設定資料』が要ります。」）は、押す直前に読めないと意味がない
  if (step.prerequisiteNote) {
    const needs = document.createElement('div');
    needs.className = 'needs';
    needs.textContent = step.prerequisiteNote;
    box.appendChild(needs);
  }

  // **光らせられたかを正直に出す。** 見つからなかったのに黙っていると、
  // 作者は画面のどこにも無いものを探すことになる
  const whereLine = document.createElement('div');
  whereLine.className = 'where';
  whereLine.textContent = where;
  box.appendChild(whereLine);

  const row = document.createElement('div');
  row.className = 'row';

  // **既定は作者が押す。** これは急ぐ人のための道であって、
  // 押しても押さなくても次の段へは同じように進む
  const run = document.createElement('button');
  run.className = 'action secondary';
  run.textContent = '代わりに押して';
  run.addEventListener('click', () => {
    run.disabled = true;
    vscode.postMessage({ type: 'tourRun' });
  });
  row.appendChild(run);

  // **押せるままにしておく**（作者の報告、2026-09-22「もう一度光らせる
  // とかいるかも」）。目を離している間に選択が動くので、何度でも呼べる
  const again = document.createElement('button');
  again.className = 'action secondary';
  again.textContent = 'もう一度光らせる';
  again.addEventListener('click', () => {
    vscode.postMessage({ type: 'tourAgain' });
  });
  row.appendChild(again);

  const stop = document.createElement('button');
  stop.className = 'action secondary';
  stop.textContent = 'やめる';
  stop.addEventListener('click', () => {
    vscode.postMessage({ type: 'tourStop' });
  });
  row.appendChild(stop);

  box.appendChild(row);
  logEl.appendChild(box);
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

/*
  上に出ているAIの名前を押したら、AI設定を開く（作者の指摘、2026-09-06）。

  リンクの色で出ているのに押せなかった。**押せそうに見えるものは押せる**
  ようにする。AIが分からないとき（名前が空）は、開く先が意味を持たないので
  何もしない。コマンド名は拡張機能側が持つ（画面からコマンドを呼ばない）。
*/
document.getElementById('context-provider').addEventListener('click', () => {
  if (!document.getElementById('context-provider').textContent) return;
  vscode.postMessage({ type: 'openAISettings' });
});

/*
  面を移る。**コマンドを呼ぶのは拡張機能側**である（既存の口と同じ流儀）。
  webviewから直接コマンドを実行できる仕組みは作らない——画面から届いた
  文字列がそのままコマンド名になる余地を、どこにも残さないため。
*/
if (toMainEl) {
  toMainEl.addEventListener('click', () => {
    if (busy) return;
    vscode.postMessage({ type: 'showInMain' });
  });
}
if (toSubEl) {
  toSubEl.addEventListener('click', () => {
    if (busy) return;
    vscode.postMessage({ type: 'showInSub' });
  });
}

/*
  相談で決まったことを、設定資料の更新案として積む（設計書6.72）。

  **押しても資料は変わらない。** 積まれるのは承認待ちで、反映するかは
  「更新分を反映」で作者が決める。ここで伝えられるのはそこまでなので、
  結果の知らせは拡張機能側の通知に任せる。
*/
if (applyToSettingsEl) {
  applyToSettingsEl.addEventListener('click', () => {
    if (busy || applying || exchanges === 0) return;
    applying = true;
    updateApplyState();
    vscode.postMessage({ type: 'applyToSettings' });
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
    // AIが分からないときは押せる場所を出さない（開く先が意味を持たない）
    providerEl.title = message.provider ? 'AI設定を開く' : '';
    // 起動できる機能は、届くたびに作り直す（機能が増減しても写しが残らない）
    quickRuns = message.quickRuns || [];
    renderQuickRuns();
    // 聞き方の例も届くたびに作り直す（読者像を決めたら札が1つ減る）
    examples = message.examples || [];
    renderExamples();
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
        // 後から開いた画面でも「相談を資料へ反映」を押せるようにする
        exchanges++;
      }
    });
    updateApplyState();
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
  if (message.type === 'thought') {
    /*
      **AIが考えている中身を流す**（設計書6.63.2）。

      大きく開いた画面で長い相談をすると、答えが返るまで何も起きない
      時間が続く。少なくとも「動いている」ことと「何を考えているか」は
      見せられる。

      **末尾を見せる。** 思考は長くなるので、頭から出すとすぐ画面外へ
      流れ、動いていることが分からなくなる。
      **答えそのものは流さない**——書きかけを読むと、作者が途中の判断で
      動いてしまう。
    */
    thought += message.delta || '';
    thinkingEl.textContent = '考えています… ' + thought.slice(-THOUGHT_TAIL);
    return;
  }
  if (message.type === 'answer') {
    setBusy(false);
    thought = '';
    thinkingEl.textContent = '考えています…';
    // 1往復できたので、資料へ反映できる会話になった
    exchanges++;
    updateApplyState();
    const turn = appendTurn('AI', message.reply, undefined, message.html);
    // 参照（そこを見せて）はそのまま出し、作業の提案は畳んで置く
    if (message.locate) appendLocate(turn, message.locate);
    // 読者の話をした回だけ、AIへ添えたのと同じ区分の一覧を作者にも見せる
    appendReaderGlossary(turn, message.readerGlossary);
    appendStagedActions(turn, message);
    // 答えで名指しされた項目の「光らせる」（0.75.6）。
    // **最初の1件はもう光っている**ので、これは押し直すための札である
    appendSpotlight(turn, message.spotlight);
    // 案内の誘い（設計書6.104）。**選択肢より先に置く**——
    // 「どの順でやるか」は、言い直しの候補より先に読みたい
    if (message.tour) appendTourOffer(turn, message.tour);
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
  if (message.type === 'applyToSettingsDone') {
    // 成否にかかわらず、押せる状態へ戻す。結果は通知と note が伝える
    applying = false;
    updateApplyState();
    return;
  }
  // 画面で指しながらの案内（設計書6.104）
  if (message.type === 'tourStep') {
    appendTourStep(message.step, message.where);
    scrollToBottom();
    return;
  }
  if (message.type === 'tourEnded') {
    // 終わった案内の札は押せなくする。**消さない**（通った道が残る）
    sealTourCards();
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = message.message;
    logEl.appendChild(note);
    scrollToBottom();
    return;
  }
  // 「代わりに押して」が起こせなかったとき。**案内は続ける**
  if (message.type === 'tourNote') {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = message.message;
    logEl.appendChild(note);
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
  // 頼まれた書き込みが済んだ。中身と結果、そして「取り消す」を出す
  if (message.type === 'editDone') {
    appendEditDone(message);
    scrollToBottom();
    return;
  }
  if (message.type === 'undoDone') {
    markEdit(message.id, message.message, true);
    scrollToBottom();
    return;
  }
  // 取り消せなかったとき（書いたあとに変わっている等）。
  // **押せる状態へは戻さない**——もう一度押しても結果は変わらない
  if (message.type === 'undoFailed') {
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
    const turn = appendTurn('エラー', message.message, 'error');
    // **直し方を押せる形で出す**（タイムアウトの秒数など）。
    // 送り返すのは鍵だけで、何をするかは拡張機能側が覚えている
    appendErrorActions(turn, message.actions || []);
    scrollToBottom();
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
