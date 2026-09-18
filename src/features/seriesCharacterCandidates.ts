import * as vscode from "vscode";
import type { Character } from "../models/character";
import type { WorkEntry } from "../models/types";
import { CharacterStore } from "../core/characterStore";
import { loadSeriesCharacterCandidates } from "../core/seriesSettings";
import {
  copyFromSeriesCandidate,
  findSeriesCharacterMatches,
  type SeriesCharacterCandidate,
} from "../core/seriesLink";
import { logFailure, logStep, useLogFile } from "../core/logger";

/**
 * 抽出で出た新しい人物に、シリーズの作品の同名を候補として並べる（6.95.3）。
 *
 * ## 自動で合体させない
 *
 * **既定は「別人として扱う」。** どれも選ばれていない状態で開き、作者が
 * 選ばなければ何も起きない。同姓同名は実際にあるので、機械が決めてよい
 * ことではない（設計書6.95.3）。
 *
 * ## 写しであって、参照ではない
 *
 * 「同じ人だ」と言われたときに写すのは、相手の紹介・読み仮名・別名だけ。
 * **写したあとは、2つのレコードは別々に育つ**——つながったままにすると、
 * 片方の抽出がもう片方の作者の書き込みを押し流す道ができてしまう。
 *
 * ## 埋まっている欄は触らない
 *
 * 写すのは空いている欄だけである（`copyFromSeriesCandidate`）。
 * 作者がこの作品で書いたものを、相手の値で上書きしない（実装ルール2）。
 */

/** 並べる候補1件。人物1人に複数の相手が当たることもある */
interface MatchPair {
  readonly character: Character;
  readonly candidate: SeriesCharacterCandidate;
}

export interface SeriesMatchResult {
  /** 並べた候補の数 */
  offered: number;
  /** 作者が「同じ人だ」と言って写した人物の数 */
  copied: number;
}

/**
 * 候補を組み立てる。**画面を出さないので、単体で測れる。**
 *
 * 1人の人物に相手が複数当たることもある（同じ名前が別の作品に2人）。
 * 全部並べて作者に選ばせる——どれが同じ人かは、機械には決められない。
 */
export function buildSeriesMatchPairs(
  newCharacters: readonly Character[],
  candidates: readonly SeriesCharacterCandidate[]
): MatchPair[] {
  const pairs: MatchPair[] = [];
  for (const character of newCharacters) {
    // モブは数が多く、同名がいくらでも出る。候補にしない
    if (character.isMob) continue;
    for (const candidate of findSeriesCharacterMatches(
      character.name,
      candidates
    )) {
      pairs.push({ character, candidate });
    }
  }
  return pairs;
}

export async function offerSeriesCharacterMatches(
  work: WorkEntry,
  newCharacters: readonly Character[]
): Promise<SeriesMatchResult> {
  const empty: SeriesMatchResult = { offered: 0, copied: 0 };
  if (newCharacters.length === 0) return empty;

  // 記録はこの作品のログファイルへ。出力チャンネルだけだと、
  // VS Code を閉じた時点で「何を写したか」の手がかりが消える
  useLogFile(work.folderPath);

  let candidates: SeriesCharacterCandidate[];
  try {
    candidates = await loadSeriesCharacterCandidates(work);
  } catch (error) {
    // つながりの読み取りで抽出を止めない（味付けであって前提ではない）
    logFailure("シリーズの人物候補の読み取り", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
  if (candidates.length === 0) return empty;

  const pairs = buildSeriesMatchPairs(newCharacters, candidates);
  if (pairs.length === 0) return empty;

  type PairItem = vscode.QuickPickItem & { pair: MatchPair };
  const items: PairItem[] = pairs.map((pair) => ({
    label: pair.character.name,
    description: `${pair.candidate.sourceTitle}にも同じ名前があります`,
    detail: describeCandidate(pair.candidate),
    // **既定は選ばれていない。** 既定で入れると、押し切っただけで合体する
    picked: false,
    pair,
  }));

  const chosen = await vscode.window.showQuickPick<PairItem>(items, {
    title: "シリーズの作品にも同じ名前があります",
    placeHolder:
      "同じ人物だと思うものだけ選んでください。選ばなければ別人のままです",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  // Esc も「選ばなかった」も同じ扱い。何もしない
  if (!chosen || chosen.length === 0) {
    return { offered: pairs.length, copied: 0 };
  }

  const store = new CharacterStore(work);
  // **保存前に読み直す。** `saveOrUpdate` は読み込んだ控えで新規か既存かを
  // 決めるので、ここで読んでおかないと必ず新規作成として失敗する
  const loaded = await store.loadAll();
  const byId = new Map(loaded.characters.map((record) => [record.id, record]));

  let copied = 0;
  for (const item of chosen) {
    const current = byId.get(item.pair.character.id);
    if (!current) continue;
    const updated = copyFromSeriesCandidate(current, item.pair.candidate);
    try {
      await store.saveOrUpdate(updated);
      byId.set(updated.id, updated);
      copied++;
      logStep(
        `シリーズから写した: ${updated.name} ← ${item.pair.candidate.sourceTitle}`
      );
    } catch (error) {
      // 1人の失敗で残りを止めない。何が写せなかったかは記録に残す
      logFailure("シリーズの人物の写し", {
        人物: updated.name,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (copied > 0) {
    void vscode.window.showInformationMessage(
      `${copied}名に、シリーズの作品の紹介と読み仮名を写しました。` +
        "これ以降は別々の資料として育ちます（相手の資料は変えていません）。"
    );
  }
  return { offered: pairs.length, copied };
}

/**
 * 候補の説明。**相手の紹介を出す。**
 *
 * ここは「写すかどうか」を決める画面なので、写す中身が見えないと判断できない。
 * 出すのは `spoilerLevel: "public"` かつ `status: "登場済み"` の人物だけ
 * なので、まだ書いていない先の設定は出てこない（設計書6.95.3の関門）。
 */
function describeCandidate(candidate: SeriesCharacterCandidate): string {
  const parts: string[] = [];
  if (candidate.reading?.trim()) parts.push(`読み ${candidate.reading.trim()}`);
  if (candidate.summary?.trim()) parts.push(candidate.summary.trim());
  if (candidate.aliases.length > 0) {
    parts.push(`別名 ${candidate.aliases.join("、")}`);
  }
  return parts.length > 0 ? parts.join(" / ") : "紹介はまだありません";
}
