import { describe, expect, it } from "vitest";
import {
  NOTICE_FUNCTION_NAMES,
  NoticeBuffer,
  wrapNoticeFunctions,
  type NoticeCall,
  type NoticeTarget,
} from "../../../src/features/noticeRecorder";
import { redactSecrets } from "../../../src/core/logger";

/**
 * 知らせを1か所で受ける仕掛け（MCP の `notices.recent`。作者の承認、2026-09-24）。
 *
 * **見張りたいのは、包んでも知らせの振る舞いが変わらないこと。**
 * 記録は横で取るだけで、呼び手が受け取る約束はそのまま、記録が失敗しても
 * 知らせは出る。包めない相手（凍結された物）なら、元のまま諦める。
 */

interface Shown {
  name: string;
  args: unknown[];
}

function fakeWindow(answer: unknown = undefined): {
  target: NoticeTarget;
  shown: Shown[];
  promises: Promise<unknown>[];
} {
  const shown: Shown[] = [];
  const promises: Promise<unknown>[] = [];
  const make = (name: string) => (...args: unknown[]): Promise<unknown> => {
    shown.push({ name, args });
    const promise = Promise.resolve(answer);
    promises.push(promise);
    return promise;
  };
  return {
    target: {
      showInformationMessage: make("info"),
      showWarningMessage: make("warning"),
      showErrorMessage: make("error"),
    },
    shown,
    promises,
  };
}

describe("包む（wrapNoticeFunctions）", () => {
  it("3つとも包み、元の関数をそのまま呼んで、返った約束をそのまま返す", () => {
    const { target, shown, promises } = fakeWindow();
    const calls: NoticeCall[] = [];
    const result = wrapNoticeFunctions(target, (call) => calls.push(call));
    expect(result.installed).toBe(true);

    const returned = target.showWarningMessage("消しますか", "消す");
    expect(shown).toEqual([{ name: "warning", args: ["消しますか", "消す"] }]);
    // **呼び手が受け取る約束は、元の関数が返したものと同じ物**
    expect(returned).toBe(promises[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].severity).toBe("warning");
    expect(calls[0].args).toEqual(["消しますか", "消す"]);

    target.showInformationMessage("a");
    target.showErrorMessage("b");
    expect(calls.map((call) => call.severity)).toEqual(["warning", "info", "error"]);
  });

  it("記録が投げても、知らせは出て約束も返る", () => {
    const { target, shown, promises } = fakeWindow();
    wrapNoticeFunctions(target, () => {
      throw new Error("記録の失敗");
    });
    const returned = target.showErrorMessage("失敗しました");
    expect(shown).toHaveLength(1);
    expect(returned).toBe(promises[0]);
  });

  it("元へ戻せる", () => {
    const { target } = fakeWindow();
    const originals = NOTICE_FUNCTION_NAMES.map((name) => target[name]);
    const result = wrapNoticeFunctions(target, () => undefined);
    expect(result.installed).toBe(true);
    if (result.installed) result.restore();
    expect(NOTICE_FUNCTION_NAMES.map((name) => target[name])).toEqual(originals);
  });

  it("凍結された物は包めない。投げずに諦め、元のまま残す", () => {
    const { target } = fakeWindow();
    const originals = NOTICE_FUNCTION_NAMES.map((name) => target[name]);
    Object.freeze(target);
    const result = wrapNoticeFunctions(target, () => undefined);
    expect(result.installed).toBe(false);
    expect(NOTICE_FUNCTION_NAMES.map((name) => target[name])).toEqual(originals);
  });

  it("1つだけ書き換えられない物なら、ほかも元へ戻して諦める（種類で記録が欠けない）", () => {
    const { target } = fakeWindow();
    const originals = NOTICE_FUNCTION_NAMES.map((name) => target[name]);
    Object.defineProperty(target, "showErrorMessage", {
      value: target.showErrorMessage,
      writable: false,
    });
    const result = wrapNoticeFunctions(target, () => undefined);
    expect(result.installed).toBe(false);
    expect(NOTICE_FUNCTION_NAMES.map((name) => target[name])).toEqual(originals);
  });
});

describe("溜める箱（NoticeBuffer）", () => {
  const clock = (): Date => new Date("2026-09-24T10:00:00.000Z");

  it("出した知らせと、押されたボタンを残す", async () => {
    const { target } = fakeWindow("消す");
    const buffer = new NoticeBuffer(redactSecrets, clock);
    wrapNoticeFunctions(target, (call) => {
      const seq = buffer.add(call);
      void Promise.resolve(call.result).then((value) => buffer.answer(seq, value));
    });
    await target.showWarningMessage("消しますか", { modal: true }, "消す", "やめる");
    await Promise.resolve();

    expect(buffer.snapshot()).toEqual([
      {
        seq: 1,
        at: "2026-09-24T10:00:00.000Z",
        severity: "warning",
        modal: true,
        message: "消しますか",
        detail: null,
        items: ["消す", "やめる"],
        truncated: false,
        answer: { at: "2026-09-24T10:00:00.000Z", choice: "消す" },
      },
    ]);
  });

  it("閉じられるまでは answer が null", () => {
    const buffer = new NoticeBuffer(redactSecrets, clock);
    buffer.add({ severity: "info", args: ["保存しました"] });
    expect(buffer.snapshot()[0].answer).toBeNull();
  });

  it("キーらしき文字は伏せ、長い文は切る", () => {
    const buffer = new NoticeBuffer(redactSecrets, clock);
    buffer.add({ severity: "error", args: ["鍵 ghp_abcdefghijklmnopqrstu を読めません"] });
    buffer.add({ severity: "info", args: ["本".repeat(1000)] });
    const [secret, long] = buffer.snapshot();
    expect(secret.message).toBe("鍵 ghp_*** を読めません");
    expect(long.truncated).toBe(true);
    expect(Array.from(long.message).length).toBeLessThanOrEqual(201);
  });

  it("中身を渡しても、箱の中は書き換わらない（書き出し中に答えが来ても混ざらない）", () => {
    const buffer = new NoticeBuffer(redactSecrets, clock);
    const seq = buffer.add({ severity: "info", args: ["x", "はい"] });
    const before = buffer.snapshot();
    buffer.answer(seq, "はい");
    expect(before[0].answer).toBeNull();
    expect(buffer.snapshot()[0].answer?.choice).toBe("はい");
  });
});

describe("拡張機能の入口で包んでいる", () => {
  it("activate の早いうちに startNoticeRecorder を呼ぶ", async () => {
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const source = fs.readFileSync(
      nodePath.join(__dirname, "../../../src/extension.ts"),
      "utf8"
    );
    const activate = source.indexOf("export async function activate(");
    const recorder = source.indexOf("startNoticeRecorder(context)");
    const profile = source.indexOf("startStartupProfile(");
    expect(activate).toBeGreaterThan(-1);
    // **起動の途中の知らせ（フォルダーが見つからない、など）こそ見たい**ので、
    // 起動の重い処理より前で包む
    expect(recorder).toBeGreaterThan(activate);
    expect(recorder).toBeLessThan(profile);
  });
});
