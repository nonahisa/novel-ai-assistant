import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  countSettingsGeneric,
  formatSpreadLines,
  metricsOfRun,
  scoreSettings,
  settingsLedgerOf,
  spreadOfRuns,
} from "../../scripts/measureScoring.mjs";

/*
  設定資料の抽出（P-04a、feature: settings）の**数え方**を確かめる
  （測定台は `test/fixtures/seeded/settings/`）。

  束も Ollama も要らない。**満点の入力とわざと壊した入力の両方を通す**
  ——片方だけでは、**常に満点を返す採点器**が通ってしまう。
*/

const ROOT = path.join(
  __dirname,
  "..",
  "fixtures",
  "seeded",
  "settings"
);

interface AnswerEntry {
  name?: string;
  label?: string;
  also?: string[];
  aliases?: string[];
}

interface Answers {
  abilityTerm: string;
  expected: {
    characters: AnswerEntry[];
    abilities: AnswerEntry[];
    locations: AnswerEntry[];
    organizations: AnswerEntry[];
    world: Array<{ label: string; keywords: string[][] }>;
  };
  mustNotAppear: Record<string, string[]>;
  mustStaySeparate: Array<{ trap: number; names: string[] }>;
  mustMerge: Array<{ trap: number; name: string; forms: string[] }>;
  forbiddenRelations: Array<{ between: string[]; words: string[] }>;
  rules: { mustNotContain: string[] };
  traps: Array<{ no: number; name: string; checkedBy: string }>;
  totals: Record<string, unknown>;
}

const ANSWERS: Answers = JSON.parse(
  fs.readFileSync(path.join(ROOT, "answers.json"), "utf8")
);

/* ── 返り値の形を組む（`src/mcp/tools/settings.ts` の SettingsValidateResult） ── */

interface Relation {
  name: string;
  relation: string;
}

function person(
  name: string,
  aliases: string[] = [],
  relations: Relation[] = []
): Record<string, unknown> {
  return { data: { name, aliases, relations }, chapters: [1] };
}

function named(name: string, aliases: string[] = []): Record<string, unknown> {
  return { data: { name, aliases }, chapters: [1] };
}

function world(
  name: string,
  description: string,
  category = "rule"
): Record<string, unknown> {
  return { data: { name, description }, category, chapters: [1] };
}

interface SettingsPart {
  abilities?: unknown[];
  locations?: unknown[];
  organizations?: unknown[];
  worldItems?: unknown[];
  rejected?: Array<{ name: string | null; reason: string }>;
  abilityTerm?: string | null;
  rules?: string[];
}

interface CharactersPart {
  accepted?: unknown[];
  rejected?: Array<{ name: string | null; reason: string }>;
  droppedSharedFamilyNameAliases?: unknown[];
  droppedRelations?: unknown[];
}

function chunkResult(
  file: string,
  characters: CharactersPart,
  settings: SettingsPart,
  index = 0
): Record<string, unknown> {
  return {
    chunkId: `本文/${file}#1-${index}@8000`,
    chapterLabel: "第1話",
    characters: {
      accepted: [],
      rejected: [],
      droppedSharedBodyAliases: [],
      droppedTruncatedAliases: [],
      droppedSharedFamilyNameAliases: [],
      droppedRelativeAliases: [],
      droppedRelations: [],
      correctedRelations: [],
      ...characters,
    },
    settings: {
      abilities: [],
      locations: [],
      organizations: [],
      worldItems: [],
      affiliations: [],
      rejected: [],
      abilityTerm: null,
      rules: [],
      ...settings,
    },
    note: "",
  };
}

/** 答えのとおりに返ってきた場合。**これが満点になる** */
const PERFECT = [
  chunkResult(
    "001_水路の朝.txt",
    {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"]),
        person("リーナ・ヴェイル", ["リーナ"]),
      ],
    },
    {
      abilities: [named("灯継ぎ"), named("水読み")],
      locations: [named("カルネラ"), named("中央水路")],
      organizations: [named("灯守り組合")],
      worldItems: [
        world("神術の宿り先", "神術は水にしか宿らない。火にも風にも土にも宿らない"),
        world("神術の代償", "神術を使うと、使い手の体が冷える"),
        world("灯替えの夜", "年に一度、街じゅうの灯を落として継ぎ直す", "culture"),
      ],
      abilityTerm: "神術",
      rules: ["水にしか宿らない", "ひとりで継いでよいのは一日に三つまで"],
    }
  ),
  chunkResult(
    "002_石の館.txt",
    {
      accepted: [
        person("ヴェイル子爵", [], [
          { name: "リーナ・ヴェイル", relation: "娘" },
          { name: "セルド・ヴェイル", relation: "息子" },
        ]),
        person("リーナ・ヴェイル", ["リーナ"], [
          { name: "セルド・ヴェイル", relation: "兄" },
        ]),
        person("セルド・ヴェイル", ["セルド"], [
          { name: "リーナ・ヴェイル", relation: "妹" },
        ]),
        person("ガーロ"),
        person("ヨナ", ["ヨナ君"]),
      ],
    },
    {
      locations: [named("カルネラ"), named("中央水路"), named("石の館")],
      organizations: [named("ヴェイル家"), named("灯守り組合")],
      worldItems: [
        world(
          "ヴェイル家の統治",
          "ヴェイル家がカルネラを代々治めている",
          "society"
        ),
      ],
      abilityTerm: "神術",
    }
  ),
  chunkResult(
    "003_灯替えの夜.txt",
    {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"]),
        person("リーナ・ヴェイル", ["リーナ"]),
      ],
    },
    {
      abilities: [named("灯継ぎ"), named("水読み")],
      abilityTerm: "神術",
    }
  ),
];

/**
 * 満点の入力から、1つの話だけを差し替える。
 *
 * **壊すのは1か所だけにする。** 2か所いっぺんに壊すと、下がった数字が
 * どちらのせいか分からなくなる（2か所壊したいときは `base` に前の結果を渡す）。
 */
function broken(
  at: number,
  characters: CharactersPart,
  settings: SettingsPart = {},
  base: Record<string, unknown>[] = PERFECT
): Record<string, unknown>[] {
  const copy = [...base];
  const file = ["001_水路の朝.txt", "002_石の館.txt", "003_灯替えの夜.txt"][at];
  const original = base[at] as {
    characters: CharactersPart;
    settings: SettingsPart;
  };
  copy[at] = chunkResult(
    file,
    { ...original.characters, ...characters },
    { ...original.settings, ...settings }
  );
  return copy;
}

/* ── 満点 ─────────────────────────────────────────────── */

describe("設定資料の抽出の答え合わせ（答えどおりなら満点）", () => {
  const scored = scoreSettings(ANSWERS, PERFECT);

  it("出るべきものを全部拾えている", () => {
    expect(scored.entities.found).toBe(scored.entities.total);
    expect(scored.entities.total).toBe(16);
    expect(scored.missed).toEqual([]);
  });

  it("種別ごとの内訳が出る", () => {
    expect(scored.entities.byKind).toEqual({
      人物: { found: 5, total: 5 },
      能力: { found: 2, total: 2 },
      場所: { found: 3, total: 3 },
      組織: { found: 2, total: 2 },
      世界観: { found: 4, total: 4 },
    });
  });

  it("あるべき別名も全部そろっている", () => {
    expect(scored.aliases).toMatchObject({ found: 4, total: 4 });
    expect(scored.aliases.missed).toEqual([]);
  });

  it("でっち上げ・誤統合・誤分割・でっち上げの関係は0", () => {
    expect(scored.fabricated.count).toBe(0);
    expect(scored.wrongMerge).toMatchObject({ count: 0, total: 3 });
    expect(scored.wrongSplit).toMatchObject({ count: 0, total: 2 });
    expect(scored.relations.count).toBe(0);
  });

  it("能力の総称が合っていて、rules に指示文が入っていない", () => {
    expect(scored.abilityTerm).toMatchObject({ actual: "神術", ok: true });
    expect(scored.ruleLeak.count).toBe(0);
  });

  it("仕込み以外のレコードは出ていない", () => {
    expect(scored.otherRecords).toMatchObject({ count: 0 });
  });

  it("兄妹の関係・親子の関係は、本文にあるので咎めない", () => {
    // 罠7が見張るのは「リーナとヨナ」だけ。実在する血縁まで誤検出にすると、
    // **正しく書いたモデルほど点が下がる**
    expect(scored.relations.items).toEqual([]);
  });
});

/* ── わざと間違えた入力（減点されなければ、採点器のほうが壊れている） ── */

describe("わざと間違えた入力は減点される", () => {
  it("罠1・罠2：別人を1件にまとめたら、誤って統合した組に数える", () => {
    const results = broken(1, {
      accepted: [
        person("ヴェイル子爵"),
        // セルドを妹の別名に吸収させ、セルドのレコードを消した
        person("リーナ・ヴェイル", ["リーナ", "セルド", "お子さま"]),
        person("ガーロ"),
        person("ヨナ", ["ヨナ君"]),
      ],
    });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.wrongMerge.count).toBe(1);
    expect(scored.wrongMerge.items[0]).toMatchObject({
      mergedInto: "リーナ・ヴェイル",
    });
    // 吸収された側は「拾えた」に数えない（1つのレコードを2人に使い回さない）
    expect(scored.entities.found).toBe(15);
    expect(scored.aliases.found).toBe(3);
    // 一般語を別名にしたのも、でっち上げ
    expect(scored.fabricated.items).toContainEqual({
      kind: "別名",
      name: "リーナ・ヴェイル",
      alias: "お子さま",
    });
  });

  it("罠2：親を子の別名にしても、誤って統合した組に数える", () => {
    const results = broken(1, {
      accepted: [
        person("リーナ・ヴェイル", ["リーナ", "ヴェイル子爵"]),
        person("セルド・ヴェイル", ["セルド"]),
        person("ガーロ"),
        person("ヨナ", ["ヨナ君"]),
      ],
    });
    expect(scoreSettings(ANSWERS, results).wrongMerge.count).toBe(1);
  });

  it("罠3：同じ人物を別レコードに割ったら、誤って分けた組に数える", () => {
    const results = broken(0, {
      accepted: [
        person("ヨナ"),
        person("ヨナ君"),
        person("リーナ・ヴェイル", ["リーナ"]),
      ],
    });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.wrongSplit.count).toBe(1);
    expect(scored.wrongSplit.items[0]).toMatchObject({
      name: "ヨナ",
      splitInto: ["ヨナ君"],
    });
  });

  it("罠4：役職のままレコードを作ったら、誤って分けた組に数える", () => {
    const results = broken(1, {
      accepted: [
        person("ヴェイル子爵"),
        person("リーナ・ヴェイル", ["リーナ"]),
        person("セルド・ヴェイル", ["セルド"]),
        person("ガーロ"),
        person("執事"),
        person("ヨナ", ["ヨナ君"]),
      ],
    });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.wrongSplit.count).toBe(1);
    expect(scored.fabricated.items).toContainEqual({
      kind: "人物",
      name: "執事",
    });
  });

  it("罠5・罠6：語り手と群衆のレコードは、でっち上げに数える", () => {
    const results = broken(0, {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"]),
        person("リーナ・ヴェイル", ["リーナ"]),
        person("わたし"),
        person("野次馬"),
        person("通行人"),
      ],
    });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.fabricated.count).toBe(3);
    expect(scored.fabricated.items.map((item) => item.name)).toEqual([
      "わたし",
      "野次馬",
      "通行人",
    ]);
    // **拾えた数は減らない。** でっち上げは見逃しとは別の失敗である
    expect(scored.entities.found).toBe(16);
  });

  it("罠7：本文に無い血縁を書いたら、でっち上げの関係に数える", () => {
    const results = broken(2, {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"]),
        person("リーナ・ヴェイル", ["リーナ"], [
          { name: "ヨナ", relation: "兄" },
        ]),
      ],
    });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.relations.count).toBe(1);
    expect(scored.relations.items[0]).toMatchObject({
      from: "リーナ・ヴェイル",
      to: "ヨナ",
      relation: "兄",
    });
  });

  it("罠7：逆向き（ヨナ側に書いた）でも拾う", () => {
    const results = broken(2, {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"], [
          { name: "リーナ・ヴェイル", relation: "妹" },
        ]),
        person("リーナ・ヴェイル", ["リーナ"]),
      ],
    });
    expect(scoreSettings(ANSWERS, results).relations.count).toBe(1);
  });

  it("罠7：血縁でない関係（幼なじみ）は咎めない", () => {
    const results = broken(2, {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"]),
        person("リーナ・ヴェイル", ["リーナ"], [
          { name: "ヨナ", relation: "幼なじみ" },
        ]),
      ],
    });
    expect(scoreSettings(ANSWERS, results).relations.count).toBe(0);
  });

  it("罠8：能力の総称がジャンル名になったら0点", () => {
    // 総称は**いちばん最初に読み取れたもの**が使われる（製品の集約と同じ）
    const results = broken(0, {}, { abilityTerm: "ファンタジー" });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.abilityTerm).toMatchObject({
      actual: "ファンタジー",
      ok: false,
    });
  });

  it("罠9：rules にプロンプトの指示文が入ったら数える", () => {
    const results = broken(
      0,
      {},
      {
        rules: [
          "水にしか宿らない",
          "本文に書かれていない事実を作らないこと",
          "読み取れないものは推測で埋めてはならない",
        ],
      }
    );
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.ruleLeak.count).toBe(2);
    expect(scored.ruleLeak.items[0]).toMatchObject({ marker: "本文" });
  });

  it("罠10：街を組織に、家を場所に出したら、でっち上げに数える", () => {
    const results = broken(
      1,
      {},
      {
        locations: [named("カルネラ"), named("中央水路"), named("ヴェイル家")],
        organizations: [named("灯守り組合"), named("カルネラ")],
      }
    );
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.fabricated.items).toContainEqual({
      kind: "場所",
      name: "ヴェイル家",
    });
    expect(scored.fabricated.items).toContainEqual({
      kind: "組織",
      name: "カルネラ",
    });
    // 石の館（場所）とヴェイル家（組織）が落ちたぶんは見逃し
    expect(scored.entities.found).toBe(14);
  });

  it("何も返さなければ、全部が見逃しになる（0件が満点にならない）", () => {
    const scored = scoreSettings(ANSWERS, []);

    expect(scored.entities).toMatchObject({ found: 0, total: 16 });
    expect(scored.aliases).toMatchObject({ found: 0, total: 4 });
    expect(scored.fabricated.count).toBe(0);
    expect(scored.abilityTerm.ok).toBe(false);
  });

  it("答えに無いレコードは、でっち上げとは別に数える", () => {
    const results = broken(0, {
      accepted: [
        person("ヨナ", ["ヨナ君", "ヨナ様"]),
        person("リーナ・ヴェイル", ["リーナ"]),
        person("水の精"),
      ],
    });
    const scored = scoreSettings(ANSWERS, results);

    expect(scored.fabricated.count).toBe(0);
    expect(scored.otherRecords).toMatchObject({ count: 1 });
    expect(scored.otherRecords.items[0]).toMatchObject({ name: "水の精" });
  });
});

/* ── 台帳（返り値のほぐし方） ──────────────────────────── */

describe("返り値のほぐし方", () => {
  it("設定資料は積み上がっているので、話ごとに最後のチャンクだけを見る", () => {
    const ledger = settingsLedgerOf([
      chunkResult("001_水路の朝.txt", {}, { locations: [named("カルネラ")] }, 0),
      // 2つ目のチャンクは、1つ目のぶんも含んだ形で返ってくる（製品の集約）
      chunkResult(
        "001_水路の朝.txt",
        {},
        { locations: [named("カルネラ"), named("中央水路")] },
        1
      ),
    ]);
    expect(ledger.locations.map((record) => record.name)).toEqual([
      "カルネラ",
      "中央水路",
    ]);
  });

  it("人物はチャンクごとの結果なので、すべての話から集めて畳む", () => {
    const ledger = settingsLedgerOf([
      chunkResult("001_水路の朝.txt", { accepted: [person("ヨナ", ["ヨナ君"])] }),
      chunkResult("003_灯替えの夜.txt", {
        accepted: [person("ヨナ", ["ヨナ様"])],
      }),
    ]);
    expect(ledger.characters).toHaveLength(1);
    expect(ledger.characters[0].aliases).toEqual(["ヨナ君", "ヨナ様"]);
  });

  it("「リーナ・ヴェイル」と「リーナ ヴェイル」は同じ人として扱う", () => {
    const ledger = settingsLedgerOf([
      chunkResult("001_水路の朝.txt", {
        accepted: [person("リーナ・ヴェイル"), person("リーナ ヴェイル")],
      }),
    ]);
    expect(ledger.characters).toHaveLength(1);
  });

  it("「ヴェイル子爵」と「ヴェイル家」は畳まない（罠2と罠10が測れなくなる）", () => {
    const ledger = settingsLedgerOf([
      chunkResult("002_石の館.txt", {
        accepted: [person("ヴェイル子爵")],
      }),
    ]);
    expect(ledger.characters[0].name).toBe("ヴェイル子爵");
    const scored = scoreSettings(ANSWERS, [
      chunkResult(
        "002_石の館.txt",
        { accepted: [person("ヴェイル子爵")] },
        { organizations: [named("ヴェイル家")] }
      ),
    ]);
    expect(scored.fabricated.count).toBe(0);
  });
});

/* ── 件数と落とした理由 ───────────────────────────────── */

describe("件数と落とした理由", () => {
  it("設定資料の返り値でも、件数と落とした理由を数えられる", () => {
    const counted = countSettingsGeneric([
      chunkResult(
        "001_水路の朝.txt",
        {
          accepted: [person("ヨナ")],
          rejected: [
            { name: "わたし", reason: "pronoun_name" },
            { name: "執事", reason: "non_person" },
          ],
          droppedSharedFamilyNameAliases: [
            { characterName: "リーナ・ヴェイル", alias: "ヴェイル" },
          ],
        },
        {
          locations: [named("カルネラ")],
          rejected: [{ name: "水の都", reason: "ungrounded" }],
        }
      ),
    ]);

    expect(counted).toMatchObject({
      accepted: 2,
      rejected: 3,
      rejectedReasons: {
        pronoun_name: 1,
        non_person: 1,
        ungrounded: 1,
      },
    });
    expect(counted.dropped.共有された姓).toBe(1);
  });
});

/* ── 指標の表 ─────────────────────────────────────────── */

describe("指標の表", () => {
  it("拾えた・見逃し・でっち上げ・誤統合が、分母つきで並ぶ", () => {
    const { metrics, detail } = metricsOfRun("settings", ANSWERS, {
      results: PERFECT,
      failures: [],
      elapsedMs: 5_000,
    });

    expect(metrics).toMatchObject({
      settingsFound: 16,
      settingsFoundTotal: 16,
      settingsMissed: 0,
      settingsAliases: 4,
      settingsAliasesTotal: 4,
      settingsFabricated: 0,
      settingsWrongMerge: 0,
      settingsWrongMergeTotal: 3,
      settingsWrongSplit: 0,
      settingsWrongSplitTotal: 2,
      settingsFakeRelations: 0,
      settingsAbilityTerm: 1,
      settingsRuleLeak: 0,
      settingsOtherRecords: 0,
      accepted: 16,
      rejected: 0,
      failures: 0,
    });
    expect(detail.settingsFound["人物"]).toEqual({ found: 5, total: 5 });

    const lines = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines[0]).toBe(
      "出るべきものを拾えた（人物・能力・場所・組織・世界観）: 16/16"
    );
    // **推敲・逸脱・矛盾の見出しが、こちらの表へ漏れていない**
    expect(lines.join("\n")).not.toContain("当て字");
    expect(lines.join("\n")).not.toContain("仕込んだ逸脱");
  });

  it("壊した入力では、数字が下がって断りが添う", () => {
    const merged = broken(1, {
      accepted: [
        person("ヴェイル子爵"),
        person("リーナ・ヴェイル", ["リーナ", "セルド"]),
        person("ガーロ"),
        person("ヨナ", ["ヨナ君"]),
      ],
    });
    // 総称と rules は、いちばん最初の話から読まれる（そちらを壊す）
    const results = broken(
      0,
      {},
      { abilityTerm: "ファンタジー", rules: ["本文から読み取れる範囲で書くこと"] },
      merged
    );
    const { metrics } = metricsOfRun("settings", ANSWERS, {
      results,
      failures: [],
      elapsedMs: 5_000,
    });

    expect(metrics.settingsFound).toBe(15);
    expect(metrics.settingsMissed).toBe(1);
    expect(metrics.settingsWrongMerge).toBe(1);
    expect(metrics.settingsAbilityTerm).toBe(0);
    expect(metrics.settingsRuleLeak).toBe(1);

    const lines = formatSpreadLines(spreadOfRuns([{ metrics }])).join("\n");
    expect(lines).toContain("別人が1件に潰れています");
    expect(lines).toContain("能力の総称が合っていません");
    expect(lines).toContain("rules にプロンプトの指示文が混ざっています");
  });

  it("落とした理由と落とした別名が、日本語の見出しで並ぶ", () => {
    const { metrics } = metricsOfRun("settings", ANSWERS, {
      results: [
        chunkResult(
          "001_水路の朝.txt",
          {
            rejected: [{ name: "わたし", reason: "pronoun_name" }],
            droppedSharedFamilyNameAliases: [
              { characterName: "リーナ・ヴェイル", alias: "ヴェイル" },
            ],
          },
          {}
        ),
      ],
      failures: [],
      elapsedMs: 100,
    });

    const lines = formatSpreadLines(spreadOfRuns([{ metrics }])).join("\n");
    expect(lines).toContain("落とした理由：pronoun_name（代名詞の名前）");
    expect(lines).toContain("落とした別名：共有された姓: 1");
  });

  it("落とした関係は、別名ではなく関係の見出しで、理由ごとに分けて出る", () => {
    // でっち上げの関係が0になったとき、**検算が効いたのか、AIが最初から
    // 書かなかったのか**は、この行が無いと読み分けられない。
    // さらに**言い回しと構造のどちらが効いたのか**も分けて出す——
    // 言い回しの表は言い換えられるたびに増えるので、構造だけで落ちた数が
    // 見えないと、表を足す意味があったのかを測れない
    const { metrics } = metricsOfRun("settings", ANSWERS, {
      results: [
        chunkResult(
          "001_水路の朝.txt",
          {
            droppedRelations: [
              {
                characterName: "リーナ・ヴェイル",
                partner: "ヨナ",
                relation: "（関係性は明記されていない）",
                reason: "not_a_relation",
              },
              {
                characterName: "リーナ・ヴェイル",
                partner: "ヨナ",
                relation:
                  "（互いの名を呼び合う程度の間柄にとどまり、それ以上の情報は与えられていない）",
                reason: "sentence_shaped",
              },
            ],
          },
          {}
        ),
      ],
      failures: [],
      elapsedMs: 100,
    });

    const lines = formatSpreadLines(spreadOfRuns([{ metrics }])).join("\n");
    expect(lines).toContain("関係の検算：言い回しで落とした関係: 1");
    expect(lines).toContain("関係の検算：文の形で落とした関係: 1");
  });
});

/* ── 測定台そのものの点検 ─────────────────────────────── */

describe("設定資料の測定台（答えと本文が食い違っていないか）", () => {
  const bodies = fs
    .readdirSync(path.join(ROOT, "本文"))
    .sort()
    .map((name) => fs.readFileSync(path.join(ROOT, "本文", name), "utf8"));
  const whole = bodies.join("\n");

  const namedEntries = [
    ...ANSWERS.expected.characters,
    ...ANSWERS.expected.abilities,
    ...ANSWERS.expected.locations,
    ...ANSWERS.expected.organizations,
  ];

  it("出るべきものの名前と別名は、本文にそのまま実在する", () => {
    for (const entry of namedEntries) {
      for (const form of [
        entry.name ?? "",
        ...(entry.also ?? []),
        ...(entry.aliases ?? []),
      ]) {
        expect(whole.includes(form), `本文に無い: ${form}`).toBe(true);
      }
    }
  });

  it("指示文の目印は、台の本文に1つも出てこない", () => {
    // 出てくると、正しく本文から取った決まりを「指示文の混入」と数えてしまう
    for (const marker of ANSWERS.rules.mustNotContain) {
      expect(whole.includes(marker), `本文にある: ${marker}`).toBe(false);
    }
  });

  it("出てはいけないものは、出るべきものと重なっていない", () => {
    const expectedNames = new Set(
      namedEntries.flatMap((entry) => [
        entry.name ?? "",
        ...(entry.also ?? []),
      ])
    );
    for (const kind of ["characters", "abilities", "locations", "organizations"]) {
      for (const name of ANSWERS.mustNotAppear[kind] ?? []) {
        // 同じ種別で重なると、拾えたのに「でっち上げ」と数えることになる
        const clash = (ANSWERS.expected as Record<string, AnswerEntry[]>)[kind]
          .flatMap((entry) => [entry.name ?? "", ...(entry.also ?? [])])
          .includes(name);
        expect(clash, `${kind} で重なっている: ${name}`).toBe(false);
      }
    }
    for (const alias of ANSWERS.mustNotAppear.aliases ?? []) {
      expect(expectedNames.has(alias), `別名が名前と重なる: ${alias}`).toBe(
        false
      );
    }
  });

  it("まとまるべき組・分かれているべき組の名前は、出るべき人物に載っている", () => {
    const people = new Set(
      ANSWERS.expected.characters.map((entry) => entry.name ?? "")
    );
    for (const pair of ANSWERS.mustStaySeparate) {
      for (const name of pair.names) expect(people.has(name)).toBe(true);
    }
    for (const entry of ANSWERS.mustMerge) {
      expect(people.has(entry.name)).toBe(true);
    }
    for (const rule of ANSWERS.forbiddenRelations) {
      for (const name of rule.between) expect(people.has(name)).toBe(true);
    }
  });

  it("罠は10個そろっていて、どこで見張るかが書いてある", () => {
    expect(ANSWERS.traps.map((trap) => trap.no)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    for (const trap of ANSWERS.traps) {
      expect(trap.checkedBy.length).toBeGreaterThan(0);
    }
  });

  it("answers.json の totals は、中身と合っている", () => {
    expect(ANSWERS.totals["出るべきもの"]).toEqual({
      人物: ANSWERS.expected.characters.length,
      能力: ANSWERS.expected.abilities.length,
      場所: ANSWERS.expected.locations.length,
      組織: ANSWERS.expected.organizations.length,
      世界観: ANSWERS.expected.world.length,
      合計: 16,
    });
    const aliases = ANSWERS.expected.characters
      .concat(ANSWERS.expected.abilities)
      .concat(ANSWERS.expected.locations)
      .concat(ANSWERS.expected.organizations)
      .reduce((sum, entry) => sum + (entry.aliases ?? []).length, 0);
    expect(ANSWERS.totals["あるべき別名"]).toBe(aliases);
    expect(ANSWERS.totals["分かれているべき組"]).toBe(
      ANSWERS.mustStaySeparate.length
    );
    expect(ANSWERS.totals["まとまるべき組"]).toBe(ANSWERS.mustMerge.length);
  });

  it("設定/ は空から始まる（抽出前の状態）", () => {
    const entries = fs
      .readdirSync(path.join(ROOT, "設定"))
      .filter((name) => name !== ".gitkeep");
    expect(entries).toEqual([]);
  });

  it("各話は 1,000〜1,500字に収まっている", () => {
    for (const body of bodies) {
      const chars = body.replace(/\r?\n/g, "").length;
      expect(chars).toBeGreaterThanOrEqual(1000);
      expect(chars).toBeLessThanOrEqual(1500);
    }
  });
});
