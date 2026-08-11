import type { Ability, AbilitySystem } from "../models/ability";
import type { Location } from "../models/location";
import type { Character } from "../models/character";
import type { AiNote } from "../models/aiNote";
import type { CustomFieldDefinition } from "../models/customField";
import { membersOf, type Organization } from "../models/organization";
import type { RecordConflict } from "../models/jsonValidation";
import {
  WORLD_CATEGORIES,
  WORLD_CATEGORY_LABELS,
  type WorldItem,
} from "../models/world";

/**
 * 設定資料としてそのまま渡せるMarkdownを組み立てる。
 *
 * 生成のたびにファイル全体を書き直すため、
 * 作者が手を入れる前提の文書ではない。
 * 手を入れたい記述は各JSONの authorNotes / exportNote に書く。
 */

export interface SettingsMarkdownOptions {
  /** 作品名。見出しに使う */
  workTitle: string;
  /** 公開範囲。指定した水準までを出力する */
  spoilerLevel?: "public" | "staff_only" | "author_only";
  /** 作者が足した項目の定義。人物一覧でのみ使う */
  customFields?: CustomFieldDefinition[];
}

const SPOILER_ORDER: Record<string, number> = {
  public: 0,
  staff_only: 1,
  author_only: 2,
};

/** 指定した公開範囲に含めてよいか */
function isVisible(
  level: string,
  limit: SettingsMarkdownOptions["spoilerLevel"]
): boolean {
  const max = SPOILER_ORDER[limit ?? "author_only"] ?? 2;
  return (SPOILER_ORDER[level] ?? 0) <= max;
}

/**
 * 能力一覧。
 *
 * 総称は作品側の呼称を使う。現代ものを書いているのに
 * 「魔法一覧」と表示されるのを避けるため。
 */
export function buildAbilityMarkdown(
  abilities: Ability[],
  system: AbilitySystem,
  options: SettingsMarkdownOptions
): string {
  const visible = abilities.filter((ability) =>
    isVisible(ability.spoilerLevel, options.spoilerLevel)
  );
  const term = system.abilityTerm || "能力";
  const lines: string[] = [`# ${options.workTitle} ${term}一覧`, ""];

  if (system.description) {
    lines.push(system.description, "");
  }
  if (system.rules.length > 0) {
    lines.push(`## ${term}の規則`, "");
    for (const rule of system.rules) lines.push(`- ${rule}`);
    lines.push("");
  }
  if (system.authorNotes.trim()) {
    lines.push("## 作者メモ", "", system.authorNotes.trim(), "");
  }

  if (visible.length === 0) {
    lines.push(`まだ${term}が登録されていません。`, "");
    return lines.join("\n");
  }

  for (const [category, items] of groupByCategory(visible)) {
    lines.push(`## ${category}`, "");
    for (const ability of items) {
      lines.push(...describeAbility(ability, term));
    }
  }

  return lines.join("\n");
}

function describeAbility(ability: Ability, term: string): string[] {
  const lines: string[] = [];
  const reading = ability.reading ? `（${ability.reading}）` : "";
  lines.push(`### ${ability.name}${reading}`, "");

  if (ability.summary) {
    lines.push(ability.summary, "");
  }

  if (ability.aliases.length > 0) {
    lines.push(`- **別名**: ${ability.aliases.join("、")}`);
  }
  if (ability.description) lines.push(`- **効果**: ${ability.description}`);
  if (ability.cost) lines.push(`- **代償**: ${ability.cost}`);
  if (ability.limitation) lines.push(`- **制約**: ${ability.limitation}`);
  if (ability.userNames.length > 0) {
    lines.push(`- **使い手**: ${ability.userNames.join("、")}`);
  }
  if (ability.appearedChapters.length > 0) {
    lines.push(`- **登場話**: ${formatChapters(ability.appearedChapters)}`);
  }
  if (ability.status === "未登場") {
    lines.push("- **状態**: 未登場（設定のみ）");
  }
  if (ability.exportNote.trim()) {
    lines.push(`- **補足**: ${ability.exportNote.trim()}`);
  }
  // 作者の判断待ちを資料に残す。黙って片方だけ載せない
  for (const conflict of ability.conflicts) {
    lines.push(
      `- **変化かもしれない（${conflict.field}）**: ${describeConflictValues(conflict)}`
    );
  }
  lines.push(...aiNoteLines(ability.aiNotes));
  lines.push("");
  return lines;
}

/**
 * 承認済みの掘り下げメモ。
 *
 * 引用形式にして、抽出した事実と見た目で区別する。
 * 掘り下げは本文からの解釈であり、根拠の逐語照合ができない。
 * 事実と同じ体裁で並べると、作者が読み返したときに
 * どこまでが本文に書いてあることなのか分からなくなる。
 */
function aiNoteLines(notes: AiNote[]): string[] {
  if (notes.length === 0) return [];

  const lines: string[] = ["", "**AIによる掘り下げ**（作者が承認したもの。本文からの解釈を含みます）", ""];
  for (const note of notes) {
    const label = [note.topic || "全体", note.model].filter((p) => p).join(" / ");
    lines.push(`> _${label}_`, ">");
    for (const line of note.text.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * 組織一覧。上位組織ごとにまとめる。
 *
 * 所属する人物も出す。人物一覧は所属で章を分けているので、
 * 組織側からも辿れるようにすると、どちらから読んでも繋がる。
 */
export function buildOrganizationMarkdown(
  organizations: Organization[],
  characters: Array<{ name: string; affiliation: string | null }>,
  options: SettingsMarkdownOptions
): string {
  const visible = organizations.filter((organization) =>
    isVisible(organization.spoilerLevel, options.spoilerLevel)
  );
  const lines: string[] = [`# ${options.workTitle} 組織一覧`, ""];

  if (visible.length === 0) {
    lines.push("まだ組織が登録されていません。", "");
    return lines.join("\n");
  }

  for (const [parent, items] of groupByParent(visible)) {
    lines.push(`## ${parent}`, "");
    for (const organization of items) {
      const reading = organization.reading ? `（${organization.reading}）` : "";
      lines.push(`### ${organization.name}${reading}`, "");
      if (organization.summary) {
        lines.push(organization.summary, "");
      }
      if (organization.aliases.length > 0) {
        lines.push(`- **別名**: ${organization.aliases.join("、")}`);
      }
      if (organization.category) {
        lines.push(`- **種別**: ${organization.category}`);
      }
      if (organization.description) {
        lines.push(`- **説明**: ${organization.description}`);
      }
      const members = membersOf(organization, characters);
      if (members.length > 0) {
        lines.push(`- **所属する人物**: ${members.join("、")}`);
      }
      if (organization.appearedChapters.length > 0) {
        lines.push(
          `- **登場話**: ${formatChapters(organization.appearedChapters)}`
        );
      }
      if (organization.status === "未登場") {
        lines.push("- **状態**: 未登場（設定のみ）");
      }
      if (organization.exportNote.trim()) {
        lines.push(`- **補足**: ${organization.exportNote.trim()}`);
      }
      for (const conflict of organization.conflicts) {
        lines.push(
          `- **変化かもしれない（${conflict.field}）**: ${describeConflictValues(conflict)}`
        );
      }
      lines.push(...aiNoteLines(organization.aiNotes));
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * 上位組織ごとに分ける。
 * 上位が読み取れなかった組織は末尾へまとめ、
 * 「上位組織なし」という架空の組織があるように見せない。
 */
function groupByParent(
  organizations: Organization[]
): Map<string, Organization[]> {
  const groups = new Map<string, Organization[]>();
  const others: Organization[] = [];

  for (const organization of organizations) {
    const parent = organization.parent?.trim();
    if (!parent) {
      others.push(organization);
      continue;
    }
    const list = groups.get(parent) ?? [];
    list.push(organization);
    groups.set(parent, list);
  }

  if (others.length > 0) groups.set("上位組織の記載なし", others);
  return groups;
}

/**
 * 世界観一覧。分類ごとにまとめる。
 *
 * 並びは `WORLD_CATEGORIES` の順に固定する。名前順や件数順にすると、
 * 抽出のたびに節の位置が入れ替わり、作者が場所を覚えられない。
 * 該当が1件も無い分類の見出しは出さない。
 */
export function buildWorldMarkdown(
  items: WorldItem[],
  options: SettingsMarkdownOptions
): string {
  const visible = items.filter((item) =>
    isVisible(item.spoilerLevel, options.spoilerLevel)
  );
  const lines: string[] = [`# ${options.workTitle} 世界観`, ""];

  if (visible.length === 0) {
    lines.push("まだ世界観が登録されていません。", "");
    return lines.join("\n");
  }

  for (const category of WORLD_CATEGORIES) {
    const group = visible.filter((item) => item.category === category);
    if (group.length === 0) continue;

    lines.push(`## ${WORLD_CATEGORY_LABELS[category]}`, "");
    for (const item of group) {
      lines.push(`### ${item.name}`, "");
      if (item.description) {
        lines.push(item.description, "");
      }
      if (item.aliases.length > 0) {
        lines.push(`- **別の言い方**: ${item.aliases.join("、")}`);
      }
      if (item.appearedChapters.length > 0) {
        lines.push(`- **登場話**: ${formatChapters(item.appearedChapters)}`);
      }
      if (item.exportNote.trim()) {
        lines.push(`- **補足**: ${item.exportNote.trim()}`);
      }
      for (const conflict of item.conflicts) {
        lines.push(
          `- **変化かもしれない（${conflict.field}）**: ${describeConflictValues(conflict)}`
        );
      }
      lines.push(...aiNoteLines(item.aiNotes));
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** 場所一覧。地域ごとにまとめる */
export function buildLocationMarkdown(
  locations: Location[],
  options: SettingsMarkdownOptions
): string {
  const visible = locations.filter((location) =>
    isVisible(location.spoilerLevel, options.spoilerLevel)
  );
  const lines: string[] = [`# ${options.workTitle} 場所一覧`, ""];

  if (visible.length === 0) {
    lines.push("まだ場所が登録されていません。", "");
    return lines.join("\n");
  }

  for (const [region, items] of groupByRegion(visible)) {
    lines.push(`## ${region}`, "");
    for (const location of items) {
      const reading = location.reading ? `（${location.reading}）` : "";
      lines.push(`### ${location.name}${reading}`, "");
      if (location.summary) {
        lines.push(location.summary, "");
      }
      if (location.aliases.length > 0) {
        lines.push(`- **別名**: ${location.aliases.join("、")}`);
      }
      if (location.description) {
        lines.push(`- **説明**: ${location.description}`);
      }
      if (location.appearedChapters.length > 0) {
        lines.push(`- **登場話**: ${formatChapters(location.appearedChapters)}`);
      }
      if (location.status === "未登場") {
        lines.push("- **状態**: 未登場（設定のみ）");
      }
      if (location.exportNote.trim()) {
        lines.push(`- **補足**: ${location.exportNote.trim()}`);
      }
      for (const conflict of location.conflicts) {
        lines.push(
          `- **変化かもしれない（${conflict.field}）**: ${describeConflictValues(conflict)}`
        );
      }
      lines.push(...aiNoteLines(location.aiNotes));
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * 登場人物一覧。
 * モブは末尾へまとめ、ネームドキャラを探す妨げにしない。
 */
export function buildCharacterMarkdown(
  characters: Character[],
  options: SettingsMarkdownOptions
): string {
  const visible = characters.filter((character) =>
    isVisible(character.spoilerLevel, options.spoilerLevel)
  );
  const named = visible.filter((character) => !character.isMob);
  const mobs = visible.filter((character) => character.isMob);

  const lines: string[] = [`# ${options.workTitle} 登場人物一覧`, ""];

  if (visible.length === 0) {
    lines.push("まだ登場人物が登録されていません。", "");
    return lines.join("\n");
  }

  // 所属ごとにまとめる。人数が増えると、名前だけ並んでいても
  // 誰がどの立場なのか掴めなくなるため
  for (const [affiliation, members] of groupByAffiliation(named)) {
    lines.push(`## ${affiliation}`, "");
    for (const character of members) {
      lines.push(...describeCharacter(character, options.customFields ?? []));
    }
  }

  if (mobs.length > 0) {
    lines.push("## モブ・集団", "");
    for (const character of mobs) {
      const chapters =
        character.appearedChapters.length > 0
          ? `（${formatChapters(character.appearedChapters)}）`
          : "";
      lines.push(`- ${character.name}${chapters}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 所属ごとに分ける。
 * 所属が読み取れなかった人物は末尾へまとめ、
 * 「所属不明」という架空の組織があるように見せない。
 */
function groupByAffiliation(characters: Character[]): Map<string, Character[]> {
  const groups = new Map<string, Character[]>();
  const others: Character[] = [];

  for (const character of characters) {
    const affiliation = character.affiliation?.trim();
    if (!affiliation) {
      others.push(character);
      continue;
    }
    const list = groups.get(affiliation) ?? [];
    list.push(character);
    groups.set(affiliation, list);
  }

  if (others.length > 0) groups.set("所属の記載なし", others);
  return groups;
}

function describeCharacter(
  character: Character,
  customFields: CustomFieldDefinition[]
): string[] {
  const lines: string[] = [];
  const reading = character.reading ? `（${character.reading}）` : "";
  lines.push(`### ${character.name}${reading}`, "");

  // 一目で誰なのか分かる1行を先頭に置く
  if (character.summary) {
    lines.push(character.summary, "");
  }

  if (character.aliases.length > 0) {
    lines.push(`- **別名**: ${character.aliases.join("、")}`);
  }
  if (character.gender) lines.push(`- **性別**: ${character.gender}`);
  if (character.role) lines.push(`- **役割**: ${character.role}`);
  if (character.personality) lines.push(`- **性格**: ${character.personality}`);
  if (character.appearance) lines.push(`- **外見**: ${character.appearance}`);
  if (character.firstPerson.default) {
    const variants = character.firstPerson.variants
      .map((variant) =>
        variant.context ? `${variant.form}（${variant.context}）` : variant.form
      )
      .join("、");
    lines.push(
      `- **一人称**: ${character.firstPerson.default}` +
        (variants ? `／${variants}` : "")
    );
  }
  if (character.defaultSecondPerson) {
    lines.push(`- **二人称**: ${character.defaultSecondPerson}`);
  }

  // 呼び分けは作品の要。相手ごとにまとめて残す
  for (const term of character.addressTerms) {
    const forms = term.forms
      .map((form) => {
        const period = formatPeriod(form.firstChapter, form.lastChapter);
        const context = form.context ? `／${form.context}` : "";
        const past = form.status === "past" ? "（現在は使われない）" : "";
        return `${form.term}${period}${context}${past}`;
      })
      .join("、");
    if (forms) {
      lines.push(`- **${term.targetName}への呼称**: ${forms}`);
    }
  }

  if (character.abilities.length > 0) {
    const abilities = character.abilities
      .map((ability) =>
        ability.mastery === "習得済み"
          ? ability.name
          : `${ability.name}（${ability.mastery}）`
      )
      .join("、");
    lines.push(`- **能力**: ${abilities}`);
  }
  if (character.relations.length > 0) {
    const relations = character.relations
      .map((relation) => `${relation.name}（${relation.relation}）`)
      .join("、");
    lines.push(`- **関係**: ${relations}`);
  }
  // 作者が足した項目。定義された順に並べ、値の無い人物では出さない
  for (const field of customFields) {
    const value = character.customFields[field.key]?.trim();
    if (value) lines.push(`- **${field.label}**: ${value}`);
  }

  if (character.appearedChapters.length > 0) {
    lines.push(`- **登場話**: ${formatChapters(character.appearedChapters)}`);
  }
  if (character.status === "未登場") {
    lines.push("- **状態**: 未登場（設定のみ）");
  }
  if (character.exportNote.trim()) {
    lines.push(`- **補足**: ${character.exportNote.trim()}`);
  }
  for (const conflict of character.conflicts) {
    lines.push(
      `- **変化かもしれない（${conflict.field}）**: ${describeConflictValues(conflict)}`
    );
  }
  lines.push(...aiNoteLines(character.aiNotes));
  lines.push("");
  return lines;
}

/**
 * 食い違いを「作中での変化」として読める形にする。
 *
 * **小説では登場人物が作中で変わる。** 髪を切る、立場が変わる、口調が変わる。
 * 値が2つ並んでいるだけでは、AIの取り違えなのか作中での変化なのか
 * 読み分けられない。**話数と並べれば読み分けられる**（作者の指摘、2026-08-11）。
 *
 *   黒髪（それ以前）→ 銀髪（第7話）
 *
 * 話数の無い値を「それ以前」と書くのは、
 * 食い違いに気づく前から入っていた値で、どの話で書かれたかの記録が無いためである。
 * 推測で埋めると、書いていない話まで含んだ表示になってしまう。
 */
export function describeConflictValues(conflict: RecordConflict): string {
  const observations = conflict.observations;
  if (!observations || observations.length === 0) {
    // 古いデータには値ごとの話数が無い。これまでどおり値だけを並べる
    return conflict.values.join(" / ");
  }
  return [...observations]
    .sort((a, b) => firstChapter(a.chapters) - firstChapter(b.chapters))
    .map((item) => {
      const chapters =
        item.chapters.length > 0 ? formatChapters(item.chapters) : "それ以前";
      return `${item.value}（${chapters}）`;
    })
    // 全角の閉じ括弧が右に余白を持つので、矢印の前に空白は入れない
    .join("→ ");
}

/** 並べ替え用。話数が無いものは、気づく前からあった値なので先に置く */
function firstChapter(chapters: number[]): number {
  return chapters.length > 0 ? Math.min(...chapters) : -1;
}

/** 連番は範囲にまとめる。「1, 2, 3, 7」→「1〜3, 7」 */
export function formatChapters(chapters: number[]): string {
  const sorted = [...new Set(chapters)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";

  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (const chapter of sorted.slice(1)) {
    if (chapter === previous + 1) {
      previous = chapter;
      continue;
    }
    parts.push(formatRange(start, previous));
    start = chapter;
    previous = chapter;
  }
  parts.push(formatRange(start, previous));
  return `第${parts.join("、")}話`;
}

function formatRange(start: number, end: number): string {
  if (start === end) return String(start);
  // 2話だけの連続を「1〜2」と書くより「1、2」の方が読みやすい
  if (end - start === 1) return `${start}、${end}`;
  return `${start}〜${end}`;
}

function formatPeriod(
  firstChapter: number | null,
  lastChapter: number | null
): string {
  if (firstChapter === null && lastChapter === null) return "";
  if (firstChapter !== null && lastChapter === null) {
    return `（第${firstChapter}話〜）`;
  }
  if (firstChapter === null) return `（〜第${lastChapter}話）`;
  if (firstChapter === lastChapter) return `（第${firstChapter}話）`;
  return `（第${firstChapter}〜${lastChapter}話）`;
}

function groupByCategory(abilities: Ability[]): Array<[string, Ability[]]> {
  const groups = new Map<string, Ability[]>();
  for (const ability of abilities) {
    const key = ability.category?.trim() || "分類なし";
    const list = groups.get(key) ?? [];
    list.push(ability);
    groups.set(key, list);
  }
  return sortGroups(groups, "分類なし");
}

function groupByRegion(locations: Location[]): Array<[string, Location[]]> {
  const groups = new Map<string, Location[]>();
  for (const location of locations) {
    const key = location.region?.trim() || "地域未設定";
    const list = groups.get(key) ?? [];
    list.push(location);
    groups.set(key, list);
  }
  return sortGroups(groups, "地域未設定");
}

/** 分類済みを先に、未分類を末尾へ置く */
function sortGroups<T>(
  groups: Map<string, T[]>,
  fallbackKey: string
): Array<[string, T[]]> {
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === fallbackKey) return 1;
    if (b === fallbackKey) return -1;
    return a.localeCompare(b, "ja");
  });
}
