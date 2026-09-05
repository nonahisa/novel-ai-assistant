/**
 * 提案パネル（下段・誤字脱字）の中身。
 *
 * 設定資料パネルと同じく、値はすべて postMessage で渡し、
 * HTMLへ文字列として埋め込まない（本文の引用符で画面が壊れるのを防ぐ）。
 */
export function buildProposalPanelHtml(
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
<title>提案</title>
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
/*
  分類の切り替え（設計書6.11.3）。**検知を走らせても前の結果は消えない**ので、
  どこに何件残っているかを出して、戻れるようにする。
  1つしか無いときは出さない（下段は狭い）
*/
/*
  作品の切り替え（設計書6.11.3）。**2つの作品で同時に検知を走らせられる**ので、
  後から届いた結果で画面を奪わない代わりに、ここで移れるようにする。
  1作品しか無いときは出さない（下段は狭い）
*/
#works {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
#works:empty { display: none; }
#works label { display: flex; align-items: center; gap: 6px; }
#works select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  border-radius: 2px;
  padding: 1px 4px;
  font-family: inherit;
  font-size: inherit;
  max-width: 60%;
}
#tabs {
  display: flex;
  gap: 4px;
  padding: 4px 10px 0;
  flex-wrap: wrap;
}
#tabs:empty { display: none; }
#tabs .tab {
  background: none;
  color: var(--vscode-foreground);
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 2px 8px;
  opacity: 0.75;
}
#tabs .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
#tabs .tab.active {
  opacity: 1;
  font-weight: bold;
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-toolbar-activeBackground, transparent);
}
#tabs .tab .n {
  margin-left: 4px;
  color: var(--vscode-descriptionForeground);
  font-weight: normal;
}
#toolbar .count { color: var(--vscode-descriptionForeground); }
/*
  検知の進み具合（作者の報告、2026-08-29）。**一覧に前の結果が出ている
  ときは、ここへ小さく出す**——読んでいる指摘の場所を奪わない。
  一覧が空のときは #empty の側へ出す（そちらのほうがよく見える）
*/
#toolbar .running { color: var(--vscode-descriptionForeground); font-size: 12px; }
#running:empty { display: none; }
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
/* 済んだ指摘は薄く出す。ただし薄くするのは中身だけで、押せる操作は
   そのままにする。以前は .issue.applied 全体を薄くしており、
   「戻す」が押せないように見えていた（2026-08-21、作者の指摘）。
   opacity は親に付けると子で戻せないので、対象を絞る */
.issue.applied .meta,
.issue.applied .diff,
.issue.applied .quote,
.issue.applied .reason,
.issue.applied .location { opacity: 0.55; }
.issue.dismissed { display: none; }
/* 再チェックで解消が確かめられたものは、見送ったものと同じく一覧から外す。
   本文は既に作者が直しており、この行にもう作業は残っていない */
.issue.resolved { display: none; }
/* 再チェックの結果。**status-detail（赤）とは分ける。**
   あちらは適用に失敗した理由で、こちらは確かめた結果である */
.recheck-note {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border-left: 2px solid var(--vscode-focusBorder);
  padding-left: 8px;
}
/* AIに訊いた答え（設計書6.73）。**再チェックの結果とは分ける**——
   あちらは「直ったか」で、こちらは「どちらに揃えるとよいか」の助言である。
   どちらも不具合ではないので赤で出さない */
.advice-note {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border-left: 2px solid var(--vscode-textLink-foreground);
  padding-left: 8px;
}
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
/*
  かつては行まるごとを赤で消し、まるごと緑で出していた。誤字は直す語が
  短いので気にならなかったが、推敲の指摘は文まるごとが対象になるため
  どこが変わるのか目で追えなかった（作者の指摘）。塗るのは違うところだけ。
  地の文は普段どおりの色で置く
*/
.diff .from, .diff .to { color: var(--vscode-foreground); }
/* mark は既定で黄色地に黒字になるので、必ず上書きする */
.diff mark { color: inherit; background: none; border-radius: 2px; padding: 0 1px; }
.diff mark.del {
  background-color: var(--vscode-diffEditor-removedTextBackground, rgba(255, 90, 90, 0.28));
  text-decoration: line-through;
}
.diff mark.ins {
  background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(76, 175, 80, 0.28));
}
/* 設定資料の更新。項目ごとに「現在 / 更新案」を上下に並べる */
.change { margin: 6px 0; }
.change .side {
  display: inline-block;
  min-width: 4.5em;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
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
<div id="works"></div>
<div id="tabs"></div>
<div id="toolbar">
  <span class="title" id="category">誤字脱字</span>
  <span class="count" id="count">0件</span>
  <span class="running" id="running"></span>
  <label><input type="checkbox" id="showLow"> 確信度が低いものも表示</label>
  <button class="secondary" id="clear" title="この分類の一覧を空にします（本文は書き換わりません）">一覧を空にする</button>
  <button class="secondary" id="applyAll" title="確信度が「高」「中」で、修正案のあるものだけが対象です">まとめて適用</button>
</div>
<!--
  **分類の名前を書かない。** この案内は誤字脱字・表記ゆれ・推敲・矛盾・
  プロット逸脱…どのタブでも同じものが出る。以前は「誤字脱字を検知」「表記ゆれを
  検知」の2つだけを挙げていたため、矛盾検知を走らせた直後に0件だった作者へ
  「別の機能を実行してください」と言っているように読めた（実機確認 2026-09-05）。
  分類ごとの対応表を持つと、分類が増えるたびに更新漏れが起きるので持たない。
-->
<div id="empty">まだ検知結果がありません。この分類の検知を実行すると、ここに指摘が並びます。</div>
<div id="list"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const showLowEl = document.getElementById('showLow');
const applyAllEl = document.getElementById('applyAll');
const tabsEl = document.getElementById('tabs');
const worksEl = document.getElementById('works');
const clearEl = document.getElementById('clear');
const runningEl = document.getElementById('running');

/**
 * 検知の進み具合（作者の報告、2026-08-29）。
 *
 * 「下に動いているときのチャンク数がでないですね」。走っている間、
 * このパネルには何も出ていなかった（右下の通知にしか出ていない）。
 *
 * **止まった／終わったときは必ず消す。** 「3/12」が出たまま残ると、
 * まだ走っているように見える。消す道は2つ——結果が届いたとき（issues）と、
 * 中止・失敗のとき（runningDone）である。
 */
let runningState = null;
/** 一覧が空のときに出ている案内。進み具合を出す間だけ差し替える */
const emptyDefault = emptyEl.textContent;
/** 直近に描いた件数。進み具合をどちらへ出すかの判断に使う */
let lastItemCount = 0;

function paintRunning() {
  /*
    **別の作品の検知なら、作品名を頭に付ける。**

    書庫では、作品Aの結果を読みながら作品Bを検知できる。以前は表示中と
    違う作品の進みを送らずに捨てていたため、2作品目では進みが一切
    出なかった。作品名があれば、見えている件数と関係のない数だと分かる。
  */
  const text = runningState
    ? (runningState.workTitle ? '〈' + runningState.workTitle + '〉' : '') +
      runningState.label + 'しています… ' +
      runningState.done + '/' + runningState.total + runningState.unit
    : '';

  // 一覧が空のときは、いちばん目に入るところへ出す
  if (text && lastItemCount === 0) {
    emptyEl.textContent = text;
    emptyEl.style.display = 'block';
    runningEl.textContent = '';
    return;
  }
  emptyEl.textContent = emptyDefault;
  emptyEl.style.display = lastItemCount === 0 ? 'block' : 'none';
  runningEl.textContent = text;
}

showLowEl.addEventListener('change', () => {
  document.body.classList.toggle('show-low', showLowEl.checked);
});
applyAllEl.addEventListener('click', () => {
  vscode.postMessage({ type: 'applyAll' });
});
clearEl.addEventListener('click', () => {
  vscode.postMessage({ type: 'clearCategory' });
});

/**
 * 分類のタブを並べる。
 *
 * **残りの件数を添える。** どれを見に行けばよいかは、名前だけでは決まらない。
 * 空になった分類も残す——「さっき走らせたのに消えた」と思わせないため。
 */
function renderTabs(categories) {
  if (!categories || categories.length === 0) {
    tabsEl.innerHTML = '';
    return;
  }
  tabsEl.innerHTML = categories.map(function (entry) {
    const count = entry.remaining > 0
      ? '<span class="n">' + entry.remaining + '</span>'
      : (entry.total > 0 ? '<span class="n">済</span>' : '');
    return '<button class="tab' + (entry.active ? ' active' : '') +
      '" data-category="' + escapeHtml(entry.name) + '">' +
      escapeHtml(entry.name) + count + '</button>';
  }).join('');

  tabsEl.querySelectorAll('.tab').forEach(function (el) {
    el.addEventListener('click', function () {
      vscode.postMessage({ type: 'selectCategory', category: el.dataset.category });
    });
  });
}

/**
 * 作品の切り替え口。
 *
 * **2作品以上のときだけ出す。** 1作品なら選ぶものが無く、これまでと同じ
 * 見た目のままにする。
 *
 * 誤字脱字を2つの作品で同時に走らせると、両方の結果が溜まる。**届いた
 * 結果は画面を奪わない**ので、移りたいときはここで選んでもらう
 * （適用・見送りは、表示中の作品の指摘にしか効かない）。
 */
function renderWorks(works) {
  if (!works || works.length < 2) {
    worksEl.innerHTML = '';
    return;
  }
  // 名前は label で結び付ける（読み上げのとき、何の選択かが分かるように）
  worksEl.innerHTML = '<label>作品<select>' +
    works.map(function (entry) {
      const count = entry.remaining > 0 ? '（' + entry.remaining + '件）' : '';
      return '<option value="' + escapeHtml(entry.id) + '"' +
        (entry.active ? ' selected' : '') + '>' +
        escapeHtml(entry.title) + count + '</option>';
    }).join('') + '</select></label>';

  worksEl.querySelector('select').addEventListener('change', function (event) {
    vscode.postMessage({ type: 'switchWork', workId: event.target.value });
  });
}

const CONFIDENCE_LABEL = { high: '確信度: 高', medium: '確信度: 中', low: '確信度: 低' };
const STATUS_LABEL = {
  applied: '適用済み',
  dismissed: '無視しました',
  failed: '失敗',
  resolved: '解消を確認しました',
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(workTitle, items) {
  // **「残り」を出す。** 以前は「見送っていないもの」を数えており、
  // 全部を適用しても件数が減らなかった。タブの印と同じ数え方にする
  const remaining = items.filter(
    (item) => item.status === 'pending' || item.status === 'failed'
  );
  countEl.textContent = remaining.length + '件';
  lastItemCount = items.length;
  // 案内を出すか、進み具合を出すかは1か所で決める（両方が同じ場所を使う）
  paintRunning();
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
/**
 * 設定資料の更新の1件。
 *
 * **何がどう変わるかを、全部並べる。** 折り畳むと読まずに押される。
 * 作者が確定させた記述を書き換える提案なので、そこは省かない。
 */
/**
 * 設定資料の更新を「項目 / 現在 / 更新案」で並べ、違うところだけを塗る。
 *
 * **紹介文は長い。** 前後をまるごと並べると、変わるのがひと言でも
 * 全部を読み比べることになる。
 * 項目ごとに分けたものが無ければ、説明の行をそのまま並べる。
 */
function renderRecordChanges(item) {
  if (!item.changeParts || item.changeParts.length === 0) {
    return item.changes.map(function (line) {
      return escapeHtml(line);
    }).join('<br>');
  }

  // **設定資料は矢印で1行に並べない。** 紹介文は本文の直しより長く、
  // 横に繋ぐと折り返して読めなくなる。上下に並べて、頭に何かを書く
  return item.changeParts.map(function (part) {
    return '<div class="change">' +
      '<div class="reason">' + escapeHtml(part.label) + '</div>' +
      '<div class="diff">' +
      '<div><span class="side">現在</span>' +
      '<span class="from">' + diffSide(part.diff, 'from', part.before) + '</span></div>' +
      '<div><span class="side">更新案</span>' +
      '<span class="to">' + diffSide(part.diff, 'to', part.after) + '</span></div>' +
      '</div>' +
      '</div>';
  }).join('');
}

/**
 * 済んだときの言い方。
 *
 * ボタンの言葉をそのまま埋めると「反映するました」になるので、文の側で
 * 活用させる（拡張機能側の conjugate と同じ規則。WebViewからは
 * 読み込めないため、ここに同じ1行を置いている）。
 */
function doneLabel(item) {
  const label = item.applyLabel || '反映する';
  return (label.endsWith('する') ? label.slice(0, -2) : label) + 'しました';
}

function renderRecordUpdate(item) {
  const classes = ["issue"];
  if (item.status === "applied") classes.push("applied");
  if (item.status === "dismissed") classes.push("dismissed");
  const canAct = item.status === "pending" || item.status === "failed";

  return (
    '<div class="' + classes.join(' ') + '">' +
    '<div class="meta"><span class="reason">' + escapeHtml(item.name) + '</span>' +
    (item.source ? '<span class="conf">' + escapeHtml(item.source) + '</span>' : '') +
    (item.status === "applied" ? '<span class="reason">' + escapeHtml(doneLabel(item)) + '</span>' : '') +
    (item.status === "failed" ? '<span class="reason">' + escapeHtml(item.statusDetail || "失敗") + '</span>' : '') +
    '</div>' +
    '<div class="quote">' + renderRecordChanges(item) + '</div>' +
    (canAct
      ? '<div class="actions">' +
        // **押した結果が何になるかで呼び名が変わる**（設計書6.35.2）。
        // 設定資料は「反映する」だが、伏線の候補は「登録」、
        // 回収の候補は「回収済みにする」である
        '<button data-action="apply" data-id="' + item.id + '">' +
        escapeHtml(item.applyLabel || '反映する') + '</button>' +
        '<button class="secondary" data-action="dismiss" data-id="' + item.id + '">見送る</button>' +
        '</div>'
      : '') +
    '</div>'
  );
}

function renderContradiction(item) {
  const classes = ['issue', 'contradiction'];
  if (item.confidence === 'low') classes.push('low');
  if (item.status === 'dismissed') classes.push('dismissed');
  // 再チェックで解消が確かめられたものは、見送ったものと同じく一覧から外す。
  // 本文は既に作者が直しており、この行にもう作業は残っていない
  if (item.status === 'resolved') classes.push('resolved');

  const canAct = item.status === 'pending';
  const note = item.note
    ? '<div class="note">' + escapeHtml(item.note) + '</div>'
    : '';
  // 再チェックの結果。確かめた結果であって不具合ではないので、赤で出さない
  const recheckNote = item.recheckNote
    ? '<div class="recheck-note">' + escapeHtml(item.recheckNote) + '</div>'
    : '';
  // **再チェック中はこの行の操作を全部止める。** AIの答えは数秒〜数十秒
  // かかる。その間に本文や設定資料を直されると、確かめている最中の本文が変わる
  const disabled = item.busy ? ' disabled' : '';

  return (
    '<div class="' + classes.join(' ') + '">' +
    '<div class="issue-head">' +
    '<span class="location" data-action="jump" data-id="' + item.id + '">' +
    escapeHtml(item.fileName) + ' ' + item.line + '行目</span>' +
    '<span class="badge cat">' + escapeHtml(item.category) + '</span>' +
    '<span class="badge ' + item.confidence + '">' + CONFIDENCE_LABEL[item.confidence] + '</span>' +
    // **片付いた理由は1つではない**（設計書6.35.4）。伏線として登録した
    // ものは「無視しました」ではない。理由が添えてあればそちらを出す
    (item.status === 'dismissed'
      ? '<span class="reason">' + escapeHtml(item.dismissReason || '無視しました') + '</span>'
      : '') +
    '</div>' +
    '<div class="quote">' + escapeHtml(item.excerpt) + '</div>' +
    '<div class="compare">' +
    '<div><span class="side">' + escapeHtml(item.leftLabel || '設定では') + '</span>' + escapeHtml(item.settingSays) + '</div>' +
    '<div><span class="side">' + escapeHtml(item.rightLabel || '本文では') + '</span>' + escapeHtml(item.textSays) + '</div>' +
    '</div>' +
    note +
    recheckNote +
    (canAct
      ? '<div class="actions">' +
        // **飛び先に合った名前を出す。** 単話プロットの検査（P-27）は
        // 本文を見ていないので、押すと開くのは単話プロットである
        '<button data-action="jump" data-id="' + item.id + '"' + disabled + '>' + escapeHtml(item.jumpLabel || '本文を見る') + '</button>' +
        // 照らす相手が無い指摘（P-27）では、このボタンごと出さない
        (item.openTarget === 'none'
          ? ''
          : '<button class="secondary" data-action="openSettings" data-id="' + item.id + '"' + disabled + '>' + escapeHtml(item.openLabel || (item.openTarget === 'plot' ? 'プロットを見る' : '設定資料を見る')) + '</button>') +
        '<button class="secondary" data-action="dismiss" data-id="' + item.id + '"' + disabled + '>無視</button>' +
        // **矛盾ではなく伏線だった、という道**（設計書6.35.4）。
        // 矛盾検知は「意図した違和感」も食い違いとして拾うので、
        // そこから伏線の台帳へ移せるようにする。プロット逸脱には出ない
        (item.canRegisterForeshadow
          ? '<button class="secondary" data-action="registerForeshadow" data-id="' + item.id + '" title="この食い違いは矛盾ではなく、意図して置いた伏線だった場合に登録します"' + disabled + '>伏線として登録</button>'
          : '') +
        // **本文を直したあと、食い違いが残っているかを確かめる**（作者の依頼、
        // 2026-08-27）。矛盾には修正案が無いので、直したかどうかは
        // 作者の手元でしか分からない
        (item.canRecheck
          // **「本文を」に限る。** 設定資料のほうを直した場合、本文は
          // 変わっていないので「本文が変わっていません」と返る（引用照合が
          // 本文だけを見るため）。できないことを謳うと、直したのに
          // 直っていないと言われた形になる。設定側の解決を見るには
          // 再チェックへ現在の設定を添える改修（P-23の変更）が要る
          ? '<button class="secondary" data-action="recheck" data-id="' + item.id + '" title="本文を書き直したあと、この食い違いが解消したかを確かめます"' + disabled + '>' +
            (item.busy ? '再チェック中…' : '再チェック') + '</button>'
          : '') +
        '</div>'
      : '') +
    '</div>'
  );
}

/**
 * 片側（消える側か、足す側か）を組み立て、違うところだけを塗る。
 *
 * 区間分けは拡張機能側（core/inlineDiff.ts）で済ませてある。ここは
 * 受け取ったものを組み立てるだけにして、判断を持たせない。
 * **添えられていなければ、まるごと出す**（古い作りへ素直に落ちる）。
 *
 * @param side 'from' なら消える側、'to' なら足す側
 */
function diffSide(segments, side, fallback) {
  if (!segments || segments.length === 0) return escapeHtml(fallback);

  let out = '';
  for (const segment of segments) {
    const text = escapeHtml(segment.text);
    if (segment.kind === 'equal') {
      out += text;
    } else if (segment.kind === 'removed' && side === 'from') {
      out += '<mark class="del">' + text + '</mark>';
    } else if (segment.kind === 'added' && side === 'to') {
      out += '<mark class="ins">' + text + '</mark>';
    }
  }
  return out;
}

/** 本文の置き換え。短いので、矢印で1行に並べる */
function renderDiff(item) {
  return '<span class="from">' + diffSide(item.diff, 'from', item.target) + '</span> → ' +
    '<span class="to">' + diffSide(item.diff, 'to', item.suggestion) + '</span>';
}

function renderItem(item) {
  // 矛盾は形が違う。並べるものが「置き換え」ではなく「食い違い」である
  if (item.excerpt !== undefined) return renderContradiction(item);
  // 設定資料の更新も形が違う。行と文字ではなくレコードと項目である
  if (item.changes !== undefined) return renderRecordUpdate(item);

  const classes = ['issue'];
  if (item.confidence === 'low') classes.push('low');
  if (item.status === 'applied') classes.push('applied');
  if (item.status === 'dismissed') classes.push('dismissed');
  if (item.status === 'resolved') classes.push('resolved');

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
  // 再チェックの結果。確かめた結果であって不具合ではないので、赤で出さない
  const recheckNote = item.recheckNote
    ? '<div class="recheck-note">' + escapeHtml(item.recheckNote) + '</div>'
    : '';
  // AIに訊いた答え（設計書6.73）。**助言であって、本文には何もしていない**
  const adviceNote = item.adviceNote
    ? '<div class="advice-note">' + escapeHtml(item.adviceNote) + '</div>'
    : '';
  // **AIに問い合わせている間も、この行の操作を全部止める。** 答えを待つ間に
  // 「適用」を押されると、どちらに揃えるかを訊いている最中の本文が変わる
  const disabled = (item.busy || item.askingAdvice) ? ' disabled' : '';

  // 「冗長」の一語だけでは、何と何の話なのか分からない。説明を添える
  const explain = [item.reason, item.detail].filter(Boolean).join('：');

  // **原文をもう一度出さない。**
  //
  // 誤字脱字は、直す語（target）が行の一部なので、行まるごと（original）を
  // 添えると前後が分かって役に立つ。**推敲は一文まるごとが target** なので、
  // 同じ文が差分のすぐ下にもう一度並んでいた（2026-08-22、作者の指摘）。
  // 前後を足せるときだけ足す
  const addsContext = item.original && item.original !== item.target;

  const body = hasFix
    ? '<div class="diff">' + renderDiff(item) + '</div>' +
      '<div class="reason">' +
      (addsContext ? escapeHtml(item.original) + '（' + escapeHtml(explain) + '）'
                   : escapeHtml(explain)) +
      '</div>'
    : '<div class="quote">' + escapeHtml(item.original) + '</div>' +
      '<div class="reason">' + escapeHtml(explain) +
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
    recheckNote +
    adviceNote +
    (canAct
      ? '<div class="actions">' +
        (hasFix
          ? '<button data-action="apply" data-id="' + item.id + '"' + disabled + '>適用</button>'
          : '<button data-action="jump" data-id="' + item.id + '"' + disabled + '>本文を見る</button>') +
        '<button class="secondary" data-action="dismiss" data-id="' + item.id + '"' + disabled + '>無視</button>' +
        (canKeep(item)
          ? '<button class="secondary" data-action="keepWord" data-id="' + item.id + '" title="この語を今後どの話でも指摘しません"' + disabled + '>今後直さない</button>'
          : '') +
        // **どちらに揃えるかは、機械には決められない**（設計書6.73）。
        // 揺れの組の材料を持っている指摘（表記ゆれ）にだけ出す。
        // 答えは下に出るだけで、本文は書き換わらない
        (item.notation
          ? '<button class="secondary" data-action="askNotation" data-id="' + item.id + '" title="どちらの表記に揃えるとよいかをAIに訊きます（本文は書き換わりません）"' + disabled + '>' +
            (item.askingAdvice ? 'AIに問い合わせ中…' : 'AIに訊く') + '</button>'
          : '') +
        // **本文を手で書き直したあと、解消したかを確かめる**（作者の依頼）。
        // 修正案の有無を問わず出す——誤字脱字でも「そうじゃない」直し方を
        // することがあり、そのときも解消したかどうかは知りたい
        (item.canRecheck
          ? '<button class="secondary" data-action="recheck" data-id="' + item.id + '" title="本文を書き直したあと、この指摘が解消したかを確かめます"' + disabled + '>' +
            (item.busy ? '再チェック中…' : '再チェック') + '</button>'
          : '') +
        '</div>'
      : '') +
    // **適用したあとに気が変わることがある**（作者の指摘）。
    // 直した箇所を、元の語へ戻せるようにする
    (item.status === 'applied'
      ? '<div class="actions">' +
        '<button class="secondary" data-action="undo" data-id="' + item.id + '" title="本文をこの指摘の前へ戻します">戻す</button>' +
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

/**
 * 直前に表示していた一覧の主（作品id＋分類）。
 *
 * **同じ一覧の描き直しでは、読んでいた位置を保つ**（0.22.24の積み残し）。
 * 別作品の結果が届く・1件適用する、のたびに全体を描き直すため、
 * そのままだと読んでいた位置が先頭へ戻ってしまう。
 * 別の作品・分類へ切り替わったときは先頭へ戻す（別の一覧を
 * 途中から見せられても、どこを見ているのか分からない）。
 */
let lastListKey = '';

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'running') {
    runningState = {
      label: message.label || '検知',
      done: message.done || 0,
      total: message.total || 0,
      unit: message.unit || 'チャンク',
      // 表示中の作品の検知なら空。別の作品なら題名が入る
      workTitle: message.workTitle || '',
    };
    paintRunning();
    return;
  }
  if (message.type === 'runningDone') {
    runningState = null;
    paintRunning();
    return;
  }
  if (message.type === 'issues') {
    // **結果が届いたら、進み具合は消す。** 走り終えているのに数字が
    // 残っていると、まだ動いているように見える
    runningState = null;
    const listKey = (message.workId || '') + '/' + (message.category || '');
    const keepScroll = listKey === lastListKey;
    const scrollY = window.scrollY;
    lastListKey = listKey;
    // 見出しは検知の種類で変わる（誤字脱字／表記ゆれ）
    document.getElementById('category').textContent = message.category || '誤字脱字';
    // 矛盾には「まとめて適用」が無い。どちらが正しいか決められないため
    applyAllEl.style.display = message.canApplyAll === false ? 'none' : '';
    // 空の分類に「空にする」を出しても押すものが無い
    clearEl.style.display = message.items.length > 0 ? '' : 'none';
    renderWorks(message.works);
    renderTabs(message.categories);
    render(message.workTitle, message.items);
    // 描き直しが終わってから戻す（先に戻すと、描き直しで打ち消される）
    window.scrollTo(0, keepScroll ? scrollY : 0);
  }
});
</script>
</body>
</html>`;
}
