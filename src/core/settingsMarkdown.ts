import type { Ability, AbilitySystem } from "../models/ability";
import type { Location } from "../models/location";
import type { Character } from "../models/character";

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
      `- **要確認（${conflict.field}）**: ${conflict.values.join(" / ")}`
    );
  }
  lines.push("");
  return lines;
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
          `- **要確認（${conflict.field}）**: ${conflict.values.join(" / ")}`
        );
      }
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

  for (const character of named) {
    lines.push(...describeCharacter(character));
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

function describeCharacter(character: Character): string[] {
  const lines: string[] = [];
  const reading = character.reading ? `（${character.reading}）` : "";
  lines.push(`## ${character.name}${reading}`, "");

  if (character.aliases.length > 0) {
    lines.push(`- **別名**: ${character.aliases.join("、")}`);
  }
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
      `- **要確認（${conflict.field}）**: ${conflict.values.join(" / ")}`
    );
  }
  lines.push("");
  return lines;
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
