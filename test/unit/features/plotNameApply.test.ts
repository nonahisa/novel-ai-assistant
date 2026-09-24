import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { WorkEntry } from "../../../src/models/types";
import type { TextFileContent } from "../../../src/core/textFile";
import { findRoleOnlyCharacters } from "../../../src/core/plotNameTargets";
import type { NameCandidate } from "../../../src/prompts/nameSuggest";

/**
 * プロットモードの「名前の候補を出す」で、選んだ名前を入れる（設計書6.4.8）。
 *
 * 動いたと言える条件：
 * 1. plot.md は**読み込み時のハッシュを添えて**本文と同じ口で書き戻す
 *    （外で書き換わっていたら、その口が止める）。書き足すのは「（名前）」だけ
 * 2. 設定資料は**承認待ちへ新規の人物として置くだけ**（名前・読み・役割・説明、
 *    出どころは「プロット」）。台帳へは書かない
 * 3. 同じ名前の人物が資料か承認待ちにいれば置かない
 * 4. プロットから役名だけで積まれていた古い案（「主人公」）は片付ける
 * 5. 画面から届いた名前は、控えにある候補しか受け取らない
 */

const state = vi.hoisted(() => ({
  characters: [] as unknown[],
  pending: [] as Array<{ kind?: string; source?: string; character: unknown; filePath: string }>,
  stage: vi.fn(async () => undefined),
  discard: vi.fn(async () => undefined),
  write: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
  mark: vi.fn(async () => true),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(),
  writeTextFilePreservingFormat: state.write,
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: [] };
    }
  },
}));

vi.mock("../../../src/core/pendingUpdates", () => ({
  PendingUpdateStore: class {
    stage = state.stage;
    discard = state.discard;
    async loadAll() {
      return { updates: state.pending, errors: [] };
    }
  },
}));

vi.mock("../../../src/features/plotCharacterSync", () => ({
  markPlotCharactersSynced: state.mark,
}));
vi.mock("../../../src/features/nameCheck", () => ({ pickOrigin: vi.fn() }));
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(),
  confirmProviderReachable: vi.fn(),
}));
vi.mock("../../../src/features/reportAIError", () => ({ reportAIError: vi.fn() }));
vi.mock("../../../src/ai/registry", () => ({
  AIRegistry: class {},
  ensureConfigured: vi.fn(),
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  responseExcerptForLog: vi.fn(),
  useLogFile: vi.fn(),
}));

const { applyPlotNames } = await import("../../../src/features/plotNameSuggest");

const work: WorkEntry = {
  id: "work_test",
  title: "現代ダンジョンのインフラ担当",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-09-25T00:00:00.000Z",
};

const TEXT = [
  "# 現代ダンジョンのインフラ担当",
  "",
  "## 主要登場人物",
  "- 主人公：冒険者試験に落ちた新人",
  "- ヒロイン：伸び悩む新人配信者",
  "- 班長：くたびれた中年の作業員で、最強",
  "",
].join("\n");

function file(text: string): TextFileContent {
  return {
    text,
    encoding: "utf8",
    eol: "\r\n",
    hasTrailingNewline: true,
    hash: "hash-at-read",
    hasConflictMarkers: false,
    hasMixedEol: false,
  };
}

function candidate(name: string, reading: string): NameCandidate {
  return { name, reading, origin: "和風", note: "" };
}

function session() {
  const targets = findRoleOnlyCharacters(TEXT, []).targets;
  return {
    plotFile: nodePath.join(work.folderPath, "設定", "plot.md"),
    file: file(TEXT),
    targets,
    candidates: new Map([
      ["1", [candidate("相馬 誠", "そうま まこと"), candidate("早瀬 陸", "はやせ りく")]],
      ["2", [candidate("白井 澪", "しらい みお")]],
      ["3", [candidate("鬼塚 剛", "おにづか ごう")]],
    ]),
  };
}

describe("選んだ名前を入れる", () => {
  let announced: string[] = [];

  beforeEach(() => {
    announced = [];
    state.characters = [];
    state.pending = [];
    state.stage.mockClear();
    state.discard.mockClear();
    state.write.mockClear();
    state.write.mockImplementation(async () => ({ ok: true }));
    state.mark.mockClear();
    window.showInformationMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
    window.showWarningMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
  });

  test("plot.md は読み込み時のハッシュを添えて、行に「（名前）」だけ足して書く", async () => {
    const ok = await applyPlotNames(work, session(), [
      { id: "1", name: "相馬 誠" },
      { id: "3", name: "鬼塚 剛" },
    ]);

    expect(ok).toBe(true);
    expect(state.write).toHaveBeenCalledTimes(1);
    const [target, text, original, hash] = state.write.mock.calls[0] as unknown as [
      string,
      string,
      TextFileContent,
      string,
    ];
    expect(target).toBe(session().plotFile);
    expect(hash).toBe("hash-at-read");
    expect(original.eol).toBe("\r\n");
    expect(text).toBe(
      TEXT.replace("- 主人公：", "- 主人公（相馬 誠）：").replace(
        "- 班長：",
        "- 班長（鬼塚 剛）："
      )
    );
    // 反映済みの印を追いつかせる（書く前と書いたあとの中身を渡す）
    expect(state.mark).toHaveBeenCalledWith(work, TEXT, text);
  });

  test("承認待ちへ、名前・読み・役割・説明つきの新規の人物として置く", async () => {
    await applyPlotNames(work, session(), [{ id: "1", name: "相馬 誠" }]);

    expect(state.stage).toHaveBeenCalledTimes(1);
    const [records, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string },
    ];
    expect(options).toEqual({ source: "plot", kind: "creation" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "相馬 誠",
      reading: "そうま まこと",
      role: "主人公",
      summary: "冒険者試験に落ちた新人",
      aliases: [],
      autoGenerated: true,
      status: "未登場",
    });
    expect(announced.join("")).toContain("承認待ちに置きました");
  });

  test("同じ名前の人物が資料にいれば、承認待ちへ置かない（plot.md には入れる）", async () => {
    state.characters = [emptyCharacter("char_001", "相馬 誠")];

    await applyPlotNames(work, session(), [{ id: "1", name: "相馬 誠" }]);

    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("同じ名前の人物が資料か承認待ちにいる");
  });

  test("同じ名前の新規案が承認待ちにあっても置かない", async () => {
    state.pending = [
      {
        kind: "creation",
        source: "chat",
        filePath: "new_相馬 誠.json",
        character: emptyCharacter("char_000", "相馬 誠"),
      },
    ];

    await applyPlotNames(work, session(), [{ id: "1", name: "相馬 誠" }]);

    expect(state.stage).not.toHaveBeenCalled();
    // 相談から来た案は片付けない
    expect(state.discard).not.toHaveBeenCalled();
  });

  test("プロットから役名だけで積まれていた案は片付ける（抽出の案は残す）", async () => {
    state.pending = [
      {
        kind: "creation",
        source: "plot",
        filePath: "new_主人公.json",
        character: emptyCharacter("char_000", "主人公"),
      },
      {
        kind: "creation",
        filePath: "new_班長.json",
        character: emptyCharacter("char_000", "班長"),
      },
    ];

    await applyPlotNames(work, session(), [
      { id: "1", name: "相馬 誠" },
      { id: "3", name: "鬼塚 剛" },
    ]);

    expect(state.discard).toHaveBeenCalledTimes(1);
    expect(state.discard).toHaveBeenCalledWith("new_主人公.json");
  });

  test("外で書き換わっていたら何も置かず、止めたことを伝える", async () => {
    state.write.mockImplementation(async () => ({
      ok: false,
      reason: "modified_externally",
    }));

    const ok = await applyPlotNames(work, session(), [{ id: "1", name: "相馬 誠" }]);

    expect(ok).toBe(false);
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.mark).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("書き換わったため、入れるのを止めました");
  });

  test("控えに無い名前は受け取らない。選ばれていなければ何も書かない", async () => {
    const ok = await applyPlotNames(work, session(), [
      { id: "1", name: "画面が勝手に作った名前" },
      { id: "9", name: "相馬 誠" },
    ]);

    expect(ok).toBe(false);
    expect(state.write).not.toHaveBeenCalled();
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("名前が選ばれていません");
  });

  test("選ばなかった人物の行は1字も変えない", async () => {
    await applyPlotNames(work, session(), [{ id: "2", name: "白井 澪" }]);

    const [, text] = state.write.mock.calls[0] as unknown as [string, string];
    expect(text.split("\n").filter((line, index) => line !== TEXT.split("\n")[index])).toEqual([
      "- ヒロイン（白井 澪）：伸び悩む新人配信者",
    ]);
  });
});
