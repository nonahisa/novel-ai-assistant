import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig } from "./workRegistry";
import { CharacterStore } from "./characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "./abilityStore";
import {
  isShareableRecord,
  resolveRelatedWorkPaths,
  seriesSourceTitle,
  type RelatedWorkPath,
  type SeriesCharacterCandidate,
  type SeriesTerm,
} from "./seriesLink";

/**
 * つないだシリーズ作品から、借りてよいものだけを読む（設計書6.95）。
 *
 * ## 黙って何もしない
 *
 * 相手のフォルダーが無い・設定資料が無い・JSONが壊れている——どれも
 * **その1件を飛ばして進む**。関門（6.94）は立てない。シリーズの連結は
 * 「あると嬉しい」ものであって、無いと機能が壊れるものではない。
 * **前提ではなく、味付けである。**
 *
 * ## 書き戻さない
 *
 * ここには読む口しか無い。相手の資料を書き換える関数を**作らない**のが、
 * 「片方向である」を守る一番確かなやり方である。
 */

/** 同じ作品を何度も読み直さないための控え。設定資料が保存されたら捨てる */
const cache = new Map<string, { terms: SeriesTerm[] }>();

export function clearSeriesCache(): void {
  cache.clear();
}

/**
 * 相手の作品を、ストアが扱える形にする。
 *
 * **登録簿には入れない。** 登録すると作品一覧に相手が2つ並び、
 * 統計にも同期にも乗ってしまう。ここで要るのは読むための入れ物だけである。
 */
function asReadOnlyWork(related: RelatedWorkPath): WorkEntry {
  return {
    id: `series:${related.folderName}`,
    title: related.folderName,
    folderPath: related.folderPath,
    registeredAt: "",
  };
}

/** つないだ相手のうち、実際にフォルダーが在るものだけを返す */
export async function listSeriesNeighbors(
  work: WorkEntry
): Promise<RelatedWorkPath[]> {
  let series;
  try {
    series = (await readWorkConfig(work))?.series;
  } catch {
    // 自分の設定が読めないのは、ここで騒ぐことではない
    // （作品を開くほかの経路が、同じ設定を読んで正しく知らせる）
    return [];
  }
  const resolved = resolveRelatedWorkPaths(work.folderPath, series);

  const found: RelatedWorkPath[] = [];
  for (const related of resolved) {
    try {
      const stat = await vscode.workspace.fs.stat(path.toUri(related.folderPath));
      if (stat.type & vscode.FileType.Directory) found.push(related);
    } catch {
      // 相手が見つからないときは、黙って何もしない（設計書6.95.2）
    }
  }
  return found;
}

/**
 * 相手の**名前と読み仮名だけ**を借りる（設計書6.95.3）。
 *
 * 用語の色分け・ルビ・IME辞書・表記ゆれの材料に足す。**中身（紹介・性格・
 * 外見など）は読まない**ので、ネタバレが漏れない——`SeriesTerm` に
 * そもそも中身を入れる欄が無い。
 *
 * 別名も名前として借りる。表記ゆれと色分けは別名まで見ており、
 * ここだけ正式名称に絞ると「本編では色が付く語が、別視点では付かない」
 * という食い違いになる。
 */
export async function loadSeriesTerms(work: WorkEntry): Promise<SeriesTerm[]> {
  const cached = cache.get(work.id);
  if (cached) return cached.terms;

  const terms: SeriesTerm[] = [];
  for (const related of await listSeriesNeighbors(work)) {
    terms.push(...(await loadTermsFrom(related)));
  }
  cache.set(work.id, { terms });
  return terms;
}

async function loadTermsFrom(related: RelatedWorkPath): Promise<SeriesTerm[]> {
  const neighbor = asReadOnlyWork(related);
  const sourceTitle = await titleOf(neighbor, related);
  const terms: SeriesTerm[] = [];

  const push = (
    kind: SeriesTerm["kind"],
    record: {
      name: string;
      aliases: string[];
      reading: string | null;
      spoilerLevel?: unknown;
      status?: unknown;
      isMob?: boolean;
    }
  ): void => {
    // 関門はここ1か所だけにする。種別ごとに書くと、足した種別で外れる
    if (!isShareableRecord(record)) return;
    // モブは数が多く、地の文の普通名詞と重なりやすい（色分けと同じ扱い）
    if (record.isMob) return;
    const name = record.name.trim();
    if (!name) return;
    terms.push({
      text: name,
      reading: record.reading?.trim() || null,
      kind,
      canonicalName: name,
      sourceTitle,
    });
    for (const alias of record.aliases) {
      const trimmed = alias.trim();
      if (!trimmed || trimmed === name) continue;
      // 別名の読み仮名は資料に無いので持たせない（作れない読みを捏造しない）
      terms.push({
        text: trimmed,
        reading: null,
        kind,
        canonicalName: name,
        sourceTitle,
      });
    }
  };

  // **壊れたJSONは直さない。** どのストアも `loadAll` が壊れた1件を
  // 読み飛ばして `errors` に積むので、ここでは受け取って捨てる
  // ——連結のために本筋を止めない（実装ルール2）
  try {
    for (const record of (await new CharacterStore(neighbor).loadAll())
      .characters) {
      push("character", record);
    }
  } catch {
    // 設定フォルダーごと読めないときも、その種別を飛ばして進む
  }
  try {
    for (const record of (await createLocationStore(neighbor).loadAll())
      .records) {
      push("location", record);
    }
  } catch {
    /* 同上 */
  }
  try {
    for (const record of (await createAbilityStore(neighbor).loadAll())
      .records) {
      push("ability", record);
    }
  } catch {
    /* 同上 */
  }
  try {
    for (const record of (await createOrganizationStore(neighbor).loadAll())
      .records) {
      push("organization", record);
    }
  } catch {
    /* 同上 */
  }

  return terms;
}

/**
 * 「この名前は〈教科書チート〉にもあります」と並べるための候補（6.95.3）。
 *
 * **こちらは紹介と別名まで読む。** 作者が「同じ人だ」と判断したときに
 * 写すものだからである。関門（`spoilerLevel: "public"` かつ
 * `status: "登場済み"`）は語の共有とまったく同じものを通す。
 */
export async function loadSeriesCharacterCandidates(
  work: WorkEntry
): Promise<SeriesCharacterCandidate[]> {
  const candidates: SeriesCharacterCandidate[] = [];
  for (const related of await listSeriesNeighbors(work)) {
    const neighbor = asReadOnlyWork(related);
    const sourceTitle = await titleOf(neighbor, related);
    try {
      const loaded = await new CharacterStore(neighbor).loadAll();
      for (const character of loaded.characters) {
        if (!isShareableRecord(character)) continue;
        if (character.isMob) continue;
        candidates.push({
          name: character.name,
          reading: character.reading,
          aliases: [...character.aliases],
          summary: character.summary,
          sourceTitle,
          sourceFolderName: related.folderName,
        });
      }
    } catch {
      // 読めない作品は飛ばす（候補が出ないだけで、抽出は進む）
    }
  }
  return candidates;
}

async function titleOf(
  neighbor: WorkEntry,
  related: RelatedWorkPath
): Promise<string> {
  try {
    const config = await readWorkConfig(neighbor);
    return seriesSourceTitle(related.folderName, config?.workTitle);
  } catch {
    return related.folderName;
  }
}
