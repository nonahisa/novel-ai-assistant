import * as path from "./pathText";
import type { SeriesConfig } from "../models/types";

/**
 * シリーズ作品を、設定資料でゆるくつなぐ（設計書6.95）。
 *
 * 作者の言葉（2026-09-19）：「シリーズ作品は設定資料等でゆるくつなぐ機能が
 * あってもいいですね」。**裁定は「人物の候補まで」**。
 *
 * ## ここには判断だけを置く
 *
 * 相手のフォルダーを実際に読むのは `seriesSettings.ts`、訊くのは
 * `features/setSeries.ts`。**判断を分けておくと、画面を押さずに測れる**
 * （`libraryHome.ts` と同じ作り）。場所の文字列も、`vscode` を連れてこない
 * `pathText.ts` を直に指す。
 *
 * ## 合体させない
 *
 * 資料を1つに統合すると、片方で走らせた抽出が、もう片方で作者が手を入れた
 * レコードを書き換えうる（実装ルール2の守りは作品フォルダーの中で閉じている）。
 * **読むのは片方向、書き戻さない。** 相手のファイルは1バイトも触らない。
 */

/** つないだ相手1つ。名前と、自分の親から辿って組み立てた場所 */
export interface RelatedWorkPath {
  /** `config.json` に書いてあるフォルダー名 */
  readonly folderName: string;
  /** 自分の親フォルダーの下に組み立てた場所 */
  readonly folderPath: string;
}

/**
 * 相手から借りてよい語（設計書6.95.3）。
 *
 * **紹介・性格・外見の欄を持たない。** 型に無ければ、うっかり詰めることも
 * できない——**ネタバレが漏れないことを、構造で保証している。**
 */
export interface SeriesTerm {
  /** 本文に現れる文字列（正式名称か別名） */
  readonly text: string;
  /** 読み仮名。無ければ null */
  readonly reading: string | null;
  readonly kind: "character" | "location" | "ability" | "organization";
  /** その語の正式名称（別名で当たったときに本来の名前を示す） */
  readonly canonicalName: string;
  /** どの作品から借りたか。画面に出どころを出すために持つ */
  readonly sourceTitle: string;
}

/**
 * 「同じ人ですか」と訊くための候補1件（設計書6.95.3）。
 *
 * こちらは**紹介と別名を持つ**。作者が「同じ人だ」と判断したときだけ
 * 写すものなので、語の共有（`SeriesTerm`）とは型ごと分けてある。
 */
export interface SeriesCharacterCandidate {
  readonly name: string;
  readonly reading: string | null;
  readonly aliases: readonly string[];
  readonly summary: string | null;
  /** 相手の作品の題（画面に出す） */
  readonly sourceTitle: string;
  /** 相手のフォルダー名（同じ題の作品が2つあっても見分けられるように） */
  readonly sourceFolderName: string;
}

/**
 * `spoilerLevel` を越えないための関門（設計書6.95.3）。
 *
 * **読むのは `spoilerLevel: "public"` かつ `status: "登場済み"` のものだけ。**
 * 本編の先の設定が、まだそこまで書いていない別視点へ漏れないようにする。
 * 欄が欠けている（古い形の）レコードは**読まない側に倒す**——「書いていない
 * から公開してよい」と読むと、守りが黙って外れる。
 */
export function isShareableRecord(record: {
  spoilerLevel?: unknown;
  status?: unknown;
}): boolean {
  return record.spoilerLevel === "public" && record.status === "登場済み";
}

/**
 * `config.json` の `series` を読む。
 *
 * **壊れていても投げない**（`parseAnnounceConfig` と同じ扱い）。ここは
 * 「あると嬉しい」味付けであって、手で書き間違えたせいで作品そのものが
 * 開けなくなるほうが困る。読めない形なら `series` ごと無かったことにする。
 *
 * **パスらしいものは弾く。** `related` に絶対パスや `..` を書かれても
 * 受け取らない——同期した先の機械で別の場所を指すうえ、作品フォルダーの
 * 外を読みに行く道を残さないため。
 */
export function parseSeriesConfig(raw: unknown): SeriesConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string") return undefined;
  if (!Array.isArray(value.related)) return undefined;

  const name = value.name.trim();
  if (!name) return undefined;

  const related = [
    ...new Set(
      value.related
        .filter((item: unknown): item is string => typeof item === "string")
        .map((item: string) => item.trim())
        .filter((item: string) => isPlainFolderName(item))
    ),
  ];
  if (related.length === 0) return undefined;

  return { name, related };
}

/**
 * ただのフォルダー名か（区切り・親への遡り・ドライブ名を含まないか）。
 *
 * 相手は**書庫の中の隣り合わせ**としてしか指せない。ここを緩めると、
 * `config.json` に書かれた文字列がそのまま読み先になる。
 */
export function isPlainFolderName(name: string): boolean {
  if (!name) return false;
  if (name === "." || name === "..") return false;
  if (/[\\/]/.test(name)) return false;
  if (path.isAbsolute(name)) return false;
  return true;
}

/**
 * つないだ相手の場所を、自分の親フォルダーから組み立てる。
 *
 * **自分自身は外す。** 自分のフォルダー名を書かれても、自分の資料を
 * 二重に読むだけで意味がない。
 */
export function resolveRelatedWorkPaths(
  selfFolderPath: string,
  series: SeriesConfig | undefined
): RelatedWorkPath[] {
  if (!series) return [];
  const normalizedSelf = path.normalize(selfFolderPath);
  const parent = path.dirname(normalizedSelf);
  // 作品フォルダーが根そのもの（`C:/` など）なら、隣は無い
  if (!parent || parent === normalizedSelf) return [];
  const selfName = path.basename(normalizedSelf);

  const resolved: RelatedWorkPath[] = [];
  const seen = new Set<string>();
  for (const folderName of series.related) {
    if (!isPlainFolderName(folderName)) continue;
    if (folderName === selfName) continue;
    const folderPath = path.join(parent, folderName);
    const key = path.normalizeForComparison(folderPath);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ folderName, folderPath });
  }
  return resolved;
}

/**
 * 抽出で出た新しい人物の名前が、相手にもあるか（設計書6.95.3）。
 *
 * **合体はしない。** ここが返すのは「並べる候補」だけで、写すかどうかは
 * 作者が決める——同姓同名は実際にあるので、機械が決めてよいことではない。
 *
 * 別名まで見るのは、同じ人物が作品によって違う呼ばれ方で登録されている
 * ことがあるためである（本編では「イント」、別視点では「坊ちゃん」）。
 */
export function findSeriesCharacterMatches(
  newName: string,
  candidates: readonly SeriesCharacterCandidate[]
): SeriesCharacterCandidate[] {
  const target = newName.trim();
  if (!target) return [];
  return candidates.filter(
    (candidate) =>
      candidate.name.trim() === target ||
      candidate.aliases.some((alias) => alias.trim() === target)
  );
}

/**
 * 作者が「同じ人だ」と言ったときに写す内容（設計書6.95.3）。
 *
 * **参照ではなく写し。** あとで別々に育てられるようにするためで、
 * 相手のレコードとつながったままにはしない。
 *
 * **すでに埋まっている欄は触らない。** こちらの作品で作者が書いたものが
 * 相手の値で押し流されるのは、実装ルール2が禁じていることである。
 * 別名は重ねずに足す（順は既にあるものが先）。
 */
export function copyFromSeriesCandidate<
  T extends {
    name: string;
    reading: string | null;
    summary: string | null;
    aliases: string[];
  },
>(target: T, candidate: SeriesCharacterCandidate): T {
  const aliases = [...target.aliases];
  for (const alias of candidate.aliases) {
    const trimmed = alias.trim();
    // 本人の名前そのものを別名に足すと、一覧に同じ語が2つ並ぶ
    if (!trimmed || trimmed === target.name.trim()) continue;
    if (!aliases.includes(trimmed)) aliases.push(trimmed);
  }
  return {
    ...target,
    reading: target.reading?.trim() ? target.reading : candidate.reading,
    summary: target.summary?.trim() ? target.summary : candidate.summary,
    aliases,
  };
}

/**
 * 書庫の中で、登録し終えた作品の隣に並んでいる作品を返す。
 *
 * 「隣」は**同じ親フォルダーの子**である（設計書6.95.2）。書庫に入って
 * いない作品はつながらない——それでよい。**つなげるために作者の置き場を
 * 動かさせない。**
 */
export function findSiblingWorks<T extends { folderPath: string }>(
  works: readonly T[],
  self: { folderPath: string }
): T[] {
  // 自分かどうかは登録簿の重複の見方と同じ鍵で見る（2026-09-24）。
  // 親も、前後の空白と末尾の区切りを落として整えた形から取る
  const normalizedSelf = path.tidyFolderPath(self.folderPath);
  const selfKey = path.folderKeyForComparison(normalizedSelf);
  const parentKey = path.normalizeForComparison(path.dirname(normalizedSelf));
  return works.filter((work) => {
    const normalized = path.tidyFolderPath(work.folderPath);
    if (path.folderKeyForComparison(normalized) === selfKey) return false;
    return path.normalizeForComparison(path.dirname(normalized)) === parentKey;
  });
}

/**
 * 登録したときに、シリーズのつながりを気づかせるか（設計書6.95.4）。
 *
 * **初回の1度だけ。** 訊きすぎると邪魔になる（`shouldOfferLibraryMerge` と
 * 同じ筋）。断った作者に作品が増えるたび言えば小言になる。
 *
 * **すでにつないである作品では訊かない。** 作者はもう知っている。
 *
 * 隣に作品が並んでいることだけを条件にしてある。**名前が似ていることは
 * 条件にしない**——実例の『教科書チート』と『転生した受験生の異世界
 * 成り上がり　～別視点バージョン～』は、同じ世界・同じ人物なのに
 * 名前が1文字も重なっていない。似た名前で絞ると、いちばん役に立つ組を
 * 取りこぼす。
 */
export function shouldOfferSeriesLink(input: {
  readonly works: readonly { folderPath: string }[];
  readonly added: { folderPath: string };
  readonly addedHasSeries: boolean;
  readonly alreadyOffered: boolean;
}): boolean {
  if (input.alreadyOffered) return false;
  if (input.addedHasSeries) return false;
  return findSiblingWorks(input.works, input.added).length > 0;
}

/**
 * 相手の作品の題を推す。
 *
 * `config.json` が読めれば `workTitle`、読めなければフォルダー名。
 * **読めないことを理由に止めない**——題が少し素っ気なくなるだけである。
 */
export function seriesSourceTitle(
  folderName: string,
  workTitle: string | undefined
): string {
  const trimmed = workTitle?.trim();
  return trimmed ? trimmed : folderName;
}
