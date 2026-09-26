/**
 * 原稿エディターの画面へ差し込む、VS Code の代わり（内蔵ブラウザの試作）。
 *
 * 画面（src/views/manuscriptEditorHtml.ts）は `acquireVsCodeApi()` で
 * 拡張機能とやりとりする。ここでは同じ形（postMessage / getState / setState）の
 * 代役を置き、**開く・保存する**だけを読み書き役（desk/server.mjs）へ振り替える。
 * 画面そのものには手を入れない——拡張機能で直した画面が、そのままここでも動く。
 *
 * - 本文は、画面が打つたびに送る `edit` を覚えておき、**Ctrl+S か「保存」で送る**
 *   （VS Code の原稿エディターも、打つだけでは保存されず Ctrl+S で保存する）
 * - `getState` / `setState` は、話ごとにブラウザの保存域へ（読めなくても動く）
 * - ほかの用件（ルビ・用語・読み上げ・AI など）は、この試作ではまだ受けない
 *
 * `__NONCE__` は読み書き役が画面ごとの値に置き換える。
 */
export const DESK_PAGE_SHIM = `<style nonce="__NONCE__">
:root {
  --vscode-font-family: system-ui, "Yu Gothic UI", "Meiryo", sans-serif;
  --vscode-font-size: 13px;
  --vscode-foreground: #3b3b3b;
  --vscode-editor-foreground: #1f1f1f;
  --vscode-editor-background: #ffffff;
  --vscode-panel-border: #e5e5e5;
  --vscode-button-background: #005fb8;
  --vscode-button-foreground: #ffffff;
  --vscode-button-border: transparent;
  --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryHoverBackground: #cccccc;
  --vscode-dropdown-background: #ffffff;
  --vscode-dropdown-foreground: #3b3b3b;
  --vscode-dropdown-border: #cecece;
  --vscode-menu-background: #ffffff;
  --vscode-menu-foreground: #3b3b3b;
  --vscode-menu-border: #cecece;
  --vscode-menu-selectionBackground: #005fb8;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-separatorBackground: #e5e5e5;
  --vscode-editorWidget-background: #f8f8f8;
  --vscode-editorWidget-border: #c8c8c8;
  --vscode-notificationsInfoIcon-foreground: #1a85ff;
  --vscode-testing-iconPassed: #388a34;
}
#desk-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  font-size: 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
}
#desk-strip select { max-width: 60vw; font: inherit; }
#desk-strip .desk-status { color: var(--vscode-foreground); }
#desk-strip .desk-status.bad { color: #b3261e; font-weight: bold; }
</style>
<script nonce="__NONCE__">
(function () {
  var params = new URLSearchParams(location.search);
  var file = params.get("file") || "";
  var stateKey = "novelai-desk-state:" + file;
  /** 最後に保存した（か、開いた）ときの本文 */
  var savedText = null;
  /** 画面がいま持っている本文（打つたびに届く edit） */
  var latest = null;
  var readOnly = false;
  var saving = false;
  var strip = null, statusEl = null, saveButton = null;

  function readState() {
    try { var raw = localStorage.getItem(stateKey); return raw ? JSON.parse(raw) : undefined; }
    catch (e) { return undefined; }
  }
  function writeState(value) {
    try { localStorage.setItem(stateKey, JSON.stringify(value)); } catch (e) { /* 覚えられなくても書ける */ }
  }
  function call(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data }; });
    });
  }
  function isDirty() { return latest !== null && savedText !== null && latest !== savedText; }
  function status(text, bad) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "desk-status" + (bad ? " bad" : "");
  }
  function paintDirty() {
    if (readOnly) return;
    if (saving) return;
    status(isDirty() ? "未保存（Ctrl+S で保存）" : "保存済み", false);
  }
  /** 拡張機能から画面への知らせと同じ道（window の message）で渡す */
  function deliver(message) { window.postMessage(message, location.origin); }

  function open(saved) {
    if (!file) { status("話を選んでください", false); return; }
    call("/api/open", { file: file, saved: saved }).then(function (res) {
      if (res.status !== 200) { status(res.data.error || "開けませんでした", true); return; }
      savedText = res.data.update.text;
      latest = savedText;
      readOnly = res.data.readOnly === true;
      deliver(res.data.update);
      if (readOnly) status("競合の印があるため、読むだけで開いています（保存しません）", true);
      else paintDirty();
    }, function () { status("読み書き役に届きません", true); });
  }

  function save() {
    if (!file || readOnly || saving || !isDirty()) return;
    var sending = latest;
    saving = true;
    status("保存しています…", false);
    call("/api/save", { file: file, text: sending }).then(function (res) {
      saving = false;
      if (res.data && res.data.ok) { savedText = sending; paintDirty(); return; }
      // 書かなかった。打った本文は画面に残したまま、理由を出す
      status((res.data && res.data.message) || "保存できませんでした", true);
    }, function () {
      saving = false;
      status("読み書き役に届かないため、保存できませんでした", true);
    });
  }

  function onMessage(message) {
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "ready":
        open(message.saved);
        return;
      case "edit":
        if (typeof message.text === "string") { latest = message.text; paintDirty(); }
        return;
      case "log":
        call("/api/log", message);
        return;
      case "count":
      case "caret":
      case "appearance":
        return;
      default:
        console.info("[desk] この試作ではまだ受けない用件:", message.type);
    }
  }

  var api = { postMessage: onMessage, getState: readState, setState: writeState };
  var acquired = false;
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error("acquireVsCodeApi は1度だけ呼べます");
    acquired = true;
    return api;
  };

  function buildStrip() {
    strip = document.getElementById("desk-strip");
    if (!strip) return;
    var select = document.createElement("select");
    select.title = "話を選ぶ";
    saveButton = document.createElement("button");
    saveButton.textContent = "保存";
    saveButton.title = "保存（Ctrl+S）";
    saveButton.addEventListener("click", save);
    statusEl = document.createElement("span");
    statusEl.className = "desk-status";
    strip.appendChild(select);
    strip.appendChild(saveButton);
    strip.appendChild(statusEl);
    call("/api/episodes", {}).then(function (res) {
      var first = document.createElement("option");
      first.value = "";
      first.textContent = res.data.work ? res.data.work + " の話を選ぶ" : "話を選ぶ";
      select.appendChild(first);
      (res.data.episodes || []).forEach(function (name) {
        var option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        if (name === file) option.selected = true;
        select.appendChild(option);
      });
    });
    select.addEventListener("change", function () {
      if (isDirty() && !confirm("保存していない変更があります。保存せずにほかの話へ移りますか？")) {
        select.value = file;
        return;
      }
      savedText = latest; // 移る前の「未保存」の確認を二重に出さない
      location.search = "?file=" + encodeURIComponent(select.value);
    });
    if (!file) status("話を選んでください", false);
  }

  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      save();
    }
  }, true);
  window.addEventListener("beforeunload", function (event) {
    if (isDirty()) { event.preventDefault(); event.returnValue = ""; }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildStrip);
  else buildStrip();
})();
</script>
`;
