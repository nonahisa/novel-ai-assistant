import { isSameBodyText } from "./bodyCompare";

/**
 * 取り込む話の番号を点検する——重複と欠番（作者の指示、2026-09-19）。
 *
 * > 同じ話が入っている場合も、製品版でも指摘できるようにしてください
 * > 話が飛んでる時も同様
 *
 * ## 止めない
 *
 * **番号が飛ぶのは普通にある**（下書きのまま・非公開・削除）。欠番を
 * 見つけたからといって取り込みを止めると、**作者が正しく持っている作品が
 * 入らなくなる。** ここがするのは知らせることだけである。
 *
 * ## 重複は、中身まで見てから言う
 *
 * 実物のアルファポリスのバックアップには、**中身まで完全に同一の話が
 * 2回入っていた**（178話「変わった面接」・179話「合格発表」）。
 * 同じものなら片方を落としても何も失わないが、**違うなら勝手に選ばない**
 * ——どちらも作者が書いた文章で、機械が捨ててよいものではない。
 *
 * 中身を比べる前に文字を揃えるのは `bodyCompare.ts` の仕事である
 * （Shift_JIS を通すと波ダッシュと全角チルダが入れ替わるため）。
 *
 * ## 1つのサイト専用にしない
 *
 * **アルファポリスで見つけた問題だが、点検は全サイト共通**である
 * （作者の指示）。なろうの合本にもカクヨムの複数ファイルにも同じ形で
 * 効く——入口（`workZip.ts`）が、どの道でもここを通す。
 *
 * VS Code API には依存しない。
 */

/** 点検にかける話1件ぶん */
export interface EpisodeNumberEntry {
  /** 読み取れた話数。**読めなければ null**（並び順で埋めない） */
  readonly number: number | null;
  /** 作者へ見せる名前（「178話　変わった面接」） */
  readonly label: string;
  /** 中身。同じ番号どうしを比べるのに使う */
  readonly body: string;
}

/** 同じ話数が2回以上あった、その1組 */
export interface DuplicateEpisodeNumber {
  readonly number: number;
  /** 何件あったか */
  readonly count: number;
  /**
   * 中身まで同じか（全件が同じときだけ true）。
   *
   * **true のときだけ「落としてよい」と言える。** false なら、
   * どちらも作者の文章なので捨てない。
   */
  readonly sameBody: boolean;
  /** その番号を名乗っていた話の名前（並び順） */
  readonly labels: readonly string[];
}

export interface EpisodeNumberReport {
  readonly duplicates: readonly DuplicateEpisodeNumber[];
  /** 抜けている話数（いちばん小さい番号といちばん大きい番号のあいだ） */
  readonly missing: readonly number[];
  /** 話数を読み取れなかった話の数（欠番の計算には混ぜていない） */
  readonly unnumbered: number;
}

/** 一覧に並べる番号の上限。これを超えたら件数だけ言う */
const LISTED_NUMBERS = 8;

export function checkEpisodeNumbers(
  entries: readonly EpisodeNumberEntry[]
): EpisodeNumberReport {
  const byNumber = new Map<number, EpisodeNumberEntry[]>();
  let unnumbered = 0;

  for (const entry of entries) {
    if (entry.number === null || !Number.isSafeInteger(entry.number)) {
      unnumbered++;
      continue;
    }
    const found = byNumber.get(entry.number);
    if (found) found.push(entry);
    else byNumber.set(entry.number, [entry]);
  }

  const duplicates: DuplicateEpisodeNumber[] = [];
  for (const [number, group] of [...byNumber.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    if (group.length < 2) continue;
    duplicates.push({
      number,
      count: group.length,
      // **全件が同じときだけ「同じ」と言う。** 3件のうち2件が同じでも、
      // 残る1件は別の文章なので、まとめて落とせる話ではない
      sameBody: group.every((entry) => isSameBodyText(entry.body, group[0].body)),
      labels: group.map((entry) => entry.label),
    });
  }

  return { duplicates, missing: missingNumbers(byNumber), unnumbered };
}

/**
 * 抜けている話数。
 *
 * **いちばん小さい番号より前は数えない。** 5話から始まる作品に
 * 「1〜4話がありません」と言うのは雑音である（作者が続きだけを
 * 書き出したのかもしれないし、そもそも1話が無いのかもしれない）。
 */
function missingNumbers(
  byNumber: ReadonlyMap<number, unknown>
): readonly number[] {
  const numbers = [...byNumber.keys()];
  if (numbers.length === 0) return [];

  const from = Math.min(...numbers);
  const to = Math.max(...numbers);
  const missing: number[] = [];
  for (let number = from + 1; number < to; number++) {
    if (!byNumber.has(number)) missing.push(number);
  }
  return missing;
}

/**
 * 作者へ見せる言葉にする（設計書6.81の規則3）。
 *
 * **何も無ければ空を返す。** 問題が無いときに「重複はありませんでした」と
 * 出しても、読むものが増えるだけである。
 *
 * @param dropped 中身まで同じなので取り込みから落とした話の名前。
 *   **落としたことは必ず言う**——黙って捨てたことにしない
 */
export function describeEpisodeNumbers(
  report: EpisodeNumberReport,
  dropped: readonly string[] = []
): string[] {
  const lines: string[] = [];

  const same = report.duplicates.filter((entry) => entry.sameBody);
  const differ = report.duplicates.filter((entry) => !entry.sameBody);

  if (same.length > 0) {
    lines.push(
      `同じ話番号が2回以上入っています：${listNumbers(
        same.map((entry) => entry.number)
      )}。中身まで同じでした。`
    );
  }
  if (dropped.length > 0) {
    lines.push(
      `そのうち ${summarizeLabels(dropped)} は、同じものなので1つだけ取り込みます。`
    );
  }
  if (differ.length > 0) {
    lines.push(
      `同じ話番号で中身が違います：${listNumbers(
        differ.map((entry) => entry.number)
      )}。` +
        // **勝手に選ばない**（作者の指示）。どちらも作者が書いた文章である
        "どちらが新しいかはファイルから分からないため、どちらも取り込みます。" +
        "取り込んだあとで、要らないほうを消してください。"
    );
  }

  if (report.missing.length > 0) {
    lines.push(
      `${listNumbers(report.missing)}が見当たりません。` +
        // 下書き・非公開・削除で番号は普通に飛ぶ。**知らせるだけ**
        "下書きや非公開の話があると番号は飛びます。そのまま取り込みます。"
    );
  }

  if (report.unnumbered > 0) {
    lines.push(
      `話数を読み取れなかった話が${report.unnumbered}件あります` +
        "（「プロローグ」など。本文はそのまま取り込みます）。"
    );
  }

  return lines;
}

/** 「10話・11話」。多いときは頭だけ並べて件数を添える */
function listNumbers(numbers: readonly number[]): string {
  const head = numbers
    .slice(0, LISTED_NUMBERS)
    .map((number) => `${number}話`)
    .join("・");
  return numbers.length > LISTED_NUMBERS
    ? `${head} ほか（ぜんぶで${numbers.length}件）`
    : head;
}

/** 名前の一覧。長くなるものなので頭だけ */
function summarizeLabels(labels: readonly string[]): string {
  const head = labels.slice(0, 3).join("・");
  return labels.length > 3 ? `${head} ほか${labels.length - 3}件` : head;
}
