import { PHOTO_EXAMPLE_CHARS, UNREADABLE_MARK } from "../prompts/photoTranscribe";
import { PHOTO_REQUEST_MAX_CHARS } from "../core/photoTranscribeRequest";
import { INLINE_REPEAT_STOP_NOTE } from "../core/photoTranscribeValidation";
import { SPREAD_ASPECT } from "../core/photoOrientValidation";
import { ORIENT_PROBE_TURNS, PHOTO_ORIENT_EDGE } from "../prompts/photoOrient";

/**
 * 写真から原稿を起こす画面（設計書6.117）。
 *
 * **画像の処理（回す・左右に切る・縮める）は、この画面の canvas で行う。**
 * 拡張機能の側は写真のバイト列を読んで渡すだけにして、Node の画像の部品を
 * 使わない（ブラウザ版でも同じ道で動く。規則7）。
 *
 * 写真の向きの印（EXIF）は `<img>` が描くときに当たる（Chromium は `<img>`・
 * `drawImage` とも印に合わせて回す。2026-10-11 に確かめた。`core/exifOrientation.ts`）。
 * ここで重ねて回すと二重になるので、拡張機能が読んだ印の値（`orientation`）は
 * 「自動で回した」と写真の札に出すのにだけ使う。作者が直す90度ずつの回転は、
 * 画面で見た向きを基準にする。
 *
 * 写真を読み込んだら、手元のAIに向きを尋ねる（設計書6.117.11。拡張機能が
 * 「尋ねてよい」と知らせたときだけ）。見えている向きから回した写し（長辺1,024px）を
 * 渡し、推しが返ったら、その向き・切り方で置き直して札に出す。**作者が先に
 * 回した・切り方を変えた・外した写真には当てない**（作者の操作が勝つ）。
 * 書き起こしは勝手に始めない。
 */

/** 送る前に縮める長辺（px）。Claude の1枚5MBの上限に余裕を持って入る。字が潰れないよう、これより小さくしない */
export const PHOTO_MAX_EDGE = 2000;

export function buildPhotoTranscribeHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 12px 16px;
  font-size: 13px;
}
h1 { font-size: 15px; margin: 0 0 4px; }
.sub { color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none; padding: 4px 10px; cursor: pointer; margin: 2px 4px 2px 0;
}
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button:disabled { opacity: 0.5; cursor: default; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
.ai { padding: 6px 8px; border-left: 3px solid var(--vscode-focusBorder); margin: 8px 0; }
.ai.ng { border-left-color: var(--vscode-errorForeground); }
.ai .note { color: var(--vscode-descriptionForeground); font-size: 12px; }
.photos { display: flex; flex-wrap: wrap; gap: 12px; }
.photo { border: 1px solid var(--vscode-panel-border); padding: 6px; width: 260px; }
.photo canvas { width: 100%; height: auto; display: block; background: #888; }
.photo .name { font-size: 11px; word-break: break-all; color: var(--vscode-descriptionForeground); }
.photo label { display: block; margin-top: 4px; }
.pages { margin-top: 16px; }
.page { display: flex; flex-wrap: wrap; gap: 12px; border-top: 1px solid var(--vscode-panel-border); padding: 10px 0; }
.page .shot { flex: 1 1 320px; max-width: 520px; }
.page .shot img { width: 100%; height: auto; display: block; }
.page .edit { flex: 1 1 320px; }
.page textarea {
  width: 100%; min-height: 260px; box-sizing: border-box;
  font-family: var(--vscode-editor-font-family); font-size: 14px; line-height: 1.7;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
}
.marks {
  white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family);
  font-size: 13px; line-height: 1.7; margin-top: 6px; padding: 6px;
  background: var(--vscode-textBlockQuote-background); max-height: 240px; overflow: auto;
}
mark.unread { background: var(--vscode-editorError-foreground, #e51400); color: #fff; padding: 0 1px; }
mark.latin { background: var(--vscode-editorWarning-foreground, #bf8803); color: #000; }
mark.example { background: var(--vscode-editorInfo-foreground, #3794ff); color: #fff; padding: 0 1px; }
.request { margin: 8px 0; }
.request label { display: block; margin-bottom: 2px; }
.request textarea {
  width: 100%; max-width: 640px; box-sizing: border-box; min-height: 3.6em;
  font-family: var(--vscode-font-family); font-size: 13px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
}
.request .note { color: var(--vscode-descriptionForeground); font-size: 12px; }
.warn { color: var(--vscode-editorWarning-foreground); font-size: 12px; }
.err { color: var(--vscode-errorForeground); }
.count { font-size: 12px; margin: 4px 0; }
.save { position: sticky; bottom: 0; background: var(--vscode-editor-background); padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
</style>
</head>
<body>
<h1>写真から原稿を起こす</h1>
<p class="sub">写真ごとに向きを直し、見開きなら左右に切ってから書き起こします。挿入の印や取り消し線の扱いは、起こした文を見ながらご自分で直してください（AIには決めさせません）。読めない字は「${UNREADABLE_MARK}」になります。</p>

<div class="ai" id="ai" data-testid="photo-ai">AIを確かめています…</div>
<div class="bar">
  <button id="addPhotos" class="secondary" data-testid="photo-add">写真を足す</button>
  <button id="pickAi" class="secondary" data-testid="photo-pick-ai">AIを選ぶ</button>
</div>

<div class="photos" id="photos" data-testid="photo-list"></div>

<div class="request">
  <label for="request">AIへの頼み（なくてもかまいません。この作品のフォルダーに保存し、同期でほかのパソコンとも共有します）</label>
  <textarea id="request" data-testid="photo-request" placeholder="例：旧字体はそのまま。ルビの小さい字は（）に入れる。"></textarea>
  <div class="note">書いてあるとおりに写す・読めない字を補わない、という決まりとぶつかる頼みは聞きません。</div>
  <div id="requestCount" class="count" data-testid="photo-request-count"></div>
  <div id="requestNote" class="count err" data-testid="photo-request-note"></div>
</div>

<div class="bar">
  <button id="run" data-testid="photo-run" disabled>書き起こす</button>
  <button id="cancel" class="secondary" data-testid="photo-cancel" disabled>中止</button>
  <span id="status" class="count"></span>
</div>

<div class="pages" id="pages" data-testid="photo-pages"></div>

<div class="save bar">
  <button id="saveNew" data-testid="photo-save-new" disabled>新しい話として保存</button>
  <button id="insert" class="secondary" data-testid="photo-insert" disabled>開いている話のカーソルの行へ差し込む</button>
  <span id="total" class="count"></span>
</div>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var MARK = ${JSON.stringify(UNREADABLE_MARK)};
  var REPEAT_NOTE = ${JSON.stringify(INLINE_REPEAT_STOP_NOTE)};
  var MAX_EDGE = ${PHOTO_MAX_EDGE};
  var SPREAD = ${SPREAD_ASPECT};
  var ORIENT_EDGE = ${PHOTO_ORIENT_EDGE};
  var ORIENT_TURNS = ${JSON.stringify(ORIENT_PROBE_TURNS)};
  /** 指示に例として挙げた字（答えに出たら写真と見比べてもらう） */
  var EXAMPLE_CHARS = ${JSON.stringify(PHOTO_EXAMPLE_CHARS)};
  /** 頼みの上限（字）。拡張機能の側も同じ数え方で確かめる */
  var REQUEST_MAX = ${PHOTO_REQUEST_MAX_CHARS};
  /**
   * 写真の並び。{ id, name, img, rotation(0/90/180/270), split, order("lr"|"rl"),
   *   orienting（手元のAIに向きを尋ねている間）, orientNote（推しの札）, touched（作者が回した・切り方を変えた） }
   */
  var photos = [];
  /** ページの並び（書き起こしの結果）。{ id, label, dataUrl, textarea } */
  var pages = [];
  var running = false;
  var aiOk = false;
  /** 手元のAIに向きを尋ねてよいか（拡張機能が知らせる） */
  var canOrient = false;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function rotatedSize(photo) {
    var w = photo.img.naturalWidth, h = photo.img.naturalHeight;
    return photo.rotation % 180 === 0 ? { w: w, h: h } : { w: h, h: w };
  }

  /** 回した全体を、長辺 limit px までの canvas に描く */
  function drawRotated(photo, limit) {
    var size = rotatedSize(photo);
    var scale = Math.min(1, limit / Math.max(size.w, size.h));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(size.w * scale));
    canvas.height = Math.max(1, Math.round(size.h * scale));
    var ctx = canvas.getContext("2d");
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(photo.rotation * Math.PI / 180);
    var dw = photo.img.naturalWidth * scale, dh = photo.img.naturalHeight * scale;
    ctx.drawImage(photo.img, -dw / 2, -dh / 2, dw, dh);
    return canvas;
  }

  /** 送る形に切り出す。左右に切るなら2ページ。どれも長辺 MAX_EDGE まで */
  function pagesOf(photo, index) {
    var size = rotatedSize(photo);
    var full = drawRotated(photo, Math.max(size.w, size.h));
    var parts = photo.split
      ? [{ x: 0, w: Math.floor(full.width / 2), side: "左" }, { x: Math.floor(full.width / 2), w: full.width - Math.floor(full.width / 2), side: "右" }]
      : [{ x: 0, w: full.width, side: "" }];
    if (photo.split && photo.order === "rl") parts.reverse();
    return parts.map(function (part, n) {
      var scale = Math.min(1, MAX_EDGE / Math.max(part.w, full.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(part.w * scale));
      canvas.height = Math.max(1, Math.round(full.height * scale));
      canvas.getContext("2d").drawImage(full, part.x, 0, part.w, full.height, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      return {
        id: photo.id + "-" + n,
        label: (index + 1) + "枚目" + (part.side ? "・" + part.side + "のページ" : ""),
        dataUrl: dataUrl,
        base64: dataUrl.slice(dataUrl.indexOf(",") + 1)
      };
    });
  }

  function renderPhotos() {
    var box = document.getElementById("photos");
    box.textContent = "";
    photos.forEach(function (photo, index) {
      var card = el("div", { "class": "photo", "data-testid": "photo-card" });
      var canvas = drawRotated(photo, 520);
      if (photo.split) {
        var ctx = canvas.getContext("2d");
        ctx.strokeStyle = "#e51400"; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
        ctx.beginPath(); ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height); ctx.stroke();
      }
      card.appendChild(canvas);
      card.appendChild(el("div", { "class": "name" }, (index + 1) + "枚目：" + photo.name));
      var autoNote = autoRotationNote(photo.orientation);
      if (autoNote) card.appendChild(el("div", { "class": "name", "data-testid": "photo-auto-rotated" }, autoNote));
      if (photo.orienting) card.appendChild(el("div", { "class": "name", "data-testid": "photo-orienting" }, "向きを手元のAIに尋ねています…（このまま回してもかまいません）"));
      if (photo.orientNote) card.appendChild(el("div", { "class": "name", "data-testid": "photo-orient-guess" }, photo.orientNote));
      var bar = el("div", { "class": "bar" });
      var left = el("button", { "class": "secondary", "title": "左へ90度回す", "data-testid": "photo-rotate-left" }, "⟲ 左へ回す");
      left.onclick = function () { touch(photo); setRotation(photo, photo.rotation + 270); };
      var right = el("button", { "class": "secondary", "title": "右へ90度回す", "data-testid": "photo-rotate-right" }, "⟳ 右へ回す");
      right.onclick = function () { touch(photo); setRotation(photo, photo.rotation + 90); };
      var remove = el("button", { "class": "secondary", "title": "この写真を外す" }, "外す");
      remove.onclick = function () { touch(photo); photos.splice(photos.indexOf(photo), 1); renderPhotos(); };
      bar.appendChild(left); bar.appendChild(right); bar.appendChild(remove);
      card.appendChild(bar);
      var splitLabel = el("label");
      var split = el("input", { type: "checkbox", "data-testid": "photo-split" });
      split.checked = photo.split;
      split.onchange = function () { touch(photo); photo.split = split.checked; renderPhotos(); };
      splitLabel.appendChild(split);
      splitLabel.appendChild(document.createTextNode(" 見開き：左右に切る"));
      card.appendChild(splitLabel);
      if (photo.split) {
        var orderLabel = el("label", {}, "読む順：");
        var order = el("select", { "data-testid": "photo-order" });
        order.appendChild(el("option", { value: "lr" }, "左のページから（横書き）"));
        order.appendChild(el("option", { value: "rl" }, "右のページから（縦書き）"));
        order.value = photo.order;
        order.onchange = function () { photo.order = order.value; };
        orderLabel.appendChild(order);
        card.appendChild(orderLabel);
      }
      box.appendChild(card);
    });
    updateButtons();
  }

  /**
   * 写真の向きの印で自動で回したことを伝える1行。印が無い・そのままの向き（1）なら出さない。
   * 角度の決め方は core/exifOrientation.ts の rotationForOrientation と同じ表
   */
  function autoRotationNote(orientation) {
    var turn = { 2: "左右を反転", 3: "180度回転", 4: "上下を反転", 5: "右へ90度回して反転", 6: "右へ90度回転", 7: "左へ90度回して反転", 8: "左へ90度回転" }[orientation];
    return turn ? "写真の向きの印に合わせて自動で直しました（" + turn + "）。違っていれば下のボタンで回してください。" : "";
  }

  /**
   * 作者がこの写真を回した・切り方を変えた・外した。推しはもう当てない。
   * 尋ねている途中なら、拡張機能に止めてもらう（手元のAIを無駄に回さない）
   */
  function touch(photo) {
    photo.touched = true;
    photo.orientNote = "";
    if (photo.orienting) {
      photo.orienting = false;
      vscode.postMessage({ type: "orientCancel", id: photo.id });
    }
  }

  /** 見えている向きから回した写し（長辺 ORIENT_EDGE）を作って、手元のAIに向きを尋ねる */
  function askOrient(photo) {
    if (!canOrient || running) return;
    var images = ORIENT_TURNS.map(function (turn) {
      var canvas = drawRotated({ img: photo.img, rotation: (photo.rotation + turn) % 360 }, ORIENT_EDGE);
      var dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      return { turn: turn, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    });
    photo.orienting = true;
    vscode.postMessage({ type: "orientProbe", id: photo.id, width: rotatedSize(photo).w, height: rotatedSize(photo).h, images: images });
  }

  function setRotation(photo, degrees) {
    photo.rotation = ((degrees % 360) + 360) % 360;
    // 回したら見開きの既定を置き直す（横長なら切る）
    var size = rotatedSize(photo);
    photo.split = size.w >= size.h * SPREAD;
    renderPhotos();
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }

  /** 〓とラテン文字の連なりを目立たせた写しを作る */
  function markUp(text) {
    return escapeHtml(text)
      .replace(/[A-Za-zＡ-Ｚａ-ｚ]{3,}/g, function (m) { return '<mark class="latin">' + m + "</mark>"; })
      .split(MARK).join('<mark class="unread">' + MARK + "</mark>")
      .replace(new RegExp("[" + EXAMPLE_CHARS.join("") + "]", "g"), function (m) { return '<mark class="example">' + m + "</mark>"; });
  }

  /** 頼みの字数。拡張機能と同じく、前後の空白を落として1字ずつ数える（絵文字も1字） */
  function requestChars() {
    return Array.from(document.getElementById("request").value.replace(/\\r\\n?/g, "\\n").trim()).length;
  }

  function requestOver() { return requestChars() > REQUEST_MAX; }

  function showRequestNote(text) {
    document.getElementById("requestNote").textContent = String(text || "");
  }

  function refreshRequest() {
    var n = requestChars();
    var box = document.getElementById("requestCount");
    if (n > REQUEST_MAX) {
      box.textContent = n + "／" + REQUEST_MAX + "字　" + REQUEST_MAX + "字を超えています。縮めてください（超えている間は書き起こせません）。";
      box.className = "count err";
    } else {
      box.textContent = n > 0 ? n + "／" + REQUEST_MAX + "字" : "";
      box.className = "count";
    }
    updateButtons();
  }

  function countMark(text) { return text.split(MARK).length - 1; }

  function refreshPage(page) {
    var text = page.textarea.value;
    page.marks.innerHTML = markUp(text);
    var n = countMark(text);
    page.count.textContent = n > 0 ? "読めない字（" + MARK + "）：" + n + "か所" : "読めない字（" + MARK + "）はありません";
    updateTotal();
  }

  function updateTotal() {
    var total = 0, chars = 0;
    pages.forEach(function (page) { total += countMark(page.textarea.value); chars += page.textarea.value.length; });
    document.getElementById("total").textContent = pages.length > 0
      ? "全部で " + chars + "字・" + MARK + " " + total + "か所" : "";
    updateButtons();
  }

  function combinedText() {
    return pages
      .map(function (page) { return page.textarea.value.replace(/\\s+$/, ""); })
      .filter(function (text) { return text !== ""; })
      .join("\\n");
  }

  function updateButtons() {
    document.getElementById("run").disabled = running || !aiOk || photos.length === 0 || requestOver();
    document.getElementById("request").disabled = running;
    document.getElementById("cancel").disabled = !running;
    document.getElementById("addPhotos").disabled = running;
    document.getElementById("pickAi").disabled = running;
    var hasText = combinedText() !== "";
    document.getElementById("saveNew").disabled = running || !hasText;
    document.getElementById("insert").disabled = running || !hasText;
  }

  function addPage(page) {
    var row = el("div", { "class": "page", "data-testid": "photo-page" });
    var shot = el("div", { "class": "shot" });
    shot.appendChild(el("div", { "class": "count" }, page.label));
    shot.appendChild(el("img", { src: page.dataUrl, alt: page.label }));
    var edit = el("div", { "class": "edit" });
    var status = el("div", { "class": "count" }, "書き起こしを待っています…");
    var textarea = el("textarea", { "data-testid": "photo-text", "aria-label": page.label + "の書き起こし" });
    textarea.disabled = true;
    var count = el("div", { "class": "count" });
    var next = el("button", { "class": "secondary", "data-testid": "photo-next-mark" }, "次の" + MARK + "へ");
    var marks = el("div", { "class": "marks", "aria-label": "読めない字と英字の目印" });
    edit.appendChild(status); edit.appendChild(textarea); edit.appendChild(count); edit.appendChild(next); edit.appendChild(marks);
    row.appendChild(shot); row.appendChild(edit);
    document.getElementById("pages").appendChild(row);
    var entry = { id: page.id, label: page.label, textarea: textarea, marks: marks, count: count, status: status };
    textarea.addEventListener("input", function () { refreshPage(entry); });
    next.onclick = function () {
      var value = textarea.value;
      var from = textarea.selectionEnd;
      var at = value.indexOf(MARK, from);
      if (at < 0) at = value.indexOf(MARK);
      if (at < 0) return;
      textarea.focus();
      textarea.setSelectionRange(at, at + MARK.length);
    };
    pages.push(entry);
  }

  document.getElementById("addPhotos").onclick = function () { vscode.postMessage({ type: "addPhotos" }); };
  document.getElementById("pickAi").onclick = function () { vscode.postMessage({ type: "pickAi" }); };
  document.getElementById("cancel").onclick = function () { vscode.postMessage({ type: "cancel" }); };
  document.getElementById("request").addEventListener("input", refreshRequest);
  // 欄を離れたら覚えてもらう（上限を超えていれば拡張機能の側が覚えない）
  document.getElementById("request").addEventListener("change", function () {
    vscode.postMessage({ type: "saveRequest", text: document.getElementById("request").value });
  });
  document.getElementById("run").onclick = function () {
    if (running || requestOver()) return;
    // 書き起こしを始めたら、向きを尋ねるのはやめる（拡張機能の側でも止める）。いまの向きで送る
    photos.forEach(function (photo) { photo.orienting = false; });
    renderPhotos();
    var out = [];
    photos.forEach(function (photo, index) { out = out.concat(pagesOf(photo, index)); });
    if (out.length === 0) return;
    document.getElementById("pages").textContent = "";
    pages = [];
    out.forEach(addPage);
    updateTotal();
    vscode.postMessage({
      type: "transcribe",
      photos: photos.length,
      request: document.getElementById("request").value,
      pages: out.map(function (page) { return { id: page.id, label: page.label, mimeType: "image/jpeg", base64: page.base64 }; })
    });
  };
  document.getElementById("saveNew").onclick = function () { vscode.postMessage({ type: "saveNew", text: combinedText() }); };
  document.getElementById("insert").onclick = function () { vscode.postMessage({ type: "insert", text: combinedText() }); };

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message.type !== "string") return;
    if (message.type === "photos") {
      message.items.forEach(function (item) {
        var img = new Image();
        img.onload = function () {
          var photo = { id: item.id, name: item.name, img: img, rotation: 0, split: false, order: "lr", orientation: item.orientation, orienting: false, orientNote: "", touched: false };
          // 横長の写真は見開きとして左右に切るのを既定にする（手元のAIの推しが返れば置き直す。設計書6.117.3）
          photo.split = img.naturalWidth >= img.naturalHeight * SPREAD;
          photos.push(photo);
          askOrient(photo);
          renderPhotos();
        };
        img.onerror = function () {
          vscode.postMessage({ type: "photoError", name: item.name });
        };
        img.src = item.dataUrl;
      });
    } else if (message.type === "request") {
      // 開いたときに、この作品で前に書いた頼みを入れる
      document.getElementById("request").value = String(message.text || "");
      showRequestNote(message.note);
      refreshRequest();
    } else if (message.type === "requestNote") {
      // 覚えられなかった理由（ファイルが壊れている・同期で書き換わった）。空なら消す
      showRequestNote(message.text);
    } else if (message.type === "ai") {
      var box = document.getElementById("ai");
      aiOk = message.canSend === true;
      canOrient = message.canOrient === true;
      box.className = aiOk ? "ai" : "ai ng";
      box.textContent = "";
      box.appendChild(el("div", {}, message.label));
      if (message.note) box.appendChild(el("div", { "class": "note" }, message.note));
      updateButtons();
    } else if (message.type === "orientResult") {
      var target = photos.filter(function (p) { return p.id === message.id; })[0];
      if (!target) return;
      target.orienting = false;
      // 作者が先に触った写真には当てない。推せなかったときは何も変えない（今までどおりの既定のまま）
      if (!target.touched && typeof message.rotation === "number" && typeof message.split === "boolean") {
        target.rotation = message.rotation;
        target.split = message.split;
        target.orientNote = String(message.label || "");
      }
      renderPhotos();
    } else if (message.type === "running") {
      running = message.on === true;
      document.getElementById("status").textContent = message.text || "";
      updateButtons();
    } else if (message.type === "pageResult") {
      var page = pages.filter(function (p) { return p.id === message.id; })[0];
      if (!page) return;
      if (message.ok) {
        page.textarea.value = message.text;
        page.textarea.disabled = false;
        var notes = [];
        if (message.stoppedEarly) notes.push("同じ行が繰り返されたので、途中で止めました。写真の向きをお確かめください。");
        if (message.repeatStopped) notes.push(REPEAT_NOTE);
        if (message.truncated) notes.push("答えが途中で切れています。");
        if (message.latin > 0) notes.push("英字が混じった所が " + message.latin + "か所あります（黄色）。");
        if (message.descriptive > 0) notes.push("写真の説明らしい行が " + message.descriptive + "行あります。");
        if (message.exampleChars > 0) notes.push("指示に例として挙げた字（" + EXAMPLE_CHARS.join("・") + "）が " + message.exampleChars + "か所あります（青）。写真にあるかお確かめください。");
        if (message.droppedEchoes > 0) notes.push("指示の言葉がそのまま返った " + message.droppedEchoes + "行を外しました。");
        page.status.textContent = notes.length > 0 ? notes.join(" ") : "書き起こしました。写真と見比べて直してください。";
        page.status.className = notes.length > 0 ? "warn" : "count";
        refreshPage(page);
      } else {
        page.status.textContent = message.error;
        page.status.className = "err";
        page.textarea.disabled = false;
        refreshPage(page);
      }
    }
  });

  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
