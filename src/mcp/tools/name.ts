import { z } from "zod";
import {
  NAME_ORIGINS,
  NAME_SUGGEST_COUNT,
  NAME_SUGGEST_SYSTEM_PROMPT,
  NAME_SUGGEST_TEMPERATURE,
  NAME_SUGGEST_VERSION,
  buildNameSuggestPrompt,
  buildNameSuggestSchema,
  parseNameSuggestAnswer,
  type NameOrigin,
} from "../../prompts/nameSuggest";
import { fitNameCandidates, planNameOrigin } from "../../core/nameOriginFit";
import { parseCharacter } from "../../models/character";
import { parseAbility } from "../../models/ability";
import { parseLocation } from "../../models/location";
import { parseOrganization } from "../../models/organization";
import {
  buildNameEntries,
  findNameCollisions,
  screenNameCandidates,
} from "../../core/nameCollision";
import { isBlankPlotSection, parsePlotMarkdown } from "../../core/plotDoc";
import {
  McpToolError,
  SETTINGS_SUBDIRS,
  readPlotMarkdown,
  readSettingsRecords,
  workTitleOf,
} from "./shared";
import {
  runOnce,
  validateWith,
  type RunnerInput,
} from "./run";

/**
 * 響きが重ならない名前の候補（P-29。設計書6.37）を外から呼ぶ（0.66.0）。
 *
 * **本文を送らない機能である。** 送るのは既にある名前の一覧と、
 * プロットの世界観・舞台の節だけ——だから `runner` がどれでも、
 * 原稿そのものは外へ出ない。**それでも `runner` は省略させない**
 * （6.87.8 の5。名前と世界観も作品の中身である）。
 *
 * **判定はAIの仕事ではない。** どの候補が既存の名前と衝突するかは
 * `screenNameCandidates`（読みと表記の規則だけ）が決める——**AIには
 * 案を出させるだけ**で、通すかどうかはコードが決める（規則3）。
 */

const VALIDATE_WITH = validateWith("name");

/**
 * 名前の系統。**形の定義はここ1か所。**
 *
 * 束ねた道具（`features.ts`）は `options.origin` を `z.unknown()` で
 * 受けるので、奥へ入れる前にこの形で確かめ直す。
 */
export const NAME_ORIGIN_SCHEMA = z.enum(
  NAME_ORIGINS as unknown as [string, ...string[]]
);

export interface NamePromptInput {
  folder: string;
  characterName: string;
  origin?: string;
}

/** 資料をぜんぶ読んで、名前の一覧にする（人物・能力・場所・組織） */
function readNameEntries(folder: string) {
  return buildNameEntries({
    characters: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.characters,
      parseCharacter
    ).records,
    abilities: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.abilities,
      parseAbility
    ).records,
    locations: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.locations,
      parseLocation
    ).records,
    organizations: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.organizations,
      parseOrganization
    ).records,
  });
}

/**
 * 世界観と舞台の節。
 *
 * **名前の系統は、世界の作りから決まる。** ここが空だと、和風の作品に
 * 西洋風の名前が並ぶことがある（`features/nameCheck.ts` と同じ材料）。
 */
function readSetting(folder: string): string {
  const plot = readPlotMarkdown(folder);
  if (!plot) return "";
  const sections = parsePlotMarkdown(plot).sections;
  return [sections.worldview, sections.setting]
    .filter((body) => body && !isBlankPlotSection(body))
    .map((body) => body.trim())
    .join("\n");
}

/**
 * 系統の決め方。**製品と同じ材料**（人物の名前だけ・付け替える本人を除く・
 * 世界観の節）で決める——`prompt` と `validate` が別々に呼ばれても、同じ
 * 作品なら同じ決め方になる
 */
function originPlan(input: NamePromptInput, entries: ReturnType<typeof readNameEntries>) {
  return planNameOrigin({
    chosen: input.origin as NameOrigin | undefined,
    existingNames: entries
      .filter((entry) => entry.kind === "character" && entry.name !== input.characterName)
      .map((entry) => entry.name),
    setting: readSetting(input.folder),
  });
}

export function namePrompt(input: NamePromptInput) {
  const entries = readNameEntries(input.folder);
  const target = entries.find(
    (entry) => entry.kind === "character" && entry.name === input.characterName
  );
  if (!target) {
    throw new McpToolError(
      `「${input.characterName}」という人物が設定資料に見つかりません` +
        `（居るのは ${entries
          .filter((entry) => entry.kind === "character")
          .map((entry) => entry.name)
          .slice(0, 10)
          .join("・")} などです）。`
    );
  }

  const character = readSettingsRecords(
    input.folder,
    SETTINGS_SUBDIRS.characters,
    parseCharacter
  ).records.find((record) => record.name === input.characterName);

  const plan = originPlan(input, entries);
  return {
    promptVersion: NAME_SUGGEST_VERSION,
    systemPrompt: NAME_SUGGEST_SYSTEM_PROMPT,
    schema: buildNameSuggestSchema(plan.choices),
    temperature: NAME_SUGGEST_TEMPERATURE,
    /** 系統をどう決めたか。**作者が選んでいなければ、コードが作品に合わせて決めた** */
    originPlan: { choices: plan.choices, basis: plan.basis },
    validateWith: VALIDATE_WITH,
    /** 何件を避ける相手として渡したか。**材料の厚みを返り値に残す** */
    existingCount: entries.length - 1,
    hasSetting: readSetting(input.folder).length > 0,
    userPrompt: buildNameSuggestPrompt({
      workTitle: workTitleOf(input.folder),
      currentName: input.characterName,
      gender: character?.gender ?? "",
      role: character?.role ?? "",
      affiliation: character?.affiliation ?? "",
      // **付け替える本人は「避ける相手」ではない**
      existingNames: entries
        .filter((entry) => entry.id !== target.id)
        .map((entry) =>
          entry.reading ? `${entry.name}（${entry.reading}）` : entry.name
        ),
      setting: readSetting(input.folder),
      plan,
    }),
  };
}

export function nameValidate(input: NamePromptInput & { response: string }) {
  const answer = parseNameSuggestAnswer(input.response);
  if (answer.candidates.length === 0) {
    throw new McpToolError(
      "応答から候補を読み取れませんでした（名前の候補のスキーマに沿っていません）。"
    );
  }

  /*
    **通すかどうかはコードが決める**（CLAUDE.md 規則3）。AIは
    「既にある名前と似ていないか」を当てにできない——`screenNameCandidates`
    が読みと表記の規則だけで弾く。
  */
  const entries = readNameEntries(input.folder);
  const target = entries.find(
    (entry) => entry.kind === "character" && entry.name === input.characterName
  );
  const others = entries.filter((entry) => entry.id !== target?.id);
  // 系統・表記を先に揃え、残ったものの響きを見る（製品の `suggestNames` と同じ順）
  const fitted = fitNameCandidates(answer.candidates, originPlan(input, entries), answer.origin);
  const screened = screenNameCandidates(fitted.kept, others);

  return {
    /** 通った候補。**これが答えである** */
    accepted: screened.kept,
    /** 弾いた候補と、その理由。**黙って減らさない** */
    rejected: [...fitted.dropped, ...screened.dropped],
    /** 揃えた系統 */
    origin: fitted.origin ?? "",
    /** 英字からカタカナに直した名前。**黙って書き換えない** */
    converted: fitted.converted,
    asked: NAME_SUGGEST_COUNT,
    note:
      "通したかどうかはAIではなくコードが決めています" +
      "（系統と表記が作品に揃っているか、読みと表記の規則で既にある名前と衝突しないかを見ました）。" +
      "ここでは何も書き換えていません——付け替えは作者の操作で行います。",
  };
}

export async function nameRun(input: NamePromptInput & RunnerInput) {
  return runOnce(input, namePrompt(input), (response) =>
    nameValidate({ ...input, response })
  );
}

/**
 * いま衝突している名前を、AIを使わずに挙げる（設計書6.37）。
 *
 * **AIが要らない判断は、AIに訊かない。** 読みと表記の規則だけで決まるので、
 * こちらは `prompt`・`validate` を持たない1本の道具にしてある
 * （表記ゆれの `detect` と同じ形。6.87.8）。
 */
export function nameCollisions(input: { folder: string }) {
  const found = findNameCollisions(readNameEntries(input.folder));
  return {
    collisions: found.collisions,
    /** 読みが取れなかったもの。**判定の外に置いたことを隠さない** */
    unreadable: found.unreadable,
    note:
      "判定はAIを使わず、読みと表記の規則だけで行っています。" +
      "何も書き換えていません。",
  };
}
