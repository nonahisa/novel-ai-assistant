/**
 * 写真から起こした文を、段落ごとにつなぐ（設計書6.117.12）。
 *
 * ## なぜコードがつなぐのか
 *
 * 作者の指摘（2026-10-15）：書き起こした文がノートの行に合わせて改行されて
 * いるが、段落の切れ目以外に改行はいらない。
 *
 * AIへの頼みは変えない（ノートの行のまま書き起こさせる）。1行ずつ写真と
 * 見比べられるので、読み違いを見つけやすいからである。つなぐのはコードで
 * 行う（AIの出力を信用しない。規則3）——AIに「段落でつないで」と頼むと、
 * つなぐついでに字を足したり削ったりしても気づけない。
 *
 * ## 改行を残す（＝新しい段落とみなす）所
 *
 * 作者のノートでの段落の切れ目（作者の答え。全部当てはまり、書き方はまちまち）
 * をそのまま規則にした。
 *
 * 1. 次の行の頭が字下げ（全角空白・半角空白・タブ）
 * 2. 次の行が開きの括弧で始まる（会話）。字は `OPENERS`
 * 3. 前の行が「途中で終わっている」——そのページの行の長さの代表値より
 *    目に見えて短い。あわせて、前の行が 」』 で終わるときも切れ目とする
 * 4. 空行（空白だけの行を含む）はそのまま段落の区切り
 *
 * 縦書きのページでも同じ（書き起こした文は行の並びなので）。〓（読めない字）
 * も1字として数える。
 *
 * ### 「途中で終わっている」の決め方
 *
 * - 代表値は、そのページの空でない行の長さの**上位四分位**（長いほうから
 *   4分の1の所）。中央値だと、会話や段落の終わりの短い行が多いページで
 *   代表値が縮み、短い行を短いと見なくなる。最大値だと、AIが2行を
 *   1行に書いた行が1つあるだけで、ほかの行がみな「短い」になる
 * - 「目に見えて短い」は、代表値の7割以下で、**しかも3字以上短い**とき。
 *   手書きのノートは1行の字数が揃わない（±15%ほど）ので、その揺れでは
 *   切らない。3字の下限は、5字前後の行ばかりのページで1字の差を
 *   「途中で終わった」と見ないため
 * - 行の長さは字の数（サロゲートペアの漢字も1字）。行末の空白は数えず、
 *   行頭の字下げは数える（ノートのます目を使っているため）
 * - 最後の行は後ろに行が無いので、短くても関係ない
 *
 * ## つなぐのは改行を外すだけ
 *
 * 行末と次の行の頭のあいだに空白を足さない（日本語なので）。ただし、
 * **前の行が英字（A-Z・a-z）で終わり、次の行が英字で始まる所だけ**、
 * 半角空白を1つ入れる。ノートで英語の語が行をまたぐのは、たいてい語の
 * 切れ目だからである（数字や全角の英字は入れない。数字は「1,000」のように
 * 行をまたいでも空白を入れないほうが自然）。
 *
 * つないだ文から改行・空白を除くと、元の文と一字も違わないことを関数の中で
 * 確かめ、崩れていたら元の行のまま（改行だけ LF に揃えて）返す。
 *
 * ## なぜ素の JS の文字列で持つのか
 *
 * つなぐのは写真の書き起こしの画面（WebView）の中である（作者が「ノートの
 * 行で見る」に切り替えたり、行の形で直したりするたびに作り直すため）。
 * 印刷の面割り（`printPaginate.ts`）と同じく、**画面に埋め込む文字列そのもの**
 * を持ち、単体テストは同じ文字列を `new Function` で評価して試す。TS の関数を
 * `toString()` で埋める道は、本番の束が縮小される（`esbuild.js` の minify）
 * ので、試したものと画面で動くものが同じだと言えない。
 *
 * ここは vscode に触らない。**このファイルの文字列の中にバッククォートを
 * 書かないこと**（埋め込む先がテンプレートリテラル）。
 */

/**
 * `joinPhotoParagraphs(text)` を定義する素の JS。写真の書き起こしの画面が
 * スクリプトの中に置く。改行は LF で返す。
 */
export const PHOTO_PARAGRAPH_SCRIPT = [
  "function joinPhotoParagraphs(text) {",
  "  var OPENERS = '\\u300c\\u300e\\uff08(\\u3008\\u300a\\u3010\\u3014\\uff3b[\\u201c';",
  "  var CLOSERS = '\\u300d\\u300f';",
  "  var SHORT_RATIO = 0.7;",
  "  var SHORT_MIN_GAP = 3;",
  "  var source = String(text).replace(/\\r\\n?/g, '\\n');",
  "  var lines = source.split('\\n');",
  "  if (lines.length < 2) return source;",
  "  function chars(line) { return Array.from(line.replace(/\\s+$/, '')); }",
  "  function isBlank(line) { return line.replace(/\\s+/g, '') === ''; }",
  "  function isAsciiLetter(c) { return /^[A-Za-z]$/.test(c || ''); }",
  "  var lengths = [];",
  "  for (var i = 0; i < lines.length; i++) {",
  "    if (!isBlank(lines[i])) lengths.push(chars(lines[i]).length);",
  "  }",
  "  lengths.sort(function (a, b) { return a - b; });",
  // 上位四分位。2行なら長いほう、1行ならその行
  "  var typical = lengths.length > 0 ? lengths[Math.ceil((lengths.length - 1) * 0.75)] : 0;",
  "  function endsEarly(line) {",
  "    var n = chars(line).length;",
  "    return n <= typical * SHORT_RATIO && typical - n >= SHORT_MIN_GAP;",
  "  }",
  "  function keepBreak(prev, next) {",
  "    if (isBlank(prev) || isBlank(next)) return true;",
  "    var head = next.charAt(0);",
  "    if (head === ' ' || head === '\\t' || head === '\\u3000') return true;",
  "    if (OPENERS.indexOf(head) >= 0) return true;",
  "    var tail = chars(prev);",
  "    if (CLOSERS.indexOf(tail[tail.length - 1]) >= 0) return true;",
  "    return endsEarly(prev);",
  "  }",
  "  var out = lines[0];",
  "  for (var j = 1; j < lines.length; j++) {",
  "    var prev = lines[j - 1];",
  "    var next = lines[j];",
  "    if (keepBreak(prev, next)) { out += '\\n' + next; continue; }",
  "    var last = Array.from(prev);",
  "    var glue = isAsciiLetter(last[last.length - 1]) && isAsciiLetter(Array.from(next)[0]) ? ' ' : '';",
  "    out += glue + next;",
  "  }",
  // 改行と空白を除いて元と一字でも違えば、つなぐのをやめて元の行のまま返す
  "  if (out.replace(/\\s+/g, '') !== source.replace(/\\s+/g, '')) return source;",
  "  return out;",
  "}",
].join("\n");
