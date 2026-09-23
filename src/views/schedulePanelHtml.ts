/**
 * スケジュールの画面（設計書6.111.7）。**縦が時間、横が作品。**
 *
 * - 上が今日寄り、下へ未来。縦にスクロールする。今日の線と月の区切り線
 * - 作品の列の中に、スケジュールごとの細い列（レーン）。段取りは帯、マイルストーンは ◆
 * - WEB連載は投稿予定日を点で縦に並べ、投稿済み・書き溜め・未執筆・過ぎて未投稿を
 *   **色と記号（●◐○×）の両方で**分ける（色が分からなくても区別できるように。編集履歴と同じ）
 * - 段を押すと右に詳細を出して直せる。作品の見出しを押すと作品を開く
 * - **並行の段は、同じレーンの中で横に並べる**（帯を組の数で細く分ける。6.111.13）。
 *   人に頼む段は帯を点線で縁取る。作業が重なる段は「重なり」の印（6.111.14）
 * - 日付の軸に**祝日の名前**、休み（割合0）の日は薄い帯（6.111.12）
 *
 * **描くのは絶対位置の要素だけ**で、日ごとの行は作らない。3年分でも要素は段と投稿日と
 * 月の線だけ（数百個）なので、見えている範囲だけ描く仕組みは入れていない。
 *
 * 画面の文字はすべて `textContent` で入れる（作品名やメモに記号が入っても崩れない・
 * 差し込まれない）。
 *
 * 埋め込みのスクリプトには**テンプレート文字列を使わない**（この関数自体がテンプレート
 * 文字列なので、`${` が混ざると外側で展開されてしまう）。
 */
export function buildSchedulePanelHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
  --head-h: 96px;
  --axis-w: 124px;
  --lane-w: 124px;
  --serial-w: 150px;
  --todo: var(--vscode-charts-blue, #3794ff);
  --late: var(--vscode-charts-red, #f14c4c);
  --done: var(--vscode-charts-green, #89d185);
  --stock: var(--vscode-charts-blue, #3794ff);
  --warn: var(--vscode-charts-orange, #d18616);
  --line: var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
}
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  font-size: 12px;
  overflow: hidden;
}
button {
  font: inherit;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
}
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
input, select, textarea {
  font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--line));
  padding: 2px 4px;
}
header {
  display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
  padding: 8px 12px; border-bottom: 1px solid var(--line);
}
header h1 { font-size: 14px; margin: 0 8px 0 0; }
.scale button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.legend { color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 8px; }
.legend .sym { font-weight: 600; margin-right: 2px; }
#empty { padding: 24px 16px; display: none; }
#empty p { margin: 0 0 10px; }
#scroller { position: relative; overflow: auto; height: calc(100vh - 44px); }
#grid { display: flex; min-width: max-content; position: relative; }
.axis { position: sticky; left: 0; z-index: 3; width: var(--axis-w); flex: none; background: var(--vscode-editor-background); border-right: 1px solid var(--line); }
.colhead { position: sticky; top: 0; z-index: 2; height: var(--head-h); background: var(--vscode-editor-background); border-bottom: 1px solid var(--line); overflow: hidden; }
.axis .colhead { z-index: 4; }
.body { position: relative; }
.work { flex: none; border-right: 1px solid var(--line); }
.work-title { display: block; width: 100%; text-align: left; border: none; border-bottom: 1px solid var(--line); border-radius: 0; font-weight: 600; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: transparent; color: var(--vscode-textLink-foreground); }
.work-title:hover { text-decoration: underline; }
.lane-heads { display: flex; }
.lane-head { flex: none; padding: 3px 5px; cursor: pointer; border-right: 1px dotted var(--line); height: calc(var(--head-h) - 24px); overflow: hidden; }
.lane-head:hover { background: var(--vscode-list-hoverBackground); }
.lane-head .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane-head .sub { color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane-head .badge { color: var(--late); font-weight: 600; white-space: normal; line-height: 1.25; }
.lane-head .badge.soft { color: var(--warn); font-weight: normal; }
.column-error { padding: 6px; color: var(--late); white-space: normal; }
.month-line { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--line); pointer-events: none; }
.today-line { position: absolute; left: 0; right: 0; border-top: 2px solid var(--late); pointer-events: none; z-index: 1; }
.axis-label { position: absolute; left: 4px; right: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.axis-label.month { font-weight: 600; color: var(--vscode-foreground); }
.axis-label.today { color: var(--late); font-weight: 600; }
.lane { position: absolute; top: 0; bottom: 0; border-right: 1px dotted var(--line); }
.bar {
  position: absolute; left: 4px; right: 4px; min-height: 2px;
  background: color-mix(in srgb, var(--todo) 28%, transparent);
  border-left: 3px solid var(--todo);
  border-radius: 2px; overflow: hidden; cursor: pointer;
  font-size: 11px; line-height: 13px; padding: 0 3px; white-space: nowrap; text-overflow: ellipsis;
}
.bar.doing { outline: 1px solid var(--todo); }
.bar.done { opacity: 0.55; border-left-color: var(--done); background: color-mix(in srgb, var(--done) 22%, transparent); }
.bar.late { border-left-color: var(--late); background: color-mix(in srgb, var(--late) 22%, transparent); }
.bar.overlap { outline: 1px dashed var(--warn); }
.bar.zero { background: none; border-left: none; border-top: 2px dotted var(--done); height: 2px; padding: 0; }
.bar.selected { outline: 2px solid var(--vscode-focusBorder); }
.bar.others { border-left-style: dashed; background: color-mix(in srgb, var(--todo) 14%, transparent); }
.bar.loaded { box-shadow: inset 0 0 0 1px var(--warn); }
.rest-band { position: absolute; left: 0; right: 0; background: color-mix(in srgb, var(--vscode-descriptionForeground, #888) 12%, transparent); pointer-events: none; }
.axis-label.holiday { color: var(--late); left: 70px; right: 2px; font-size: 10px; overflow: hidden; text-overflow: ellipsis; }
.notes { width: 100%; color: var(--warn); }
.workload { color: var(--vscode-descriptionForeground); }
.serial .bar { right: auto; width: 66px; }
.milestone {
  position: absolute; left: 2px; right: 2px; height: 14px; line-height: 14px;
  font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  color: var(--vscode-foreground); border-top: 2px solid var(--vscode-foreground);
}
.milestone.estimated { border-top-style: dashed; font-weight: normal; color: var(--vscode-descriptionForeground); }
.wbar { position: absolute; left: 74px; width: 16px; background: color-mix(in srgb, var(--todo) 35%, transparent); border-radius: 2px; }
.wbar.late { background: color-mix(in srgb, var(--late) 45%, transparent); }
.dot {
  position: absolute; left: 96px; border-radius: 50%; text-align: center; font-size: 9px; font-weight: 700;
  border: 1px solid var(--vscode-descriptionForeground); color: var(--vscode-editor-background); overflow: hidden;
}
.dot.posted { background: var(--done); border-color: var(--done); }
.dot.stocked { background: var(--stock); border-color: var(--stock); }
.dot.unwritten { background: transparent; color: var(--vscode-descriptionForeground); }
.dot.missed { background: var(--late); border-color: var(--late); }
.dot-label { position: absolute; left: 110px; font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
#detail {
  position: fixed; top: 44px; right: 0; bottom: 0; width: min(360px, 100vw);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-left: 1px solid var(--line); padding: 10px 12px; overflow: auto; z-index: 10; display: none;
}
#detail.open { display: block; }
#detail h2 { font-size: 13px; margin: 0 0 6px; }
#detail .row { margin: 6px 0; }
#detail label { display: block; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
#detail input[type="text"], #detail input[type="number"], #detail input[type="date"], #detail select, #detail textarea { width: 100%; }
#detail textarea { min-height: 60px; resize: vertical; }
#detail .buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
#detail .note { color: var(--vscode-descriptionForeground); }
#detail ul.alerts { padding-left: 16px; margin: 4px 0; }
#detail ul.alerts li.strong { color: var(--late); font-weight: 600; }
.weekdays label { display: inline-block; margin-right: 6px; color: var(--vscode-foreground); }
</style>
</head>
<body>
<header>
  <h1>スケジュール</h1>
  <button id="add" class="primary">＋ スケジュールを足す</button>
  <span class="scale" role="group" aria-label="縮尺">
    <button data-scale="week">週</button><button data-scale="month">月</button><button data-scale="year">年</button>
  </span>
  <button id="toToday">今日へ</button>
  <label><input type="checkbox" id="showFinished"> 済んだ作品も見る</label>
  <button id="exportIcs" title="締切・発売日・連載開始日と、手で入れた期日だけを .ics に書き出します（Google カレンダーへ取り込めます）">カレンダーへ書き出す</button>
  <button id="importHolidays" title="押したときだけ祝日の一覧を取りに行きます。ふだんは拡張機能に入っている一覧を使います">祝日を取り込む</button>
  <button id="workloadSettings" title="平日・土日・祝日にどれだけ進むか、作業が重なったときの損">作業量の設定</button>
  <span class="workload" id="workload"></span>
  <span class="legend">
    <span><span class="sym" style="color:var(--done)">●</span>投稿済み</span>
    <span><span class="sym" style="color:var(--stock)">◐</span>書き溜め</span>
    <span><span class="sym">○</span>未執筆</span>
    <span><span class="sym" style="color:var(--late)">×</span>過ぎて未投稿</span>
    <span>◆ 締切・発売日・連載開始</span>
    <span>┆ 人に頼む段</span>
  </span>
  <div class="notes" id="notes"></div>
</header>
<div id="empty"></div>
<div id="scroller"><div id="grid"></div></div>
<aside id="detail" aria-label="詳細"></aside>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var saved = vscode.getState() || {};
  var state = { scale: saved.scale || "month", showFinished: !!saved.showFinished };
  var PX = { week: 24, month: 8, year: 3 };
  var board = null;
  var selection = null;
  var firstRender = true;
  var KIND_DAYS = ["日", "月", "火", "水", "木", "金", "土"];
  var STATUS = { todo: "未着手", doing: "進行中", done: "済み" };
  var SLOT = { posted: "投稿済み", stocked: "書き溜め（書いたが未投稿）", unwritten: "未執筆", missed: "予定日を過ぎて未投稿" };
  var SLOT_SYM = { posted: "●", stocked: "◐", unwritten: "○", missed: "×" };
  var SITES = [["", "どれか1つに出していれば"], ["narou", "小説家になろう"], ["kakuyomu", "カクヨム"], ["alphapolis", "アルファポリス"], ["note", "note"]];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function saveState() { vscode.setState({ scale: state.scale, showFinished: state.showFinished }); }
  function ms(key) { return Date.parse(key + "T00:00:00Z"); }
  function dayIndex(key) { return Math.round((ms(key) - ms(board.from)) / 86400000); }
  function px() { return PX[state.scale]; }
  function yOf(key) { return dayIndex(key) * px(); }
  function md(key) { var p = key.split("-"); return Number(p[1]) + "/" + Number(p[2]); }
  function addDays(key, days) { var d = new Date(ms(key)); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  function totalHeight() { return (dayIndex(board.to) + 1) * px(); }
  function laneWidth(plan) { return plan.schedule.kind === "webSerial" ? 150 : 124; }
  function post(message) { vscode.postMessage(message); }

  document.getElementById("add").addEventListener("click", function () { post({ type: "addSchedule", workId: null }); });
  document.getElementById("exportIcs").addEventListener("click", function () { post({ type: "exportIcs" }); });
  document.getElementById("importHolidays").addEventListener("click", function () { post({ type: "importHolidays" }); });
  document.getElementById("workloadSettings").addEventListener("click", function () { post({ type: "openWorkloadSettings" }); });
  var ACTOR = { self: "自分で進める", others: "人に頼む" };

  // 見出しの行は、ボタンと断りの数で折り返して高さが変わる。下の画面をその分だけ縮める
  function fitLayout() {
    var header = document.querySelector("header");
    var h = header ? header.offsetHeight : 44;
    document.getElementById("scroller").style.height = "calc(100vh - " + h + "px)";
    document.getElementById("detail").style.top = h + "px";
  }
  window.addEventListener("resize", fitLayout);

  function renderHeaderInfo() {
    var workload = document.getElementById("workload");
    var notes = document.getElementById("notes");
    workload.textContent = ""; notes.textContent = "";
    if (!board) return;
    var w = board.workload;
    if (w && !w.uniform) {
      var parts = ["平日 " + w.weekday, "土日 " + w.weekend, "祝日 " + w.holiday];
      for (var d = 0; d < 7; d++) {
        if (w.byWeekday[d] !== null && w.byWeekday[d] !== undefined) parts.push(KIND_DAYS[d] + "曜 " + w.byWeekday[d]);
      }
      workload.textContent = "作業量の割合：" + parts.join("・");
    }
    (board.notes || []).forEach(function (text) { notes.appendChild(el("div", "", text)); });
    fitLayout();
  }
  document.getElementById("toToday").addEventListener("click", scrollToToday);
  var finished = document.getElementById("showFinished");
  finished.checked = state.showFinished;
  finished.addEventListener("change", function () {
    state.showFinished = finished.checked; saveState();
    post({ type: "setShowFinished", value: state.showFinished });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".scale button"), function (button) {
    button.addEventListener("click", function () {
      var scroller = document.getElementById("scroller");
      var centerDay = board ? (scroller.scrollTop + scroller.clientHeight / 2) / px() : 0;
      state.scale = button.getAttribute("data-scale"); saveState();
      render();
      if (board) scroller.scrollTop = Math.max(0, centerDay * px() - scroller.clientHeight / 2);
    });
  });

  function scrollToToday() {
    if (!board) return;
    var scroller = document.getElementById("scroller");
    scroller.scrollTop = Math.max(0, yOf(board.today) - 60);
  }

  function markScale() {
    Array.prototype.forEach.call(document.querySelectorAll(".scale button"), function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-scale") === state.scale ? "true" : "false");
    });
  }

  function monthStarts() {
    var out = [];
    var p = board.from.split("-");
    var y = Number(p[0]); var m = Number(p[1]);
    for (var i = 0; i < 400; i++) {
      m += 1; if (m > 12) { m = 1; y += 1; }
      var key = y + "-" + (m < 10 ? "0" + m : m) + "-01";
      if (key > board.to) break;
      out.push(key);
    }
    return out;
  }

  function drawLines(body, withLabels) {
    // 休み（割合0）の日は薄い帯。続く休みは1本にまとめる（要素を増やしすぎない）
    var rest = board.restDays || [];
    for (var i = 0; i < rest.length; i++) {
      var first = rest[i]; var last = first;
      while (i + 1 < rest.length && rest[i + 1] === addDays(last, 1)) { i++; last = rest[i]; }
      var band = el("div", "rest-band");
      band.style.top = yOf(first) + "px";
      band.style.height = (dayIndex(last) - dayIndex(first) + 1) * px() + "px";
      body.appendChild(band);
    }
    if (withLabels) {
      (board.holidays || []).forEach(function (holiday) {
        // 年の縮尺では文字が重なるので、名前は出さずに印だけ
        var mark = el("div", "axis-label holiday", px() >= 8 ? "祝 " + holiday.name : "祝");
        // 週の縮尺では1日の高さに2行入るので、日付の下の行へ名前を全部出す
        if (px() >= 24) { mark.style.top = (yOf(holiday.date) + 11) + "px"; mark.style.left = "4px"; }
        else mark.style.top = yOf(holiday.date) + "px";
        mark.title = md(holiday.date) + " " + holiday.name;
        body.appendChild(mark);
      });
    }
    monthStarts().forEach(function (key) {
      var line = el("div", "month-line"); line.style.top = yOf(key) + "px"; body.appendChild(line);
      if (withLabels) {
        var p = key.split("-");
        var label = el("div", "axis-label month", (p[1] === "01" || key === monthStarts()[0] ? p[0] + "年" : "") + Number(p[1]) + "月");
        label.style.top = (yOf(key) + 1) + "px"; body.appendChild(label);
      }
    });
    if (withLabels && px() >= 8) {
      // 月曜ごとに日付を添える（週・月の縮尺だけ）
      for (var key = board.from; key <= board.to; key = addDays(key, 1)) {
        // 月の見出しと重なる月初めの数日は添えない
        if (new Date(ms(key)).getUTCDay() !== 1) continue;
        if (px() < 24 && (Number(key.slice(8)) <= 3 || Number(addDays(key, 2).slice(8)) <= 2)) continue;
        var tick = el("div", "axis-label", md(key) + "（月）");
        tick.style.top = yOf(key) + "px"; body.appendChild(tick);
      }
    }
    var today = el("div", "today-line"); today.style.top = yOf(board.today) + "px"; body.appendChild(today);
    if (withLabels) {
      var label = el("div", "axis-label today", "今日 " + md(board.today));
      label.style.top = (yOf(board.today) + 2) + "px"; body.appendChild(label);
    }
  }

  function render() {
    markScale();
    if (!board) return;
    renderHeaderInfo();
    var grid = document.getElementById("grid");
    var empty = document.getElementById("empty");
    var scroller = document.getElementById("scroller");
    var keepTop = scroller.scrollTop;
    grid.textContent = "";
    if (board.columns.length === 0) {
      scroller.style.display = "none";
      empty.style.display = "block";
      empty.textContent = "";
      empty.appendChild(el("p", "", "スケジュールのある作品がありません。"));
      empty.appendChild(el("p", "note", "「＋ スケジュールを足す」で、公募・自費出版・出版社からの出版・WEB連載の予定を作れます。作品目標設定で応募先を入れても、公募のスケジュールが出ます。"));
      if (board.hiddenCount > 0) {
        empty.appendChild(el("p", "note", "済んだ・過ぎた予定だけの作品が" + board.hiddenCount + "つあります（上の「済んだ作品も見る」で出せます）。"));
      }
      var button = el("button", "primary", "＋ スケジュールを足す");
      button.addEventListener("click", function () { post({ type: "addSchedule", workId: null }); });
      empty.appendChild(button);
      closeDetail();
      return;
    }
    scroller.style.display = "block";
    empty.style.display = "none";
    var height = totalHeight();

    var axis = el("div", "axis");
    var axisHead = el("div", "colhead");
    axisHead.appendChild(el("div", "note", ""));
    axis.appendChild(axisHead);
    var axisBody = el("div", "body"); axisBody.style.height = height + "px";
    drawLines(axisBody, true);
    axis.appendChild(axisBody);
    grid.appendChild(axis);

    board.columns.forEach(function (column) { grid.appendChild(renderColumn(column, height)); });

    if (firstRender) { firstRender = false; scrollToToday(); } else { scroller.scrollTop = keepTop; }
    if (selection) showDetail();
  }

  function renderColumn(column, height) {
    var width = column.plans.reduce(function (sum, plan) { return sum + laneWidth(plan); }, 0);
    var work = el("div", "work");
    work.style.width = Math.max(width, 160) + "px";
    var head = el("div", "colhead");
    var title = el("button", "work-title", column.title);
    title.title = "「" + column.title + "」を開く（いちばん新しい話）";
    title.addEventListener("click", function () { post({ type: "openWork", workId: column.workId }); });
    head.appendChild(title);
    var body = el("div", "body"); body.style.height = height + "px";
    if (column.error) {
      var error = el("div", "column-error", column.error);
      head.appendChild(error);
      var open = el("button", "", "ファイルを開く");
      open.addEventListener("click", function () { post({ type: "openFile", workId: column.workId }); });
      head.appendChild(open);
      drawLines(body, false);
      work.appendChild(head); work.appendChild(body);
      return work;
    }
    var heads = el("div", "lane-heads");
    drawLines(body, false);
    var left = 0;
    column.plans.forEach(function (plan) {
      var w = laneWidth(plan);
      heads.appendChild(renderLaneHead(column, plan, w));
      body.appendChild(renderLane(column, plan, left, w));
      left += w;
    });
    head.appendChild(heads);
    work.appendChild(head); work.appendChild(body);
    return work;
  }

  function renderLaneHead(column, plan, width) {
    var head = el("div", "lane-head");
    head.style.width = width + "px";
    head.title = plan.name + "（" + plan.kindLabel + "）— 押すと詳細";
    head.appendChild(el("div", "name", plan.name));
    var when = plan.milestone ? plan.milestoneLabel + " " + md(plan.milestone) : plan.milestoneLabel + " 未定";
    head.appendChild(el("div", "sub", plan.kindLabel + "・" + when));
    var first = plan.alerts.length ? plan.alerts[0] : null;
    if (plan.shortageDays > 0 && !plan.milestonePassed) {
      head.appendChild(el("div", "badge", "間に合いません（あと" + plan.shortageDays + "日）"));
    } else if (plan.serial && plan.serial.firstMiss) {
      head.appendChild(el("div", "badge", "書き溜めが尽きる見込み"));
    } else if (first) {
      head.appendChild(el("div", "badge soft", first));
    }
    head.addEventListener("click", function () {
      selection = { workId: column.workId, scheduleId: plan.schedule.id, stepId: null };
      render();
    });
    return head;
  }

  function renderLane(column, plan, left, width) {
    var lane = el("div", "lane" + (plan.schedule.kind === "webSerial" ? " serial" : ""));
    lane.style.left = left + "px"; lane.style.width = width + "px";
    var scale = px();
    plan.steps.forEach(function (planned) {
      var step = planned.step;
      if (step.status === "done" && planned.end < board.from) return;
      var bar = el("div", "bar " + step.status);
      if (planned.lateDays > 0) bar.classList.add("late");
      if (planned.overlapDays > 0) bar.classList.add("overlap");
      if (planned.actor === "others") bar.classList.add("others");
      if (planned.peakLoad > 1 && step.status !== "done") bar.classList.add("loaded");
      // 並行の段は、レーンの幅を組の数で分けて横に並べる
      var tracks = planned.tracks || 1;
      if (tracks > 1 && plan.schedule.kind !== "webSerial") {
        var inner = width - 8;
        var each = inner / tracks;
        bar.style.left = (4 + each * planned.track) + "px";
        bar.style.right = "auto";
        bar.style.width = Math.max(6, each - 2) + "px";
      }
      if (selection && selection.stepId === step.id && selection.scheduleId === plan.schedule.id && selection.workId === column.workId) bar.classList.add("selected");
      var top; var h;
      if (planned.days === 0 && step.status !== "done") {
        bar.classList.add("zero");
        top = yOf(planned.end) + scale; h = 2;
      } else {
        top = yOf(planned.start);
        h = Math.max(3, (dayIndex(planned.end) - dayIndex(planned.start) + 1) * scale);
      }
      bar.style.top = top + "px"; bar.style.height = h + "px";
      var text = (step.status === "done" ? "✓ " : "") + step.label + (step.due ? "（期日）" : "");
      if (h >= 12) bar.textContent = text;
      bar.title = describeStep(plan, planned);
      bar.addEventListener("click", function (event) {
        event.stopPropagation();
        selection = { workId: column.workId, scheduleId: plan.schedule.id, stepId: step.id };
        render();
      });
      lane.appendChild(bar);
    });
    if (plan.milestone) {
      var mark = el("div", "milestone", "◆ " + plan.milestoneLabel + " " + md(plan.milestone));
      mark.style.top = yOf(plan.milestone) + "px";
      lane.appendChild(mark);
    } else if (plan.earliestMilestone) {
      var est = el("div", "milestone estimated", "◇ 最短 " + md(plan.earliestMilestone));
      est.style.top = yOf(plan.earliestMilestone) + "px";
      lane.appendChild(est);
    }
    if (plan.serial) {
      var size = Math.max(4, Math.min(12, scale + 2));
      plan.serial.writing.forEach(function (writing) {
        if (writing.end < board.from || writing.start > board.to) return;
        var wbar = el("div", "wbar" + (writing.late ? " late" : ""));
        wbar.style.top = yOf(writing.start) + "px";
        wbar.style.height = Math.max(2, (dayIndex(writing.end) - dayIndex(writing.start) + 1) * scale - 1) + "px";
        wbar.title = "第" + writing.episode + "話の執筆 " + md(writing.start) + "〜" + md(writing.end) + (writing.late ? "（投稿日に間に合わない見込み）" : "");
        lane.appendChild(wbar);
      });
      plan.serial.slots.forEach(function (slot) {
        if (slot.date < board.from || slot.date > board.to) return;
        var dot = el("div", "dot " + slot.state, size >= 9 ? SLOT_SYM[slot.state] : "");
        dot.style.top = (yOf(slot.date) + Math.max(0, (scale - size) / 2)) + "px";
        dot.style.width = size + "px"; dot.style.height = size + "px"; dot.style.lineHeight = (size - 2) + "px";
        var time = plan.schedule.serial && plan.schedule.serial.time ? " " + plan.schedule.serial.time : "";
        dot.title = "第" + slot.episode + "話" + (slot.title ? "「" + slot.title + "」" : "") + " " + md(slot.date) + time + "　" + SLOT_SYM[slot.state] + SLOT[slot.state];
        lane.appendChild(dot);
        if (scale >= 24) {
          var label = el("div", "dot-label", "第" + slot.episode + "話");
          label.style.top = yOf(slot.date) + "px";
          lane.appendChild(label);
        }
      });
    }
    return lane;
  }

  function describeStep(plan, planned) {
    var step = planned.step;
    if (step.status === "done") return step.label + "　済み（" + md(planned.end) + "）";
    var range = planned.days === 0 ? "字数に届いています" : md(planned.start) + "〜" + md(planned.end) + "（" + planned.days + "日）";
    var parts = [step.label + "　" + range, STATUS[step.status] + "・" + ACTOR[planned.actor || "self"]];
    if (step.due) parts.push("期日 " + md(step.due) + "（手で入れた日付）");
    if (planned.lateDays > 0) parts.push("あと" + planned.lateDays + "日足りない");
    if (planned.overlapDays > 0) parts.push("あとの段と" + planned.overlapDays + "日重なる");
    if ((planned.tracks || 1) > 1) parts.push("ほかの段と同時に進める");
    if (plan.overlapNotes && plan.overlapNotes[step.id]) parts.push(plan.overlapNotes[step.id]);
    return parts.join("\\n");
  }

  function findSelected() {
    if (!board || !selection) return null;
    for (var i = 0; i < board.columns.length; i++) {
      var column = board.columns[i];
      if (column.workId !== selection.workId) continue;
      for (var j = 0; j < column.plans.length; j++) {
        var plan = column.plans[j];
        if (plan.schedule.id !== selection.scheduleId) continue;
        if (!selection.stepId) return { column: column, plan: plan, planned: null };
        for (var k = 0; k < plan.steps.length; k++) {
          if (plan.steps[k].step.id === selection.stepId) return { column: column, plan: plan, planned: plan.steps[k] };
        }
      }
    }
    return null;
  }

  function closeDetail() {
    selection = null;
    var detail = document.getElementById("detail");
    detail.classList.remove("open"); detail.textContent = "";
  }

  function field(parent, labelText, input) {
    var row = el("div", "row");
    var label = el("label", "", labelText);
    row.appendChild(label); row.appendChild(input); parent.appendChild(row);
    return input;
  }
  function input(type, value) {
    var node = document.createElement("input");
    node.type = type;
    node.value = value === null || value === undefined ? "" : String(value);
    return node;
  }
  function button(text, cls, onClick) {
    var node = el("button", cls || "", text);
    node.addEventListener("click", onClick);
    return node;
  }
  function numberOrNull(value) {
    var trimmed = String(value).trim();
    if (!trimmed) return null;
    var n = Number(trimmed);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }

  function showDetail() {
    var found = findSelected();
    var detail = document.getElementById("detail");
    if (!found) { closeDetail(); return; }
    detail.textContent = "";
    detail.classList.add("open");
    var top = el("div", "buttons");
    top.appendChild(button("閉じる", "", function () { closeDetail(); render(); }));
    detail.appendChild(top);
    if (found.planned) stepDetail(detail, found.column, found.plan, found.planned);
    else scheduleDetail(detail, found.column, found.plan);
  }

  function ids(column, plan) { return { workId: column.workId, scheduleId: plan.schedule.id }; }

  function stepDetail(detail, column, plan, planned) {
    var step = planned.step;
    detail.appendChild(el("h2", "", step.label));
    detail.appendChild(el("div", "note", column.title + "／" + plan.name + "（" + plan.kindLabel + "）"));
    detail.appendChild(el("div", "note", describeStep(plan, planned).split("\\n").join("・")));
    var label = field(detail, "段の名前", input("text", step.label));
    var status = document.createElement("select");
    ["todo", "doing", "done"].forEach(function (key) {
      var option = el("option", "", STATUS[key]); option.value = key; if (key === step.status) option.selected = true; status.appendChild(option);
    });
    field(detail, "状態" + (step.doneAt ? "（済んだ日 " + md(step.doneAt) + "）" : ""), status);
    var due = field(detail, "期日（手で入れる日付。入れると逆算はこの日を動かしません）", input("date", step.due));
    var pace = step.key === "write" || step.key === "serialBuffer";
    var days = field(detail, pace ? "仮の日数（直近30日の執筆の記録か予定の字数が無いときに使います）" : "日数", input("number", step.days));
    days.min = "1"; days.max = "3650";
    if (pace) detail.appendChild(el("div", "note", planned.daysSource === "pace" ? "いまは字数と直近30日の平均から " + planned.days + "日 と出しています。" : "いまは仮の日数を使っています。"));
    // 並行：同じスケジュールのほかの段から選ぶ（6.111.13）
    var parallel = document.createElement("select");
    var none = el("option", "", "前の段が終わってから"); none.value = ""; parallel.appendChild(none);
    plan.schedule.steps.forEach(function (other) {
      if (other.id === step.id) return;
      var option = el("option", "", "「" + other.label + "」と同時に進められる");
      option.value = other.id;
      if (step.parallelWith === other.id) option.selected = true;
      parallel.appendChild(option);
    });
    field(detail, "始める時期", parallel);
    // 誰が動かすか（6.111.14）
    var actor = document.createElement("select");
    ["self", "others"].forEach(function (key) {
      var option = el("option", "", ACTOR[key]); option.value = key; if (key === (planned.actor || "self")) option.selected = true; actor.appendChild(option);
    });
    field(detail, "誰が進めるか（人に頼む段は休む日・作業の重なりに数えません）", actor);
    var note = document.createElement("textarea"); note.value = step.note || "";
    field(detail, "メモ", note);
    var buttons = el("div", "buttons");
    buttons.appendChild(button("保存", "primary", function () {
      var patch = { label: label.value, status: status.value, due: due.value || null, note: note.value, days: numberOrNull(days.value), parallelWith: parallel.value || null, actor: actor.value };
      if (patch.days === null) delete patch.days;
      post(Object.assign({ type: "updateStep", stepId: step.id, patch: patch }, ids(column, plan)));
    }));
    if (step.due) buttons.appendChild(button("期日を外す（逆算に戻す）", "", function () {
      post(Object.assign({ type: "updateStep", stepId: step.id, patch: { due: null } }, ids(column, plan)));
    }));
    buttons.appendChild(button("↑ 前へ", "", function () { post(Object.assign({ type: "moveStep", stepId: step.id, direction: -1 }, ids(column, plan))); }));
    buttons.appendChild(button("↓ 後ろへ", "", function () { post(Object.assign({ type: "moveStep", stepId: step.id, direction: 1 }, ids(column, plan))); }));
    buttons.appendChild(button("段を消す", "", function () { post(Object.assign({ type: "removeStep", stepId: step.id }, ids(column, plan))); }));
    detail.appendChild(buttons);
    addStepForm(detail, column, plan, step.id, "この段の後ろに段を足す");
  }

  function addStepForm(detail, column, plan, afterStepId, title) {
    detail.appendChild(el("h2", "", title));
    var name = field(detail, "段の名前", input("text", ""));
    var days = field(detail, "日数", input("number", 7)); days.min = "1"; days.max = "3650";
    var buttons = el("div", "buttons");
    buttons.appendChild(button("足す", "", function () {
      post(Object.assign({ type: "addStep", afterStepId: afterStepId, label: name.value, days: numberOrNull(days.value) }, ids(column, plan)));
    }));
    detail.appendChild(buttons);
  }

  function scheduleDetail(detail, column, plan) {
    var schedule = plan.schedule;
    detail.appendChild(el("h2", "", plan.name + "（" + plan.kindLabel + "）"));
    detail.appendChild(el("div", "note", column.title));
    if (plan.virtual) detail.appendChild(el("div", "note", "作品目標設定の応募先から出しています。段を直すと、このスケジュールを保存します。"));
    if (plan.alerts.length) {
      var list = el("ul", "alerts");
      plan.alerts.forEach(function (text) {
        var strong = text.indexOf("間に合いません") === 0 || text.indexOf("書き溜めが尽きる") === 0;
        list.appendChild(el("li", strong ? "strong" : "", text));
      });
      detail.appendChild(list);
    }
    var patch = {};
    var name = null; var milestone = null; var target = null;
    if (schedule.followsGoals) {
      detail.appendChild(el("div", "note", "名前・締切・予定の字数は作品目標設定の応募先に従います（ここへは写しません）。直すときは作品目標設定で。"));
    } else {
      name = field(detail, "名前", input("text", schedule.name));
      milestone = field(detail, plan.milestoneLabel + "（空なら未定。今日から詰めて最短の日を出します）", input("date", schedule.milestone));
      if (schedule.kind !== "publisher" && schedule.kind !== "webSerial") {
        target = field(detail, "予定の字数（執筆の日数を出すのに使います）", input("number", schedule.targetChars));
      }
    }
    var serialInputs = null;
    if (schedule.serial) serialInputs = serialFields(detail, schedule.serial, plan);
    var note = document.createElement("textarea"); note.value = schedule.note || "";
    field(detail, "メモ", note);
    var buttons = el("div", "buttons");
    buttons.appendChild(button("保存", "primary", function () {
      if (name) patch.name = name.value;
      if (milestone) patch.milestone = milestone.value || null;
      if (target) patch.targetChars = numberOrNull(target.value);
      patch.note = note.value;
      if (serialInputs) patch.serial = serialInputs();
      post(Object.assign({ type: "updateSchedule", patch: patch }, ids(column, plan)));
    }));
    buttons.appendChild(button("スケジュールを消す", "", function () { post(Object.assign({ type: "removeSchedule" }, ids(column, plan))); }));
    detail.appendChild(buttons);
    addStepForm(detail, column, plan, null, "先頭に段を足す");
  }

  function serialFields(detail, rule, plan) {
    detail.appendChild(el("h2", "", "連載の決まり"));
    if (plan.serial) {
      detail.appendChild(el("div", "note", "書き溜めの残り " + plan.serial.stock + "話" + (plan.serial.charsPerEpisode ? "・1話 約" + plan.serial.charsPerEpisode.toLocaleString("ja-JP") + "字で計算" : "")));
    }
    var box = el("div", "row weekdays");
    box.appendChild(el("label", "", "更新する曜日"));
    var checks = [];
    for (var day = 0; day < 7; day++) {
      var wrap = el("label", "");
      var check = input("checkbox", ""); check.checked = rule.weekdays.indexOf(day) >= 0; check.value = String(day);
      wrap.appendChild(check); wrap.appendChild(document.createTextNode(KIND_DAYS[day]));
      box.appendChild(wrap); checks.push(check);
    }
    detail.appendChild(box);
    var time = field(detail, "更新の時刻（任意）", input("time", rule.time));
    var buffer = field(detail, "開始までに書き溜める話数", input("number", rule.bufferEpisodes)); buffer.min = "0";
    var first = field(detail, "連載の第何話から", input("number", rule.firstEpisode)); first.min = "1";
    var end = field(detail, "完結予定の話数（任意）", input("number", rule.endEpisode));
    var endDate = field(detail, "終わりの日（任意）", input("date", rule.endDate));
    var chars = field(detail, "1話の字数（空なら作品目標設定の1記事の目標、無ければ書いた話の平均）", input("number", rule.charsPerEpisode));
    var site = document.createElement("select");
    SITES.forEach(function (pair) {
      var option = el("option", "", pair[1]); option.value = pair[0]; if ((rule.site || "") === pair[0]) option.selected = true; site.appendChild(option);
    });
    field(detail, "投稿済みをどのサイトの記録で見るか", site);
    return function () {
      return {
        weekdays: checks.filter(function (c) { return c.checked; }).map(function (c) { return Number(c.value); }),
        time: time.value || null,
        bufferEpisodes: numberOrNull(buffer.value) === null ? 0 : numberOrNull(buffer.value),
        firstEpisode: numberOrNull(first.value) === null ? 1 : numberOrNull(first.value),
        endEpisode: numberOrNull(end.value),
        endDate: endDate.value || null,
        charsPerEpisode: numberOrNull(chars.value),
        site: site.value || null
      };
    };
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "board") {
      board = message.board;
      if (message.select) selection = message.select;
      render();
    }
  });
  markScale();
  // 用意ができたことを、覚えている「済んだ作品も見る」と一緒に知らせる（1度で描く）
  post({ type: "setShowFinished", value: state.showFinished });
})();
</script>
</body>
</html>`;
}
