import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 「投稿済みの基準線」の窓（作者の実機の指摘、2026-09-22）。
 *
 * ## 何が起きたか
 *
 * 投稿サイトの設定を通したあと、「投稿済みの基準線」の2択が出た。作者は
 * これを**数字を打つ欄**だと読んで「219」と打ち、2つとも絞り込みで消え、
 * Enterを押しても何も起きなくなった。説明文（placeHolder）も打った瞬間に
 * 消えるので、何の画面だったのかも分からなくなる。
 *
 * ## どう直したか
 *
 *   - **初回登録（記録がまだ1件も無い）は2択を挟まず、話の一覧を直接出す**
 *     ——引き直す前の線が無いのだから、「引き直すか」を訊く意味が無い
 *   - 一覧の案内を「一覧から選んでください（数字を打つと絞り込めます）」で
 *     始める。何が記録されるかの説明は落とさず、後ろへ回す
 *   - 2択は残すが、題（絞り込んでも残る）にも「一覧から選びます」と書く
 *
 * **サイトへは何も送らない**（6.68.1）。ここで動くのは画面と台帳だけである。
 */

const episodes = [
  { fileName: "第1話.txt", filePath: path.join("C:", "novels", "base", "本文", "第1話.txt") },
  { fileName: "第2話.txt", filePath: path.join("C:", "novels", "base", "本文", "第2話.txt") },
];

const scanWork = vi.fn();
vi.mock("../../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

import { configurePostingSites } from "../../../src/features/postingKit";

const work: WorkEntry = {
  id: "work_baseline",
  title: "灯台の下",
  folderPath: path.join("C:", "novels", "base"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const kakuyomuUrl = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";

interface PickItem {
  label: string;
  [key: string]: unknown;
}

const disk = new Map<string, Uint8Array>();
/** 出た選択画面（項目と、そのときの題・案内） */
const picks: Array<{
  items: PickItem[];
  title: string;
  placeHolder: string;
}> = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** すでにある記録。空なら「まだ1話も出していない」状態 */
function writeLedger(posts: unknown[]): void {
  disk.set(
    ledgerPath,
    utf8(
      JSON.stringify({
        schemaVersion: "1",
        sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
        siteProfiles: [],
        posts,
        rankings: [],
      })
    )
  );
}

/** 2択（「引き直す」の項目を持つ画面）が出たか */
function redoPick(): (typeof picks)[number] | undefined {
  return picks.find((pick) => pick.items.some((item) => "redo" in item));
}

/** 話の一覧（「まで投稿済み」の項目を持つ画面）が出たか */
function episodePick(): (typeof picks)[number] | undefined {
  return picks.find((pick) => pick.items.some((item) => "upto" in item));
}

beforeEach(() => {
  disk.clear();
  picks.length = 0;
  scanWork.mockReset();
  scanWork.mockResolvedValue({ episodes, manuscriptDir: "本文" });

  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;

  Object.assign(window, {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async (options: { title?: string }) =>
      // 投稿ページのURLだけは必須なので答える。作品情報は訊かれない
      String(options.title ?? "").includes("新規エピソード投稿ページ")
        ? kakuyomuUrl
        : "",
    showQuickPick: async (
      items: PickItem[],
      options: { title?: string; placeHolder?: string }
    ) => {
      picks.push({
        items,
        title: options?.title ?? "",
        placeHolder: options?.placeHolder ?? "",
      });
      // 1つ目：出すサイト（複数選択）→カクヨムだけ
      if (items.some((item) => "site" in item)) {
        return items.filter((item) => item.site === "kakuyomu");
      }
      // 2つ目：作品情報を入れるか→入れない
      if (items.some((item) => "detailed" in item)) return items[0];
      // 基準線まわりは、出たことだけ見て取りやめる
      return undefined;
    },
  });
});

describe("初回登録（記録がまだ1件も無い）", () => {
  test("2択を挟まず、話の一覧を直接出す", async () => {
    writeLedger([]);

    await configurePostingSites(work);

    // **「引き直しますか」は出ない**（引き直す前の線が無い）
    expect(redoPick()).toBeUndefined();
    const list = episodePick();
    expect(list).toBeDefined();
    // 新しい話が上。ここでは第2話が先頭（見分けはファイル名で出す）
    expect(String(list?.items[0].detail)).toBe("第2話.txt");
  });

  test("一覧の案内は「一覧から選んでください」で始まり、記録の説明も残る", async () => {
    writeLedger([]);

    await configurePostingSites(work);

    const list = episodePick();
    expect(list?.placeHolder.startsWith("一覧から選んでください")).toBe(true);
    // **数字は絞り込みであって、打ち込む欄ではない**と読めること
    expect(list?.placeHolder).toContain("絞り込め");
    // 何が起きるかの説明は落とさない（登録したサイトすべてへ入る）
    expect(list?.placeHolder).toContain("登録したサイトすべて");
  });
});

describe("引き直し（すでに記録がある）", () => {
  const posted = [
    {
      episodePath: "本文/第1話.txt",
      site: "kakuyomu",
      postedAt: "2026-09-10T00:00:00.000Z",
      importedBaseline: true,
    },
  ];

  test("2択を挟む（うっかり引き直さないため）", async () => {
    writeLedger(posted);

    await configurePostingSites(work);

    expect(redoPick()).toBeDefined();
    // 2択で取りやめたので、話の一覧までは進まない
    expect(episodePick()).toBeUndefined();
  });

  test("2択の題に「一覧から選びます」と書く（打っても消えない場所）", async () => {
    writeLedger(posted);

    await configurePostingSites(work);

    const redo = redoPick();
    expect(redo?.title).toContain("一覧から選びます");
    // 案内のほうも、数字を打つ欄ではないと言い切る
    expect(redo?.placeHolder).toContain("数字を打つ欄ではありません");
  });
});
