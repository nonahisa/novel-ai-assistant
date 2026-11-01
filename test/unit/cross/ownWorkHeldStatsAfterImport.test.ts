import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { zipSync } from "fflate";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import * as paths from "../../../src/core/paths";
import {
  PENDING_OWN_WORK_STATS_KEY,
  UNREGISTERED_OWN_WORKS_KEY,
  UnregisteredOwnWorks,
  type OwnWorksMemory,
} from "../../../src/features/unregisteredOwnWorks";
import { importWorkFromZip, type RegisterWork } from "../../../src/features/importWorkFromZip";
import { importHeldOwnWorkStats } from "../../../src/features/ownWorkHeldStatsImport";
import { registeredSiteWorkKeys, type UnregisteredOwnWork } from "../../../src/core/unregisteredOwnWorks";
import { buildReaderStatsEnvelope } from "../../../src/core/readerStatsEnvelope";
import { emptyPostingLedger, parsePostingLedger, type PostingLedger } from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 未登録の自分の作品の控えが、バックアップからの登録の直後に台帳へ入るか
 * （作者の実機 0.120.0、2026-11-01 19:01〜19:02 の再現。設計書6.99.8）。
 *
 * 作者の実機では、控えは残ったまま・台帳の readerStats は0件で、登録の知らせは
 * 「貼り付けか手入力で足せます」と言った。原因は、**作品一覧が登録の直後に描き直され、
 * 台帳（投稿状態.json）に作品ID が書かれる前の空の台帳を控えに持った**こと。
 * 控えの取り込みはその控え（`registeredKeys`）で「登録済みか」を見ていたので、
 * 作品ID の鍵が無く、黙って何もしなかった。
 *
 * ここでは部品を差し替えずに、枠 → `importWorkFromZip` → `importHeldOwnWorkStats` を
 * 本物どうしで繋ぐ。差し替えるのはファイル置き場（メモリ）・保管庫・画面の窓だけ。
 * **一覧の描き直しは、登録の口の中で台帳を読んで控える形で写す**（実機の順番どおり）。
 *
 * 作者の実データと同じ形にする：台帳は `sites: []`・`siteProfiles` にだけ作品ID、
 * 書庫は2つ（「どこに作りますか」が出る）。
 */

const LIBRARY_A = paths.normalize("c:/小説/連載");
const LIBRARY_B = paths.normalize("c:/小説/短編");

const FIRST: UnregisteredOwnWork = {
  site: "kakuyomu",
  workId: "16816927863003767055",
  title: "苦手の流転",
  ownedVia: "owner-page",
  lastSeenAt: "2026-11-01T10:01:07.659Z",
};
const SECOND: UnregisteredOwnWork = {
  site: "kakuyomu",
  workId: "16816927863003767099",
  title: "夜更けの郵便局",
  ownedVia: "owner-page",
  lastSeenAt: "2026-11-01T10:05:00.000Z",
};

class Memory implements OwnWorksMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** カクヨムのバックアップ（【セルフレイティング】の欄でカクヨムと見分ける。`backupSite.ts`） */
function kakuyomuZip(title: string): Uint8Array {
  return zipSync({
    "about.txt": utf8(
      [
        "【タイトル】",
        title,
        "",
        "【ジャンル】",
        "現代ドラマ",
        "",
        "【紹介文】",
        "会社員の話。",
        "",
        "【セルフレイティング】",
        "",
      ].join("\n")
    ),
    "episode_0001.txt": utf8(["【タイトル】", "第1話　月曜日", "", "【本文】", "朝が来た。", ""].join("\n")),
  });
}

/** 管理画面で読んだ作品全体と各話の数（作者の控えと同じ形） */
function ownEnvelopeText(entry: UnregisteredOwnWork): string {
  return buildReaderStatsEnvelope({
    site: entry.site,
    workId: entry.workId,
    readAt: "2026-11-01T10:01:07.659Z",
    title: entry.title ?? null,
    tags: ["サラリーマン"],
    completion: "completed",
    ownedVia: "owner-page",
    entries: [
      { scope: "work", metrics: { pv: 321 } },
      { scope: "episode", episode: 1, metrics: { pv: 120 } },
    ],
  });
}

let memory: Memory;
let disk: Map<string, Uint8Array>;
let works: WorkEntry[];
/** 作品一覧の控え（`WorkTreeProvider.posting`）。一度読んだ作品は読み直さない */
let treeCache: Map<string, PostingLedger>;
let infos: string[];
let picks: number;
let own: UnregisteredOwnWorks;
const original = {
  showInformationMessage: window.showInformationMessage,
  showWarningMessage: window.showWarningMessage,
  showQuickPick: window.showQuickPick,
  fs: workspace.fs,
};

async function loadLedger(work: WorkEntry): Promise<PostingLedger> {
  const bytes = disk.get(Uri.file(paths.join(work.folderPath, "設定", "投稿状態.json")).fsPath);
  return bytes ? parsePostingLedger(JSON.parse(new TextDecoder().decode(bytes))) : emptyPostingLedger();
}

/** 作品一覧の `registeredOwnWorkKeys` と同じ作り（控えにある作品は読み直さない） */
async function treeRegisteredKeys(): Promise<Set<string>> {
  for (const work of works) {
    if (!treeCache.has(work.id)) treeCache.set(work.id, await loadLedger(work));
  }
  return registeredSiteWorkKeys(
    works.map((work) => treeCache.get(work.id)).filter((ledger): ledger is PostingLedger => !!ledger),
    works.map((work) => work.title)
  );
}

/**
 * 登録の口（`registerFolderAsWork`）。実機では登録の直後に作品一覧が描き直され
 * （`refreshRoot`）、描き直しが台帳を読んで控え、`noticeRegistered` を呼ぶ。
 * その順番を写す——このとき台帳にはまだ作品ID が無い
 */
const register: RegisterWork = async (folderPath, title) => {
  const entry: WorkEntry = {
    id: `w${works.length + 1}`,
    title,
    folderPath,
    registeredAt: "2026-11-01T10:02:00.000Z",
  };
  works.push(entry);
  await own.settleRegistered(await treeRegisteredKeys());
  return entry;
};

beforeEach(() => {
  memory = new Memory();
  disk = new Map();
  workspace.fs = memoryFs(disk);
  treeCache = new Map();
  infos = [];
  picks = 0;
  // 書庫が2つ（作品の数は同じ）。「どこに作りますか」が出る
  works = [
    { id: "a1", title: "連載の作品", folderPath: paths.join(LIBRARY_A, "連載の作品"), registeredAt: "2026-01-01T00:00:00.000Z" },
    { id: "b1", title: "短編の作品", folderPath: paths.join(LIBRARY_B, "短編の作品"), registeredAt: "2026-01-01T00:00:00.000Z" },
  ];
  window.showInformationMessage = (async (message: string) => {
    infos.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = (async () => undefined) as typeof window.showWarningMessage;
  // 「どこに作りますか」では「短編」を選ぶ（並びの先頭でないほう）
  window.showQuickPick = (async (items: readonly { home?: string }[]) => {
    picks++;
    return items.find((item) => item.home === LIBRARY_B);
  }) as unknown as typeof window.showQuickPick;

  own = new UnregisteredOwnWorks(memory, {
    importAsNew: (picked, known, unattended) =>
      importWorkFromZip(works, register, picked, known, unattended),
    registeredKeys: treeRegisteredKeys,
    // extension.ts の閉包と同じ道（束の取り込みと同じ関数を通す）
    importHeldStats: async (envelopes, lead, options) =>
      (await importHeldOwnWorkStats(envelopes, works, lead, options)).remaining,
  });
});

afterEach(() => {
  window.showInformationMessage = original.showInformationMessage;
  window.showWarningMessage = original.showWarningMessage;
  window.showQuickPick = original.showQuickPick;
  workspace.fs = original.fs;
});

describe("訊かずにバックアップから登録した直後に、控えた読者の反応を取り込む", () => {
  test("控えが台帳に入って控えから消え、知らせは取り込んだと言う。2回目は書庫を訊かない", async () => {
    memory.values.set(UNREGISTERED_OWN_WORKS_KEY, [FIRST, SECOND]);
    // ヘルパーが管理画面で読んだ（作品はまだ登録されていない）
    const { parseReaderStatsEnvelope } = await import("../../../src/core/readerStatsEnvelope");
    const envelopes = [FIRST, SECOND].map((entry) => {
      const parsed = parseReaderStatsEnvelope(ownEnvelopeText(entry));
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.envelope;
    });
    await own.note(envelopes);
    expect(own.pendingStats()).toHaveLength(2);

    // 1作目：届いたバックアップを訊かずに取り込む
    const first = await own.importBytes(
      FIRST,
      { fileName: "苦手の流転_20261101.zip", bytes: kakuyomuZip("苦手の流転") },
      { unattended: true }
    );
    expect(first?.folderPath).toBe(paths.join(LIBRARY_B, "苦手の流転"));
    expect(picks).toBe(1);

    // 台帳：sites は空のまま、siteProfiles に作品ID、控えの数が入っている
    const ledger = await loadLedger(first as WorkEntry);
    expect(ledger.sites).toEqual([]);
    expect(ledger.siteProfiles.map((profile) => profile.workId)).toEqual([FIRST.workId]);
    expect(ledger.readerStats?.some((record) => record.scope === "work")).toBe(true);
    expect(ledger.readerStats?.some((record) => record.scope === "episode")).toBe(true);
    // 控えから消えた（2作目の分は残る）
    expect(own.pendingStats().map((envelope) => envelope.workId)).toEqual([SECOND.workId]);
    expect(
      (memory.values.get(PENDING_OWN_WORK_STATS_KEY) as unknown[]).length
    ).toBe(1);

    // 知らせ：控えを取り込んだと言い、「貼り付けか手入力で足せます」は言わない
    const notice = infos.find((message) => message.startsWith("「苦手の流転」を登録しました"));
    expect(notice).toContain("読者の反応（1画面）も取り込みました");
    expect(notice).not.toContain("貼り付けか手入力");
    // 登録の知らせとは別に、束の取り込みの知らせを重ねない
    expect(infos.filter((message) => message.includes("控えておいた読者の反応を移しました"))).toEqual([]);

    // 2作目：前回選んだ書庫へ、訊かずに作る
    const second = await own.importBytes(
      SECOND,
      { fileName: "夜更けの郵便局_20261101.zip", bytes: kakuyomuZip("夜更けの郵便局") },
      { unattended: true }
    );
    expect(picks).toBe(1);
    expect(second?.folderPath).toBe(paths.join(LIBRARY_B, "夜更けの郵便局"));
    expect(own.pendingStats()).toEqual([]);
  });

  test("控えが無ければ、これまでどおり「貼り付けか手入力で足せます」と言う", async () => {
    memory.values.set(UNREGISTERED_OWN_WORKS_KEY, [FIRST]);
    await own.importBytes(
      FIRST,
      { fileName: "苦手の流転_20261101.zip", bytes: kakuyomuZip("苦手の流転") },
      { unattended: true }
    );
    const notice = infos.find((message) => message.startsWith("「苦手の流転」を登録しました"));
    expect(notice).toContain("貼り付けか手入力で足せます");
    expect(notice).not.toContain("も取り込みました");
  });

  test("覚えた書庫が無くなっていたら、もう一度訊く", async () => {
    memory.values.set(UNREGISTERED_OWN_WORKS_KEY, [FIRST, SECOND]);
    await own.importBytes(
      FIRST,
      { fileName: "苦手の流転_20261101.zip", bytes: kakuyomuZip("苦手の流転") },
      { unattended: true }
    );
    expect(picks).toBe(1);
    // 「短編」の作品がすべて外れた（書庫が無くなった）。書庫はほかに2つ
    works = works.filter((work) => !work.folderPath.startsWith(LIBRARY_B));
    works.push({
      id: "c1",
      title: "別の作品",
      folderPath: paths.join(paths.normalize("c:/小説/別"), "別の作品"),
      registeredAt: "2026-01-01T00:00:00.000Z",
    });
    window.showQuickPick = (async (items: readonly { home?: string }[]) => {
      picks++;
      return items.find((item) => item.home === LIBRARY_A);
    }) as unknown as typeof window.showQuickPick;
    const second = await own.importBytes(
      SECOND,
      { fileName: "夜更けの郵便局_20261101.zip", bytes: kakuyomuZip("夜更けの郵便局") },
      { unattended: true }
    );
    expect(picks).toBe(2);
    expect(second?.folderPath).toBe(paths.join(LIBRARY_A, "夜更けの郵便局"));
  });
});
