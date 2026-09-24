/**
 * 画面に流れる文が英語になっていたら、その場で差し戻す（作者の指示、2026-09-25）。
 *
 * ## なぜ要るのか
 *
 * CLAUDE.md とメモリーで「日本語で」と何度書いても、長い作業や英語のログを読んだあとに
 * 英語へ戻る。作者は思考の欄もツールの説明文も読んでいるので、毎回気づいて指摘していた。
 *
 * ## なぜこの形なのか（処理量を使わない）
 *
 * 毎ターン「日本語で」と注意書きを差し込むやり方は、何も起きていないときにも処理量を使う。
 * このフックは**文字を数えるだけ**で、AIには何も送らない。**英語だったときだけ**
 * 差し戻しの一文（数十字）が届き、書き直しの分だけ処理量を使う。
 *
 * - `stop`：返事を出し終えたとき、最後の返事の文を数える。英語なら書き直させる
 * - `tool`：コマンドの説明文・担当への指示・作者への質問を、実行する前に数える。英語なら止めて書き直させる
 *
 * ## 見られないもの
 *
 * **思考の欄は数えられない。** 会話記録には思考の中身が残らない（空で保存される）ため。
 * 思考が英語に戻る癖は、返事と説明文を差し戻されることで間接的に抑えるしかない。
 *
 * ## 数え方
 *
 * コードの囲み・`インラインコード`・URL・ファイルのパスは除く（英字で当然のもの）。
 * そのうえで英字とかなと漢字を数え、英字が多すぎるときだけ英語とみなす。
 * 英単語は1語5字ほど、日本語は1字で1語近くの意味を持つので、英字を割り引いて比べる。
 *
 * **どんな失敗でも止めない。** 数え損ねたら黙って通す（作業を止めるほうが害が大きい）。
 */

import fs from "node:fs";

/** 本文（長い文）：英字がこれ未満なら数えない。短い英語の固有名詞だけの返事を止めない */
const MIN_LATIN_LONG = 60;
/** 説明文（短い文）：かなも漢字も無く、英字がこれ以上なら英語 */
const MIN_LATIN_SHORT = 10;

function stripNonProse(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<[^>\n]{1,80}>/g, " ")
    // パス・ファイル名・識別子（/ \ . _ を含む英数字のかたまり）
    .replace(/[\w.-]*[\\/][\w.\\/:-]*/g, " ")
    .replace(/\b\w+[._]\w[\w._]*\b/g, " ");
}

function measure(text) {
  const prose = stripNonProse(text);
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length;
  const japanese = (prose.match(/[぀-ヿ㐀-鿿ｦ-ﾟ]/g) ?? []).length;
  return { latin, japanese };
}

/** 長い文（返事・担当への指示） */
export function looksEnglishLong(text) {
  const { latin, japanese } = measure(text);
  if (latin < MIN_LATIN_LONG) return false;
  // 英字5字 ≒ 日本語1〜2字。英字が日本語の3倍を超えたら、地の文が英語になっている
  return latin > japanese * 3;
}

/** 短い文（コマンドの説明・質問） */
export function looksEnglishShort(text) {
  const { latin, japanese } = measure(text);
  if (japanese > 0) return false;
  return latin >= MIN_LATIN_SHORT;
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** 会話記録の末尾から、最後の返事（最後のツール結果より後の文）を拾う */
function lastReplyFromTranscript(file) {
  const size = fs.statSync(file).size;
  const want = Math.min(size, 2 * 1024 * 1024);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(want);
  fs.readSync(fd, buf, 0, want, size - want);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type === "user") break;
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block.type === "text" && block.text) parts.unshift(block.text);
  }
  return parts.join("\n");
}

function block(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

function onStop(input) {
  // 差し戻したあとの書き直しで、もう一度止めない（止め続ける輪を作らない）
  if (input.stop_hook_active) return;
  const text =
    typeof input.last_assistant_message === "string"
      ? input.last_assistant_message
      : input.transcript_path
        ? lastReplyFromTranscript(input.transcript_path)
        : "";
  if (text && looksEnglishLong(text)) {
    block("返事が英語でした。同じ内容を日本語で書き直してください（CLAUDE.md の言語の決まり）。");
  }
}

function onTool(input) {
  const t = input.tool_input ?? {};
  const shortTexts = [];
  const longTexts = [];
  if (typeof t.description === "string") shortTexts.push(t.description);
  if (typeof t.prompt === "string") longTexts.push(t.prompt);
  if (Array.isArray(t.questions)) {
    for (const q of t.questions) {
      if (typeof q?.question === "string") shortTexts.push(q.question);
      for (const o of q?.options ?? []) {
        if (typeof o?.description === "string") shortTexts.push(o.description);
      }
    }
  }
  const bad = shortTexts.find(looksEnglishShort) ?? longTexts.find(looksEnglishLong);
  if (bad !== undefined) {
    block("作者が読む文が英語でした。日本語に直して、もう一度呼んでください：「" + bad.slice(0, 60) + "」");
  }
}

// テストから関数だけを読み込むときは走らせない
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  try {
    const input = readStdin();
    if (input) {
      if (process.argv[2] === "stop") onStop(input);
      else if (process.argv[2] === "tool") onTool(input);
    }
  } catch {
    // 数え損ねたら黙って通す
  }
  process.exit(0);
}
