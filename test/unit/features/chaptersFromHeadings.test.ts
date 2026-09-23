import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  describeEpisodeSections,
  planEpisodeSections,
  readEpisodeSections,
  type EpisodeHeadingSource,
} from "../../../src/core/collectedSections";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 分け済みの作品の、話ごとのファイルの見出しから章を立てる（設計書6.66）。
 *
 * 作者の言葉（2026-09-23）：「章立ては各作品に反映させてください」。
 * 「教科書チート」は話ごとのファイルに分けてあり、7つのファイルの頭に
 * `【第1章】第一章『死の谷』`〜`【第7章】第七章『ログラム公会議』` が
 * 残っているのに、章の台帳が無いので章が1つも出ていなかった。
 *
 * **台帳を書くだけで章が立つ**（原稿の並びも中身も変えない）。守りは
 * 合本を分けるときと同じ——台帳が空のときだけ、押す前に一覧で見せる。
 *
 * 材料は教科書チートの形を写した小さな話ごとのファイル（作者のファイル
 * そのものは読まない）。
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
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

const { chaptersFromHeadings } = await import(
  "../../../src/features/chaptersFromHeadings"
);

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

/** 分けたなろうの話1つぶん。章の最初の話にだけ見出しが付く */
function episodeText(n: number, title: string, part?: [number, string]): string {
  return [
    SEP(n),
    ...(part ? [`【第${part[0]}章】`, part[1], ""] : []),
    "【エピソードタイトル】",
    `${n}話　${title}`,
    "",
    "【本文】",
    `${title}の本文。`,
    "",
  ].join("\r\n");
}

const WORK_FOLDER = path.join("C:", "novels", "textbook");

function source(
  n: number,
  text: string | null
): EpisodeHeadingSource {
  return {
    startEpisodePath: `episode_${String(n).padStart(4, "0")}.txt`,
    label: `第${n}話`,
    text,
  };
}

/** 5話・2章（1話と3話が章の始まり） */
function textbookSources(): EpisodeHeadingSource[] {
  return [
    source(1, episodeText(1, "転生", [1, "第一章『死の谷』"])),
    source(2, episodeText(2, "てこの原理と救助")),
    source(3, episodeText(3, "特別監査官", [2, "第二章『王都招聘と婚約』"])),
    source(4, episodeText(4, "嫌疑")),
    source(5, episodeText(5, "見送り")),
  ];
}

describe("話ごとのファイルの頭から章を拾う（純粋な関数）", () => {
  test("見出しのある話ごとに、名前と開始の話つきで章が立つ", () => {
    const sources = textbookSources();
    const reading = readEpisodeSections(sources);
    const plan = planEpisodeSections({ sources, reading, existingChapters: [] });

    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    expect(plan.chapters).toEqual([
      { name: "第一章『死の谷』", startEpisodePath: "episode_0001.txt" },
      { name: "第二章『王都招聘と婚約』", startEpisodePath: "episode_0003.txt" },
    ]);
  });

  test("**台帳が空でなければ立てない**", () => {
    const sources = textbookSources();
    const reading = readEpisodeSections(sources);
    const plan = planEpisodeSections({
      sources,
      reading,
      existingChapters: [
        { name: "作者の章", startEpisodePath: "episode_0002.txt" },
      ],
    });

    expect(plan.kind).toBe("existing");
  });

  test("見出しの無い作品では何も立てない", () => {
    const sources = [
      source(1, episodeText(1, "転生")),
      source(2, episodeText(2, "検査")),
    ];
    const reading = readEpisodeSections(sources);

    expect(
      planEpisodeSections({ sources, reading, existingChapters: [] }).kind
    ).toBe("none");
  });

  test("区切り行の無い原稿の【第1章】は拾わない", () => {
    // なろうの見出しかどうか決められない（作者が本文に書いた行かもしれない）
    const sources = [source(1, "【第1章】\r\n旅立ち\r\n\r\n本文。")];

    expect(readEpisodeSections(sources).sections).toEqual([]);
  });

  test("読めなかったファイルは数えて、残りから立てる", () => {
    const sources = [
      source(1, episodeText(1, "転生", [1, "第一章『死の谷』"])),
      source(2, null),
      source(3, episodeText(3, "特別監査官", [2, "第二章『王都招聘と婚約』"])),
    ];
    const reading = readEpisodeSections(sources);

    expect(reading.unreadable).toBe(1);
    expect(reading.sections).toHaveLength(2);
  });

  test("合本の途中の見出しは章にできないので、数だけ数える", () => {
    const collected = [
      episodeText(1, "転生", [1, "第一章『死の谷』"]),
      episodeText(2, "特別監査官", [2, "第二章『王都招聘と婚約』"]),
    ].join("\r\n");
    const reading = readEpisodeSections([source(1, collected)]);

    // 合本の頭の見出しは、その合本のファイルから始まる章として立てられる
    expect(reading.sections.map((section) => section.name)).toEqual([
      "第一章『死の谷』",
    ]);
    expect(reading.insideCollected).toBe(1);
  });

  test("確認の本文に、章ごとの題と始まりの話が並ぶ", () => {
    const sources = textbookSources();
    const reading = readEpisodeSections(sources);

    const text = describeEpisodeSections(reading.sections, sources, reading);

    expect(text).toContain("・第一章『死の谷』　← 第1話から");
    expect(text).toContain("・第二章『王都招聘と婚約』　← 第3話から");
    expect(text).toContain("原稿は書き換えません");
  });
});

/* ── 操作をとおして確かめる ─────────────────────────────── */

const work: WorkEntry = {
  id: "work_textbook",
  title: "教科書チート",
  folderPath: WORK_FOLDER,
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const chaptersPath = diskPath(path.join(WORK_FOLDER, "設定", "章立て.json"));

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function episodeFile(n: number, text: string): EpisodeFile {
  const fileName = `episode_${String(n).padStart(4, "0")}.txt`;
  const filePath = path.join(WORK_FOLDER, fileName);
  disk.set(diskPath(filePath), new TextEncoder().encode(text));
  return {
    filePath,
    fileName,
    ext: ".txt",
    chapterStart: n,
    chapterEnd: n,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

const disk = new Map<string, Uint8Array>();

describe("「話の見出しから章を立てる」", () => {
  let confirmMessage = "";
  let confirmDetail = "";
  let confirmAnswer: string | undefined = "章を立てる";
  let infoMessages: string[] = [];

  beforeEach(() => {
    disk.clear();
    scanned.length = 0;
    confirmMessage = "";
    confirmDetail = "";
    confirmAnswer = "章を立てる";
    infoMessages = [];
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
    } as unknown as typeof workspace.fs;

    // 確認（モーダル）は中身を覚えて答える。モーダルでない知らせは積むだけ
    window.showInformationMessage = (async (
      message: string,
      options?: { modal?: boolean; detail?: string },
      ...items: string[]
    ) => {
      if (options && typeof options === "object" && options.modal) {
        confirmMessage = message;
        confirmDetail = options.detail ?? "";
        return items.includes("章を立てる") ? confirmAnswer : undefined;
      }
      infoMessages.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
    window.showWarningMessage = (async () =>
      undefined) as typeof window.showWarningMessage;
    window.showErrorMessage = (async () =>
      undefined) as typeof window.showErrorMessage;
  });

  function ledger(): {
    chapters: Array<{ name: string; startEpisodePath: string }>;
  } | null {
    const bytes = disk.get(chaptersPath);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  }

  function putTextbook(): void {
    scanned.push(
      episodeFile(1, episodeText(1, "転生", [1, "第一章『死の谷』"])),
      episodeFile(2, episodeText(2, "てこの原理と救助")),
      episodeFile(3, episodeText(3, "特別監査官", [2, "第二章『王都招聘と婚約』"])),
      episodeFile(4, episodeText(4, "嫌疑")),
      episodeFile(5, episodeText(5, "訃報", [3, "第三章『王都』"]))
    );
  }

  test("押すと、見出しのある話から章が台帳に立つ", async () => {
    putTextbook();

    expect(await chaptersFromHeadings(work)).toBe(true);

    expect(ledger()?.chapters).toEqual([
      { name: "第一章『死の谷』", startEpisodePath: "episode_0001.txt" },
      { name: "第二章『王都招聘と婚約』", startEpisodePath: "episode_0003.txt" },
      { name: "第三章『王都』", startEpisodePath: "episode_0005.txt" },
    ]);
  });

  test("押す前の確認画面に、章の数と一覧が出る", async () => {
    putTextbook();

    await chaptersFromHeadings(work);

    expect(confirmMessage).toContain("章を3個立てます");
    expect(confirmDetail).toContain("第一章『死の谷』");
    expect(confirmDetail).toContain("第5話から");
  });

  test("押さなければ、台帳を作らない", async () => {
    putTextbook();
    confirmAnswer = undefined;

    expect(await chaptersFromHeadings(work)).toBe(false);
    expect(ledger()).toBeNull();
  });

  test("**既に章のある作品は、台帳を1文字も変えず「既に章があります」と止まる**", async () => {
    putTextbook();
    const authored = `${JSON.stringify(
      {
        schemaVersion: "1",
        chapters: [{ name: "作者の章", startEpisodePath: "episode_0002.txt" }],
      },
      null,
      2
    )}\n`;
    disk.set(chaptersPath, new TextEncoder().encode(authored));

    expect(await chaptersFromHeadings(work)).toBe(false);

    expect(new TextDecoder().decode(disk.get(chaptersPath))).toBe(authored);
    expect(confirmMessage).toBe("");
    expect(infoMessages.join("")).toContain("既に章が1個あります");
  });

  test("**合本の途中に見出しがあれば、1章も立てずに「先に分ける」へ案内する**", async () => {
    // 頭の章だけ立てると台帳が空でなくなり、あとで合本を分けても
    // 「既に章がある」として残りの章が立たなくなる（作者の「コールドスリープ」の形）
    const collected = [
      episodeText(1, "目覚め", [1, "主治医　中神 杏奈"]),
      episodeText(2, "条件付きの同意", [2, "担当編集　鳴海 キサラ"]),
    ].join("\r\n");
    scanned.push({ ...episodeFile(1, collected), collectedCount: 2 });

    expect(await chaptersFromHeadings(work)).toBe(false);

    expect(ledger()).toBeNull();
    expect(confirmMessage).toBe("");
    expect(infoMessages.join("")).toContain("合本を話ごとに分ける");
  });

  test("見出しの無い作品では、何も書かずに見つからないと言う", async () => {
    scanned.push(
      episodeFile(1, episodeText(1, "転生")),
      episodeFile(2, episodeText(2, "検査"))
    );

    expect(await chaptersFromHeadings(work)).toBe(false);

    expect(ledger()).toBeNull();
    expect(confirmMessage).toBe("");
    expect(infoMessages.join("")).toContain("見つかりませんでした");
  });
});
