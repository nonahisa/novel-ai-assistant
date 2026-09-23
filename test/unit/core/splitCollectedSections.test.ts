import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  collectedSectionStarts,
  describeSplitSections,
  planSplitSections,
  splitPartSections,
} from "../../src/core/collectedSections";
import { planSplit } from "../../src/core/splitCollected";
import { splitCollectedFile } from "../../src/features/splitCollectedFile";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * 合本を話ごとに分けるとき、中の【第N章】から章を立てる（設計書6.66.4・6.2.2）。
 *
 * 作者の問い（2026-09-23）：「なろうやカクヨムのバックアップから章立ては
 * 読み取れませんでしたか？」——なろうの合本には章の見出しが入っており、
 * 読めてもいた（`collectedFile.ts` の `part`）。ところが**章の台帳は
 * ファイルしか指せない**ので、合本のままでは2章目以降を置く場所が無い
 * （合本の途中には章を置けない、6.66.4）。
 *
 * そこで**分けたときに立てる。** 分けたあとなら、章の始まりの話が
 * 実在のファイルになる。
 *
 * 材料は作者の `N5078JI.txt`（5章・31話）の形を写した小さな合本
 * （3章・6話）。作者のファイルそのものは読まない。
 */

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

/** なろうの合本の形。章の見出しは**章の最初の話にだけ**付く */
function episode(n: number, title: string, part?: string): string[] {
  return [
    SEP(n),
    ...(part === undefined ? [] : [`【第${partNumber(part)}章】`, part, ""]),
    "【エピソードタイトル】",
    `${toWide(n)}話　${title}`,
    "",
    "【本文】",
    `${title}の本文。`,
    "",
    "【リアクション】",
    "いいね: 3件",
    "",
  ];
}

const PART_NAMES = [
  "主治医　中神 杏奈",
  "担当編集　鳴海 キサラ",
  "リハビリ担当　倉内さなえ",
];

function partNumber(name: string): number {
  return PART_NAMES.indexOf(name) + 1;
}

function toWide(n: number): string {
  return String(n).replace(/[0-9]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0xfee0)
  );
}

/** 3章・6話。1話・3話・6話が章の始まり */
function collectedWithParts(eol = "\r\n"): string {
  return [
    "【Nコード】",
    "N0000XX",
    "",
    ...episode(1, "目覚め", PART_NAMES[0]),
    ...episode(2, "検査"),
    ...episode(3, "条件付きの同意", PART_NAMES[1]),
    ...episode(4, "原稿"),
    ...episode(5, "締め切り"),
    ...episode(6, "歩く練習", PART_NAMES[2]),
  ].join(eol);
}

/** 章の見出しが1つも無い合本 */
function collectedWithoutParts(): string {
  return [
    ...episode(1, "目覚め"),
    ...episode(2, "検査"),
    ...episode(3, "条件付きの同意"),
  ].join("\n");
}

describe("章の変わり目を拾う（純粋な関数）", () => {
  test("章の見出しが変わった話ごとに、章が1つ立つ", () => {
    const sections = collectedSectionStarts([
      { order: 1, part: "第一部" },
      { order: 2, part: null },
      { order: 3, part: "第二部" },
    ]);

    expect(sections).toEqual([
      { name: "第一部", startOrder: 1, startIndex: 0 },
      { name: "第二部", startOrder: 3, startIndex: 2 },
    ]);
  });

  test("見出しの無い話は、直前の章に入る（新しい章を立てない）", () => {
    const sections = collectedSectionStarts([
      { order: 1, part: "第一部" },
      { order: 2, part: null },
      { order: 3, part: null },
    ]);

    expect(sections).toHaveLength(1);
  });

  test("最初の章より前の話は、どの章にも入れない", () => {
    // 章なしの話を勝手に第1章へ入れない（作者が書いていない章を作らない）
    const sections = collectedSectionStarts([
      { order: 1, part: null },
      { order: 2, part: "第一部" },
    ]);

    expect(sections).toEqual([
      { name: "第一部", startOrder: 2, startIndex: 1 },
    ]);
  });

  test("同じ題が続いても、2つ目を別の章にしない", () => {
    // アルファポリスから載せ替えた合本などで、同じ章題が話ごとに付いていても
    // 章は1つ
    const sections = collectedSectionStarts([
      { order: 1, part: "第一部" },
      { order: 2, part: "第一部" },
    ]);

    expect(sections).toHaveLength(1);
  });

  test("章の題はそのまま持つ。前後の空白だけ落とす", () => {
    const sections = collectedSectionStarts([
      { order: 1, part: "　主治医　中神 杏奈 " },
    ]);

    expect(sections[0].name).toBe("主治医　中神 杏奈");
  });

  test("空白だけの題は、見出しが無いのと同じに扱う", () => {
    const sections = collectedSectionStarts([
      { order: 1, part: "第一部" },
      { order: 2, part: "　" },
    ]);

    expect(sections).toHaveLength(1);
  });

  test("章の見出しが1つも無ければ、何も立てない", () => {
    expect(
      collectedSectionStarts([
        { order: 1, part: null },
        { order: 2, part: null },
      ])
    ).toEqual([]);
  });
});

describe("分け方（planSplit）から章を拾う", () => {
  test("3章・6話の合本から、名前と開始の話つきで3章が立つ", () => {
    const plan = planSplit(collectedWithParts(), { extension: ".txt" })!;

    const sections = splitPartSections(plan.parts);

    expect(sections.map((section) => section.name)).toEqual(PART_NAMES);
    expect(sections.map((section) => section.startOrder)).toEqual([1, 3, 6]);
  });

  test("章の無い合本では、章を立てない", () => {
    const plan = planSplit(collectedWithoutParts(), { extension: ".txt" })!;

    expect(splitPartSections(plan.parts)).toEqual([]);
  });
});

describe("台帳へ書くものを決める", () => {
  const startPathOf = (fileName: string) => `本文/${fileName}`;

  test("台帳が空なら、分けたファイルを指して章を立てる", () => {
    const plan = planSplit(collectedWithParts(), { extension: ".txt" })!;

    const result = planSplitSections({
      parts: plan.parts,
      existingChapters: [],
      startPathOf,
    });

    expect(result.kind).toBe("create");
    if (result.kind !== "create") return;
    expect(result.chapters).toEqual([
      { name: PART_NAMES[0], startEpisodePath: `本文/${plan.parts[0].fileName}` },
      { name: PART_NAMES[1], startEpisodePath: `本文/${plan.parts[2].fileName}` },
      { name: PART_NAMES[2], startEpisodePath: `本文/${plan.parts[5].fileName}` },
    ]);
  });

  test("**既に章のある作品は、上書きしない**", () => {
    const plan = planSplit(collectedWithParts(), { extension: ".txt" })!;

    const result = planSplitSections({
      parts: plan.parts,
      existingChapters: [
        { name: "作者が付けた章", startEpisodePath: "本文/episode_0001.txt" },
      ],
      startPathOf,
    });

    expect(result.kind).toBe("existing");
  });

  test("台帳を読めなければ、章を立てない", () => {
    // 壊れた台帳の上へこちらの章を書くと、作者の章が消える
    const plan = planSplit(collectedWithParts(), { extension: ".txt" })!;

    const result = planSplitSections({
      parts: plan.parts,
      existingChapters: null,
      startPathOf,
    });

    expect(result.kind).toBe("unreadable");
  });

  test("章の無い合本では、何も言わない", () => {
    const plan = planSplit(collectedWithoutParts(), { extension: ".txt" })!;

    const result = planSplitSections({
      parts: plan.parts,
      existingChapters: [],
      startPathOf,
    });

    expect(result.kind).toBe("none");
    expect(describeSplitSections(result)).toBeNull();
  });

  test("確認の文に、章の数と題が出る", () => {
    const plan = planSplit(collectedWithParts(), { extension: ".txt" })!;
    const result = planSplitSections({
      parts: plan.parts,
      existingChapters: [],
      startPathOf,
    });

    const text = describeSplitSections(result) ?? "";

    expect(text).toContain("章を3個立てます");
    expect(text).toContain("「主治医　中神 杏奈」");
  });

  test("既に章のある作品では、立てないことを確認の文で言う", () => {
    const plan = planSplit(collectedWithParts(), { extension: ".txt" })!;
    const result = planSplitSections({
      parts: plan.parts,
      existingChapters: [
        { name: "作者が付けた章", startEpisodePath: "本文/episode_0001.txt" },
      ],
      startPathOf,
    });

    const text = describeSplitSections(result) ?? "";

    expect(text).toContain("既に章");
    expect(text).toContain("立てません");
  });
});

/* ── 分割の操作をとおして確かめる ───────────────────────────── */

const work: WorkEntry = {
  id: "work_split_sections",
  title: "コールドスリープ",
  folderPath: path.join("C:", "novels", "coldsleep"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const collectedPath = path.join(work.folderPath, "本文", "N0000XX.txt");
const chaptersPath = diskPath(
  path.join(work.folderPath, "設定", "章立て.json")
);

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

describe("「合本を話ごとに分ける」で章が立つ", () => {
  const disk = new Map<string, Uint8Array>();
  let confirmDetail = "";
  let confirmAnswer: string | undefined = "分ける";

  beforeEach(() => {
    disk.clear();
    confirmDetail = "";
    confirmAnswer = "分ける";
    workspace.textDocuments = [];
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
      readDirectory: async (uri: { fsPath: string }) => {
        const prefix = `${uri.fsPath}${path.sep}`;
        return [...disk.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .filter((rest) => !rest.includes(path.sep))
          .map((name) => [name, 1]);
      },
    } as unknown as typeof workspace.fs;

    // 分割の確認（モーダル）で何を見せたかを覚え、「分ける」を押す
    window.showWarningMessage = (async (
      _message: string,
      options?: { detail?: string },
      ...items: string[]
    ) => {
      if (options && typeof options === "object" && "detail" in options) {
        confirmDetail = options.detail ?? "";
        return items.includes("分ける") ? confirmAnswer : undefined;
      }
      return undefined;
    }) as typeof window.showWarningMessage;
    window.showInformationMessage = (async () =>
      undefined) as typeof window.showInformationMessage;
    window.showErrorMessage = (async () =>
      undefined) as typeof window.showErrorMessage;
  });

  function put(filePath: string, text: string): void {
    disk.set(diskPath(filePath), new TextEncoder().encode(text));
  }

  function ledger(): { chapters: Array<{ name: string; startEpisodePath: string }> } | null {
    const bytes = disk.get(chaptersPath);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  test("分けたあと、章の台帳に3章が立つ（開始は分けたファイル）", async () => {
    put(collectedPath, collectedWithParts());

    await splitCollectedFile(work, collectedPath);

    const written = ledger();
    expect(written).not.toBeNull();
    expect(written!.chapters.map((chapter) => chapter.name)).toEqual(PART_NAMES);
    // **実在のファイルを指す**（合本を指さない。6.66.4）
    for (const chapter of written!.chapters) {
      expect(chapter.startEpisodePath.startsWith("本文/episode_")).toBe(true);
      expect(
        disk.has(diskPath(path.join(work.folderPath, chapter.startEpisodePath)))
      ).toBe(true);
    }
    expect(written!.chapters[1].startEpisodePath).toContain("0003");
    expect(written!.chapters[2].startEpisodePath).toContain("0006");
  });

  test("押す前の確認画面に、立てる章の数が出る", async () => {
    put(collectedPath, collectedWithParts());

    await splitCollectedFile(work, collectedPath);

    expect(confirmDetail).toContain("章を3個立てます");
  });

  test("「分ける」を押さなければ、台帳も作らない", async () => {
    put(collectedPath, collectedWithParts());
    confirmAnswer = undefined;

    await splitCollectedFile(work, collectedPath);

    expect(ledger()).toBeNull();
  });

  test("**既に章のある作品は、台帳を1文字も変えない**", async () => {
    put(collectedPath, collectedWithParts());
    const authored = `${JSON.stringify(
      {
        schemaVersion: "1",
        chapters: [{ name: "作者が付けた章", startEpisodePath: "本文/前の話.txt" }],
      },
      null,
      2
    )}\n`;
    put(path.join(work.folderPath, "設定", "章立て.json"), authored);

    await splitCollectedFile(work, collectedPath);

    expect(new TextDecoder().decode(disk.get(chaptersPath))).toBe(authored);
    expect(confirmDetail).toContain("既に章");
  });

  test("章の無い合本では、台帳を作らず、確認画面にも章の話を出さない", async () => {
    put(collectedPath, collectedWithoutParts());

    await splitCollectedFile(work, collectedPath);

    expect(ledger()).toBeNull();
    expect(confirmDetail).not.toContain("章を");
  });
});
