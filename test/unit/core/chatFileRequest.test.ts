import { describe, expect, test } from "vitest";
import {
  MISSING_FILE_HINTS,
  OVERVIEW_EPISODE_LIMIT,
  OVERVIEW_FILE_CHARS,
  REQUESTED_FILE_CHARS,
  formatChatOverview,
  missingFileHintsFrom,
  readRequestedFiles,
  type RequestedFileAccess,
} from "../../../src/core/chatFileRequest";

/**
 * 相談で求められたファイルを読む部品（0.85.1 で相談パネルから core へ寄せた）。
 *
 * **製品の相談パネルと MCP の相談が同じものを通る。** ここでは読み方
 * （`RequestedFileAccess`）を作り物にして、振る舞いだけを見る。
 */

/** 作り物の作品フォルダー。`files` は相対パス → 中身 */
function access(files: Record<string, string>): RequestedFileAccess & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readText: async (relative) => {
      reads.push(relative);
      return files[relative];
    },
    siblingNames: async (relative) => {
      const slash = relative.lastIndexOf("/");
      const folder = slash >= 0 ? relative.slice(0, slash + 1) : "";
      const names = Object.keys(files)
        .filter((name) => name.startsWith(folder) && !name.slice(folder.length).includes("/"))
        .map((name) => name.slice(folder.length));
      return names.length > 0 ? names : undefined;
    },
  };
}

describe("readRequestedFiles", () => {
  test("あるファイルはそのまま読む", async () => {
    const result = await readRequestedFiles(
      ["本文/a.txt"],
      access({ "本文/a.txt": "本文A" })
    );
    expect(result).toEqual({ files: [{ path: "本文/a.txt", content: "本文A" }], missing: [] });
  });

  test("無いファイルは、拡張子だけ違う原稿が1つあればそれを読む", async () => {
    const result = await readRequestedFiles(
      ["本文/a.txt"],
      access({ "本文/a.md": "本文A" })
    );
    expect(result.files).toEqual([{ path: "本文/a.md", content: "本文A" }]);
    expect(result.missing).toEqual([]);
  });

  test("読めなかったものは missing に入れる（黙って飛ばさない）", async () => {
    const result = await readRequestedFiles(
      ["本文/無い.txt", "本文/a.txt"],
      access({ "本文/a.txt": "本文A" })
    );
    expect(result.missing).toEqual(["本文/無い.txt"]);
    expect(result.files.map((file) => file.path)).toEqual(["本文/a.txt"]);
  });

  test("同じファイルに行き着く2つの指定は1回だけ渡す", async () => {
    const result = await readRequestedFiles(
      ["本文/a.txt", "本文/a.md"],
      access({ "本文/a.md": "本文A" })
    );
    expect(result.files).toHaveLength(1);
  });

  test("長いファイルは上限で切り、切ったことを書く", async () => {
    const long = "あ".repeat(REQUESTED_FILE_CHARS + 10);
    const result = await readRequestedFiles(["a.txt"], access({ "a.txt": long }));
    expect(result.files[0].content).toBe(
      `${"あ".repeat(REQUESTED_FILE_CHARS)}\n（以下省略）`
    );
  });
});

describe("missingFileHintsFrom", () => {
  test("番号の合う候補を先に、上限で切る。元の件数も返す", () => {
    const all = Array.from({ length: 20 }, (_, index) => ({
      path: `本文/episode_${String(index + 1).padStart(4, "0")}.md`,
      label: `第${index + 1}話`,
    }));
    const result = missingFileHintsFrom(["本文/episode_0015.txt"], all);
    expect(result.availableTotal).toBe(20);
    expect(result.available).toHaveLength(MISSING_FILE_HINTS);
    expect(result.available[0].label).toBe("第15話");
  });
});

describe("formatChatOverview", () => {
  test("材料が何も無ければ undefined", () => {
    expect(formatChatOverview({ episodes: [], documents: [] })).toBeUndefined();
  });

  test("話の一覧には各話の場所を添え、文書は見出しつきで並べる", () => {
    const text = formatChatOverview({
      episodes: [{ path: "本文/001.md", label: "第1話 出会い" }],
      documents: [{ label: "プロット", file: "plot.md", text: "港町の話" }],
    });
    expect(text).toBe(
      "【作品の全体像】\n全1話。\n話の一覧: 第1話 出会い（本文/001.md）\n【プロット（plot.md）】\n港町の話"
    );
  });

  test("話が多いときは中間を省き、省いたことを書く。長い文書は切る", () => {
    const episodes = Array.from({ length: OVERVIEW_EPISODE_LIMIT + 5 }, (_, index) => ({
      path: `本文/${index + 1}.md`,
      label: `第${index + 1}話`,
    }));
    const text = formatChatOverview({
      episodes,
      documents: [{ label: "プロット", file: "plot.md", text: "あ".repeat(OVERVIEW_FILE_CHARS + 1) }],
    });
    expect(text).toContain("（多いため中間を省略）");
    expect(text).toContain("…（中略）…");
    expect(text).toContain(`全${OVERVIEW_EPISODE_LIMIT + 5}話。`);
    expect(text).toContain("（以下省略。全文が要るなら needFiles で求めてください）");
  });
});
