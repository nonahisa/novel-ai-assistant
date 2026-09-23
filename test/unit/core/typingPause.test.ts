import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TypingPause } from "../../../src/core/typingPause";

/**
 * 「打鍵が止まってから1回だけ」の仕掛け（作者の報告、2026-09-23）。
 * 用語の色付け・ステータスバーの字数・資料パネルの追従が共通で使う。
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TypingPause", () => {
  test("打鍵が続くあいだは走らず、止まってから1回だけ走る", () => {
    const run = vi.fn();
    const pause = new TypingPause(run);
    for (let i = 0; i < 20; i++) {
      pause.typed(800);
      vi.advanceTimersByTime(10);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("打鍵中に届いた打鍵以外の知らせも、打鍵が止まるまで待つ", () => {
    const run = vi.fn();
    const pause = new TypingPause(run);
    pause.typed(800);
    vi.advanceTimersByTime(100);
    pause.schedule(150);
    vi.advanceTimersByTime(200);
    // 150ms では走らない（打鍵の 800ms がまだ明けていない）
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("打鍵していなければ、打鍵以外の知らせは短い待ちで走る", () => {
    const run = vi.fn();
    const pause = new TypingPause(run);
    pause.schedule(150);
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("runNow は予約を捨てて、いま1回だけ走らせる", () => {
    const run = vi.fn();
    const pause = new TypingPause(run);
    pause.typed(500);
    pause.runNow();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("捨てたあとは走らない", () => {
    const run = vi.fn();
    const pause = new TypingPause(run);
    pause.typed(500);
    pause.dispose();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
