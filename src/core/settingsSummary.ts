import type { Character } from "../models/character";
import type { Ability, AbilitySystem } from "../models/ability";
import type { Location } from "../models/location";
import { formatChapters } from "./settingsMarkdown";

/**
 * 1件分の設定を、人が読める短い文章にする。
 *
 * AIへ「現在の設定」として渡す用途。JSONをそのまま渡すと
 * 空の項目やid・ハッシュのような内部事情まで読ませることになり、
 * 肝心の内容が埋もれる。値の入っている項目だけを並べる。
 */

export type SettingsKind = "character" | "ability" | "location";

export const KIND_LABELS: Record<SettingsKind, string> = {
  character: "登場人物",
  ability: "能力",
  location: "場所",
};

export function describeCharacter(character: Character): string {
  const lines: string[] = [`名前: ${character.name}`];
  push(lines, "別名", character.aliases.join("、"));
  push(lines, "読み", character.reading);
  push(lines, "役割", character.role);
  push(lines, "性格", character.personality);
  push(lines, "外見", character.appearance);
  push(lines, "一人称", character.firstPerson.default);

  if (character.firstPerson.variants.length > 0) {
    push(
      lines,
      "一人称の使い分け",
      character.firstPerson.variants
        .map((v) => `${v.form}（${v.context ?? "場面不明"}）`)
        .join("、")
    );
  }
  if (character.relations.length > 0) {
    push(
      lines,
      "関係",
      character.relations.map((r) => `${r.name}=${r.relation}`).join("、")
    );
  }
  if (character.abilities.length > 0) {
    push(
      lines,
      "能力",
      character.abilities.map((a) => `${a.name}（${a.mastery}）`).join("、")
    );
  }
  if (character.addressTerms.length > 0) {
    push(
      lines,
      "呼称",
      character.addressTerms
        .map(
          (term) =>
            `${term.targetName}を「${term.forms
              .map((form) => form.term)
              .join("」「")}」`
        )
        .join("、")
    );
  }
  push(lines, "登場話", formatChapters(character.appearedChapters));
  push(lines, "作者メモ", character.authorNotes);
  return lines.join("\n");
}

export function describeAbility(
  ability: Ability,
  system?: AbilitySystem
): string {
  const lines: string[] = [`名前: ${ability.name}`];
  push(lines, "別名", ability.aliases.join("、"));
  push(lines, "読み", ability.reading);
  push(lines, "分類", ability.category);
  push(lines, "説明", ability.description);
  push(lines, "代償", ability.cost);
  push(lines, "制約", ability.limitation);
  push(lines, "使い手", ability.userNames.join("、"));
  push(lines, "登場話", formatChapters(ability.appearedChapters));
  push(lines, "作者メモ", ability.authorNotes);
  if (system) {
    push(lines, "この作品での総称", system.abilityTerm);
    if (system.rules.length > 0) {
      push(lines, "体系の規則", system.rules.join(" / "));
    }
  }
  return lines.join("\n");
}

export function describeLocation(location: Location): string {
  const lines: string[] = [`名前: ${location.name}`];
  push(lines, "別名", location.aliases.join("、"));
  push(lines, "読み", location.reading);
  push(lines, "地域", location.region);
  push(lines, "説明", location.description);
  push(lines, "登場話", formatChapters(location.appearedChapters));
  push(lines, "作者メモ", location.authorNotes);
  return lines.join("\n");
}

function push(lines: string[], label: string, value: string | null): void {
  // 空の項目を「なし」と書くと、AIがそれを事実として扱いかねない
  if (!value || !value.trim()) return;
  lines.push(`${label}: ${value.trim()}`);
}
