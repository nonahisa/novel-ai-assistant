import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { extractCommit } from "../../../src/mcp/tools/extractCommit";
import {
  extractStashFileOf,
  readExtractStash,
} from "../../../src/mcp/tools/extractStash";
import {
  extractEnrichStashFileOf,
  readExtractEnrichStash,
} from "../../../src/mcp/tools/extractEnrichStash";
import { settingsPrompt, settingsValidate } from "../../../src/mcp/tools/settings";
import { novelPrompt, novelValidate } from "../../../src/mcp/tools/features";
import { settingsEnrichPrompt } from "../../../src/mcp/tools/settingsEnrich";
import { buildEnrichPrompt } from "../../../src/prompts/settingsEnrich";
import { KIND_LABELS } from "../../../src/core/settingsSummary";
import {
  emptyCharacter,
  nextCharacterId,
  parseCharacter,
  type Character,
} from "../../../src/models/character";

/**
 * 抽出の保存の前に、外部AIが性格・外見などを「解説として読める形」にまとめ直す道
 * （作者の裁定 2026-10-02）。
 *
 * 見張ること：
 * - まとめは**まだ保存していない新規レコード**の本体の欄へ入り、面と根拠
 *   （`personalityFacets`・`changes`）は残る
 * - 検算（製品の「AIで再読込」と同じ `checkEnrichProposals`）で落ちたまとめは入らない
 * - 既存の記録（承認待ちへ回るもの）には効かない
 * - まとめたあとで抽出の貯めが変わったら、古いまとめは入れない
 * - 抽出の貯め場所（`external-extract.json`）の形は1バイトも変えない
 */

const NUM_CTX = 32768;
const temporary: string[] = [];
const FIRST_CHARACTER_ID = nextCharacterId([]);

const EPISODE_1 = "001_出会い.txt";
const EPISODE_2 = "002_嵐.txt";
const TEXT_1 =
  "　港町に灯という娘がいた。\n" +
  "　灯は毎晩、灯台に火をともした。\n" +
  "「わたしが守るの」と灯は言った。\n";
const TEXT_2 =
  "　嵐の夜、漁師の岩男が港町へ戻ってきた。\n" +
  "　岩男は日焼けした大男で、灯に深々と頭を下げて礼を言った。\n";

/** 本文だけの作品（`設定/` がまだ無い）。`withExisting` なら人物「灯」が台帳にある */
function makeWork(withExisting = false): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-extract-enrich-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE_1), TEXT_1, "utf8");
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE_2), TEXT_2, "utf8");
  if (withExisting) {
    const character = emptyCharacter(FIRST_CHARACTER_ID, "灯");
    fs.mkdirSync(nodePath.join(folder, "設定", "characters"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(folder, "設定", "characters", `${character.id}_灯.json`),
      `${JSON.stringify({ ...character, updatedAt: "2026-09-01T00:00:00.000Z" }, null, 2)}\n`,
      "utf8"
    );
  }
  return folder;
}

const ANSWER_1 = {
  characters: [
    {
      name: "灯",
      aliases: [],
      entityType: "person",
      summary: "毎晩、灯台に火をともす娘",
      evidence: "灯は毎晩、灯台に火をともした",
    },
  ],
  locations: [
    {
      name: "灯台",
      description: "灯が毎晩火をともす塔",
      evidence: "灯台に火をともした",
    },
  ],
};

const ANSWER_2 = {
  characters: [
    {
      name: "岩男",
      aliases: [],
      entityType: "person",
      role: "漁師",
      personality: "律儀",
      appearance: "日焼けした大男",
      evidence: "岩男は日焼けした大男で、灯に深々と頭を下げて礼を言った",
    },
  ],
};

function chunkIdOf(folder: string, episode: string): string {
  return settingsPrompt({ folder, filePath: `本文/${episode}`, numCtx: NUM_CTX })
    .chunks[0].chunkId;
}

function stashAnswer(folder: string, episode: string, answer: unknown): void {
  settingsValidate({
    folder,
    chunkId: chunkIdOf(folder, episode),
    response: JSON.stringify(answer),
    stash: true,
  });
}

function stashBoth(folder: string): void {
  stashAnswer(folder, EPISODE_1, ANSWER_1);
  stashAnswer(folder, EPISODE_2, ANSWER_2);
}

/** AIで再読込の答え（人物）。指定しない欄は null */
function enrichAnswer(values: Record<string, string | null>): string {
  return JSON.stringify({
    gender: null,
    summary: null,
    affiliation: null,
    role: null,
    personality: null,
    speechStyle: null,
    appearance: null,
    misattributed: [],
    ...values,
  });
}

const SUMMARY_PERSONALITY =
  "恩を受けた相手には深々と頭を下げて礼を言う、律儀で礼儀を重んじる人柄";
const SUMMARY_APPEARANCE = "日焼けした肌の大柄な男";

function stashSummary(folder: string, name: string, response: string): unknown {
  return novelValidate({
    folder,
    feature: "settingsEnrich",
    response,
    stash: true,
    options: { fromExtract: true, name },
  });
}

function savedCharacter(folder: string, name: string): Character {
  const dir = nodePath.join(folder, "設定", "characters");
  const file = fs.readdirSync(dir).find((entry) => entry.endsWith(`_${name}.json`));
  if (!file) throw new Error(`${name} が保存されていない`);
  return parseCharacter(JSON.parse(fs.readFileSync(nodePath.join(dir, file), "utf8")));
}

function sha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

afterEach(() => {
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("まとめ直しのプロンプト（まだ保存していない新規レコード）", () => {
  it("製品の「AIで再読込」と同じ関数で組み、新規の人物の【現在の設定】を載せる", () => {
    const folder = makeWork();
    stashBoth(folder);

    const prompt = novelPrompt({
      folder,
      feature: "settingsEnrich",
      options: { fromExtract: true, name: "岩男" },
    }) as ReturnType<typeof settingsEnrichPrompt>;

    expect(prompt.name).toBe("岩男");
    expect(prompt.promptVersion).toMatch(/^P-20 /);
    // 指示の文言は製品と同じ（プロンプトの頭の行が同じ関数から出ている）
    const head = buildEnrichPrompt({
      workTitle: "x",
      kind: "character",
      target: { kindLabel: KIND_LABELS.character, name: "岩男", currentSettings: "" },
      excerpts: [],
    })
      .split("\n")
      .slice(-12)
      .join("\n");
    expect(prompt.userPrompt).toContain(head);
    // 抽出で積んだ値が【現在の設定】に入っている
    expect(prompt.userPrompt).toContain("律儀");
    expect(prompt.userPrompt).toContain("日焼けした大男");
    // まだ保存していない（台帳にファイルは無い）
    expect(fs.existsSync(nodePath.join(folder, "設定", "characters"))).toBe(false);
  });

  it("既存の記録（承認待ちへ回るもの）は断る", () => {
    const folder = makeWork(true);
    stashBoth(folder);

    expect(() =>
      novelPrompt({
        folder,
        feature: "settingsEnrich",
        options: { fromExtract: true, name: "灯" },
      })
    ).toThrow(/既存/);
    expect(() => stashSummary(folder, "灯", enrichAnswer({ role: "灯台守" }))).toThrow(
      /既存/
    );
    expect(fs.existsSync(extractEnrichStashFileOf(folder))).toBe(false);
  });

  it("台帳の記録への再読込（fromExtract なし）で stash を付けたら断る", () => {
    const folder = makeWork(true);
    expect(() =>
      novelValidate({
        folder,
        feature: "settingsEnrich",
        response: enrichAnswer({ role: "灯台守" }),
        stash: true,
        options: { name: "灯" },
      })
    ).toThrow(/fromExtract/);
  });
});

describe("まとめを貯めて、保存で本体の欄へ入れる", () => {
  it("まとめは本体の欄へ入り、面と根拠（personalityFacets・changes）は残る", () => {
    const folder = makeWork();
    stashBoth(folder);
    const extractStashBefore = sha(extractStashFileOf(folder));

    const validated = stashSummary(
      folder,
      "岩男",
      enrichAnswer({ personality: SUMMARY_PERSONALITY, appearance: SUMMARY_APPEARANCE })
    ) as { stashed?: boolean; edits?: Record<string, string> };
    expect(validated.stashed).toBe(true);
    expect(validated.edits).toEqual({
      personality: SUMMARY_PERSONALITY,
      appearance: SUMMARY_APPEARANCE,
    });
    // 抽出の貯め場所は1バイトも変わっていない（形の後方互換）
    expect(sha(extractStashFileOf(folder))).toBe(extractStashBefore);
    expect(readExtractStash(folder)).toHaveLength(2);

    const result = extractCommit({ folder });
    expect(result.summaries.applied).toEqual([
      { kind: "character", name: "岩男", fields: ["personality", "appearance"] },
    ]);

    const saved = savedCharacter(folder, "岩男");
    expect(saved.personality).toBe(SUMMARY_PERSONALITY);
    expect(saved.appearance).toBe(SUMMARY_APPEARANCE);
    // 面と根拠は消えていない
    expect(saved.personalityFacets.map((facet) => facet.value)).toEqual(["律儀"]);
    expect(saved.personalityFacets[0].chapters).toEqual([2]);
    const appearanceChanges = saved.changes.filter((change) => change.field === "appearance");
    expect(appearanceChanges.map((change) => change.value)).toEqual(["日焼けした大男"]);
    expect(appearanceChanges[0].chapters).toEqual([2]);
    // まとめていない欄は抽出の値のまま。作者が確定させた記録にはしない
    expect(saved.role).toBe("漁師");
    expect(saved.autoGenerated).toBe(true);
    // まとめの貯め場所も、抽出の貯め場所と一緒に消える
    expect(fs.existsSync(extractEnrichStashFileOf(folder))).toBe(false);
    expect(fs.existsSync(extractStashFileOf(folder))).toBe(false);
  });

  it("まとめの無い新規レコードは今までどおり", () => {
    const folder = makeWork();
    stashBoth(folder);
    stashSummary(folder, "岩男", enrichAnswer({ personality: SUMMARY_PERSONALITY }));

    const result = extractCommit({ folder });

    const light = savedCharacter(folder, "灯");
    expect(light.summary).toBe("毎晩、灯台に火をともす娘");
    expect(result.created.character.sort()).toEqual(["岩男", "灯"].sort());
  });

  it("検算で落ちたまとめ（無い話の引用・「不明」）は入らず、元の値のまま", () => {
    const folder = makeWork();
    stashBoth(folder);

    const validated = stashSummary(
      folder,
      "岩男",
      enrichAnswer({
        personality: "第17話で仲間を見捨てた冷酷な男",
        appearance: "不明",
      })
    ) as { stashed?: boolean; dropped: { unknownCitations: unknown[] } };
    expect(validated.stashed).toBe(false);
    expect(validated.dropped.unknownCitations).toHaveLength(1);
    expect(readExtractEnrichStash(folder)).toEqual([]);

    extractCommit({ folder });
    const saved = savedCharacter(folder, "岩男");
    expect(saved.personality).toBe("律儀");
    expect(saved.appearance).toBe("日焼けした大男");
  });

  it("一部の欄だけ落ちたら、通った欄だけを貯める", () => {
    const folder = makeWork();
    stashBoth(folder);

    stashSummary(
      folder,
      "岩男",
      enrichAnswer({
        personality: SUMMARY_PERSONALITY,
        appearance: "第17話で負った傷のある顔",
      })
    );

    extractCommit({ folder });
    const saved = savedCharacter(folder, "岩男");
    expect(saved.personality).toBe(SUMMARY_PERSONALITY);
    expect(saved.appearance).toBe("日焼けした大男");
  });

  it("まとめたあとで抽出の貯めが変わったら、古いまとめは入れずに理由を返す", () => {
    const folder = makeWork();
    stashBoth(folder);
    stashSummary(folder, "岩男", enrichAnswer({ personality: SUMMARY_PERSONALITY }));
    // 第2話を読み直して、岩男の記録が変わった
    stashAnswer(folder, EPISODE_2, {
      characters: [{ ...ANSWER_2.characters[0], role: "港町の漁師" }],
    });

    const result = extractCommit({ folder });

    expect(result.summaries.applied).toEqual([]);
    expect(result.summaries.skipped).toHaveLength(1);
    expect(result.summaries.skipped[0].name).toBe("岩男");
    expect(result.summaries.skipped[0].reason).toMatch(/変わり/);
    expect(savedCharacter(folder, "岩男").personality).toBe("律儀");
  });

  it("既存の記録へは効かない（承認待ちの案は抽出の値のまま）", () => {
    const folder = makeWork(true);
    stashBoth(folder);
    stashSummary(folder, "岩男", enrichAnswer({ personality: SUMMARY_PERSONALITY }));

    const result = extractCommit({ folder });

    expect(result.pending.character).toEqual(["灯"]);
    expect(result.summaries.applied.map((item) => item.name)).toEqual(["岩男"]);
    const pendingDir = nodePath.join(folder, ".aiwriter", "pending-characters");
    const payload = fs.readFileSync(
      nodePath.join(pendingDir, `${FIRST_CHARACTER_ID}.json`),
      "utf8"
    );
    expect(payload).not.toContain(SUMMARY_PERSONALITY);
  });
});

describe("dryRun の材料", () => {
  it("新規レコードの材料（各欄・面・根拠）を返し、names・offset・limit で絞れる", () => {
    const folder = makeWork();
    stashBoth(folder);

    const all = extractCommit({ folder, dryRun: true });
    // 材料は新しい人物だけ（灯・岩男。新しい場所「灯台」は入らない）
    expect(all.materials?.total).toBe(2);
    expect(all.createdCount).toBe(3);
    const iwao = all.materials?.items.find((item) => item.name === "岩男");
    expect(iwao?.kind).toBe("character");
    expect(iwao?.fields.personality).toBe("律儀");
    expect(iwao?.fields.appearance).toBe("日焼けした大男");
    expect(iwao?.personalityFacets?.map((facet) => facet.value)).toEqual(["律儀"]);
    expect(iwao?.changes.some((change) => change.field === "appearance")).toBe(true);
    expect(iwao?.summarized).toBeNull();

    const named = extractCommit({ folder, dryRun: true, names: ["岩男"] });
    expect(named.materials?.total).toBe(1);
    expect(named.materials?.items.map((item) => item.name)).toEqual(["岩男"]);
    // 絞っても、保存の内訳は全体のまま
    expect(named.createdCount).toBe(all.createdCount);

    const first = extractCommit({ folder, dryRun: true, offset: 0, limit: 1 });
    expect(first.materials?.items).toHaveLength(1);
    expect(first.materials?.items[0].name).toBe(all.materials?.items[0].name);
    expect(first.materials?.nextOffset).toBe(1);

    const rest = extractCommit({ folder, dryRun: true, offset: 1, limit: 5 });
    expect(rest.materials?.items.map((item) => item.name)).toEqual([
      all.materials?.items[1].name,
    ]);
    expect(rest.materials?.nextOffset).toBeNull();
  });

  it("貯めたまとめは、材料に「入る値」として出る（何も書かない）", () => {
    const folder = makeWork();
    stashBoth(folder);
    stashSummary(folder, "岩男", enrichAnswer({ personality: SUMMARY_PERSONALITY }));

    const result = extractCommit({ folder, dryRun: true, names: ["岩男"] });

    expect(result.materials?.items[0].summarized).toEqual({
      personality: SUMMARY_PERSONALITY,
    });
    expect(result.summaries.applied.map((item) => item.name)).toEqual(["岩男"]);
    expect(fs.existsSync(nodePath.join(folder, "設定"))).toBe(false);
    expect(readExtractEnrichStash(folder)).toHaveLength(1);
  });
});
