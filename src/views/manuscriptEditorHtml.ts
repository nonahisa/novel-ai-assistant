/**
 * 原稿エディタの画面（設計書6.25）。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （本文の引用符や `<` で画面が壊れるのを防ぐ）。提案パネルと同じ作法。
 *
 * ## 「書く」と「読む」を分けてある理由
 *
 * ルビを出したまま打てる画面（`contenteditable` に組み立てた見た目へ
 * 直接打ち込む形）は作れるが、**日本語の入力（IME）と相性が悪い。**
 * 変換中の文字を差し替えると、確定前の文字が消えたり二重に入ったりする。
 * ここは作者が1日じゅう触るところで、**壊れたときの被害が原稿そのもの**
 * である。
 *
 * そこで、
 *
 * - **書く面**は `<textarea>`。IMEは何も細工しなくても確実に効く。
 *   縦書きは `writing-mode` で効かせる（textareaにも効く）
 * - **読む面**は組み立てたHTML。ルビ・傍点・用語の色分けが出る
 *
 * 切り替えは1つのボタンで、**同じ場所を見続けられるようにする**。
 */

export function buildManuscriptEditorHtml(
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
<title>原稿</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}

/* ── 上の帯 ───────────────────────────── */
#bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto;
  flex-wrap: wrap;
}
button {
  font-family: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.on {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
#bar .gap { flex: 1 1 auto; }
#bar .count {
  font-size: 11px;
  opacity: 0.8;
  white-space: nowrap;
}
#bar .sep {
  width: 1px;
  align-self: stretch;
  background: var(--vscode-panel-border);
  margin: 0 2px;
}

/* ── 本文の面 ─────────────────────────── */
#surface {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
}
#write, #read {
  position: absolute;
  inset: 0;
  padding: 24px 28px;
  overflow: auto;
  line-height: 1.9;
  font-size: var(--novelai-size, 16px);
  /* **小説は明朝で読む。** VS Code の編集用フォント（等幅の欧文書体）は
     縦書きの日本語を想定していないので、仮名の位置が揃わない。
     設定 novelai.manuscriptEditor.fontFamily で変えられる */
  font-family: var(--novelai-font, "Yu Mincho", "YuMincho",
    "Hiragino Mincho ProN", "MS Mincho", serif);
}
#write {
  border: none;
  resize: none;
  width: 100%;
  height: 100%;
  color: var(--vscode-editor-foreground);
  background: transparent;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 4;
}
#read { white-space: normal; }
#read p.line {
  margin: 0;
  min-height: 1.9em;
}
/* 縦書き。**行の高さを「幅」として持つ**ので、指定はそのまま効く */
body.vertical #write, body.vertical #read {
  writing-mode: vertical-rl;
  /* **upright にしない。** 全部を立てると、英数字が1文字ずつ縦に
     積まれる（2026 が4行になる）。既定の mixed は日本語の組版と
     同じ扱いで、英数字のまとまりを横に寝かせる */
  text-orientation: mixed;
  /*
    **傍線は行の右へ。**（作者の指示、2026-08-24）

    ただし**変換中の線には効かなかった**（実機で確認、設計書6.25.2）。
    あの線を引いているのは日本語入力の層で、本文の下線とは別の道を通る。
    ここに残してあるのは、本文へ下線を引く日が来たときのためである。

    縦書きの日本語では、傍線（下線）は行の右側に引く。変換中に日本語入力が
    引く線もこれに従う。既定（auto）では左に出ることがあり、**打っている
    文字の左に線が付くと、隣の行に付いているように見える。**

    横書きのときは、この指定は無視される（左右の別が無いため）ので、
    縦書きの指定の中だけに置けばよい。
  */
  text-underline-position: right;
  /* 縦書きでは上下の余白が「行頭・行末」になる */
  padding: 28px 24px;
}
body.vertical #read p.line { min-width: 1.9em; min-height: 0; }
/* 縦書きのときだけ、行の長さを紙のように区切る */
body.vertical.paged #surface { padding: 0; }

body.reading:not(.split) #write { visibility: hidden; pointer-events: none; }
body:not(.reading):not(.split) #read { visibility: hidden; pointer-events: none; }

/*
  並べる。**打つ面はそのまま、見る面を隣に置く。**
  ルビを出したまま打てる画面は日本語入力（IME）を壊すので作らない
  （設計書6.25）。代わりに、打ちながら組み上がりを見られるようにする。
*/
body.split #surface { display: flex; gap: 0; }
body.split #write, body.split #read {
  position: relative;
  inset: auto;
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
}
body.split #read { border-left: 1px solid var(--vscode-panel-border); }

/* ── ルビ・傍点・用語 ─────────────────── */
ruby > rt {
  font-size: 0.5em;
  opacity: 0.85;
  user-select: none;
}
em.emph {
  font-style: normal;
  text-emphasis: filled dot;
  -webkit-text-emphasis: filled dot;
  text-emphasis-position: over right;
  -webkit-text-emphasis-position: over right;
}
.term { cursor: pointer; border-radius: 2px; }
.term:hover { background: var(--vscode-editor-hoverHighlightBackground); }
.term-character { color: var(--novelai-character); }
.term-location { color: var(--novelai-location); }
.term-ability { color: var(--novelai-ability); }
.term-organization { color: var(--novelai-organization); }
body.plain .term { color: inherit; }

/* ── 右クリックの品書き ───────────────── */
#menu {
  position: fixed;
  z-index: 20;
  min-width: 190px;
  padding: 4px 0;
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-menu-background, var(--vscode-editor-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  display: none;
}
#menu.open { display: block; }
#menu .item {
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
#menu .item:hover {
  background: var(--vscode-menu-selectionBackground);
  color: var(--vscode-menu-selectionForeground);
}
#menu .item.disabled { opacity: 0.45; cursor: default; }
#menu .item.disabled:hover { background: transparent; color: inherit; }
#menu .rule {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
}
#menu .head {
  padding: 4px 14px;
  font-size: 11px;
  opacity: 0.7;
}

/* ── 下の帯（凡例と知らせ） ───────────── */
#foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 10px;
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 11px;
  opacity: 0.85;
  flex-wrap: wrap;
}
#foot .swatch::before {
  content: "■";
  margin-right: 3px;
}
#note {
  color: var(--vscode-notificationsInfoIcon-foreground, inherit);
}
</style>
</head>
<body class="vertical">
<div id="bar">
  <button id="mode" title="組み立てた表示と、打てる表示を切り替えます">読む</button>
  <button id="dir" title="縦書きと横書きを切り替えます">横書きにする</button>
  <button id="split" title="打つ面と、組み上がりを並べます">並べる</button>
  <div class="sep"></div>
  <button id="ruby" title="選んだ文字にルビを振ります">ルビ</button>
  <button id="emph" title="選んだ文字に傍点を付けます">傍点</button>
  <div class="sep"></div>
  <button id="copy" title="投稿サイトの記法に直してコピーします">投稿用にコピー</button>
  <button id="smaller" title="文字を小さく">ー</button>
  <button id="bigger" title="文字を大きく">＋</button>
  <div class="gap"></div>
  <span class="count" id="count"></span>
</div>

<div id="surface">
  <textarea id="write" spellcheck="false" wrap="soft"></textarea>
  <div id="read"></div>
</div>

<div id="foot">
  <span id="legend"></span>
  <span id="note"></span>
</div>

<div id="menu"></div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const write = document.getElementById("write");
  const read = document.getElementById("read");
  const menu = document.getElementById("menu");
  const countLabel = document.getElementById("count");
  const legend = document.getElementById("legend");
  const note = document.getElementById("note");
  const modeButton = document.getElementById("mode");
  const dirButton = document.getElementById("dir");
  const splitButton = document.getElementById("split");

  /** いま画面が持っている本文。拡張機能から来たものと比べるために持つ */
  let current = "";
  /**
   * 最後に自分が送った本文。
   *
   * **これと同じものが返ってきたら、打っている面には触らない。**
   * 自分の書き換えが文書へ入ると、拡張機能はその文書を送り返してくる。
   * それを入れ直すと、カーソルが飛び、変換中なら変換そのものが壊れる。
   */
  let lastSent = null;
  /** 変換中に外から届いた本文。確定してから片づける */
  let pending = null;
  /** 書いている間に届いた「読む面」。切り替えるときに当てる */
  let freshHtml = null;

  const saved = vscode.getState() || {};
  /** はじめの向きは設定から。**一度切り替えたら、その原稿ではそれを覚える** */
  let vertical = saved.vertical;
  let reading = saved.reading === true;
  /** 打つ面と組み上がりを並べる */
  let split = saved.split === true;
  let size = saved.size || 16;

  function remember() {
    vscode.setState({ vertical, reading, split, size });
  }

  /** 組み上がりが見えている場面か（並べているときも見えている） */
  function showingRead() {
    return reading || split;
  }

  function paint() {
    // 設定がまだ届いていない間は縦書きとして見せる（body の初期値と揃える）
    document.body.classList.toggle("vertical", vertical !== false);
    document.body.classList.toggle("reading", reading);
    document.body.classList.toggle("split", split);
    splitButton.textContent = split ? "並べるのをやめる" : "並べる";
    splitButton.classList.toggle("on", split);
    // 並べているときは、切り替えるものが無い
    modeButton.disabled = split;
    document.documentElement.style.setProperty("--novelai-size", size + "px");
    modeButton.textContent = reading ? "書く" : "読む";
    modeButton.classList.toggle("on", reading);
    dirButton.textContent = vertical !== false ? "横書きにする" : "縦書きにする";
    dirButton.classList.toggle("on", vertical !== false);
    // **書く面では、ルビは記法のまま見える。** そのことを一言添える
    note.textContent = showingRead()
      ? ""
      : "ルビ・傍点・用語の色分けは「読む」か「並べる」で出ます（この面では記法のまま見えます）";
  }

  /** 縦書きでは「上下」ではなく「左右」に流れる。位置合わせもそれに従う */
  function keepPlace(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    if (vertical !== false) {
      const total = fromEl.scrollWidth - fromEl.clientWidth;
      if (total > 0) {
        const ratio = fromEl.scrollLeft / total;
        toEl.scrollLeft = ratio * (toEl.scrollWidth - toEl.clientWidth);
      }
    } else {
      const total = fromEl.scrollHeight - fromEl.clientHeight;
      if (total > 0) {
        const ratio = fromEl.scrollTop / total;
        toEl.scrollTop = ratio * (toEl.scrollHeight - toEl.clientHeight);
      }
    }
  }

  modeButton.addEventListener("click", function () {
    const from = reading ? read : write;
    reading = !reading;
    // 書いている間に溜めておいた分を、ここで当てる
    if (reading) applyFreshHtml();
    paint();
    remember();
    const to = reading ? read : write;
    // 切り替えても同じあたりを見ていられるようにする
    requestAnimationFrame(function () { keepPlace(from, to); });
    if (!reading) write.focus();
  });

  splitButton.addEventListener("click", function () {
    split = !split;
    if (split) {
      applyFreshHtml();
      // 並べたら、打つのはこちら側である
      reading = false;
    }
    paint();
    remember();
    if (split) {
      requestAnimationFrame(function () {
        keepPlace(write, read);
        write.focus();
      });
    }
  });

  dirButton.addEventListener("click", function () {
    vertical = vertical === false;
    paint();
    remember();
  });

  document.getElementById("bigger").addEventListener("click", function () {
    size = Math.min(40, size + 1);
    paint();
    remember();
  });
  document.getElementById("smaller").addEventListener("click", function () {
    size = Math.max(9, size - 1);
    paint();
    remember();
  });

  document.getElementById("ruby").addEventListener("click", function () {
    askRuby();
  });
  document.getElementById("emph").addEventListener("click", function () {
    askEmphasis();
  });
  document.getElementById("copy").addEventListener("click", function () {
    vscode.postMessage({ type: "copyForPosting" });
  });

  /** 選んでいる文字。読む面では選択範囲、書く面では textarea の選択 */
  function selectionText() {
    if (reading) return String(window.getSelection() || "");
    return write.value.slice(write.selectionStart, write.selectionEnd);
  }

  function askRuby() {
    const text = selectionText();
    vscode.postMessage({
      type: "ruby",
      text: text,
      start: reading ? -1 : write.selectionStart,
      end: reading ? -1 : write.selectionEnd,
    });
  }

  function askEmphasis() {
    const text = selectionText();
    vscode.postMessage({
      type: "emphasis",
      text: text,
      start: reading ? -1 : write.selectionStart,
      end: reading ? -1 : write.selectionEnd,
    });
  }

  /* ── 打たれたら、変わったことだけを伝える ── */
  write.addEventListener("input", function () {
    // **変換中は送らない。** 確定前の文字を本文へ入れると、
    // 確定のたびに二重に入る
    if (composing) return;
    send();
  });

  let composing = false;
  write.addEventListener("compositionstart", function () { composing = true; });
  write.addEventListener("compositionend", function () {
    composing = false;
    /*
      **確定した文字が入るのは、この直後のことがある。**
      compositionend が先に起き、確定ぶんの input があとから来る組み合わせ
      （Windowsの日本語入力）では、ここで読むとまだ確定前の中身である。
      1周まわしてから読む。
    */
    setTimeout(function () {
      send();
      // 変換中に外から届いていた書き換えは、ここで片づける
      flushPending();
    }, 0);
  });

  /**
   * 打たれた本文を、そのまま文書へ返す。
   *
   * **待たせない。** 以前は200ミリ秒まとめていたが、
   *
   * - 打った直後に Ctrl+S を押すと、**最後の数文字が保存されない**
   * - 待っている間に届いた書き換えと、打った内容がぶつかる
   *
   * 日本語入力では input は変換中にも起きるが、そこは送らない。
   * **実際に送るのは「変換を確定したとき」＝語ごと**なので、
   * 打鍵のたびに送ることにはならない。
   */
  function send() {
    if (write.value === current) return;
    current = write.value;
    lastSent = current;
    vscode.postMessage({ type: "edit", text: current });
    updateCount();
  }

  /**
   * 拡張機能から届いた本文を、打っている面へ入れるかどうか決める。
   *
   * **触ってよい場面のほうが少ない。** 次の3つは触らない。
   *
   * 1. **変換中**（IME）。値を入れ直すと変換そのものが壊れる——
   *    確定前の文字が消える、二重に入る、変換が途中で止まる。
   *    作者が実機で当たったのはこれである（2026-08-24）
   * 2. **自分が送った本文が返ってきただけのとき。** 打つたびに
   *    文書が変わり、その文書がそのまま送り返される。入れ直すと
   *    カーソルが飛ぶ
   * 3. すでに同じ中身のとき
   */
  function takeIncoming(text) {
    if (composing) {
      // 確定するまで覚えておく。**いま入れると変換が壊れる**
      if (text !== lastSent && text !== write.value) pending = text;
      return;
    }
    if (text === lastSent) return;
    if (write.value === text) return;
    replaceKeepingCaret(text);
  }

  /** 溜めておいた組み上がりを当てる。見えていないときは溜めたままにする */
  function applyFreshHtml() {
    if (freshHtml === null) return;
    read.innerHTML = freshHtml;
    freshHtml = null;
    if (split) followCaret();
  }

  /**
   * 並べているとき、組み上がりの側を**カーソルのある行に合わせる**。
   *
   * 割合でスクロールを合わせる手もあるが、ルビや傍点で行の高さが変わるため
   * 少しずつずれる。**行そのものを指して寄せる**ほうが確かである。
   */
  let followTimer = null;
  function followCaret() {
    if (!split) return;
    if (followTimer) cancelAnimationFrame(followTimer);
    followTimer = requestAnimationFrame(function () {
      followTimer = null;
      const before = write.value.slice(0, write.selectionStart);
      let line = 0;
      for (let i = 0; i < before.length; i++) {
        if (before.charCodeAt(i) === 10) line++;
      }
      const target = read.querySelector('[data-line="' + line + '"]');
      if (target && target.scrollIntoView) {
        target.scrollIntoView({ block: "center", inline: "center" });
      }
    });
  }

  // カーソルが動いたら、組み上がりの側も追いかける
  document.addEventListener("selectionchange", function () {
    if (document.activeElement === write) followCaret();
  });

  /** 変換が確定したあとに、待たせていた書き換えを片づける */
  function flushPending() {
    const text = pending;
    pending = null;
    if (text === null) return;
    // **打った内容のほうを優先する。** 変換している間に外から
    // 書き換えが来たなら、確定した文字を捨てるより送り直すほうがよい
    if (write.value !== current) { send(); return; }
    takeIncoming(text);
  }

  /**
   * 外からの書き換えを当てる。**カーソルの位置をできるだけ保つ。**
   *
   * 前から一致する長さを見て、カーソルがそれより前なら動かさない。
   * 後ろなら、増えた（減った）ぶんだけずらす。
   */
  function replaceKeepingCaret(text) {
    const before = write.value;
    const start = write.selectionStart;
    const end = write.selectionEnd;
    let common = 0;
    const max = Math.min(before.length, text.length);
    while (common < max && before[common] === text[common]) common++;
    const delta = text.length - before.length;
    const move = function (at) {
      if (at <= common) return at;
      return Math.max(common, Math.min(text.length, at + delta));
    };
    /*
      **見ている場所も保つ。** 縦書きでは行が右から左へ並ぶので、
      本文が短くなると左端（＝いちばん新しい行）の位置がずれ、
      値を入れ直しただけで画面が飛ぶ（作者の指摘、2026-08-24）。
    */
    const left = write.scrollLeft;
    const top = write.scrollTop;
    write.value = text;
    try {
      write.setSelectionRange(move(start), move(end));
    } catch (e) {
      /* 範囲外なら諦める */
    }
    write.scrollLeft = left;
    write.scrollTop = top;
  }

  function updateCount() {
    // 数え方は拡張機能側に合わせる（ルビの読み仮名は数えない）
    vscode.postMessage({ type: "count", text: write.value });
  }

  /* ── 右クリック ────────────────────── */
  let menuTerm = null;

  function closeMenu() {
    menu.classList.remove("open");
    menuTerm = null;
  }

  function openMenu(x, y, term, hasSelection) {
    menu.innerHTML = "";
    menuTerm = term;

    function add(label, onClick, enabled) {
      const item = document.createElement("div");
      item.className = "item" + (enabled === false ? " disabled" : "");
      item.textContent = label;
      if (enabled !== false) {
        item.addEventListener("click", function () {
          closeMenu();
          onClick();
        });
      }
      menu.appendChild(item);
      return item;
    }
    function rule() {
      const r = document.createElement("div");
      r.className = "rule";
      menu.appendChild(r);
    }

    if (term) {
      const head = document.createElement("div");
      head.className = "head";
      head.textContent = term.name;
      menu.appendChild(head);
      add("設定資料を見る", function () {
        vscode.postMessage({ type: "openTerm", id: term.id, kind: term.kind });
      });
      rule();
    }

    add("ルビを振る", askRuby, hasSelection || !reading);
    add("傍点を付ける", askEmphasis, hasSelection);
    rule();
    add("投稿サイト用にコピー", function () {
      vscode.postMessage({ type: "copyForPosting" });
    });
    add("選んだところをAIに相談", function () {
      vscode.postMessage({
        type: "chat",
        start: reading ? -1 : write.selectionStart,
        end: reading ? -1 : write.selectionEnd,
      });
    }, hasSelection);

    menu.classList.add("open");
    // 画面の外へはみ出さないように収める
    const box = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - box.width - 4);
    const top = Math.min(y, window.innerHeight - box.height - 4);
    menu.style.left = Math.max(0, left) + "px";
    menu.style.top = Math.max(0, top) + "px";
  }

  function termFrom(target) {
    const el = target && target.closest ? target.closest(".term") : null;
    if (!el) return null;
    return {
      id: el.getAttribute("data-term-id"),
      kind: el.getAttribute("data-term-kind"),
      name: el.getAttribute("data-term-name"),
    };
  }

  document.addEventListener("contextmenu", function (event) {
    if (event.target === menu || menu.contains(event.target)) return;
    event.preventDefault();
    openMenu(
      event.clientX,
      event.clientY,
      termFrom(event.target),
      selectionText().length > 0
    );
  });

  document.addEventListener("click", function (event) {
    if (!menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  /** 読む面で用語を押したら、そのまま資料を開く */
  read.addEventListener("click", function (event) {
    const term = termFrom(event.target);
    if (term) {
      vscode.postMessage({ type: "openTerm", id: term.id, kind: term.kind });
    }
  });

  /* ── 拡張機能からの知らせ ──────────── */
  window.addEventListener("message", function (event) {
    const message = event.data;
    if (message.type === "update") {
      current = message.text;
      takeIncoming(message.text);
      /*
        **打っている間は、読む面を組み立て直さない。**
        4万字の本文では段落が千を超える。打つたびにそれを作り直すと、
        画面がつかえて「変換が途中で止まった」ように感じる。
        見えていないのだから、切り替えるときに作ればよい。
      */
      freshHtml = message.html;
      if (showingRead()) applyFreshHtml();
      if (typeof vertical !== "boolean") {
        // まだ切り替えたことがない原稿。設定の向きで開く
        vertical = message.verticalDefault !== false;
        paint();
      }
      if (message.fontFamily) {
        document.documentElement.style.setProperty(
          "--novelai-font",
          message.fontFamily
        );
      }
      if (message.colors) {
        for (const key of Object.keys(message.colors)) {
          document.documentElement.style.setProperty(
            "--novelai-" + key,
            message.colors[key]
          );
        }
      }
      document.body.classList.toggle("plain", message.hasTerms === false);
      legend.innerHTML = "";
      if (message.legend) {
        for (const item of message.legend) {
          const span = document.createElement("span");
          span.className = "swatch";
          span.style.color = "var(--novelai-" + item.kind + ")";
          span.textContent = item.label;
          legend.appendChild(span);
          legend.appendChild(document.createTextNode(" "));
        }
      }
    } else if (message.type === "count") {
      countLabel.textContent = message.label;
    } else if (message.type === "select" && !reading) {
      // ルビを入れたあと、入れた場所を選び直す
      write.focus();
      try { write.setSelectionRange(message.start, message.end); } catch (e) { /* 範囲外 */ }
    }
  });

  paint();
  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
