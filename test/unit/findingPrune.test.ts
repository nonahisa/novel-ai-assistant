import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";
import { FindingStore } from "../../src/features/findingStore";
import type { Finding, FindingDecision } from "../../src/models/finding";
import type { WorkEntry } from "../../src/models/types";

/**
 * 「古い指摘を片づける」（設計書6.96.4）。
 *
 * **期限切れは隠れているだけで、ファイルには在る。** 消えるのは作者が
 * 押したときだけで、機械は勝手に消さない——時計のずれや、ノートPCを
 * 久しぶりに開いたときに、**作者が見る前に消える**のを防ぐため。
 *
 * ここで見るのは「消しすぎないこと」である。**`findings.jsonl` を書き直す
 * のはこの道だけ**なので、取りこぼしも消しすぎも、ほかのどこにも現れない。
 */

const work: WorkEntry = {
  id: "w1",
  title: "テスト作品",
  folderPath: "C:\\novels\\テスト作品",
  registeredAt: new Date(0).toISOString(),
};

const FINDINGS_PATH = Uri.file(
  "C:\\novels\\テスト作品\\.aiwriter\\findings.jsonl"
).fsPath;

const NOW = new Date("2026-09-19T12:00:00.000Z");
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    time: daysAgo(1),
    file: "本文/001.txt",
    hintLine: 3,
    original: "　彼女は振り返らなかった。",
    target: "振り返らなかった",
    suggestion: "振りかえらなかった",
    before: "　朝の廊下は静かだった。",
    after: "　窓の外で鐘が鳴る。",
    message: "送り仮名が他の箇所と揃っていません",
    category: "typo",
    label: "誤字脱字",
    ...overrides,
  };
}

async function seed(
  lines: ReadonlyArray<Finding | FindingDecision>
): Promise<void> {
  const store = new FindingStore(work);
  for (const line of lines) {
    if ("findingId" in line) await store.decide([line]);
    else await store.record([line]);
  }
}

/** 偽のディスク。置き場はここへ溜まる */
const files = new Map<string, Uint8Array>();

/** いま置き場に何行あるか（畳む前の生の行数） */
function rawLines(): string[] {
  const bytes = files.get(FINDINGS_PATH);
  if (!bytes) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.length > 0);
}

beforeEach(() => {
  files.clear();
  workspace.fs = {
    createDirectory: vi.fn(async () => undefined),
    readFile: vi.fn(async (uri: { fsPath: string }) => {
      const bytes = files.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    }),
    writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
      files.set(uri.fsPath, bytes);
    }),
  };
});

describe("古い指摘を片づける", () => {
  test("期限を過ぎた指摘だけを消し、新しいものは残す", async () => {
    await seed([
      finding({ id: "old", time: daysAgo(5) }),
      finding({ id: "new", time: daysAgo(1) }),
    ]);

    const removed = await new FindingStore(work).prune(3, NOW);

    expect(removed).toBe(1);
    const left = await new FindingStore(work).load();
    expect(left.map((entry) => entry.id)).toEqual(["new"]);
  });

  test("消した指摘に付いていた判断の行も、一緒に消える", async () => {
    await seed([
      finding({ id: "old", time: daysAgo(5) }),
      { findingId: "old", time: daysAgo(4), status: "dismissed", note: "" },
    ]);

    await new FindingStore(work).prune(3, NOW);

    // **判断だけを残さない**（残すと、検知し直した瞬間に隠れる）
    expect(rawLines()).toEqual([]);
  });

  test("残す指摘の判断は消さない", async () => {
    await seed([
      finding({ id: "new", time: daysAgo(1) }),
      { findingId: "new", time: daysAgo(1), status: "dismissed", note: "" },
      finding({ id: "old", time: daysAgo(9) }),
    ]);

    await new FindingStore(work).prune(3, NOW);

    const left = await new FindingStore(work).load();
    expect(left).toHaveLength(1);
    expect(left[0].status).toBe("dismissed");
  });

  /**
   * 記録は追記のみなので、同じ番号が2度書かれていることがある。
   * **古い行だけを見て消すと、まだ3日経っていない指摘が消える。**
   */
  test("同じ番号で書き直されていれば、新しいほうを見て残す", async () => {
    await seed([
      finding({ id: "f1", time: daysAgo(9) }),
      finding({ id: "f1", time: daysAgo(1) }),
    ]);

    expect(await new FindingStore(work).prune(3, NOW)).toBe(0);
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  test("無期限（0）のときは、何も消さない", async () => {
    await seed([finding({ id: "old", time: daysAgo(90) })]);

    expect(await new FindingStore(work).prune(0, NOW)).toBe(0);
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  test("消すものが無ければ、ファイルへは書かない", async () => {
    await seed([finding({ time: daysAgo(1) })]);
    const before = rawLines();

    expect(await new FindingStore(work).prune(3, NOW)).toBe(0);

    expect(rawLines()).toEqual(before);
  });

  test("置き場がまだ無くても、静かに0件で返る", async () => {
    expect(await new FindingStore(work).prune(3, NOW)).toBe(0);
  });

  test("押す前に、何件消えるかを数えられる", async () => {
    await seed([
      finding({ id: "old1", time: daysAgo(5) }),
      finding({ id: "old2", time: daysAgo(4) }),
      finding({ id: "new", time: daysAgo(1) }),
    ]);

    const store = new FindingStore(work);
    expect(await store.countExpired(3, NOW)).toBe(2);
    // **数えただけでは消えない**（確認を取る前に消してはいけない）
    expect(await store.load()).toHaveLength(3);
  });
});
