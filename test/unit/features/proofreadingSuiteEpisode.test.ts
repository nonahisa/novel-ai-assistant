import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, window } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import {
  runProofreadingSuite,
  type SelectionMemento,
} from "../../../src/features/proofreadingSuite";
import {
  PROOFREADING_EPISODE_SELECTION_KEY,
  PROOFREADING_SUITE_SELECTION_KEY,
} from "../../../src/core/proofreadingSuite";

/**
 * 原稿エディターの［校正］→「この話を校正」と Ctrl+Alt+A（作者の答え 2026-11-27
 * 「そう。この話だけにしたい」。設計書6.25・6.80）。
 *
 * **選んだ校正を、押した話の範囲だけで回す。** 作品全体のまとめ実行
 * （詳細メニュー・手順の案内から呼ぶ道）は今までどおり作品全体で回る——そちらは
 * `proofreadingSuiteRun.test.ts` が見張る（このファイルを足しても1文字も変えない）。
 */

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const EPISODE = "C:/works/試しの作品/本文/003.txt";

interface OfferedItem {
  label: string;
  id: string;
  picked?: boolean;
}

let calls: { command: string; args: unknown[] }[] = [];
let offered: OfferedItem[] = [];
let pickTitle = "";
let selection: string[] | undefined;
let confirmed: string[] = [];
let savedKeys: string[] = [];
let readKeys: string[] = [];

const stub = window as unknown as Record<string, unknown>;
const originalWithProgress = stub.withProgress;
const originalShowQuickPick = stub.showQuickPick;

function memento(stored: Record<string, unknown> = {}): SelectionMemento {
  return {
    get: <T,>(key: string, defaultValue: T): T => {
      readKeys.push(key);
      return key in stored ? (stored[key] as T) : defaultValue;
    },
    update: async (key: string) => {
      savedKeys.push(key);
    },
  };
}

async function runEpisode(stored?: Record<string, unknown>): Promise<void> {
  await runProofreadingSuite(work, {
    memento: memento(stored),
    remainingIn: () => 0,
    estimate: async () => ({
      totalChars: 3200,
      chunkCount: 1,
      providerNames: ["Ollama"],
      isPaid: false,
    }),
    episodeFile: EPISODE,
  });
}

beforeEach(() => {
  calls = [];
  offered = [];
  pickTitle = "";
  selection = undefined;
  confirmed = [];
  savedKeys = [];
  readKeys = [];
  stub.withProgress = async (
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ) => task({ report: () => undefined }, undefined);
  stub.showQuickPick = async (items: OfferedItem[], options?: { title?: string }) => {
    offered = items;
    pickTitle = options?.title ?? "";
    if (selection === undefined) return undefined;
    return items.filter((item) => selection?.includes(item.id));
  };
  Object.assign(commands, {
    executeCommand: async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      return undefined;
    },
  });
  window.showInformationMessage = (async (message: string, options?: unknown) => {
    if (options !== null && typeof options === "object" && "modal" in (options as object)) {
      confirmed.push(`${message}\n${(options as { detail?: string }).detail ?? ""}`);
      return "実行";
    }
    return undefined;
  }) as typeof window.showInformationMessage;
});

afterEach(() => {
  stub.withProgress = originalWithProgress;
  stub.showQuickPick = originalShowQuickPick;
});

describe("並べる校正", () => {
  test("話1つに絞れるもの（誤字脱字・推敲・プロット逸脱・矛盾）だけを並べ、表記ゆれは並べない", async () => {
    selection = [];
    await runEpisode();
    expect(offered.map((item) => item.id)).toEqual([
      "typos",
      "proofread",
      "deviations",
      "contradictions",
    ]);
  });

  test("控えが無ければ、作品全体の既定から表記ゆれを抜いた3つが選ばれている", async () => {
    selection = [];
    await runEpisode();
    expect(offered.filter((item) => item.picked).map((item) => item.id)).toEqual([
      "typos",
      "proofread",
      "contradictions",
    ]);
  });

  test("選ぶ画面の題で、どの話かが分かる", async () => {
    selection = [];
    await runEpisode();
    expect(pickTitle).toBe("この話を校正：003.txt");
  });
});

describe("押した話の範囲だけで回す", () => {
  test("各校正へ、作品と「この話」を渡す（作品全体で回さない）", async () => {
    selection = ["typos", "proofread", "deviations", "contradictions"];
    await runEpisode();
    expect(calls.map((call) => call.command)).toEqual([
      "novelai.checkTypos",
      "novelai.checkProofread",
      "novelai.checkDeviations",
      "novelai.checkContradictions",
    ]);
    for (const call of calls) {
      expect(call.args[0]).toEqual({ type: "work", work });
      expect(call.args[1]).toEqual({
        suite: { confirmed: true, holdsRun: true, onlyFile: EPISODE },
      });
    }
  });

  test("前回の控えに表記ゆれが残っていても、表記ゆれは走らせない", async () => {
    selection = ["notation", "typos"];
    await runEpisode({ [PROOFREADING_EPISODE_SELECTION_KEY]: ["notation", "typos"] });
    expect(calls.map((call) => call.command)).toEqual(["novelai.checkTypos"]);
  });

  test("量と料金の確認は1回だけで、どの話かを名乗る", async () => {
    selection = ["typos"];
    await runEpisode();
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain("試しの作品 の「003.txt」を校正します。");
  });
});

describe("前回の選択の控え", () => {
  test("作品全体の道とは別の鍵で読み書きする（表記ゆれが作品全体の控えから落ちない）", async () => {
    selection = ["typos"];
    await runEpisode();
    expect(readKeys).toEqual([PROOFREADING_EPISODE_SELECTION_KEY]);
    expect(savedKeys).toEqual([PROOFREADING_EPISODE_SELECTION_KEY]);
    expect(savedKeys).not.toContain(PROOFREADING_SUITE_SELECTION_KEY);
  });
});
