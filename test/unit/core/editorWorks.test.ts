import { describe, expect, test } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { isJoinedWork, isUnderEditingHome } from "../../../src/core/editorWorks";

/**
 * 編集者モードで出す作品の見分け（作者の指示 2026-11-05 夜「編集モードだと自分の作品を出さないように
 * してください」。設計書5.6.6）。
 *
 * **0.127.x までに参加した作品（印が無い）が消えて見えないこと**を最優先に見る。
 */

function work(id: string, folderPath: string, joinedAsEditor?: boolean): WorkEntry {
  return {
    id,
    title: id,
    folderPath,
    registeredAt: "2026-11-01T00:00:00.000Z",
    ...(joinedAsEditor ? { joinedAsEditor } : {}),
  };
}

describe("参加した作品か", () => {
  test("参加で登録した作品（印あり）は出す", () => {
    expect(isJoinedWork(work("a", "D:\\どこか\\作品", true), "absent")).toBe(true);
  });

  test("印の無い作品でも、参加の置き場（編集部/）の下なら出す", () => {
    expect(isJoinedWork(work("k", "C:\\Users\\kmizu\\Documents\\編集部\\tayutau"), "absent")).toBe(true);
    expect(isJoinedWork(work("k", "/home/kmizu/編集部/tayutau"), "absent")).toBe(true);
  });

  test("印の無い作品でも、編集用の写しの印（editor-share-manifest）があれば出す", () => {
    expect(isJoinedWork(work("k", "D:\\別の場所\\tayutau"), "present")).toBe(true);
  });

  test("写しの印が読めないときは、出さないに倒さない", () => {
    expect(isJoinedWork(work("k", "D:\\別の場所\\tayutau"), "unknown")).toBe(true);
  });

  test("印も置き場も写しの印も無い作品（作者自身の作品）は出さない", () => {
    expect(isJoinedWork(work("own", "C:\\Users\\nonah\\小説\\氷の街"), "absent")).toBe(false);
  });

  test("置き場の判定は、フォルダー名が「編集部」と一致するときだけ（名前に含むだけでは見ない）", () => {
    expect(isUnderEditingHome("C:\\小説\\編集部メモ\\作品")).toBe(false);
    expect(isUnderEditingHome("C:\\小説\\編集部\\作品")).toBe(true);
  });
});
