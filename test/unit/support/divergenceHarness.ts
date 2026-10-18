import * as fs from "node:fs";
import * as nodePath from "node:path";
import { beforeEach } from "vitest";
import type { foldDivergence } from "../../../src/features/resolveDivergence";
import { configureTestRepo, git, gitTemplate, pointOrigin } from "./gitTemplate";

/**
 * 分岐を合わせる試験（`features/resolveDivergence*.test.ts`）の共通の前準備。
 *
 * **1つのファイルを3つに分けた**（2026-10-17。単体テストの重さの見直し）。
 * 本物の git で合流まで走らせる件が34件あり、製品の側が1件で git を30回ほど
 * 起こす。1つのファイルの中は順に走るので、このファイル1本が単体テスト全体の
 * 実行時間を決めていた（全体75秒のうち73秒）。ファイルを分ければ並列に走る。
 * **確かめる中身は1件も変えていない**——分けたのは置き場所だけで、
 * 3つのファイルがここの同じ前準備・同じ代役を使う。
 *
 * - `resolveDivergence.test.ts`：確認から合わせるまでの通しと、知らせの文面
 * - `resolveDivergenceFoldSettings.test.ts`：自動合流のうち、設定資料と途中でやめたとき
 * - `resolveDivergenceFoldFiles.test.ts`：自動合流のうち、本文・追記型の記録・履歴・承認待ち
 *
 * **ここから製品のコードを読み込まない**（型だけ）。製品は `vscode` を読み込み、
 * その代役（`vscodeStub`）はここにある。ここが製品を読み込むと、代役を作る途中で
 * 代役を求めることになる。
 */

/** 画面に出た問いと、その答え */
export const answers: string[] = [];
export const shown: string[] = [];

/** 画面に添えられた説明も控える。落ちた理由はそちらに出る */
function record(message: string, rest: unknown[]): void {
  const detail = rest.find(
    (item): item is { detail?: string } =>
      typeof item === "object" && item !== null && "detail" in item
  )?.detail;
  shown.push(detail ? `${message}
${detail}` : message);
}

/** ボタンが並んでいたら、答えとして用意したものを返す */
function pickAnswer(rest: unknown[]): string | undefined {
  const buttons = rest.filter((item) => typeof item === "string") as string[];
  const wanted = answers.find((answer) => buttons.includes(answer));
  return wanted;
}

const readFile = async (uri: { fsPath: string }) =>
  new Uint8Array(fs.readFileSync(uri.fsPath));
// 追記型の記録を混ぜた結果は、索引からではなく**その場で組んで**置く
const writeFile = async (uri: { fsPath: string }, bytes: Uint8Array) => {
  fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
  fs.writeFileSync(uri.fsPath, bytes);
};

/**
 * `vscode` の代役。**vscode だけを差し替えて、gitとファイルは本物を使う。**
 * 各試験のファイルで `vi.mock("vscode", async () => (await import(…)).vscodeStub)` と渡す。
 */
export const vscodeStub = {
  window: {
    showInformationMessage: (message: string, ...rest: unknown[]) => {
      record(message, rest);
      return Promise.resolve(pickAnswer(rest));
    },
    showWarningMessage: (message: string, ...rest: unknown[]) => {
      record(message, rest);
      return Promise.resolve(pickAnswer(rest));
    },
    showErrorMessage: (message: string, ...rest: unknown[]) => {
      record(message, rest);
      return Promise.resolve(pickAnswer(rest));
    },
    withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      Promise.resolve(
        task({ report: () => {} }, { isCancellationRequested: false })
      ),
    createStatusBarItem: () => ({
      show() {},
      hide() {},
      dispose() {},
    }),
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      dispose() {},
    }),
  },
  workspace: {
    fs: { readFile, writeFile },
    getConfiguration: () => ({ get: () => undefined }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
  Uri: {
    file: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
    parse: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
  },
  ProgressLocation: { Window: 10, Notification: 15 },
  // 中止ボタン付きの進捗が使う。中止はしないので、押されていない札を返すだけ
  CancellationTokenSource: class {
    token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    cancel() {}
    dispose() {}
  },
  StatusBarAlignment: { Right: 2 },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
};

export type ConflictWalker = Parameters<
  typeof foldDivergence
>[2] extends { walk?: infer W } | undefined
  ? NonNullable<W>
  : never;

/** この端末の写し（作業フォルダー）。テストごとに `setUp` が決め直す */
export let root: string;
/** GitHub役の置き場 */
export let remote: string;
/** 「別のPC」の写し。GitHub役から取り出した状態で雛形に入れてある */
let otherClone: string;

export function write(dir: string, file: string, body: string): void {
  const full = nodePath.join(dir, file);
  fs.mkdirSync(nodePath.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

/**
 * 作品1つを置いた、GitHub役の置き場とその写し（この端末・別のPC）の雛形。
 *
 * **ファイルで1回だけ作り、テストごとに写す**（`support/gitTemplate.ts`）。
 * 以前はテストごとに git を11回起こして作り直していた。中身は毎回同じなので、
 * 写してもテストが受け取る状態は変わらない。
 */
const template = gitTemplate("novelai-diverge-", (base) => {
  const seed = nodePath.join(base, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  // **端末のgitの設定で結果が変わらないようにする**（取り出す前に入れる理由は
  // `configureTestRepo` の注）
  configureTestRepo(seed);
  write(seed, "短編/本文/第1話.txt", "むかしむかし。\n");
  write(seed, "短編/.aiwriter/stats/pc.json", '{"at":"1"}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "初回");

  const bare = nodePath.join(base, "remote.git");
  git(base, "clone", "-q", "--bare", seed, bare);
  configureTestRepo(bare);
  git(base, "-c", "core.autocrlf=false", "clone", "-q", bare, "work");
  configureTestRepo(nodePath.join(base, "work"));
  git(base, "-c", "core.autocrlf=false", "clone", "-q", bare, "other");
  configureTestRepo(nodePath.join(base, "other"));
});

/** 雛形を写して、この端末とGitHub役の場所を決める */
function setUp(): void {
  // **一時フォルダーの道を長い形にそろえる。** GitHub の検査機（Windows）では os.tmpdir() が
  // `C:\Users\RUNNER~1\…` の短い形（8.3）で返り、git の `--show-toplevel` は長い形で返す。
  // 食い違うと「同じフォルダー」と判定できず、作品名の代わりにフォルダー名が出る（2026-10-18、CI で10-06から落ちていた）
  const base = fs.realpathSync.native(template.copy());
  remote = nodePath.join(base, "remote.git");
  root = nodePath.join(base, "work");
  otherClone = nodePath.join(base, "other");
  pointOrigin(root, remote);
  pointOrigin(otherClone, remote);
}

/** 別のPCで書いた分を、GitHub役へ入れる。`removals` は向こうで消したもの */
export function pushFromOtherMachine(
  changes: Array<[string, string]>,
  removals: string[] = []
): void {
  /*
    **書く前に、GitHub役の最新を取り込む。** 以前は呼ぶたびに取り出し直して
    いた（＝その時点のGitHub役と同じ状態から書く）。この端末が先に送って
    いることがある（`分岐を作る`）ので、取り込まずに書くと押し返される。
    別のPCの写しには送っていない記録が無いので、早送りだけで追いつく。
  */
  git(otherClone, "pull", "-q", "--ff-only", "origin", "main");
  for (const [file, body] of changes) write(otherClone, file, body);
  for (const file of removals) fs.rmSync(nodePath.join(otherClone, file));
  git(otherClone, "add", "-A");
  git(otherClone, "commit", "-qm", "別のPCで書いた");
  git(otherClone, "push", "-q", "origin", "main");
}

/** この端末で書いて記録する */
export function commitHere(changes: Array<[string, string]>, message: string): void {
  for (const [file, body] of changes) write(root, file, body);
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

export function deps() {
  return {
    registry: {
      list: () => [{ id: "w1", title: "短編", folderPath: root }],
    } as never,
  };
}

export function status(): string {
  return git(root, "status", "-sb").split("\n")[0];
}

/** 画面の問いと答えを空にする（各試験のファイルの外側の `beforeEach` で呼ぶ） */
export function resetScreen(): void {
  answers.length = 0;
  shown.length = 0;
}

/*
  **倉庫を用意するのは、本物のgitを使う describe の中だけ**（2026-10-17）。

  以前はファイルの外側の `beforeEach` で全件に倉庫を作っていて、確認の文面を
  組むだけのテスト（git を使わない約30件）も1件300ms以上を前準備に使っていた。

  **フックにも猶予が要る**（2026-09-18、CIで落ちた）。`describe` に与えた
  `timeout` はテスト本体にしか効かず、フックは `hookTimeout`（既定10秒）で
  動く。最初の1件は雛形づくり（git を十数回起こす）を含むので、CIの遅い機械で
  並列に走ると超える（実際 `Hook timed out in 10000ms` で落ちた）。
  **処理が遅いのではなく起動が重いので、待ちだけ伸ばす。**
*/
export function useRepository(): void {
  beforeEach(() => {
    setUp();
  }, 30_000);
}

// ─── 自動合流（`foldDivergence`）の2つのファイルが使うもの ───

export const 人物ファイル = "短編/設定/characters/char_001_太志.json";

/** 1人ぶんのJSON。作者が書く部分と、AIが書く部分を分けて渡す */
export function 人物(input: {
  summary: string;
  authorNotes?: string;
  updatedAt: string;
  autoGenerated?: boolean;
}): string {
  return `${JSON.stringify(
    {
      schemaVersion: "0.1",
      id: "char_001",
      name: "太志",
      summary: input.summary,
      appearedChapters: [1],
      authorNotes: input.authorNotes ?? "",
      exportNote: "",
      autoGenerated: input.autoGenerated ?? true,
      updatedAt: input.updatedAt,
    },
    null,
    2
  )}\n`;
}

/** 種を置いてから分岐を作る */
export function 分岐を作る(seedFiles: Array<[string, string]>, other: Array<[string, string]>, here: Array<[string, string]>): void {
  commitHere(seedFiles, "土台");
  git(root, "push", "-q", "origin", "main");
  pushFromOtherMachine(other);
  commitHere(here, "こちらで直した");
  git(root, "fetch", "-q");
}

/** 作者の代わりに「こちら」を選ぶ。**gitへの書き戻しまで本物と同じにする** */
export const こちらを選ぶ: ConflictWalker = async ({ root: cwd, files }) => {
  for (const file of files) {
    git(cwd, "checkout", "--ours", "--", file);
    git(cwd, "add", "--", file);
  }
  return { resolved: [...files], bulkResolved: [], aborted: false };
};

/** 作者が途中でやめる */
export const やめる: ConflictWalker = async () => ({
  resolved: [],
  bulkResolved: [],
  aborted: true,
});
