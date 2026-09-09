import type { Ability, AbilitySystem } from "../models/ability";
import type { Character } from "../models/character";
import type { CustomFieldDefinition } from "../models/customField";
import type { AiNote } from "../models/aiNote";
import type { RecordConflict } from "../models/jsonValidation";
import type { Location } from "../models/location";
import { membersOf, type Organization } from "../models/organization";
import {
  WORLD_CATEGORIES,
  WORLD_CATEGORY_LABELS,
  type WorldItem,
} from "../models/world";
import { changedFields, changesOfField } from "./recordChanges";
import { hasAppearedBy, recordAsOf } from "./settingsAsOf";
import {
  aiNoteLines,
  describeChangeValues,
  describeConflictValues,
  formatChapters,
  formatPeriod,
  isVisibleAtSpoilerLevel,
} from "./settingsMarkdown";
import { formatDayStamp } from "./timestampedFileName";

/**
 * 設定資料を、提供先の型に合わせて絞って並べ直す（設計書6.75）。
 *
 * **AIは使わない。** 既にある資料から、出してよい項目だけを選んで組むだけの
 * 純粋関数である（VS Code APIに依存しない）。
 *
 * ## なぜ要るか
 *
 * これまでの書き出し（`generateSettingsDocs`）は「自分用の全部入り」しか
 * 作れなかった。**渡す相手によって、出してよい情報は違う。** イラストの
 * 発注書に結末の伏線や内面の掘り下げが混ざっていては困るし、レビュー依頼に
 * 経歴を全部付ける必要もない。
 *
 * ## 判断は「項目の種類」だけで行う
 *
 * 何を出すかは**下の表だけ**が決める。値の中身を見て「これはネタバレか」を
 * 判定しない——AIにも正規表現にも確実には判定できず、外したときに戻せない
 * のは作者の側だからである。**確実に判定できないものは、出さない側へ倒す。**
 *
 * ## 既存の全部入りを置き換えるものではない
 *
 * `settingsMarkdown.ts` の書き出しは種別ごとに1ファイルを作る「作者が読む
 * ための資料」で、こちらは**1ファイルにまとめて人へ渡すためのもの**である。
 * 見た目（項目名・話数の書き方・掘り下げの引用体裁）は向こうの部品をそのまま
 * 借りて、読む側が2種類の書式を覚えずに済むようにしてある。
 */

export type ExportAudience = "editorial" | "illustration" | "introduction";

/** 選択画面に出す順。**上ほど出す情報が多い** */
export const EXPORT_AUDIENCES: readonly ExportAudience[] = [
  "editorial",
  "illustration",
  "introduction",
];

export type CharacterExportField =
  | "reading"
  | "summary"
  | "aliases"
  | "gender"
  | "age"
  | "role"
  | "personality"
  | "appearance"
  | "looks"
  | "clothing"
  | "firstPerson"
  | "secondPerson"
  | "addressTerms"
  | "abilities"
  | "relations"
  | "customFields"
  | "affiliation"
  | "appearedChapters"
  | "status"
  | "exportNote"
  | "changes"
  | "conflicts"
  | "aiNotes";

export type LocationExportField =
  | "reading"
  | "aliases"
  | "summary"
  | "description"
  | "region"
  | "appearedChapters"
  | "status"
  | "exportNote"
  | "conflicts"
  | "aiNotes";

export type AbilityExportField =
  | "reading"
  | "aliases"
  | "summary"
  | "description"
  | "cost"
  | "limitation"
  | "userNames"
  | "category"
  | "appearedChapters"
  | "status"
  | "exportNote"
  | "conflicts"
  | "aiNotes";

export type OrganizationExportField =
  | "reading"
  | "aliases"
  | "summary"
  | "category"
  | "description"
  | "members"
  | "parent"
  | "appearedChapters"
  | "status"
  | "exportNote"
  | "conflicts"
  | "aiNotes";

export type WorldExportField =
  | "reading"
  | "aliases"
  | "description"
  | "appearedChapters"
  | "exportNote"
  | "conflicts"
  | "aiNotes";

/**
 * 項目の名前。**冒頭の「含めた／含めなかった」もここから作る。**
 * 表示名を別に持つと、落とした項目の名前だけが古いままになる。
 *
 * 並びは出力の順でもある。既存の全部入り（`settingsMarkdown.ts`）の順を
 * 崩さず、そこに無い `physical` の3つ（年齢・容姿・服装）だけを外見の隣へ
 * 足してある。
 */
const CHARACTER_FIELD_LABELS: Record<CharacterExportField, string> = {
  reading: "読み",
  summary: "紹介文",
  aliases: "別名",
  gender: "性別",
  age: "年齢",
  role: "役割",
  personality: "性格",
  appearance: "外見",
  looks: "容姿（身長・体格・髪・目・肌・特徴）",
  clothing: "服装",
  firstPerson: "一人称",
  secondPerson: "二人称",
  addressTerms: "相手ごとの呼び方",
  abilities: "能力",
  relations: "関係",
  customFields: "作者が足した項目",
  affiliation: "所属",
  appearedChapters: "登場話",
  status: "状態",
  exportNote: "補足",
  changes: "作中での変化",
  conflicts: "判断待ちの食い違い",
  aiNotes: "AIの掘り下げ",
};

const LOCATION_FIELD_LABELS: Record<LocationExportField, string> = {
  reading: "読み",
  aliases: "別名",
  summary: "紹介文",
  description: "説明",
  region: "地域",
  appearedChapters: "登場話",
  status: "状態",
  exportNote: "補足",
  conflicts: "判断待ちの食い違い",
  aiNotes: "AIの掘り下げ",
};

const ABILITY_FIELD_LABELS: Record<AbilityExportField, string> = {
  reading: "読み",
  aliases: "別名",
  summary: "紹介文",
  description: "効果",
  cost: "代償",
  limitation: "制約",
  userNames: "使い手",
  category: "分類",
  appearedChapters: "登場話",
  status: "状態",
  exportNote: "補足",
  conflicts: "判断待ちの食い違い",
  aiNotes: "AIの掘り下げ",
};

const ORGANIZATION_FIELD_LABELS: Record<OrganizationExportField, string> = {
  reading: "読み",
  aliases: "別名",
  summary: "紹介文",
  category: "種別",
  description: "説明",
  members: "所属する人物",
  parent: "上位組織",
  appearedChapters: "登場話",
  status: "状態",
  exportNote: "補足",
  conflicts: "判断待ちの食い違い",
  aiNotes: "AIの掘り下げ",
};

const WORLD_FIELD_LABELS: Record<WorldExportField, string> = {
  reading: "読み",
  aliases: "別の言い方",
  description: "説明",
  appearedChapters: "登場話",
  exportNote: "補足",
  conflicts: "判断待ちの食い違い",
  aiNotes: "AIの掘り下げ",
};

function allFields<T extends string>(labels: Record<T, string>): readonly T[] {
  return Object.keys(labels) as T[];
}

/**
 * 提供先の型ひとつ分。
 *
 * `null` を入れた種別は**まるごと出さない**。空配列（＝名前だけ出す）と
 * 区別するために分けてある。
 */
export interface AudienceProfile {
  id: ExportAudience;
  /** 選択画面と資料の冒頭に出す名前 */
  label: string;
  /** ファイル名に入れる短い名前 */
  fileLabel: string;
  /** 選択画面の説明。**何が出て何が出ないか**を1行で書く */
  description: string;
  /**
   * どの公開範囲まで含めるか。
   *
   * **`author_only`（作者だけ）はどの型にも渡さない。** 作者が自分の印を
   * 付けた項目を、頼まれてもいないのに外へ出さないためである。
   */
  spoilerLevel: "public" | "staff_only";
  /**
   * 所属・地域・分類・上位組織で章を分けるか。
   *
   * 分けるのは編集部向けだけにしてある。ほかの2つは渡す相手が読む単位が
   * 「人ひとり」「項目ひとつ」で、組織の構造まで要らない。
   */
  grouped: boolean;
  /** モブ・集団（名前だけの記録）を末尾に並べるか */
  mobs: boolean;
  characters: readonly CharacterExportField[] | null;
  locations: readonly LocationExportField[] | null;
  abilities: readonly AbilityExportField[] | null;
  organizations: readonly OrganizationExportField[] | null;
  world: readonly WorldExportField[] | null;
}

/**
 * 提供先の型の表。**ここが唯一の定義である。**
 *
 * 出す・出さないの根拠を1か所に集めてあるので、「イラスト発注に内面が
 * 混ざっていた」のような事故は、この表を読めば起きる前に分かる。
 */
export const AUDIENCE_PROFILES: Record<ExportAudience, AudienceProfile> = {
  editorial: {
    id: "editorial",
    label: "編集部向け",
    fileLabel: "編集部用",
    description:
      "全部入り。作品を一緒に見る相手へ渡します（作者だけの印を付けた項目は除く）",
    spoilerLevel: "staff_only",
    grouped: true,
    mobs: true,
    characters: allFields(CHARACTER_FIELD_LABELS),
    locations: allFields(LOCATION_FIELD_LABELS),
    abilities: allFields(ABILITY_FIELD_LABELS),
    organizations: allFields(ORGANIZATION_FIELD_LABELS),
    world: allFields(WORLD_FIELD_LABELS),
  },
  illustration: {
    id: "illustration",
    label: "イラスト・デザイン発注向け",
    fileLabel: "イラスト発注用",
    description:
      "外見に関わることだけ。内面・経歴・伏線・AIの掘り下げは出しません",
    spoilerLevel: "public",
    grouped: false,
    mobs: false,
    // **紹介文・役割・性格を入れない。** 描くのに要らないうえ、
    // 物語の筋がそのまま書かれていることが多い
    characters: [
      "reading",
      "gender",
      "age",
      "appearance",
      "looks",
      "clothing",
      "relations",
    ],
    // 場所は「名前と外観の描写だけ」（設計書6.75）。紹介文は物語での
    // 役割を書くところなので外す
    locations: ["reading", "description"],
    abilities: null,
    organizations: null,
    world: null,
  },
  introduction: {
    id: "introduction",
    label: "あらすじ・設定の紹介向け",
    fileLabel: "紹介用",
    description:
      "人物は名前と紹介文だけ、世界観は公開できる項目だけ。レビュー依頼などに",
    spoilerLevel: "public",
    grouped: false,
    mobs: false,
    characters: ["reading", "summary"],
    locations: null,
    abilities: null,
    organizations: null,
    world: ["reading", "description"],
  },
};

export interface SettingsExportData {
  characters: readonly Character[];
  locations: readonly Location[];
  abilities: readonly Ability[];
  abilitySystem: AbilitySystem;
  organizations: readonly Organization[];
  world: readonly WorldItem[];
  /**
   * 作者が足した項目の定義。
   *
   * **編集部向けにしか出さない。** 何を書く欄なのかは作者しか知らず、
   * 中身がネタバレかどうかを機械で判定できない（設計書6.75）。
   * 型ごとに出し分けたくなったら、定義の側に「どの提供先へ出してよいか」を
   * 持たせるのが筋である——ここで値を見て決めることはしない。
   */
  customFields?: readonly CustomFieldDefinition[];
}

export interface SettingsExportOptions {
  workTitle: string;
  /** 作者名。分からなければ null（行ごと出さない） */
  authorName?: string | null;
  /** 第N話まで。`null` なら全話ぶん */
  chapter: number | null;
  /** 作成日。呼び出し側から渡して、試験で固定できるようにしてある */
  at: Date;
}

/**
 * 話数で巻き戻す項目（設計書6.10.3）。
 *
 * **名前と読みは巻き戻さない。** 作中で変わるものではないし、消すと誰の話か
 * 分からなくなる。矛盾検知（`checkContradictions.ts`）と同じ一覧である。
 */
const CHARACTER_AS_OF_FIELDS = [
  "summary",
  "role",
  "personality",
  "appearance",
  "gender",
  "affiliation",
];

const LOCATION_AS_OF_FIELDS = ["summary", "region", "description"];

/**
 * 時点の記録を持たない人物の項目（本体の裁定、0.32.6）。
 *
 * 年齢・容姿・服装・別名と、作者が足した項目は、**いつ変わったのかの記録が
 * 無い**。第N話までの資料として渡しても、載るのは最新の値である。
 *
 * **落とさない。** これらはイラスト発注の中心項目で、外すと資料が用を
 * なさない。代わりに冒頭で正直に断る——渡された側が「第3話時点の姿だ」と
 * 思い込むのがいちばん困る。
 */
const UNDATED_CHARACTER_FIELDS: readonly CharacterExportField[] = [
  "aliases",
  "age",
  "looks",
  "clothing",
  "customFields",
];

/**
 * 第N話までに、その記録が世に出ているか。
 *
 * **`settingsAsOf.ts` の `hasAppearedBy` とは向きが逆である。** あちらは
 * 登場話の記録が無いレコードを通す——矛盾検知では、記録が無いだけで設定を
 * 捨てると突き合わせる材料が消えるので、それが正しい。
 *
 * **書き出しでは逆に効く**（0.32.6のレビュー）。まだ本文に書いていない
 * 人物・場所・能力の設定が、第1話までの資料にそのまま載っていた。
 * 渡す相手には「その時点までの話」しか見せない約束なので、
 * **確実に判定できないものは、出さない側へ倒す**（設計書6.75）。
 *
 * 矛盾検知の挙動は動かさない（`settingsAsOf.ts` には触っていない）。
 */
function appearsBy(
  record: {
    appearedChapters: readonly number[];
    /** 世界観だけは「未登場」の印を持たない */
    status?: "登場済み" | "未登場";
  },
  chapter: number | null
): boolean {
  if (chapter === null) return true;
  // 作者が「未登場（設定のみ）」と決めたものは、登場話が入っていても出さない
  if (record.status === "未登場") return false;
  const known = record.appearedChapters.filter((at) => Number.isFinite(at));
  if (known.length === 0) return false;
  return Math.min(...known) <= chapter;
}

/** その提供先・その時点で、このレコードを出してよいか */
function isExportable(
  record: {
    spoilerLevel: string;
    appearedChapters: readonly number[];
    status?: "登場済み" | "未登場";
  },
  profile: AudienceProfile,
  chapter: number | null
): boolean {
  return (
    isVisibleAtSpoilerLevel(record.spoilerLevel, profile.spoilerLevel) &&
    appearsBy(record, chapter)
  );
}

/**
 * 名前で引ける索引。**別名も同じ相手として引く。**
 *
 * 同じ呼び名の記録が複数あるときは全部持つ。出す・出さないの判断は
 * **全員が出してよいときだけ通す**——1人でも伏せる相手が混ざっているなら、
 * その名前は伏せた相手を指しているかもしれない。
 */
function nameIndexOf<T extends { name: string; aliases: readonly string[] }>(
  records: readonly T[]
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const record of records) {
    for (const raw of [record.name, ...record.aliases]) {
      const key = raw.trim();
      if (!key) continue;
      const found = index.get(key) ?? [];
      found.push(record);
      index.set(key, found);
    }
  }
  return index;
}

/**
 * 名前で引いた相手を、資料に出してよいか。
 *
 * **引き当てられない名前は、時点を絞ったときだけ落とす。** その相手が
 * いつ登場するのかを言えない以上、出さない側へ倒すしかない。全話ぶんの
 * 資料では絞る理由が無いので、これまでどおり出す（AIが本文から拾った
 * 呼び名は、資料の記録と一字一句同じとは限らない）。
 */
function mentionAllowed<
  T extends {
    name: string;
    aliases: readonly string[];
    spoilerLevel: string;
    appearedChapters: readonly number[];
    status?: "登場済み" | "未登場";
  },
>(
  index: Map<string, T[]>,
  name: string,
  profile: AudienceProfile,
  chapter: number | null
): boolean {
  const found = index.get(name.trim());
  if (!found || found.length === 0) return chapter === null;
  return found.every((record) => isExportable(record, profile, chapter));
}

/**
 * 提供先の型に合わせた設定資料を組み立てる。
 *
 * @param audience 提供先の型
 * @param data 書き出す元の資料（読むだけ。値は書き換えない）
 */
export function buildExportMarkdown(
  audience: ExportAudience,
  data: SettingsExportData,
  options: SettingsExportOptions
): string {
  const profile = AUDIENCE_PROFILES[audience];
  const chapter = options.chapter;
  /**
   * 話数の分からない自由記述を出してよいか。
   *
   * **時点で絞ったときは出さない。** 補足・AIの掘り下げ・判断待ちの
   * 食い違いは、いつ書かれたものか記録が無い。第N話までの資料として渡す
   * 以上、**先の話の情報が混ざっていないと言えないものは出さない側へ倒す。**
   */
  const undatedText = chapter === null;

  const lines: string[] = [
    ...headerLines(profile, data, options, undatedText),
  ];

  if (profile.characters) {
    lines.push(
      ...characterSection(profile, profile.characters, data, chapter, undatedText)
    );
  }
  if (profile.locations) {
    lines.push(
      ...locationSection(profile, profile.locations, data, chapter, undatedText)
    );
  }
  if (profile.abilities) {
    lines.push(
      ...abilitySection(profile, profile.abilities, data, chapter, undatedText)
    );
  }
  if (profile.organizations) {
    lines.push(
      ...organizationSection(
        profile,
        profile.organizations,
        data,
        chapter,
        undatedText
      )
    );
  }
  if (profile.world) {
    lines.push(
      ...worldSection(profile, profile.world, data, chapter, undatedText)
    );
  }

  return lines.join("\n");
}

/**
 * 冒頭の頭書き。
 *
 * **何を含めなかったかまで書く。** 渡された側が「これで全部だ」と思い込むと、
 * 足りない情報を訊いてもらえない（設計書6.75）。
 */
function headerLines(
  profile: AudienceProfile,
  data: SettingsExportData,
  options: SettingsExportOptions,
  undatedText: boolean
): string[] {
  const scope =
    options.chapter === null
      ? "全話ぶん"
      : `第${options.chapter}話までに書かれたことだけ`;

  const lines: string[] = [
    `# ${options.workTitle} 設定資料（${profile.label}）`,
    "",
    `- **作品名**: ${options.workTitle}`,
  ];
  if (options.authorName?.trim()) {
    lines.push(`- **作者**: ${options.authorName.trim()}`);
  }
  lines.push(
    `- **作成日**: ${formatDayStamp(options.at)}`,
    `- **提供先の型**: ${profile.label}`,
    `- **範囲**: ${scope}`,
    "",
    "## この資料に含めた項目",
    ""
  );

  for (const line of includedLines(profile, data)) lines.push(line);

  lines.push("", "## この資料に含めなかった項目", "");
  for (const line of excludedLines(profile, data)) lines.push(line);

  lines.push(
    "",
    `作者が「作者だけ」と印を付けた項目は含めていません。${
      profile.spoilerLevel === "public"
        ? "公開してよい印の付いた項目だけを載せています。"
        : ""
    }`
  );
  if (!undatedText) {
    lines.push(
      "",
      `第${options.chapter}話までに絞ったため、いつ書かれたか分からない自由記述` +
        "（補足・AIの掘り下げ・判断待ちの食い違い）は、先の話の内容が混ざって" +
        "いないと言い切れないので含めていません。"
    );
    /*
      **落とせない項目は、落とさずに断る**（本体の裁定、0.32.6）。

      年齢・容姿・服装・別名と作者が足した項目には、いつ変わったのかの
      記録が無い。落とすとイラスト発注の資料が用をなさないので載せるが、
      渡された側が「第N話時点の姿だ」と思い込まないよう、ここで正直に言う。
    */
    const undated = (profile.characters ?? []).filter((field) =>
      UNDATED_CHARACTER_FIELDS.includes(field)
    );
    if (undated.length > 0) {
      const names = undated.map((field) => CHARACTER_FIELD_LABELS[field]);
      lines.push(
        "",
        `ただし ${names.join("・")} は時点の記録を持たないため、` +
          "この資料でも最新の値で載っています（作中で変わっていれば、" +
          "第" +
          `${options.chapter}話の時点とは違うことがあります）。`
      );
    }
  }
  lines.push("");
  return lines;
}

/** 種別ごとに「名前＋出す項目」を並べる */
function includedLines(
  profile: AudienceProfile,
  data: SettingsExportData
): string[] {
  const lines: string[] = [];
  for (const kind of kindsOf(profile, data)) {
    if (!kind.fields) continue;
    const names = ["名前", ...kind.fields.map((field) => kind.labels[field])];
    lines.push(`- **${kind.label}**: ${names.join("／")}`);
  }
  if (lines.length === 0) lines.push("- （何も含めていません）");
  return lines;
}

function excludedLines(
  profile: AudienceProfile,
  data: SettingsExportData
): string[] {
  const lines: string[] = [];
  const wholeKinds: string[] = [];

  for (const kind of kindsOf(profile, data)) {
    if (!kind.fields) {
      wholeKinds.push(kind.label);
      continue;
    }
    const dropped = allFields(kind.labels)
      .filter((field) => !kind.fields!.includes(field))
      .map((field) => kind.labels[field]);
    if (dropped.length > 0) {
      lines.push(`- **${kind.label}**: ${dropped.join("／")}`);
    }
  }

  if (wholeKinds.length > 0) {
    lines.push(`- **${wholeKinds.join("・")}**: 種別ごと含めていません`);
  }
  if (lines.length === 0) lines.push("- （落とした項目はありません）");
  return lines;
}

/**
 * 種別の一覧。**含めた／含めなかった の両方がここを読む。**
 * 種別を足したときに、片方の一覧にだけ載る事故を防ぐ。
 *
 * 項目のキーは種別ごとに違う型なので、ここでは文字列として扱う
 * （出す・出さないの判断は既に済んでおり、ここは名前を並べるだけである）。
 */
interface ExportKind {
  label: string;
  fields: readonly string[] | null;
  labels: Record<string, string>;
}

function kindsOf(
  profile: AudienceProfile,
  data: SettingsExportData
): ExportKind[] {
  return [
    {
      label: "登場人物",
      fields: profile.characters,
      labels: CHARACTER_FIELD_LABELS,
    },
    { label: "場所", fields: profile.locations, labels: LOCATION_FIELD_LABELS },
    {
      label: abilityTermOf(data),
      fields: profile.abilities,
      labels: ABILITY_FIELD_LABELS,
    },
    {
      label: "組織",
      fields: profile.organizations,
      labels: ORGANIZATION_FIELD_LABELS,
    },
    { label: "世界観", fields: profile.world, labels: WORLD_FIELD_LABELS },
  ];
}

function abilityTermOf(data: SettingsExportData): string {
  return data.abilitySystem.abilityTerm || "能力";
}

/* ────────────────────────────  登場人物  ──────────────────────────── */

function characterSection(
  profile: AudienceProfile,
  fields: readonly CharacterExportField[],
  data: SettingsExportData,
  chapter: number | null,
  undatedText: boolean
): string[] {
  const visible = data.characters
    .filter((character) => isExportable(character, profile, chapter))
    .map((character) =>
      recordAsOf(character, CHARACTER_AS_OF_FIELDS, chapter)
    );

  const named = visible.filter((character) => !character.isMob);
  const mobs = profile.mobs ? visible.filter((c) => c.isMob) : [];

  const lines = ["## 登場人物", ""];
  if (named.length === 0 && mobs.length === 0) {
    lines.push("該当する登場人物はありません。", "");
    return lines;
  }

  /*
    **名指しされた相手も、同じ関門を通す**（0.32.6のレビュー）。
    関係・呼称・能力は「別の記録の名前」を書く欄なので、その記録を出さないと
    決めていても、名前だけがここから漏れていた。索引は人物ぶんの走査に
    なるので、1人ずつではなく**種別ごとに1回だけ**作る。
  */
  const mentions: MentionIndexes = {
    characters: nameIndexOf(data.characters),
    abilities: nameIndexOf(data.abilities),
  };

  const depth = profile.grouped && fields.includes("affiliation") ? 4 : 3;
  if (depth === 4) {
    for (const [affiliation, members] of groupBy(
      named,
      (character) => character.affiliation,
      "所属の記載なし"
    )) {
      lines.push(`### ${affiliation}`, "");
      for (const character of members) {
        lines.push(
          ...describeCharacter(
            character,
            fields,
            data,
            profile,
            mentions,
            chapter,
            undatedText,
            depth
          )
        );
      }
    }
  } else {
    for (const character of named) {
      lines.push(
        ...describeCharacter(
          character,
          fields,
          data,
          profile,
          mentions,
          chapter,
          undatedText,
          depth
        )
      );
    }
  }

  if (mobs.length > 0) {
    lines.push("### モブ・集団", "");
    for (const character of mobs) {
      const chapters = chaptersUpTo(character.appearedChapters, chapter);
      const suffix =
        fields.includes("appearedChapters") && chapters.length > 0
          ? `（${formatChapters(chapters)}）`
          : "";
      lines.push(`- ${character.name}${suffix}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * 名指しされた相手を引く索引。**種別ごとに1回だけ作って持ち回る。**
 * 人物ごとに作り直すと、記録の数だけ二乗で効いてくる。
 */
interface MentionIndexes {
  characters: Map<string, Character[]>;
  abilities: Map<string, Ability[]>;
}

function describeCharacter(
  character: Character,
  fields: readonly CharacterExportField[],
  data: SettingsExportData,
  profile: AudienceProfile,
  mentions: MentionIndexes,
  chapter: number | null,
  undatedText: boolean,
  depth: number
): string[] {
  const lines: string[] = [];
  lines.push(heading(depth, character.name, has(fields, "reading") ? character.reading : null), "");

  if (has(fields, "summary") && character.summary) {
    lines.push(character.summary, "");
  }

  const bullet = (label: string, value: string) =>
    lines.push(`- **${label}**: ${value}`);

  if (has(fields, "aliases") && character.aliases.length > 0) {
    bullet("別名", character.aliases.join("、"));
  }
  if (has(fields, "gender") && character.gender) bullet("性別", character.gender);
  if (has(fields, "age") && character.physical?.age) {
    bullet("年齢", character.physical.age);
  }
  if (has(fields, "role") && character.role) bullet("役割", character.role);
  if (has(fields, "personality") && character.personality) {
    bullet("性格", character.personality);
  }
  if (has(fields, "appearance") && character.appearance) {
    bullet("外見", character.appearance);
  }
  if (has(fields, "looks")) {
    const looks = describeLooks(character);
    if (looks) bullet("容姿", looks);
  }
  if (has(fields, "clothing") && character.physical?.clothing) {
    bullet("服装", character.physical.clothing);
  }
  if (has(fields, "firstPerson") && character.firstPerson.default) {
    const variants = character.firstPerson.variants
      .filter((variant) => startsBy(variant.chapters, chapter))
      .map((variant) =>
        variant.context ? `${variant.form}（${variant.context}）` : variant.form
      )
      .join("、");
    bullet(
      "一人称",
      `${character.firstPerson.default}${variants ? `／${variants}` : ""}`
    );
  }
  if (has(fields, "secondPerson") && character.defaultSecondPerson) {
    bullet("二人称", character.defaultSecondPerson);
  }
  if (has(fields, "addressTerms")) {
    for (const term of character.addressTerms) {
      // **相手を出さないと決めたなら、呼び方も出さない**（0.32.6のレビュー）。
      // 「終幕の男への呼称」という見出しだけで、その人物の存在が漏れる
      if (
        !mentionAllowed(mentions.characters, term.targetName, profile, chapter)
      ) {
        continue;
      }
      const forms = term.forms
        // **いつから使われた呼び方か分からないものは、時点を絞ったら
        // 出さない。** 第3話までの資料に、第9話で始まる呼び方が載りうる
        .filter((form) =>
          form.firstChapter === null
            ? chapter === null
            : upTo(form.firstChapter, chapter)
        )
        .map((form) => {
          const period = formatPeriod(form.firstChapter, form.lastChapter);
          const context = form.context ? `／${form.context}` : "";
          // **「現在は使われない」は作品全体を見た判断である。**
          // 第N話までの資料では、その時点でまだ使われていることがある
          const ended =
            form.status === "past" &&
            (form.lastChapter === null || upTo(form.lastChapter, chapter));
          return `${form.term}${period}${context}${ended ? "（現在は使われない）" : ""}`;
        })
        .join("、");
      if (forms) bullet(`${term.targetName}への呼称`, forms);
    }
  }
  if (has(fields, "abilities")) {
    const abilities = character.abilities
      .filter(
        (ability) =>
          startsBy(ability.appearedChapters, chapter) &&
          (ability.firstChapter === null ||
            upTo(ability.firstChapter, chapter)) &&
          // **能力の台帳のほうで伏せたものは、人物欄にも書かない**
          // （0.32.6のレビュー）。能力の章に出ないだけでは足りず、
          // 「能力: 終焉」の1行で名前が漏れていた
          mentionAllowed(mentions.abilities, ability.name, profile, chapter)
      )
      .map((ability) =>
        ability.mastery === "習得済み"
          ? ability.name
          : `${ability.name}（${ability.mastery}）`
      )
      .join("、");
    if (abilities) bullet("能力", abilities);
  }
  if (has(fields, "relations")) {
    // **相手を出さないと決めたなら、関係の行にも名前を出さない**
    // （0.32.6のレビュー）。人物そのものは伏せたのに、
    // 「関係: 白鳥（同僚）」でその存在が漏れていた
    const relations = character.relations
      .filter((relation) =>
        mentionAllowed(mentions.characters, relation.name, profile, chapter)
      )
      .map((relation) => `${relation.name}（${relation.relation}）`)
      .join("、");
    if (relations) bullet("関係", relations);
  }
  if (has(fields, "customFields")) {
    for (const field of data.customFields ?? []) {
      const value = character.customFields[field.key]?.trim();
      if (value) bullet(field.label, value);
    }
  }
  if (has(fields, "appearedChapters")) {
    const chapters = chaptersUpTo(character.appearedChapters, chapter);
    if (chapters.length > 0) bullet("登場話", formatChapters(chapters));
  }
  if (has(fields, "status") && character.status === "未登場") {
    bullet("状態", "未登場（設定のみ）");
  }
  if (has(fields, "exportNote") && undatedText && character.exportNote.trim()) {
    bullet("補足", character.exportNote.trim());
  }
  if (has(fields, "changes")) {
    const changes = changesUpTo(character.changes, chapter);
    for (const field of changedFields(changes)) {
      bullet(
        `変化（${field}）`,
        describeChangeValues(changesOfField(changes, field))
      );
    }
  }
  if (has(fields, "conflicts") && undatedText) {
    for (const conflict of character.conflicts) {
      bullet(
        `変化かもしれない（${conflict.field}）`,
        describeConflictValues(conflict)
      );
    }
  }
  if (has(fields, "aiNotes") && undatedText) {
    lines.push(...aiNoteLines(character.aiNotes));
  }
  lines.push("");
  return lines;
}

/** 見た目の細目。1つの欄にまとめて、箇条書きが縦に伸びるのを防ぐ */
function describeLooks(character: Character): string {
  const physical = character.physical;
  if (!physical) return "";
  return [
    physical.height && `身長：${physical.height}`,
    physical.build && `体格：${physical.build}`,
    physical.hair && `髪：${physical.hair}`,
    physical.eyes && `目：${physical.eyes}`,
    physical.skin && `肌：${physical.skin}`,
    physical.distinctive && `特徴：${physical.distinctive}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("、");
}

/* ────────────────────────────  場所  ──────────────────────────── */

function locationSection(
  profile: AudienceProfile,
  fields: readonly LocationExportField[],
  data: SettingsExportData,
  chapter: number | null,
  undatedText: boolean
): string[] {
  const visible = data.locations
    .filter((location) => isExportable(location, profile, chapter))
    .map((location) => recordAsOf(location, LOCATION_AS_OF_FIELDS, chapter));

  const lines = ["## 場所", ""];
  if (visible.length === 0) {
    lines.push("該当する場所はありません。", "");
    return lines;
  }

  const grouped = profile.grouped && fields.includes("region");
  const depth = grouped ? 4 : 3;
  const groups = grouped
    ? groupBy(visible, (location) => location.region, "地域未設定")
    : new Map([["", visible]]);

  for (const [region, items] of groups) {
    if (grouped) lines.push(`### ${region}`, "");
    for (const location of items) {
      lines.push(
        heading(depth, location.name, has(fields, "reading") ? location.reading : null),
        ""
      );
      if (has(fields, "summary") && location.summary) {
        lines.push(location.summary, "");
      }
      if (has(fields, "aliases") && location.aliases.length > 0) {
        lines.push(`- **別名**: ${location.aliases.join("、")}`);
      }
      if (has(fields, "description") && location.description) {
        lines.push(`- **説明**: ${location.description}`);
      }
      lines.push(
        ...commonTailLines(
          {
            appearedChapters: location.appearedChapters,
            status: location.status,
            exportNote: location.exportNote,
            conflicts: location.conflicts,
            aiNotes: location.aiNotes,
          },
          fields,
          chapter,
          undatedText
        )
      );
      lines.push("");
    }
  }
  return lines;
}

/* ────────────────────────────  能力  ──────────────────────────── */

function abilitySection(
  profile: AudienceProfile,
  fields: readonly AbilityExportField[],
  data: SettingsExportData,
  chapter: number | null,
  undatedText: boolean
): string[] {
  const term = abilityTermOf(data);
  const visible = data.abilities.filter((ability) =>
    isExportable(ability, profile, chapter)
  );
  // 「使い手」は人物の名前なので、人物と同じ関門を通す（設計書6.75）
  const charactersByName = nameIndexOf(data.characters);

  const lines = [`## ${term}`, ""];
  if (visible.length === 0) {
    lines.push(`該当する${term}はありません。`, "");
    return lines;
  }

  const grouped = profile.grouped && fields.includes("category");
  const depth = grouped ? 4 : 3;
  const groups = grouped
    ? groupBy(visible, (ability) => ability.category, "分類なし")
    : new Map([["", visible]]);

  for (const [category, items] of groups) {
    if (grouped) lines.push(`### ${category}`, "");
    for (const ability of items) {
      lines.push(
        heading(depth, ability.name, has(fields, "reading") ? ability.reading : null),
        ""
      );
      if (has(fields, "summary") && ability.summary) {
        lines.push(ability.summary, "");
      }
      if (has(fields, "aliases") && ability.aliases.length > 0) {
        lines.push(`- **別名**: ${ability.aliases.join("、")}`);
      }
      if (has(fields, "description") && ability.description) {
        lines.push(`- **効果**: ${ability.description}`);
      }
      if (has(fields, "cost") && ability.cost) {
        lines.push(`- **代償**: ${ability.cost}`);
      }
      if (has(fields, "limitation") && ability.limitation) {
        lines.push(`- **制約**: ${ability.limitation}`);
      }
      if (has(fields, "userNames")) {
        const users = ability.userNames.filter((name) =>
          mentionAllowed(charactersByName, name, profile, chapter)
        );
        if (users.length > 0) lines.push(`- **使い手**: ${users.join("、")}`);
      }
      lines.push(
        ...commonTailLines(
          {
            appearedChapters: ability.appearedChapters,
            status: ability.status,
            exportNote: ability.exportNote,
            conflicts: ability.conflicts,
            aiNotes: ability.aiNotes,
          },
          fields,
          chapter,
          undatedText
        )
      );
      lines.push("");
    }
  }
  return lines;
}

/* ────────────────────────────  組織  ──────────────────────────── */

function organizationSection(
  profile: AudienceProfile,
  fields: readonly OrganizationExportField[],
  data: SettingsExportData,
  chapter: number | null,
  undatedText: boolean
): string[] {
  const visible = data.organizations.filter((organization) =>
    isExportable(organization, profile, chapter)
  );

  const lines = ["## 組織", ""];
  if (visible.length === 0) {
    lines.push("該当する組織はありません。", "");
    return lines;
  }

  // **所属する人物は、その提供先に出してよい人だけを引く**（0.32.6の
  // レビュー）。公開範囲を見ていなかったので、作者だけの印を付けた人物の
  // 名前が、組織の欄からそのまま漏れていた
  const members = data.characters
    .filter((character) => isExportable(character, profile, chapter))
    .map((character) => ({
      name: character.name,
      affiliation: character.affiliation,
    }));

  const grouped = profile.grouped && fields.includes("parent");
  const depth = grouped ? 4 : 3;
  const groups = grouped
    ? groupBy(visible, (organization) => organization.parent, "上位組織の記載なし")
    : new Map([["", visible]]);

  for (const [parent, items] of groups) {
    if (grouped) lines.push(`### ${parent}`, "");
    for (const organization of items) {
      lines.push(
        heading(
          depth,
          organization.name,
          has(fields, "reading") ? organization.reading : null
        ),
        ""
      );
      if (has(fields, "summary") && organization.summary) {
        lines.push(organization.summary, "");
      }
      if (has(fields, "aliases") && organization.aliases.length > 0) {
        lines.push(`- **別名**: ${organization.aliases.join("、")}`);
      }
      if (has(fields, "category") && organization.category) {
        lines.push(`- **種別**: ${organization.category}`);
      }
      if (has(fields, "description") && organization.description) {
        lines.push(`- **説明**: ${organization.description}`);
      }
      if (has(fields, "members")) {
        const belongs = membersOf(organization, members);
        if (belongs.length > 0) {
          lines.push(`- **所属する人物**: ${belongs.join("、")}`);
        }
      }
      lines.push(
        ...commonTailLines(
          {
            appearedChapters: organization.appearedChapters,
            status: organization.status,
            exportNote: organization.exportNote,
            conflicts: organization.conflicts,
            aiNotes: organization.aiNotes,
          },
          fields,
          chapter,
          undatedText
        )
      );
      lines.push("");
    }
  }
  return lines;
}

/* ────────────────────────────  世界観  ──────────────────────────── */

/**
 * 世界観は、どの型でも分類でまとめる。
 *
 * 分類（ジャンル・時代背景・世界の法則…）は資料の並びそのものであって、
 * 伏せる情報ではない。並び順を `WORLD_CATEGORIES` に固定するのも
 * 既存の書き出しと同じ理由——読む人が場所を覚えられるようにするため。
 */
function worldSection(
  profile: AudienceProfile,
  fields: readonly WorldExportField[],
  data: SettingsExportData,
  chapter: number | null,
  undatedText: boolean
): string[] {
  const visible = data.world.filter((item) =>
    isExportable(item, profile, chapter)
  );

  const lines = ["## 世界観", ""];
  if (visible.length === 0) {
    lines.push("該当する世界観の項目はありません。", "");
    return lines;
  }

  for (const category of WORLD_CATEGORIES) {
    const group = visible.filter((item) => item.category === category);
    if (group.length === 0) continue;

    lines.push(`### ${WORLD_CATEGORY_LABELS[category]}`, "");
    for (const item of group) {
      lines.push(
        heading(4, item.name, has(fields, "reading") ? item.reading : null),
        ""
      );
      if (has(fields, "description") && item.description) {
        lines.push(item.description, "");
      }
      if (has(fields, "aliases") && item.aliases.length > 0) {
        lines.push(`- **別の言い方**: ${item.aliases.join("、")}`);
      }
      lines.push(
        ...commonTailLines(
          {
            appearedChapters: item.appearedChapters,
            exportNote: item.exportNote,
            conflicts: item.conflicts,
            aiNotes: item.aiNotes,
          },
          fields,
          chapter,
          undatedText
        )
      );
      lines.push("");
    }
  }
  return lines;
}

/**
 * どの種別にも共通する末尾（登場話・状態・補足・食い違い・掘り下げ）。
 *
 * 種別ごとに書くと、**片方だけ「補足が出ない」ような差が静かに残る。**
 * 項目名は種別の表と同じ綴りなので、`CommonTailField` で型を効かせている。
 */
type CommonTailField =
  | "appearedChapters"
  | "status"
  | "exportNote"
  | "conflicts"
  | "aiNotes";

function commonTailLines(
  record: {
    appearedChapters: number[];
    /** 世界観だけは「未登場」の印を持たない */
    status?: "登場済み" | "未登場";
    exportNote: string;
    conflicts: readonly RecordConflict[];
    aiNotes: AiNote[];
  },
  fields: readonly string[],
  chapter: number | null,
  undatedText: boolean
): string[] {
  const shows = (field: CommonTailField): boolean => fields.includes(field);

  const lines: string[] = [];
  if (shows("appearedChapters")) {
    const chapters = chaptersUpTo(record.appearedChapters, chapter);
    if (chapters.length > 0) {
      lines.push(`- **登場話**: ${formatChapters(chapters)}`);
    }
  }
  if (shows("status") && record.status === "未登場") {
    lines.push("- **状態**: 未登場（設定のみ）");
  }
  if (shows("exportNote") && undatedText && record.exportNote.trim()) {
    lines.push(`- **補足**: ${record.exportNote.trim()}`);
  }
  if (shows("conflicts") && undatedText) {
    for (const conflict of record.conflicts) {
      lines.push(
        `- **変化かもしれない（${conflict.field}）**: ${describeConflictValues(conflict)}`
      );
    }
  }
  if (shows("aiNotes") && undatedText) {
    lines.push(...aiNoteLines(record.aiNotes));
  }
  return lines;
}

/* ────────────────────────────  共通  ──────────────────────────── */

function has<T extends string>(fields: readonly T[], field: T): boolean {
  return fields.includes(field);
}

function heading(depth: number, name: string, reading: string | null): string {
  const suffix = reading ? `（${reading}）` : "";
  return `${"#".repeat(depth)} ${name}${suffix}`;
}

/** 話数の一覧を、第N話までに切り詰める */
function chaptersUpTo(chapters: number[], chapter: number | null): number[] {
  if (chapter === null) return chapters;
  return chapters.filter((at) => Number.isFinite(at) && at <= chapter);
}

/** 記録の始まりが第N話までにあるか。記録が無ければ判断できないので通す */
function startsBy(chapters: number[], chapter: number | null): boolean {
  return hasAppearedBy(chapters, chapter);
}

function upTo(value: number, chapter: number | null): boolean {
  return chapter === null || value <= chapter;
}

/** 第N話までに書かれた変化だけを残す */
function changesUpTo<T extends { chapters: number[] }>(
  changes: readonly T[],
  chapter: number | null
): T[] {
  if (chapter === null) return [...changes];
  return changes
    .filter((change) => {
      const known = change.chapters.filter((at) => Number.isFinite(at));
      // 話数の記録が無い値は「それ以前」。落とすと作者が書いた値が消える
      return known.length === 0 || Math.min(...known) <= chapter;
    })
    .map((change) => ({
      ...change,
      chapters: chaptersUpTo(change.chapters, chapter),
    }));
}

/**
 * 見出しでまとめる。
 * まとめる値を持たないものは末尾へ寄せ、架空の分類があるように見せない。
 */
function groupBy<T>(
  records: readonly T[],
  keyOf: (record: T) => string | null,
  fallback: string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  const others: T[] = [];

  for (const record of records) {
    const key = keyOf(record)?.trim();
    if (!key) {
      others.push(record);
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  if (others.length > 0) groups.set(fallback, others);
  return groups;
}
