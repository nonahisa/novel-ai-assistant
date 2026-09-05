import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { offerAnnouncementActions } from "../../src/features/generateAnnouncement";
import { X_SHARE_LABEL } from "../../src/core/snsShare";
import type { WorkEntry } from "../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * 更新告知の結果画面から、Xの投稿画面を開く配線（設計書6.79.8）。
 *
 * **確かめるのは3つ。** 選択肢が出ること、`openExternal` へ渡るURLの形
 * （Web Intentに告知文と作品の一覧URLだけが載る）、そして**投稿ボタンは
 * 作者が押す**という案内が出ること。
 *
 * **Xへ投稿はしない。** この機能が外へ出るのはクリップボードと
 * 「ブラウザで開く」の2つだけである（6.68.1と同じ線）。
 */

const work: WorkEntry = {
  id: "work_share",
  title: "図書塔の魔女",
  folderPath: path.join("C:", "novels", "share"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

/** 告知の3種。X用には作者がURLを設定していないときの目印が入っている */
const texts = {
  x: "第13話「邂逅」 更新しました\n塔の内側の話です。\n#創作\n{URL}",
  activityReport: "活動報告用の文です。",
  afterword: "後書き用の文です。",
};

/** なろうとカクヨムの両方でURLを決められる台帳（登録の並びはカクヨムが先） */
const twoSiteLedger = {
  schemaVersion: "1",
  sites: [
    {
      site: "kakuyomu",
      newEpisodeUrl: "https://kakuyomu.jp/my/works/16816927859/episodes/new",
    },
    {
      site: "narou",
      newEpisodeUrl:
        "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
    },
  ],
  siteProfiles: [
    { site: "narou", workId: "n1234ab" },
    { site: "kakuyomu", workId: "16816927859" },
  ],
  posts: [],
  rankings: [],
};

const disk = new Map<string, Uint8Array>();
/** 出た知らせ（文言と、並んだボタン） */
const notices: Array<{ message: string; buttons: string[] }> = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(value: unknown): void {
  disk.set(ledgerPath, utf8(JSON.stringify(value)));
}

/**
 * 通知の答え方。**押したボタンを順に返す。**
 *
 * `undefined` は「閉じた（Esc・×）」——結果画面はそこで終わる。
 */
function stubNotifications(answers: Array<string | undefined>): void {
  let index = 0;
  Object.assign(window, {
    showInformationMessage: async (message: string, ...items: unknown[]) => {
      notices.push({ message, buttons: items.map(String) });
      return answers[index++];
    },
  });
}

/** 選択画面の答え方。渡された項目を覚えてから、1つ返す */
function stubQuickPick(
  answer: (items: Array<Record<string, unknown>>) => unknown
): Array<Array<Record<string, unknown>>> {
  const captured: Array<Array<Record<string, unknown>>> = [];
  Object.assign(window, {
    showQuickPick: async (items: Array<Record<string, unknown>>) => {
      captured.push(items);
      return answer(items);
    },
  });
  return captured;
}

/** Intent URL に載った投稿文を取り出す */
function sharedText(): string {
  const opened = env.opened[0];
  expect(opened).toBeTruthy();
  return new URL(opened).searchParams.get("text") ?? "";
}

describe("Xへ貼り付ける", () => {
  beforeEach(() => {
    disk.clear();
    notices.length = 0;
    env.clipboard.text = "";
    env.opened.length = 0;
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
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;

    Object.assign(window, {
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
    });

    writeLedger({
      schemaVersion: "1",
      sites: [
        {
          site: "narou",
          newEpisodeUrl:
            "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
        },
      ],
      siteProfiles: [{ site: "narou", workId: "n1234ab" }],
      posts: [],
      rankings: [],
    });
  });

  test("結果画面に、コピーと並んで貼り付けの選択肢が出る", async () => {
    stubNotifications([undefined]);

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    expect(notices[0].buttons).toContain("X用をコピー");
    expect(notices[0].buttons).toContain(X_SHARE_LABEL);
  });

  test("台帳の作品IDから、作品の各話一覧のURLを載せて開く", async () => {
    stubNotifications([X_SHARE_LABEL, undefined]);

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    const text = sharedText();
    // **各話への直接リンクにしない**（作者の指定、6.79.8）
    expect(text).toContain("https://ncode.syosetu.com/n1234ab/");
    // 目印を残したまま貼らない
    expect(text).not.toContain("{URL}");
    expect(text).toContain("第13話「邂逅」 更新しました");
    // 載せるのは告知文だけ（余計な引数を足さない）
    expect([...new URL(env.opened[0]).searchParams.keys()]).toEqual(["text"]);

    // **投稿ボタンは作者が押す**（6.79.2の一線）
    expect(
      notices.some((notice) => notice.message.includes("ご自身"))
    ).toBe(true);
  });

  test("URLを決められない作品では、手入力で受ける", async () => {
    // 作品IDも作品ページURLも入れていない台帳
    writeLedger({
      schemaVersion: "1",
      sites: [
        {
          site: "narou",
          newEpisodeUrl:
            "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
        },
      ],
      posts: [],
      rankings: [],
    });
    stubNotifications([X_SHARE_LABEL, undefined]);
    Object.assign(window, {
      showInputBox: async () => "https://kakuyomu.jp/works/16816927859",
    });

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    expect(sharedText()).toContain("https://kakuyomu.jp/works/16816927859");
  });

  test("手入力を空のまま確定したら、URL無しで文だけ貼る", async () => {
    disk.delete(ledgerPath);
    stubNotifications([X_SHARE_LABEL, undefined]);
    Object.assign(window, { showInputBox: async () => "" });

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    const text = sharedText();
    expect(text).not.toContain("{URL}");
    expect(text).not.toContain("http");
    expect(text).toContain("塔の内側の話です。");
  });

  test("手入力を取りやめたら、何も開かない", async () => {
    disk.delete(ledgerPath);
    // 1回目でXを選び、取りやめたあと2回目で閉じる
    stubNotifications([X_SHARE_LABEL, undefined]);
    Object.assign(window, { showInputBox: async () => undefined });

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    expect(env.opened).toHaveLength(0);
    // **選択肢は残す**（取りやめただけなので、もう一度押せる）
    expect(notices[1].buttons).toContain(X_SHARE_LABEL);
  });

  test("URLを作れるサイトが複数あれば、どれを載せるか選ばせる", async () => {
    writeLedger(twoSiteLedger);
    stubNotifications([X_SHARE_LABEL, undefined]);
    const picks = stubQuickPick((items) =>
      items.find((item) => item.url === "https://kakuyomu.jp/works/16816927859")
    );

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    // 並びは投稿サイトの一覧（なろう→カクヨム）に揃える
    expect(picks[0][0].url).toBe("https://ncode.syosetu.com/n1234ab/");
    expect(sharedText()).toContain("https://kakuyomu.jp/works/16816927859");
  });

  test("告知文に既にURLが入っていれば、URLを訊かない", async () => {
    // 告知の設定でURLを入れてある作品。訊いても答えは使いようがない。
    // **URLを決められるサイトが2つある台帳**で確かめる——1つだけの台帳では、
    // 訊かずに決まる経路と見分けが付かない
    writeLedger(twoSiteLedger);
    stubNotifications([X_SHARE_LABEL, undefined]);
    let asked = false;
    Object.assign(window, {
      showInputBox: async () => {
        asked = true;
        return undefined;
      },
    });
    const picks = stubQuickPick(() => {
      asked = true;
      return undefined;
    });

    await offerAnnouncementActions({
      work,
      texts: {
        ...texts,
        x: "第13話「邂逅」 更新しました\n塔の内側の話です。\nhttps://example.com/works/1",
      },
      warningCount: 0,
    });

    expect(asked).toBe(false);
    expect(picks).toHaveLength(0);
    expect(sharedText()).toContain("https://example.com/works/1");
  });

  test("コピーは今までどおり動く（貼り付けを足しても壊さない）", async () => {
    stubNotifications(["活動報告用をコピー", undefined]);

    await offerAnnouncementActions({ work, texts, warningCount: 0 });

    expect(env.clipboard.text).toBe(texts.activityReport);
    // 押したものは並べ直さない
    expect(notices[1].buttons).not.toContain("活動報告用をコピー");
  });
});
