import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import {
  registerEpisodeTimeline,
  TIMELINE_REFRESH_DELAY_MS,
} from "../../../src/features/episodeTimeline";
import { notifyWorkRecordWritten } from "../../../src/core/workRecordSignal";

/**
 * タイムラインの欄の登録（設計書6.119）。
 *
 * - **設定が有効のときだけ**登録し、切り替えたら再起動なしで登録・解除する
 * - 口が無い版（1.145 より前）では何もしない
 * - 口が在っても呼ぶと断る版（正式になる前）でも、起動を止めない
 */

type Listener = (event: { affectsConfiguration(section: string): boolean }) => void;

const workspace = vscode.workspace as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const keys = ["getConfiguration", "onDidChangeConfiguration", "registerTimelineProvider"];

let show = false;
let listeners: Listener[] = [];
let registered = 0;
let lastArgs: unknown[] = [];
let disposed = 0;

function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscode.ExtensionContext;
}

function flip(value: boolean): void {
  show = value;
  for (const listener of listeners) {
    listener({ affectsConfiguration: (section) => section === "novelai.timeline.show" });
  }
}

beforeEach(() => {
  for (const key of keys) saved[key] = workspace[key];
  show = false;
  listeners = [];
  registered = 0;
  disposed = 0;
  workspace.getConfiguration = () => ({
    get: <T>(key: string, fallback: T): T => (key === "timeline.show" ? (show as T) : fallback),
  });
  workspace.onDidChangeConfiguration = (listener: Listener) => {
    listeners.push(listener);
    return { dispose() {} };
  };
  workspace.registerTimelineProvider = (...args: unknown[]) => {
    registered += 1;
    lastArgs = args;
    return { dispose: () => { disposed += 1; } };
  };
});

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete workspace[key];
    else workspace[key] = saved[key];
  }
});

describe("タイムラインの欄の登録", () => {
  test("既定（出さない）では登録しない。有効にすると登録し、戻すと外す", () => {
    registerEpisodeTimeline(fakeContext(), () => undefined);
    expect(registered).toBe(0);

    flip(true);
    expect(registered).toBe(1);
    // 同じ値で知らせが来ても二重に登録しない
    flip(true);
    expect(registered).toBe(1);

    flip(false);
    expect(disposed).toBe(1);
  });

  test("正式な口（1.145）の形で呼ぶ：id・名前・場所の仕組み・提供役の4つ。変わったら onDidChangeTimeline で知らせる", () => {
    // 提案中の頃の (scheme, provider) で呼ぶと、1.145 では断られて欄に何も出なかった（画面テスト episodeTimelineFollow）
    show = true;
    registerEpisodeTimeline(fakeContext(), () => undefined);
    expect(registered).toBe(1);
    expect(lastArgs).toHaveLength(4);
    expect(typeof lastArgs[0]).toBe("string");
    expect(typeof lastArgs[1]).toBe("string");
    expect(lastArgs[2]).toEqual(["file", "vscode-vfs"]);
    const provider = lastArgs[3] as { provideTimeline?: unknown; onDidChangeTimeline?: unknown };
    expect(typeof provider.provideTimeline).toBe("function");
    expect(typeof provider.onDidChangeTimeline).toBe("function");
  });

  test("製品が記録や本文を書いたら（保存を通らなくても）、少し待って1回だけ欄を読み直させる", () => {
    // 提案パネルの［適用］は workspace.fs で書くので保存の知らせが来ず、欄が古いまま残っていた
    vi.useFakeTimers();
    try {
      show = true;
      const context = fakeContext();
      registerEpisodeTimeline(context, () => undefined);
      const provider = lastArgs[3] as {
        onDidChangeTimeline: (listener: (uri: unknown) => void) => { dispose(): void };
      };
      const fired: unknown[] = [];
      provider.onDidChangeTimeline((uri) => fired.push(uri));

      // ［適用］1回で、本文・編集履歴・操作ログ・置き場の4つが続けて書かれる
      notifyWorkRecordWritten("C:/作品/本文/第1話.txt");
      notifyWorkRecordWritten("C:/作品/.aiwriter/history/edits.jsonl");
      notifyWorkRecordWritten("C:/作品/.aiwriter/logs/ai_actions.log");
      notifyWorkRecordWritten("C:/作品/.aiwriter/findings.jsonl");
      expect(fired).toHaveLength(0);
      vi.advanceTimersByTime(TIMELINE_REFRESH_DELAY_MS);
      expect(fired).toHaveLength(1);
      // どの話の記録かは書き方が混ざっている（相対・名前だけ・絶対）ので、全部を読み直させる
      expect(fired[0]).toBeUndefined();

      // 欄を出さない設定にしたら、知らせない
      flip(false);
      notifyWorkRecordWritten("C:/作品/本文/第1話.txt");
      vi.advanceTimersByTime(TIMELINE_REFRESH_DELAY_MS);
      expect(fired).toHaveLength(1);

      for (const subscription of context.subscriptions) subscription.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("口が無い版では何もしない", () => {
    delete workspace.registerTimelineProvider;
    show = true;
    expect(() => registerEpisodeTimeline(fakeContext(), () => undefined)).not.toThrow();
    expect(registered).toBe(0);
  });

  test("口が呼ぶと断る版でも、起動を止めない", () => {
    workspace.registerTimelineProvider = () => {
      throw new Error("CANNOT use API proposal: timeline");
    };
    show = true;
    expect(() => registerEpisodeTimeline(fakeContext(), () => undefined)).not.toThrow();
  });
});
