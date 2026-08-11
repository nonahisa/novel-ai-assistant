/**
 * 設定資料パネルの中身（HTML / CSS / スクリプト）。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない。
 * 作品には作者が書いた任意の文字列が入るため、
 * 埋め込むと引用符ひとつで画面が壊れる。
 *
 * 色はVS Codeのテーマ変数を使う。作者のテーマに合わせるため。
 */

export function buildSettingsPanelHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>設定資料</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
/*
 * 画面全体をページごとスクロールさせない。
 *
 * 以前は #layout に 100vh を与えたうえで #status をその下に置いていたため、
 * 合計が画面より高くなり、ページ全体が縦にずれていた。
 * タブや一覧が上へ隠れるうえ、下端の入力欄を押すと同時に画面が動いて
 * 狙った場所に当たらないことがある。
 * スクロールするのは中身（#detail と一覧）だけにする。
 */
body {
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
/* min-height: 0 が無いと、中身の高さに引きずられて縮まなくなる */
#layout { display: flex; flex: 1; min-height: 0; }
#sidebar {
  width: 260px;
  min-width: 200px;
  border-right: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
}
#tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
#tabs button {
  flex: 1;
  padding: 8px 4px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 12px;
}
#tabs button.active {
  border-bottom: 2px solid var(--vscode-focusBorder);
  font-weight: bold;
}
#search { margin: 8px; padding: 4px 6px; }
/*
 * 入力欄は必ず枠線を見せる。
 *
 * --vscode-input-border はテーマによっては定義されておらず、
 * 明るいテーマでは「白地に透明の枠」＝ただの余白にしか見えなくなる。
 * 実際に「入力フォームと分からない」という報告があった。
 * 定義があればそれを使い、無ければパネルの境界線で代用する。
 */
input, textarea, select {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  padding: 4px 6px;
  font-family: inherit;
  font-size: inherit;
}
/* 今どこに書いているかが分かるようにする */
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}
/* 高さを中身に合わせて広げる欄があるので、下限は小さくしておく */
textarea { resize: vertical; min-height: 32px; }
#list { flex: 1; overflow-y: auto; }
#list .item {
  padding: 6px 10px;
  cursor: pointer;
  border-left: 3px solid transparent;
}
#list .item:hover { background: var(--vscode-list-hoverBackground); }
#list .item.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-left-color: var(--vscode-focusBorder);
}
#list .item .sub {
  font-size: 11px;
  opacity: 0.7;
}
/* モブ・集団の区切り。一覧の一部だと分かる程度に控えめにする */
#list .group {
  padding: 6px 10px;
  margin-top: 4px;
  font-size: 11px;
  opacity: 0.75;
  border-top: 1px solid var(--vscode-panel-border);
  user-select: none;
}
#list .group.clickable { cursor: pointer; }
#list .group.clickable:hover { background: var(--vscode-list-hoverBackground); }
/* チェックボックスの項目。入力欄と違い、ラベルを右に置く */
.field.check { display: flex; align-items: center; gap: 6px; }
.field.check input { width: auto; }
.field.check label { margin: 0; }
#detail { flex: 1; overflow-y: auto; padding: 16px 20px; }
h2 { margin: 0 0 4px; font-size: 18px; }
h3 {
  margin: 24px 0 8px;
  font-size: 13px;
  text-transform: none;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 4px;
}
.field { margin-bottom: 10px; }
.field label { display: block; font-size: 12px; opacity: 0.8; margin-bottom: 3px; }
.readonly { font-size: 12px; opacity: 0.85; margin-bottom: 6px; }
.readonly .k { opacity: 0.7; margin-right: 6px; }
button.action {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 5px 12px;
  border-radius: 2px;
  cursor: pointer;
}
button.action:hover { background: var(--vscode-button-hoverBackground); }
button.action:disabled { opacity: 0.5; cursor: default; }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.note {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.note .meta { font-size: 11px; opacity: 0.7; margin-bottom: 4px; }
.note .body { white-space: pre-wrap; }
/* Markdownを整形した部分。改行はタグで表すので pre-wrap を外す */
.rendered { white-space: normal; }
.rendered p { margin: 0 0 8px; }
.rendered p:last-child { margin-bottom: 0; }
.rendered ul { margin: 0 0 8px; padding-left: 20px; }
.rendered li { margin-bottom: 3px; }
.rendered code {
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px;
  border-radius: 2px;
}
.draft { border-color: var(--vscode-focusBorder); }
.proposal { border-color: var(--vscode-focusBorder); }
.proposal .field-row {
  border-top: 1px solid var(--vscode-panel-border);
  padding: 8px 0;
}
.proposal .field-row:first-of-type { border-top: none; }
/*
 * 見出しの行。左から チェック → 項目名 → 注意書き の順に詰める。
 *
 * 以前は下の .proposal input がチェックにも効いて幅100%になり、
 * チェックが横いっぱいに広がって項目名が右端へ押し出されていた。
 * 幅の狭いパネルでは項目名が縦書きのように折り返され、
 * どのチェックがどの項目のものか読み取れなかった。
 */
.proposal .head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.proposal .head input[type="checkbox"] {
  width: auto;
  margin: 0;
  flex: 0 0 auto;
}
.proposal .head label {
  font-weight: bold;
  cursor: pointer;
  /* 項目名は折り返さず、左に置く */
  flex: 0 0 auto;
  white-space: nowrap;
}
.proposal .before {
  font-size: 12px;
  opacity: 0.7;
  white-space: pre-wrap;
  margin: 4px 0;
}
.proposal .before .k { opacity: 0.7; margin-right: 4px; }
/* 入力欄は全幅に戻す。字下げすると、幅の狭いパネルで折り返しが増える */
.proposal .field-row textarea, .proposal .field-row > input { width: 100%; }
.proposal .overwrite {
  font-size: 11px;
  color: var(--vscode-notificationsWarningIcon-foreground, #cca700);
}
/* 一括操作の行。項目が多いと下まで送るのが手間になるので上にも置く */
.proposal .bulk {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.draft .banner {
  font-size: 12px;
  margin-bottom: 6px;
  color: var(--vscode-notificationsWarningIcon-foreground, #cca700);
}
.chat-turn { margin-bottom: 10px; }
.chat-turn .who { font-size: 11px; opacity: 0.7; margin-bottom: 2px; }
/*
 * 済んだやり取りは「読むだけ」だと分かる形にする。
 *
 * 以前は作者の発言を「透明の地＋全周の枠線」で描いていたため、
 * 入力欄と見分けが付かなかった（実際に取り違えられた）。
 * 枠で囲わず、地の色と左の帯で示す。
 */
.chat-turn .body {
  white-space: pre-wrap;
  padding: 6px 10px;
  border-radius: 0 3px 3px 0;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
}
.chat-turn.author .body {
  border-left-color: var(--vscode-panel-border);
  opacity: 0.85;
}
/* 観点を指定しなかった場合の但し書き。作者が書いた文ではないと分かるように */
.chat-turn .body.unspecified { font-style: italic; opacity: 0.7; }
#status {
  padding: 6px 20px;
  font-size: 12px;
  min-height: 26px;
  /* 高さが変わると上の領域が押し上げられるので、縮まないようにする */
  flex: 0 0 auto;
  border-top: 1px solid var(--vscode-panel-border);
}
#status.error { color: var(--vscode-errorForeground); }
.empty { opacity: 0.6; padding: 20px; }
.badge {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  margin-left: 6px;
}
</style>
</head>
<body>
<div id="layout">
  <div id="sidebar">
    <div id="tabs"></div>
    <input id="search" type="text" placeholder="名前で絞り込む">
    <div id="list"></div>
  </div>
  <div id="detail"><div class="empty">左の一覧から選んでください。</div></div>
</div>
<div id="status"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  // 組織は場所の手前に置く。人物の所属から辿る流れに合わせる。
  // 世界観は末尾。個々の設定を見たあとに読むもので、探し物としては開かれにくい
  const KINDS = ["character", "ability", "organization", "location", "world"];
  const KIND_LABELS = {
    character: "登場人物",
    ability: "能力",
    organization: "組織",
    location: "場所",
    world: "世界観",
  };

  let groups = {};
  let activeKind = "character";
  let selected = null;
  let detail = null;
  let draft = null;
  let proposal = null;
  let chatLog = [];
  let busy = false;
  /**
   * 相談欄に書きかけの文章。
   *
   * renderDetail() は詳細欄をまるごと作り直すので、
   * 入力欄も毎回作り直される。ここに控えておかないと、
   * AIの応答・保存・進捗の通知が届いた瞬間に書きかけが消え、
   * 作者からは「入力できない」ようにしか見えない。
   */
  let questionText = "";

  /** 相談欄に出す例。質問の形と、観点だけを書く形の両方を見せる */
  const CHAT_EXAMPLES = {
    character:
      "例：第12話で嘘をついた理由は本文から読み取れますか？／生い立ち",
    ability:
      "例：この力を使ったあと何が起きていますか？／代償はどこまで描かれているか",
    organization:
      "例：この組織は何を目的に動いていますか？／内部の力関係",
    location:
      "例：この場所はどんな雰囲気で描かれていますか？／誰が出入りしているか",
    world:
      "例：この決まりは誰にでも当てはまりますか？／例外が描かれている場面",
  };
  /**
   * モブの区画を開いているか。
   * 既定は閉じる。ネームドキャラを探すときに間へ挟まると目当ての名前を見つけにくい。
   */
  let mobsOpen = false;

  const el = {
    tabs: document.getElementById("tabs"),
    search: document.getElementById("search"),
    list: document.getElementById("list"),
    detail: document.getElementById("detail"),
    status: document.getElementById("status"),
  };

  function setStatus(text, isError) {
    el.status.textContent = text || "";
    el.status.className = isError ? "error" : "";
  }

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type: type }, payload || {}));
  }

  function renderTabs() {
    el.tabs.replaceChildren();
    for (const kind of KINDS) {
      const items = groups[kind] || [];
      const button = document.createElement("button");
      button.textContent = KIND_LABELS[kind] + "(" + items.length + ")";
      if (kind === activeKind) button.className = "active";
      button.addEventListener("click", function () {
        activeKind = kind;
        renderTabs();
        renderList();
      });
      el.tabs.appendChild(button);
    }
  }

  function renderList() {
    const keyword = el.search.value.trim();
    const items = (groups[activeKind] || []).filter(function (item) {
      if (!keyword) return true;
      return (item.name + " " + (item.sub || "")).indexOf(keyword) !== -1;
    });
    const named = items.filter(function (item) { return !item.isMob; });
    const mobs = items.filter(function (item) { return item.isMob; });

    el.list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "該当がありません。";
      el.list.appendChild(empty);
      return;
    }

    for (const item of named) el.list.appendChild(listRow(item));

    if (mobs.length === 0) return;
    // 絞り込み中は畳まない。探しているものが隠れると、
    // 出ていないのか無いのかが作者に区別できなくなる
    const searching = keyword !== "";
    const open = mobsOpen || searching;
    el.list.appendChild(mobHeader(mobs.length, open, searching));
    if (open) {
      for (const item of mobs) el.list.appendChild(listRow(item));
    }
  }

  /**
   * モブの区画の見出し。件数を必ず出す。
   * 畳んだまま件数が分からないと、そこに何かあること自体に気づけない。
   */
  function mobHeader(count, open, searching) {
    const row = document.createElement("div");
    row.className = "group";
    row.textContent =
      (searching ? "" : (open ? "▼ " : "▶ ")) + "モブ・集団（" + count + "件）";
    // 絞り込み中は開いたままなので、押しても何も起きないボタンにしない
    if (!searching) {
      row.classList.add("clickable");
      row.addEventListener("click", function () {
        mobsOpen = !mobsOpen;
        renderList();
      });
    }
    return row;
  }

  function listRow(item) {
    const row = document.createElement("div");
    row.className = "item" + (selected && selected.id === item.id ? " selected" : "");
    const name = document.createElement("div");
    name.textContent = item.name;
    row.appendChild(name);
    if (item.sub) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = item.sub;
      row.appendChild(sub);
    }
    row.addEventListener("click", function () {
      selected = { kind: activeKind, id: item.id };
      draft = null;
      proposal = null;
      chatLog = [];
      // 別の記録へ移ったら書きかけは持ち越さない。
      // 前の相手への質問が残っていると、誰に聞いているのか分からなくなる
      questionText = "";
      renderList();
      post("select", { kind: activeKind, id: item.id });
    });
    return row;
  }

  function labelled(labelText, control) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  /** 入・切の項目。ラベルはチェックの右に置き、押しても切り替わるようにする */
  function checkbox(labelText, box) {
    const wrap = document.createElement("div");
    wrap.className = "field check";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.addEventListener("click", function () {
      box.checked = !box.checked;
    });
    wrap.appendChild(box);
    wrap.appendChild(label);
    return wrap;
  }

  function heading(text) {
    const node = document.createElement("h3");
    node.textContent = text;
    return node;
  }

  /**
   * 中身の量に合わせて高さを変える入力欄。
   *
   * 行数を固定していたため、紹介文のように少し長い文章が
   * 途中で隠れていた。書いたものが全部見えないと、
   * 直すために毎回スクロールすることになる。
   */
  let pendingGrow = [];
  function growWithContent(area) {
    area.rows = 1;
    // 高さを中身に合わせるので、内側でスクロールさせない。
    // 行数を固定した他の欄（相談・下書き）はこれまでどおりスクロールする
    area.style.overflowY = "hidden";
    area.addEventListener("input", function () {
      fitHeight(area);
    });
    // 画面に載せる前は高さを測れないので、あとでまとめて合わせる
    pendingGrow.push(area);
    return area;
  }
  function fitHeight(area) {
    area.style.height = "auto";
    area.style.height = area.scrollHeight + 2 + "px";
  }
  function applyPendingGrow() {
    for (const area of pendingGrow) fitHeight(area);
    pendingGrow = [];
  }

  function renderDetail() {
    el.detail.replaceChildren();
    if (!detail) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "左の一覧から選んでください。";
      el.detail.appendChild(empty);
      return;
    }

    const title = document.createElement("h2");
    title.textContent = detail.name;
    if (!detail.autoGenerated) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "作者が確定";
      title.appendChild(badge);
    }
    el.detail.appendChild(title);

    // ── 読み取り専用の情報（本文から機械的に求まる値）
    if (detail.readOnly.length > 0) {
      for (const entry of detail.readOnly) {
        const line = document.createElement("div");
        line.className = "readonly";
        const key = document.createElement("span");
        key.className = "k";
        key.textContent = entry.label;
        line.appendChild(key);
        line.appendChild(document.createTextNode(entry.value));
        el.detail.appendChild(line);
      }
    }

    // ── 作者による書き換え
    el.detail.appendChild(heading("設定を書き換える"));
    const inputs = {};
    for (const field of detail.fields) {
      if (field.check) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = field.value === "1";
        inputs[field.key] = box;
        el.detail.appendChild(checkbox(field.label, box));
        continue;
      }
      // 決まった値から選ぶ項目は選択肢で出す。手入力にすると
      // 綴りの揺れた値が保存され、読み込み時の検証で落ちる
      if (field.choices) {
        const select = document.createElement("select");
        for (const choice of field.choices) {
          const option = document.createElement("option");
          option.value = choice.value;
          option.textContent = choice.label;
          if (choice.value === field.value) option.selected = true;
          select.appendChild(option);
        }
        inputs[field.key] = select;
        el.detail.appendChild(labelled(field.label, select));
        continue;
      }
      const control = document.createElement(field.multiline ? "textarea" : "input");
      control.value = field.value;
      // 中身の量に合わせて高さを変える。固定の行数だと、
      // 紹介文のように少し長い文章が途中で隠れてしまう
      if (field.multiline) growWithContent(control);
      inputs[field.key] = control;
      el.detail.appendChild(labelled(field.label, control));
    }

    const saveRow = document.createElement("div");
    saveRow.className = "row";
    const saveButton = document.createElement("button");
    saveButton.className = "action";
    saveButton.textContent = "保存";
    saveButton.disabled = busy;
    saveButton.addEventListener("click", function () {
      const edits = {};
      for (const key of Object.keys(inputs)) {
        const control = inputs[key];
        // チェックは value ではなく入・切の状態を送る
        edits[key] =
          control.type === "checkbox" ? (control.checked ? "1" : "") : control.value;
      }
      post("save", { kind: detail.kind, id: detail.id, edits: edits });
    });
    saveRow.appendChild(saveButton);
    const saveHint = document.createElement("span");
    saveHint.className = "sub";
    saveHint.style.fontSize = "11px";
    saveHint.style.opacity = "0.7";
    saveHint.textContent = "保存すると、以後この項目は抽出で上書きされなくなります。";
    saveRow.appendChild(saveHint);
    el.detail.appendChild(saveRow);

    // ── AIに各項目を埋めさせる（承認制）
    el.detail.appendChild(heading("AIで項目を充実させる"));
    const enrichHint = document.createElement("div");
    enrichHint.className = "readonly";
    enrichHint.textContent =
      "本文を読み直して、上の各項目に入れる内容を提案させます。反映するかは項目ごとに選べます。";
    el.detail.appendChild(enrichHint);

    const enrichRow = document.createElement("div");
    enrichRow.className = "row";
    const enrichButton = document.createElement("button");
    enrichButton.className = "action";
    enrichButton.textContent = "項目を充実させる";
    enrichButton.disabled = busy;
    enrichButton.addEventListener("click", function () {
      post("enrich", { kind: detail.kind, id: detail.id });
    });
    enrichRow.appendChild(enrichButton);
    el.detail.appendChild(enrichRow);

    if (proposal) el.detail.appendChild(renderProposal());

    // ── AIに相談する（質問と掘り下げを1つにまとめたもの）
    el.detail.appendChild(heading("AIに相談する"));
    const chatHint = document.createElement("div");
    chatHint.className = "readonly";
    chatHint.textContent =
      "質問にも、掘り下げたい観点にも使えます。空欄で押すと全体的に掘り下げます。" +
      "答えは項目には入らず、残したいものだけメモとして追記できます。";
    el.detail.appendChild(chatHint);

    for (const turn of chatLog) el.detail.appendChild(renderTurn(turn));
    if (draft) el.detail.appendChild(renderDraft());

    const question = document.createElement("textarea");
    // 例は種別ごとに変える。能力を見ているのに「嘘をついた理由」と出ると、
    // 何を聞ける機能なのか伝わらない
    question.placeholder = CHAT_EXAMPLES[detail.kind] || CHAT_EXAMPLES.character;
    question.rows = 2;
    // 書きかけを復元する。再描画で消えると入力できないのと同じ
    question.value = questionText;
    question.addEventListener("input", function () {
      questionText = question.value;
    });
    // 上の項目と同じく見出しを付ける。
    // 見出しの無い入力欄は、直前のやり取りの続きに見えて気づかれない
    el.detail.appendChild(labelled("聞きたいこと（空欄でも押せます）", question));

    const askRow = document.createElement("div");
    askRow.className = "row";
    const askButton = document.createElement("button");
    askButton.className = "action";
    askButton.textContent = "AIに聞く";
    askButton.disabled = busy;
    askButton.addEventListener("click", function () {
      const text = question.value.trim();
      // 空欄のまま押されたら全体的な掘り下げとして扱う。
      // そのとき出す文は作者が書いたものではないので、
      // 何を頼んだのかが読んで分かる文にし、字体でも区別する
      chatLog.push({
        role: "author",
        text: text || "観点を指定せず、全体的に掘り下げるよう頼みました。",
        unspecified: text === "",
      });
      post("chat", { kind: detail.kind, id: detail.id, question: text });
      questionText = "";
      renderDetail();
    });
    askRow.appendChild(askButton);
    el.detail.appendChild(askRow);

    // ── 参考（食い違い・抽出根拠）
    // 毎回読むものではないので最後に置く。上に置くと、
    // 登場話や編集欄が画面の外へ押し出されて読みにくい
    if (detail.reference && detail.reference.length > 0) {
      el.detail.appendChild(heading("参考"));
      for (const entry of detail.reference) {
        const line = document.createElement("div");
        line.className = "readonly";
        const key = document.createElement("span");
        key.className = "k";
        key.textContent = entry.label;
        line.appendChild(key);
        line.appendChild(document.createTextNode(entry.value));
        el.detail.appendChild(line);
      }
    }

    // 高さは画面に載せてからでないと測れない
    applyPendingGrow();
  }

  function renderProposal() {
    const box = document.createElement("div");
    box.className = "note proposal";

    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent =
      "提案です。まだ保存していません。反映する項目にチェックを入れてください。";
    box.appendChild(banner);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = proposal.model;
    box.appendChild(meta);

    const controls = [];

    // 項目が多いと、反映のたびに下まで送ることになる。上にも同じ操作を置く
    box.appendChild(bulkRow(controls));
    for (const item of proposal.proposals) {
      const row = document.createElement("div");
      row.className = "field-row";

      const head = document.createElement("div");
      head.className = "head";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = item.selected;
      check.id = "prop-" + item.key;
      head.appendChild(check);
      const label = document.createElement("label");
      label.textContent = item.label;
      label.htmlFor = check.id;
      head.appendChild(label);
      if (item.before) {
        // 既にある内容を置き換える提案は、目立たせて既定で選ばない
        const warn = document.createElement("span");
        warn.className = "overwrite";
        warn.textContent = "現在の内容を置き換えます";
        head.appendChild(warn);
      }
      row.appendChild(head);

      if (item.before) {
        const before = document.createElement("div");
        before.className = "before";
        const key = document.createElement("span");
        key.className = "k";
        key.textContent = "現在:";
        before.appendChild(key);
        before.appendChild(document.createTextNode(item.before));
        row.appendChild(before);
      }

      const editor = document.createElement(item.multiline ? "textarea" : "input");
      editor.value = item.after;
      // 提案は長いことが多い。隠れていると、何を反映するのか読めない
      if (item.multiline) growWithContent(editor);
      // 選択と手直しを提案側へ書き戻す。再描画で元へ戻さないため
      editor.addEventListener("input", function () {
        item.after = editor.value;
      });
      check.addEventListener("change", function () {
        item.selected = check.checked;
      });
      row.appendChild(editor);

      controls.push({ key: item.key, check: check, editor: editor });
      box.appendChild(row);
    }

    box.appendChild(bulkRow(controls));
    return box;
  }

  /**
   * 提案の一括操作。上下の両方に同じものを置く。
   *
   * controls は行を作りながら push される配列で、
   * 押された時点の中身を見る。上の行を先に作れるのはそのため。
   */
  function bulkRow(controls) {
    const row = document.createElement("div");
    row.className = "bulk";

    const selectAll = document.createElement("button");
    selectAll.className = "action secondary";
    selectAll.textContent = "すべて選ぶ";
    selectAll.addEventListener("click", function () {
      // 現在の内容を置き換える提案も含めて選ぶ。
      // 押した本人の意思なので、ここで勝手に除かない
      for (const item of proposal.proposals) item.selected = true;
      renderDetail();
    });
    row.appendChild(selectAll);

    const clearAll = document.createElement("button");
    clearAll.className = "action secondary";
    clearAll.textContent = "選択を解除";
    clearAll.addEventListener("click", function () {
      for (const item of proposal.proposals) item.selected = false;
      renderDetail();
    });
    row.appendChild(clearAll);

    const apply = document.createElement("button");
    apply.className = "action";
    apply.textContent = "選んだ項目を反映";
    apply.disabled = busy;
    apply.addEventListener("click", function () {
      const values = {};
      let count = 0;
      for (const control of controls) {
        if (!control.check.checked) continue;
        values[control.key] = control.editor.value;
        count++;
      }
      if (count === 0) {
        setStatus("反映する項目が選ばれていません。", true);
        return;
      }
      post("applyProposal", { kind: proposal.kind, id: proposal.id, values: values });
    });
    row.appendChild(apply);

    const discard = document.createElement("button");
    discard.className = "action secondary";
    discard.textContent = "破棄";
    discard.addEventListener("click", function () {
      proposal = null;
      setStatus("提案を破棄しました。保存はしていません。");
      renderDetail();
    });
    row.appendChild(discard);
    return row;
  }

  function renderDraft() {
    const box = document.createElement("div");
    box.className = "note draft";

    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = "下書きです。まだ保存していません。内容を確認し、必要なら直してから追記してください。";
    box.appendChild(banner);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (draft.topic || "全体") + " / " + draft.model;
    box.appendChild(meta);

    const body = document.createElement("textarea");
    body.value = draft.text;
    body.rows = 8;
    // 手直しした内容を draft 側へ書き戻す。
    // 再描画で作者の直しが元へ戻るのは、AIの文章より惜しい
    body.addEventListener("input", function () {
      draft.text = body.value;
    });
    box.appendChild(body);

    const row = document.createElement("div");
    row.className = "row";
    const approve = document.createElement("button");
    approve.className = "action";
    approve.textContent = "追記する";
    approve.disabled = busy;
    approve.addEventListener("click", function () {
      post("approveNote", {
        kind: detail.kind,
        id: detail.id,
        topic: draft.topic,
        text: body.value,
        source: draft.source,
      });
    });
    row.appendChild(approve);

    const discard = document.createElement("button");
    discard.className = "action secondary";
    discard.textContent = "破棄";
    discard.addEventListener("click", function () {
      draft = null;
      setStatus("下書きを破棄しました。保存はしていません。");
      renderDetail();
    });
    row.appendChild(discard);
    box.appendChild(row);
    return box;
  }

  function renderNote(note) {
    const box = document.createElement("div");
    box.className = "note";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent =
      (note.source === "chat" ? "質問への回答" : "掘り下げ") +
      " / " + (note.topic || "全体") +
      " / " + note.model +
      " / " + (note.createdAt || "").slice(0, 10);
    box.appendChild(meta);

    const body = document.createElement("div");
    // html は拡張機能側で無害化・整形済み（core/markdownLite.ts）
    body.className = "body rendered";
    body.innerHTML = note.html;
    box.appendChild(body);

    const row = document.createElement("div");
    row.className = "row";
    const remove = document.createElement("button");
    remove.className = "action secondary";
    remove.textContent = "削除";
    remove.disabled = busy;
    remove.addEventListener("click", function () {
      post("deleteNote", { kind: detail.kind, id: detail.id, noteId: note.id });
    });
    row.appendChild(remove);
    box.appendChild(row);
    return box;
  }

  function renderTurn(turn) {
    const box = document.createElement("div");
    box.className = "chat-turn " + turn.role;
    const who = document.createElement("div");
    who.className = "who";
    // 「あなた」だけでは何の欄か分からない、という指摘があった。
    // 何を見ているのかが読んで分かる見出しにする
    who.textContent = turn.role === "author" ? "聞いたこと" : "AIの回答";
    box.appendChild(who);
    const body = document.createElement("div");
    body.className = "body";
    if (turn.role === "author" && turn.unspecified) {
      body.classList.add("unspecified");
    }
    if (turn.role === "assistant" && turn.html) {
      // AIの応答はMarkdownで返ってくる。記号のまま見せない。
      // html は拡張機能側で無害化・整形済み
      body.classList.add("rendered");
      body.innerHTML = turn.html;
    } else {
      body.textContent = turn.text;
    }
    box.appendChild(body);

    if (turn.role === "assistant") {
      const row = document.createElement("div");
      row.className = "row";
      const keep = document.createElement("button");
      keep.className = "action secondary";
      keep.textContent = "この回答をメモにする";
      keep.disabled = busy;
      keep.addEventListener("click", function () {
        // すぐには保存せず、手直しできる下書きにする。
        // AIの文章をそのまま残したいとは限らない
        draft = {
          topic: turn.question || "",
          text: turn.text,
          model: turn.model || "",
          source: "chat",
        };
        setStatus("下書きにしました。内容を確認して「追記する」を押してください。");
        renderDetail();
      });
      row.appendChild(keep);
      box.appendChild(row);
    }
    return box;
  }

  el.search.addEventListener("input", renderList);

  window.addEventListener("message", function (event) {
    const message = event.data;
    switch (message.type) {
      case "init":
        groups = message.groups;
        renderTabs();
        renderList();
        setStatus(message.notice || "");
        break;
      case "detail":
        detail = message.detail;
        renderDetail();
        break;
      case "focus":
        // 本文で用語をクリックしたとき。種別タブと一覧の選択も合わせる
        activeKind = message.kind;
        selected = { kind: message.kind, id: message.id };
        detail = message.detail;
        draft = null;
        proposal = null;
        chatLog = [];
        questionText = "";
        renderTabs();
        renderList();
        renderDetail();
        el.detail.scrollTop = 0;
        break;
      case "draft":
        draft = { topic: message.topic, text: message.text, model: message.model, source: "deep_dive" };
        setStatus("下書きができました。まだ保存していません。");
        renderDetail();
        break;
      case "proposal":
        proposal = message;
        setStatus(
          message.proposals.length + " 項目の提案ができました。まだ保存していません。"
        );
        renderDetail();
        break;
      case "chatAnswer":
        chatLog.push({
          role: "assistant",
          text: message.text,
          html: message.html,
          question: message.question,
          model: message.model,
        });
        renderDetail();
        break;
      case "saved":
        draft = null;
        proposal = null;
        detail = message.detail;
        groups = message.groups;
        renderTabs();
        renderList();
        renderDetail();
        setStatus(message.notice || "保存しました。");
        break;
      case "busy":
        busy = message.busy;
        setStatus(message.label || "");
        renderDetail();
        break;
      case "error":
        setStatus(message.message, true);
        busy = false;
        renderDetail();
        break;
    }
  });

  post("ready");
}());
</script>
</body>
</html>`;
}
