import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { postNewEpisode } from "../../../src/features/postingKit";
import type { AIRegistry } from "../../../src/ai/registry";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { env, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import {
  postingNotationTextHash,
  postingTextHash,
  postingTitleHash,
} from "../../../src/core/postingBodyHash";

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
    // 出し直しは新しい話を投稿したとは数えない（作者の裁定 2026-11-03 夜）
    expect(result.postedNew).toBe(false);

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

  /** 両方のサイトへ出した台帳 */
  const ALL_POSTED = {
    ...PARTLY_POSTED,
    posts: [
      ...PARTLY_POSTED.posts,
      { episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z" },
    ],
  };

  test("全部のサイトに出した話では、出し方を訊かずに出し直しのサイト選びへ進み、投稿済みのサイトすべてを選べる", async () => {
    writeLedger(ALL_POSTED);
    const picks = stubQuickPick([
      (items) => items.filter((item) => item.site === "narou"),
      byKey("answer", "revised"),
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);

    // 最初の画面がサイト選び（出し方の画面は出さない。選べることが出し直ししか無い）
    expect(picks[0].canPickMany).toBe(true);
    expect(picks[0].items.map((item) => item.site)).toEqual(["narou", "kakuyomu"]);
    expect(picks[0].placeHolder).toContain("すべてへ投稿済み");
    // 印の無い記録だけなので、直したサイトは分からない → 既定で全部に印
    expect(picks[0].items.every((item) => item.picked === true)).toBe(true);

    // なろうの管理画面は数字の小説番号で作品を指す。番号がまだ届いていないので、
    // 番号の要らない「自分の作品の一覧」を開き、そこから選ぶよう言う（作者の答え 2026-11-03 昼）
    expect(env.opened).toEqual(["https://syosetu.com/usernovel/list/"]);
    expect(picks[1].placeHolder).toContain("作品の一覧");
    expect(picks[1].placeHolder).toContain("第13話");
    expect(picks[1].placeHolder).toContain("編集画面");
    expect(picks[1].items.some((item) => item.label.includes("作品の一覧をもう一度開く"))).toBe(true);

    const ledger = readLedger();
    expect(ledger.posts).toHaveLength(2);
    expect(ledger.revisions?.map((record) => record.site)).toEqual(["narou"]);
  });

  test("全部のサイトに出した話で「新しい話としてもう一度すべてのサイトへ出す」は出さない（作者の裁定 2026-11-03 昼）", async () => {
    writeLedger(ALL_POSTED);
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    const labels = picks.flatMap((pick) => pick.items.map((item) => item.label));
    expect(labels.some((label) => label.includes("新しい話としてもう一度"))).toBe(false);
    expect(picks.some((pick) => pick.items.some((item) => item.mode === "repost"))).toBe(false);
    // 新しい話の投稿ページは開かない
    expect(env.opened).toEqual([]);
  });

  test("アルファポリスは作品の管理画面（/mypage/content/detail/9桁）を開く", async () => {
    writeLedger({
      sites: [{ site: "alphapolis", newEpisodeUrl: alphapolisUrl }],
      posts: [{ episodePath: relativeEpisode, site: "alphapolis", postedAt: "2026-10-01T00:00:00.000Z" }],
    });
    stubQuickPick([(items) => items, byKey("answer", "skip")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(env.opened).toEqual(["https://www.alphapolis.co.jp/mypage/content/detail/123456789"]);
    // 飛ばしたら記録しない
    expect(readLedger().revisions).toBeUndefined();
  });

  test("サイトの話の番号が記録にあれば、話の編集画面を直に開く（カクヨム・アルファポリス）", async () => {
    writeLedger({
      sites: [
        { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
        { site: "alphapolis", newEpisodeUrl: alphapolisUrl },
      ],
      siteProfiles: [{ site: "kakuyomu", workId: "16816927859" }],
      posts: [
        { episodePath: relativeEpisode, site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z", siteEpisodeId: "16816927860" },
        { episodePath: relativeEpisode, site: "alphapolis", postedAt: "2026-10-01T00:00:00.000Z", siteEpisodeId: "987654" },
      ],
    });
    const picks = stubQuickPick([(items) => items, byKey("answer", "skip"), byKey("answer", "skip")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(env.opened).toEqual([
      "https://kakuyomu.jp/my/works/16816927859/episodes/16816927860",
      "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789/987654",
    ]);
    expect(picks[1].placeHolder).toContain("開いた第13話の編集画面");
    expect(picks[1].items.some((item) => item.label.includes("話の編集画面をもう一度開く"))).toBe(true);
  });

  test("出し直しを2回記録すると、同じ話・同じサイトでも履歴として2件残る（作者の裁定 2026-11-03 昼）", async () => {
    writeLedger({
      ...PARTLY_POSTED,
      revisions: [{ episodePath: relativeEpisode, site: "kakuyomu", revisedAt: "2026-10-05T00:00:00.000Z" }],
    });
    const picks = stubQuickPick([byKey("mode", "revise"), (items) => items, byKey("answer", "revised")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    const revisions = readLedger().revisions ?? [];
    expect(revisions).toHaveLength(2);
    expect(revisions[0].revisedAt).toBe("2026-10-05T00:00:00.000Z");
    expect(revisions[1].revisedAt).not.toBe("2026-10-05T00:00:00.000Z");
    // サイト選びの画面には最新の出し直しだけを添える（履歴は並べない）
    const sitePick = picks.find((pick) => pick.canPickMany);
    const description = String(sitePick?.items[0].description ?? "");
    expect(description).toContain("修正版 2026-10-05");
    expect(description.match(/修正版/g)).toHaveLength(1);
  });

  test("投稿と出し直しの記録に、そのときの本文の印を残す（6.68.7）", async () => {
    writeLedger(PARTLY_POSTED);
    stubQuickPick([byKey("mode", "post"), byKey("answer", "posted"), () => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    const posted = readLedger().posts.find((post) => post.site === "narou");
    expect(posted?.bodyHash).toBe(postingNotationTextHash("邂逅", body));

    stubQuickPick([(items) => items, byKey("answer", "revised"), byKey("answer", "revised")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    const revisions = readLedger().revisions ?? [];
    expect(revisions).toHaveLength(2);
    expect(revisions.every((record) => record.bodyHash === postingNotationTextHash("邂逅", body))).toBe(true);
  });

  test("話を名指ししたとき、投稿のあとに直したサイトだけに既定で印を付け、そう添える", async () => {
    writeLedger({
      ...ALL_POSTED,
      posts: [
        { episodePath: relativeEpisode, site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z", bodyHash: postingTextHash("邂逅", "直す前の本文") },
        { episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z", bodyHash: postingTextHash("邂逅", body) },
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    const kakuyomu = picks[0].items.find((item) => item.site === "kakuyomu");
    const narou = picks[0].items.find((item) => item.site === "narou");
    expect(kakuyomu?.picked).toBe(true);
    expect(String(kakuyomu?.description)).toContain("投稿後に直しています");
    expect(narou?.picked).toBe(false);
  });

  test("題（サブタイトル）だけ直した話も「投稿後に直しています」と言う（作者の答え 2026-11-03 昼）", async () => {
    writeLedger({
      ...ALL_POSTED,
      posts: [
        // 本文は同じで、投稿したときの題は「出会い」だった（いまのファイル名の題は「邂逅」）
        { episodePath: relativeEpisode, site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z", bodyHash: postingTextHash("出会い", body) },
        { episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z", bodyHash: postingTextHash("邂逅", body) },
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(picks[0].items.find((item) => item.site === "kakuyomu")?.picked).toBe(true);
    expect(picks[0].items.find((item) => item.site === "narou")?.picked).toBe(false);
  });

  test("なろうは小説番号が台帳にあれば作品の管理画面を、話の番号もあれば話の編集画面を開く", async () => {
    writeLedger({
      sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
      siteFacts: [{ site: "narou", siteWorkNumber: "2930206", siteWorkNumberAt: "2026-11-03T00:00:00.000Z" }],
      posts: [{ episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z" }],
    });
    stubQuickPick([(items) => items, byKey("answer", "skip")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(env.opened).toEqual(["https://syosetu.com/usernovelmanage/top/ncode/2930206/"]);

    env.opened.length = 0;
    writeLedger({
      sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
      siteFacts: [{ site: "narou", siteWorkNumber: "2930206", siteWorkNumberAt: "2026-11-03T00:00:00.000Z" }],
      posts: [{ episodePath: relativeEpisode, site: "narou", postedAt: "2026-10-01T00:00:00.000Z", siteEpisodeId: "12345" }],
    });
    stubQuickPick([(items) => items, byKey("answer", "skip")]);
    await postNewEpisode(work, {} as unknown as AIRegistry, episode);
    expect(env.opened).toEqual([
      "https://syosetu.com/usernoveldatamanage/updateinput/ncode/2930206/noveldataid/12345/",
    ]);
  });

  /*
    **題を直した話の出し直しでは、題の貼り替えも案内する**（作者の裁定 2026-11-03 夜）。
    題と本文の印（`v2:`）は1つに繋いだ値なので、違っても「題か本文のどちらか」までしか
    分からない。題だけの印（`titleHash`）を記録に持ち、最後に渡した記録の題の印と比べる。
  */
  describe("題の貼り替えの案内", () => {
    const TITLE_HINT = "題（サブタイトル）も貼り替えてください";
    const postedWith = (site: string, extra: Record<string, unknown>) => ({
      episodePath: relativeEpisode,
      site,
      postedAt: "2026-10-01T00:00:00.000Z",
      ...extra,
    });
    /** 全部のサイトへ出した話でカクヨムだけを出し直し、その案内（2つ目の画面）を返す */
    async function walkKakuyomu(posts: unknown[], revisions?: unknown[]): Promise<Captured> {
      writeLedger({ ...ALL_POSTED, posts, ...(revisions ? { revisions } : {}) });
      const picks = stubQuickPick([
        (items) => items.filter((item) => item.site === "kakuyomu"),
        () => undefined,
      ]);
      await postNewEpisode(work, {} as unknown as AIRegistry, episode);
      expect(picks[1].title).toContain("修正版");
      return picks[1];
    }

    test("投稿したときの題と今の題が違えば、題の貼り替えも添える（再現：直す前は本文だけを案内した）", async () => {
      const walk = await walkKakuyomu([
        postedWith("kakuyomu", {
          bodyHash: postingTextHash("出会い", body),
          titleHash: postingTitleHash("出会い"),
        }),
        postedWith("narou", {}),
      ]);
      expect(walk.placeHolder).toContain(TITLE_HINT);
      expect(walk.placeHolder).toContain("本文を貼り替えてください");
    });

    test("題が同じ（本文だけ直した）話には添えない", async () => {
      const walk = await walkKakuyomu([
        postedWith("kakuyomu", {
          bodyHash: postingTextHash("邂逅", "直す前の本文"),
          titleHash: postingTitleHash("邂逅"),
        }),
        postedWith("narou", {}),
      ]);
      expect(walk.placeHolder).toContain("本文を貼り替えてください");
      expect(walk.placeHolder).not.toContain(TITLE_HINT);
    });

    test("題の印の無い古い記録（0.125.1 まで）では、分からないので添えない", async () => {
      // 題と本文の印からは題が違うと見えても、題だけが違うのかは分からない
      const walk = await walkKakuyomu([
        postedWith("kakuyomu", { bodyHash: postingTextHash("出会い", body) }),
        postedWith("narou", {}),
      ]);
      expect(walk.placeHolder).not.toContain(TITLE_HINT);
    });

    test("最後に渡したのが出し直しなら、その題と比べる（古い投稿の題へ遡らない）", async () => {
      const walk = await walkKakuyomu(
        [postedWith("kakuyomu", { titleHash: postingTitleHash("出会い") }), postedWith("narou", {})],
        [
          {
            episodePath: relativeEpisode,
            site: "kakuyomu",
            revisedAt: "2026-10-20T00:00:00.000Z",
            titleHash: postingTitleHash("邂逅"),
          },
        ]
      );
      expect(walk.placeHolder).not.toContain(TITLE_HINT);
    });

    test("最後の出し直しに題の印が無ければ、投稿の記録の題へ遡らず添えない", async () => {
      const walk = await walkKakuyomu(
        [postedWith("kakuyomu", { titleHash: postingTitleHash("出会い") }), postedWith("narou", {})],
        [{ episodePath: relativeEpisode, site: "kakuyomu", revisedAt: "2026-10-20T00:00:00.000Z" }]
      );
      expect(walk.placeHolder).not.toContain(TITLE_HINT);
    });

    test("投稿と出し直しの記録に、そのときの題の印を残す", async () => {
      writeLedger(PARTLY_POSTED);
      stubQuickPick([byKey("mode", "post"), byKey("answer", "posted"), () => undefined]);
      await postNewEpisode(work, {} as unknown as AIRegistry, episode);
      expect(readLedger().posts.find((post) => post.site === "narou")?.titleHash).toBe(
        postingTitleHash("邂逅")
      );

      stubQuickPick([(items) => items.filter((item) => item.site === "narou"), byKey("answer", "revised")]);
      await postNewEpisode(work, {} as unknown as AIRegistry, episode);
      expect(readLedger().revisions?.[0].titleHash).toBe(postingTitleHash("邂逅"));
    });
  });
});
