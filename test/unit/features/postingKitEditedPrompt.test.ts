import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AIRegistry } from "../../../src/ai/registry";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { postingBodyHash, postingTextHash } from "../../../src/core/postingBodyHash";
import { env, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 作品から投稿を始めたとき、投稿のあとに本文を直した話があれば出し直しを促す
 * （設計書6.68.7。作者の裁定 2026-11-03 昼「『投稿』ボタンを押した時に再投稿を促すように」）。
 *
 * 新しい入口（命令・品書き）は足さない。作品の「新話投稿」を押したときだけ、話を選ぶ前に促す。
 * **直していない話では1手も増やさない**（見逃しと誤検出の両方を見る）。
 *
 * 走査（`scanWork`）は作品の本文を全部読むので、ここでは話の一覧だけを差し替える。
 */

const work: WorkEntry = {
  id: "work_edited",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "edited"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;

function episodeFile(chapter: number, name: string, collected = false): EpisodeFile {
  return {
    filePath: path.join(work.folderPath, "本文", name),
    fileName: name,
    ext: ".txt",
    chapterStart: chapter,
    chapterEnd: collected ? chapter + 1 : chapter,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: { gross: 0, net: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: collected ? 2 : null,
  };
}

const ep1 = episodeFile(1, "001.txt");
const ep2 = episodeFile(2, "002.txt");
const ep3 = episodeFile(3, "003.txt");

const episodes: { list: EpisodeFile[] } = { list: [ep1, ep2, ep3] };

vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({ episodes: episodes.list }),
}));

// 差し替えのあとで読む（`postingKit` が差し替えた走査を使うように）
const { postNewEpisode } = await import("../../../src/features/postingKit");

const kakuyomuUrl = "https://kakuyomu.jp/my/works/16816927859/episodes/new";
const narouUrl = "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeFile(file: EpisodeFile, text: string): void {
  disk.set(Uri.file(file.filePath).fsPath, utf8(text));
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

const SITES = [
  { site: "narou", newEpisodeUrl: narouUrl },
  { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
];

const posted = (episodePath: string, site: string, text?: string) => ({
  episodePath,
  site,
  postedAt: "2026-10-01T00:00:00.000Z",
  // 題の無い話（ファイル名にも中にも題が無い）の、題と本文の印（0.124.1 の取り方）
  ...(text !== undefined ? { bodyHash: postingTextHash(null, text) } : {}),
});

describe("作品から投稿を始めたときの、出し直しの促し", () => {
  beforeEach(() => {
    disk.clear();
    informed.length = 0;
    episodes.list = [ep1, ep2, ep3];
    env.clipboard.text = "";
    env.opened.length = 0;
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk);
    Object.assign(window, {
      showInformationMessage: async (message: string) => {
        informed.push(message);
        return undefined;
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    });
    writeFile(ep1, "　一話目。");
    writeFile(ep2, "　二話目を直した。");
    writeFile(ep3, "　三話目。");
  });

  test("投稿のあとに直した話があれば、話を選ぶ前に「第2話は投稿後に直しています。出し直しますか」と促す", async () => {
    writeLedger({
      sites: SITES,
      posts: [
        posted("本文/001.txt", "narou", "　一話目。"),
        posted("本文/001.txt", "kakuyomu", "　一話目。"),
        // 第2話は投稿したあとに本文を直した（カクヨムだけ印あり、なろうは印の無い古い記録）
        posted("本文/002.txt", "narou"),
        posted("本文/002.txt", "kakuyomu", "　二話目。"),
      ],
    });
    const picks = stubQuickPick([
      (items) => items.find((item) => typeof item.label === "string" && item.label.includes("第2話")),
      // サイト選び：既定の印のまま
      (items) => items.filter((item) => item.picked === true),
      (items) => items.find((item) => item.answer === "revised"),
    ]);
    const result = await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(result.changed).toBe(true);
    /*
      **出し直しだけで終えた回は、新しい話を投稿したとは数えない**（作者の裁定 2026-11-03 夜）。
      再現：直す前は台帳が変わっただけで「済んだ」になり、はじめの案内などの手順が先へ進んだ
    */
    expect(result.postedNew).toBe(false);

    expect(picks[0].placeHolder).toBe("第2話は投稿後に直しています。出し直しますか");
    // 直していない第1話は並べない（誤検出しない）
    expect(picks[0].items.some((item) => item.label.includes("第1話"))).toBe(false);

    // サイト選び：印で直したと分かったカクヨムだけに既定の印。なろうは「分からない」
    const sitePick = picks[1];
    expect(sitePick.canPickMany).toBe(true);
    expect(sitePick.items.find((item) => item.site === "kakuyomu")?.picked).toBe(true);
    expect(sitePick.items.find((item) => item.site === "narou")?.picked).toBe(false);

    // カクヨムの作品の管理画面を開き、今の本文をコピーする。新しい話の投稿ページは開かない
    expect(env.opened).toEqual(["https://kakuyomu.jp/my/works/16816927859"]);
    expect(env.clipboard.text).toBe("　二話目を直した。");

    // 出し直しの記録に今の本文の印。投稿の記録は増えない
    const ledger = readLedger();
    expect(ledger.posts).toHaveLength(4);
    expect(ledger.revisions).toEqual([
      expect.objectContaining({
        episodePath: "本文/002.txt",
        site: "kakuyomu",
        bodyHash: postingTextHash(null, "　二話目を直した。"),
      }),
    ]);

    // 未投稿の第3話が残っているので、続けて新しい話を投稿するかを訊く（答えずに閉じたので、そこで終わる）
    expect(picks[3].title).toBe("続けて新しい話を投稿しますか");
    expect(picks).toHaveLength(4);
  });

  test("出し直しのあと「続けて新しい話を投稿する」を選ぶと、未投稿の第3話へ進み、出し直しの記録も消えない", async () => {
    writeLedger({
      sites: SITES,
      posts: [
        posted("本文/001.txt", "narou", "　一話目。"),
        posted("本文/001.txt", "kakuyomu", "　一話目。"),
        posted("本文/002.txt", "narou", "　二話目。"),
        posted("本文/002.txt", "kakuyomu", "　二話目。"),
      ],
    });
    const picks = stubQuickPick([
      (items) => items.find((item) => item.label.includes("第2話")),
      (items) => items.filter((item) => item.site === "kakuyomu"),
      (items) => items.find((item) => item.answer === "revised"),
      (items) => items.find((item) => item.proceed === true),
      // 第3話をなろうへ
      (items) => items.find((item) => item.answer === "posted"),
      // カクヨムは飛ばす
      (items) => items.find((item) => item.answer === "skip"),
      // 告知は作らない
      () => undefined,
    ]);
    const result = await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(result.changed).toBe(true);
    // 出し直しに続けて第3話を出したので、新しい話を投稿したと数える
    expect(result.postedNew).toBe(true);
    expect(picks[4].title).toContain("第3話");
    expect(picks[4].title).toContain("小説家になろう");
    const ledger = readLedger();
    expect(ledger.revisions).toHaveLength(1);
    expect(ledger.posts).toContainEqual(
      expect.objectContaining({ episodePath: "本文/003.txt", site: "narou", bodyHash: postingTextHash(null, "　三話目。") })
    );
  });

  test("出し直しを途中で中止したら、続けるかを訊かない", async () => {
    writeLedger({
      sites: SITES,
      posts: [posted("本文/002.txt", "narou", "　二話目。"), posted("本文/002.txt", "kakuyomu", "　二話目。")],
    });
    const picks = stubQuickPick([
      (items) => items.find((item) => item.label.includes("第2話")),
      (items) => items,
      (items) => items.find((item) => item.label.includes("中止")),
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks.some((pick) => pick.title === "続けて新しい話を投稿しますか")).toBe(false);
  });

  test("題だけ直した話も促す", async () => {
    // 中の【タイトル】を直した（本文は同じ）
    writeFile(ep2, ["【タイトル】", "別れの朝", "", "【本文】", "　二話目。"].join("\n"));
    writeLedger({
      sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
      posts: [{ ...posted("本文/002.txt", "kakuyomu"), bodyHash: postingTextHash("別れ", "　二話目。") }],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).toBe("投稿のあとに直した話があります");
    expect(picks[0].placeHolder).toContain("第2話");
  });

  test("0.124.0 の印（本文だけ）は、本文が違えば促し、同じなら題が分からないので促さない", async () => {
    writeLedger({
      sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
      posts: [
        { ...posted("本文/001.txt", "kakuyomu"), bodyHash: postingBodyHash("　一話目。") },
        { ...posted("本文/002.txt", "kakuyomu"), bodyHash: postingBodyHash("　二話目。") },
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).toBe("投稿のあとに直した話があります");
    const offered = picks[0].items.filter((item) => item.label.includes("出し直す"));
    expect(offered.map((item) => item.label)).toEqual([expect.stringContaining("第2話")]);
  });

  test("出し直したあとは、同じ話をもう促さない（最新の出し直しの印と比べる）", async () => {
    writeLedger({
      sites: SITES,
      posts: [posted("本文/002.txt", "kakuyomu", "　二話目。")],
      revisions: [
        {
          episodePath: "本文/002.txt",
          site: "kakuyomu",
          revisedAt: "2026-11-01T00:00:00.000Z",
          bodyHash: postingTextHash(null, "　二話目を直した。"),
        },
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).not.toBe("投稿のあとに直した話があります");
  });

  test("直した話が無ければ促さず、今までどおり未投稿のいちばん古い話を案内する", async () => {
    writeLedger({
      sites: SITES,
      posts: [
        posted("本文/001.txt", "narou", "　一話目。"),
        posted("本文/001.txt", "kakuyomu", "　一話目。"),
        // 改行コードと行末の空白だけ違う（読者が読む本文は同じ）
        posted("本文/002.txt", "narou", "　二話目を直した。  \r\n"),
        posted("本文/002.txt", "kakuyomu", "　二話目を直した。"),
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).toContain("第3話");
    expect(picks[0].title).not.toBe("投稿のあとに直した話があります");
  });

  test("印の無い記録だけの作品（0.124.0 より前に投稿した話）では、話を読まずに促さない", async () => {
    writeLedger({
      sites: SITES,
      posts: [posted("本文/002.txt", "narou"), posted("本文/002.txt", "kakuyomu")],
    });
    // 読めば「直した」に見える本文でも、印が無ければ比べようがない
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).not.toBe("投稿のあとに直した話があります");
  });

  test("「出し直さずに、新しい話を投稿する」を選ぶと、未投稿のいちばん古い話へ進む", async () => {
    writeLedger({
      sites: SITES,
      posts: [
        posted("本文/001.txt", "narou", "　一話目。"),
        posted("本文/001.txt", "kakuyomu", "　一話目。"),
        posted("本文/002.txt", "narou", "　二話目。"),
        posted("本文/002.txt", "kakuyomu", "　二話目。"),
      ],
    });
    const picks = stubQuickPick([(items) => items.find((item) => item.skip === true), () => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].items.find((item) => item.skip === true)?.label).toContain("新しい話を投稿する");
    expect(picks[1].title).toContain("第3話");
    expect(readLedger().revisions).toBeUndefined();
  });

  test("全話を出し終えた作品でも促しが出る（未投稿の話を選ぶ前に置いてある）", async () => {
    episodes.list = [ep1, ep2];
    writeLedger({
      sites: SITES,
      posts: [
        posted("本文/001.txt", "narou", "　一話目。"),
        posted("本文/001.txt", "kakuyomu", "　一話目。"),
        posted("本文/002.txt", "narou", "　二話目。"),
        posted("本文/002.txt", "kakuyomu", "　二話目。"),
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).toBe("投稿のあとに直した話があります");
    // 未投稿の話が無いので「新しい話を投稿する」とは言わない
    expect(picks[0].items.find((item) => item.skip === true)?.label).toContain("出し直さない");
  });

  test("合本は話ごとに印を比べ、直した話だけを促す", async () => {
    const all = episodeFile(1, "all.txt", true);
    episodes.list = [all];
    const text = (second: string) =>
      [
        "------------------------- エピソード1開始 -------------------------",
        "【エピソードタイトル】",
        "１話　邂逅",
        "",
        "【本文】",
        "",
        "　一話目の本文。",
        "",
        "------------------------- エピソード2開始 -------------------------",
        "【エピソードタイトル】",
        "２話　別離",
        "",
        "【本文】",
        "",
        second,
        "",
      ].join("\n");
    writeFile(all, text("　二話目を直した。"));
    writeLedger({
      sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
      posts: [
        { ...posted("本文/all.txt", "kakuyomu"), chapter: 1, bodyHash: postingBodyHash("\n　一話目の本文。\n") },
        { ...posted("本文/all.txt", "kakuyomu"), chapter: 2, bodyHash: postingBodyHash("\n　二話目の本文。\n") },
      ],
    });
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks[0].title).toBe("投稿のあとに直した話があります");
    const offered = picks[0].items.filter((item) => item.label.includes("出し直す"));
    expect(offered).toHaveLength(1);
    expect(offered[0].label).toContain("第2話");
  });
});
