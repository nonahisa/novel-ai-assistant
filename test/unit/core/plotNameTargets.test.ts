import { describe, expect, it } from "vitest";
import {
  buildRoleRenameProposal,
  findRoleOnlyCharacters,
  insertNamesIntoPlot,
  settingFromPlotText,
} from "../../../src/core/plotNameTargets";
import { parsePlotCharacters } from "../../../src/core/plotCharacterSync";
import { parsePlotMarkdown } from "../../../src/core/plotDoc";
import { assembleCharacterReview } from "../../../src/core/pendingReview";
import { emptyCharacter, type Character } from "../../../src/models/character";

/**
 * プロットの役名だけの人物を拾い、選んだ名前を書き足す（設計書6.4.8
 * 「名前の候補を出す」）。
 *
 * 作者の実例（現代ダンジョンのインフラ担当の plot.md、2026-09-25）と
 * 同じ形を、中身を縮めて写してある。
 */
const PLOT = [
  "# 現代ダンジョンのインフラ担当",
  "",
  "<!--",
  "このファイルは自由に書けます。",
  "  主要登場人物",
  "-->",
  "",
  "## 世界観",
  "- 現代。各地にダンジョンが出現した",
  "",
  "## あらすじ",
  "- 主人公の初現場は、中級エリアの配線の保守",
  "",
  "## 主要登場人物",
  "- 主人公：冒険者試験に落ち、敷設業者へ流れ着いた弱い新人",
  "- ヒロイン：伸び悩む新人配信者",
  "- 魔物：深層から上がってきた知能のある魔物",
  "- 班長：くたびれた中年の作業員で、最強",
  "  - 強さの自覚は無い",
  "- 向こうの業者：向こう側で封印を張っている業者",
  "",
  "## 形式",
  "長編（目標10万字）",
  "",
].join("\n");

describe("役名だけの人物を拾う", () => {
  it("実例の5人を拾い、行と説明を覚える", () => {
    const scan = findRoleOnlyCharacters(PLOT, []);

    expect(scan.hasSection).toBe(true);
    expect(scan.targets.map((target) => target.role)).toEqual([
      "主人公",
      "ヒロイン",
      "魔物",
      "班長",
      "向こうの業者",
    ]);
    expect(scan.targets.map((target) => target.id)).toEqual(["1", "2", "3", "4", "5"]);
    const lines = PLOT.split("\n");
    for (const target of scan.targets) {
      expect(lines[target.lineIndex]).toBe(target.lineText);
    }
    // 字下げした細目は直前の人物の説明に足す（別の人物にしない）
    expect(scan.targets[3].summary).toBe(
      "くたびれた中年の作業員で、最強 強さの自覚は無い"
    );
  });

  it("あらすじの節にある役名は拾わない（主要登場人物の節だけを見る）", () => {
    const scan = findRoleOnlyCharacters(PLOT, []);
    expect(scan.targets.every((target) => target.lineIndex > 13)).toBe(true);
  });

  it("名前のある行・名前を足した行は拾わない", () => {
    const text = [
      "## 主要登場人物",
      "- 月島灯：主人公。幽霊が見える",
      "- 主人公（相馬 誠）：新人",
      "- ヒロイン：配信者",
    ].join("\n");

    const scan = findRoleOnlyCharacters(text, []);

    expect(scan.targets.map((target) => target.role)).toEqual(["ヒロイン"]);
    expect(scan.skipped).toEqual([
      { name: "月島灯", reason: "名前に見えます" },
      { name: "相馬 誠", reason: "名前が入っています" },
    ]);
  });

  it("設定資料にその呼び名の人物がいれば拾わない", () => {
    const text = ["## 主要登場人物", "- 班長：最強", "- 魔物：ファン"].join("\n");
    const existing = [
      { ...emptyCharacter("char_001", "鬼塚剛"), aliases: ["班長"] },
    ];

    const scan = findRoleOnlyCharacters(text, existing);

    expect(scan.targets.map((target) => target.role)).toEqual(["魔物"]);
    expect(scan.skipped[0]).toEqual({
      name: "班長",
      reason: "設定資料に、この呼び名の人物がいます",
    });
  });

  describe("設定資料の人物の名前が役名だけのとき（作者の裁定、2026-09-25 午前）", () => {
    it("対象にし、資料のどの人物を直すかを覚える", () => {
      const text = ["## 主要登場人物", "- 主人公：新人", "- 班長：最強"].join("\n");
      const existing = [
        emptyCharacter("char_001", "主人公"),
        // 名前が役名で、プロットの役名は別名に当たる
        { ...emptyCharacter("char_002", "作業員"), aliases: ["班長"] },
      ];

      const scan = findRoleOnlyCharacters(text, existing);

      expect(scan.targets.map((target) => target.role)).toEqual(["主人公", "班長"]);
      expect(scan.targets[0].ledger).toEqual({ id: "char_001", name: "主人公" });
      expect(scan.targets[1].ledger).toEqual({ id: "char_002", name: "作業員" });
      expect(scan.skipped).toEqual([]);
    });

    it("資料に居なければ、直す相手は無い（新規の人物になる）", () => {
      const scan = findRoleOnlyCharacters("## 主要登場人物\n- 主人公：新人", []);
      expect(scan.targets[0].ledger).toBeUndefined();
    });

    it("同じ呼び名の人物が複数いれば、どれを直すか決めずに拾わない", () => {
      const text = "## 主要登場人物\n- 主人公：新人";
      const existing = [
        emptyCharacter("char_001", "主人公"),
        { ...emptyCharacter("char_002", "少年"), aliases: ["主人公"] },
      ];
      const scan = findRoleOnlyCharacters(text, existing);
      expect(scan.targets).toEqual([]);
      expect(scan.skipped[0]).toEqual({
        name: "主人公",
        reason: "設定資料に、この呼び名の人物が複数います",
      });
    });

    it("集団の呼び名（モブ）として登録された人物には、名前を付けない", () => {
      const text = "## 主要登場人物\n- 作業員：現場の人たち";
      const existing = [{ ...emptyCharacter("char_001", "作業員"), isMob: true }];
      const scan = findRoleOnlyCharacters(text, existing);
      expect(scan.targets).toEqual([]);
      expect(scan.skipped[0].reason).toContain("集団");
    });
  });

  it("迷うものも対象に含め、迷ったと印を付ける", () => {
    const text = ["## 主要登場人物", "- 男A：刺客"].join("\n");
    const scan = findRoleOnlyCharacters(text, []);
    expect(scan.targets).toHaveLength(1);
    expect(scan.targets[0].kind).toBe("unsure");
  });

  it("主要登場人物の節が無ければ、そう返す", () => {
    const scan = findRoleOnlyCharacters("# 題\n\n## あらすじ\n- 主人公が歩く", []);
    expect(scan.hasSection).toBe(false);
    expect(scan.targets).toEqual([]);
  });
});

describe("選んだ名前を書き足す", () => {
  it("書き足すのは「（名前）」だけ。ほかの行は1字も変えない", () => {
    const scan = findRoleOnlyCharacters(PLOT, []);
    const [hero, , , chief] = scan.targets;

    const result = insertNamesIntoPlot(PLOT, [
      { ...hero, name: "相馬 誠" },
      { ...chief, name: "鬼塚 剛" },
    ]);

    const before = PLOT.split("\n");
    const after = result.text.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after[hero.lineIndex]).toBe(
      "- 主人公（相馬 誠）：冒険者試験に落ち、敷設業者へ流れ着いた弱い新人"
    );
    expect(after[chief.lineIndex]).toBe("- 班長（鬼塚 剛）：くたびれた中年の作業員で、最強");
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toHaveLength(2);
    expect(result.missing).toEqual([]);
  });

  it("書き足した行は、プロットからの反映で名前と役名に分けて読まれる", () => {
    const scan = findRoleOnlyCharacters(PLOT, []);
    const result = insertNamesIntoPlot(PLOT, [{ ...scan.targets[1], name: "ミオ" }]);

    const entries = parsePlotCharacters(
      parsePlotMarkdown(result.text).sections.mainCharacters
    ).entries;
    expect(entries.find((entry) => entry.role === "ヒロイン")).toEqual({
      name: "ミオ",
      summary: "伸び悩む新人配信者",
      role: "ヒロイン",
    });
    // 書き足したあとは、もう対象に並ばない
    expect(
      findRoleOnlyCharacters(result.text, []).targets.map((target) => target.role)
    ).not.toContain("ヒロイン");
  });

  it("改行コード（CRLF）を保つ", () => {
    const crlf = PLOT.replace(/\n/g, "\r\n");
    const scan = findRoleOnlyCharacters(crlf, []);
    const result = insertNamesIntoPlot(crlf, [{ ...scan.targets[0], name: "相馬 誠" }]);

    expect(result.text.includes("\r\n")).toBe(true);
    expect(result.text.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(result.text.length).toBe(crlf.length + "（相馬 誠）".length);
  });

  it("行が拾ったときと違えば、その行には書かない", () => {
    const scan = findRoleOnlyCharacters(PLOT, []);
    const changed = PLOT.replace("- 主人公：冒険者試験", "- 主人公：もう冒険者試験");

    const result = insertNamesIntoPlot(changed, [{ ...scan.targets[0], name: "相馬 誠" }]);

    expect(result.text).toBe(changed);
    expect(result.applied).toEqual([]);
    expect(result.missing).toHaveLength(1);
  });

  it("強調の印の内側でも、役名の直後へ書き足す", () => {
    const text = ["## 主要登場人物", "- **主人公**：新人"].join("\n");
    const scan = findRoleOnlyCharacters(text, []);
    const result = insertNamesIntoPlot(text, [{ ...scan.targets[0], name: "相馬 誠" }]);
    expect(result.text.split("\n")[1]).toBe("- **主人公（相馬 誠）**：新人");
  });
});

describe("資料の役名の人物を、選んだ名前に直す案", () => {
  it("名前を直し、元の役名は役割の欄へ、読みを入れる。ほかの欄は1つも変えない", () => {
    const current: Character = {
      ...emptyCharacter("char_001", "主人公"),
      reading: "しゅじんこう",
      summary: "冒険者試験に落ちた新人",
      authorNotes: "作者のメモ",
      exportNote: "資料の補足",
      autoGenerated: false,
      appearedChapters: [1, 2],
      addressTerms: [
        {
          targetName: "班長",
          targetId: "char_002",
          forms: [],
          authorLocked: true,
        },
      ],
    };

    const proposal = buildRoleRenameProposal(current, {
      name: "相馬 誠",
      reading: "そうま まこと",
    });

    expect(proposal).toEqual({
      ...current,
      name: "相馬 誠",
      reading: "そうま まこと",
      role: "主人公",
    });
    // 元のレコードには触らない（承認するまで台帳は変わらない）
    expect(current.name).toBe("主人公");
  });

  it("役割の欄に書いてあれば、元の役名を頭に足す。もう含まれていれば足さない", () => {
    const withRole = { ...emptyCharacter("char_001", "主人公"), role: "敷設業者の新人" };
    expect(
      buildRoleRenameProposal(withRole, { name: "相馬 誠", reading: "そうま まこと" }).role
    ).toBe("主人公。敷設業者の新人");

    const already = { ...emptyCharacter("char_001", "主人公"), role: "物語の主人公" };
    expect(
      buildRoleRenameProposal(already, { name: "相馬 誠", reading: "そうま まこと" }).role
    ).toBe("物語の主人公");
  });

  it("承認の画面に、名前・読み・役割の変化として並ぶ（差分が無いと見て片付けられない）", () => {
    const current = emptyCharacter("char_001", "主人公");
    const proposal = buildRoleRenameProposal(current, {
      name: "相馬 誠",
      reading: "そうま まこと",
    });

    const review = assembleCharacterReview(
      [{ character: proposal, filePath: "char_001.json", source: "plot" }],
      [current],
      []
    );

    expect(review.stale).toEqual([]);
    expect(review.items[0].diff.changes.map((change) => change.label)).toEqual([
      "名前",
      "読み",
      "役割",
    ]);
  });

  it("新しい名前と同じ別名は外す（名前と別名が二重にならない）", () => {
    const current = { ...emptyCharacter("char_001", "主人公"), aliases: ["相馬 誠", "新人"] };
    expect(
      buildRoleRenameProposal(current, { name: "相馬 誠", reading: "そうま まこと" }).aliases
    ).toEqual(["新人"]);
  });
});

describe("世界観の材料", () => {
  it("世界観と舞台の節を渡す（名前の点検と同じ読み方）", () => {
    expect(settingFromPlotText(PLOT)).toBe("- 現代。各地にダンジョンが出現した");
  });
});
