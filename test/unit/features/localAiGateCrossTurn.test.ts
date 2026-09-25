import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Uri } from "vscode";
import { startLocalAiGate } from "../../../src/features/localAiGate";
import { localAiGate } from "../../../src/core/localAiGate";
import {
  AiQueueAbortError,
  acquireRun,
  resetAiSequence,
  runScopeAvailable,
  withinRunScope,
} from "../../../src/core/aiSequence";
import { parseLease, serializeLease } from "../../../src/core/localAiLease";

/**
 * 拡張機能の門（`features/localAiGate.ts`）が、**一括処理の1チャンクと単発を
 * 見分けて**2段の札を取ること（設計書6.76.1 の追記、作者の裁定 2026-09-25 午前）。
 *
 * - 一括処理の本体（`aiTurn.ts` が印を持たせた流れ）からの送信は、まとまりの札
 *   （`run.json`）を取り、送り終えても一括処理のあいだは持ち続ける
 * - 印の無い送信（相談など）は、送信の札（`lease.json`）だけを取る。**同じ窓で
 *   一括処理が札を持っている最中でも**単発として扱う（0.86.13 はここを
 *   一括処理と取り違えていた）
 * - 別の窓の一括処理がまとまりの札を持っていても、単発は待たない。
 *   一括処理は待つ
 *
 * 宛先は `gemini` にして、管理外の負荷の測定（nvidia-smi）を走らせない
 * （門は「この機械へ送るか」で測るかを決める。この機械の GPU で結果を変えない）。
 */

let storage: string;
let dispose: (() => void) | undefined;

function file(name: string): string {
  return path.join(storage, "local-ai", name);
}

function otherWindowHolds(name: string, label: string): void {
  fs.mkdirSync(path.join(storage, "local-ai"), { recursive: true });
  fs.writeFileSync(
    file(name),
    serializeLease({
      version: 1,
      token: "other-window",
      pid: process.pid,
      host: "extension",
      windowName: "作品B",
      label,
      startedAt: new Date().toISOString(),
    })
  );
}

const request = { providerId: "gemini", model: "m" };

beforeEach(async () => {
  resetAiSequence();
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-gate-"));
  const handle = startLocalAiGate({ globalStorageUri: Uri.file(storage) } as never);
  dispose = handle ? () => handle.dispose() : undefined;
  // 門を1回通して、Node の部品（印の仕組み）が読み込まれるのを待つ
  const leave = await localAiGate()!.enter(request);
  leave();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

afterEach(() => {
  dispose?.();
  resetAiSequence();
  fs.rmSync(storage, { recursive: true, force: true });
});

describe("一括処理の1チャンクと単発を見分ける", () => {
  test("門が起きると、一括処理の中かを運ぶ仕組みが入る", () => {
    expect(runScopeAvailable()).toBe(true);
  });

  test("一括処理の中の送信は、まとまりの札を取り、一括処理のあいだ持ち続ける", async () => {
    const releaseRun = await acquireRun("誤字脱字の検知");
    await withinRunScope("誤字脱字の検知", async () => {
      const leave = await localAiGate()!.enter(request);
      expect(parseLease(fs.readFileSync(file("run.json"), "utf8"))?.label).toBe(
        "誤字脱字の検知"
      );
      leave();
    });
    // チャンクの合間：送信の札は離し、まとまりの札は持っている。
    // 札の片づけは非同期なので、決め打ちの待ち時間ではなく消えるまで見に行く
    // （20ミリ秒の決め打ちは、ほかの検査と並んで重いときに間に合わず揺れた）
    await vi.waitFor(() => expect(fs.existsSync(file("lease.json"))).toBe(false), {
      timeout: 2000,
    });
    expect(fs.existsSync(file("run.json"))).toBe(true);
    releaseRun();
    localAiGate()!.runEnded();
    await vi.waitFor(() => expect(fs.existsSync(file("run.json"))).toBe(false), {
      timeout: 2000,
    });
  });

  test("同じ窓で一括処理が札を持っている最中の相談は、単発として扱う（まとまりの札を取らない）", async () => {
    // 別の窓の一括処理がまとまりの札を持っている。同じ窓でも一括処理が札（6.76）を持っている
    otherWindowHolds("run.json", "推敲");
    const releaseRun = await acquireRun("誤字脱字の検知");
    try {
      // 印の外（画面から押された相談）
      const leave = await localAiGate()!.enter(request);
      // 待たずに送れた。相手のまとまりの札はそのまま
      expect(parseLease(fs.readFileSync(file("run.json"), "utf8"))?.token).toBe("other-window");
      leave();
    } finally {
      releaseRun();
    }
  });

  test("別の窓の一括処理がまとまりの札を持っていれば、一括処理は待つ（中止できる）", async () => {
    otherWindowHolds("run.json", "推敲");
    const releaseRun = await acquireRun("誤字脱字の検知");
    const controller = new AbortController();
    let entered = false;
    const waiting = withinRunScope("誤字脱字の検知", () =>
      localAiGate()!
        .enter({ ...request, signal: controller.signal })
        .then((leave) => {
          entered = true;
          leave();
        })
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(entered).toBe(false);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AiQueueAbortError);
    expect(parseLease(fs.readFileSync(file("run.json"), "utf8"))?.token).toBe("other-window");
    releaseRun();
  });
});
