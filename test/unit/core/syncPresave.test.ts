import { describe, expect, test } from "vitest";
import {
  describePresaveFailures,
  isInsideAnyFolder,
  pickPresaveDocuments,
  type PresaveDocument,
} from "../../../src/core/syncPresave";

/**
 * 「すべて同期」の記録の前に保存する文書の選び方（設計書5.5.19。
 * 作者の裁定 2026-10-04「記録の前に自動で保存する」）。
 *
 * **保存するのは、同期する作品のフォルダーの中の未保存だけ。** 書庫の根に
 * ある登録していないフォルダー・ほかの作品・作品の外は触らない。
 */

const 作品A = "C:/書庫/作品A";
const 作品B = "C:/書庫/作品B";

function doc(
  filePath: string,
  options: { isDirty?: boolean; isUntitled?: boolean; text?: string } = {}
): PresaveDocument {
  return {
    filePath,
    isDirty: options.isDirty ?? true,
    isUntitled: options.isUntitled ?? false,
    readText: () => options.text ?? "本文",
  };
}

describe("記録の前に保存する文書を選ぶ", () => {
  test("作品の中の未保存だけを選ぶ", () => {
    const picked = pickPresaveDocuments(
      [
        doc(`${作品A}/本文/001.txt`),
        doc(`${作品A}/本文/002.txt`, { isDirty: false }),
        doc("C:/書庫/メモ.txt"),
        doc("C:/ほか/日記.txt"),
      ],
      [作品A]
    );
    expect(picked.save).toEqual([`${作品A}/本文/001.txt`]);
    expect(picked.conflicted).toEqual([]);
  });

  test("同期しない作品の未保存は選ばない", () => {
    const picked = pickPresaveDocuments(
      [doc(`${作品A}/本文/001.txt`), doc(`${作品B}/本文/001.txt`)],
      [作品B]
    );
    expect(picked.save).toEqual([`${作品B}/本文/001.txt`]);
  });

  test("置き場に作品が2つあれば、両方の中を選ぶ", () => {
    const picked = pickPresaveDocuments(
      [doc(`${作品A}/本文/001.txt`), doc(`${作品B}/設定/人物.json`)],
      [作品A, 作品B]
    );
    expect(picked.save).toHaveLength(2);
  });

  test("名前の無い文書は選ばない（保存すると場所を訊かれる）", () => {
    const picked = pickPresaveDocuments(
      [doc(`${作品A}/Untitled-1`, { isUntitled: true })],
      [作品A]
    );
    expect(picked.save).toEqual([]);
  });

  test("名前が前方一致するだけの別フォルダーは中に数えない", () => {
    // 「作品A」と「作品AB」は別の作品
    const picked = pickPresaveDocuments(
      [doc("C:/書庫/作品AB/本文/001.txt")],
      [作品A]
    );
    expect(picked.save).toEqual([]);
  });

  test("競合の印が入った文書は保存せず、分けて返す", () => {
    const marked = "前\n<<<<<<< HEAD\nこちら\n=======\nあちら\n>>>>>>> origin/main\n";
    const picked = pickPresaveDocuments(
      [doc(`${作品A}/本文/001.txt`, { text: marked }), doc(`${作品A}/本文/002.txt`)],
      [作品A]
    );
    expect(picked.save).toEqual([`${作品A}/本文/002.txt`]);
    expect(picked.conflicted).toEqual([`${作品A}/本文/001.txt`]);
  });

  test("作品の外の文書の本文は読まない", () => {
    let read = 0;
    pickPresaveDocuments(
      [
        {
          filePath: "C:/ほか/大きな.txt",
          isDirty: true,
          isUntitled: false,
          readText: () => {
            read += 1;
            return "";
          },
        },
      ],
      [作品A]
    );
    expect(read).toBe(0);
  });

  test("区切りの違いだけの同じ文書を二度選ばない", () => {
    const picked = pickPresaveDocuments(
      [doc(`${作品A}/本文/001.txt`), doc("C:\\書庫\\作品A\\本文\\001.txt")],
      [作品A]
    );
    expect(picked.save).toHaveLength(1);
  });

  test("作品フォルダーそのものは中に数えない", () => {
    expect(isInsideAnyFolder([作品A], 作品A)).toBe(false);
    expect(isInsideAnyFolder([作品A], `${作品A}/本文/001.txt`)).toBe(true);
  });
});

describe("保存できなかった話の知らせ", () => {
  test("どの話が、なぜ保存できなかったかを出す", () => {
    const text = describePresaveFailures([
      { filePath: `${作品A}/本文/001.txt`, reason: "saveFailed" },
      { filePath: `${作品A}/本文/002.txt`, reason: "conflict" },
      { filePath: `${作品A}/本文/003.txt`, reason: "unsent" },
    ]);
    expect(text).toContain("記録を止めました");
    expect(text).toContain("「001.txt」（保存できませんでした）");
    expect(text).toContain("「002.txt」（競合の印");
    expect(text).toContain("「003.txt」（原稿エディターの画面の字が、まだ原稿へ届いていません）");
  });

  test("同じ話は1回だけ出す", () => {
    const text = describePresaveFailures([
      { filePath: `${作品A}/本文/001.txt`, reason: "timeout" },
      { filePath: `${作品A}/本文/001.txt`, reason: "saveFailed" },
    ]);
    expect(text.match(/001\.txt/g)).toHaveLength(1);
  });
});
