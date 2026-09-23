import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAT_NOTE_DIR,
  CHAT_NOTE_NAME_TRIES,
  buildChatNoteMarkdown,
  chatNoteFileNameCandidates,
  type ChatNoteTurn,
} from "../../src/core/chatNote";

/**
 * 相談メモ（作者の要望、2026-08-28）。
 *
 * 会話は閉じると消えるので、読み返せる形で残せるようにした。
 * ここで見るのは**組み立て**だけ（保存はVS Code APIが要るので別）。
 */

const AT = new Date(2026, 7, 28, 2, 49, 17);

function note(turns: ChatNoteTurn[]): string {
  return buildChatNoteMarkdown(turns, { workTitle: "銀の航路", savedAt: AT });
}

describe("メモの組み立て", () => {
  test("見出しと、作品名・日時が入る", () => {
    const markdown = note([]);

    expect(markdown).toContain("# 相談メモ");
    expect(markdown).toContain("- 作品: 銀の航路");
    expect(markdown).toContain("- 保存: 2026-08-28 02:49");
  });

  test("往復が、話した順に並ぶ", () => {
    const markdown = note([
      { role: "author", text: "この場面は説明が多すぎない？" },
      { role: "assistant", text: "3段落目が説明に寄っています。" },
      { role: "author", text: "どう直す？" },
    ]);

    // 見出しで話者を分ける。**順序そのものが会話である**ので、
    // 並べ替えたり畳んだりしない
    const order = [...markdown.matchAll(/^## (あなた|AI)$/gm)].map((m) => m[1]);
    expect(order).toEqual(["あなた", "AI", "あなた"]);

    // 中身が落ちていないこと
    expect(markdown).toContain("この場面は説明が多すぎない？");
    expect(markdown).toContain("3段落目が説明に寄っています。");
    expect(markdown).toContain("どう直す？");
  });

  test("AIの返事のMarkdownは、そのまま残す", () => {
    // 返事は箇条書きや強調で返ってくる。引用で畳むと読めなくなる
    const markdown = note([
      { role: "assistant", text: "- 案1\n- 案2" },
    ]);

    expect(markdown).toContain("- 案1\n- 案2");
  });

  test("履歴が空でも壊れない", () => {
    // **空のときに保存するかどうかは呼び出し側が決める。**
    // ここで投げると「まだ会話がありません」と穏やかに伝える道が塞がる
    expect(() => note([])).not.toThrow();
    expect(note([])).toContain("# 相談メモ");
  });

  test("末尾は改行1つで終わる", () => {
    const markdown = note([{ role: "author", text: "こんにちは" }]);

    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("保存先の名前", () => {
  test("はじめの候補は、分までの名前", () => {
    expect(chatNoteFileNameCandidates(AT)[0]).toBe("相談 2026-08-28 0249.md");
  });

  test("ぶつかったときの候補は、秒つき・連番の順", () => {
    const names = chatNoteFileNameCandidates(AT, 4);

    expect(names).toEqual([
      "相談 2026-08-28 0249.md",
      "相談 2026-08-28 024917.md",
      "相談 2026-08-28 024917-2.md",
      "相談 2026-08-28 024917-3.md",
    ]);
  });

  test("候補どうしが重ならない", () => {
    // 同じ名前を2度試しても意味がない（上書きはしない作りなので、
    // 候補が尽きると保存そのものができなくなる）
    const names = chatNoteFileNameCandidates(AT, 20);

    expect(new Set(names).size).toBe(names.length);
  });

  test("1桁の月日・時刻は0で詰める", () => {
    const names = chatNoteFileNameCandidates(new Date(2026, 0, 5, 9, 3, 7), 2);

    expect(names[0]).toBe("相談 2026-01-05 0903.md");
    expect(names[1]).toBe("相談 2026-01-05 090307.md");
  });
});

/**
 * 保存先と、既存のメモの扱い（実機確認リスト F-23）。
 *
 * **置き場は作品の `設定/相談メモ/`。** GitHubへ同期される場所である
 * ——読み返すためのものなので、開発用の記録（`.aiwriter/logs/chat.md`）とは
 * 扱いを分ける。
 *
 * **既存ファイルは上書きしない。** `atomicWriteFile` の新規作成だけを使い、
 * 名前がぶつかったら別名にする（`atomicWrite.ts` の置換は必ず失敗する設計で、
 * それ以前に作者のメモを消してよい理由がない）。
 */
describe("相談メモの置き場と、上書きしない作り", () => {
  test("`設定/` の下の「相談メモ」へ置く（実機確認リスト F-23 の代わり）", () => {
    expect(CHAT_NOTE_DIR).toBe("相談メモ");

    const source = readFileSync("src/features/workChatPanel.ts", "utf-8");
    expect(source).toContain("CHAT_NOTE_DIR");
  });

  test("同じ分に2回押しても、別名になる（実機確認リスト F-23 の代わり）", () => {
    // 分までの名前がぶつかったら、秒つきへ降りる
    const names = chatNoteFileNameCandidates(AT, 2);

    expect(names[0]).not.toBe(names[1]);
  });

  test("書き込みは新規作成だけを使う（実機確認リスト F-23 の代わり）", () => {
    // ここが `replace` だと、作者のメモを消す道が開く
    const source = readFileSync("src/features/workChatPanel.ts", "utf-8");
    const at = source.indexOf("const markdown = buildChatNoteMarkdown");
    expect(at).toBeGreaterThan(0);

    expect(source.slice(at, at + 400)).toContain('mode: "create"');
  });

  test("試す名前が尽きない数だけ用意してある（実機確認リスト F-23 の代わり）", () => {
    // 候補が尽きると、保存そのものができなくなる
    expect(CHAT_NOTE_NAME_TRIES).toBeGreaterThan(2);
    expect(chatNoteFileNameCandidates(AT, CHAT_NOTE_NAME_TRIES)).toHaveLength(
      CHAT_NOTE_NAME_TRIES
    );
  });
});
