import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AIRegistry } from "../../../src/ai/registry";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { env, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * ヘルパーから届いた投稿した話の番号を受け取る（`/import-posted`。設計書6.68.8）。
 *
 * 確かめること：
 * - **番号は『投稿しました』より先に届く**（再現）。案内の保存を止めず、同じ保存で番号が入る
 * - 札があれば札で、無ければ題で話を決め、決まらなければ作者に選んでもらう
 * - 同じ番号を2度受けても台帳は1バイトも変わらない。別の番号がある話は訊いてから替える
 * - なろうは小説番号で作品を引き、無ければ（作品が1つでも）作者に選んでもらう
 * - 書くのは投稿の記録だけ（原稿は1バイトも変わらない）
 */

const scanned: EpisodeFile[] = [];
vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({
    episodes: scanned,
    stats: {},
    manuscriptDir: "",
    workInfoFiles: [],
    timing: {},
  }),
}));

const { importPostedFromHelper } = await import("../../../src/features/importPosted");
const { postNewEpisode } = await import("../../../src/features/postingKit");
const { settlePendingOnStartup } = await import("../../../src/features/postedPendingSettle");
const { storedPostingUpdatesOf, usePostingPendingMemory } = await import(
  "../../../src/features/postingKitSession"
);

/** 保管庫の作り物（本物と同じく JSON に通した形で持つ） */
function freshMemento() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return values.has(key) ? (values.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown): Thenable<void> {
      values.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
  };
}

const work: WorkEntry = {
  id: "work_posted",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "posted"),
  registeredAt: "2026-11-03T00:00:00.000Z",
};
const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;
const kakuyomuUrl = "https://kakuyomu.jp/my/works/16816927859/episodes/new";
const narouUrl = "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";
const body = ["「引くな」と彼は言った。", "", "そして——歩き出した。"].join("\n");

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
const errors: string[] = [];
let warningAnswer: string | undefined;
const changedWorks: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function episodeFile(fileName: string, chapter: number, subtitle: string): EpisodeFile {
  const filePath = path.join(work.folderPath, "本文", fileName);
  disk.set(Uri.file(filePath).fsPath, utf8(body));
  return {
    filePath,
    fileName,
    ext: ".txt",
    chapterStart: chapter,
    chapterEnd: chapter,
    subtitle,
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
}

interface LedgerJson {
  posts: Array<Record<string, unknown>>;
  siteFacts?: Array<Record<string, unknown>>;
}

function writeLedger(ledger: Record<string, unknown>): void {
  disk.set(
    ledgerPath,
    utf8(
      JSON.stringify({
        schemaVersion: "1",
        sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
        siteProfiles: [{ site: "kakuyomu", workId: "16816927859" }],
        posts: [],
        rankings: [],
        ...ledger,
      })
    )
  );
}

function readLedger(): LedgerJson {
  const bytes = disk.get(ledgerPath);
  if (!bytes) throw new Error("台帳が書かれていません");
  return JSON.parse(new TextDecoder().decode(bytes)) as LedgerJson;
}

function posted(extra: Record<string, unknown>): string {
  return JSON.stringify({
    "novelai-posted": 1,
    site: "kakuyomu",
    workId: "16816927859",
    episodeId: "16816927859000000123",
    readAt: "2026-11-03T21:40:00.000+09:00",
    ...extra,
  });
}

interface PickItem {
  label: string;
  [key: string]: unknown;
}

/** 選択画面の答え方（渡された項目を覚えてから、1つ返す。答えは非同期でもよい） */
function stubQuickPick(
  answers: Array<(items: PickItem[]) => unknown>
): Array<{ items: PickItem[]; title: string }> {
  const captured: Array<{ items: PickItem[]; title: string }> = [];
  let index = 0;
  Object.assign(window, {
    showQuickPick: async (items: PickItem[], options?: { title?: string }) => {
      captured.push({ items, title: options?.title ?? "" });
      const answer = answers[index++];
      return answer ? await answer(items) : undefined;
    },
  });
  return captured;
}

const deps = {
  listWorks: () => [work],
  afterChange: (changed: WorkEntry) => {
    changedWorks.push(changed.id);
  },
};

const post013 = {
  episodePath: "本文/013_邂逅.txt",
  site: "kakuyomu",
  postedAt: "2026-11-03T12:00:00.000Z",
};
const post012 = {
  episodePath: "本文/012_出立.txt",
  site: "kakuyomu",
  postedAt: "2026-11-02T12:00:00.000Z",
};

beforeEach(() => {
  disk.clear();
  scanned.length = 0;
  informed.length = 0;
  warned.length = 0;
  errors.length = 0;
  changedWorks.length = 0;
  warningAnswer = undefined;
  usePostingPendingMemory(freshMemento());
  env.clipboard.text = "";
  workspace.textDocuments = [];
  workspace.fs = memoryFs(disk);
  Object.assign(window, {
    showInformationMessage: async (message: string) => {
      informed.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      warned.push(message);
      return warningAnswer;
    },
    showErrorMessage: async (message: string) => {
      errors.push(message);
      return undefined;
    },
  });
  stubQuickPick([]);
  scanned.push(episodeFile("012_出立.txt", 12, "出立"), episodeFile("013_邂逅.txt", 13, "邂逅"));
});

describe("投稿キットの案内の途中で届く（『投稿しました』より先）", () => {
  test("案内の保存を止めず、『投稿しました』の保存で番号と札が入る", async () => {
    writeLedger({});
    let issuedRef = "";
    stubQuickPick([
      (items) => items.find((item) => item.answer === "envelope"),
      async (items) => {
        // 封筒をコピーした直後。作者がブラウザで投稿し、ヘルパーのボタンを押した
        issuedRef = (JSON.parse(env.clipboard.text) as { postRef: string }).postRef;
        env.clipboard.text = posted({ postRef: issuedRef, title: "邂逅" });
        await importPostedFromHelper(deps);
        // このあとで VS Code の『投稿しました』を押す
        return items.find((item) => item.answer === "posted");
      },
      () => undefined,
    ]);

    const result = await postNewEpisode(work, {} as unknown as AIRegistry, scanned[1]);

    expect(result.changed).toBe(true);
    // 預かりを当てる後始末が、新しい話を投稿したことを消さない（手順の「済んだ」に使う。6.68.7）
    expect(result.postedNew).toBe(true);
    // 「外部で変更されています」で止まっていない
    expect(errors).toEqual([]);
    expect(issuedRef).toMatch(/^[0-9a-f]{24}$/);
    const ledger = readLedger();
    expect(ledger.posts).toHaveLength(1);
    expect(ledger.posts[0].postRef).toBe(issuedRef);
    expect(ledger.posts[0].siteEpisodeId).toBe("16816927859000000123");
    expect(informed.some((message) => message.includes("「投稿しました」を選ぶと"))).toBe(true);
  });

  test("次のサイトの案内の途中で届いても、案内の保存は止まらない（受け手は台帳を書かずに預ける）", async () => {
    writeLedger({
      sites: [
        { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
        { site: "alphapolis", newEpisodeUrl: "https://www.alphapolis.co.jp/novel/episode/create/123456789" },
      ],
    });
    let issuedRef = "";
    stubQuickPick([
      (items) => items.find((item) => item.answer === "envelope"),
      (items) => {
        issuedRef = (JSON.parse(env.clipboard.text) as { postRef: string }).postRef;
        return items.find((item) => item.answer === "posted");
      },
      async (items) => {
        // カクヨムは記録済み。アルファポリスの案内の途中で、カクヨムの番号が届いた
        env.clipboard.text = posted({ postRef: issuedRef });
        await importPostedFromHelper(deps);
        return items.find((item) => item.answer === "posted");
      },
      () => undefined,
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, scanned[1]);

    expect(errors).toEqual([]);
    const posts = readLedger().posts;
    expect(posts.map((p) => p.site).sort()).toEqual(["alphapolis", "kakuyomu"]);
    expect(posts.find((p) => p.site === "kakuyomu")?.siteEpisodeId).toBe("16816927859000000123");
    expect(posts.find((p) => p.site === "alphapolis")?.siteEpisodeId).toBeUndefined();
  });

  /** 封筒をコピーし、番号を受け取ってから、『投稿しました』を選ばずに中止する */
  async function abortAfterNumberArrives(): Promise<void> {
    stubQuickPick([
      (items) => items.find((item) => item.answer === "envelope"),
      async () => {
        const ref = (JSON.parse(env.clipboard.text) as { postRef: string }).postRef;
        env.clipboard.text = posted({ postRef: ref });
        await importPostedFromHelper(deps);
        return undefined; // 中止
      },
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, scanned[1]);
  }

  test("『投稿しました』を選ばずに終えたら、台帳は書かず、番号は保管庫に預かったままにする", async () => {
    writeLedger({});
    await abortAfterNumberArrives();
    expect(readLedger().posts).toEqual([]);
    expect(informed.some((message) => message.includes("預かっておきます"))).toBe(true);
    expect(storedPostingUpdatesOf(work.id)).toHaveLength(1);
  });

  test("（再現）VS Code を閉じて開き直したあと、投稿キットで『投稿しました』を選ぶと預かった番号が入り、預かりは消える", async () => {
    writeLedger({});
    await abortAfterNumberArrives();
    // VS Code を閉じて開き直した（保管庫は残る。案内の札は消える）
    stubQuickPick([
      (items) => items.find((item) => item.answer === "posted"),
      () => undefined,
    ]);
    await postNewEpisode(work, {} as unknown as AIRegistry, scanned[1]);
    expect(errors).toEqual([]);
    expect(readLedger().posts[0].siteEpisodeId).toBe("16816927859000000123");
    expect(storedPostingUpdatesOf(work.id)).toEqual([]);
  });

  test("（再現）別の手で投稿の記録ができていれば、次に VS Code を開いたときに入る", async () => {
    writeLedger({});
    await abortAfterNumberArrives();
    // 作者がほかの道（別の端末から同期された・台帳を手で直した等）で投稿の記録を作った
    writeLedger({ posts: [post013] });
    await settlePendingOnStartup(deps);
    expect(readLedger().posts[0].siteEpisodeId).toBe("16816927859000000123");
    expect(storedPostingUpdatesOf(work.id)).toEqual([]);
    expect(changedWorks).toContain(work.id);
  });

  test("開いたときに入れる前にも、上書きしない決まりを通す（別の番号がある話は替えずに預かりから外す）", async () => {
    writeLedger({});
    await abortAfterNumberArrives();
    writeLedger({ posts: [{ ...post013, siteEpisodeId: "999" }] });
    const before = disk.get(ledgerPath);
    await settlePendingOnStartup(deps);
    expect(disk.get(ledgerPath)).toBe(before);
    expect(storedPostingUpdatesOf(work.id)).toEqual([]);
    expect(warned.some((message) => message.includes("預かりから外しました"))).toBe(true);
  });
});

describe("投稿のあとに届く", () => {
  test("札で話を決めて番号を入れる", async () => {
    writeLedger({ posts: [post012, { ...post013, postRef: "k7Qm2xP9" }] });
    env.clipboard.text = posted({ postRef: "k7Qm2xP9", title: "まったく別の題" });
    await importPostedFromHelper(deps);
    const posts = readLedger().posts;
    expect(posts.find((p) => p.episodePath === post013.episodePath)?.siteEpisodeId).toBe(
      "16816927859000000123"
    );
    expect(posts.find((p) => p.episodePath === post012.episodePath)?.siteEpisodeId).toBeUndefined();
    expect(changedWorks).toEqual([work.id]);
  });

  test("札が無ければ題で照らす", async () => {
    writeLedger({ posts: [post012, post013] });
    env.clipboard.text = posted({ title: "邂逅" });
    await importPostedFromHelper(deps);
    expect(readLedger().posts.find((p) => p.episodePath === post013.episodePath)?.siteEpisodeId).toBe(
      "16816927859000000123"
    );
  });

  test("題で決まらなければ選んでもらう（推し量って決めない）", async () => {
    writeLedger({ posts: [post012, post013] });
    env.clipboard.text = posted({ title: "どれでもない題" });
    const picks = stubQuickPick([(items) => items.find((item) => item.label.includes("12"))]);
    await importPostedFromHelper(deps);
    expect(picks).toHaveLength(1);
    expect(readLedger().posts.find((p) => p.episodePath === post012.episodePath)?.siteEpisodeId).toBe(
      "16816927859000000123"
    );
  });

  test("同じ番号を2度受けても台帳は変わらない", async () => {
    writeLedger({ posts: [{ ...post013, postRef: "r1", siteEpisodeId: "16816927859000000123" }] });
    const before = disk.get(ledgerPath);
    env.clipboard.text = posted({ postRef: "r1" });
    await importPostedFromHelper(deps);
    expect(disk.get(ledgerPath)).toBe(before);
    expect(informed.some((message) => message.includes("記録済み"))).toBe(true);
  });

  test("別の番号がある話は上書きせず訊く。答えなければ替えない", async () => {
    writeLedger({ posts: [{ ...post013, postRef: "r1", siteEpisodeId: "999" }] });
    const before = disk.get(ledgerPath);
    env.clipboard.text = posted({ postRef: "r1" });
    await importPostedFromHelper(deps);
    expect(warned.some((message) => message.includes("999"))).toBe(true);
    expect(disk.get(ledgerPath)).toBe(before);

    warningAnswer = "届いた番号に替える";
    await importPostedFromHelper(deps);
    expect(readLedger().posts[0].siteEpisodeId).toBe("16816927859000000123");
  });

  test("作品IDを登録した作品が無ければ記録しない", async () => {
    writeLedger({ posts: [post013] });
    const before = disk.get(ledgerPath);
    env.clipboard.text = posted({ workId: "99999", title: "邂逅" });
    await importPostedFromHelper(deps);
    expect(disk.get(ledgerPath)).toBe(before);
    expect(warned.some((message) => message.includes("作品ID 99999"))).toBe(true);
  });

  test("札の話の作品IDが届いた作品IDと違えば記録しない", async () => {
    writeLedger({ posts: [{ ...post013, postRef: "r1" }] });
    const before = disk.get(ledgerPath);
    env.clipboard.text = posted({ postRef: "r1", workId: "77777" });
    await importPostedFromHelper(deps);
    expect(disk.get(ledgerPath)).toBe(before);
    expect(warned.some((message) => message.includes("取り違え"))).toBe(true);
  });

  test("壊れた封筒は理由を言って止まり、何も書かない", async () => {
    writeLedger({ posts: [post013] });
    const before = disk.get(ledgerPath);
    env.clipboard.text = posted({ episodeId: "12a" });
    await importPostedFromHelper(deps);
    expect(disk.get(ledgerPath)).toBe(before);
    expect(warned).toHaveLength(1);
  });

  test("原稿は1バイトも変わらない", async () => {
    writeLedger({ posts: [{ ...post013, postRef: "r1" }] });
    const manuscripts = [...disk].filter(([key]) => key !== ledgerPath);
    env.clipboard.text = posted({ postRef: "r1" });
    await importPostedFromHelper(deps);
    for (const [key, bytes] of manuscripts) expect(disk.get(key)).toBe(bytes);
  });
});

describe("なろう", () => {
  const narouLedger = {
    sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
    siteProfiles: [{ site: "narou", workId: "n1234ab" }],
    posts: [
      { ...post012, site: "narou" },
      { ...post013, site: "narou" },
    ],
  };
  const narouPosted = (extra: Record<string, unknown>) =>
    JSON.stringify({
      "novelai-posted": 1,
      site: "narou",
      novelNo: "1234567",
      readAt: "2026-11-03T21:40:00.000+09:00",
      ...extra,
    });

  test("番号を持つ作品が無ければ、作品が1つでも訊いて覚える。話も選んでもらう", async () => {
    writeLedger(narouLedger);
    env.clipboard.text = narouPosted({ episodeId: "8765432" });
    const picks = stubQuickPick([
      (items) => items.find((item) => item.label === work.title),
      (items) => items.find((item) => item.label.includes("13")),
    ]);
    await importPostedFromHelper(deps);
    expect(picks).toHaveLength(2);
    const ledger = readLedger();
    expect(ledger.siteFacts?.[0]).toMatchObject({ site: "narou", siteWorkNumber: "1234567" });
    expect(ledger.posts.find((p) => p.episodePath === post013.episodePath)?.siteEpisodeId).toBe("8765432");
  });

  test("番号を覚えた作品は訊かずに決まる。作品の管理画面で押したときは番号だけ", async () => {
    writeLedger({
      ...narouLedger,
      siteFacts: [{ site: "narou", siteWorkNumber: "1234567", siteWorkNumberAt: "x" }],
    });
    const before = disk.get(ledgerPath);
    env.clipboard.text = narouPosted({});
    const picks = stubQuickPick([]);
    await importPostedFromHelper(deps);
    expect(picks).toHaveLength(0);
    expect(disk.get(ledgerPath)).toBe(before);
    expect(informed.some((message) => message.includes("記録済み"))).toBe(true);
  });

  test("作品を選ばなければ何も書かない", async () => {
    writeLedger(narouLedger);
    const before = disk.get(ledgerPath);
    env.clipboard.text = narouPosted({});
    stubQuickPick([() => undefined]);
    await importPostedFromHelper(deps);
    expect(disk.get(ledgerPath)).toBe(before);
  });
});
