import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import { CHARACTER_EXTRACT_VERSION } from "../../prompts/characterExtract";
import { SETTINGS_ENRICH_VERSION } from "../../prompts/settingsEnrich";
import { hashText } from "../../core/hash";
import type { SettingsKind } from "../../core/settingsSummary";
import { McpToolError, describeError } from "./shared";

/**
 * 抽出の保存の前に外部AIがまとめ直した値（「まとめ」）の貯め場所
 * （2026-10-02、作者の裁定「保存の前にまとめて、承認なしで入れる」）。
 *
 * `novel.validate`（feature: settingsEnrich、`options.fromExtract: true`、
 * `stash: true`）が、製品の「AIで再読込」と同じ検算に通った値だけを記録ごとに
 * 貯め、`novel.extract.commit` が新規レコードの本体の欄へ入れる。
 *
 * ## 抽出の貯め場所（`external-extract.json`）とは別のファイルにするわけ
 *
 * あちらは作者の作品で外部AIが**いま貯めている最中**のもので、形を変えると
 * 既にある貯めが読めなくなる。さらに、まだ古い版のMCPサーバーが答えを貯めると
 * ファイルを丸ごと書き直すので、同じファイルへ足した欄は黙って消える。
 * 別のファイルなら、どちらの版が書いても互いを壊さない。
 *
 * ## 何に結びつけるか
 *
 * まとめは「その時点の新規レコード」を読んで書いたものである。抽出の貯めが
 * 増えたり読み直されたりしてレコードが変わったら、まとめは新しい面を
 * 知らない——**指紋（`recordHash`）が合わなければ入れない**。
 * 抽出とまとめ直しのプロンプトの版も持ち、違えば入れない（答えの形が変わりうる）。
 */

/** 置き場。抽出の貯め場所と同じ `cache/` の下（同期されない） */
export function extractEnrichStashFileOf(folder: string): string {
  return nodePath.join(
    nodePath.resolve(folder),
    AIWRITER_DIR,
    "cache",
    "external-extract-enrich.json"
  );
}

const ENRICH_STASH_SCHEMA_VERSION = 1;

export interface EnrichStashEntry {
  recordKind: SettingsKind;
  /** 新規レコードの名前（保存の時に、種類と名前で引き当てる） */
  name: string;
  /** まとめたときの新規レコードの指紋（`recordFingerprint`） */
  recordHash: string;
  /** 抽出のプロンプト版（`CHARACTER_EXTRACT_VERSION`） */
  extractVersion: string;
  /** まとめ直しのプロンプト版（`SETTINGS_ENRICH_VERSION`） */
  enrichVersion: string;
  /**
   * 本体の欄へ入れる値。キーは設定資料パネルの反映と同じ
   * （既定の項目はそのまま、作者が足した項目は `custom:` 接頭辞。`toRecordEdits`）
   */
  edits: Record<string, string>;
  savedAt: string;
}

interface EnrichStashFile {
  schemaVersion: number;
  entries: EnrichStashEntry[];
}

/**
 * 新規レコードの指紋。保存時刻（`updatedAt`）は除く——保存の直前に付くので、
 * 入れると同じレコードでも毎回違う指紋になる。
 */
export function recordFingerprint(record: { updatedAt?: string }): string {
  const { updatedAt: _ignored, ...rest } = record;
  return hashText(JSON.stringify(rest));
}

/**
 * 貯めたまとめを読む。無ければ空。
 *
 * **読めないときは止める**（抽出の貯め場所と同じ。黙って空にすると、次に
 * 貯めた1件でそれまでのまとめを消す）。
 */
export function readExtractEnrichStash(folder: string): EnrichStashEntry[] {
  const file = extractEnrichStashFileOf(folder);
  if (!fs.existsSync(file)) return [];
  const broken = (detail: string): never => {
    throw new McpToolError(
      `まとめの貯め場所を読めませんでした（${relativeTo(folder, file)}: ${detail}）。` +
        "中身を確かめるか、要らなければ消してから、もう一度まとめ直してください。"
    );
  };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return broken(describeError(error));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return broken("形が違います");
  }
  const entries = (raw as Partial<EnrichStashFile>).entries;
  if (!Array.isArray(entries)) return broken("形が違います");
  const result: EnrichStashEntry[] = [];
  for (const item of entries as unknown[]) {
    const entry = item as Partial<EnrichStashEntry> | null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.recordKind !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.recordHash !== "string" ||
      typeof entry.extractVersion !== "string" ||
      typeof entry.enrichVersion !== "string" ||
      typeof entry.edits !== "object" ||
      entry.edits === null ||
      Object.values(entry.edits).some((value) => typeof value !== "string")
    ) {
      return broken("形が違います");
    }
    result.push(entry as EnrichStashEntry);
  }
  return result;
}

/**
 * 1つの記録のまとめを貯める。**同じ種類・同じ名前は差し替える**
 * （後からまとめ直したほうを使う）。
 */
export function stashExtractEnrich(
  folder: string,
  entry: Omit<EnrichStashEntry, "extractVersion" | "enrichVersion" | "savedAt">
): void {
  const entries = readExtractEnrichStash(folder).filter(
    (item) => !(item.recordKind === entry.recordKind && item.name === entry.name)
  );
  entries.push({
    ...entry,
    extractVersion: CHARACTER_EXTRACT_VERSION,
    enrichVersion: SETTINGS_ENRICH_VERSION,
    savedAt: new Date().toISOString(),
  });
  const file = extractEnrichStashFileOf(folder);
  const body: EnrichStashFile = { schemaVersion: ENRICH_STASH_SCHEMA_VERSION, entries };
  try {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    // 一時ファイルへ書いてから置き換える（`extractStash.ts` と同じ。書きかけを読ませない）
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    throw new McpToolError(`まとめを貯められませんでした: ${describeError(error)}`);
  }
}

/** 保存が済んだら消す。無ければ何もしない */
export function clearExtractEnrichStash(folder: string): void {
  const file = extractEnrichStashFileOf(folder);
  if (fs.existsSync(file)) fs.rmSync(file);
}

/** まとめが、いまの新規レコードとプロンプトの版に合っているか。合わなければ理由 */
export function staleReasonOf(
  entry: EnrichStashEntry,
  record: { updatedAt?: string }
): string | undefined {
  if (entry.extractVersion !== CHARACTER_EXTRACT_VERSION) {
    return `抽出のプロンプトの版が違います（まとめたとき ${entry.extractVersion}・いま ${CHARACTER_EXTRACT_VERSION}）`;
  }
  if (entry.enrichVersion !== SETTINGS_ENRICH_VERSION) {
    return `まとめ直しのプロンプトの版が違います（まとめたとき ${entry.enrichVersion}・いま ${SETTINGS_ENRICH_VERSION}）`;
  }
  if (entry.recordHash !== recordFingerprint(record)) {
    return "まとめたあとで抽出の貯めが変わり、この記録の中身も変わりました（まとめ直してください）";
  }
  return undefined;
}

function relativeTo(folder: string, target: string): string {
  return nodePath
    .relative(nodePath.resolve(folder), target)
    .split(nodePath.sep)
    .join("/");
}
