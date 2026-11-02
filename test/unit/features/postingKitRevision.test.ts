import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { postNewEpisode } from "../../../src/features/postingKit";
import type { AIRegistry } from "../../../src/ai/registry";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { env, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 修正版の出し直し（作者の依頼 2026-11-03「修正後再投稿に対応してください」。設計書6.68.7）。
 *
 * 直す前は、**一部のサイトにだけ出した話を、出したサイトへもう一度出す道が無かった**。
 * 話を名指しで投稿すると未投稿のサイトだけを案内し、投稿済みのサイトは選べなかった。
 *
 * 出し直しは「新しい話を出した」とは数えない。台帳の `revisions` へ別に残し、
 * 未投稿の数（`posts`）を動かさない。開くのは新しい話の画面ではなく作品の管理画面
 * （新しい話の画面へ修正版を貼ると、同じ話が2本公開される）。
 */

const work: WorkEntry = {
  id: "work_revision",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "revision"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;
const episodePath = path.join(work.folderPath, "本文", "013_邂逅.txt");
const relativeEpisode = "本文/013_邂逅.txt";

const narouUrl = "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";
const kakuyomuUrl = "https://kakuyomu.jp/my/works/16816927859/episodes/new";
const alphapolisUrl = "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789";

const body = ["|漢字《かんじ》を直した。", "", "そして——歩き出した。"].join("\n");

const episode: EpisodeFile = {
  filePath: episodePath,
  fileName: "013_邂逅.txt",
  ext: ".txt",
  chapterStart: 13,
  chapterEnd: 13,
  subtitle: "邂逅",
  kind: "本編",
  isInitialName: false,
  counts: { gross: 0, net: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
  hasMetadata: false,
  metaTitle: null,
  declaredCharCount: null,
  metaUpdatedAt: null,
  hasConflictMarkers: false,
  collectedCount: null,
};

interface PickItem {
  label: string;
  [key: string]: unknown;
}

interface Captured {
  items: PickItem[];
  title: string;
  placeHolder: string;
  canPickMany: boolean;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(ledger: Record<string, unknown>): void {
  disk.set(ledgerPath, utf8(JSON.stringify({ schemaVersion: "1", rankings: [], ...ledger })));
}

function readLedger(): {
  posts: Array<Record<string, unknown>>;
  revisions?: Array<Record<string, unknown>>;
} {
  const bytes = disk.get(ledgerPath);
  if (!bytes) throw new Error("台帳が書かれていません");
  return JSON.parse(new TextDecoder().decode(bytes));
}

function stubQuickPick(answers: Array<(items: PickItem[]) => unknown>): Captured[] {
  const captured: Captured[] = [];
  let index = 0;
  Object.assign(window, {
    showQuickPick: async (
      items: PickItem[],
      options?: { placeHolder?: string; title?: string; canPickMany?: boolean }
    ) => {
      captured.push({
        items,
        title: options?.title ?? "",
        placeHolder: options?.placeHolder ?? "",
        canPickMany: options?.canPickMany === true,
      });
      const answer = answers[index++];
      return answer ? answer(items) : undefined;
    },
  });
  return captured;
}

const byKey = (key: string, value: string) => (items: PickItem[]) =>
  items.find((item) => item[key] === value);

/** 一部のサイトへ出した台帳：カクヨムへは出した、なろうはまだ */
const PARTLY_POSTED = {
  sites: [
    { site: "narou", newEpisodeUrl: narouUrl },
    { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
  ],
  siteProfiles: [{ site: "kakuyomu", workId: "16816927859" }],
  posts: [{ episodePath: relativeEpisode, site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z" }],
};

describe("修正版の出し直し", () => {
  beforeEach(() => {
    disk.clear();
    informed.length = 0;
    warned.length = 0;
    env.clipboard.text = "";
    env.opened.length = 0;
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk);
    Object.assign(window, {
      showInformationMessage: async (message: string) => {
        informed.push(message);
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        warned.push(message);
        return undefined;
      },
      showErrorMessage: async () => undefined,
    });
    disk.set(Uri.file(episodePath).fsPath, utf8(body));
  });

  test("一部のサイトに出した話を、出したサイトへ出し直せる（再現：直す前は未投稿のなろうしか案内しなかった）", async () => {
    writeLedger(PARTLY_POSTED);
    const picks = stubQuickPick([
      // 未投稿のサイトへ出すか、投稿済みのサイトへ出し直すか
      byKey("mode", "revise"),
      // 出し直すサイト（投稿済みのカクヨムだけが並ぶ）
      (items) => items.filter((item) => item.site === "kakuyomu"),
      // カクヨムの案内で「出し直しました」
      byKey("answer", "revised"),
    ]);

    const result = await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(result.changed).toBe(true);

    // サイトを選ぶ画面には、投稿済みのサイトだけが並ぶ（未投稿のなろうは出さない）
    const sitePick = picks.find((pick) => pick.canPickMany);
    expect(sitePick?.items.map((item) => item.site)).toEqual(["kakuyomu"]);

    // カクヨムの案内が出る。題に「修正版」と書いて、新しい話の案内と見分けられる
    const walk = picks[2];
    expect(walk.title).toContain("カクヨム");
    expect(walk.title).toContain("修正版");
    // 編集画面を開いて貼り替える、と言う
    expect(walk.placeHolder).toContain("編集画面");

    // **新しい話の画面は開かない**（修正版を貼ると同じ話が2本公開される）。作品の管理画面を開く
    expect(env.opened).not.toContain(kakuyomuUrl);
    expect(env.opened).toContain("https://kakuyomu.jp/my/works/16816927859");

    // 本文は今の変換を通したもの（カクヨムの記法のまま）
    expect(env.clipboard.text).toBe(body);

    // 記録は出し直しの欄へ。投稿の記録は1件のまま（日時も変えない）
    const ledger = readLedger();
    expect(ledger.posts).toEqual(PARTLY_POSTED.posts);
    expect(ledger.revisions).toHaveLength(1);
    expect(ledger.revisions?.[0]).toMatchObject({ episodePath: relativeEpisode, site: "kakuyomu" });
    expect(typeof ledger.revisions?.[0].revisedAt).toBe("string");

    // 告知の誘いは出さない（新しい話ではない）
    expect(picks.some((pick) => pick.title === "投稿おつかれさまでした")).toBe(false);
    expect(informed.join("\n")).toContain("修正版");
  });

  test("出し直しでは「ヘルパーへ渡す形でコピー」を出さない（ヘルパーは新しい話の画面にしか貼らない）", async () => {
    writeLedger(PARTLY_POSTED);
    const picks = stubQuickPick([
      byKey("mode", "revise"),
      (items) => items,
      () => undefined,
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(picks[2].items.some((item) => item.answer === "envelope")).toBe(false);
    // サブタイトルのコピーは同じく出す
    expect(picks[2].items.some((item) => item.answer === "subtitle")).toBe(true);
  });

  test("一部のサイトに出した話で「未投稿のサイトへ出す」を選ぶと、今までどおり未投稿のサイトを案内する", async () => {
    writeLedger(PARTLY_POSTED);
    const picks = stubQuickPick([
      byKey("mode", "post"),
      byKey("answer", "posted"),
      // 告知は作らない
      () => undefined,
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);

    // 先頭は「未投稿のサイトへ出す」（今までの既定を変えない）
    expect(picks[0].items[0].mode).toBe("post");
    expect(picks[1].title).toContain("小説家になろう");
    expect(picks[1].title).not.toContain("修正版");
    expect(env.opened).toContain(narouUrl);
    const ledger = readLedger();
    expect(ledger.posts).toHaveLength(2);
    expect(ledger.revisions).toBeUndefined();
  });

  test("まだどこにも出していない話では、出し直しを訊かずに今までどおり案内する", async () => {
    writeLedger({ ...PARTLY_POSTED, posts: [] });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(picks[0].items.some((item) => "mode" in item)).toBe(false);
    expect(picks[0].title).toContain("小説家になろう");
  });

  test("全部のサイトに出した話では、出し直しを先頭に出し、投稿済みのサイトすべてを選べる", async () => {
    writeLedger({
      ...PARTLY_POSTED,
      posts: [
        ...PARTLY_POSTED.posts,
        { episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z" },
      ],
    });
    const picks = stubQuickPick([
      byKey("mode", "revise"),
      (items) => items.filter((item) => item.site === "narou"),
      byKey("answer", "revised"),
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);

    expect(picks[0].items[0].mode).toBe("revise");
    expect(picks[1].items.map((item) => item.site)).toEqual(["narou", "kakuyomu"]);
    // 既定で全部に印が付いている（直した話は、出したサイトすべてで直すのがふつう）
    expect(picks[1].items.every((item) => item.picked === true)).toBe(true);

    // なろうは管理画面の形を確かめていないので、何も開かない（推測のURLを開かせない）。
    // 代わりに、どこを開けばよいかを言う
    expect(env.opened).toEqual([]);
    expect(picks[2].placeHolder).toContain("第13話");
    expect(picks[2].placeHolder).toContain("編集画面");

    const ledger = readLedger();
    expect(ledger.posts).toHaveLength(2);
    expect(ledger.revisions?.map((record) => record.site)).toEqual(["narou"]);
  });

  test("全部のサイトに出した話で「新しい話としてもう一度出す」を選ぶと、今までどおり全サイトを案内する", async () => {
    writeLedger({
      ...PARTLY_POSTED,
      posts: [
        ...PARTLY_POSTED.posts,
        { episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z" },
      ],
    });
    const picks = stubQuickPick([byKey("mode", "repost"), () => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(picks[1].title).toContain("小説家になろう");
    expect(picks[1].title).not.toContain("修正版");
    expect(env.opened).toContain(narouUrl);
  });

  test("アルファポリスは作品の管理画面（/mypage/content/detail/9桁）を開く", async () => {
    writeLedger({
      sites: [{ site: "alphapolis", newEpisodeUrl: alphapolisUrl }],
      posts: [{ episodePath: relativeEpisode, site: "alphapolis", postedAt: "2026-10-01T00:00:00.000Z" }],
    });
    stubQuickPick([byKey("mode", "revise"), (items) => items, byKey("answer", "skip")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(env.opened).toEqual(["https://www.alphapolis.co.jp/mypage/content/detail/123456789"]);
    // 飛ばしたら記録しない
    expect(readLedger().revisions).toBeUndefined();
  });

  test("出し直しを2回記録しても、同じ話・同じサイトの記録は1件に保つ（日時は新しいほう）", async () => {
    writeLedger({
      ...PARTLY_POSTED,
      revisions: [{ episodePath: relativeEpisode, site: "kakuyomu", revisedAt: "2026-10-05T00:00:00.000Z" }],
    });
    stubQuickPick([byKey("mode", "revise"), (items) => items, byKey("answer", "revised")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    const revisions = readLedger().revisions ?? [];
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revisedAt).not.toBe("2026-10-05T00:00:00.000Z");
  });
});
