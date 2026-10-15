import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as vscodeStub from "../support/vscodeStub";
import { window } from "../support/vscodeStub";
import { hashBytes } from "../../../src/core/hash";
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
  /** 置いた名前を直す案の記録（見送られたあと、反映の側が置き直さないため） */
  recordOffers: vi.fn(async () => undefined),
  /** 自分で保存する plot.md の覚え書き（その保存で「保存からの反映」を走らせない） */
  noteOwn: vi.fn(),
  forgetOwn: vi.fn(),
}));

vi.mock("../../../src/features/roleRenameOffers", () => ({
  recordRoleRenameOffers: state.recordOffers,
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
  noteOwnPlotSave: state.noteOwn,
  forgetOwnPlotSave: state.forgetOwn,
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

/**
 * 設定資料に**名前が役名だけの人物**（「主人公」）がいるとき
 * （作者の裁定、2026-09-25 午前）。
 *
 * 動いたと言える条件：
 * 1. 新規の人物は置かず、**その人物の名前を直す更新案**を承認待ちへ置く
 *    （名前を 主人公 → 相馬 誠、元の役名は役割の欄へ、読みを入れる。出どころは「プロット」）
 * 2. **台帳（資料）は書き換えない。** 作者が承認するまで変わらない
 * 3. `autoGenerated: false` の人物・`authorLocked` の呼称も、案に出すだけで、
 *    呼称と `autoGenerated` はそのまま残す
 * 4. 既に同じ人物の更新案が承認待ちにあれば、その案の上に名前の変更を重ねる
 *    （上書きで先の案を消さない）
 * 5. plot.md への書き足しは新規のときと同じ形
 */
describe("資料の役名の人物に名前を入れる", () => {
  let announced: string[] = [];
  const hero = (): Character => ({
    ...emptyCharacter("char_001", "主人公"),
    summary: "冒険者試験に落ちた新人",
  });

  function ledgerSession() {
    const targets = findRoleOnlyCharacters(TEXT, state.characters as Character[]).targets;
    return { ...session(), targets };
  }

  beforeEach(() => {
    announced = [];
    state.characters = [hero()];
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

  test("資料の「主人公」を拾い、直す相手として覚える", () => {
    expect(ledgerSession().targets[0]).toMatchObject({
      role: "主人公",
      ledger: { id: "char_001", name: "主人公" },
    });
  });

  test("新規の人物ではなく、名前を直す更新案を承認待ちへ置く（plot.md は同じ形で書き足す）", async () => {
    const ok = await applyPlotNames(work, ledgerSession(), [{ id: "1", name: "相馬 誠" }]);

    expect(ok).toBe(true);
    const [, text] = state.write.mock.calls[0] as unknown as [string, string];
    expect(text).toBe(TEXT.replace("- 主人公：", "- 主人公（相馬 誠）："));

    expect(state.stage).toHaveBeenCalledTimes(1);
    const [records, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string; reason?: string },
    ];
    // 更新案（kind を持たない）。ファイル名は人物のIDで付く
    expect(options.kind).toBeUndefined();
    expect(options.source).toBe("plot");
    expect(options.reason).toContain("主人公 → 相馬 誠");
    expect(records).toEqual([
      { ...hero(), name: "相馬 誠", reading: "そうま まこと", role: "主人公" },
    ]);
    // 台帳のレコードは書き換えていない
    expect((state.characters[0] as Character).name).toBe("主人公");
    expect(announced.join("")).toContain("主人公→相馬 誠");
    expect(announced.join("")).toContain("名前を直す案");
    // 置いたことを記録する。作者が見送ったあと、plot.md の保存で
    // 「プロットからの反映」が同じ案を置き直さないため（設計書6.4.9）
    expect(state.recordOffers).toHaveBeenCalledWith(work, [
      { id: "char_001", from: "主人公", to: "相馬 誠" },
    ]);
  });

  test("作者が確定させた人物・作者が決めた呼称も、案に出すだけで中身はそのまま", async () => {
    const locked: Character = {
      ...hero(),
      autoGenerated: false,
      authorNotes: "作者のメモ",
      addressTerms: [
        { targetName: "班長", targetId: "char_002", forms: [], authorLocked: true },
      ],
    };
    state.characters = [locked];

    await applyPlotNames(work, ledgerSession(), [{ id: "1", name: "相馬 誠" }]);

    const [records] = state.stage.mock.calls[0] as unknown as [Character[]];
    expect(records[0].autoGenerated).toBe(false);
    expect(records[0].authorNotes).toBe("作者のメモ");
    expect(records[0].addressTerms).toEqual(locked.addressTerms);
    expect(records[0].name).toBe("相馬 誠");
  });

  test("同じ人物の更新案が承認待ちにあれば、その上に重ねる（先の案を消さない）", async () => {
    const extracted: Character = { ...hero(), personality: "負けず嫌い" };
    state.pending = [{ filePath: "char_001.json", character: extracted }];

    await applyPlotNames(work, ledgerSession(), [{ id: "1", name: "相馬 誠" }]);

    const [records, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string },
    ];
    expect(records[0]).toMatchObject({ name: "相馬 誠", personality: "負けず嫌い" });
    // 出どころは先の案のもの（抽出）を引き継ぐ
    expect(options.source).toBeUndefined();
    expect(state.discard).not.toHaveBeenCalled();
  });

  test("選んだ名前の人物がほかに資料にいれば、案を置かない（plot.md には入れる）", async () => {
    const targets = findRoleOnlyCharacters(TEXT, [hero()]).targets;
    state.characters = [hero(), emptyCharacter("char_009", "相馬 誠")];

    await applyPlotNames(work, { ...session(), targets }, [{ id: "1", name: "相馬 誠" }]);

    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("同じ名前の人物が資料か承認待ちにいる");
  });

  test("候補を出したあとに資料の人物の名前が変わっていたら、案を置かない", async () => {
    const targets = findRoleOnlyCharacters(TEXT, [hero()]).targets;
    state.characters = [{ ...hero(), name: "早瀬 陸" }];

    await applyPlotNames(work, { ...session(), targets }, [{ id: "1", name: "相馬 誠" }]);

    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("資料の人物が候補を出したときと変わっている");
  });

  test("新規の人物と、名前を直す人物が混ざっても、それぞれの形で置く", async () => {
    await applyPlotNames(work, ledgerSession(), [
      { id: "1", name: "相馬 誠" },
      { id: "3", name: "鬼塚 剛" },
    ]);

    expect(state.stage).toHaveBeenCalledTimes(2);
    const calls = state.stage.mock.calls as unknown as Array<
      [Character[], { source?: string; kind?: string }]
    >;
    const creation = calls.find(([, options]) => options.kind === "creation");
    const rename = calls.find(([, options]) => options.kind === undefined);
    expect(creation?.[0].map((record) => record.name)).toEqual(["鬼塚 剛"]);
    expect(rename?.[0].map((record) => record.name)).toEqual(["相馬 誠"]);
  });
});

/**
 * **plot.md がエディターで開いているときは、ディスクを直に書かない**（作者の裁定「両方直す」、2026-10-16）。
 *
 * ディスクへ「退避 → 消して作り直す」で書くと、開いたままのエディターは VS Code のファイルの見張りが
 * 拾って読み直すまで古い中身と古い更新時刻を持つ。その間に作者が打つと未保存になり、Ctrl+S が
 * 「Failed to save 'plot.md': The content of the file is newer」で断られた（画面テスト plotRenamePending）。
 * 開いている文書へ変わった所だけを当てて VS Code に保存させれば、エディターとディスクが食い違う間が無い。
 */
describe("plot.md がエディターで開いているとき", () => {
  const plotFile = nodePath.join(work.folderPath, "設定", "plot.md");
  const diskBytes = new TextEncoder().encode(TEXT.replace(/\n/g, "\r\n"));
  let applied: Array<{ replacements: Array<{ range: unknown; text: string }> }> = [];
  let order: string[] = [];
  let documentText = "";
  let dirty = false;
  const save = vi.fn(async () => {
    order.push("save");
    return true;
  });

  function openDocument(): void {
    documentText = TEXT.replace(/\n/g, "\r\n");
    vscodeStub.workspace.textDocuments.push({
      uri: { fsPath: plotFile },
      get isDirty() {
        return dirty;
      },
      getText: () => documentText,
      save,
      eol: 2,
      // 文書の空間（CRLF）の位置を、行と桁へ直す
      positionAt: (offset: number) => {
        const before = documentText.slice(0, offset).split("\r\n");
        return new vscodeStub.Position(before.length - 1, before[before.length - 1].length);
      },
    } as unknown as (typeof vscodeStub.workspace.textDocuments)[number]);
  }

  beforeEach(() => {
    applied = [];
    order = [];
    dirty = false;
    save.mockClear();
    state.write.mockClear();
    state.stage.mockClear();
    state.stage.mockImplementation(async () => {
      order.push("stage");
      return undefined;
    });
    state.mark.mockClear();
    state.noteOwn.mockReset();
    state.noteOwn.mockImplementation(() => {
      order.push("noteOwn");
    });
    state.forgetOwn.mockClear();
    vscodeStub.workspace.textDocuments.length = 0;
    vscodeStub.workspace.fs.readFile = (async () => diskBytes) as never;
    vscodeStub.workspace.applyEdit = async (edit: unknown) => {
      applied.push(edit as (typeof applied)[number]);
      return true;
    };
    window.showInformationMessage = (async () => undefined) as typeof window.showInformationMessage;
    window.showWarningMessage = (async () => undefined) as typeof window.showWarningMessage;
  });

  afterEach(() => {
    vscodeStub.workspace.textDocuments.length = 0;
    state.stage.mockImplementation(async () => undefined);
  });

  function openSession() {
    return { ...session(), file: { ...file(TEXT), hash: hashBytes(diskBytes) } };
  }

  test("ディスクを直に書かず、開いている文書へ変わった所だけを当てて保存する", async () => {
    openDocument();

    const ok = await applyPlotNames(work, openSession(), [
      { id: "1", name: "相馬 誠" },
      { id: "3", name: "鬼塚 剛" },
    ]);

    expect(ok).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
    expect(applied).toHaveLength(1);
    const text = applied[0].replacements.map((entry) => entry.text).join("");
    expect(text).toContain("（相馬 誠）");
    expect(text).toContain("（鬼塚 剛）");
    // 文書の改行（CRLF）に合わせて入れる。LF だけの改行を混ぜない
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(save).toHaveBeenCalledTimes(1);
    // 承認待ちへ置いて印を進めてから保存する
    expect(order).toEqual(["stage", "noteOwn", "save"]);
    expect(state.mark).toHaveBeenCalledTimes(1);
    // この保存では「保存からの反映」を走らせない（［入れる］がもう案を置いた。画面テスト plotRenamePending）。
    // 覚えるのは保存する中身そのもの（LF空間）
    const marked = state.mark.mock.calls[0] as unknown as [WorkEntry, string, string];
    expect(state.noteOwn).toHaveBeenCalledWith(plotFile, marked[2]);
    expect(state.forgetOwn).not.toHaveBeenCalled();
  });

  test("保存できなければ、覚え書きを忘れて保存を頼む", async () => {
    openDocument();
    save.mockImplementationOnce(async () => false);
    const warned: string[] = [];
    window.showWarningMessage = (async (message: string) => {
      warned.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;

    const ok = await applyPlotNames(work, openSession(), [{ id: "1", name: "相馬 誠" }]);

    expect(ok).toBe(true);
    expect(state.forgetOwn).toHaveBeenCalledWith(plotFile);
    expect(warned.join("")).toContain("plot.md を保存できませんでした");
  });

  test("文書に保存していない変更があれば、書かずに止める", async () => {
    openDocument();
    dirty = true;

    const ok = await applyPlotNames(work, openSession(), [{ id: "1", name: "相馬 誠" }]);

    expect(ok).toBe(false);
    expect(applied).toHaveLength(0);
    expect(state.write).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("候補を出したあとにディスクが書き換わっていたら、文書へも当てずに止める", async () => {
    openDocument();

    const ok = await applyPlotNames(
      work,
      { ...session(), file: { ...file(TEXT), hash: "hash-before-change" } },
      [{ id: "1", name: "相馬 誠" }]
    );

    expect(ok).toBe(false);
    expect(applied).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(state.stage).not.toHaveBeenCalled();
  });
});
