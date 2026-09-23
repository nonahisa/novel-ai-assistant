import { describe, expect, test } from "vitest";
import { renamePlotHeading } from "../../src/core/plotDoc";
import { WorkRegistry } from "../../src/core/workRegistry";
import type { WorkEntry } from "../../src/models/types";

/**
 * 作品名の変更（設計書6.1.1。作者の依頼、2026-09-10）。
 *
 * 題は3か所にある。ここで見るのは、AIもファイルシステムも要らない2つ。
 *
 * - 登録（`WorkRegistry.rename`）——一覧・ステータスバーの出どころ
 * - プロットの先頭の見出し（`renamePlotHeading`）——**作者の文書**なので、
 *   元の題と一致するときしか触らない
 */

/** 登録簿の中身を持つだけの `globalState`。書いた値をそのまま覗く */
function fakeContext(works: WorkEntry[]): {
  context: { globalState: unknown };
  saved: () => WorkEntry[];
} {
  let stored = works;
  return {
    context: {
      globalState: {
        get: <T>(_key: string, _defaultValue: T): T => stored as unknown as T,
        update: async (_key: string, value: unknown) => {
          stored = value as WorkEntry[];
        },
      },
    },
    saved: () => stored,
  };
}

function entry(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:\\novels\\${id}`,
    registeredAt: "2026-09-10T00:00:00.000Z",
  };
}

describe("登録の題を変える", () => {
  test("題だけを変え、フォルダーと登録日はそのまま", async () => {
    // **フォルダーを動かさない。** 動かすとGitHubの同期先も書庫の並びも切れる
    const { context, saved } = fakeContext([entry("w1", "旧題"), entry("w2", "別作品")]);
    const registry = new WorkRegistry(context as never);

    const renamed = await registry.rename("w1", "新題");

    expect(renamed?.title).toBe("新題");
    expect(renamed?.folderPath).toBe("C:\\novels\\w1");
    expect(renamed?.registeredAt).toBe("2026-09-10T00:00:00.000Z");
    expect(saved().map((w) => w.title)).toEqual(["新題", "別作品"]);
  });

  test("一覧が更新されたことを知らせる", async () => {
    // 作品一覧とステータスバーは `onDidChange` で追随する
    const { context } = fakeContext([entry("w1", "旧題")]);
    const registry = new WorkRegistry(context as never);
    let fired = 0;
    registry.onDidChange(() => (fired += 1));

    await registry.rename("w1", "新題");

    expect(fired).toBe(1);
  });

  test("前後の空白は落とす", async () => {
    const { context, saved } = fakeContext([entry("w1", "旧題")]);
    const registry = new WorkRegistry(context as never);

    await registry.rename("w1", "  新題  ");

    expect(saved()[0].title).toBe("新題");
  });

  test("空・空白だけ・変更なしのときは書かない", async () => {
    // 空にすると一覧から名前が消える。同じ題なら書く理由が無い
    for (const title of ["", "   ", "旧題"]) {
      const { context } = fakeContext([entry("w1", "旧題")]);
      const registry = new WorkRegistry(context as never);
      let fired = 0;
      registry.onDidChange(() => (fired += 1));

      const result = await registry.rename("w1", title);

      expect(result?.title, title).toBe("旧題");
      expect(fired, title).toBe(0);
    }
  });

  test("登録されていない作品は何もしない", async () => {
    const { context, saved } = fakeContext([entry("w1", "旧題")]);
    const registry = new WorkRegistry(context as never);

    expect(await registry.rename("w9", "新題")).toBeUndefined();
    expect(saved()[0].title).toBe("旧題");
  });
});

describe("プロットの先頭の見出し", () => {
  test("元の題と同じなら、その行だけを変える", () => {
    const before = "# 旧題\n\n## ログライン\n旧題は、まだ旧題のままの物語。\n";

    const { text, changed } = renamePlotHeading(before, "旧題", "新題");

    expect(changed).toBe(true);
    // 本文の「旧題」は触らない（見出しの1行だけが変わる）
    expect(text).toBe("# 新題\n\n## ログライン\n旧題は、まだ旧題のままの物語。\n");
  });

  test("作者が書き換えた見出しは触らない", () => {
    // 登録名を変えたついでに、作者の書いた見出しを消してはいけない
    const before = "# 第一部・構想メモ\n\n## ログライン\n";

    expect(renamePlotHeading(before, "旧題", "新題")).toEqual({
      text: before,
      changed: false,
    });
  });

  test("最初の `# ` 見出しだけを見る", () => {
    // あとから出てくる `# 旧題` は、作者が本文として書いた行かもしれない
    const before = "# ほんとうの題\n\n# 旧題\n";

    expect(renamePlotHeading(before, "旧題", "新題").changed).toBe(false);
  });

  test("`##` は節であって題ではない", () => {
    const before = "## 旧題\n\n本文\n";

    expect(renamePlotHeading(before, "旧題", "新題").changed).toBe(false);
  });

  test("見出しが1つも無ければ変えない", () => {
    const before = "見出しのないプロット\n";

    expect(renamePlotHeading(before, "旧題", "新題").changed).toBe(false);
  });

  test("CRLFの改行はそのまま残す", () => {
    // 改行が変わると、1行直しただけで全行が差分になる
    const before = "# 旧題\r\n\r\n## ログライン\r\n";

    const { text, changed } = renamePlotHeading(before, "旧題", "新題");

    expect(changed).toBe(true);
    expect(text).toBe("# 新題\r\n\r\n## ログライン\r\n");
  });

  test("題の前後の空白は、同じ題とみなす", () => {
    const before = "#   旧題  \n";

    expect(renamePlotHeading(before, " 旧題 ", "新題")).toEqual({
      text: "# 新題\n",
      changed: true,
    });
  });

  test("元の題が空なら何もしない", () => {
    // 空の題は、どの見出しとも「一致した」ことにしない
    const before = "# 旧題\n";

    expect(renamePlotHeading(before, "  ", "新題").changed).toBe(false);
  });
});
