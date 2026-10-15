import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { WorkEntry } from "../../../src/models/types";

/**
 * plot.md を保存したときの、設定資料への差分反映（設計書6.4.9）。
 *
 * **同じ提案を二度積まない。** 前回反映した欄の内容ハッシュを `.aiwriter`
 * に覚え、変わったときだけ承認待ちへ積む。保存のたびに同じ行が増える
 * 提案パネルは、読まれなくなる。
 *
 * 台帳（`設定/characters/*.json`）へは書かない。積むのは承認待ちだけで、
 * 反映は既存の「更新分を反映」が行う。
 */

const state = vi.hoisted(() => ({
  plotText: "",
  characters: [] as unknown[],
  loadErrors: [] as unknown[],
  stage: vi.fn(async () => undefined),
  /** 既に積んである承認待ち（新規案の読みを引き継ぐ元。設計書6.4.8） */
  pending: [] as Array<{
    kind?: string;
    character: unknown;
    filePath: string;
    source?: string;
    reason?: string;
  }>,
}));

vi.mock("../../../src/core/plotFile", () => ({
  readPlotText: vi.fn(async () => state.plotText),
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: state.loadErrors };
    }
  },
}));

vi.mock("../../../src/core/pendingUpdates", () => ({
  PendingUpdateStore: class {
    stage = state.stage;
    async loadAll() {
      return { updates: state.pending, errors: [] };
    }
  },
}));

vi.mock("../../../src/core/logger", () => ({ logFailure: vi.fn() }));

const {
  consumeOwnPlotSave,
  forgetOwnPlotSave,
  markPlotCharactersSynced,
  noteOwnPlotSave,
  syncPlotCharacters,
} = await import("../../../src/features/plotCharacterSync");

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const statePath = Uri.file(
  nodePath.join(work.folderPath, ".aiwriter", "plot-sync.json")
).fsPath;

function character(id: string, name: string, summary: string): Character {
  return { ...emptyCharacter(id, name), summary };
}

function plot(body: string): string {
  return ["# 氷の街", "", "## 主要登場人物", body, ""].join("\n");
}

describe("plot.md の保存で人物の更新案を積む", () => {
  const disk = new Map<string, Uint8Array>();
  let announced: string[] = [];

  beforeEach(() => {
    disk.clear();
    announced = [];
    state.stage.mockClear();
    state.loadErrors = [];
    state.pending = [];
    state.characters = [character("char_001", "灯", "主人公")];
    state.plotText = plot("- 灯：主人公。幽霊が見える。");

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
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
    } as unknown as typeof workspace.fs;

    window.showInformationMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
    window.showWarningMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
  });

  test("紹介文が変わっていれば、承認待ちへ「プロット」の印つきで積む", async () => {
    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(1);
    expect(state.stage).toHaveBeenCalledTimes(1);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string },
    ];
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe("char_001");
    expect(staged[0].summary).toBe("主人公。幽霊が見える。");
    expect(options).toEqual({ source: "plot" });
    expect(announced.join("")).toContain("プロットから人物1件");
    // 覚え書きは `.aiwriter` へ残す（作者が読む「設定」を散らかさない）
    expect(disk.has(statePath)).toBe(true);
  });

  test("二度目の保存では、同じ提案を積み直さない", async () => {
    await syncPlotCharacters(work);
    state.stage.mockClear();
    announced = [];

    const result = await syncPlotCharacters(work);

    expect(result.unchanged).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
    // 新しい情報が無ければ何も言わない
    expect(announced).toEqual([]);
  });

  test("並べ替えただけでは積み直さない", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "澪", "親友"),
    ];
    state.plotText = plot(["- 灯：主人公。", "- 澪：灯の親友。"].join("\n"));
    await syncPlotCharacters(work);
    state.stage.mockClear();

    state.plotText = plot(["- 澪：灯の親友。", "- 灯：主人公。"].join("\n"));
    const result = await syncPlotCharacters(work);

    expect(result.unchanged).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
  });

  test("手で押したときは、変わっていなくても積み直して結果を知らせる", async () => {
    await syncPlotCharacters(work);
    state.stage.mockClear();
    announced = [];

    const result = await syncPlotCharacters(work, { force: true });

    expect(result.unchanged).toBe(false);
    expect(state.stage).toHaveBeenCalledTimes(1);
    expect(announced.join("")).toContain("プロットから人物1件");
  });

  test("手で押して積むものが無ければ、そう知らせる", async () => {
    state.plotText = plot("- 灯：主人公");
    const result = await syncPlotCharacters(work, { force: true });

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("反映するものはありません");
  });

  test("作者が確定させた人物は変えず、その旨を添える", async () => {
    state.characters = [
      { ...character("char_001", "灯", "主人公"), autoGenerated: false },
    ];

    const result = await syncPlotCharacters(work, { force: true });

    expect(result.staged).toBe(0);
    expect(result.skipped).toEqual([
      { name: "灯", reason: "authorConfirmed" },
    ]);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("作者が確定させた人物");
  });

  test("読めない行があれば、件数を添える", async () => {
    state.plotText = plot(
      ["- 灯：主人公。幽霊が見える。", "この節はあとで書き直す。"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.unparsed).toBe(1);
    expect(announced.join("")).toContain("1行は読めませんでした");
  });

  test("資料にまだ無い名前は、新規の人物案として積む", async () => {
    state.plotText = plot("- 澪：灯の親友");

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(0);
    expect(result.creations).toEqual(["澪"]);
    expect(state.stage).toHaveBeenCalledTimes(1);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string },
    ];
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe("澪");
    expect(staged[0].summary).toBe("灯の親友");
    // 抽出の新規と同じ流儀。**本文にはまだ出ていない**ので未登場
    expect(staged[0].autoGenerated).toBe(true);
    expect(staged[0].appearedChapters).toEqual([]);
    expect(staged[0].status).toBe("未登場");
    expect(options).toEqual({ source: "plot", kind: "creation" });
    expect(announced.join("")).toContain("新規案");
  });

  test("新規と更新が混ざったら、内訳を出して両方を積む", async () => {
    state.plotText = plot(
      ["- 灯：主人公。幽霊が見える。", "- 澪：灯の親友"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(1);
    expect(result.creations).toEqual(["澪"]);
    expect(state.stage).toHaveBeenCalledTimes(2);
    expect(announced.join("")).toContain("新規1件・更新1件");
  });

  test("人物設定が読めないときは、積まずに止める", async () => {
    state.loadErrors = [{ file: "char_001_灯.json", message: "壊れています" }];

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    // 覚え書きも残さない（次の保存でやり直せるようにする）
    expect(disk.has(statePath)).toBe(false);
  });

  /*
    名前の候補（設計書6.4.8）で「主人公（相馬 誠）」と書き足したあとの反映。
    **「主人公（相馬 誠）」という名前の人物を積まない**、そして名前の候補から
    読みつきで置いた案を、**読みの無い案で上書きしない**
  */
  test("「役名（名前）」の行は、名前で積み、役名は役割の欄へ入れる", async () => {
    state.plotText = plot("- 主人公（相馬 誠）：冒険者試験に落ちた新人");

    const result = await syncPlotCharacters(work);

    expect(result.creations).toEqual(["相馬 誠"]);
    const [staged] = state.stage.mock.calls[0] as unknown as [Character[]];
    expect(staged[0].name).toBe("相馬 誠");
    expect(staged[0].role).toBe("主人公");
    expect(staged[0].aliases).toEqual([]);
  });

  test("積み直すときは、承認待ちの同じ名前の案から読みを引き継ぐ", async () => {
    state.plotText = plot("- 主人公（相馬 誠）：冒険者試験に落ちた新人");
    state.pending = [
      {
        kind: "creation",
        filePath: "new_相馬 誠.json",
        character: {
          ...emptyCharacter("char_000", "相馬 誠"),
          reading: "そうま まこと",
          role: "主人公",
        },
      },
    ];

    await syncPlotCharacters(work);

    const [staged] = state.stage.mock.calls[0] as unknown as [Character[]];
    expect(staged[0].reading).toBe("そうま まこと");
  });

  /*
    名前を直す案（主人公 → 相馬 誠）がまだ承認待ちのうちに保存したとき
    （作者の判断、2026-09-25「直す」）。**「相馬 誠」を新規に積まない**——
    新規案を先に承認すると、資料に同じ人が2人できる
  */
  test("名前を直す案が承認待ちなら、同じ人を新規に積まない", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "主人公", "冒険者試験に落ちた"),
    ];
    state.pending = [
      {
        filePath: "char_002.json",
        source: "plot",
        reason: "プロットモードで選んだ名前に直します（主人公 → 相馬 誠）。",
        character: {
          ...character("char_002", "相馬 誠", "冒険者試験に落ちた"),
          reading: "そうま まこと",
          role: "主人公",
        },
      },
    ];
    state.plotText = plot(
      ["- 灯：主人公", "- 主人公（相馬 誠）：冒険者試験に落ちた"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.creations).toEqual([]);
    expect(state.stage).not.toHaveBeenCalled();
  });

  test("直す案が承認待ちで紹介文が変わったら、直す案へ重ねる（出どころと理由は残す）", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "主人公", "冒険者試験に落ちた"),
    ];
    const reason = "プロットモードで選んだ名前に直します（主人公 → 相馬 誠）。";
    state.pending = [
      {
        filePath: "char_002.json",
        source: "plot",
        reason,
        character: {
          ...character("char_002", "相馬 誠", "冒険者試験に落ちた"),
          reading: "そうま まこと",
          role: "主人公",
        },
      },
    ];
    state.plotText = plot(
      ["- 灯：主人公", "- 主人公（相馬 誠）：試験に落ちた新人"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.creations).toEqual([]);
    expect(result.staged).toBe(1);
    expect(state.stage).toHaveBeenCalledTimes(1);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string; reason?: string },
    ];
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe("char_002");
    expect(staged[0].name).toBe("相馬 誠");
    expect(staged[0].reading).toBe("そうま まこと");
    expect(staged[0].summary).toBe("試験に落ちた新人");
    expect(options.kind).toBeUndefined();
    expect(options.source).toBe("plot");
    expect(options.reason).toBe(reason);
  });

  /*
    資料に「主人公」がいて、直す案が無いとき（作者の判断、2026-09-25
    「直す案を置く」）。0.87.4 は知らせるだけだった。**名前の候補と同じ形の
    直す案を、承認待ちへ置く**
  */
  test("資料に役名の人物がいて直す案が無ければ、名前を直す案を置く", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "主人公", "冒険者試験に落ちた"),
    ];
    state.plotText = plot(
      ["- 灯：主人公", "- 主人公（相馬 誠）：試験に落ちた新人"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.creations).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.renamed).toEqual([{ from: "主人公", to: "相馬 誠" }]);
    const renameCall = state.stage.mock.calls.find(
      (call) => ((call as unknown as [Character[]])[0][0]?.id ?? "") === "char_002"
    ) as unknown as [Character[], { source?: string; kind?: string; reason?: string }];
    expect(renameCall).toBeDefined();
    const [records, options] = renameCall;
    expect(records).toEqual([
      {
        ...character("char_002", "相馬 誠", "試験に落ちた新人"),
        role: "主人公",
      },
    ]);
    // 更新案（kind を持たない）。ファイル名は人物のIDで付く
    expect(options.kind).toBeUndefined();
    expect(options.source).toBe("plot");
    expect(options.reason).toContain("主人公 → 相馬 誠");
    expect(announced.join("")).toContain("主人公→相馬 誠");
    // 台帳は書き換えていない
    expect((state.characters[1] as Character).name).toBe("主人公");
  });

  test("置いた直す案を作者が見送ったら、次の保存で置き直さない", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "主人公", "冒険者試験に落ちた"),
    ];
    state.plotText = plot(
      ["- 灯：主人公", "- 主人公（相馬 誠）：冒険者試験に落ちた"].join("\n")
    );
    await syncPlotCharacters(work);
    expect(state.stage).toHaveBeenCalledTimes(1);

    // 作者が承認の画面で見送った（承認待ちは空のまま、資料も「主人公」のまま）。
    // 別の行を書き換えて保存する
    state.stage.mockClear();
    announced = [];
    state.pending = [];
    state.plotText = plot(
      ["- 灯：主人公。幽霊が見える。", "- 主人公（相馬 誠）：冒険者試験に落ちた"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    const renamedAgain = state.stage.mock.calls.some(
      (call) => ((call as unknown as [Character[]])[0][0]?.id ?? "") === "char_002"
    );
    expect(renamedAgain).toBe(false);
    expect(result.renamed).toEqual([]);
    expect(result.creations).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "相馬 誠", reason: "renameOffered", role: "主人公" },
    ]);
  });

  test("名前を変えて書き直したら、新しい名前で直す案を置く", async () => {
    state.characters = [character("char_002", "主人公", "冒険者試験に落ちた")];
    state.plotText = plot("- 主人公（相馬 誠）：冒険者試験に落ちた");
    await syncPlotCharacters(work);
    state.stage.mockClear();

    state.plotText = plot("- 主人公（早瀬 陸）：冒険者試験に落ちた");
    const result = await syncPlotCharacters(work);

    expect(result.renamed).toEqual([{ from: "主人公", to: "早瀬 陸" }]);
  });

  test("書き足す前の欄が反映済みなら、書き足したあとの欄を反映済みにする", async () => {
    const before = plot("- 灯：主人公。幽霊が見える。\n- 主人公：新人");
    const after = plot("- 灯：主人公。幽霊が見える。\n- 主人公（相馬 誠）：新人");
    state.plotText = before;
    await syncPlotCharacters(work);
    state.stage.mockClear();

    expect(await markPlotCharactersSynced(work, before, after)).toBe(true);
    state.plotText = after;
    const result = await syncPlotCharacters(work);

    // 名前の候補の側で読みつきの案を置いてあるので、積み直さない
    expect(result.unchanged).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
  });

  test("反映していない書きかけがあれば、反映済みの印を進めない", async () => {
    const before = plot("- 灯：主人公。幽霊が見える。\n- 主人公：新人");
    const after = plot("- 灯：主人公。幽霊が見える。\n- 主人公（相馬 誠）：新人");
    // 一度も反映していない（覚え書きが無い）

    expect(await markPlotCharactersSynced(work, before, after)).toBe(false);
    expect(disk.has(statePath)).toBe(false);
  });

  /**
   * 名前を直す案を見送った作品では、反映するものが無い保存でも一言出す
   * （作者の裁定、2026-10-12）。黙ると、plot.md に名前を書いたのに資料へ
   * 出てこない理由が分からない。ただし同じ文は、VS Code を開いている間に
   * 作品ごとに1回だけ（保存のたびに出るとうるさい）。
   *
   * 作品ごとに覚えるので、ほかの試験と覚えが混ざらないよう別の作品で試す。
   */
  function otherWork(id: string): { entry: WorkEntry; digestPath: string } {
    const entry: WorkEntry = {
      ...work,
      id,
      folderPath: nodePath.join("C:", "novels", id),
    };
    const digestPath = Uri.file(
      nodePath.join(entry.folderPath, ".aiwriter", "plot-sync.json")
    ).fsPath;
    return { entry, digestPath };
  }

  async function offerThenDecline(entry: WorkEntry): Promise<void> {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "主人公", "冒険者試験に落ちた"),
    ];
    state.plotText = plot(
      ["- 灯：主人公", "- 主人公（相馬 誠）：冒険者試験に落ちた"].join("\n")
    );
    await syncPlotCharacters(entry);
    expect(state.stage).toHaveBeenCalled();
    // 作者が承認の画面で見送った（承認待ちは空、資料は「主人公」のまま）
    state.stage.mockClear();
    state.pending = [];
    announced = [];
  }

  test("見送った名前の案があれば、反映するものが無い保存でも置き直さないことを言う", async () => {
    const { entry, digestPath } = otherWork("work_declined");
    await offerThenDecline(entry);

    // 欄が変わったものとして読み直させる（覚え書きを消す）。積むものは無い
    disk.delete(digestPath);
    const result = await syncPlotCharacters(entry);

    expect(result.staged).toBe(0);
    expect(result.creations).toEqual([]);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain("反映するものはありませんでした");
    expect(announced[0]).toContain("相馬 誠");
    expect(announced[0]).toContain("置き直していません");
  });

  test("同じ一言は、同じ作品で二度出さない", async () => {
    const { entry, digestPath } = otherWork("work_declined_twice");
    await offerThenDecline(entry);

    disk.delete(digestPath);
    await syncPlotCharacters(entry);
    expect(announced).toHaveLength(1);

    announced = [];
    disk.delete(digestPath);
    await syncPlotCharacters(entry);
    expect(announced).toEqual([]);
  });

  test("見送った案が無い作品では、反映するものが無い保存は今までどおり黙る", async () => {
    const { entry, digestPath } = otherWork("work_quiet");
    state.characters = [character("char_001", "灯", "主人公")];
    state.plotText = plot("- 灯：主人公");
    await syncPlotCharacters(entry);
    expect(state.stage).not.toHaveBeenCalled();

    disk.delete(digestPath);
    await syncPlotCharacters(entry);

    expect(announced).toEqual([]);
  });

  test("主要登場人物の節が無ければ、何もしない", async () => {
    state.plotText = ["# 氷の街", "", "## あらすじ", "- 灯が歩く。"].join("\n");

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });
});

/**
 * **こちらが自分で保存した plot.md では、保存からの反映を走らせない**（2026-10-16）。
 *
 * プロットモードの［入れる］は、開いている plot.md へ当てて保存する。その保存でも反映が走ると、
 * ［入れる］がもう置いた案の上に、役名だけの人物の新規の案と直す案への重ね書きを同じ保存で積み、
 * 画面テスト plotRenamePending の知らせが崩れた。見分けは時間でなく中身で行う。
 */
describe("自分で保存した plot.md の見分け", () => {
  const plotFile = nodePath.join("C:", "novels", "work", "設定", "plot.md");

  test("覚えた中身と同じ保存は1度だけ当たる（改行の違いは見ない）", () => {
    noteOwnPlotSave(plotFile, "# 題\n- 主人公（相馬 誠）：\n");
    expect(consumeOwnPlotSave(plotFile, "# 題\r\n- 主人公（相馬 誠）：\r\n")).toBe(true);
    // 次の保存は作者のもの
    expect(consumeOwnPlotSave(plotFile, "# 題\n- 主人公（相馬 誠）：\n")).toBe(false);
  });

  test("保存の知らせの前に作者が打ち足していれば当たらない（作者の分を取りこぼさない）", () => {
    noteOwnPlotSave(plotFile, "# 題\n- 主人公（相馬 誠）：\n");
    expect(consumeOwnPlotSave(plotFile, "# 題\n- 主人公（相馬 誠）：港町の高校生\n")).toBe(false);
    // 外れても覚え書きは消える（残すと、作者が同じ中身へ戻して保存したときに反映が走らない）
    expect(consumeOwnPlotSave(plotFile, "# 題\n- 主人公（相馬 誠）：\n")).toBe(false);
  });

  test("忘れたら当たらない・ほかのファイルには当たらない", () => {
    noteOwnPlotSave(plotFile, "本文\n");
    expect(consumeOwnPlotSave(nodePath.join("C:", "novels", "other", "設定", "plot.md"), "本文\n")).toBe(false);
    forgetOwnPlotSave(plotFile);
    expect(consumeOwnPlotSave(plotFile, "本文\n")).toBe(false);
  });

  test("保存の知らせの受け口は、覚え書きに当たったときだけ反映を飛ばす", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/extension.ts", "utf8");
    expect(source).toMatch(
      /if \(!consumeOwnPlotSave\(fromUri\(document\.uri\), document\.getText\(\)\)\) \{\s*void syncPlotCharactersOnSave\(fromUri\(document\.uri\)\);/
    );
  });
});
