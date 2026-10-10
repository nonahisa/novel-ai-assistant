import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { AIWRITER_DIR, DEFAULT_SETTINGS_DIR } from "../../models/types";
import {
  characterFileName,
  parseCharacter,
  type Character,
  type PersonalityFacet,
} from "../../models/character";
import {
  abilityFileName,
  parseAbility,
  parseAbilitySystem,
  type Ability,
  type AbilitySystem,
} from "../../models/ability";
import {
  locationFileName,
  parseLocation,
  type Location,
} from "../../models/location";
import {
  organizationFileName,
  parseOrganization,
  type Organization,
} from "../../models/organization";
import {
  parseWorldItem,
  worldItemFileName,
  type WorldItem,
} from "../../models/world";
import {
  initialAbilityTermOf,
  replayExtraction,
  type ExtractionBaseline,
  type ExtractionReplayResult,
  type ReplayChunk,
} from "../../core/externalExtractMerge";
import { applyCharacterEdits, toRecordEdits } from "../../core/settingsEdit";
import { enrichableFields } from "../../prompts/settingsEnrich";
import {
  NEW_JSON_FILE_FORMAT,
  formatJsonForFile,
} from "../../core/jsonFileFormat";
import {
  PENDING_DIR,
  buildPendingPayload,
  pendingFileName,
} from "../../core/pendingUpdateFormat";
import {
  PENDING_SETTINGS_DIR,
  buildPendingSettingsPayload,
  parsePendingSettingsPayload,
  pendingSettingsFileName,
  type PendingSettingsKind,
  type PendingSettingsRecord,
} from "../../core/pendingSettingsMerge";
import { CHARACTER_EXTRACT_VERSION } from "../../prompts/characterExtract";
import {
  FOLDER_INPUT,
  McpToolError,
  SETTINGS_SUBDIRS,
  chunkFromId,
  describeError,
  parseChunkId,
} from "./shared";
import {
  clearExtractStash,
  readExtractStash,
  type StashEntry,
} from "./extractStash";
import {
  clearExtractEnrichStash,
  readExtractEnrichStash,
  staleReasonOf,
} from "./extractEnrichStash";

/**
 * 外部AIが行った設定資料の抽出を、**拡張機能の［設定資料を抽出］と同じ形で**
 * 資料へ保存する（2026-10-02、作者の裁定「何もない状態からであれば承認は不要」）。
 *
 * ## 設計書6.87.7「MCP は資料を書き換えない」の例外
 *
 * **例外はこの道具の、この保存だけ**である。製品のボタンも
 *
 *   新しい資料 → その場で保存（承認は要らない）
 *   既存の人物への変更 → 承認待ち（`.aiwriter/pending-characters/`）
 *
 * と分けている。ここも同じ線を引く。**既存のファイルは1バイトも変えない**
 * ——新しいファイルは `wx`（新規作成だけ）で作り、同じ名前が既にあれば
 * 上書きせずにその件を断って返す。
 *
 * ## 製品と違うところ（安全側に倒した）
 *
 * - **既存の能力・場所・組織・世界観への変更も、承認待ち（`pending-settings/`）へ
 *   回す。** 製品の `persist` はそのまま台帳へ書く（`SettingsStore.saveAll`）。
 *   MCP は既存のファイルを書き換えない線を守るため、作者が差分を見て採る形にした
 * - **能力体系（総称・決まり。`設定/ability_system.json`）は保存しない。**
 *   読み取れた総称と決まりは返り値に載せる（作者が確かめて書く）
 *
 * ## 並び
 *
 * 貯めた答え（`extractStash.ts`）を**作品の話の順**（話数の小さい順、
 * 話数の無いものは後ろ）に並べ、`core/externalExtractMerge.ts` の
 * `replayExtraction` へ渡す。製品と同じ関数で検算し、マージを1回ずつ行う。
 */

/** 材料の既定の件数と上限（上限は一覧に16桁の数が載らないように置く） */
const DEFAULT_MATERIAL_LIMIT = 20;
const MAX_MATERIAL_LIMIT = 1000;
const MAX_MATERIAL_OFFSET = 1_000_000;

export const EXTRACT_COMMIT_INPUT = {
  ...FOLDER_INPUT,
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "true なら書かずに、保存されるもの（新規・承認待ち・断るもの）の件数と内訳と、" +
        "新しい人物のまとめ直しの材料（materials）を返します"
    ),
  /*
    **材料だけを絞る口**（2026-10-02）。人物100人規模の作品では、材料を
    一度に返すと外部AIが読み切れない。保存の内訳（件数）は絞らない——
    絞ると「保存される数」が変わって見える
  */
  names: z
    .array(z.string())
    .max(MAX_MATERIAL_LIMIT)
    .optional()
    .describe("dryRun の材料（materials）を、この名前の新しい人物だけに絞ります（完全一致）"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_MATERIAL_OFFSET)
    .optional()
    .describe("dryRun の材料の何件目から返すか（既定は0）"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_MATERIAL_LIMIT)
    .optional()
    .describe(`dryRun の材料を何件返すか（既定は${DEFAULT_MATERIAL_LIMIT}）`),
};

export interface ExtractCommitInput {
  folder: string;
  dryRun?: boolean;
  /** dryRun の材料を絞る（名前の完全一致） */
  names?: string[];
  offset?: number;
  limit?: number;
}

/** 材料の1件（まだ保存していない新しい人物）。外部AIがまとめ直す元になる */
export interface ExtractMaterial {
  kind: "character";
  id: string;
  name: string;
  aliases: string[];
  appearedChapters: number[];
  /** まとめ直しの対象になる欄の、抽出で積んだいまの値（「AIで再読込」の項目と同じ並び） */
  fields: Record<string, string | null>;
  /** 性格の面（話数と根拠つき）。まとめても消えずに残る */
  personalityFacets: PersonalityFacet[];
  /** 口調の面（根拠は台詞の引用）。まとめても消えずに残る */
  speechStyleFacets: PersonalityFacet[];
  /** 話ごとの値と根拠（外見・紹介など）。まとめても消えずに残る */
  changes: Array<{ field: string; value: string; chapters: number[]; evidence: string | null }>;
  /** 作者の判断を待つ食い違い（まとめでは解かない） */
  conflicts: Array<{ field: string; values: string[] }>;
  evidence: string | null;
  /** 貯めてあるまとめ（保存で本体の欄へ入る値）。無ければ null */
  summarized: Record<string, string> | null;
  /** まとめが古くて入らない理由。あれば */
  summaryStale?: string;
}

type RecordKind = "character" | PendingSettingsKind;

export interface ExtractCommitResult {
  dryRun: boolean;
  /** 検算し直したチャンクの数 */
  replayedChunks: number;
  /** 新しく作った（作る）レコード。種類ごとの件数と名前 */
  created: Record<RecordKind, string[]>;
  createdCount: number;
  /** 既存のレコードへの変更として、承認待ちへ置いた（置く）もの */
  pending: Record<RecordKind, string[]>;
  pendingCount: number;
  /** 書かなかったもの。**上書きしない**ので、同じ名前が既にあれば断る */
  refused: Array<{ kind: RecordKind; name: string; file: string; reason: string }>;
  /** 書こうとして失敗したもの。**あれば貯め場所は消さない** */
  failed: Array<{ kind: RecordKind; name: string; file: string; reason: string }>;
  /** 使わなかった貯め（本文が変わった・版が違う） */
  discardedChunks: Array<{ chunkId: string; reason: string }>;
  /** 検算で落とした件数・作者に判断を預けた食い違い */
  rejected: { characters: number; settings: number };
  /**
   * 名前の出てこない語り手を、同じ一人称の人物が2人以上いて置けなかったもの
   * （2026-10-10。製品の完了報告と同じ中身）。無ければ欄ごと出さない
   */
  unplacedNarrators?: Array<{ firstPerson: string; candidates: string[] }>;
  conflicts: number;
  /** 読み取れた能力の総称と決まり。**保存していない** */
  abilitySystem: { abilityTerm: string | null; rules: string[] };
  /** 貯め場所（抽出の答えと、まとめ）を消したか */
  stashCleared: boolean;
  /**
   * まとめ（保存の前に外部AIがまとめ直した値）の当て方。
   * `applied` は本体の欄へ入れた（dryRun では入れる）もの、`skipped` は
   * 入れなかったもの（古い・既存の記録・新規に見当たらない）と理由
   */
  summaries: {
    applied: Array<{ kind: RecordKind; name: string; fields: string[] }>;
    skipped: Array<{ kind: RecordKind; name: string; reason: string }>;
  };
  /** dryRun のときだけ。新しい人物のまとめ直しの材料 */
  materials?: {
    total: number;
    offset: number;
    limit: number;
    items: ExtractMaterial[];
    /** 続きがあれば、次に渡す offset。無ければ null */
    nextOffset: number | null;
  };
  nextStep: string;
  note: string;
}

/** 承認待ちに添える理由。承認の画面にそのまま出る */
const PENDING_REASON =
  "外部AIが行った設定資料の抽出で、台帳にある記録の内容が変わりました。差分を見て採否を決めてください。";

export function extractCommit(input: ExtractCommitInput): ExtractCommitResult {
  const dryRun = input.dryRun === true;
  const plan = planExtractCommit(input.folder);
  const { root, settingsDir, result, chunks, discarded } = plan;

  /*
    **まとめ（保存の前に外部AIがまとめ直した値）を、新規の人物にだけ当てる**
    （2026-10-02、作者の裁定）。材料は当てる前の値で返す——外部AIがまとめ直す
    のは抽出で積んだ値であって、まとめた後の値ではない
  */
  const summaryPlan = planSummaries(input.folder, result);
  const materials = dryRun ? materialsOf(result, summaryPlan, input) : undefined;
  applySummaries(result, summaryPlan);

  const writes = planWrites(root, settingsDir, result);
  const created = emptyByKind();
  const pending = emptyByKind();
  const refused: ExtractCommitResult["refused"] = [];
  const failed: ExtractCommitResult["failed"] = [];

  for (const write of writes) {
    const file = relativeTo(root, write.target);
    if (fs.existsSync(write.target)) {
      refused.push({
        kind: write.kind,
        name: write.name,
        file,
        reason: write.pending
          ? "作者がまだ判断していない案があります（上書きすると作者が見る前の案が消えます）"
          : "同じ名前のファイルが既にあります（上書きしません）",
      });
      continue;
    }
    if (dryRun) {
      (write.pending ? pending : created)[write.kind].push(write.name);
      continue;
    }
    try {
      fs.mkdirSync(nodePath.dirname(write.target), { recursive: true });
      // **新規作成だけ**（`wx`）。確かめたあとに誰かが置いても上書きしない
      fs.writeFileSync(write.target, write.body, { encoding: "utf8", flag: "wx" });
      (write.pending ? pending : created)[write.kind].push(write.name);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") {
        refused.push({
          kind: write.kind,
          name: write.name,
          file,
          reason: "同じ名前のファイルが、確かめたあとに置かれました（上書きしません）",
        });
        continue;
      }
      failed.push({ kind: write.kind, name: write.name, file, reason: describeError(error) });
    }
  }

  /*
    **貯め場所は、書き終えたら消す。** 断った件（既にあるファイル）は失敗では
    ないので消してよい——もう一度保存しても同じ件が断られるだけである。
    **書けなかった件があれば残す**（直してからもう一度保存できるように）。
  */
  const stashCleared = !dryRun && failed.length === 0;
  if (stashCleared) {
    clearExtractStash(input.folder);
    // まとめは抽出の貯めに結びついている（指紋）。抽出の貯めだけ消すと、
    // 次の抽出で別のレコードに古いまとめが残るので、一緒に消す
    clearExtractEnrichStash(input.folder);
  }

  const createdCount = countOf(created);
  const pendingCount = countOf(pending);
  return {
    dryRun,
    replayedChunks: chunks.length,
    created,
    createdCount,
    pending,
    pendingCount,
    refused,
    failed,
    discardedChunks: discarded,
    rejected: {
      characters: result.rejectedCharacters.length,
      settings: result.rejectedSettings.length,
    },
    ...((result.characterMerge?.unplacedNarrators.length ?? 0) > 0
      ? { unplacedNarrators: result.characterMerge?.unplacedNarrators }
      : {}),
    conflicts:
      (result.characterMerge?.conflicts.length ?? 0) +
      result.settingsMerge.abilityMerge.conflicts.length +
      result.settingsMerge.locationMerge.conflicts.length +
      result.settingsMerge.organizationMerge.conflicts.length +
      result.settingsMerge.worldMerge.conflicts.length,
    abilitySystem: {
      abilityTerm: result.abilityTerm,
      rules: result.abilityRules,
    },
    stashCleared,
    summaries: {
      applied: summaryPlan.applied.map(({ kind, name, edits }) => ({
        kind,
        name,
        fields: Object.keys(edits),
      })),
      skipped: summaryPlan.skipped,
    },
    ...(materials ? { materials } : {}),
    nextStep:
      pendingCount > 0 && !dryRun
        ? "既存の記録への変更は承認待ちです。VS Code の詳細メニュー「設定資料更新分反映」で採否を決めます。"
        : dryRun
          ? "dryRun です。何も書いていません。dryRun を外すと、この内訳で保存します。"
          : "新しい資料を保存しました。VS Code の設定資料パネルで確かめられます。",
    note:
      "拡張機能の［設定資料を抽出］と同じ検算とマージを通しました。" +
      "新しい記録は保存し、既存の記録への変更は承認待ちへ置きます（既存のファイルは書き換えません）。" +
      "既存の能力・場所・組織・世界観への変更も承認待ちです（拡張機能はそのまま保存します）。" +
      "能力体系（総称・決まり）は保存していません（abilitySystem に読み取れたものを載せています）。" +
      "まとめ（settingsEnrich の fromExtract で貯めたもの）は新しい人物の本体の欄にだけ入れ、" +
      "性格・口調の面と話ごとの値（changes）はそのまま残します。",
  };
}

/** 抽出を検算し直した結果と、書く場所（`novel.extract.commit` と、まとめ直しのプロンプトが使う） */
export interface ExtractCommitPlan {
  root: string;
  settingsDir: string;
  baseline: ExtractionBaseline;
  result: ExtractionReplayResult;
  chunks: ReplayChunk[];
  discarded: Array<{ chunkId: string; reason: string }>;
}

/**
 * 貯めた答えを製品と同じ順で検算し直し、保存するものを決める（書かない）。
 *
 * **まとめ直しのプロンプト（`settingsEnrich.ts` の `fromExtract`）も、ここを通って
 * 「まだ保存していない新規レコード」を得る。** 保存と別の道で組むと、まとめ直した
 * レコードと保存するレコードが食い違う。
 */
export function planExtractCommit(folder: string): ExtractCommitPlan {
  const root = nodePath.resolve(folder);
  // **無い作品フォルダーには書かない**（`mkdirSync` は道を作ってしまう）
  if (!fs.existsSync(root)) {
    throw new McpToolError(
      `作品フォルダーが見つかりません: ${folder}（novel.scan が通る場所を指定してください）`
    );
  }
  const settingsDir = nodePath.join(root, DEFAULT_SETTINGS_DIR);

  /*
    **読めない台帳が1つでもあれば、何も書かずに止める**（製品の抽出と同じ）。
    読めないレコードを抜いたままマージすると、同じ人物を新規として作り直したり、
    同じ番号を2度採ったりする。直すのは作者で、こちらは直さない（規則2）。
  */
  const ledgers = loadBaseline(settingsDir);
  if (ledgers.errors.length > 0) {
    throw new McpToolError(
      "読めない設定ファイルがあります。上書きを避けるため保存を中止しました（何も書いていません）。\n" +
        ledgers.errors.join("\n")
    );
  }
  const abilitySystem = loadAbilitySystem(settingsDir);

  const stashed = readExtractStash(folder);
  if (stashed.length === 0) {
    throw new McpToolError(
      "保存する抽出の答えがありません。novel.validate（feature: settings）に stash: true を付けて検算するか、" +
        "novel.run（feature: settings、runner: sampling）で抽出してから呼んでください。"
    );
  }
  const { chunks, discarded } = replayChunksOf(folder, stashed);
  if (chunks.length === 0) {
    throw new McpToolError(
      "貯めた答えが1件も使えませんでした（何も書いていません）。" +
        discarded.map((item) => `${item.chunkId}: ${item.reason}`).join("／")
    );
  }

  const result = replayExtraction({
    chunks,
    baseline: ledgers.baseline,
    initialAbilityTerm: initialAbilityTermOf(abilitySystem),
  });

  return {
    root,
    settingsDir,
    baseline: ledgers.baseline,
    result,
    chunks,
    discarded,
  };
}

/* ── まとめ（保存の前のまとめ直し）────────────────────────── */

interface SummaryPlan {
  /** 当てるまとめ。`index` は `result.characters.created` の位置 */
  applied: Array<{ kind: RecordKind; name: string; index: number; edits: Record<string, string> }>;
  skipped: Array<{ kind: RecordKind; name: string; reason: string }>;
  /** 古くて当てないまとめ（材料に理由を出すため。名前で引く） */
  stale: Map<string, string>;
}

/**
 * 貯めたまとめを、どの新規レコードへ当てるかを決める（当てない）。
 *
 * **当てるのは新しい人物だけ。** 既存の人物（承認待ちへ回るもの）へ当てると、
 * 作者が承認の画面で見る案が、作者の見ていないまとめに変わる。人物以外は
 * 話ごとの値を残す欄（`changes`）を持たないので、まとめると元の値が消える。
 */
function planSummaries(folder: string, result: ExtractionReplayResult): SummaryPlan {
  const plan: SummaryPlan = { applied: [], skipped: [], stale: new Map() };
  const entries = readExtractEnrichStash(folder);
  if (entries.length === 0) return plan;
  const created = result.characters.created;
  const updated = new Set(result.characters.updated.map((character) => character.name));
  for (const entry of entries) {
    const kind = entry.recordKind;
    const skip = (reason: string) => plan.skipped.push({ kind, name: entry.name, reason });
    if (kind !== "character") {
      skip("まとめ直して保存できるのは新しい人物だけです");
      continue;
    }
    const index = created.findIndex((character) => character.name === entry.name);
    if (index < 0) {
      skip(
        updated.has(entry.name)
          ? "既存の記録です（変更は承認待ちへ回るので、まとめは当てません）"
          : "保存する新しい人物の中に見当たりません"
      );
      continue;
    }
    const stale = staleReasonOf(entry, created[index]);
    if (stale) {
      plan.stale.set(entry.name, stale);
      skip(stale);
      continue;
    }
    plan.applied.push({ kind, name: entry.name, index, edits: entry.edits });
  }
  return plan;
}

/**
 * まとめを本体の欄へ入れる（`result` の新規レコードを差し替える）。
 *
 * **入れ方は設定資料パネルの「AIで再読込」を採ったときと同じ**
 * （`applyCharacterEdits`、`authorConfirmed: false`）——作者が確定させた記録には
 * しない（以後の抽出で育つ）。面（`personalityFacets`・`speechStyleFacets`）・
 * 話ごとの値（`changes`）・食い違い（`conflicts`）には触らないので、積んだ値と
 * 根拠はそのまま残る。
 */
function applySummaries(result: ExtractionReplayResult, plan: SummaryPlan): void {
  for (const item of plan.applied) {
    const character = result.characters.created[item.index];
    result.characters.created[item.index] = applyCharacterEdits(
      character,
      toRecordEdits(item.edits),
      { authorConfirmed: false, characters: [character] }
    );
  }
}

/** dryRun の材料。**当てる前の値**で組む（まとめ直す元は抽出で積んだ値） */
function materialsOf(
  result: ExtractionReplayResult,
  plan: SummaryPlan,
  input: ExtractCommitInput
): NonNullable<ExtractCommitResult["materials"]> {
  const names = input.names && input.names.length > 0 ? new Set(input.names) : undefined;
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_MATERIAL_LIMIT;
  const summarized = new Map(plan.applied.map((item) => [item.name, item.edits]));
  const targets = result.characters.created.filter(
    (character) => !names || names.has(character.name)
  );
  const fieldKeys = enrichableFields("character").map((field) => field.key);
  const items = targets.slice(offset, offset + limit).map((character): ExtractMaterial => {
    const record = character as unknown as Record<string, unknown>;
    const stale = plan.stale.get(character.name);
    return {
      kind: "character",
      id: character.id,
      name: character.name,
      aliases: [...character.aliases],
      appearedChapters: [...character.appearedChapters],
      fields: Object.fromEntries(
        fieldKeys.map((key) => [key, typeof record[key] === "string" ? (record[key] as string) : null])
      ),
      personalityFacets: character.personalityFacets ?? [],
      speechStyleFacets: character.speechStyleFacets ?? [],
      changes: character.changes.map(({ field, value, chapters, evidence }) => ({
        field,
        value,
        chapters: [...chapters],
        evidence,
      })),
      conflicts: character.conflicts.map(({ field, values }) => ({ field, values: [...values] })),
      evidence: character.evidence,
      summarized: summarized.get(character.name) ?? null,
      ...(stale ? { summaryStale: stale } : {}),
    };
  });
  const next = offset + items.length;
  return {
    total: targets.length,
    offset,
    limit,
    items,
    nextOffset: next < targets.length ? next : null,
  };
}

/* ── 台帳の読み方 ───────────────────────────────────────── */

interface LoadedBaseline {
  baseline: ExtractionBaseline;
  /** 読めなかったファイル（`設定/characters/xxx.json: 理由`） */
  errors: string[];
}

/**
 * `設定/` の5つの台帳を読む。**製品の台帳（`CharacterStore`・`SettingsStore` の
 * `loadAll`）と同じ決まりで読む**：
 *
 * - `.json` だけ、`_` で始まるもの（`_index.json` など）は飛ばす
 * - ファイル名とIDが合わないもの・IDが重なるものは「読めない」に数える
 *
 * `shared.ts` の `readSettingsRecords` は読むだけの道具向けで、この2つを見ない。
 * 番号を採る保存では、見落とすと同じ番号を2度採る。
 */
function loadBaseline(settingsDir: string): LoadedBaseline {
  const errors: string[] = [];
  const read = <T extends { id: string }>(
    subdir: string,
    parse: (raw: unknown) => T
  ): T[] => {
    const loaded = loadLedger(nodePath.join(settingsDir, subdir), parse);
    errors.push(...loaded.errors.map((error) => `${subdir}/${error}`));
    return loaded.records;
  };
  return {
    baseline: {
      characters: read<Character>(SETTINGS_SUBDIRS.characters, parseCharacter),
      abilities: read<Ability>(SETTINGS_SUBDIRS.abilities, parseAbility),
      locations: read<Location>(SETTINGS_SUBDIRS.locations, parseLocation),
      organizations: read<Organization>(
        SETTINGS_SUBDIRS.organizations,
        parseOrganization
      ),
      world: read<WorldItem>(SETTINGS_SUBDIRS.world, parseWorldItem),
    },
    errors,
  };
}

function loadLedger<T extends { id: string }>(
  directory: string,
  parse: (raw: unknown) => T
): { records: T[]; errors: string[] } {
  const records: T[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(directory)) return { records, errors };
  const ids = new Set<string>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    try {
      const record = parse(
        JSON.parse(fs.readFileSync(nodePath.join(directory, name), "utf8"))
      );
      if (name !== `${record.id}.json` && !name.startsWith(`${record.id}_`)) {
        throw new Error(`ファイル名とID「${record.id}」が一致しません。`);
      }
      if (ids.has(record.id)) {
        throw new Error(`ID「${record.id}」が重複しています。`);
      }
      ids.add(record.id);
      records.push(record);
    } catch (error) {
      errors.push(`${name}: ${describeError(error)}`);
    }
  }
  // 製品の台帳と同じ並び（IDの順）。マージは並びに依らないが、揃えておく
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records, errors };
}

/** 能力体系。**壊れていれば止める**（製品の `AbilitySystemStore.load` と同じ） */
function loadAbilitySystem(settingsDir: string): AbilitySystem | undefined {
  const file = nodePath.join(settingsDir, "ability_system.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return parseAbilitySystem(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new McpToolError(
      `能力体系の設定（${DEFAULT_SETTINGS_DIR}/ability_system.json）を読めません。` +
        `上書きを避けるため保存を中止しました（何も書いていません）: ${describeError(error)}`
    );
  }
}

/* ── 貯めた答えを並べる ─────────────────────────────────── */

/**
 * 貯めた答えを、**作品の話の順**のチャンクの列にする。使えないものは理由付きで返す。
 *
 * - 本文が変わった（ハッシュが違う・そのチャンクがもう無い）→ 捨てる
 * - プロンプトの版が違う → 捨てる（答えの形が変わりうる）
 *
 * 並びは `shared.ts` の `orderedEpisodeBodies` と同じ考え——話数の読める
 * ものを先に小さい順、読めないものは後ろ、同じ話はファイル名・チャンクの順。
 * 抽出は既知名を育てながら進むので、**並びが変わると結果が変わる。**
 */
export function replayChunksOf(
  folder: string,
  stashed: readonly StashEntry[]
): { chunks: ReplayChunk[]; discarded: Array<{ chunkId: string; reason: string }> } {
  const usable: Array<ReplayChunk & { order: ReturnType<typeof parseChunkId> }> = [];
  const discarded: Array<{ chunkId: string; reason: string }> = [];
  for (const entry of stashed) {
    if (entry.promptVersion !== CHARACTER_EXTRACT_VERSION) {
      discarded.push({
        chunkId: entry.chunkId,
        reason: `プロンプトの版が違います（貯めたとき ${entry.promptVersion}・いま ${CHARACTER_EXTRACT_VERSION}）`,
      });
      continue;
    }
    let chunk;
    let order;
    try {
      order = parseChunkId(entry.chunkId);
      chunk = chunkFromId(folder, entry.chunkId);
    } catch (error) {
      discarded.push({ chunkId: entry.chunkId, reason: describeError(error) });
      continue;
    }
    if (chunk.hash !== entry.chunkHash) {
      discarded.push({
        chunkId: entry.chunkId,
        reason: "答えたあとに本文が変わりました（読み直してください）",
      });
      continue;
    }
    usable.push({ chunk, parsed: entry.parsed, order });
  }
  usable.sort((left, right) => {
    const a = left.order;
    const b = right.order;
    if (a.chapter === null && b.chapter !== null) return 1;
    if (a.chapter !== null && b.chapter === null) return -1;
    if (a.chapter !== null && b.chapter !== null && a.chapter !== b.chapter) {
      return a.chapter - b.chapter;
    }
    const byFile = a.filePath.localeCompare(b.filePath, "ja");
    if (byFile !== 0) return byFile;
    return a.index - b.index;
  });
  return {
    chunks: usable.map(({ chunk, parsed }) => ({ chunk, parsed })),
    discarded,
  };
}

/* ── 書くものを組む ─────────────────────────────────────── */

interface PlannedWrite {
  kind: RecordKind;
  name: string;
  target: string;
  body: string;
  /** 承認待ちへ置くもの（既存の記録への変更） */
  pending: boolean;
}

const SETTINGS_KIND_PLACES: Record<
  PendingSettingsKind,
  { subdir: string; fileName: (record: never) => string }
> = {
  ability: { subdir: SETTINGS_SUBDIRS.abilities, fileName: abilityFileName },
  location: { subdir: SETTINGS_SUBDIRS.locations, fileName: locationFileName },
  organization: {
    subdir: SETTINGS_SUBDIRS.organizations,
    fileName: organizationFileName,
  },
  world: { subdir: SETTINGS_SUBDIRS.world, fileName: worldItemFileName },
};

function planWrites(
  root: string,
  settingsDir: string,
  result: ReturnType<typeof replayExtraction>
): PlannedWrite[] {
  const now = new Date().toISOString();
  const writes: PlannedWrite[] = [];

  /*
    **新しい人物は、製品の `CharacterStore.saveAll` と同じ形で作る**——
    `parseCharacter` を通したものに `updatedAt` を付け、字下げ2つ・LF・
    末尾改行（`NEW_JSON_FILE_FORMAT`）。ファイル名も同じ関数で決める。
  */
  for (const character of result.characters.created) {
    const validated = parseCharacter(character);
    writes.push({
      kind: "character",
      name: validated.name,
      target: nodePath.join(
        settingsDir,
        SETTINGS_SUBDIRS.characters,
        characterFileName(validated)
      ),
      body: formatJsonForFile({ ...validated, updatedAt: now }, NEW_JSON_FILE_FORMAT),
      pending: false,
    });
  }

  // 人物以外は `SettingsStore.saveAll` と同じ（検証せずにそのまま。`updatedAt` だけ付ける）
  const settingsKinds: Array<[PendingSettingsKind, PendingSettingsRecord[]]> = [
    ["ability", result.abilities.created],
    ["location", result.locations.created],
    ["organization", result.organizations.created],
    ["world", result.world.created],
  ];
  for (const [kind, records] of settingsKinds) {
    const place = SETTINGS_KIND_PLACES[kind];
    for (const record of records) {
      writes.push({
        kind,
        name: record.name,
        target: nodePath.join(
          settingsDir,
          place.subdir,
          (place.fileName as (record: PendingSettingsRecord) => string)(record)
        ),
        body: formatJsonForFile({ ...record, updatedAt: now }, NEW_JSON_FILE_FORMAT),
        pending: false,
      });
    }
  }

  /*
    **既存の人物への変更は、承認待ちへ**（`propose.ts` と同じ書き方）。
    製品の `PendingUpdateStore.stage` は同じ人物の案を上書きするが、
    ここでは作者が見る前の案を消さないよう、既にあれば断る。
  */
  const pendingCharacters = nodePath.join(root, AIWRITER_DIR, PENDING_DIR);
  for (const character of result.characters.updated) {
    const validated = parseCharacter(character);
    writes.push({
      kind: "character",
      name: validated.name,
      target: nodePath.join(pendingCharacters, pendingFileName(validated, undefined)),
      body: `${JSON.stringify(
        buildPendingPayload(validated, { source: "external", reason: PENDING_REASON }),
        null,
        2
      )}\n`,
      pending: true,
    });
  }

  // 既存の人物以外への変更も承認待ちへ（`proposeRecord.ts` と同じ書き方）
  const pendingSettings = nodePath.join(root, AIWRITER_DIR, PENDING_SETTINGS_DIR);
  const updatedKinds: Array<[PendingSettingsKind, PendingSettingsRecord[]]> = [
    ["ability", result.abilities.updated],
    ["location", result.locations.updated],
    ["organization", result.organizations.updated],
    ["world", result.world.updated],
  ];
  for (const [kind, records] of updatedKinds) {
    for (const record of records) {
      const payload = buildPendingSettingsPayload(kind, record, {
        source: "external",
        reason: PENDING_REASON,
      });
      // **製品の読み取りが読める形かを、置く前に確かめる**（読めない案は画面に出ない）
      parsePendingSettingsPayload(JSON.parse(JSON.stringify(payload)) as unknown);
      writes.push({
        kind,
        name: record.name,
        target: nodePath.join(pendingSettings, pendingSettingsFileName(record)),
        body: `${JSON.stringify(payload, null, 2)}\n`,
        pending: true,
      });
    }
  }
  return writes;
}

function emptyByKind(): Record<RecordKind, string[]> {
  return { character: [], ability: [], location: [], organization: [], world: [] };
}

function countOf(byKind: Record<RecordKind, string[]>): number {
  return Object.values(byKind).reduce((sum, names) => sum + names.length, 0);
}

/** 作品フォルダーからの相対。区切りは読みやすいほうへ揃える */
function relativeTo(root: string, target: string): string {
  return nodePath.relative(root, target).split(nodePath.sep).join("/");
}
