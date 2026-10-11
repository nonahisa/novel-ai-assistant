import { beforeEach, describe, expect, test, vi } from "vitest";
import { env, window, workspace } from "../support/vscodeStub";

/**
 * 「LM Studioの導入」の案内（設計書6.16・6.24。実機確認リストの LM Studio の節
 * 「未起動→起動→モデル読み込み→AI選択まで通しで案内するか」「Context Length 合わせの
 * 入力が出て、設定に反映されるか」「wingetの無い環境相当でも、配布ページを開く道が
 * あるか」。2026-10-11 作者の指示「機械でできる実機確認」）。
 *
 * LM Studio そのもの（接続・`lms`・winget）は作り物にし、**案内の順番と、
 * 作者の答えで次にどこへ進むか**を見る。LM Studio の本物の画面・本物の読み込みは
 * 実機に残る（ここでは見ない）。
 */

const lm = vi.hoisted(() => ({
  /** 接続確認を呼ぶたびに、先頭から1つずつ返す */
  connections: [] as Array<{ ok: boolean; message: string; modelCount?: number }>,
  loadedContext: undefined as number | undefined,
  cli: undefined as string | undefined,
  packageManager: undefined as string | undefined,
  setupWizard: vi.fn(async () => undefined),
  askText: vi.fn(async (_options: { value?: string }) => undefined as string | undefined),
}));

vi.mock("../../../src/ai/lmstudioProvider", () => ({
  lmstudioEndpoint: () => "http://localhost:1234",
  LmStudioProvider: class {
    async testConnection() {
      const next = lm.connections.shift();
      if (!next) throw new Error("接続確認の台本が尽きました（案内が終わらずに回っています）");
      return next;
    }
    async readLoadedContextWindow() {
      return lm.loadedContext;
    }
  },
}));

vi.mock("../../../src/ai/lmstudioLauncher", () => ({
  describeStartFailure: () => "起動できませんでした",
  isLocalEndpoint: () => true,
  resolveCli: async () => lm.cli,
  startLmStudioServer: async () => ({ ok: true }),
}));

vi.mock("../../../src/ai/registry", () => ({
  AIRegistry: class {},
  runSetupWizard: lm.setupWizard,
}));

vi.mock("../../../src/core/packageInstall", () => ({
  detectPackageManager: async () => lm.packageManager,
  installPackage: async () => ({ kind: "installed" }),
  shortenProgress: (line: string) => line,
}));

vi.mock("../../../src/core/runtime", () => ({
  canRunProcesses: () => true,
}));

vi.mock("../../../src/views/dialogs", () => ({
  askText: lm.askText,
}));

const { setupLmStudio } = await import("../../../src/features/setupLmStudio");

/** 出た知らせ（本文と、並んだボタン） */
let shown: Array<{ message: string; buttons: string[] }> = [];
/** 知らせの本文の一部 → 押すボタン。当たらなければ閉じる */
let answers: Array<[string, string]> = [];
/** 設定へ書いたもの */
let updated: Array<{ key: string; value: unknown; global: unknown }> = [];

beforeEach(() => {
  shown = [];
  answers = [];
  updated = [];
  env.opened.length = 0;
  lm.connections = [];
  lm.loadedContext = undefined;
  lm.cli = undefined;
  lm.packageManager = undefined;
  lm.setupWizard.mockClear();
  lm.askText.mockReset();
  lm.askText.mockImplementation(async () => undefined);

  window.showInformationMessage = (async (message: string, ...rest: unknown[]) => {
    const buttons = rest.filter((item): item is string => typeof item === "string");
    shown.push({ message, buttons });
    return answers.find(([part]) => message.includes(part))?.[1];
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = (async (message: string) => {
    shown.push({ message, buttons: [] });
    return undefined;
  }) as typeof window.showWarningMessage;
  window.withProgress = (async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
    task({ report: () => undefined }, { isCancellationRequested: false })) as typeof window.withProgress;
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
    update: async (key: string, value: unknown, global: unknown) => {
      updated.push({ key, value, global });
    },
  })) as unknown as typeof workspace.getConfiguration;
});

describe("LM Studioの導入の案内", () => {
  test("未起動 → 入れる道 → 起動の案内 → モデル読み込みの案内 → 長さ合わせ → AI選択まで、通しで進む", async () => {
    lm.connections = [
      { ok: false, message: "接続できません" },
      { ok: true, message: "LM Studioに接続できました。", modelCount: 0 },
      { ok: true, message: "LM Studioに接続できました。", modelCount: 1 },
    ];
    lm.loadedContext = 32768;
    lm.askText.mockImplementation(async (options) => options.value);
    answers = [
      ["まだ入れていなければ", "配布ページを開く"],
      ["ローカルサーバーを開始", "もう一度確かめる"],
      ["モデルが読み込まれていません", "もう一度確かめる"],
      ["このままLM Studioを使う設定にしますか", "設定する"],
    ];

    await setupLmStudio({} as never);

    const order = shown.map((entry) => entry.message);
    const at = (part: string) => order.findIndex((message) => message.includes(part));
    expect(at("まだ入れていなければ")).toBeGreaterThanOrEqual(0);
    expect(at("ローカルサーバーを開始")).toBeGreaterThan(at("まだ入れていなければ"));
    expect(at("モデルが読み込まれていません")).toBeGreaterThan(at("ローカルサーバーを開始"));
    expect(at("このままLM Studioを使う設定にしますか")).toBeGreaterThan(
      at("モデルが読み込まれていません")
    );
    // 長さ合わせを訊いてから、AIの選択へ進む
    expect(lm.askText).toHaveBeenCalledTimes(1);
    expect(lm.setupWizard).toHaveBeenCalledTimes(1);
  });

  test("Context Length の入力が出て、LM Studioが読み込んだ長さが初期値になり、答えた値が機械全体の設定に入る", async () => {
    lm.connections = [{ ok: true, message: "LM Studioに接続できました。", modelCount: 1 }];
    lm.loadedContext = 32768;
    lm.askText.mockImplementation(async () => "16384");

    await setupLmStudio({} as never);

    expect(lm.askText).toHaveBeenCalledTimes(1);
    const options = lm.askText.mock.calls[0][0] as { title?: string; value?: string };
    expect(options.title).toBe("LM Studioのコンテキスト長");
    expect(options.value).toBe("32768");
    expect(updated).toEqual([{ key: "lmstudio.contextWindow", value: 16384, global: true }]);
  });

  test("wingetが無い環境では「wingetで入れる」を出さず、「配布ページを開く」で配布ページが開く", async () => {
    lm.packageManager = undefined;
    lm.connections = [{ ok: false, message: "接続できません" }];
    answers = [["まだ入れていなければ", "配布ページを開く"]];

    await setupLmStudio({} as never);

    const offer = shown.find((entry) => entry.message.includes("まだ入れていなければ"));
    expect(offer?.buttons).toEqual(["配布ページを開く", "閉じる"]);
    expect(env.opened).toEqual(["https://lmstudio.ai/"]);
  });

  test("wingetがある環境では、「wingetで入れる」も並ぶ（配布ページの道は残る）", async () => {
    lm.packageManager = "winget";
    lm.connections = [{ ok: false, message: "接続できません" }];

    await setupLmStudio({} as never);

    const offer = shown.find((entry) => entry.message.includes("まだ入れていなければ"));
    expect(offer?.buttons).toEqual(["wingetで入れる", "配布ページを開く", "閉じる"]);
  });
});
