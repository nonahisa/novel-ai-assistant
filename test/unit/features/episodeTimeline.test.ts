import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as vscode from "vscode";
import { registerEpisodeTimeline } from "../../../src/features/episodeTimeline";

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
  workspace.registerTimelineProvider = () => {
    registered += 1;
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
