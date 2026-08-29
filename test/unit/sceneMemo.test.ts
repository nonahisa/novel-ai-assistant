import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMO_TAG,
  MEMO_MARKER_COLOR,
  MEMO_TAG_COLORS,
  blankMemoLines,
  countMemosByTag,
  hasMemoLines,
  isMemoLine,
  memoBadgeText,
  memoColorVars,
  memoLineRanges,
  memoTagClass,
  memoTagKind,
  nearestMemo,
  nextMemo,
  parseMemos,
  prevMemo,
  removeMemoLine,
  sortMemos,
  stripMemoLines,
} from "../../src/core/sceneMemo";
import { sceneMemoToMarkdown } from "../../src/core/sceneMemoMarkdown";
import { countChars, countManuscriptLines } from "../../src/core/charCount";
import { splitIntoChunks, withLineNumbers } from "../../src/core/chunker";
import { bodyForPosting } from "../../src/core/episodeCopy";
import { buildPrintHtml } from "../../src/core/printHtml";
import { renderTermMarks } from "../../src/core/manuscriptRender";
import { hideMemoLinesInMarkdown } from "../../src/core/markdownItRuby";
import { TermIndex } from "../../src/core/termIndex";

/**
 * シーンメモ——本文中の付箋（設計書6.40）。
 *
 * **消し忘れが公開事故になる。** メモは作者だけのもので、読者向けの出力
 * （字数・投稿用・PDF・プレビュー）とAIの入力からは必ず消える。
 * 6.40.2 の表に並ぶ経路を**1本ずつ見張る**のが、この試験の主な役目である。
 */

describe("付箋の記法（6.40.1）", () => {
  it("行の先頭の // と ／／ だけが付箋である", () => {
    expect(isMemoLine("// TODO 描写を足す")).toBe(true);
    expect(isMemoLine("／／ 要確認 距離が合わない")).toBe(true);
  });

  /**
   * **字下げを許さない。** 日本語の小説は段落の頭を全角空白で下げるので、
   * 先頭の空白を許すと本文と見分けが付かなくなる。
   */
  it("先頭に空白があれば付箋ではない", () => {
    expect(isMemoLine(" // 半角の字下げ")).toBe(false);
    expect(isMemoLine("　// 全角の字下げ")).toBe(false);
  });

  /** URLと会話文を巻き込まない */
  it("行の途中の // は付箋ではない", () => {
    expect(isMemoLine("　彼は https://example.com を開いた。")).toBe(false);
    expect(isMemoLine("「そうか// と彼は言った」")).toBe(false);
  });

  it("最初の語をタグとして読む", () => {
    const memos = parseMemos("// TODO 潮の匂いを足す", "a.txt");
    expect(memos).toHaveLength(1);
    expect(memos[0]).toMatchObject({
      filePath: "a.txt",
      line: 1,
      tag: "TODO",
      text: "潮の匂いを足す",
      raw: "// TODO 潮の匂いを足す",
    });
  });

  /**
   * **日本語には語の切れ目に空白が無い。** 空白で区切られていない1語は
   * 本文であって、タグではない（全文がタグになってしまう）。
   */
  it("語が1つだけなら、タグではなく本文として読む", () => {
    const memos = parseMemos("// 潮の匂いを足す");
    expect(memos[0].tag).toBe(DEFAULT_MEMO_TAG);
    expect(memos[0].text).toBe("潮の匂いを足す");
  });

  it("よく使うタグは、それだけ書いてもタグとして読む", () => {
    const memos = parseMemos("// TODO");
    expect(memos[0].tag).toBe("TODO");
    expect(memos[0].text).toBe("");
  });

  it("印の直後の空白は落とす（全角も）", () => {
    expect(parseMemos("//　　伏線　銀の時計")[0]).toMatchObject({
      tag: "伏線",
      text: "銀の時計",
    });
  });

  it("行番号は1始まりで、メモでない行も数える", () => {
    const memos = parseMemos("　一行目\n\n// TODO ここ\n　四行目\n// 伏線 そこ");
    expect(memos.map((memo) => memo.line)).toEqual([3, 5]);
  });

  it("タグごとに色の種類が決まる（表に無い語は灰）", () => {
    expect(memoTagKind("TODO")).toBe("todo");
    expect(memoTagKind("要確認")).toBe("check");
    expect(memoTagKind("伏線")).toBe("foreshadow");
    expect(memoTagKind("アイデア")).toBe("idea");
    expect(memoTagKind("推敲")).toBe("other");
    expect(memoTagClass("TODO")).toBe("memo-todo");
  });

  /** **16進はここ1か所**（画面はCSS変数で受ける。6.40.5） */
  it("色は明暗の組で持ち、CSS変数の一式にできる", () => {
    const dark = memoColorVars(true);
    expect(dark["memo-marker"]).toBe(MEMO_MARKER_COLOR.dark);
    expect(dark["memo-todo"]).toBe(MEMO_TAG_COLORS.todo.dark);
    const light = memoColorVars(false);
    expect(light["memo-marker"]).toBe(MEMO_MARKER_COLOR.light);
    expect(light["memo-todo"]).toBe(MEMO_TAG_COLORS.todo.light);
  });
});

describe("2つの消し方（6.40.1）", () => {
  it("blankMemoLines は行数を保つ", () => {
    const text = "　一行目\n// TODO ここ\n　三行目";
    const blanked = blankMemoLines(text);
    expect(blanked.split("\n")).toHaveLength(3);
    expect(blanked).toBe("　一行目\n\n　三行目");
  });

  /**
   * **CRLFを保つ。** 改行コードを勝手に変えると、外部ツールで書いている
   * 作者のファイルが1行残らず「変更あり」になる（設計書5.4）。
   */
  it("blankMemoLines は CRLF をそのまま残す", () => {
    const text = "　一行目\r\n// TODO ここ\r\n　三行目\r\n";
    expect(blankMemoLines(text)).toBe("　一行目\r\n\r\n　三行目\r\n");
  });

  it("stripMemoLines は行ごと落とす", () => {
    const text = "　一行目\n// TODO ここ\n　三行目";
    expect(stripMemoLines(text)).toBe("　一行目\n　三行目");
  });

  it("stripMemoLines も CRLF を残す", () => {
    expect(stripMemoLines("　一行目\r\n／／ 伏線\r\n　三行目")).toBe(
      "　一行目\r\n　三行目"
    );
  });

  it("メモが無い本文は、どちらの関数でも変わらない", () => {
    const text = "　彼女は港を見下ろしていた。\r\n　風が吹いた。\r\n";
    expect(blankMemoLines(text)).toBe(text);
    expect(stripMemoLines(text)).toBe(text);
    expect(hasMemoLines(text)).toBe(false);
  });

  it("メモ行の範囲を、改行を含めずに返す", () => {
    expect(memoLineRanges("あ\n// x\nい")).toEqual([{ start: 2, end: 6 }]);
  });
});

/* ══ 消し忘れの見張り（6.40.2 の表を1本ずつ） ══════════════ */

/** どの経路の試験でも使う、メモ入りの本文 */
const BODY_WITH_MEMO = [
  "　彼女は港を見下ろしていた。",
  "// TODO ここに潮の匂いの描写を足す",
  "　風が吹いた。",
].join("\n");

describe("読者向けの出力とAIから消す（6.40.2）", () => {
  it("字数：メモは執筆量に入らない", () => {
    const withMemo = countChars(BODY_WITH_MEMO);
    const without = countChars("　彼女は港を見下ろしていた。\n　風が吹いた。");
    expect(withMemo).toEqual(without);
  });

  it("原稿用紙の行数：メモはマスを取らない", () => {
    expect(countManuscriptLines(BODY_WITH_MEMO)).toBe(
      countManuscriptLines("　彼女は港を見下ろしていた。\n　風が吹いた。")
    );
  });

  it("投稿用にコピー：メモは投稿されない", () => {
    const posted = bodyForPosting(BODY_WITH_MEMO, "site");
    expect(posted).not.toContain("TODO");
    expect(posted).toContain("港を見下ろしていた");
  });

  it("PDF：メモは紙に出ない", () => {
    const html = buildPrintHtml({
      workTitle: "試作",
      episodes: [
        { heading: "第1話", body: BODY_WITH_MEMO, notation: "curly" },
      ],
      preset: "bunko-vertical",
    });
    expect(html).not.toContain("TODO");
    expect(html).toContain("港を見下ろしていた");
  });

  /**
   * **AIへ渡す本文は、行数が変わらないこと**が肝である（6.40.2）。
   * 誤字脱字と推敲はAIに「何行目」を言わせ、その値で本文の位置を決める。
   * 行が減れば、AIの指摘が**別の行を書き換える**。
   */
  describe("AIのチャンク", () => {
    it("メモの文はチャンクに入らない", () => {
      const chunks = splitIntoChunks("a.txt", BODY_WITH_MEMO, 1, 1);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).not.toContain("TODO");
    });

    it("行番号が元の本文と一致したまま残る", () => {
      const chunks = splitIntoChunks("a.txt", BODY_WITH_MEMO, 1, 1);
      const numbered = withLineNumbers(chunks[0]).split("\n");
      // メモの行（2行目）は空になるが、行そのものは残る
      expect(numbered).toHaveLength(3);
      expect(numbered[1]).toBe("2: ");
      // 3行目は、元の本文でも3行目である
      expect(numbered[2]).toBe("3: 　風が吹いた。");
    });

    /**
     * 分割が起きる長さでも行番号が合うことを見る。**切り出す位置は
     * メモを抜いたあとの本文で決まる**ので、`startLine` が元の本文と
     * ずれていないかは、実際に割ってみないと分からない。
     */
    it("分割されたチャンクでも、行番号が元の本文と合う", () => {
      const lines: string[] = [];
      for (let i = 1; i <= 40; i++) {
        lines.push(`　${i}行目の本文です。`);
        if (i % 10 === 0) lines.push(`// TODO ${i}のあたり`);
      }
      const text = lines.join("\n");
      const chunks = splitIntoChunks("a.txt", text, 1, 1, { maxChars: 200 });
      expect(chunks.length).toBeGreaterThan(1);

      const original = text.split("\n");
      for (const chunk of chunks) {
        chunk.text.split("\n").forEach((line, index) => {
          const at = chunk.startLine + index;
          // メモの行は空になっているので、それ以外を突き合わせる
          if (line === "") return;
          expect(line).toBe(original[at]);
        });
      }
    });
  });

  it("索引・意味検索の材料：メモの中の名前で場面が引かれない", () => {
    // `loadExcerptSources` は vscode を通るので、そこが呼ぶ関数を直に見る
    const text = "　港に立った。\n// 伏線 太志が銀の時計を持っている\n　船が出た。";
    expect(blankMemoLines(text)).not.toContain("太志");
    expect(blankMemoLines(text)).toContain("港に立った");
  });

  it("Markdownプレビュー：メモの行は出ない", () => {
    expect(hideMemoLinesInMarkdown(BODY_WITH_MEMO)).toBe(
      "　彼女は港を見下ろしていた。\n　風が吹いた。"
    );
  });

  /**
   * **プログラムのコメントを食べない。** この拡張機能の説明文書には
   * 行頭が `//` のコード例がある。まとめて落とすと文書が壊れる。
   */
  it("Markdownプレビュー：囲みコードの中の // は残す", () => {
    const src = [
      "文章です。",
      "```js",
      "// これはコードのコメント",
      "```",
      "// TODO これは付箋",
    ].join("\n");
    const hidden = hideMemoLinesInMarkdown(src);
    expect(hidden).toContain("// これはコードのコメント");
    expect(hidden).not.toContain("// TODO これは付箋");
  });

  /** **原稿エディタは消さない**（ここは書く場所である。6.40.2） */
  it("原稿エディタの重ね敷きには、メモが残って印が付く", () => {
    const html = renderTermMarks(BODY_WITH_MEMO, new TermIndex([]));
    expect(html).toContain("TODO");
    expect(html).toContain('<span class="memo-line">');
  });

  /**
   * **本文は1文字も落とさない。** 重ね敷きは打つ面と字がぴったり重なる
   * ことで成り立っている（設計書6.25.6）。1文字でも増減すると、
   * 色も蛍光ペンも別の字に付く。
   */
  it("用語とメモが混ざっても、文字は増えも減りもしない", () => {
    const index = new TermIndex([
      { text: "太志", kind: "character", id: "c1", canonicalName: "太志" },
    ]);
    const text = "　太志は港へ出た。\n// 伏線 太志の銀の時計\n　太志は笑った。";
    const html = renderTermMarks(text, index);
    // タグを剥がすと、元の本文がそのまま出てくる
    expect(html.replace(/<[^>]+>/g, "")).toBe(text);
    // メモの行は蛍光ペンの箱に入り、その中の用語にも色が付く
    expect(html).toContain(
      '<span class="memo-line">// 伏線 <span class="mark mark-character">太志</span>'
    );
    // メモの外の用語も、これまでどおり色が付く
    expect(html.match(/mark-character/g)).toHaveLength(3);
  });
});

/* ══ 次へ・戻る（6.40.4） ══════════════════════════ */

const FILES = ["01.txt", "02.txt", "03.txt"];

const MEMOS = [
  ...parseMemos("あ\n// TODO 一つ目\nい\n// 伏線 二つ目", "01.txt"),
  ...parseMemos("あ\n// 要確認 三つ目", "02.txt"),
  ...parseMemos("あ\nい\n// アイデア 四つ目", "03.txt"),
];

describe("次へ・戻る（6.40.4）", () => {
  it("話数順→行の順に並べる", () => {
    const shuffled = [MEMOS[3], MEMOS[1], MEMOS[2], MEMOS[0]];
    expect(
      sortMemos(shuffled, FILES).map((memo) => memo.text)
    ).toEqual(["一つ目", "二つ目", "三つ目", "四つ目"]);
  });

  it("同じ話の中で次へ進む", () => {
    const next = nextMemo(MEMOS, { filePath: "01.txt", line: 2 }, FILES);
    expect(next?.text).toBe("二つ目");
  });

  it("話をまたいで次へ進む", () => {
    const next = nextMemo(MEMOS, { filePath: "01.txt", line: 4 }, FILES);
    expect(next?.text).toBe("三つ目");
  });

  /** **メモの無い話に居ても、その先のメモへ進める**（並びは走査の順） */
  it("メモの無い話に居ても、次の話のメモへ進む", () => {
    const memos = MEMOS.filter((memo) => memo.filePath !== "02.txt");
    const next = nextMemo(memos, { filePath: "02.txt", line: 1 }, FILES);
    expect(next?.text).toBe("四つ目");
  });

  it("末尾なら先頭へ回る", () => {
    const next = nextMemo(MEMOS, { filePath: "03.txt", line: 3 }, FILES);
    expect(next?.text).toBe("一つ目");
  });

  it("戻るは、前のメモへ", () => {
    const prev = prevMemo(MEMOS, { filePath: "02.txt", line: 2 }, FILES);
    expect(prev?.text).toBe("二つ目");
  });

  it("先頭で戻ると末尾へ回る", () => {
    const prev = prevMemo(MEMOS, { filePath: "01.txt", line: 2 }, FILES);
    expect(prev?.text).toBe("四つ目");
  });

  it("メモが1件も無ければ、どちらも何も返さない", () => {
    expect(nextMemo([], null, FILES)).toBeUndefined();
    expect(prevMemo([], null, FILES)).toBeUndefined();
  });

  /** カーソルの追従は**同じ話の中だけ**を見る（別の話の付箋を光らせない） */
  it("いちばん近いメモは、同じ話の中から選ぶ", () => {
    expect(nearestMemo(MEMOS, "01.txt", 4)?.text).toBe("二つ目");
    expect(nearestMemo(MEMOS, "01.txt", 1)?.text).toBe("一つ目");
    expect(nearestMemo(MEMOS, "04.txt", 1)).toBeUndefined();
  });
});

describe("済みにする（6.40.4）", () => {
  it("行が読み込んだときのものなら消す", () => {
    const text = "あ\n// TODO ここ\nい\n";
    expect(removeMemoLine(text, 2, "// TODO ここ")).toBe("あ\nい\n");
  });

  /**
   * **読み込んでから押すまでの間に本文が変わることがある。**
   * 行番号だけで消すと、別の行が消える。
   */
  it("行が変わっていれば消さない", () => {
    const text = "あ\n// TODO 別のこと\nい\n";
    expect(removeMemoLine(text, 2, "// TODO ここ")).toBeNull();
  });

  it("メモでない行は消さない", () => {
    expect(removeMemoLine("あ\nい\n", 2, "い")).toBeNull();
  });

  it("CRLFの本文でも、残る行の改行はそのまま", () => {
    expect(removeMemoLine("あ\r\n// x\r\nい\r\n", 2, "// x")).toBe(
      "あ\r\nい\r\n"
    );
  });
});

describe("Markdownで書き出す（6.40.4）", () => {
  const placeOf = (filePath: string): { label: string; title: string } => ({
    label: `第${filePath.slice(0, 2).replace(/^0/, "")}話`,
    title: "",
  });

  it("話ごとの見出しで、行番号とタグを添えて並べる", () => {
    const markdown = sceneMemoToMarkdown({
      workTitle: "試作",
      memos: MEMOS,
      totalCount: MEMOS.length,
      placeOf,
    });
    expect(markdown).toContain("# シーンメモ：試作");
    expect(markdown).toContain("メモ 4件");
    expect(markdown).toContain("## 第1話");
    expect(markdown).toContain("- 2行目：**TODO** 一つ目");
    expect(markdown).toContain("## 第3話");
  });

  /**
   * **絞り込んだ結果であることを断る。** 件数だけ見て「これで全部」と
   * 読まれると、消し忘れた付箋が残ったまま投稿されかねない。
   */
  it("絞り込んであれば、絞り込み前の件数も出す", () => {
    const markdown = sceneMemoToMarkdown({
      workTitle: "試作",
      memos: [MEMOS[0]],
      totalCount: 4,
      placeOf,
    });
    expect(markdown).toContain("メモ 1件（絞り込み前は 4件）");
  });

  it("1件も無ければ、その旨だけを出す", () => {
    const markdown = sceneMemoToMarkdown({
      workTitle: "試作",
      memos: [],
      totalCount: 0,
      placeOf,
    });
    expect(markdown).toContain("（出ているメモはありません）");
  });
});

describe("件数の印（6.40.5）", () => {
  it("タグごとに数える（多い順）", () => {
    expect(countMemosByTag(MEMOS)).toEqual([
      { tag: "TODO", count: 1 },
      { tag: "アイデア", count: 1 },
      { tag: "伏線", count: 1 },
      { tag: "要確認", count: 1 },
    ]);
  });

  it("メモが無ければ印を出さない", () => {
    expect(memoBadgeText([])).toBe("");
  });

  it("種類が1つなら、その名前と件数だけ", () => {
    const memos = parseMemos("// TODO 一\n// TODO 二", "a.txt");
    expect(memoBadgeText(memos)).toBe("TODO 2");
  });

  it("混ざっていれば、合計も添える", () => {
    const memos = parseMemos("// TODO 一\n// TODO 二\n// 伏線 三", "a.txt");
    expect(memoBadgeText(memos)).toBe("TODO 2／メモ計 3");
  });
});
