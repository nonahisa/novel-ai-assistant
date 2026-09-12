import type { Character } from "../models/character";
import type { CustomFieldDefinition } from "../models/customField";

/**
 * 既存の人物設定と、抽出で作られた更新案の差分をまとめる。
 *
 * 作者に「何が変わるのか」を見せてから反映するための材料。
 * JSONを並べて見比べさせるのは酷なので、変わる項目だけを日本語で示す。
 */

/**
 * 更新案の中の、1つだけ落とせる値（作者の依頼、2026-09-12）。
 *
 * 「呼称にハヤブサ先生があり、これが間違いです。この画面でここだけ
 * 消したりできないでしょうか？」——項目ごと文字列へ潰していたので、
 * レコードまるごと見送るか、間違ったまま反映するかの二択になっていた。
 */
export interface DiffEntry {
  /** その値を指す鍵。画面から返ってきたときに引き当てる */
  key: string;
  /** 画面に出す文字列 */
  text: string;
  /** 足される値か、消える値か、そのままか */
  state: "added" | "removed" | "kept";
}

export interface FieldChange {
  label: string;
  before: string;
  after: string;
  /**
   * 1つずつ落とせる値（設計書6.32）。
   *
   * **名前の並ぶ3項目（呼称・関係・別名）だけが持つ。** AIの読み違いが
   * 集まるのがここで、しかも「1つだけ違う」が起きやすい。紹介文のような
   * 地の文は、1つずつに分けようがないので持たない（画面は今までどおり）。
   */
  entries?: DiffEntry[];
}

/**
 * 葉を指す鍵。**作る側と落とす側で同じ関数を使う**——
 * 文字列を組み直すと、区切りの扱いが片方だけずれる。
 */
export function addressEntryKey(targetName: string, term: string): string {
  return `address:${targetName}:${term}`;
}

export function relationEntryKey(name: string, relation: string): string {
  return `relation:${name}:${relation}`;
}

export function aliasEntryKey(alias: string): string {
  return `alias:${alias}`;
}

/** 葉1つ分の素材。`state` は前後を突き合わせてから決める */
interface Leaf {
  key: string;
  text: string;
  /** 作者が固定した呼称か。固定されていれば落とせる葉にしない */
  locked: boolean;
}

function addressLeaves(character: Character): Leaf[] {
  return character.addressTerms.flatMap((term) =>
    term.forms.map((form) => ({
      key: addressEntryKey(term.targetName, form.term),
      text: `${term.targetName}→${form.term}`,
      locked: term.authorLocked,
    }))
  );
}

function relationLeaves(character: Character): Leaf[] {
  return character.relations.map((relation) => ({
    key: relationEntryKey(relation.name, relation.relation),
    text: `${relation.name}=${relation.relation}`,
    locked: false,
  }));
}

function aliasLeaves(character: Character): Leaf[] {
  return character.aliases.map((alias) => ({
    key: aliasEntryKey(alias),
    text: alias,
    locked: false,
  }));
}

/**
 * 葉ごとの変化を並べる。
 *
 * 更新案の側（after）の並びをそのまま出し、消える値を末尾へ添える。
 * **消える値も出す**——落とせるのは追加だけだが、何が消えるのかを
 * 隠すと、作者は一覧を見て「全部入る」と読む。
 */
function diffEntries(
  before: Character,
  after: Character,
  read: (character: Character) => Leaf[]
): DiffEntry[] {
  const beforeLeaves = read(before);
  const beforeKeys = new Set(beforeLeaves.map((leaf) => leaf.key));
  const entries: DiffEntry[] = [];
  const seen = new Set<string>();

  for (const leaf of read(after)) {
    if (seen.has(leaf.key)) continue;
    seen.add(leaf.key);
    entries.push({
      key: leaf.key,
      text: leaf.text,
      // 作者が固定した呼称は、そもそも抽出のマージが触らない（CLAUDE.md 規則2）。
      // 「そのまま」に倒して、落とせる葉から外す
      state: leaf.locked || beforeKeys.has(leaf.key) ? "kept" : "added",
    });
  }
  for (const leaf of beforeLeaves) {
    if (seen.has(leaf.key)) continue;
    seen.add(leaf.key);
    entries.push({ key: leaf.key, text: leaf.text, state: "removed" });
  }
  return entries;
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
  /** 1つずつ落とせる項目だけが持つ（呼称・関係・別名） */
  leaves?: (character: Character) => Leaf[];
}> = [
  { label: "名前", read: (c) => c.name },
  { label: "紹介", read: (c) => c.summary ?? "" },
  { label: "性別", read: (c) => c.gender ?? "" },
  { label: "所属", read: (c) => c.affiliation ?? "" },
  { label: "読み", read: (c) => c.reading ?? "" },
  { label: "別名", read: (c) => c.aliases.join("、"), leaves: aliasLeaves },
  { label: "役割", read: (c) => c.role ?? "" },
  { label: "性格", read: (c) => c.personality ?? "" },
  { label: "外見", read: (c) => c.appearance ?? "" },
  { label: "一人称", read: (c) => c.firstPerson.default ?? "" },
  {
    label: "関係",
    read: (c) => c.relations.map((r) => `${r.name}=${r.relation}`).join("、"),
    leaves: relationLeaves,
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
    // 作者が困っているのはここ。**呼び方1つずつ**に分ける
    leaves: addressLeaves,
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
    const change: FieldChange = { label: field.label, before: left, after: right };
    // 1つずつ落とせる項目だけ、葉に分けたものも添える
    if (field.leaves) change.entries = diffEntries(before, after, field.leaves);
    changes.push(change);
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

/**
 * 提案パネルに出す差分。**Markdownの記号を付けない。**
 *
 * `formatDiff` は文書に貼る形（`##` `###` `-`）で作っている。これを
 * パネルへそのまま流したところ、`###` が記号のまま画面に出た
 * （2026-08-20、作者が実機で発見）。**パネルはHTMLを自分で組み立てる**ので、
 * 渡すのは記法ではなく行の並びだけにする。
 *
 * 名前は見出しとして別に出しているため、ここには含めない。
 */
export function diffLinesForPanel(diff: CharacterDiff): string[] {
  if (diff.changes.length === 0) return ["変更はありません。"];
  const lines: string[] = [];
  for (const change of diff.changes) {
    lines.push(change.label);
    lines.push(`　現在: ${change.before || "（未設定）"}`);
    lines.push(`　更新案: ${change.after || "（未設定）"}`);
  }
  return lines;
}
