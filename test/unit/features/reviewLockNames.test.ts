import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, Uri, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 校閲中の知らせに git の名前を出さない（0.141.1。0.138.0 の決まりに揃える）。
 *
 * 帯（0.139.0）は GitHub のユーザー名（`.aiwriter/editing.json` の `editorLogin`、無ければ
 * `formerEditorLogin`）で出す。鍵の holder は git の名前で、作者が招いた名前と違うことがある
 * （実機では「Kei Mizushima が校閲中です」と出た）。右下の知らせ・素のエディターの警告・
 * 本文の書き込みの断りも、帯と同じ名前の決め方にする。
 *
 * あわせて、原稿エディターで開いたときに素のエディター用の警告を出さない（0.141.1 の追加 A。
 * 原稿エディターには帯がある）。
 *
 * 本物のファイルシステムで走らせる（`editingLocks.test.ts` と同じ）。
 */

const { installEditorLockGuard } = await import("../../../src/features/editorLockGuard");
const { writeTextFilePreservingFormat, readTextFile, setBodyWriteGuard } = await import(
  "../../../src/core/textFile"
);
const { reviewLockDetailFor } = await import("../../../src/features/manuscriptReviewLock");

const GIT_NAME = "Kei Mizushima";
const LOCKS = nodePath.join(".aiwriter", "locks", "locks.jsonl");
const SITE = nodePath.join(".aiwriter", "editing.json");

let base = "";
let root = "";
let nextFile = 0;
const warnings: string[] = [];
let openListener: ((document: { uri: unknown }) => void) | undefined;
let activeListener: ((editor: { document: { uri: unknown } } | undefined) => void) | undefined;

const work = (): WorkEntry => ({
  id: "work_lock_names",
  title: "氷の街",
  folderPath: root,
  registeredAt: "2026-10-28T00:00:00.000Z",
});

async function put(relative: string, text: string): Promise<void> {
  const target = nodePath.join(root, relative);
  await fsp.mkdir(nodePath.dirname(target), { recursive: true });
  await fsp.writeFile(target, text, "utf8");
}

/** 編集者が鍵をかけた話を1つ作る（鍵の holder は git の名前）。警告の間引きを避けて毎回別の名前 */
async function lockedEpisode(site: Record<string, string>): Promise<string> {
  nextFile += 1;
  const name = `00${nextFile}_校閲中.txt`;
  await put(nodePath.join("本文", name), "朝の駅は静かだった。");
  await put(
    LOCKS,
    `${JSON.stringify({
      kind: "acquire",
      file: `本文/${name}`,
      holder: GIT_NAME,
      holderKind: "editor",
      time: "2026-11-07T09:30:00.000Z",
      note: "",
    })}\n`
  );
  await put(SITE, JSON.stringify(site));
  return nodePath.join(root, "本文", name);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-lock-names-"));
  root = nodePath.join(base, "氷の街");
  await fsp.mkdir(root, { recursive: true });
  warnings.length = 0;
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
    readDirectory: async (uri: { fsPath: string }) => {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
    },
    delete: async (uri: { fsPath: string }, options?: { recursive?: boolean }) => {
      await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
    },
  } as unknown as typeof workspace.fs;
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async (message: string) => {
      warnings.push(message);
      return undefined;
    }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    onDidChangeActiveTextEditor: (listener: typeof activeListener) => {
      activeListener = listener;
      return { dispose() {} };
    },
  });
  Object.assign(workspace, {
    onDidOpenTextDocument: (listener: typeof openListener) => {
      openListener = listener;
      return { dispose() {} };
    },
  });
});

afterEach(async () => {
  setBodyWriteGuard(undefined);
  workspace.fs = {} as typeof workspace.fs;
  await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
});

describe("名前の決め方（帯と同じ）", () => {
  test("GitHub の名前があればそれ。git の名前は出さない", async () => {
    const file = await lockedEpisode({ editorLogin: "kmizu" });
    const { editorLockOf } = await import("../../../src/core/fileLockStore");
    const lock = await editorLockOf(work(), file);
    if (!lock) throw new Error("鍵が読めません");
    const text = await reviewLockDetailFor(work(), lock);
    expect(text).toContain("編集者 kmizu");
    expect(text).not.toContain(GIT_NAME);
  });

  test("解除のあとは前の編集者の名前。どちらも無ければ「編集者」とだけ", async () => {
    const { editorLockOf } = await import("../../../src/core/fileLockStore");
    const former = await lockedEpisode({ formerEditorLogin: "kmizu-old" });
    const lock1 = await editorLockOf(work(), former);
    if (!lock1) throw new Error("鍵が読めません");
    expect(await reviewLockDetailFor(work(), lock1)).toContain("編集者 kmizu-old");

    const none = await lockedEpisode({});
    const lock2 = await editorLockOf(work(), none);
    if (!lock2) throw new Error("鍵が読めません");
    const text = await reviewLockDetailFor(work(), lock2);
    expect(text.startsWith("編集者")).toBe(true);
    expect(text).not.toContain(GIT_NAME);
  });
});

describe("本文の書き込みの断り", () => {
  test("断りの文に git の名前が出ない", async () => {
    const file = await lockedEpisode({ editorLogin: "kmizu" });
    const guard = installEditorLockGuard({ list: () => [work()] });
    const content = await readTextFile(file);
    const refused = await writeTextFilePreservingFormat(file, "朝の駅は。", content, content.hash);
    guard.dispose();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.detail).toContain("編集者 kmizu");
      expect(refused.detail).not.toContain(GIT_NAME);
    }
  });
});

describe("素のエディターの警告（開いたとき）", () => {
  test("原稿エディターで開いたとき（文書が開いただけで、素のエディターが前に出ない）は出さない", async () => {
    const file = await lockedEpisode({ editorLogin: "kmizu" });
    const guard = installEditorLockGuard({ list: () => [work()] });
    openListener?.({ uri: Uri.file(file) });
    await settle();
    guard.dispose();
    expect(warnings, `出た知らせ：${JSON.stringify(warnings)}`).toEqual([]);
  });

  test("素のエディターが前に出たら、読み取り専用にしたことを GitHub の名前で知らせる", async () => {
    const file = await lockedEpisode({ editorLogin: "kmizu" });
    const guard = installEditorLockGuard({ list: () => [work()] });
    activeListener?.({ document: { uri: Uri.file(file) } });
    await settle();
    guard.dispose();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`は編集者が校閲中のため、読み取り専用にしました（編集者 kmizu`);
    expect(warnings[0]).not.toContain(GIT_NAME);
  });
});

describe("素のエディターで読み取り専用を外して打ったとき（0.141.1 の追加 C。作者の答え「打った時点で戻す」）", () => {
  /** 素のエディターで開いている文書の代役。打つと中身が変わり、戻す命令でファイルの中身へ戻る */
  async function typeIntoPlainEditor(file: string, typed: string, waitMs = 3000) {
    const executed: string[] = [];
    let changeListener: ((event: unknown) => void) | undefined;
    const fileText = await fsp.readFile(file, "utf8");
    const document = {
      uri: Uri.file(file),
      text: fileText,
      getText() {
        return this.text;
      },
    };
    Object.assign(workspace, {
      onDidChangeTextDocument: (listener: typeof changeListener) => {
        changeListener = listener;
        return { dispose() {} };
      },
    });
    Object.assign(window, { activeTextEditor: { document } });
    const { commands } = await import("../support/vscodeStub");
    const originalExecute = commands.executeCommand;
    commands.executeCommand = (async (command: string) => {
      executed.push(command);
      if (command === "workbench.action.files.revert") {
        document.text = fileText;
        changeListener?.({ document, contentChanges: [{ text: "" }] });
      }
      return undefined;
    }) as typeof commands.executeCommand;
    const rescues = new Map<string, unknown>();
    const store = {
      get: (key: string) => rescues.get(key),
      update: async (key: string, value: unknown) => {
        rescues.set(key, value);
      },
    };
    const guard = installEditorLockGuard({ list: () => [work()] }, { readonlyRescues: store });
    document.text = typed;
    changeListener?.({ document, contentChanges: [{ text: "あ" }] });
    /*
      **決まった回数では待たない**（CI の遅い機械で、戻す前に見て落ちた。2026-11-07 run 42377118627）。
      戻す仕事は、控えの書き込み・鍵の台帳の読み・命令の呼び出しと続くので、戻ったのが見えるまで待つ
    */
    /*
      鍵のある話は、戻ったのが見えれば抜けるので、上限は長くしてよい。CI の全件の混む中では3秒を超えた
      （2026-11-07 run 42377837222 で 3,366ms のあいだ戻らずに落ちた）。鍵の無い話（何もしない件）は、上限まで待って抜ける
    */
    const until = Date.now() + waitMs;
    while (Date.now() < until && !(document.text === fileText && executed.includes("workbench.action.files.setActiveEditorReadonlyInSession"))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await settle();
    guard.dispose();
    commands.executeCommand = originalExecute;
    Object.assign(window, { activeTextEditor: undefined });
    return { executed, document, rescues, fileText };
  }

  test("文書がファイルの中身に戻り、打った字が控えに入り、読み取り専用が掛け直され、git の名前の無い知らせが出る", async () => {
    const file = await lockedEpisode({ editorLogin: "kmizu" });
    const result = await typeIntoPlainEditor(file, "朝の駅は静かだった。あ", 20_000);
    expect(result.document.text).toBe(result.fileText);
    expect(await fsp.readFile(file, "utf8"), "原稿のファイルには書かない").toBe(result.fileText);
    expect(result.executed).toContain("workbench.action.files.revert");
    expect(result.executed).toContain("workbench.action.files.setActiveEditorReadonlyInSession");
    const kept = JSON.stringify([...result.rescues.values()]);
    expect(kept).toContain("朝の駅は静かだった。あ");
    const notice = warnings.find((message) => message.includes("打った字は控えました"));
    expect(notice, `出た知らせ：${JSON.stringify(warnings)}`).toBeDefined();
    expect(notice).toContain("は編集者が校閲中のため、書けません（編集者 kmizu");
    expect(notice).not.toContain(GIT_NAME);
  }, 30_000);

  test("鍵の無い話では何もしない", async () => {
    nextFile += 1;
    const name = `00${nextFile}_ふつう.txt`;
    await put(nodePath.join("本文", name), "朝の駅は静かだった。");
    const file = nodePath.join(root, "本文", name);
    const result = await typeIntoPlainEditor(file, "朝の駅は静かだった。あ");
    expect(result.document.text).toBe("朝の駅は静かだった。あ");
    expect(result.executed).toEqual([]);
    expect(result.rescues.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe("打ったときの右下の知らせ（原稿エディター）", () => {
  test("鍵の holder（git の名前）を文に使わない", () => {
    // 原稿エディターの打鍵の道は大きな部品の奥にあるので、名前の決め方を通っていることを源で見る
    const source = readFileSync(
      nodePath.join(__dirname, "..", "..", "..", "src", "features", "manuscriptEditor.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/describeLock\(/);
    expect(source).toMatch(/reviewLockDetailFor\(/);
    const guard = readFileSync(
      nodePath.join(__dirname, "..", "..", "..", "src", "features", "editorLockGuard.ts"),
      "utf8"
    );
    expect(guard).not.toMatch(/describeLock\(/);
  });
});
