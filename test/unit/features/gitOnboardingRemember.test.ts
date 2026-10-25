import { beforeEach, describe, expect, test, vi } from "vitest";

/*
  GitHub 送信の準備（VS Code のアカウントで新しくリポジトリを作る道）で、認証情報を git 側へ覚えられたか
  （`rememberGithubCredential` の結果）によって、**作ったあとの知らせと操作ログが分かれる**ところを見る。

  実機確認リスト「覚えられなかった場合、その旨のお知らせが出るか」。覚えられないのは本物の機械では起こしにくい
  （認証情報の置き場が使えない端末）ので、`rememberGithubCredential` が false を返す形を作って見る。
  2026-10-26 の裁定で、作る確認と1回目の送信の確認を1つにまとめたので、作ったあとそのまま送る。
  知らせも「作って送った」1つになった。

  - 覚えられた：知らせは「非公開のリポジトリ … を作り、… を GitHub へ送りました。」だけ
  - 覚えられなかった：同じ知らせに「（この端末では認証情報を覚えられませんでした。送信のときに一度聞かれることがあります）」が付く
  - 操作ログ（`logStep`）は、どちらも「認証情報の記憶: 成功／できず」で終わる
*/
const remember = vi.fn<(token: string, url: string, folder: string) => Promise<boolean>>();
const logStep = vi.fn<(line: string) => void>();

vi.mock("../../../src/core/gitSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/gitSetup")>();
  return {
    ...actual,
    ghAvailable: async () => false,
    ensureGithubAuthToken: async () => "テスト用の合言葉",
    hasGithubSession: async () => true,
    // 名前は訊かなくなった（2026-10-26）。作った名前は作成の結果から知らせへ出る
    createGithubRepositoryWithFreeName: async () => ({ ok: true, cloneUrl: "https://github.com/example/novel-test.git", name: "novel-test", isPrivate: true, detail: "" }),
    hasCommits: async () => true,
    currentBranch: async () => "main",
    pushSetUpstream: async () => ({ ok: true }),
    addRemote: async () => ({ ok: true, detail: "" }),
    rememberGithubCredential: (token: string, url: string, folder: string) => remember(token, url, folder),
  };
});
vi.mock("../../../src/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/logger")>();
  return { ...actual, logStep: (line: string) => logStep(line), logFailure: () => undefined };
});
vi.mock("../../../src/features/syncLog", () => ({ useSyncLog: async () => undefined }));
vi.mock("../../../src/views/progress", () => ({ withProgress: async (_title: string, work: () => Promise<unknown>) => work() }));
vi.mock("../../../src/views/dialogs", () => ({ askText: async () => "novel-test", cancelItem: () => ({ label: "取りやめる" }) }));

import * as vscode from "vscode";
import { runSetupStep } from "../../../src/features/gitOnboarding";
import type { GitSyncStatus } from "../../../src/core/git";
import type { SyncTarget } from "../../../src/core/syncTarget";

const infoMessages: string[] = [];
const noRun = async () => ({ ok: true, stdout: "", stderr: "", code: 0 });

function target(): SyncTarget {
  return { folderPath: "/tmp/library", label: "書庫", works: [{ title: "作品", folderPath: "/tmp/library/作品" }] } as unknown as SyncTarget;
}

beforeEach(() => {
  remember.mockReset();
  logStep.mockReset();
  infoMessages.length = 0;
  const window = vscode.window as unknown as {
    showQuickPick: (items: Array<{ action?: string }>) => Promise<unknown>;
    showInformationMessage: (message: string) => Promise<undefined>;
    showWarningMessage: (message: string, ...rest: unknown[]) => Promise<string | undefined>;
  };
  // まとめた確認（作って送る）は押す
  window.showWarningMessage = async () => "作って送る";
  // 送り先は「VS Code のアカウントで新しく作る」を選ぶ
  window.showQuickPick = async (items) => items.find((item) => item.action === "vscodeAuth");
  window.showInformationMessage = async (message: string) => {
    infoMessages.push(message);
    return undefined;
  };
});

async function runNoRemote(): Promise<boolean> {
  const status = { kind: "no_remote" } as GitSyncStatus;
  return runSetupStep(target(), status, noRun as never);
}

describe("リポジトリを作ったあとの、認証情報の記憶の知らせ", () => {
  test("覚えられたときは、「覚えられませんでした」の一文が付かず、操作ログは「成功」で終わる", async () => {
    remember.mockResolvedValue(true);
    const advanced = await runNoRemote();
    expect(advanced).toBe(true);
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toContain("非公開のリポジトリ novel-test を作り、書庫 を GitHub へ送りました。");
    expect(infoMessages[0]).not.toContain("覚えられませんでした");
    expect(logStep.mock.calls.map((call) => call[0]).join("\n")).toContain("認証情報の記憶: 成功");
  });

  test("覚えられなかったときは、同じ知らせに「この端末では認証情報を覚えられませんでした。送信のときに一度聞かれることがあります」が付き、操作ログは「できず」で終わる", async () => {
    remember.mockResolvedValue(false);
    const advanced = await runNoRemote();
    expect(advanced, "覚えられなくてもリポジトリは作れているので、先へ進む").toBe(true);
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toContain("非公開のリポジトリ novel-test を作り、書庫 を GitHub へ送りました。");
    expect(infoMessages[0]).toContain("（この端末では認証情報を覚えられませんでした。送信のときに一度聞かれることがあります）");
    expect(logStep.mock.calls.map((call) => call[0]).join("\n")).toContain("認証情報の記憶: できず");
    // 覚えさせる相手は、いま作ったリポジトリの URL と作品の置き場（合言葉は渡すが、知らせ・ログには出さない）
    expect(remember).toHaveBeenCalledWith("テスト用の合言葉", "https://github.com/example/novel-test.git", "/tmp/library");
    expect(infoMessages[0]).not.toContain("テスト用の合言葉");
    expect(logStep.mock.calls.map((call) => call[0]).join("\n")).not.toContain("テスト用の合言葉");
  });
});
