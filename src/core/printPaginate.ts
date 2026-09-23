import { NO_LINE_END, NO_LINE_START } from "./kinsoku";

/**
 * 印刷用HTMLを、紙1枚ずつの面に割るスクリプト（設計書6.33.5 の1）。
 *
 * ## なぜブラウザの中で割るのか
 *
 * 作者の報告（2026-09-21）：「ブラウザが開いたときに不安になります。
 * プレビューの内容を印刷時に近づけてほしい」。以前の画面は流し込みの
 * 1枚の紙で、**どこでページが切れるのかも、余白がどれだけあるのかも
 * 見えなかった。**
 *
 * どこで切れるかは、字の幅・ルビ・禁則をすべて組んでみないと決まらない。
 * それを正確に知っているのはブラウザだけなので、**開いたブラウザ自身に
 * 組ませて、はみ出したところで次の面へ送る。** 面は `@page` と同じ寸法の
 * 箱で、印刷のときは余白を0にして箱1つを紙1枚に刷る。**画面で見た面が、
 * そのまま紙になる**（同じエンジンが同じ寸法で組んだものを刷るため）。
 *
 * ## 動かなかったときは、これまでの紙に戻る
 *
 * スクリプトが走らない・途中で失敗したときは、面を片付けて元の流し込みを
 * 見せ、`@page` の余白もそのまま残す（以前と同じ刷り上がり）。
 *
 * ## ここは vscode に触らない
 *
 * 文字列を1つ作るだけである。禁則の字は `kinsoku.ts` から埋め込む
 * （写しを置かない）。
 *
 * **このファイルの文字列の中にバッククォートを書かないこと。**
 * テンプレートリテラルがそこで終わり、型検査が落ちる（2回踏んだ）。
 */

/**
 * ページの切れ目の禁則だけを持つ部分。**単体テストのために分けてある**
 * （`new Function` で取り出して試す）。
 *
 * `cutForKinsoku(texts, cut)`：1つの段落を `cut` 個目の手前で次の面へ
 * 送ろうとしているとき、切れ目を禁則に合う位置まで前へずらした数を返す。
 * `texts` は段落の部品（字またはルビのかたまり）ごとの文字。
 *
 * - 次の面の頭が句読点・閉じ括弧になるなら、前の字ごと送る（追い出し）
 * - この面の終わりが開き括弧になるなら、その括弧を次の面へ送る
 * - **ずらすのは4つまで。** それ以上さかのぼらないと合わないのは
 *   「……」」」」」のような特殊な並びで、面の終わりに大きな穴が空くより、
 *   禁則を破るほうがましである（元の数をそのまま返す）
 */
export const PAGINATE_HELPERS = [
  "var NO_START = " + JSON.stringify(NO_LINE_START) + ";",
  "var NO_END = " + JSON.stringify(NO_LINE_END) + ";",
  "var MAX_PULL = 4;",
  "function firstOf(text) { return text ? Array.from(text)[0] : ''; }",
  "function lastOf(text) { var chars = Array.from(text || ''); return chars.length ? chars[chars.length - 1] : ''; }",
  "function cutForKinsoku(texts, cut) {",
  "  if (cut <= 0 || cut >= texts.length) return cut;",
  "  for (var k = cut; k >= 1 && cut - k <= MAX_PULL; k--) {",
  "    var head = firstOf(texts[k]);",
  "    var tail = lastOf(texts[k - 1]);",
  "    var badHead = head !== '' && NO_START.indexOf(head) >= 0;",
  "    var badTail = tail !== '' && NO_END.indexOf(tail) >= 0;",
  "    if (!badHead && !badTail) return k;",
  "  }",
  "  return cut;",
  "}",
  // 上下の余白に刷る中身（設計書6.33.5 の2）。扉は番号0で、番号を刷らない
  "function marginText(slot, info) {",
  "  if (slot === 'title') return info.title;",
  "  if (slot === 'author') return info.author;",
  "  if (slot === 'episode') return info.heading;",
  "  if (slot === 'page') return info.number > 0 ? String(info.number) : '';",
  "  return '';",
  "}",
].join("\n");

/**
 * 面へ割る本体。`buildPrintHtml` が `<body>` の最後に置く。
 *
 * 前提にしている形（`printHtml.ts` が作る）：
 * - `#print-source` … 流し込みの本文（扉 `section.cover`、話 `section.episode`）
 * - `#print-pages` … ここへ面（`.page`）を並べる
 * - `body[data-vertical="1"]` … 縦書き
 * - `#print-page-count` … 案内帯の「全Nページ」を入れる場所
 *
 * 1つの段落が面をまたぐときは、字（ルビはかたまりごと）を単位に、
 * はみ出さない最大の数を二分探索で求めて割る。1字ずつ足して測ると、
 * 長い作品では数十秒かかる。
 */
export const PRINT_PAGINATE_SCRIPT = [
  "(function () {",
  "'use strict';",
  PAGINATE_HELPERS,
  "var doc = document;",
  "var body = doc.body;",
  "var source = doc.getElementById('print-source');",
  "var root = doc.getElementById('print-pages');",
  // 公募の納品用の組版（設計書6.33.5 の3）は、面をこちら（コード）で組んで
  // 渡してある。割り直さず、上下の余白を埋めて数えるだけにする
  "var grid = body.getAttribute('data-grid') === '1';",
  "if (!root || (!source && !grid)) return;",
  "var vertical = body.getAttribute('data-vertical') === '1';",
  "",
  "function overflows(box) {",
  "  return vertical",
  "    ? box.scrollWidth > box.clientWidth + 1",
  "    : box.scrollHeight > box.clientHeight + 1;",
  "}",
  "",
  "function newPage(kind, heading) {",
  "  var page = doc.createElement('div');",
  "  page.className = kind === 'cover' ? 'page page-cover' : 'page';",
  "  page.setAttribute('data-heading', heading || '');",
  "  var head = doc.createElement('div');",
  "  head.className = 'page-head';",
  "  var inner = doc.createElement('div');",
  "  inner.className = 'page-body';",
  "  var foot = doc.createElement('div');",
  "  foot.className = 'page-foot';",
  "  page.appendChild(head);",
  "  page.appendChild(inner);",
  "  page.appendChild(foot);",
  "  root.appendChild(page);",
  "  return inner;",
  "}",
  "",
  // 段落を部品へ。平文と傍点は1字ずつ、ルビなどの札はかたまりごと
  "function atomsOf(block) {",
  "  var atoms = [];",
  "  for (var i = 0; i < block.childNodes.length; i++) {",
  "    var node = block.childNodes[i];",
  "    if (node.nodeType === 3) {",
  "      Array.from(node.nodeValue || '').forEach(function (ch) { atoms.push({ t: 'text', s: ch }); });",
  "    } else if (node.nodeType === 1 && node.classList.contains('emphasis')) {",
  "      Array.from(node.textContent || '').forEach(function (ch) { atoms.push({ t: 'em', s: ch }); });",
  "    } else if (node.nodeType === 1) {",
  "      atoms.push({ t: 'node', s: '', n: node });",
  "    }",
  "  }",
  "  return atoms;",
  "}",
  "",
  "function fill(shell, atoms, from, to) {",
  "  while (shell.firstChild) shell.removeChild(shell.firstChild);",
  "  var run = '';",
  "  var runType = '';",
  "  function flush() {",
  "    if (!run) return;",
  "    if (runType === 'em') {",
  "      var span = doc.createElement('span');",
  "      span.className = 'emphasis';",
  "      span.textContent = run;",
  "      shell.appendChild(span);",
  "    } else {",
  "      shell.appendChild(doc.createTextNode(run));",
  "    }",
  "    run = '';",
  "  }",
  "  for (var i = from; i < to; i++) {",
  "    var atom = atoms[i];",
  "    if (atom.t === 'node') { flush(); runType = ''; shell.appendChild(atom.n.cloneNode(true)); continue; }",
  "    if (atom.t !== runType) { flush(); runType = atom.t; }",
  "    run += atom.s;",
  "  }",
  "  flush();",
  "}",
  "",
  "function place(block, state) {",
  "  var whole = block.cloneNode(true);",
  "  state.box.appendChild(whole);",
  "  if (!overflows(state.box)) return;",
  "  state.box.removeChild(whole);",
  "  var atoms = atomsOf(block);",
  "  var texts = atoms.map(function (atom) { return atom.s; });",
  "  var from = 0;",
  "  var first = true;",
  "  while (from < atoms.length) {",
  "    var shell = block.cloneNode(false);",
  "    if (!first) { shell.classList.add('cont'); shell.classList.remove('gap'); }",
  "    state.box.appendChild(shell);",
  "    fill(shell, atoms, from, atoms.length);",
  "    if (!overflows(state.box)) return;",
  "    var lo = 0;",
  "    var hi = atoms.length - from - 1;",
  "    while (lo < hi) {",
  "      var mid = (lo + hi + 1) >> 1;",
  "      fill(shell, atoms, from, from + mid);",
  "      if (overflows(state.box)) hi = mid - 1; else lo = mid;",
  "    }",
  "    var count = lo > 0 ? cutForKinsoku(texts.slice(from), lo) : 0;",
  "    if (count <= 0) {",
  // 1字も入らない。ほかに何か載っている面なら、次の面で組み直す。
  // 空の面でも入らないなら（巨大なルビなど）、1つだけ載せて先へ進む（止まらないため）
  "      if (state.box.childNodes.length > 1) {",
  "        state.box.removeChild(shell);",
  "        state.box = newPage('body', state.heading);",
  "        continue;",
  "      }",
  "      count = 1;",
  "    }",
  "    fill(shell, atoms, from, from + count);",
  "    from += count;",
  "    first = false;",
  "    state.box = newPage('body', state.heading);",
  "  }",
  "}",
  "",
  "function paginate() {",
  "  var sections = Array.prototype.slice.call(source.children);",
  "  sections.forEach(function (section) {",
  "    if (section.classList.contains('cover')) {",
  "      var coverBox = newPage('cover', '');",
  "      Array.prototype.slice.call(section.children).forEach(function (child) {",
  "        coverBox.appendChild(child.cloneNode(true));",
  "      });",
  "      return;",
  "    }",
  "    var headingNode = section.querySelector('.episode-heading');",
  "    var heading = headingNode ? (headingNode.textContent || '') : '';",
  "    var state = { box: newPage('body', heading), heading: heading };",
  "    Array.prototype.slice.call(section.children).forEach(function (block) {",
  "      place(block, state);",
  "    });",
  "  });",
  "}",
  "",
  "function countPages() {",
  "  var pages = root.querySelectorAll('.page');",
  "  var count = doc.getElementById('print-page-count');",
  "  if (count) count.textContent = '全' + pages.length + 'ページ（扉を含む）';",
  "}",
  "",
  // 上下の余白を埋める。**扉には何も刷らず、番号も数えない**
  // （本文の1ページ目を1とする。本の数え方とは違うが、作者が数えやすい）
  "function decorate() {",
  "  var headSlot = body.getAttribute('data-head') || 'none';",
  "  var footSlot = body.getAttribute('data-foot') || 'none';",
  "  var base = {",
  "    title: body.getAttribute('data-title') || '',",
  "    author: body.getAttribute('data-author') || ''",
  "  };",
  "  var number = 0;",
  "  Array.prototype.slice.call(root.querySelectorAll('.page')).forEach(function (page) {",
  "    if (page.classList.contains('page-cover')) return;",
  "    number += 1;",
  "    var info = { title: base.title, author: base.author, heading: page.getAttribute('data-heading') || '', number: number };",
  "    var head = page.querySelector('.page-head');",
  "    var foot = page.querySelector('.page-foot');",
  "    if (head) head.textContent = marginText(headSlot, info);",
  "    if (foot) foot.textContent = marginText(footSlot, info);",
  "  });",
  "}",
  "",
  "function run() {",
  "  if (!grid) body.classList.add('paginating');",
  "  try {",
  "    if (!grid) paginate();",
  "    decorate();",
  "    countPages();",
  // 面が出来てから、印刷の余白を0にする（面の中に余白を持っている）。
  // 失敗したときは付けない——流し込みの紙に余白が無くなる
  "    var style = doc.createElement('style');",
  "    style.textContent = '@page { margin: 0; }';",
  "    doc.head.appendChild(style);",
  "    body.classList.add('paginated');",
  "  } catch (error) {",
  // 組んで渡された面（公募の納品用）は消さない。消すと何も残らない
  "    if (!grid) { while (root.firstChild) root.removeChild(root.firstChild); }",
  "    var failed = doc.getElementById('print-page-count');",
  "    if (failed) failed.textContent = '面に分けられなかったため、続けて並べています';",
  "    if (window.console) console.error(error);",
  "  }",
  "  body.classList.remove('paginating');",
  "}",
  "",
  // 字の形が決まってから測る。明朝の読み込みが後になると、測った幅が変わる
  "if (doc.fonts && doc.fonts.ready) { doc.fonts.ready.then(run, run); } else { run(); }",
  "})();",
].join("\n");
