import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CONTEST_INBOX_KEY,
  RSS_SKIPPED_NOTE,
  type ContestImportDeps,
  type ContestMemory,
} from "../../../src/features/contestImport";
import { importContestsFromRss } from "../../../src/features/contestRss";
import { CONTEST_RSS_URL } from "../../../src/core/contestRss";
import { normalizeContestInbox } from "../../../src/core/contestInbox";
import { window } from "../support/vscodeStub";

/**
 * 公募を RSS から取り込む（設計書6.3.6.2）。
 *
 * - **押す前に、どこへつなぐかを出す**（作者の裁定：押したときだけ取りに行く）
 * - 断ったら通信しない
 * - 読んだものは、ヘルパー・貼り付けと同じ置き場へ入れる
 * - つなげない・RSS でないときは、理由と別の道（貼り付け）を言う。**0件を黙って成功にしない**
 *
 * 見本の公募はすべて作り物である。
 */

const FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0"><channel><title>作り物</title><link>https://tsukuritemirai.com/kobo/novel/</link>',
  "<item><title>第3回 あおぞら短編賞</title><link>https://tsukuritemirai.com/kobo/aaa</link>",
  "<description>短編を募集。 募集内容 : 1万字以内 〆切 : WEB応募：2026年10月31日</description></item>",
  "<item><title>締切の無い募集</title><description>随時。</description></item>",
  "</channel></rss>",
].join("");

class MemoryStub implements ContestMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}

let memory: MemoryStub;
let informed: string[];
let warned: string[];
let details: string[];
/** 確かめる画面で押すボタン */
let confirmAnswer: string | undefined;

function deps(): ContestImportDeps {
  return { memory, listWorks: () => [], afterSave: async () => undefined };
}

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeAll(() => {
  Object.assign(window, {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00+09:00"));
  memory = new MemoryStub();
  informed = [];
  warned = [];
  details = [];
  confirmAnswer = "取りに行く";
  Object.assign(window, {
    showInformationMessage: async (text: string, ...rest: unknown[]) => {
      informed.push(text);
      const options = rest[0];
      if (typeof options === "object" && options !== null && "modal" in options) {
        details.push(String((options as { detail?: string }).detail ?? ""));
        return rest.includes(confirmAnswer) ? confirmAnswer : undefined;
      }
      return undefined;
    },
    showWarningMessage: async (text: string) => {
      warned.push(text);
      return undefined;
    },
  });
});

describe("RSS から取り込む", () => {
  test("押す前に、つなぐ先（フィードの URL）を出す。断ったら通信しない", async () => {
    confirmAnswer = undefined;
    const fetcher = vi.fn();
    await importContestsFromRss(deps(), undefined, fetcher);
    expect(details.join("\n")).toContain(CONTEST_RSS_URL);
    expect(fetcher).not.toHaveBeenCalled();
    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
  });

  test("取りに行ったら、読めた公募を置き場へ入れ、読めなかった数も言う", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response(200, FEED));
    await importContestsFromRss(deps(), undefined, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(CONTEST_RSS_URL);
    const inbox = normalizeContestInbox(memory.values.get(CONTEST_INBOX_KEY));
    expect(inbox.map((entry) => entry.name)).toEqual(["第3回 あおぞら短編賞"]);
    expect(inbox[0].source).toBe("tsukuritemirai");
    expect(inbox[0].url).toBe("https://tsukuritemirai.com/kobo/aaa");
    expect(inbox[0].sourcePage).toBe("https://tsukuritemirai.com/kobo/novel/");
    expect(informed.join("\n")).toContain("公募を1件読みました（公募として読めなかったもの 1件）");
    // 本物のフィードは説明を500字で切っており、締切の欄が落ちることがある（2026-09-23 に実測）
    expect(informed.join("\n")).toContain(RSS_SKIPPED_NOTE);
  });

  test("HTTP で断られたら、状態の番号と別の道（貼り付け）を言う", async () => {
    const fetcher = vi.fn(async () => response(503, "メンテナンス中"));
    await importContestsFromRss(deps(), undefined, fetcher);
    expect(warned.join("\n")).toContain("503");
    expect(warned.join("\n")).toContain("貼り付けて取り込む");
    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
  });

  test("つなげなかったら（通信の失敗）、理由を決めつけずに言う", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await importContestsFromRss(deps(), undefined, fetcher);
    expect(warned.join("\n")).toContain("つなげませんでした");
    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
  });

  test("RSS でない文が返ったら、理由を言って止める", async () => {
    const fetcher = vi.fn(async () => response(200, "<!DOCTYPE html><html><body>別のページ</body></html>"));
    await importContestsFromRss(deps(), undefined, fetcher);
    expect(warned.join("\n")).toContain("RSS の形ではありません");
    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
  });

  test("公募が0件なら、黙って成功にしない", async () => {
    const fetcher = vi.fn(async () =>
      response(200, '<rss version="2.0"><channel><title>空</title></channel></rss>')
    );
    await importContestsFromRss(deps(), undefined, fetcher);
    expect(warned.join("\n")).toContain("公募を1件も読めませんでした");
  });
});
