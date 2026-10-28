import { describe, expect, test } from "vitest";
import {
  autoEditingDestination,
  changesOutsideLedger,
  joinEditorDestination,
  shouldReturnDecisions,
} from "../../../src/core/editingRepo";
import { isNestedLocation } from "../../../src/core/locationCompare";

describe("置き場の自動決定", () => {
  test("既定の置き場の下の「編集部」に、題から作った名前で置く", () => {
    const destination = autoEditingDestination("C:\\Novels", "氷の街");
    expect(destination.replace(/\\/g, "/")).toBe("C:/Novels/編集部/氷の街-編集用");
  });

  test("同じ名前があるときは番号を足す（中身を巻き込まない）", () => {
    expect(autoEditingDestination("C:\\Novels", "氷の街", 2).replace(/\\/g, "/")).toBe(
      "C:/Novels/編集部/氷の街-編集用-2"
    );
  });

  test("作品フォルダーの中になる置き場は、入れ子として断れる", () => {
    const work = "C:\\Novels\\氷の街";
    expect(isNestedLocation(autoEditingDestination(work, "氷の街"), work)).toBe(true);
    expect(isNestedLocation(autoEditingDestination("C:\\Novels", "氷の街"), work)).toBe(false);
  });

  test("参加の置き場は 編集部/<リポジトリ名>", () => {
    expect(joinEditorDestination("C:\\Novels", "novel-editing").replace(/\\/g, "/")).toBe(
      "C:/Novels/編集部/novel-editing"
    );
  });
});

describe("採否を決め終えたら自動で送り返すか", () => {
  const base = { hasPointer: true, pendingCount: 0, editorMode: false };

  test("pointer があり、未決が0件なら送り返す", () => {
    expect(shouldReturnDecisions(base)).toBe(true);
  });
  test("未決が残っていれば送り返さない", () => {
    expect(shouldReturnDecisions({ ...base, pendingCount: 1 })).toBe(false);
  });
  test("pointer が無い（渡していない）作品では何もしない", () => {
    expect(shouldReturnDecisions({ ...base, hasPointer: false })).toBe(false);
  });
  test("編集者モードでは何もしない", () => {
    expect(shouldReturnDecisions({ ...base, editorMode: true })).toBe(false);
  });
});

describe("校閲を終えて返すときの、本文の未記録の検査", () => {
  test("台帳（.aiwriter）の変更だけなら、外には何も無い", () => {
    expect(
      changesOutsideLedger([
        ".aiwriter/proposals/proposals.jsonl",
        ".aiwriter\\locks\\locks.jsonl",
      ])
    ).toEqual([]);
  });

  test("本文や設定資料の変更は外として拾う", () => {
    expect(
      changesOutsideLedger([".aiwriter/proposals/proposals.jsonl", "本文/001.txt", "設定/a.json"])
    ).toEqual(["本文/001.txt", "設定/a.json"]);
  });

  test("`.gitignore` は拡張機能が整える作業用の設定なので、本文の変更に数えない（B3）", () => {
    expect(changesOutsideLedger([".gitignore", ".aiwriter/locks/locks.jsonl"])).toEqual([]);
    // 本文の変更が一緒にあれば、そちらだけが残る
    expect(changesOutsideLedger([".gitignore", "本文/001.txt"])).toEqual(["本文/001.txt"]);
  });

  test("名前が似ているだけの .aiwriter-old は台帳ではない", () => {
    expect(changesOutsideLedger([".aiwriter-old/x.txt"])).toEqual([".aiwriter-old/x.txt"]);
  });
});
