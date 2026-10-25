import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
  「GitHub初期設定」（`novelai.setupGithub`）を1回押したときに、作者へ出る問いの数と順を固定する。

  2026-10-26 未明の実機で、作者は「４回も良くわからないことを聞かれました」。調べると、
  製品の問いだけで5つ（［始める］・［記録する］・送り先・名前・［送信する］）あり、
  しかも押すたびに1手しか進まず、メニューを3回押す必要があった。作者の裁定（まとめて減らす）：

  - 1回押せば最後まで進む
  - ［始める］と［記録する］を1つの問いにする（警告の顔は残す）
  - 名前は訊かない（`novel-YYYYMMDD`、題は説明欄へ）
  - リポジトリを作る確認と、はじめて送る確認を1つにまとめる（**送る前の確認は残す**）
  - VS Code の許可とブラウザの承認の前に、まとめた確認の中で一言断る（サインイン済みなら断らない）

  偽の git・偽の GitHub で流れをたどり、**作者に出る問いを1本の列に積んで**見る。
*/

type Status = { kind: "not_a_repo" } | { kind: "no_remote" } | { kind: "no_upstream"; branch: string } | { kind: "tracked" };

const state = {
  repo: false,
  committed: false,
  remote: false,
  pushed: false,
  session: false,
  createdPrivate: true as boolean | undefined,
};
const questions: string[] = [];
const infoMessages: string[] = [];
const askText = vi.fn(async () => "使われないはず");
const authenticate = vi.fn(async () => "テスト用の合言葉");
const createRepo = vi.fn(async (_token: string, base: string, _description: string | undefined) => ({
  ok: true,
  cloneUrl: `https://github.com/example/${base}.git`,
  name: base,
  isPrivate: state.createdPrivate,
}));
const push = vi.fn(async () => {
  state.pushed = true;
  return { ok: true };
});

vi.mock("../../../src/core/gitSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/gitSetup")>();
  return {
    ...actual,
    ghAvailable: async () => false,
    hasGithubSession: async () => state.session,
    ensureGithubAuthToken: () => authenticate(),
    createGithubRepositoryWithFreeName: (token: string, base: string, description: string | undefined) =>
      createRepo(token, base, description),
    addRemote: async () => {
      state.remote = true;
      return { ok: true };
    },
    rememberGithubCredential: async () => true,
    initRepository: async () => {
      state.repo = true;
      return { ok: true };
    },
    hasCommitIdentity: async () => true,
    countTrackableFiles: async () => 13,
    commitAll: async () => {
      state.committed = true;
      return { ok: true };
    },
    hasCommits: async () => state.committed,
    currentBranch: async () => "main",
    pushSetUpstream: () => push(),
  };
});
vi.mock("../../../src/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/logger")>();
  return { ...actual, logStep: () => undefined, logFailure: () => undefined };
});
vi.mock("../../../src/features/syncLog", () => ({ useSyncLog: async () => undefined }));
vi.mock("../../../src/views/progress", () => ({
  withProgress: async (_title: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../../../src/views/dialogs", () => ({
  askText: () => askText(),
  cancelItem: () => ({ label: "取りやめる" }),
}));
const confirmAnswers: boolean[] = [];
vi.mock("../../../src/views/notify", () => ({
  confirmRun: async (message: string, label: string) => {
    questions.push(`製品の確認［${label}］: ${message.split("\n")[0]}`);
    return confirmAnswers.shift() ?? true;
  },
  notifyDone: () => undefined,
  warnWithLog: async (message: string) => {
    infoMessages.push(`警告: ${message}`);
  },
}));

import * as vscode from "vscode";
import { runSetupFlow } from "../../../src/features/gitOnboarding";
import type { GitSyncStatus } from "../../../src/core/git";
import type { SyncTarget } from "../../../src/core/syncTarget";

/** 送る前のまとめた確認で、作者が押すボタン（undefined なら閉じる） */
let modalAnswer: string | undefined;
const modalDetails: string[] = [];

function target(): SyncTarget {
  return {
    folderPath: "/tmp/GitHub試験_確認用",
    label: "GitHub試験_確認用",
    works: [{ title: "GitHub試験_確認用", folderPath: "/tmp/GitHub試験_確認用" }],
  } as unknown as SyncTarget;
}

/** 偽の git の状態から、製品の `readSyncStatus` と同じ分かれ方で答える */
async function readStatus(): Promise<GitSyncStatus> {
  let status: Status;
  if (!state.repo) status = { kind: "not_a_repo" };
  else if (!state.remote) status = { kind: "no_remote" };
  else if (!state.pushed) status = { kind: "no_upstream", branch: "main" };
  else status = { kind: "tracked" };
  return status as unknown as GitSyncStatus;
}

const noRun = async () => ({ ok: true, stdout: "https://github.com/example/x.git", stderr: "", code: 0 });

beforeEach(() => {
  Object.assign(state, { repo: false, committed: false, remote: false, pushed: false, session: false, createdPrivate: true });
  questions.length = 0;
  infoMessages.length = 0;
  modalDetails.length = 0;
  confirmAnswers.length = 0;
  modalAnswer = "作って送る";
  askText.mockClear();
  authenticate.mockClear();
  createRepo.mockClear();
  push.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 作者が試した時刻（手元の暦で 2026-10-26 0:09。UTC では前日）
  vi.setSystemTime(new Date(2026, 9, 26, 0, 9));

  const window = vscode.window as unknown as Record<string, unknown>;
  window.showQuickPick = async (items: Array<{ action?: string }>, options: { title?: string }) => {
    questions.push(`製品の選択: ${options.title ?? ""}`);
    return items.find((item) => item.action === "vscodeAuth");
  };
  window.showWarningMessage = async (message: string, ...rest: unknown[]) => {
    const options = rest[0] as { modal?: boolean; detail?: string } | undefined;
    if (options?.modal) {
      questions.push(`製品の確認（モーダル）: ${message.split("\n")[0]}`);
      modalDetails.push(options.detail ?? "");
      return modalAnswer;
    }
    infoMessages.push(`警告: ${message}`);
    return undefined;
  };
  window.showInformationMessage = async (message: string) => {
    infoMessages.push(message);
    return undefined;
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GitHub初期設定を1回押したときの問い（2026-10-26 の裁定）", () => {
  test("まだGitで管理していない作品から、1回押すだけで送り終わる。製品の問いは「始める」「送り先」「まとめた確認」の3つだけ", async () => {
    const first = await readStatus();
    const advanced = await runSetupFlow(target(), first, { readStatus, run: noRun as never });

    expect(advanced).toBe(true);
    expect(questions).toEqual([
      "製品の確認［始める］: GitHub試験_確認用 をGitで管理しますか？",
      "製品の選択: GitHub試験_確認用 の送り先",
      "製品の確認（モーダル）: 非公開のリポジトリ novel-20261026 をGitHubに作り、GitHub試験_確認用 を送ります。",
    ]);
    // 名前は訊かない（入力欄は1度も出ない）
    expect(askText).not.toHaveBeenCalled();
    // 名前は日付つき、題は説明欄へ
    expect(createRepo).toHaveBeenCalledWith("テスト用の合言葉", "novel-20261026", "GitHub試験_確認用");
    // 送信は1回だけ（2度目の［送信する］は出ない）
    expect(push).toHaveBeenCalledTimes(1);
    expect(state.pushed).toBe(true);
    // 送る前の確認は残っている——確認より先に作る・送ることはない
    expect(questions.some((line) => line.includes("［記録する］"))).toBe(false);
  });

  test("まだサインインしていなければ、まとめた確認の中で VS Code の許可とブラウザの承認を前置きする", async () => {
    state.session = false;
    await runSetupFlow(target(), await readStatus(), { readStatus, run: noRun as never });
    expect(modalDetails[0]).toContain("次に VS Code の許可と、ブラウザで GitHub の承認を求められます。");
    expect(modalDetails[0]).toContain("［許可］／［Authorize］");
  });

  test("英数字だけの題なら、その名前で作り、「日付で名前を付け」とは言わない", async () => {
    const ascii = {
      folderPath: "/tmp/My Novel 2",
      label: "My Novel 2",
      works: [{ title: "My Novel 2", folderPath: "/tmp/My Novel 2" }],
    } as unknown as SyncTarget;
    await runSetupFlow(ascii, await readStatus(), { readStatus, run: noRun as never });
    expect(questions[2]).toContain("非公開のリポジトリ My-Novel-2 をGitHubに作り");
    expect(modalDetails[0]).not.toContain("日付で名前を付け");
    expect(modalDetails[0]).toContain("-2 などの番号");
  });

  test("もうサインインしていれば、出ない窓のことは断らない", async () => {
    state.session = true;
    await runSetupFlow(target(), await readStatus(), { readStatus, run: noRun as never });
    expect(modalDetails[0]).not.toContain("［Authorize］");
  });

  test("まとめた確認で取りやめれば、サインインも作成も送信もしない（送る前の確認は残っている）", async () => {
    modalAnswer = undefined;
    const advanced = await runSetupFlow(target(), await readStatus(), { readStatus, run: noRun as never });
    expect(advanced, "記録までは進んでいる").toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
    expect(createRepo).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  test("最初の［始める］で取りやめれば、何も作らず、次の問いも出さない", async () => {
    confirmAnswers.push(false);
    const advanced = await runSetupFlow(target(), await readStatus(), { readStatus, run: noRun as never });
    expect(advanced).toBe(false);
    expect(state.repo).toBe(false);
    expect(questions).toHaveLength(1);
  });

  test("GitHub が非公開で作ったと答えなければ、送らずに止める", async () => {
    state.createdPrivate = false;
    await runSetupFlow(target(), await readStatus(), { readStatus, run: noRun as never });
    expect(push).not.toHaveBeenCalled();
  });

  test("送り先だけが決まっている作品（URL を登録済み）は、これまでどおり［送信する］を訊いてから送る", async () => {
    state.repo = true;
    state.committed = true;
    state.remote = true;
    modalAnswer = "送信する";
    await runSetupFlow(target(), await readStatus(), { readStatus, run: noRun as never });
    expect(questions).toEqual(["製品の確認（モーダル）: GitHub試験_確認用 をGitHubへ送ります。"]);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
