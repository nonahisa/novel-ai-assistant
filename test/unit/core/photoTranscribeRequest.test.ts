import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import {
  PHOTO_REQUEST_KEY_PREFIX,
  PHOTO_REQUEST_MAX_CHARS,
  PhotoTranscribeRequestStore,
  checkPhotoRequest,
  countPhotoRequestChars,
  photoRequestEchoes,
  photoRequestKey,
} from "../../../src/core/photoTranscribeRequest";
import { verifiedState } from "../../../src/core/verifiedMemento";

/**
 * 写真の書き起こしの「AIへの頼み」（設計書6.117.12。作者の裁定、2026-10-12）。
 *
 * 守るのは3つ。
 * 1. 作品ごとに覚え、次に開いたとき前の頼みが入っている（ほかの作品へ漏れない）
 * 2. 上限（300字）を超えたら、黙って切らずに断る
 * 3. 改行はそのまま
 */

/** その場かぎりの保管庫 */
function memento(): vscode.Memento {
  const box = new Map<string, unknown>();
  return {
    keys: () => [...box.keys()],
    get: <T>(key: string, fallback?: T) => (box.has(key) ? box.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) box.delete(key);
      else box.set(key, value);
    },
  } as vscode.Memento;
}

/** 書いたあと読み返しを見張る仕組みを止めて包む（試験の中で時計を待たない） */
function store(state = memento()): { store: PhotoTranscribeRequestStore; state: vscode.Memento } {
  verifiedState(state, { lateCheckDelays: [] });
  return { store: new PhotoTranscribeRequestStore(state), state };
}

describe("頼みを作品ごとに覚える", () => {
  test("覚えた頼みは、同じ作品でだけ読める（改行もそのまま）", async () => {
    const { store: requests } = store();
    await requests.set("work-a", "旧字体はそのまま。\nルビの小さい字は（）に入れる。");
    expect(requests.get("work-a")).toBe("旧字体はそのまま。\nルビの小さい字は（）に入れる。");
    expect(requests.get("work-b")).toBe("");
  });

  test("次に開いたとき（同じ保管庫を新しく包み直しても）前の頼みが入っている", async () => {
    const shared = memento();
    await store(shared).store.set("work-a", "旧字体はそのまま");
    expect(new PhotoTranscribeRequestStore(shared).get("work-a")).toBe("旧字体はそのまま");
  });

  test("鍵は作品IDごと", async () => {
    const { store: requests, state } = store();
    await requests.set("work-a", "頼み");
    expect(photoRequestKey("work-a")).toBe(`${PHOTO_REQUEST_KEY_PREFIX}work-a`);
    expect(state.get(photoRequestKey("work-a"))).toBe("頼み");
  });

  test("空にしたら消す（空の頼みを残さない）", async () => {
    const { store: requests, state } = store();
    await requests.set("work-a", "頼み");
    await requests.set("work-a", "  \n ");
    expect(requests.get("work-a")).toBe("");
    expect(state.get(photoRequestKey("work-a"))).toBeUndefined();
  });

  test("CRLF は LF にそろえ、前後の空白は落とす", async () => {
    const { store: requests } = store();
    await requests.set("work-a", "\r\n 一行目\r\n二行目 \r\n");
    expect(requests.get("work-a")).toBe("一行目\n二行目");
  });

  test("上限を超えた頼みは覚えない（前の頼みが残る）", async () => {
    const { store: requests } = store();
    await requests.set("work-a", "前の頼み");
    expect(await requests.set("work-a", "あ".repeat(PHOTO_REQUEST_MAX_CHARS + 1))).toBe(false);
    expect(requests.get("work-a")).toBe("前の頼み");
  });
});

describe("頼みの上限", () => {
  test("上限は300字", () => {
    expect(PHOTO_REQUEST_MAX_CHARS).toBe(300);
  });

  test("ちょうど上限までは通す", () => {
    const check = checkPhotoRequest("あ".repeat(PHOTO_REQUEST_MAX_CHARS));
    expect(check.ok).toBe(true);
  });

  test("超えたら、黙って切らずに理由（字数）を返す", () => {
    const check = checkPhotoRequest("あ".repeat(PHOTO_REQUEST_MAX_CHARS + 1));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("300字を超えています（301字）");
  });

  test("絵文字などは1字に数える（画面の Array.from と揃える）", () => {
    expect(countPhotoRequestChars("𠮷野家")).toBe(3);
    expect(checkPhotoRequest("𠮷".repeat(PHOTO_REQUEST_MAX_CHARS)).ok).toBe(true);
  });

  test("文字列でないものは空の頼みとして扱う", () => {
    expect(checkPhotoRequest(undefined)).toEqual({ ok: true, text: "" });
    expect(checkPhotoRequest(42)).toEqual({ ok: true, text: "" });
  });
});

describe("頼みの返りを捨てるための行", () => {
  test("空の行を除き、行ごとに前後の空白を落とす", () => {
    expect(photoRequestEchoes(" 旧字体はそのまま\n\n ルビは（）に ")).toEqual([
      "旧字体はそのまま",
      "ルビは（）に",
    ]);
    expect(photoRequestEchoes("")).toEqual([]);
  });
});
