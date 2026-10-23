import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import { startLocalAiGate } from "../../../src/features/localAiGate";
import { localAiGate } from "../../../src/core/localAiGate";
import { AiQueueAbortError, resetAiSequence } from "../../../src/core/aiSequence";
import { serializeLease } from "../../../src/core/localAiLease";

/**
 * 単発の送信が別の窓を待つときの、ステータスバーの表示（作者の裁定「題を短くする」、
 * 2026-10-23）。
 *
 * 題と本文に同じ文を渡していたので、「別の窓（書庫）の「誤字脱字の検知」の完了を
 * 待っています: 別の窓（書庫）の「誤字脱字の検知」の完了を待っています…」と
 * 同じ文が2回並んでいた。題は「手元のAIの順番待ち」、本文に待ちの文を1回だけ出す。
 */

let storage: string;
let dispose: (() => void) | undefined;

const request = { providerId: "gemini", model: "m" };

beforeEach(async () => {
  resetAiSequence();
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-gate-wait-"));
  const handle = startLocalAiGate({ globalStorageUri: vscode.Uri.file(storage) } as never);
  dispose = handle ? () => handle.dispose() : undefined;
  // 門を1回通して、Node の部品が読み込まれるのを待つ
  const leave = await localAiGate()!.enter(request);
  leave();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

afterEach(() => {
  vi.restoreAllMocks();
  dispose?.();
  resetAiSequence();
  fs.rmSync(storage, { recursive: true, force: true });
});

describe("単発の順番待ちの表示", () => {
  test("題は「手元のAIの順番待ち」で、待ちの文は本文に1回だけ出る", async () => {
    // 別の窓（書庫）が送信の札を持っている。単発は送信の札を待つ
    fs.mkdirSync(path.join(storage, "local-ai"), { recursive: true });
    fs.writeFileSync(
      path.join(storage, "local-ai", "lease.json"),
      serializeLease({
        version: 1,
        token: "other-window",
        pid: process.pid,
        host: "extension",
        windowName: "書庫",
        label: "誤字脱字の検知",
        startedAt: new Date().toISOString(),
      })
    );

    const titles: string[] = [];
    const messages: string[] = [];
    vi.spyOn(vscode.window, "withProgress").mockImplementation(((
      options: { title?: string },
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean; onCancellationRequested(fn: () => void): void }
      ) => Thenable<unknown>
    ) => {
      titles.push(options.title ?? "");
      return task(
        { report: (value) => messages.push(value.message ?? "") },
        { isCancellationRequested: false, onCancellationRequested: () => undefined }
      );
    }) as never);

    const controller = new AbortController();
    const waiting = localAiGate()!.enter({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0), { timeout: 2000 });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AiQueueAbortError);

    expect(titles).toEqual(["手元のAIの順番待ち"]);
    const waitText = "別の窓（書庫）の「誤字脱字の検知」の完了を待っています…";
    expect(messages[0]).toBe(waitText);
    // 題と本文を並べても、待ちの文は1回しか出ない
    const shown = `${titles[0]}: ${messages[0]}`;
    expect(shown.split("の完了を待っています").length - 1).toBe(1);
  });
});
