import * as path from "path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  ReaderStatsHelperLink,
  SEEN_FINGERPRINTS_KEY,
  type FingerprintMemory,
} from "../../src/features/readerStatsHelperLink";
import {
  pickReaderStatsWork,
  readerStatsAlreadyImported,
  readerStatsUriAction,
  rememberFingerprint,
  uriPathForLog,
} from "../../src/core/readerStatsHelperLink";
import {
  buildReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  readerStatsRecordsFromEnvelope,
  type ReaderStatsEnvelope,
} from "../../src/core/readerStatsEnvelope";
import {
  emptyPostingLedger,
  readPostingLedger,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../src/models/posting";
import type { WorkEntry } from "../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * ヘルパーからの受け口（設計書6.79.7「ヘルパーからの受け口」）。
 *
 * ヘルパーは読者の反応をクリップボードへ置いて
 * `vscode://nonahisa.novel-ai-assistant/import-reader-stats` を開く。
 * ここで確かめるのは次のとおり。
 *
 *   1. URI は**パスだけ**で見分け、知らないパスは何もしない。**URI に
 *      データが載っていても読まない**（読むのはクリップボードだけ）
 *   2. クリップボードに読者の反応のデータが無ければ、何もしないで理由を言う
 *   3. **読者の反応でないクリップボードは、記録にも指紋にも残さない**
 *   4. 窓が前に出たとき、**同じデータで二度訊かない**・取り込み済みなら訊かない
 *   5. 設定で切れる
 *   6. 作品は取り込みと同じ照合で絞り、決めきれなければ訊く
 */

const KAKUYOMU_POST = "https://kakuyomu.jp/my/works/1177354054892/episodes/new";

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: path.join("C:", "novels", id),
    registeredAt: "2026-09-23T00:00:00.000Z",
  };
}

function ledgerPath(entry: WorkEntry): string {
  return Uri.file(path.join(entry.folderPath, "設定", "投稿状態.json")).fsPath;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
const logged: string[] = [];
const picks: unknown[][] = [];
let clipboardReads = 0;
/** 通知のボタンへの答え（窓が前に出たときの問い） */
let answer: string | undefined;
/** 作品の選択画面で選ぶ項目の番号 */
let pickIndex: number | undefined;
let setting = true;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(entry: WorkEntry, ledger: PostingLedger): void {
  disk.set(ledgerPath(entry), utf8(`${JSON.stringify(ledger, null, 2)}\n`));
}

function readLedger(entry: WorkEntry): PostingLedger | undefined {
  const bytes = disk.get(ledgerPath(entry));
  if (!bytes) return undefined;
  return readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger;
}

function onKakuyomu(workId?: string): PostingLedger {
  const ledger = withSites(emptyPostingLedger(), [
    { site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST },
  ]);
  return workId ? withSiteProfile(ledger, "kakuyomu", { workId }) : ledger;
}

function envelopeText(workId?: string, pv = 1234): string {
  return buildReaderStatsEnvelope({
    site: "kakuyomu",
    ...(workId ? { workId } : {}),
    readAt: "2026-09-23T10:00:00.000+09:00",
    entries: [{ scope: "work", metrics: { pv } }],
  });
}

function parsed(text: string): ReaderStatsEnvelope {
  const result = parseReaderStatsEnvelope(text);
  if (!result.ok) throw new Error(result.reason);
  return result.envelope;
}

class MemoryStub implements FingerprintMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

let memory: MemoryStub;
let works: WorkEntry[];
let refreshed: string[];

function link(): ReaderStatsHelperLink {
  return new ReaderStatsHelperLink({
    listWorks: () => works,
    memory,
    afterImport: async (entry) => {
      refreshed.push(entry.id);
    },
  });
}

beforeAll(() => {
  // 記録の行を覗く（`core/logger.ts` は最初の1行で出力パネルを作る）
  Object.assign(window, {
    createOutputChannel: () => ({
      appendLine: (line: string) => logged.push(line),
      show() {},
      dispose() {},
    }),
  });
});

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  logged.length = 0;
  picks.length = 0;
  clipboardReads = 0;
  answer = undefined;
  pickIndex = undefined;
  setting = true;
  memory = new MemoryStub();
  works = [];
  refreshed = [];
  env.clipboard.text = "";
  env.clipboard.readText = async () => {
    clipboardReads++;
    return env.clipboard.text;
  };
  workspace.textDocuments = [];
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "readerStats.importOnFocus" ? (setting as T) : defaultValue,
  })) as typeof workspace.getConfiguration;

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
    showQuickPick: async (items: unknown[]) => {
      picks.push(items);
      return pickIndex === undefined ? undefined : items[pickIndex];
    },
    showInputBox: async () => undefined,
    showInformationMessage: async (message: string, ...buttons: string[]) => {
      informed.push(message);
      return buttons.length > 0 ? answer : undefined;
    },
    showWarningMessage: async (message: string) => {
      warned.push(message);
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      warned.push(message);
      return undefined;
    },
  });
});

describe("URI のパスの判定", () => {
  test("約束のパスだけを取り込みの合図と読む（末尾の / は許す）", () => {
    expect(readerStatsUriAction("/import-reader-stats")).toBe("import");
    expect(readerStatsUriAction("/import-reader-stats/")).toBe("import");
  });

  test("知らないパス・似た綴りは合図と読まない", () => {
    expect(readerStatsUriAction("")).toBeUndefined();
    expect(readerStatsUriAction("/")).toBeUndefined();
    expect(readerStatsUriAction("/Import-Reader-Stats")).toBeUndefined();
    expect(readerStatsUriAction("/import-reader-stats/extra")).toBeUndefined();
    expect(readerStatsUriAction("/delete-everything")).toBeUndefined();
  });

  test("記録に残すパスは、制御文字を落として短く切る", () => {
    expect(uriPathForLog("/a\u0000b\nc")).toBe("/abc");
    expect(uriPathForLog(`/${"x".repeat(200)}`).length).toBeLessThanOrEqual(81);
  });

  test("知らないパスでは、クリップボードを読まず何も出さない（記録だけ）", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = envelopeText();

    await link().handleUri({ path: "/something-else" });

    expect(clipboardReads).toBe(0);
    expect(informed).toEqual([]);
    expect(warned).toEqual([]);
    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
    expect(logged.some((line) => line.includes("/something-else"))).toBe(true);
  });

  test("URI にデータが載っていても読まない（クリップボードが空なら取り込まない）", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    const uri = {
      path: "/import-reader-stats",
      query: `data=${encodeURIComponent(envelopeText())}`,
    };

    await link().handleUri(uri);

    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
    expect(informed).toHaveLength(1);
    expect(informed[0]).toContain("読者の反応のデータがありませんでした");
  });
});

describe("URI で呼ばれたとき", () => {
  test("クリップボードに読者の反応のデータが無ければ、何もしないで理由を言う", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = "今日の買い物：卵、牛乳";

    await link().handleUri({ path: "/import-reader-stats" });

    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
    expect(informed).toHaveLength(1);
    expect(informed[0]).toContain("統合小説執筆環境ヘルパー");
    // 私物の中身は記録にも残さない
    expect(logged.join("\n")).not.toContain("卵");
    expect(memory.get<string[]>(SEEN_FINGERPRINTS_KEY, [])).toEqual([]);
  });

  test("作品が1つに決まれば、訊かずに取り込む（知らせに作品名を添える）", async () => {
    works = [work("w1", "星を継ぐ者たち"), work("w2", "別の話")];
    writeLedger(works[0], onKakuyomu());
    writeLedger(works[1], emptyPostingLedger());
    env.clipboard.text = envelopeText();

    await link().handleUri({ path: "/import-reader-stats" });

    expect(picks).toHaveLength(0);
    expect(readLedger(works[0])?.readerStats).toHaveLength(1);
    expect(readLedger(works[0])?.readerStats[0].metrics).toEqual({ pv: 1234 });
    expect(informed.at(-1)).toContain("「星を継ぐ者たち」");
    expect(refreshed).toEqual(["w1"]);
  });

  test("候補が2つあれば作品を選んでもらう（推し量って決めない）", async () => {
    works = [work("w1", "一つ目"), work("w2", "二つ目")];
    writeLedger(works[0], onKakuyomu());
    writeLedger(works[1], onKakuyomu());
    env.clipboard.text = envelopeText();
    pickIndex = 1;

    await link().handleUri({ path: "/import-reader-stats" });

    expect(picks).toHaveLength(1);
    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
    expect(readLedger(works[1])?.readerStats).toHaveLength(1);
  });

  test("選ぶ画面を閉じれば、どこにも書かない", async () => {
    works = [work("w1", "一つ目"), work("w2", "二つ目")];
    writeLedger(works[0], onKakuyomu());
    writeLedger(works[1], onKakuyomu());
    env.clipboard.text = envelopeText();

    await link().handleUri({ path: "/import-reader-stats" });

    expect(picks).toHaveLength(1);
    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
    expect(readLedger(works[1])?.readerStats ?? []).toHaveLength(0);
  });

  test("作品IDが一致する作品があれば、そちらに決まる", async () => {
    works = [work("w1", "一つ目"), work("w2", "二つ目")];
    writeLedger(works[0], onKakuyomu());
    writeLedger(works[1], onKakuyomu("1177354054892"));
    env.clipboard.text = envelopeText("1177354054892");

    await link().handleUri({ path: "/import-reader-stats" });

    expect(picks).toHaveLength(0);
    expect(readLedger(works[1])?.readerStats).toHaveLength(1);
  });

  test("作品が1つで照合に落ちれば、取り込みと同じ理由を言って書かない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu("111"));
    env.clipboard.text = envelopeText("222");

    await link().handleUri({ path: "/import-reader-stats" });

    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("作品ID");
  });

  test("URI で取り込んだデータは、そのあと窓が前に出ても訊かない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = envelopeText();
    const helper = link();

    await helper.handleUri({ path: "/import-reader-stats" });
    informed.length = 0;
    await helper.checkOnFocus();

    expect(informed).toEqual([]);
  });
});

describe("VS Code に戻ったとき", () => {
  test("読者の反応でないクリップボードは、何も出さず記録にも指紋にも残さない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = "口座番号 1234-5678";

    await link().checkOnFocus();

    expect(informed).toEqual([]);
    expect(warned).toEqual([]);
    expect(logged).toEqual([]);
    expect(memory.values.size).toBe(0);
  });

  test("ただの JSON も、読者の反応でなければ同じく残さない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = JSON.stringify({ secret: "合言葉" });

    await link().checkOnFocus();

    expect(informed).toEqual([]);
    expect(logged).toEqual([]);
    expect(memory.values.size).toBe(0);
  });

  test("読者の反応があれば1度だけ訊き、「取り込む」で取り込む", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = envelopeText();
    answer = "取り込む";

    await link().checkOnFocus();

    expect(informed[0]).toContain("「星を継ぐ者たち」に取り込みますか");
    expect(readLedger(works[0])?.readerStats).toHaveLength(1);
    expect(refreshed).toEqual(["w1"]);
  });

  test("同じデータで二度訊かない（「取り込まない」と答えたあとも）", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = envelopeText();
    answer = "取り込まない";
    const helper = link();

    await helper.checkOnFocus();
    await helper.checkOnFocus();

    expect(informed).toHaveLength(1);
    expect(readLedger(works[0])?.readerStats ?? []).toHaveLength(0);
  });

  test("覚えた指紋は窓（拡張機能の起動）をまたいでも効く", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = envelopeText();

    await link().checkOnFocus();
    await link().checkOnFocus();

    expect(informed).toHaveLength(1);
  });

  test("違うデータなら、また訊く", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    const helper = link();

    env.clipboard.text = envelopeText(undefined, 100);
    await helper.checkOnFocus();
    env.clipboard.text = envelopeText(undefined, 200);
    await helper.checkOnFocus();

    expect(informed).toHaveLength(2);
  });

  test("もう取り込んであるデータは訊かない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    const text = envelopeText();
    let ledger = onKakuyomu();
    for (const record of readerStatsRecordsFromEnvelope(parsed(text))) {
      ledger = withReaderStats(ledger, record);
    }
    writeLedger(works[0], ledger);
    env.clipboard.text = text;

    await link().checkOnFocus();

    expect(informed).toEqual([]);
  });

  test("どの作品とも照合できなければ訊かない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], emptyPostingLedger());
    env.clipboard.text = envelopeText();

    await link().checkOnFocus();

    expect(informed).toEqual([]);
    expect(warned).toEqual([]);
  });

  test("設定を切れば、クリップボードも読まない", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = envelopeText();
    setting = false;

    await link().checkOnFocus();

    expect(clipboardReads).toBe(0);
    expect(informed).toEqual([]);
  });

  test("形の合わない読者の反応（版の食い違い）は、理由を1度だけ言う", async () => {
    works = [work("w1", "星を継ぐ者たち")];
    writeLedger(works[0], onKakuyomu());
    env.clipboard.text = JSON.stringify({ "novelai-stats": 99, site: "kakuyomu" });
    const helper = link();

    await helper.checkOnFocus();
    await helper.checkOnFocus();

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("ヘルパー");
  });
});

describe("作品の絞り込み（画面を出さない部分）", () => {
  const envelope = parsed(envelopeText());

  test("関所を通る作品が1つなら決まり、無ければ none", () => {
    expect(
      pickReaderStatsWork(envelope, [
        { id: "a", ledger: onKakuyomu() },
        { id: "b", ledger: emptyPostingLedger() },
      ])
    ).toEqual({ kind: "one", id: "a" });
    expect(
      pickReaderStatsWork(envelope, [{ id: "b", ledger: emptyPostingLedger() }])
    ).toEqual({ kind: "none" });
  });

  test("通る作品が2つなら選ばせる", () => {
    expect(
      pickReaderStatsWork(envelope, [
        { id: "a", ledger: onKakuyomu() },
        { id: "b", ledger: onKakuyomu() },
      ])
    ).toEqual({ kind: "choose", ids: ["a", "b"] });
  });

  test("取り込み済みの見分けは、取り込みと同じ記録で行う", () => {
    let ledger = onKakuyomu();
    expect(readerStatsAlreadyImported(envelope, ledger)).toBe(false);
    for (const record of readerStatsRecordsFromEnvelope(envelope)) {
      ledger = withReaderStats(ledger, record);
    }
    expect(readerStatsAlreadyImported(envelope, ledger)).toBe(true);
  });

  test("覚える指紋は上限まで、古いものから忘れる", () => {
    let list: string[] = [];
    for (let i = 0; i < 5; i++) list = rememberFingerprint(list, `f${i}`, 3);
    expect(list).toEqual(["f2", "f3", "f4"]);
    // 同じものは1つにまとめて末尾へ
    expect(rememberFingerprint(["a", "b"], "a", 3)).toEqual(["b", "a"]);
  });
});
