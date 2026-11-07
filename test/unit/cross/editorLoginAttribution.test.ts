import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 編集者の GitHub のユーザー名を、作者の側の画面に残す（設計書5.7.5.9。0.138.0。作者の答え 2026-11-07）。
 *
 * 作者の実データと同じ形：台帳の `proposer` は編集者のパソコンの git の名前（「Kota Mizushima」）、
 * GitHub のユーザー名（「kmizu」）は作者の作品の `.aiwriter/editing.json` の `editorLogin` にだけある。
 * 解除で `editorLogin` が消えるので、そのあとは誰の提案だったか分からなくなっていた。
 *
 * 確かめること：
 * - 採った・見送ったときの履歴の行に、その時点の GitHub のユーザー名が残る
 * - 解除のあとも残る（`editing.json` から消えても行にある）。名前は「前の編集者」として残る
 * - 編集用の写しの編集者の行（▲）を取り込む。同じ行は二度入れない
 * - git の名前は画面の文に出ない
 * - 次に渡すとき、前の編集者の名前が訊く欄の初めの値になる
 *
 * **本物のファイルシステムで走らせる**（何を書いたかを見るのが目的。`collectEditorProposals.test.ts` と同じ）。
 */

vi.mock("../../../src/core/git", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  // 取り寄せは通ったことにする。見たいのは取り寄せの後
  pullFastForward: vi.fn(async () => ({ ok: true, detail: "" })),
  runGit: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
}));

// 作者の git の名前（decidedBy・actorName に入る。画面には出ない）
vi.mock("../../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "Hisa Nonaka"),
}));

// 採否を決め終えたときの送り返し（git）は走らせない
vi.mock("../../../src/core/runtime", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  canRunProcesses: () => false,
}));

// 本文の書き戻し（退避→新規作成）はここで見たいことではない。中身だけ書き換える
vi.mock("../../../src/core/textFile", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  writeTextFilePreservingFormat: vi.fn(async (target: string, next: string) => {
    await fsp.writeFile(target, next, "utf8");
    return { ok: true };
  }),
}));

vi.mock("../../../src/views/progress", () => ({
  withProgress: async <T>(_title: string, run: () => Promise<T>) => run(),
}));

const { acceptProposal, rejectProposal, primeEditorProposals } = await import(
  "../../../src/features/reviewProposals"
);
const { revokeEditorAccessFlow } = await import("../../../src/features/revokeEditorAccess");
const { askEditorLogin, importEditorProposalsQuietly, readSite } = await import(
  "../../../src/features/shareWithEditor"
);
const { ProposalStore } = await import("../../../src/core/proposalStore");
const { EditHistory } = await import("../../../src/core/editHistory");
const { historyDisplayName } = await import("../../../src/core/editHistoryFormat");
const { buildEpisodeTimeline } = await import("../../../src/core/episodeTimeline");
const { ProposerLoginStore } = await import("../../../src/core/proposerLogins");
const { proposalListRows } = await import("../../../src/features/editorProposalList");
const { authorGithubLogin, setAuthorTokenSourceForTests } = await import(
  "../../../src/features/authorGithubLogin"
);

const GIT_NAME = "Kota Mizushima";
const LOGIN = "kmizu";
const BODY = nodePath.join("本文", "001.txt");
const HISTORY = nodePath.join(".aiwriter", "history", "edits.jsonl");
const SITE = nodePath.join(".aiwriter", "editing.json");
const POINTER = nodePath.join(".aiwriter", "cache", "editing.json");
const PROPOSALS = nodePath.join(".aiwriter", "proposals", "proposals.jsonl");

function proposal(id: string, line: number, target: string, suggestion: string) {
  return {
    id,
    time: "2026-11-07T01:00:00.000Z",
    proposer: GIT_NAME,
    file: "本文/001.txt",
    line,
    original: target,
    target,
    suggestion,
    reason: "表記",
    category: "編集部の直し",
  };
}

describe("編集者の GitHub のユーザー名を、作者の側に残す", () => {
  let base = "";
  let root = "";
  let editing = "";

  const work = (): WorkEntry => ({
    id: "work_login",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-11-07T00:00:00.000Z",
  });

  const put = async (dir: string, relative: string, text: string) => {
    const target = nodePath.join(dir, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };
  const read = (dir: string, relative: string) => fsp.readFile(nodePath.join(dir, relative), "utf8");
  const historyLines = async () =>
    (await read(root, HISTORY))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>);

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-login-"));
    root = nodePath.join(base, "氷の街");
    editing = nodePath.join(base, "氷の街-編集用");
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(editing, { recursive: true });

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size };
      },
      readFile: async (uri: { fsPath: string }) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
      readDirectory: async () => [],
      delete: async () => undefined,
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });

    await put(root, BODY, "彼は走つた。\n夜が明けた。\n雪が降った。\n");
    // 作者が書いた知らない項目（`note`）も置いておく。解除のあとも消えないこと
    await put(
      root,
      SITE,
      JSON.stringify({ remoteUrl: "https://github.com/hisa/ice-editing.git", editorLogin: LOGIN, note: "作者のメモ" })
    );
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  test("採ったときの履歴の行に GitHub のユーザー名が残り、解除のあとも残る", async () => {
    const store = new ProposalStore(work());
    await store.propose([
      proposal("p1", 1, "走つた", "走った"),
      proposal("p2", 2, "明けた", "明けてゆく"),
      proposal("p3", 3, "降った", "降っていた"),
    ]);
    // p2 は取り込んだときに名前を覚えてある。p3 は 0.138.0 より前に取り込んだ（覚え無し）
    await new ProposerLoginStore(work()).remember(["p2"], LOGIN);

    expect(await acceptProposal(work(), proposal("p1", 1, "走つた", "走った"))).toEqual({ ok: true });
    const accepted = (await historyLines()).find((line) => line.action.includes("採り入れた"));
    expect(accepted?.action).toBe("編集者 kmizu の提案を採り入れた");
    expect(accepted?.editorLogin).toBe(LOGIN);

    // 解除する（権利は外せたことにする。消すかの問いは出さない）
    const result = await revokeEditorAccessFlow(work(), {
      confirm: async () => true,
      token: async () => "token",
      revoke: async () => ({ ok: true as const, outcome: "removed" as const }),
      whoAmI: async () => "Hisa Nonaka",
      offerDelete: async () => undefined,
    });
    expect(result.kind).toBe("done");

    // 名前は「前の編集者」として残り、作者の書いた項目も残る
    const site = JSON.parse(await read(root, SITE)) as Record<string, string>;
    expect(site.editorLogin).toBeUndefined();
    expect(site.formerEditorLogin).toBe(LOGIN);
    expect(site.note).toBe("作者のメモ");
    expect(site.remoteUrl).toBe("https://github.com/hisa/ice-editing.git");

    // 採った行は残っている
    expect((await historyLines()).some((line) => line.action === "編集者 kmizu の提案を採り入れた")).toBe(true);

    // 解除のあと：覚えのある提案は名前つき、覚えの無い提案は名前なし（git の名前に落とさない）
    await rejectProposal(work(), "p2", "本文/001.txt");
    await rejectProposal(work(), "p3", "本文/001.txt");
    const rejected = (await historyLines()).filter((line) => line.action.includes("見送った"));
    expect(rejected.map((line) => line.action)).toEqual([
      "編集者 kmizu の提案を見送った",
      "編集者の提案を見送った",
    ]);
    expect(await read(root, HISTORY)).not.toContain(GIT_NAME);
  });

  test("編集用の写しの編集者の行（▲）を取り込む。二度入れず、名前は GitHub のユーザー名で出す", async () => {
    await put(root, POINTER, JSON.stringify({ folderPath: editing }));
    await put(
      editing,
      PROPOSALS,
      JSON.stringify({ kind: "proposal", ...proposal("p9", 1, "走つた", "走った") }) + "\n"
    );
    const editorRow = {
      time: "2026-11-07T01:00:00.000Z",
      actor: "editor",
      actorName: GIT_NAME,
      action: "修正を提案した",
      file: "本文/001.txt",
      detail: "1行 「走つた」→「走った」",
    };
    // 写しには作者の行も混じりうる（作者の作品の側が正なので持ち込まない）
    const authorRow = { ...editorRow, actor: "author", actorName: "Hisa Nonaka", action: "書いた" };
    await put(editing, HISTORY, `${JSON.stringify(editorRow)}\n${JSON.stringify(authorRow)}\n`);

    await importEditorProposalsQuietly(work());
    await importEditorProposalsQuietly(work());

    const lines = await historyLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].actor).toBe("editor");
    expect(lines[0].editorLogin).toBe(LOGIN);
    // 画面に出す名前は GitHub のユーザー名
    const [loaded] = await new EditHistory(work()).load();
    expect(historyDisplayName(loaded)).toBe(LOGIN);
    // 提案ごとの覚え：取り込んだ時点の名前
    expect((await new ProposerLoginStore(work()).load()).get("p9")).toBe(LOGIN);
  });

  test("名前が分からない編集者の行は「編集者」とだけ出す（git の名前を出さない）", () => {
    const entry = {
      time: "2026-11-07T01:00:00.000Z",
      actor: "editor" as const,
      actorName: GIT_NAME,
      action: "修正を提案した",
      file: "本文/001.txt",
      detail: "",
    };
    expect(historyDisplayName(entry)).toBe("");
    // 作者の行は今までどおり
    expect(historyDisplayName({ ...entry, actor: "author", actorName: "Hisa Nonaka" })).toBe("Hisa Nonaka");
  });

  test("提案パネルの行・タイムラインの欄に git の名前が出ず、GitHub のユーザー名が出る", async () => {
    await new ProposalStore(work()).propose([proposal("p1", 1, "走つた", "走った")]);
    await new ProposalStore(work()).decide([
      {
        proposalId: "p0",
        time: "2026-11-07T02:00:00.000Z",
        decidedBy: "Hisa Nonaka",
        decidedByLogin: "nonahisa",
        status: "rejected",
        note: "",
      },
    ]);
    await new ProposerLoginStore(work()).remember(["p1"], LOGIN);

    const shown: Array<{ reason: string }> = [];
    const panel = {
      showRestoredProposals: (_work: WorkEntry, items: Array<{ reason: string }>) => shown.push(...items),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await primeEditorProposals(work(), panel as any);
    expect(shown).toHaveLength(1);
    expect(shown[0].reason).toContain("（kmizu の提案）");
    expect(shown[0].reason).not.toContain(GIT_NAME);

    const views = await new ProposalStore(work()).load();
    const timeline = buildEpisodeTimeline({
      workFolder: root,
      episodePath: nodePath.join(root, BODY),
      edits: [
        {
          time: "2026-11-07T01:00:00.000Z",
          actor: "editor",
          actorName: GIT_NAME,
          action: "修正を提案した",
          file: "本文/001.txt",
          detail: "",
        },
      ],
      proposals: [
        ...views,
        {
          ...proposal("p0", 2, "明けた", "明けてゆく"),
          status: "rejected",
          decision: {
            proposalId: "p0",
            time: "2026-11-07T02:00:00.000Z",
            decidedBy: "Hisa Nonaka",
            decidedByLogin: "nonahisa",
            status: "rejected",
            note: "",
          },
        },
      ],
      proposerLogins: await new ProposerLoginStore(work()).load(),
    });
    const text = JSON.stringify(timeline);
    expect(text).not.toContain(GIT_NAME);
    expect(text).not.toContain("Hisa Nonaka");
    expect(text).toContain(LOGIN);
    expect(text).toContain("nonahisa");
  });

  test("編集者の側の採否の一覧：決めた作者は GitHub のユーザー名だけで添える", () => {
    const base0 = { ...proposal("p1", 1, "走つた", "走った"), status: "accepted" as const };
    const withLogin = proposalListRows(
      [
        {
          ...base0,
          decision: {
            proposalId: "p1",
            time: "2026-11-07T02:00:00.000Z",
            decidedBy: "Hisa Nonaka",
            decidedByLogin: "nonahisa",
            status: "accepted",
            note: "",
          },
        },
      ],
      "decided",
      GIT_NAME
    );
    expect(withLogin[0].detail).toContain("決めた作者：nonahisa");
    expect(JSON.stringify(withLogin.map(({ label, description, detail }) => ({ label, description, detail })))).not.toContain(
      "Hisa Nonaka"
    );

    // 名前を引けなかった採否：誰が決めたかを書かない（git の名前に落とさない）
    const without = proposalListRows(
      [
        {
          ...base0,
          decision: {
            proposalId: "p1",
            time: "2026-11-07T02:00:00.000Z",
            decidedBy: "Hisa Nonaka",
            status: "accepted",
            note: "",
          },
        },
      ],
      "decided",
      GIT_NAME
    );
    expect(without[0].detail).not.toContain("決めた作者");
    expect(without[0].detail).not.toContain("Hisa Nonaka");
  });

  test("次に渡すとき、前の編集者の名前が訊く欄の初めの値になる", async () => {
    await put(root, SITE, JSON.stringify({ remoteUrl: "https://github.com/hisa/ice-editing.git", formerEditorLogin: LOGIN }));
    const asked: Array<{ value?: string }> = [];
    Object.assign(window, {
      showInputBox: vi.fn(async (options: { value?: string }) => {
        asked.push(options);
        return options.value;
      }),
    });
    const site = await readSite(work());
    expect(site.editorLogin).toBeUndefined();
    expect(await askEditorLogin(site)).toBe(LOGIN);
    expect(asked[0].value).toBe(LOGIN);
  });

  test("作者の GitHub 名：引けたら名前、引けなければ書かない（失敗は覚えない）", async () => {
    setAuthorTokenSourceForTests(undefined);
    const fetchLogin = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, detail: "回線" })
      .mockResolvedValueOnce({ ok: true, login: "nonahisa" });
    const token = async () => "token-a";
    expect(await authorGithubLogin(work(), { token, fetchLogin })).toBeUndefined();
    expect(await authorGithubLogin(work(), { token, fetchLogin })).toBe("nonahisa");
    // 通ったら、同じ鍵では引き直さない
    expect(await authorGithubLogin(work(), { token, fetchLogin })).toBe("nonahisa");
    expect(fetchLogin).toHaveBeenCalledTimes(2);
    expect(await authorGithubLogin(work(), { token: async () => undefined, fetchLogin })).toBeUndefined();
  });
});
