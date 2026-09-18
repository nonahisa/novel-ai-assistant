import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";
import {
  FindingStore,
  visibleFindings,
} from "../../src/features/findingStore";
import {
  findingId,
  isFindingExpired,
  parseFindingLines,
  resolveFindings,
  type Finding,
  type FindingView,
} from "../../src/models/finding";
import type { WorkEntry } from "../../src/models/types";

/**
 * AIの指摘を数日残す置き場（設計書6.96）。
 *
 * 作者の指示（2026-09-19）：「提案が一回ごとに消えるのは面倒なので、
 * 位置把握を厳にして数日保存する機能が欲しい」。
 *
 * ここで見るのは**置き場のほう**——追記だけで判断が足せること、期限の
 * 判定、壊れた行を跨げること。位置の探し直しは
 * `findingLocation.test.ts` が見る。
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

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    id: "f1",
    time: "2026-09-19T09:00:00.000Z",
    file: "本文/episode_0001.txt",
    hintLine: 12,
    original: "　彼女は振り返らなかった。",
    target: "振り返らなかった",
    suggestion: "振りかえらなかった",
    before: "　朝の廊下は静かだった。",
    after: "　窓の外で鐘が鳴る。",
    message: "送り仮名が他の箇所と揃っていません",
    category: "typo",
  };
  return { ...base, ...overrides };
}

describe("置き場のファイル", () => {
  const files = new Map<string, Uint8Array>();

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

  /**
   * **`.aiwriter/cache/` へ置かない**（6.96.4）。あそこは `.gitignore` で
   * 外れているので、置いた瞬間に同期されなくなる。
   */
  test("同期される場所（.aiwriter直下）へ書く", async () => {
    await new FindingStore(work).record([finding()]);

    expect([...files.keys()]).toEqual([FINDINGS_PATH]);
    expect([...files.keys()][0]).not.toContain("cache");
  });

  test("1行1件のJSONLで、追記されていく", async () => {
    const store = new FindingStore(work);
    await store.record([finding({ id: "f1" })]);
    await store.record([finding({ id: "f2" })]);

    const text = new TextDecoder().decode(files.get(FINDINGS_PATH));
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["f1", "f2"]);
  });

  test("読み込めば、書いた指摘がそのまま戻る", async () => {
    await new FindingStore(work).record([finding()]);

    const loaded = await new FindingStore(work).load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: "f1",
      original: "　彼女は振り返らなかった。",
      before: "　朝の廊下は静かだった。",
      after: "　窓の外で鐘が鳴る。",
      hintLine: 12,
      category: "typo",
    });
    expect(loaded[0].status).toBe("pending");
  });

  /** **本体を書き換えず、別の行を足す**（6.96.4）。ここが要 */
  test("退けたことは、指摘の行を書き換えずに別の行で足せる", async () => {
    const store = new FindingStore(work);
    await store.record([finding()]);
    const before = new TextDecoder().decode(files.get(FINDINGS_PATH));

    await store.decide([
      {
        findingId: "f1",
        time: "2026-09-20T09:00:00.000Z",
        status: "dismissed",
        note: "これは方言なので直さない",
      },
    ]);

    const after = new TextDecoder().decode(files.get(FINDINGS_PATH));
    // 前に書いた行はそのまま残っている（先頭から一致する）
    expect(after.startsWith(before)).toBe(true);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe("dismissed");
    expect(loaded[0].decision?.note).toBe("これは方言なので直さない");
  });

  test("判断を足し直せば、後から来たほうが勝つ", async () => {
    const store = new FindingStore(work);
    await store.record([finding()]);
    await store.decide([
      {
        findingId: "f1",
        time: "2026-09-20T09:00:00.000Z",
        status: "dismissed",
        note: "",
      },
    ]);
    await store.decide([
      {
        findingId: "f1",
        time: "2026-09-21T09:00:00.000Z",
        status: "accepted",
        note: "やっぱり直す",
      },
    ]);

    expect((await store.load())[0].status).toBe("accepted");
  });

  test("ファイルが無ければ、空として扱う（検知そのものは動く）", async () => {
    expect(await new FindingStore(work).load()).toEqual([]);
  });

  /** 同期の競合で1行が壊れても、無事な指摘まで見えなくしない */
  test("壊れた行・競合マーカーが混ざっても、読める行は残る", async () => {
    await new FindingStore(work).record([finding()]);
    const existing = new TextDecoder().decode(files.get(FINDINGS_PATH));
    files.set(
      FINDINGS_PATH,
      new TextEncoder().encode(
        `<<<<<<< HEAD\n${existing}これはJSONではない\n>>>>>>> other\n`
      )
    );

    const loaded = await new FindingStore(work).load();
    expect(loaded.map((view) => view.id)).toEqual(["f1"]);
  });
});

describe("1件の形を読む", () => {
  /** 原文が無ければ、位置を探し直す手がかりが永久に無い（6.96.3） */
  test("原文の無い行は読まない", () => {
    const lines = parseFindingLines(
      [
        JSON.stringify({ kind: "finding", id: "f1", file: "a.txt" }),
        JSON.stringify({
          kind: "finding",
          id: "f2",
          file: "a.txt",
          original: "本文",
        }),
      ].join("\n")
    );

    expect(lines.map((line) => (line.kind === "finding" ? line.id : ""))).toEqual(
      ["f2"]
    );
  });

  test("知らない種類でも止まらず、other として読む", () => {
    const lines = parseFindingLines(
      JSON.stringify({
        kind: "finding",
        id: "f1",
        file: "a.txt",
        original: "本文",
        category: "まだ無い種類",
      })
    );

    expect(lines[0].kind === "finding" && lines[0].category).toBe("other");
  });

  /** **番号に行を混ぜない**（6.96.3）。混ぜると1行足すだけで別物になる */
  test("番号は、行が動いても変わらない", () => {
    expect(findingId("a.txt", "原文", "語", "直し", "typo")).toBe(
      findingId("a.txt", "原文", "語", "直し", "typo")
    );
    // 絶対パスでも相対パスでも揃う
    expect(
      findingId("C:\\novels\\作品\\本文\\a.txt", "原文", "語", "直し", "typo")
    ).toBe(findingId("本文/a.txt", "原文", "語", "直し", "typo"));
    // 中身が違えば別物
    expect(findingId("a.txt", "原文", "語", "直し", "typo")).not.toBe(
      findingId("a.txt", "原文", "語", "別の直し", "typo")
    );
  });

  test("同じ番号が2回来たら、後から来たほうの手がかりを採る", () => {
    const views = resolveFindings([
      { kind: "finding", ...finding({ hintLine: 12 }) },
      { kind: "finding", ...finding({ hintLine: 40 }) },
    ]);

    expect(views).toHaveLength(1);
    expect(views[0].hintLine).toBe(40);
  });
});

describe("期限（既定3日）", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  test("3日以内なら、まだ隠さない", () => {
    expect(
      isFindingExpired("2026-09-17T12:00:00.000Z", 3, now)
    ).toBe(false);
  });

  test("3日を過ぎたら隠す", () => {
    expect(isFindingExpired("2026-09-15T11:00:00.000Z", 3, now)).toBe(true);
  });

  /** ちょうど3日は、まだ残す（切り捨てるなら作者が見られなくなる側） */
  test("ちょうど3日は、まだ隠さない", () => {
    expect(isFindingExpired("2026-09-16T12:00:00.000Z", 3, now)).toBe(false);
  });

  test("0 なら無期限（どれだけ古くても隠さない）", () => {
    expect(isFindingExpired("2020-01-01T00:00:00.000Z", 0, now)).toBe(false);
  });

  /** 日時が読めないものを隠すと、作者は二度と見られない */
  test("日時が読めない指摘は隠さない", () => {
    expect(isFindingExpired("", 3, now)).toBe(false);
    expect(isFindingExpired("きのう", 3, now)).toBe(false);
  });

  /** 機械が2台あると時計はずれる。ずれた側の指摘を消さない */
  test("未来の日時（時計のずれ）でも隠さない", () => {
    expect(isFindingExpired("2026-09-25T00:00:00.000Z", 3, now)).toBe(false);
  });
});

describe("並べてよい指摘を選ぶ", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  function view(overrides: Partial<FindingView>): FindingView {
    return { ...finding(), status: "pending", ...overrides };
  }

  test("期限切れは並べない", () => {
    const kept = visibleFindings(
      [
        view({ id: "新しい", time: "2026-09-18T12:00:00.000Z" }),
        view({ id: "古い", time: "2026-09-01T12:00:00.000Z" }),
      ],
      3,
      now
    );

    expect(kept.map((entry) => entry.id)).toEqual(["新しい"]);
  });

  test("判断の済んだものは並べない", () => {
    const kept = visibleFindings(
      [
        view({ id: "未決" }),
        view({ id: "採った", status: "accepted" }),
        view({ id: "退けた", status: "dismissed" }),
      ],
      3,
      now
    );

    expect(kept.map((entry) => entry.id)).toEqual(["未決"]);
  });

  /**
   * **隠すだけで、ファイルからは消さない**（6.96.4、作者の裁定）。
   * 時計のずれや、ノートPCを久しぶりに開いたときに、作者が見る前に
   * 消えるのを防ぐ。
   */
  test("隠しても、読み込みには残っている", () => {
    const all = [
      view({ id: "古い", time: "2026-09-01T12:00:00.000Z" }),
    ];

    expect(visibleFindings(all, 3, now)).toHaveLength(0);
    expect(all).toHaveLength(1);
  });
});
