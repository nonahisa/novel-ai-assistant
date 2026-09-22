import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import {
  commands,
  FileSystemError,
  window,
  workspace,
} from "./support/vscodeStub";
import * as paths from "../../src/core/paths";
import { setFallbackLogRoot, useLogFile } from "../../src/core/logger";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { PickedBackup } from "../../src/features/importWorkFromZip";

/**
 * 相談パネルへ持ち込まれたバックアップを捌く（作者の依頼、2026-09-23）。
 *
 * 見るのは次の4つ——**どれも「書かないこと」と「書くこと」を対で確かめる**
 * （止まるほうだけを試すと、何もしない実装が満点になる）。
 *
 * 1. 当たった作品には、確かめたあとで章といいねだけを足す
 * 2. **原稿は1バイトも変わらない**（本文の違いは記録へ書き出すだけ）
 * 3. 押さなければ何も書かない
 * 4. 当たらなければ、確かめてから新しい作品として取り込む道へ渡す
 *
 * ファイルは作らず、覚え書きの上で動かす（作者の原稿の近くで試験を走らせない）。
 */

const scanned: EpisodeFile[] = [];
const LIBRARY = paths.normalize("c:/小説");
const WORK_FOLDER = paths.join(LIBRARY, "眠りから覚めたら");
const MANUSCRIPT = paths.join(WORK_FOLDER, "本文");
const SETTINGS = paths.join(WORK_FOLDER, "設定");
const CHAPTERS = paths.join(SETTINGS, "章立て.json");
const POSTING = paths.join(SETTINGS, "投稿状態.json");

vi.mock("../../src/core/scanner", () => ({
  scanWork: async () => ({
    episodes: scanned,
    stats: {},
    manuscriptDir: MANUSCRIPT,
    workInfoFiles: [],
    timing: {},
  }),
}));

const { receiveBackup } = await import("../../src/features/backupDrop");

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

interface Spec {
  n: number;
  title: string;
  body: string;
  part?: [number, string];
  likes?: number;
}

function block(spec: Spec): string[] {
  return [
    SEP(spec.n),
    ...(spec.part ? [`【第${spec.part[0]}章】`, spec.part[1], ""] : []),
    "【エピソードタイトル】",
    `${spec.n}話　${spec.title}`,
    "",
    "【本文】",
    spec.body,
    "",
    ...(spec.likes === undefined ? [] : ["【リアクション】", `いいね: ${spec.likes}件`, ""]),
  ];
}

/** 作者のなろうの合本（N5078JI.txt）の形だけを写した材料 */
const SPECS: Spec[] = [
  { n: 1, title: "目覚め", part: [1, "主治医"], body: "　目が覚めた。", likes: 19 },
  { n: 2, title: "検査", body: "　検査が続く。", likes: 16 },
  { n: 3, title: "外へ", part: [2, "学園"], body: "　外は明るかった。", likes: 15 },
];

function narouZip(specs: Spec[] = SPECS, title = "眠りから覚めたら"): Uint8Array {
  const text = [
    "【Nコード】",
    "N5078JI",
    "",
    "【タイトル】",
    title,
    "",
    ...specs.flatMap(block),
  ].join("\n");
  return zipSync({ "N5078JI.txt": new TextEncoder().encode(text) });
}

const disk = new Map<string, Uint8Array>();

function put(file: string, text: string): void {
  disk.set(file, new TextEncoder().encode(text));
}

function text(file: string): string | undefined {
  const bytes = disk.get(file);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** 手元：分け済みの話ごとのファイル（CRLF。原稿が変わらないことを1バイト単位で見る） */
function putSplitManuscript(specs: Spec[] = SPECS): void {
  scanned.length = 0;
  for (const spec of specs) {
    const fileName = `${String(spec.n).padStart(4, "0")}.txt`;
    const filePath = paths.join(MANUSCRIPT, fileName);
    put(filePath, block(spec).join("\r\n"));
    scanned.push({
      filePath,
      fileName,
      ext: ".txt",
      chapterStart: spec.n,
      chapterEnd: spec.n,
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
    } as EpisodeFile);
  }
}

function manuscriptSnapshot(): Map<string, string> {
  return new Map(
    [...disk.entries()]
      .filter(([name]) => name.startsWith(MANUSCRIPT))
      .map(([name, bytes]) => [name, Buffer.from(bytes).toString("hex")])
  );
}

const WORK: WorkEntry = {
  id: "w-sleep",
  title: "コールドスリープ",
  folderPath: WORK_FOLDER,
  registeredAt: "2026-09-23T00:00:00.000Z",
};
const OTHER: WorkEntry = {
  id: "w-other",
  title: "教科書チート",
  folderPath: paths.join(LIBRARY, "教科書チート"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

/** 台帳にNコードを書いておく（作品IDで当たる形） */
function putNcodeLedger(): void {
  put(
    POSTING,
    JSON.stringify({
      schemaVersion: "1",
      sites: [],
      siteProfiles: [{ site: "narou", workId: "n5078ji" }],
      posts: [],
      rankings: [],
      readerStats: [],
    })
  );
}

const modals: Array<{ message: string; detail: string; buttons: string[] }> = [];
let modalAnswer: (message: string, buttons: string[]) => string | undefined;
const executed: string[] = [];
let quickPickItems: Array<{ label: string; description?: string; work?: WorkEntry }> = [];
let quickPickAnswer: ((items: typeof quickPickItems) => unknown) | undefined;

const original = {
  showInformationMessage: window.showInformationMessage,
  showQuickPick: window.showQuickPick,
  executeCommand: commands.executeCommand,
  fs: workspace.fs,
};

beforeEach(() => {
  disk.clear();
  scanned.length = 0;
  modals.length = 0;
  executed.length = 0;
  quickPickItems = [];
  quickPickAnswer = undefined;
  modalAnswer = (_message, buttons) => buttons[0];

  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError(uri.fsPath, "FileNotFound");
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
      if (!bytes) throw new FileSystemError(from.fsPath, "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError(to.fsPath, "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) throw new FileSystemError(uri.fsPath, "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;

  window.showInformationMessage = (async (
    message: string,
    options?: { modal?: boolean; detail?: string },
    ...items: string[]
  ) => {
    if (options && typeof options === "object" && options.modal) {
      modals.push({ message, detail: options.detail ?? "", buttons: items });
      return modalAnswer(message, items);
    }
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showQuickPick = (async (items: unknown) => {
    quickPickItems = items as typeof quickPickItems;
    return quickPickAnswer ? quickPickAnswer(quickPickItems) : undefined;
  }) as typeof window.showQuickPick;
  commands.executeCommand = (async (command: string) => {
    executed.push(command);
    return undefined;
  }) as typeof commands.executeCommand;
});

afterEach(() => {
  window.showInformationMessage = original.showInformationMessage;
  window.showQuickPick = original.showQuickPick;
  commands.executeCommand = original.executeCommand;
  workspace.fs = original.fs;
});

describe("既にある作品に当たったとき", () => {
  it("当たった作品と、足すものの一覧を見せてから確かめる", async () => {
    putSplitManuscript();
    putNcodeLedger();

    await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [OTHER, WORK] }
    );

    expect(modals).toHaveLength(1);
    expect(modals[0].message).toBe(
      "「コールドスリープ」に当たりました（Nコード（N5078JI）が一致）。取り込みますか？"
    );
    expect(modals[0].detail).toContain("章：2個立てます");
    expect(modals[0].detail).toContain("いいね3話ぶん");
    expect(modals[0].detail).toContain("本文の違い：ありません");
    expect(modals[0].buttons).toEqual(["取り込む"]);
  });

  it("押すと章といいねだけが台帳に入り、**原稿は1バイトも変わらない**", async () => {
    putSplitManuscript();
    putNcodeLedger();
    const before = manuscriptSnapshot();

    const result = await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [OTHER, WORK] }
    );

    expect(result?.message).toBe("「コールドスリープ」へ取り込みました：章2・いいね3話ぶん");
    expect(JSON.parse(text(CHAPTERS) ?? "{}").chapters).toEqual([
      { name: "主治医", startEpisodePath: "本文/0001.txt" },
      { name: "学園", startEpisodePath: "本文/0003.txt" },
    ]);
    const ledger = JSON.parse(text(POSTING) ?? "{}");
    expect(
      ledger.readerStats.map((row: { episode?: number; metrics: unknown; source: string }) => [
        row.episode,
        row.metrics,
        row.source,
      ])
    ).toEqual([
      [1, { likes: 19 }, "backup"],
      [2, { likes: 16 }, "backup"],
      [3, { likes: 15 }, "backup"],
    ]);
    expect(manuscriptSnapshot()).toEqual(before);
  });

  it("**本文が違う話は、記録へ書き出すだけで原稿は書き換えない**", async () => {
    // 手元で2話を直してある（まだ投稿していない）
    putSplitManuscript(
      SPECS.map((spec) => (spec.n === 2 ? { ...spec, body: "　手元で直した場面。" } : spec))
    );
    putNcodeLedger();
    const before = manuscriptSnapshot();

    const result = await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [WORK] }
    );

    expect(modals[0].detail).toContain("本文の違い：1話（2話　検査）");
    expect(modals[0].detail).toContain("原稿は書き換えません");
    expect(result?.message).toContain("本文の違い1話");
    expect(result?.recordPath).toBeDefined();
    const record = text(result?.recordPath ?? "") ?? "";
    expect(record).toContain("- 　手元で直した場面。");
    expect(record).toContain("+ 　検査が続く。");
    expect(manuscriptSnapshot()).toEqual(before);
  });

  it("押さなければ、台帳も記録も書かない", async () => {
    putSplitManuscript();
    putNcodeLedger();
    const ledgerBefore = text(POSTING);
    modalAnswer = () => undefined;

    const result = await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [WORK] }
    );

    expect(result).toBeUndefined();
    expect(text(CHAPTERS)).toBeUndefined();
    expect(text(POSTING)).toBe(ledgerBefore);
  });

  it("**台帳に章があれば、章は立てずにいいねだけ足す**", async () => {
    putSplitManuscript();
    putNcodeLedger();
    const authored = JSON.stringify({
      schemaVersion: "1",
      chapters: [{ name: "作者の章", startEpisodePath: "本文/0002.txt" }],
    });
    put(CHAPTERS, authored);

    const result = await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [WORK] }
    );

    expect(modals[0].detail).toContain("既に1個あるため、立てません");
    expect(text(CHAPTERS)).toBe(authored);
    expect(result?.message).toBe("「コールドスリープ」へ取り込みました：いいね3話ぶん");
  });

  it("題で当たったときも、決めつけずに確かめる", async () => {
    putSplitManuscript();
    const titled: WorkEntry = { ...WORK, title: "眠りから覚めたら" };

    await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [titled] }
    );

    expect(modals[0].message).toBe("「眠りから覚めたら」に当たりました（題が一致）。取り込みますか？");
  });

  it("候補が曖昧なら、作品を選ばせる（候補を先頭に、新しい作品も選べる）", async () => {
    putSplitManuscript();
    // フォルダー名も別にする（同じなら、フォルダー名で題が一致して当たりになる）
    const variant: WorkEntry = {
      ...WORK,
      title: "眠りから覚めたら　～別視点～",
      folderPath: paths.join(LIBRARY, "眠りから覚めたら　～別視点～"),
    };
    quickPickAnswer = (items) => items.find((item) => item.work?.id === WORK.id);

    await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [OTHER, variant] }
    );

    expect(quickPickItems[0]).toMatchObject({ label: variant.title, description: "候補" });
    expect(quickPickItems.map((item) => item.label)).toContain("$(add) 新しい作品として取り込む");
    // 選んだあとも、足すものの一覧で確かめる
    expect(modals[0].message).toBe(`「${variant.title}」へ取り込みますか？`);
  });
});

describe("どの作品にも当たらないとき", () => {
  it("確かめてから、新しい作品として取り込む道へ中身ごと渡す", async () => {
    const received: PickedBackup[] = [];

    await receiveBackup(
      { fileName: "N9999ZZ.zip", bytes: narouZip(SPECS, "まったく新しい話") },
      {
        works: [OTHER],
        importAsNew: async (picked) => {
          received.push(picked);
        },
      }
    );

    expect(modals[0].message).toBe(
      "「まったく新しい話」は、登録済みの作品には見当たりませんでした。新しい作品として取り込みますか？"
    );
    expect(received).toHaveLength(1);
    expect(received[0].fileName).toBe("N9999ZZ.zip");
    expect(received[0].inspection.episodeCount).toBe(3);
  });

  it("**確かめで押さなければ、取り込まない**", async () => {
    const received: PickedBackup[] = [];
    modalAnswer = () => undefined;

    const result = await receiveBackup(
      { fileName: "N9999ZZ.zip", bytes: narouZip(SPECS, "まったく新しい話") },
      { works: [OTHER], importAsNew: async (picked) => void received.push(picked) }
    );

    expect(result).toBeUndefined();
    expect(received).toEqual([]);
  });

  it("取り込みの道が繋がっていなければ、メニューの取り込みを開いて選び直してもらう", async () => {
    const result = await receiveBackup(
      { fileName: "N9999ZZ.zip", bytes: narouZip(SPECS, "まったく新しい話") },
      { works: [OTHER] }
    );

    expect(executed).toEqual(["novelai.importWorkFromZip"]);
    expect(result?.message).toContain("もう一度選んでください");
  });
});

describe("受け取れないもの", () => {
  it("バックアップでない種類のファイルは、中を見ずに断る", async () => {
    const result = await receiveBackup(
      { fileName: "表紙.png", bytes: new Uint8Array([1, 2, 3]) },
      { works: [WORK] }
    );

    expect(result?.message).toContain("バックアップとして読めません");
    expect(modals).toEqual([]);
  });

  it("ZIPとして読めなければ、理由を返して何も書かない", async () => {
    const result = await receiveBackup(
      { fileName: "壊れた.zip", bytes: new Uint8Array([1, 2, 3]) },
      { works: [WORK] }
    );

    expect(result?.message).toContain("ZIPファイルとして読めませんでした");
    expect(disk.size).toBe(0);
  });
});

/*
  実機（2026-09-23、0.75.13）：確認用の作品へ取り込んだ回の照合の1行が、
  **関係の無い作品（教科書チート）の記録**へ入り、取り込んだ先の作品には
  何も残っていなかった。照合の `logStep` が、書き先を切り替える
  `useLogFile(work)` より前にあり、直前に触った作品の記録へ落ちていた。
*/
describe("記録（ログ）の書き先", () => {
  const FALLBACK = paths.normalize("c:/保管庫");
  const logOf = (folder: string) =>
    text(paths.join(folder, ".aiwriter", "logs", "actions.log"));
  /** 記録は順番待ちの列で書かれるので、書き終わるまで待つ */
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    setFallbackLogRoot(FALLBACK);
    // 直前に、関係の無い作品を触っていた（書き先がそこに残っている）
    useLogFile(OTHER.folderPath);
  });

  it("取り込んだときは、取り込んだ先の作品の記録に照合と足したものが残る", async () => {
    putSplitManuscript();
    putNcodeLedger();

    await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [OTHER, WORK] }
    );
    await settle();

    expect(logOf(OTHER.folderPath)).toBeUndefined();
    const log = logOf(WORK_FOLDER) ?? "";
    expect(log).toContain("N5078JI.zip");
    expect(log).toContain("Nコード（N5078JI）が一致");
    expect(log).toContain("章2");
    expect(log).toContain("いいね3話");
    expect(log).toContain("本文の違い0話");
  });

  it("確かめで取りやめたときも、取り込み先の記録に取りやめたことが残る", async () => {
    putSplitManuscript();
    putNcodeLedger();
    modalAnswer = () => undefined;

    await receiveBackup(
      { fileName: "N5078JI.zip", bytes: narouZip() },
      { works: [OTHER, WORK] }
    );
    await settle();

    expect(logOf(OTHER.folderPath)).toBeUndefined();
    expect(logOf(WORK_FOLDER) ?? "").toContain("取りやめ");
  });

  it("当たらずに新しい作品へ回したときは、関係の無い作品の記録へ書かない", async () => {
    await receiveBackup(
      { fileName: "N9999ZZ.zip", bytes: narouZip(SPECS, "まったく新しい話") },
      { works: [OTHER], importAsNew: async () => undefined }
    );
    await settle();

    expect(logOf(OTHER.folderPath)).toBeUndefined();
    // 作品が決まっていない段の照合は、拡張機能の保管庫の記録へ
    expect(logOf(FALLBACK) ?? "").toContain("照合");
  });

  it("当たらずに取りやめたときも、関係の無い作品の記録へ書かない", async () => {
    modalAnswer = () => undefined;

    await receiveBackup(
      { fileName: "N9999ZZ.zip", bytes: narouZip(SPECS, "まったく新しい話") },
      { works: [OTHER] }
    );
    await settle();

    expect(logOf(OTHER.folderPath)).toBeUndefined();
  });
});

/*
  実機（2026-09-23、0.75.13）：題が「照合試験_無関係」のバックアップで、
  「『教科書チート』『教科書チート_確認用』は題が同じですが、…」と出た。
*/
describe("見当たらないときの一言", () => {
  const ledgerWith = (folder: string, ncode: string) =>
    put(
      paths.join(folder, "設定", "投稿状態.json"),
      JSON.stringify({
        schemaVersion: "1",
        sites: [],
        siteProfiles: [{ site: "narou", workId: ncode }],
        posts: [],
        rankings: [],
        readerStats: [],
      })
    );

  it("題の違う作品については、IDが違っても何も言わない", async () => {
    ledgerWith(OTHER.folderPath, "n2600go");
    modalAnswer = () => undefined;

    await receiveBackup(
      { fileName: "N0000ZY.zip", bytes: narouZip(SPECS, "照合試験_無関係") },
      { works: [OTHER] }
    );

    expect(modals[0].detail).not.toContain("教科書チート");
    expect(modals[0].detail).not.toContain("題が同じ");
  });

  it("題が同じでIDが違う作品は「題が同じ」、一部だけなら「題の一部が同じ」と言い分ける", async () => {
    const partner: WorkEntry = {
      ...OTHER,
      id: "w-variant",
      title: "教科書チート〜別視点バージョン〜",
      folderPath: paths.join(LIBRARY, "教科書チート〜別視点バージョン〜"),
    };
    ledgerWith(OTHER.folderPath, "n2600go");
    ledgerWith(partner.folderPath, "n2600gp");
    modalAnswer = () => undefined;

    await receiveBackup(
      { fileName: "N0000ZY.zip", bytes: narouZip(SPECS, "教科書チート") },
      { works: [OTHER, partner] }
    );

    expect(modals[0].detail).toContain("「教科書チート」は題が同じですが");
    expect(modals[0].detail).toContain(
      "「教科書チート〜別視点バージョン〜」は題の一部が同じですが"
    );
  });
});
