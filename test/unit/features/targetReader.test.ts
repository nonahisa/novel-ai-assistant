import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 差し替え口はスタブから直に取る（`importWorkFromZip.test.ts` と同じ理由）
import { commands, FileSystemError, window, workspace } from "../support/vscodeStub";
import { runTargetReader } from "../../../src/features/targetReader";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  CHECK_FAILED,
} from "../../../src/core/proofreadingSuite";
import { READER_QUESTIONS } from "../../../src/core/readerTarget";
import { readAimReason, readAimTypes, extractAuthorBlock } from "../../../src/core/targetSheetDoc";
import * as paths from "../../../src/core/paths";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「ターゲット読者」の入口（設計書6.108.6）。
 *
 * 見張るのは設計に書かれた約束だけである。
 *
 * 1. **済んだ段だけでシートを作る**（途中でやめても、それまでの段は残る）
 * 2. **何も済まなければシートも作らない**（やめたつもりが済んだことにならない）
 * 3. **2段目の途中までの答えは残さない**（半端な答えが「前回の答え」になる）
 * 4. **作者が置いた同名のファイルには、狙いも書き込まない**（実装ルール2）
 *
 * AI を使う3段目と適合度は、ここでは通さない（AI の登録を空にしてある。
 * 流れの分かれ目だけを見る）。
 */

const WORK_FOLDER = paths.normalize("c:/小説/鉛の海");
const SETTINGS = paths.join(WORK_FOLDER, "設定");
const SHEET = paths.join(SETTINGS, "ターゲットシート.md");
const PROFILE = paths.join(SETTINGS, "読者像.json");
const HISTORY_DIR = paths.join(SETTINGS, "ターゲットシート", "履歴");

const WORK: WorkEntry = {
  id: "w1",
  title: "鉛の海",
  folderPath: WORK_FOLDER,
  registeredAt: "2026-09-01T00:00:00.000Z",
};

class MemoryFs {
  readonly files = new Map<string, Uint8Array>();

  text(name: string): string | undefined {
    const bytes = this.files.get(name);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  /** 一時ファイルを除いた、置かれたファイルの名前 */
  placed(): string[] {
    return [...this.files.keys()]
      .filter((name) => !name.includes(".novelai-"))
      .sort();
  }

  install(): void {
    workspace.fs = {
      readFile: async (uri: { fsPath: string }) => {
        const bytes = this.files.get(uri.fsPath);
        if (!bytes) throw new FileSystemError(uri.fsPath, "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        this.files.set(uri.fsPath, bytes);
      },
      stat: async (uri: { fsPath: string }) => {
        if (this.files.has(uri.fsPath)) return { type: 1 };
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      },
      createDirectory: async () => undefined,
      readDirectory: async (uri: { fsPath: string }) => {
        const prefix = uri.fsPath + paths.separatorFor(uri.fsPath);
        return [...this.files.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => [name.slice(prefix.length), 1]);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        if (this.files.has(to.fsPath) && !options?.overwrite) {
          throw new FileSystemError(to.fsPath, "FileExists");
        }
        const bytes = this.files.get(from.fsPath);
        if (!bytes) throw new FileSystemError(from.fsPath, "FileNotFound");
        this.files.delete(from.fsPath);
        this.files.set(to.fsPath, bytes);
      },
      delete: async (uri: { fsPath: string }) => {
        this.files.delete(uri.fsPath);
      },
    } as unknown as typeof workspace.fs;
  }
}

type PickItem = Record<string, unknown> & { label: string };
type Answer = (items: PickItem[], options: { canPickMany?: boolean }) => unknown;

const original = {
  fs: workspace.fs,
  showQuickPick: window.showQuickPick,
  showInputBox: window.showInputBox,
  showWarningMessage: window.showWarningMessage,
  executeCommand: commands.executeCommand,
};

let fs: MemoryFs;
let answers: Answer[];
let inputs: Array<string | undefined>;
const warnings: string[] = [];

/** 選択画面の答えを、順に1つずつ返す */
function stubDialogs(): void {
  window.showQuickPick = (async (items: PickItem[], options: { canPickMany?: boolean }) => {
    const next = answers.shift();
    if (!next) throw new Error("想定より多く選択画面が出た");
    return next(items, options ?? {});
  }) as unknown as typeof window.showQuickPick;
  window.showInputBox = (async () => inputs.shift()) as unknown as typeof window.showInputBox;
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as unknown as typeof window.showWarningMessage;
  commands.executeCommand = (async () => undefined) as unknown as typeof commands.executeCommand;
}

/** 入口の選択肢を名前の頭で選ぶ */
function plan(label: string): Answer {
  return (items) => items.find((item) => item.label.startsWith(label));
}
/** 複数選択で、層の名前を選ぶ */
function types(...labels: string[]): Answer {
  return (items) => items.filter((item) => labels.includes(item.label));
}
/** 閉じる（Esc） */
const escape: Answer = () => undefined;
/** 選択肢の頭から n 番目（答えの番号）を選ぶ */
function choice(index: number): Answer {
  return (items) => items[index];
}

const REGISTRY = {} as AIRegistry;
const SOURCES = {};

beforeEach(() => {
  fs = new MemoryFs();
  fs.install();
  answers = [];
  inputs = [];
  warnings.length = 0;
  stubDialogs();
});

afterEach(() => {
  workspace.fs = original.fs;
  window.showQuickPick = original.showQuickPick;
  window.showInputBox = original.showInputBox;
  window.showWarningMessage = original.showWarningMessage;
  commands.executeCommand = original.executeCommand;
});

describe("1段目（狙い）だけ", () => {
  it("選んだ狙いと理由が、シートの作者の欄に入り、推移に1行残る", async () => {
    answers = [plan("1 狙い"), types("考察層", "没入層")];
    inputs = ["伏線を拾ってくれる人に"];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_COMPLETED);
    const block = extractAuthorBlock(fs.text(SHEET) ?? "") ?? "";
    expect(readAimTypes(block)).toEqual(["lore_deep", "deep_pure"]);
    expect(readAimReason(block)).toBe("伏線を拾ってくれる人に");
    // 狙いだけの控え（点数は無い）
    const history = fs.placed().filter((name) => name.startsWith(HISTORY_DIR));
    expect(history).toHaveLength(1);
    // 読者像の台帳には触らない
    expect(fs.text(PROFILE)).toBeUndefined();
  });

  it("3つ選んだら、選び直してもらう（黙って2つに削らない）", async () => {
    answers = [plan("1 狙い"), types("考察層", "没入層", "刺激層"), types("刺激層")];
    inputs = [""];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_COMPLETED);
    expect(warnings.join("\n")).toContain("2つまで");
    const block = extractAuthorBlock(fs.text(SHEET) ?? "") ?? "";
    expect(readAimTypes(block)).toEqual(["crave_pure"]);
  });

  it("作者が手で書いた欄のほかの行は、そのまま残る", async () => {
    fs.files.set(
      SHEET,
      new TextEncoder().encode(
        [
          "<!-- 作者の欄 ここから -->",
          "狙い：刺激層",
          "理由：昔",
          "メモ：第2部で変える",
          "<!-- ここまで -->",
        ].join("\n")
      )
    );
    answers = [plan("1 狙い"), types("すきま層")];
    inputs = ["新しい理由"];

    await runTargetReader(WORK, REGISTRY, SOURCES);

    const block = extractAuthorBlock(fs.text(SHEET) ?? "") ?? "";
    expect(block.split("\n")).toEqual([
      "狙い：すきま層",
      "理由：新しい理由",
      "メモ：第2部で変える",
    ]);
  });
});

describe("途中でやめる", () => {
  it("最初の選択で閉じたら、何も書かない", async () => {
    answers = [escape];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_CANCELLED);
    expect(fs.placed()).toEqual([]);
  });

  it("狙いの選択で閉じたら、シートも作らない（済んだ段が無い）", async () => {
    answers = [plan("1 狙い"), escape];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_CANCELLED);
    expect(fs.placed()).toEqual([]);
  });

  it("3段とも通す途中、2段目の途中で閉じたら、狙いだけのシートを作る", async () => {
    answers = [
      plan("3段とも通す"),
      types("考察層"),
      choice(0),
      choice(1),
      escape, // 2段目の3問目で閉じる
    ];
    inputs = ["理由"];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_COMPLETED);
    expect(readAimTypes(extractAuthorBlock(fs.text(SHEET) ?? "") ?? "")).toEqual([
      "lore_deep",
    ]);
    // **途中まで答えた2段目は残さない**
    expect(fs.text(PROFILE)).toBeUndefined();
    expect(answers).toEqual([]);
  });

  it("理由の窓を閉じたら、狙いは残して先の段へ進まない", async () => {
    answers = [plan("3段とも通す"), types("没入層")];
    inputs = [undefined];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_COMPLETED);
    expect(readAimTypes(extractAuthorBlock(fs.text(SHEET) ?? "") ?? "")).toEqual([
      "deep_pure",
    ]);
    expect(fs.text(PROFILE)).toBeUndefined();
  });
});

describe("2段目（書き方の判断）", () => {
  it("9問すべてに答えると、読者像に残り、シートに一致度が出る", async () => {
    answers = [
      plan("2 書き方の判断"),
      ...READER_QUESTIONS.map(() => choice(2)),
    ];

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_COMPLETED);
    const profile = JSON.parse(fs.text(PROFILE) ?? "{}") as {
      declared?: { answers: number[] };
    };
    expect(profile.declared?.answers).toEqual(READER_QUESTIONS.map(() => 2));
    expect(fs.text(SHEET)).toContain("| 読者層 | 一致度 | どんな読者か |");
  });
});

describe("作者が置いた同名のファイル", () => {
  it("印の無い ターゲットシート.md には、狙いも書き込まない", async () => {
    const own = "自分で書いたメモ。狙い：考察層";
    fs.files.set(SHEET, new TextEncoder().encode(own));

    const outcome = await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(outcome).toBe(CHECK_FAILED);
    expect(fs.text(SHEET)).toBe(own);
    // 選ばせる前に止める（答えさせてから捨てない）
    expect(answers).toEqual([]);
  });
});

/**
 * **3つの輪は、シートの中の節に一本化した**（作者の裁定、2026-09-23
 * 「ターゲットシートと3つの輪は完全統合」）。単独の3つの輪の紙を作る道は
 * もう無い——入口の選択肢にも出さない。
 */
describe("3つの輪はシートの中だけ", () => {
  it("入口の選択肢に「3つの輪の紙を開く」が無い", async () => {
    let labels: string[] = [];
    answers = [
      (items) => {
        labels = items.map((item) => item.label);
        return undefined;
      },
    ];

    await runTargetReader(WORK, REGISTRY, SOURCES);

    expect(labels.some((label) => label.includes("3つの輪"))).toBe(false);
    // シートを作り直す道は残る（3つの輪の節はそちらに入る）
    expect(labels).toContain("いまの材料でシートを作り直す");
  });
});
