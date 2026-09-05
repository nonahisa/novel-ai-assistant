import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { configurePostingSites } from "../../src/features/postingKit";
import { POSTING_SITES, postingSiteInfo } from "../../src/models/posting";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * サイトごとの作品情報を訊く画面（設計書6.68.5）。
 *
 * **確かめるのは、作品IDの例がサイトごとに変わること。** 4サイトとも
 * `n1234ab`（なろうのNコード）を出していたころは、ほかのサイトで何を
 * 入れればよいのか分からなかった——とりわけ**アルファポリスの作品IDは
 * 「作者番号＋作品番号」の2部構成**で、片方だけでは作品を指せない
 * （URLを合成しない理由は `core/snsShare.ts` にある）。
 *
 * **サイトへは何も送らない**（6.68.1）。ここで動くのは入力欄だけである。
 */

const work: WorkEntry = {
  id: "work_profile",
  title: "星の在処",
  folderPath: path.join("C:", "novels", "profile"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

/** 投稿ページのURL（サイトごとにドメインが検証される） */
const newEpisodeUrl: Record<string, string> = {
  小説家になろう:
    "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  カクヨム: "https://kakuyomu.jp/my/works/16816927859/episodes/new",
  アルファポリス: "https://www.alphapolis.co.jp/novel/manage/123456/7890123",
  note: "https://note.com/notes/new",
};

const disk = new Map<string, Uint8Array>();
/** 出た入力欄（題と、そこに出した例） */
const asked: Array<{ title: string; placeHolder: string }> = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** 入力欄の題から、どのサイトのことかを読む */
function siteOfTitle(title: string): string {
  return (
    Object.keys(newEpisodeUrl).find((label) => title.startsWith(label)) ?? ""
  );
}

/** そのサイトの「作品ID」の欄に出した例 */
function workIdPlaceholder(label: string): string {
  return (
    asked.find((entry) => entry.title === `${label} での作品ID`)?.placeHolder ??
    ""
  );
}

describe("サイトごとの作品IDの入力案内", () => {
  beforeEach(() => {
    disk.clear();
    asked.length = 0;
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

    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          sites: [],
          siteProfiles: [],
          posts: [],
          rankings: [],
        })
      )
    );

    Object.assign(window, {
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInputBox: async (options: {
        title?: string;
        placeHolder?: string;
      }) => {
        const title = options.title ?? "";
        asked.push({ title, placeHolder: options.placeHolder ?? "" });
        // 投稿ページのURLだけは必須なので答える。ほかは空のまま飛ばす
        return title.includes("新規エピソード投稿ページ")
          ? newEpisodeUrl[siteOfTitle(title)]
          : "";
      },
    });
  });

  test("作品IDの例は、サイトごとに違う（なろうのNコードを使い回さない）", async () => {
    let round = 0;
    Object.assign(window, {
      showQuickPick: async (items: Array<Record<string, unknown>>) => {
        round += 1;
        // 1回目：出すサイト（複数選択）→4つとも選ぶ
        if (round === 1) return items;
        // 2回目：作品情報も入れるか→入れる
        if (round === 2) return items.find((item) => "detailed" in item);
        // 3回目：基準線の引き直し→しない
        return undefined;
      },
    });

    await configurePostingSites(work);

    // **4サイトとも、その場で意味の通る例が出る**
    expect(workIdPlaceholder("小説家になろう")).toContain("Nコード");
    expect(workIdPlaceholder("カクヨム")).toContain("作品ページURL");
    // アルファポリスは2部構成であることが読めること
    expect(workIdPlaceholder("アルファポリス")).toContain("作者番号");
    expect(workIdPlaceholder("アルファポリス")).toContain("作品番号");
    // noteには「作品」の単位が無い（空のままでよいと言い切る）
    expect(workIdPlaceholder("note")).toContain("空のまま");

    // 使い回していないこと（4つとも別の文言）
    const hints = POSTING_SITES.map((site) => site.workIdExample);
    expect(new Set(hints).size).toBe(POSTING_SITES.length);
    // 画面に出た例は、台帳の型が持つものと同じ（写しを作らない）
    for (const site of POSTING_SITES) {
      expect(workIdPlaceholder(site.label)).toBe(
        postingSiteInfo(site.id).workIdExample
      );
    }
  });
});
