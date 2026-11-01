import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の「未登録の自分の作品」の枠（作者の指示 2026-11-01。設計書6.99.8）。
 *
 * - 作品の行の**後ろ**に、見出し「未登録の自分の作品」の下に並ぶ。題とサイト名だけで、中身は無い
 * - 登録した作品の台帳と同じサイト・作品IDのものは出ない。出さないを選んだものも出ない
 * - 1つも無ければ見出しも出ない
 */

const scanWork = vi.fn();
vi.mock("../../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

vi.mock("../../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { schemaVersion: "1", chapters: [] };
    }
  },
  ChapterStoreError: class extends Error {},
}));

const loadPosting = vi.fn();
vi.mock("../../../src/core/postingStore", () => ({
  PostingStore: class {
    load() {
      return loadPosting();
    }
  },
  PostingStoreError: class extends Error {},
}));

vi.mock("../../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

import { WorkTreeProvider, type OwnWorksSource, type TreeNode } from "../../../src/views/workTree";
import { emptyPostingLedger, withSiteProfile } from "../../../src/models/posting";
import type { UnregisteredOwnWork } from "../../../src/core/unregisteredOwnWorks";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import { WORK_LIST_SNAPSHOT_KEY, buildWorkListSnapshot } from "../../../src/core/workListSnapshot";

const work: WorkEntry = {
  id: "work_1",
  title: "登録した作品",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const frames: UnregisteredOwnWork[] = [
  { site: "kakuyomu", workId: "111", title: "登録済みの作品", ownedVia: "owner-page", lastSeenAt: "2026-11-01" },
  { site: "kakuyomu", workId: "222", title: "未登録の作品", ownedVia: "owner-page", lastSeenAt: "2026-11-01" },
  { site: "alphapolis", workId: "123456789", title: "出さない作品", ownedVia: "owner-page", lastSeenAt: "2026-11-01", hidden: true },
];

function source(list: UnregisteredOwnWork[], waiting: string[] = []): OwnWorksSource {
  return {
    list: () => list,
    isWaiting: (entry) => waiting.includes(entry.workId),
    onDidChange: () => ({ dispose() {} }),
  };
}

async function root(
  works: WorkEntry[],
  own: OwnWorksSource | undefined
): Promise<{ provider: WorkTreeProvider; nodes: TreeNode[] }> {
  const registry = {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(registry);
  if (own) provider.setOwnWorksSource(own);
  return { provider, nodes: await provider.getChildren() };
}

beforeEach(() => {
  scanWork.mockReset();
  loadPosting.mockReset();
  scanWork.mockResolvedValue({
    episodes: [],
    stats: {
      fileCount: 1,
      totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  loadPosting.mockResolvedValue(withSiteProfile(emptyPostingLedger(), "kakuyomu", { workId: "111" }));
});

describe("未登録の自分の作品の枠", () => {
  test("作品の行の後ろに見出しが1つ付き、その下に未登録の作品だけが並ぶ", async () => {
    const { provider, nodes } = await root([work], source(frames));
    expect(nodes.map((node) => node.type)).toEqual(["work", "ownWorksHeader"]);
    const header = nodes[1];
    const headerItem = provider.getTreeItem(header);
    expect(headerItem.label).toBe("未登録の自分の作品");
    // 出さないにした作品が1つあるので、戻す道の印が付く
    expect(headerItem.contextValue).toBe("ownWorksHeader-hasHidden");

    const children = await provider.getChildren(header);
    const items = children.map((node) => provider.getTreeItem(node));
    // 登録済み（台帳のカクヨム 111）と、出さないを選んだものは出ない
    expect(items.map((item) => item.label)).toEqual(["未登録の作品"]);
    expect(items[0].description).toBe("カクヨム");
    expect(items[0].contextValue).toBe("ownWorkFrame");
    // 中身（話）は無い
    expect(items[0].collapsibleState).toBe(0);
    expect(await provider.getChildren(children[0])).toEqual([]);
  });

  test("待っている作品には「バックアップ待ち」と添える", async () => {
    const { provider, nodes } = await root([work], source(frames, ["222"]));
    const children = await provider.getChildren(nodes[1]);
    expect(provider.getTreeItem(children[0]).description).toBe("カクヨム・バックアップ待ち");
  });

  test("枠が1つも無ければ見出しも出さない", async () => {
    const onlyRegistered = [frames[0]];
    expect((await root([work], source(onlyRegistered))).nodes.map((node) => node.type)).toEqual(["work"]);
    expect((await root([work], source([]))).nodes.map((node) => node.type)).toEqual(["work"]);
    expect((await root([work], undefined)).nodes.map((node) => node.type)).toEqual(["work"]);
  });

  test("出さないにした作品があれば、見出しの印で［出さないにした作品を戻す］を出す。無ければ出さない", async () => {
    const withHidden = await root([work], source(frames));
    expect(withHidden.provider.getTreeItem(withHidden.nodes[1]).contextValue).toBe(
      "ownWorksHeader-hasHidden"
    );
    const none = await root([work], source([frames[1]]));
    expect(none.provider.getTreeItem(none.nodes[1]).contextValue).toBe("ownWorksHeader");
  });

  test("出さないにした作品だけが残っていても、戻す道のために見出しは出す（枠は0）", async () => {
    const { provider, nodes } = await root([work], source([frames[0], frames[2]]));
    expect(nodes.map((node) => node.type)).toEqual(["work", "ownWorksHeader"]);
    expect(await provider.getChildren(nodes[1])).toEqual([]);
    expect(provider.getTreeItem(nodes[1]).contextValue).toBe("ownWorksHeader-hasHidden");
  });

  /*
    登録した作品が0件のとき、VS Code の「まだ作品が登録されていません」の案内（viewsWelcome）は
    一覧が空のときだけ出る。枠の行があると出なくなるので、同じ文と登録の入口を枠の上に置く
  */
  test("登録した作品が0件で枠があるときは、枠の上に登録の案内と入口の行を置く", async () => {
    const { provider, nodes } = await root([], source(frames));
    const items = nodes.map((node) => provider.getTreeItem(node));
    expect(items[0].label).toBe("まだ作品が登録されていません。");
    const commands = items
      .map((item) => item.command?.command)
      .filter((command): command is string => command !== undefined);
    expect(commands).toEqual([
      "novelai.importWorkFromZip",
      "novelai.addWork",
      "novelai.createWork",
      "novelai.addWorkFromGithub",
    ]);
    expect(nodes.at(-1)?.type).toBe("ownWorksHeader");
  });

  test("登録した作品が0件で枠も無ければ、何も返さない（いつもの案内が出る）", async () => {
    expect((await root([], source([]))).nodes).toEqual([]);
    expect((await root([], undefined)).nodes).toEqual([]);
  });

  test("作品の右クリックの印（work-）と重ならない", async () => {
    const { provider, nodes } = await root([work], source(frames));
    const children = await provider.getChildren(nodes[1]);
    expect(String(provider.getTreeItem(children[0]).contextValue)).not.toMatch(/^work-/);
  });
});

/*
  作者の実機（0.119.0、2026-11-01）で枠が出なかった件の再現。覚えには2作品が入っているのに、
  作品一覧のどこにも見出しが無かった。実機と同じ形——まとまり（書庫「novel」）に17作品、
  ほかに単独の作品が4つ、前回の一覧の控えがある——で描く
*/
describe("実機と同じ形（書庫があり、前回の一覧の控えがある）でも枠が出る", () => {
  const library = Array.from({ length: 17 }, (_, index): WorkEntry => ({
    id: `novel_${index}`,
    title: `書庫の作品${index}`,
    folderPath: path.join("C:", "Users", "someone", "novel", `作品${index}`),
    registeredAt: "2026-09-04T00:00:00.000Z",
  }));
  // 「確認用コピー」も2作品を抱えるまとまり（書庫が2つあると、一覧に書庫の段が付く）
  const copies = ["教科書チート_確認用", "星の数_確認用"].map(
    (name, index): WorkEntry => ({
      id: `copy_${index}`,
      title: name,
      folderPath: path.join("C:", "Users", "someone", "Documents", "確認用コピー", name),
      registeredAt: "2026-09-04T00:00:00.000Z",
    })
  );
  const standalone = ["GitHub試験_確認用", "GitHub試験_確認用2", "テスト作品"].map(
    (name, index): WorkEntry => ({
      id: `solo_${index}`,
      title: name,
      folderPath: path.join("C:", "Users", "someone", "Documents", `置き場${index}`, name),
      registeredAt: "2026-09-04T00:00:00.000Z",
    })
  );
  const works = [...library, ...copies, ...standalone];
  const author: UnregisteredOwnWork[] = [
    {
      site: "kakuyomu",
      workId: "16816927861924296900",
      title: "星の数ほどいるクズ",
      ownedVia: "owner-page",
      lastSeenAt: "2026-11-01T07:47:50.743Z",
    },
  ];

  function snapshotStore() {
    const data = new Map<string, unknown>([
      [
        WORK_LIST_SNAPSHOT_KEY,
        buildWorkListSnapshot(
          works.map((entry) => ({
            id: entry.id,
            folderPath: entry.folderPath,
            fileCount: 3,
            totals: { gross: 10, net: 9, lines: 1, paragraphs: 1, manuscriptLines: 1 },
            conflictedCount: 0,
          })),
          "t"
        ),
      ],
    ]);
    return {
      get: (key: string) => data.get(key),
      update: async (key: string, value: unknown) => {
        data.set(key, value);
      },
    };
  }

  test("走査を待って描いたとき、書庫と作品の後ろに見出しが付く", async () => {
    loadPosting.mockResolvedValue(emptyPostingLedger());
    const { nodes } = await root(works, source(author));
    expect(nodes.at(-1)?.type).toBe("ownWorksHeader");
    expect(nodes.filter((node) => node.type === "library")).toHaveLength(2);
  });

  test("控えで先に描いたあと、裏の走査が終わって描き直した回で見出しが付く", async () => {
    loadPosting.mockResolvedValue(emptyPostingLedger());
    const registry = {
      list: () => works,
      onDidChange: () => ({ dispose() {} }),
    } as unknown as WorkRegistry;
    const provider = new WorkTreeProvider(registry, undefined, undefined, undefined, undefined, {
      snapshot: snapshotStore(),
    });
    let redraws = 0;
    provider.onDidChangeTreeData(() => redraws++);
    provider.setOwnWorksSource(source(author));
    await provider.getChildren();
    await vi.waitFor(() => expect(redraws).toBeGreaterThan(0));
    const second = await provider.getChildren();
    expect(second.at(-1)?.type).toBe("ownWorksHeader");
  });

  /*
    これが実機で起きていたこと（0.119.0 までは、控えの回に枠を出さない作りだった）。
    裏の走査が長引く・終わらない作品が1つでもあると、控えの行のまま枠が出ない。
    枠に要るのは各作品の投稿状態（小さな JSON）だけで、原稿の走査は要らない
  */
  test("裏の走査が終わらなくても、控えで描いた回に見出しが付く", async () => {
    loadPosting.mockResolvedValue(emptyPostingLedger());
    scanWork.mockImplementation(() => new Promise(() => {}));
    const registry = {
      list: () => works,
      onDidChange: () => ({ dispose() {} }),
    } as unknown as WorkRegistry;
    const provider = new WorkTreeProvider(registry, undefined, undefined, undefined, undefined, {
      snapshot: snapshotStore(),
    });
    provider.setOwnWorksSource(source(author));
    const first = await provider.getChildren();
    expect(first.filter((node) => node.type === "library")).toHaveLength(2);
    expect(first.at(-1)?.type).toBe("ownWorksHeader");
    expect((await provider.getChildren(first.at(-1))).map((node) => node.type)).toEqual([
      "ownWorkFrame",
    ]);
  });
});
