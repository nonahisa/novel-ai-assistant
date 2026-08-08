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
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#layout { display: flex; height: 100vh; }
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
input, textarea, select {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  padding: 4px 6px;
  font-family: inherit;
  font-size: inherit;
}
textarea { resize: vertical; min-height: 60px; }
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
.proposal .head { display: flex; align-items: center; gap: 6px; }
.proposal .head label { font-weight: bold; cursor: pointer; }
.proposal .before {
  font-size: 12px;
  opacity: 0.7;
  white-space: pre-wrap;
  margin: 4px 0 4px 20px;
}
.proposal textarea, .proposal input { margin-left: 20px; width: calc(100% - 20px); }
.proposal .overwrite {
  font-size: 11px;
  color: var(--vscode-notificationsWarningIcon-foreground, #cca700);
}
.draft .banner {
  font-size: 12px;
  margin-bottom: 6px;
  color: var(--vscode-notificationsWarningIcon-foreground, #cca700);
}
.chat-turn { margin-bottom: 10px; }
.chat-turn .who { font-size: 11px; opacity: 0.7; margin-bottom: 2px; }
.chat-turn .body {
  white-space: pre-wrap;
  padding: 6px 8px;
  border-radius: 3px;
  background: var(--vscode-textBlockQuote-background);
}
.chat-turn.author .body { background: transparent; border: 1px solid var(--vscode-panel-border); }
#status {
  padding: 6px 20px;
  font-size: 12px;
  min-height: 26px;
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
  const KIND_LABELS = { character: "登場人物", ability: "能力", location: "場所" };

  let groups = {};
  let activeKind = "character";
  let selected = null;
  let detail = null;
  let draft = null;
  let proposal = null;
  let chatLog = [];
  let busy = false;

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
    for (const kind of ["character", "ability", "location"]) {
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

    el.list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "該当がありません。";
      el.list.appendChild(empty);
      return;
    }

    for (const item of items) {
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
        renderList();
        post("select", { kind: activeKind, id: item.id });
      });
      el.list.appendChild(row);
    }
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

  function heading(text) {
    const node = document.createElement("h3");
    node.textContent = text;
    return node;
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
      const control = document.createElement(field.multiline ? "textarea" : "input");
      control.value = field.value;
      if (field.multiline) control.rows = 3;
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
      for (const key of Object.keys(inputs)) edits[key] = inputs[key].value;
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

    // ── AIによる掘り下げ（承認制）
    el.detail.appendChild(heading("AIで掘り下げる"));
    const diveHint = document.createElement("div");
    diveHint.className = "readonly";
    diveHint.textContent =
      "本文から読み取れることを文章で書かせます。項目には入らず、メモとして下に残ります。";
    el.detail.appendChild(diveHint);
    const topic = document.createElement("input");
    topic.type = "text";
    topic.placeholder = "観点（空欄なら全体的に掘り下げます）";
    el.detail.appendChild(topic);

    const diveRow = document.createElement("div");
    diveRow.className = "row";
    const diveButton = document.createElement("button");
    diveButton.className = "action";
    diveButton.textContent = "掘り下げる";
    diveButton.disabled = busy;
    diveButton.addEventListener("click", function () {
      post("deepDive", { kind: detail.kind, id: detail.id, topic: topic.value });
    });
    diveRow.appendChild(diveButton);
    el.detail.appendChild(diveRow);

    if (draft) el.detail.appendChild(renderDraft());

    if (detail.aiNotes.length > 0) {
      el.detail.appendChild(heading("追記済みの掘り下げ"));
      for (const note of detail.aiNotes) el.detail.appendChild(renderNote(note));
    }

    // ── チャット
    el.detail.appendChild(heading("この設定について質問する"));
    for (const turn of chatLog) el.detail.appendChild(renderTurn(turn));

    const question = document.createElement("textarea");
    question.placeholder = "例：この人物が第12話で嘘をついた理由は本文から読み取れますか？";
    question.rows = 2;
    el.detail.appendChild(question);

    const askRow = document.createElement("div");
    askRow.className = "row";
    const askButton = document.createElement("button");
    askButton.className = "action";
    askButton.textContent = "質問する";
    askButton.disabled = busy;
    askButton.addEventListener("click", function () {
      const text = question.value.trim();
      if (!text) return;
      chatLog.push({ role: "author", text: text });
      post("chat", { kind: detail.kind, id: detail.id, question: text });
      question.value = "";
      renderDetail();
    });
    askRow.appendChild(askButton);
    el.detail.appendChild(askRow);
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
        before.textContent = "現在: " + item.before;
        row.appendChild(before);
      }

      const editor = document.createElement(item.multiline ? "textarea" : "input");
      editor.value = item.after;
      if (item.multiline) editor.rows = 3;
      row.appendChild(editor);

      controls.push({ key: item.key, check: check, editor: editor });
      box.appendChild(row);
    }

    const row = document.createElement("div");
    row.className = "row";
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
    box.appendChild(row);
    return box;
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
    who.textContent = turn.role === "author" ? "あなた" : "AI";
    box.appendChild(who);
    const body = document.createElement("div");
    body.className = "body";
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
      keep.textContent = "この回答をメモとして追記";
      keep.disabled = busy;
      keep.addEventListener("click", function () {
        post("approveNote", {
          kind: detail.kind,
          id: detail.id,
          topic: turn.question || "",
          text: turn.text,
          source: "chat",
        });
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
