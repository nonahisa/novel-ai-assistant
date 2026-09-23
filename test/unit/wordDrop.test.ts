import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { commands, FileSystemError, window, workspace } from "./support/vscodeStub";
import * as paths from "../../src/core/paths";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { PickedBackup } from "../../src/features/importWorkFromZip";

/**
 * 相談パネルへ落とされた Word 原稿（.docx）を捌く（作者の裁定、2026-09-23
 * 「相談パネルドロップにも対応してください。相談パネルが既存作の続きでも、
 * わかれば対応できるようにしてください」）。
 *
 * 見るのは次の4つ——**書くことと書かないことを対で確かめる**。
 *
 * 1. 既存作品の続きと分かれば、確かめてから新しい話のファイルとして足す
 *    （既にある話は1バイトも変わらない・同じ名前があれば上書きしない）
 * 2. 書き出しが既にある話と同じなら、新しい話としては足さない
 * 3. 当たらなければ、確かめてから新しい作品として取り込む道へ渡す
 * 4. 押さなければ何も書かない・読めない .docx は理由を返す
 *
 * ファイルは作らず、覚え書きの上で動かす。
 */

const LIBRARY = paths.normalize("c:/小説");
const SLEEP_FOLDER = paths.join(LIBRARY, "コールドスリープ");
const OTHER_FOLDER = paths.join(LIBRARY, "教科書チート");
const MANUSCRIPT = paths.join(SLEEP_FOLDER, "本文");

const scannedBy = new Map<string, EpisodeFile[]>();

vi.mock("../../src/core/scanner", () => ({
  scanWork: async (work: WorkEntry) => ({
    episodes: scannedBy.get(work.folderPath) ?? [],
    stats: {},
    manuscriptDir: paths.join(work.folderPath, "本文"),
    workInfoFiles: [],
    timing: {},
  }),
}));

const { receiveBackup } = await import("../../src/features/backupDrop");

const SLEEP: WorkEntry = {
  id: "w-sleep",
  title: "コールドスリープ",
  folderPath: SLEEP_FOLDER,
  registeredAt: "2026-09-23T00:00:00.000Z",
};
const OTHER: WorkEntry = {
  id: "w-other",
  title: "教科書チート",
  folderPath: OTHER_FOLDER,
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const encoder = new TextEncoder();

function docx(paragraphs: Array<{ text: string; heading?: boolean }>): Uint8Array {
  const inner = paragraphs
    .map(
      (p) =>
        `<w:p>${p.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}` +
        `<w:r><w:t>${p.text}</w:t></w:r></w:p>`
    )
    .join("");
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${inner}</w:body></w:document>`;
  return zipSync({ "word/document.xml": encoder.encode(xml) });
}

const NEW_EPISODE = docx([
  { text: "4話　再会", heading: true },
  { text: "　病室の窓から、見慣れない街が見えていた。" },
  { text: "　僕はゆっくりと体を起こした。" },
]);

const disk = new Map<string, Uint8Array>();
function put(file: string, text: string): void {
  disk.set(file, encoder.encode(text));
}
function text(file: string): string | undefined {
  const bytes = disk.get(file);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** コールドスリープの手元：0001〜0003.txt */
function putSleepManuscript(bodies = ["　目が覚めた。", "　検査が続く。", "　外は明るかった。"]): void {
  const episodes: EpisodeFile[] = [];
  bodies.forEach((body, index) => {
    const n = index + 1;
    const fileName = `${String(n).padStart(4, "0")}.txt`;
    const filePath = paths.join(MANUSCRIPT, fileName);
    put(filePath, `${n}話\n\n${body}\n`);
    episodes.push({
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
    } as EpisodeFile);
  });
  scannedBy.set(SLEEP_FOLDER, episodes);
}

/** 本文フォルダーの中だけ（記録（ログ）は作品フォルダーへ書かれるので除く） */
function snapshot(): Map<string, string> {
  return new Map(
    [...disk.entries()]
      .filter(([name]) => name.startsWith(MANUSCRIPT))
      .map(([name, bytes]) => [name, Buffer.from(bytes).toString("hex")])
  );
}

const modals: Array<{ message: string; detail: string; buttons: string[] }> = [];
let modalAnswer: (message: string, buttons: string[]) => string | undefined;
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
  scannedBy.clear();
  modals.length = 0;
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
  commands.executeCommand = (async () => undefined) as typeof commands.executeCommand;
});

afterEach(() => {
  window.showInformationMessage = original.showInformationMessage;
  window.showQuickPick = original.showQuickPick;
  commands.executeCommand = original.executeCommand;
  workspace.fs = original.fs;
});

describe("既存作品の続きと分かったとき", () => {
  it("**作品フォルダーの中から落とされたら、その作品の新しい話として確かめてから足す**", async () => {
    putSleepManuscript();
    const before = snapshot();
    const refreshed: string[] = [];

    const result = await receiveBackup(
      {
        fileName: "下書き.docx",
        bytes: NEW_EPISODE,
        sourcePath: paths.join(SLEEP_FOLDER, "下書き", "下書き.docx"),
      },
      { works: [OTHER, SLEEP], afterEpisodesAdded: async (work) => void refreshed.push(work.id) }
    );

    expect(modals[0].message).toBe(
      "「コールドスリープ」の新しい話として足しますか？（作品フォルダーの中から渡されました）"
    );
    expect(modals[0].detail).toContain("足すファイル：0004.md");
    expect(modals[0].detail).toContain("題：4話　再会");
    expect(modals[0].buttons).toEqual(["新しい話として足す", "別の作品を選ぶ"]);

    // 手元の流儀（0001.txt）の番号で、中身は Word 変換と同じ Markdown
    expect(text(paths.join(MANUSCRIPT, "0004.md"))).toBe(
      "# 4話　再会\n　病室の窓から、見慣れない街が見えていた。\n　僕はゆっくりと体を起こした。\n"
    );
    for (const [name, hex] of before) expect(snapshot().get(name)).toBe(hex);
    expect(refreshed).toEqual([SLEEP.id]);
    expect(result?.message).toContain("「コールドスリープ」に新しい話として足しました：0004.md");
  });

  it("ファイル名に作品の題が入っているだけなら、候補を先頭に選ばせてから確かめる", async () => {
    putSleepManuscript();
    quickPickAnswer = (items) => items.find((item) => item.work?.id === SLEEP.id);

    await receiveBackup(
      { fileName: "コールドスリープ 4話.docx", bytes: NEW_EPISODE },
      { works: [OTHER, SLEEP] }
    );

    expect(quickPickItems[0]).toMatchObject({ label: "コールドスリープ", description: "候補" });
    expect(modals[0].message).toBe("「コールドスリープ」の新しい話として足しますか？");
    expect(text(paths.join(MANUSCRIPT, "0004.md"))).toBeDefined();
  });

  it("**確かめで押さなければ、何も書かない**", async () => {
    putSleepManuscript();
    const before = snapshot();
    modalAnswer = () => undefined;

    const result = await receiveBackup(
      { fileName: "下書き.docx", bytes: NEW_EPISODE, sourcePath: paths.join(SLEEP_FOLDER, "x.docx") },
      { works: [SLEEP] }
    );

    expect(result).toBeUndefined();
    expect(snapshot()).toEqual(before);
  });

  it("**同じ名前のファイルが既にあれば上書きせず、足せなかったと言う**", async () => {
    putSleepManuscript();
    const occupied = paths.join(MANUSCRIPT, "0004.md");
    put(occupied, "作者のメモ");

    const result = await receiveBackup(
      { fileName: "下書き.docx", bytes: NEW_EPISODE, sourcePath: paths.join(SLEEP_FOLDER, "x.docx") },
      { works: [SLEEP] }
    );

    expect(text(occupied)).toBe("作者のメモ");
    expect(result?.message).toContain("足せませんでした");
    expect(result?.message).toContain("上書きしません");
  });
});

describe("書き出しが既にある話と同じとき", () => {
  it("**新しい話としては足さず、どの話と同じかを言う**", async () => {
    putSleepManuscript([
      "　目が覚めた。",
      "　病室の窓から、見慣れない街が見えていた。\n　僕はゆっくりと体を起こした。",
      "　外は明るかった。",
    ]);
    const before = snapshot();
    modalAnswer = () => undefined;

    const result = await receiveBackup(
      { fileName: "コールドスリープ 2話.docx", bytes: NEW_EPISODE },
      { works: [OTHER, SLEEP] }
    );

    expect(modals[0].message).toContain("「コールドスリープ」の 本文/0002.txt と書き出しが同じです");
    expect(modals[0].buttons).toEqual(["それでも新しい話として足す"]);
    expect(snapshot()).toEqual(before);
    expect(result?.message).toContain("既にある話と書き出しが同じなので、足しませんでした");
  });
});

describe("どの作品の続きにも見えないとき", () => {
  it("確かめてから、新しい作品として取り込む道へ（.md 1つの形で）渡す", async () => {
    putSleepManuscript();
    const imported: PickedBackup[] = [];

    await receiveBackup(
      { fileName: "新しい物語.docx", bytes: NEW_EPISODE },
      { works: [OTHER, SLEEP], importAsNew: async (picked) => void imported.push(picked) }
    );

    expect(modals[0].message).toBe(
      "「新しい物語」は、登録済みの作品の続きには見えませんでした。新しい作品として取り込みますか？"
    );
    expect(modals[0].buttons).toEqual(["新しい作品として取り込む", "既にある作品に足す"]);
    expect(imported).toHaveLength(1);
    expect(imported[0].fileName).toBe("新しい物語.docx");
    expect(imported[0].inspection.files.map((file) => file.name)).toEqual(["新しい物語.md"]);
  });

  it("**確かめで押さなければ、取り込まない**", async () => {
    const imported: PickedBackup[] = [];
    modalAnswer = () => undefined;

    const result = await receiveBackup(
      { fileName: "新しい物語.docx", bytes: NEW_EPISODE },
      { works: [OTHER], importAsNew: async (picked) => void imported.push(picked) }
    );

    expect(result).toBeUndefined();
    expect(imported).toEqual([]);
  });
});

describe("読めないもの", () => {
  it("Word 原稿として読めなければ、理由を返して何も書かない", async () => {
    const before = snapshot();

    const result = await receiveBackup(
      { fileName: "壊れた.docx", bytes: new Uint8Array([1, 2, 3]) },
      { works: [SLEEP] }
    );

    expect(result?.message).toContain("Word 原稿として読めませんでした");
    expect(snapshot()).toEqual(before);
  });
});
