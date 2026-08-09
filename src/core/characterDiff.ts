import type { Character } from "../models/character";
import type { CustomFieldDefinition } from "../models/customField";

/**
 * 既存の人物設定と、抽出で作られた更新案の差分をまとめる。
 *
 * 作者に「何が変わるのか」を見せてから反映するための材料。
 * JSONを並べて見比べさせるのは酷なので、変わる項目だけを日本語で示す。
 */

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

export interface CharacterDiff {
  id: string;
  name: string;
  changes: FieldChange[];
}

/** 表示名と、値の取り出し方 */
const TEXT_FIELDS: Array<{
  label: string;
  read: (character: Character) => string;
}> = [
  { label: "名前", read: (c) => c.name },
  { label: "紹介", read: (c) => c.summary ?? "" },
  { label: "性別", read: (c) => c.gender ?? "" },
  { label: "所属", read: (c) => c.affiliation ?? "" },
  { label: "読み", read: (c) => c.reading ?? "" },
  { label: "別名", read: (c) => c.aliases.join("、") },
  { label: "役割", read: (c) => c.role ?? "" },
  { label: "性格", read: (c) => c.personality ?? "" },
  { label: "外見", read: (c) => c.appearance ?? "" },
  { label: "一人称", read: (c) => c.firstPerson.default ?? "" },
  {
    label: "関係",
    read: (c) => c.relations.map((r) => `${r.name}=${r.relation}`).join("、"),
  },
  {
    label: "能力",
    read: (c) => c.abilities.map((a) => a.name).join("、"),
  },
  {
    label: "登場話",
    read: (c) => c.appearedChapters.join("、"),
  },
  {
    label: "呼称",
    read: (c) =>
      c.addressTerms
        .map(
          (term) =>
            `${term.targetName}→${term.forms.map((f) => f.term).join("・")}`
        )
        .join("、"),
  },
  // モブ扱いになると一覧の下へ回り、用語ハイライトとIME辞書からも外れる。
  // 反映すると見え方が変わるので、黙って適用せず差分に出す
  {
    label: "モブ扱い",
    read: (c) => (c.isMob ? "はい" : "いいえ"),
  },
];

export function diffCharacter(
  before: Character,
  after: Character,
  customFields: CustomFieldDefinition[] = []
): CharacterDiff {
  const changes: FieldChange[] = [];

  for (const field of TEXT_FIELDS) {
    const left = field.read(before);
    const right = field.read(after);
    if (left === right) continue;
    changes.push({ label: field.label, before: left, after: right });
  }

  changes.push(...customFieldChanges(before, after, customFields));

  // 作者メモと資料用の補足は、そもそも抽出で書き換えない約束になっている。
  // 万一変化していたら見逃せないので必ず出す。
  for (const field of [
    { label: "作者メモ", read: (c: Character) => c.authorNotes },
    { label: "資料用の補足", read: (c: Character) => c.exportNote },
  ]) {
    const left = field.read(before);
    const right = field.read(after);
    if (left !== right) {
      changes.push({ label: field.label, before: left, after: right });
    }
  }

  return { id: after.id, name: after.name, changes };
}

/**
 * 作者が足した項目の変化。
 *
 * 定義に無いキーも見る。作者が項目を消したあとも値は残るので、
 * そこが書き換わったのに差分に出ないと、気付けない変更になる。
 * 見出しは定義があればその名前、無ければキーをそのまま出す。
 */
function customFieldChanges(
  before: Character,
  after: Character,
  definitions: CustomFieldDefinition[]
): FieldChange[] {
  const labels = new Map(definitions.map((field) => [field.key, field.label]));
  const keys = [
    ...definitions.map((field) => field.key),
    ...Object.keys({ ...before.customFields, ...after.customFields }),
  ];

  const changes: FieldChange[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const left = before.customFields[key] ?? "";
    const right = after.customFields[key] ?? "";
    if (left === right) continue;
    changes.push({ label: labels.get(key) ?? key, before: left, after: right });
  }
  return changes;
}

/** 一覧に出す1行の説明。何が増えるのかが分かる粒度にする */
export function summarizeDiff(diff: CharacterDiff): string {
  if (diff.changes.length === 0) return "変更なし";
  return diff.changes
    .map((change) => (change.before ? `${change.label}を変更` : `${change.label}を追加`))
    .join(" / ");
}

/** 差分の詳細。作者が読んで判断できる形にする */
export function formatDiff(diff: CharacterDiff): string {
  const lines = [`## ${diff.name}`, ""];
  if (diff.changes.length === 0) {
    lines.push("変更はありません。", "");
    return lines.join("\n");
  }
  for (const change of diff.changes) {
    lines.push(`### ${change.label}`);
    lines.push(`- 現在: ${change.before || "（未設定）"}`);
    lines.push(`- 更新案: ${change.after || "（未設定）"}`);
    lines.push("");
  }
  return lines.join("\n");
}
