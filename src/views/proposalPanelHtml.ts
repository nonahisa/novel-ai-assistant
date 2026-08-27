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
  <label><input type="checkbox" id="showLow"> 確信度が低いものも表示</label>
  <button class="secondary" id="clear" title="この分類の一覧を空にします（本文は書き換わりません）">一覧を空にする</button>
  <button class="secondary" id="applyAll" title="確信度が「高」「中」で、修正案のあるものだけが対象です">まとめて適用</button>
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
const tabsEl = document.getElementById('tabs');
const worksEl = document.getElementById('works');
const clearEl = document.getElementById('clear');

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
const STATUS_LABEL = { applied: '適用済み', dismissed: '無視しました', failed: '失敗' };

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

function renderRecordUpdate(item) {
  const classes = ["issue"];
  if (item.status === "applied") classes.push("applied");
  if (item.status === "dismissed") classes.push("dismissed");
  const canAct = item.status === "pending" || item.status === "failed";

  return (
    '<div class="' + classes.join(' ') + '">' +
    '<div class="meta"><span class="reason">' + escapeHtml(item.name) + '</span>' +
    (item.source ? '<span class="conf">' + escapeHtml(item.source) + '</span>' : '') +
    (item.status === "applied" ? '<span class="reason">反映しました</span>' : '') +
    (item.status === "failed" ? '<span class="reason">' + escapeHtml(item.statusDetail || "失敗") + '</span>' : '') +
    '</div>' +
    '<div class="quote">' + renderRecordChanges(item) + '</div>' +
    (canAct
      ? '<div class="actions">' +
        '<button data-action="apply" data-id="' + item.id + '">反映する</button>' +
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

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'issues') {
    // 見出しは検知の種類で変わる（誤字脱字／表記ゆれ）
    document.getElementById('category').textContent = message.category || '誤字脱字';
    // 矛盾には「まとめて適用」が無い。どちらが正しいか決められないため
    applyAllEl.style.display = message.canApplyAll === false ? 'none' : '';
    // 空の分類に「空にする」を出しても押すものが無い
    clearEl.style.display = message.items.length > 0 ? '' : 'none';
    renderWorks(message.works);
    renderTabs(message.categories);
    render(message.workTitle, message.items);
  }
});
</script>
</body>
</html>`;
}
