import { isSameBodyText } from "./bodyCompare";
import { episodeUnit } from "./episodeLabel";
import type { WorkFormatKey } from "./workFormat";
import type { EpisodeFile } from "../models/types";

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
 * ## 作品一覧にも出す
 *
 * 登録済みの作品の話数の重複・欠番は、作品一覧の作品の行に印で出す
 * （設計書5.4.5。`checkWorkEpisodeNumbers`）。こちらは本文を読まず、
 * 走査が持っている話数だけで決める。
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
function listNumbers(
  numbers: readonly number[],
  label: (number: number) => string = (number) => `${number}話`
): string {
  const head = numbers.slice(0, LISTED_NUMBERS).map(label).join("・");
  return numbers.length > LISTED_NUMBERS
    ? `${head} ほか（ぜんぶで${numbers.length}件）`
    : head;
}

/** 名前の一覧。長くなるものなので頭だけ */
function summarizeLabels(labels: readonly string[]): string {
  const head = labels.slice(0, 3).join("・");
  return labels.length > 3 ? `${head} ほか${labels.length - 3}件` : head;
}

/* ------------------------------------------------------------------ */
/* 作品一覧に出す点検（設計書5.4.5、作者の裁定 2026-10-25 夜）          */
/* ------------------------------------------------------------------ */

/** 作品一覧の話数の点検の結果 */
export interface WorkEpisodeNumberReport {
  /** 2つ以上のファイルが名乗っている話数（小さい順） */
  readonly duplicated: readonly number[];
  /**
   * 抜けている話数。**連番の並びの中の抜けだけ**——大きく飛んだ先までの
   * 抜けは数えない（`jumps`）
   */
  readonly missing: readonly number[];
  /**
   * 大きく飛んだところ（`from` の次が `to`）。欠番には数えず、印にも出さない。
   * 作者が意図して離した番号（確かめ用の第9999話など）のことがあるため
   */
  readonly jumps: readonly { readonly from: number; readonly to: number }[];
  /** 話数の言い方（「第3話」「投稿3」）。作品の形式で変わる */
  readonly format?: WorkFormatKey;
}

/**
 * 合本1ファイルが名乗れる話数の幅の上限。
 *
 * 読み違いで「1〜999999話」のような幅が来たとき、1つずつ数えると
 * 一覧の描画が止まる。実在する作品の話数はこれに遠く届かない。
 */
const MAX_COLLECTED_SPAN = 10000;

/**
 * 直前の話数からこれ以上先の番号は「飛んだ」とみなし、欠番に数えない。
 *
 * 確かめのために置いた第9998話・第9999話までの抜けを全部数え、
 * 4話の作品に「話数の欠番9993件」と出た（実機、2026-10-25 夜）。
 * 値は「予定の話を足す」の既定の話数で使う `OUTLYING_EPISODE_GAP`
 * （`core/plotMode.ts`、作者の裁定 2026-09-26）と同じ 100 に揃える——
 * ふつうの連載で番外編や欠番がそこまで離れることはまず無く、試験や仮置きの
 * 番号（9999・1000）はそれより確実に遠い。同じ作品で「飛び離れた」の線が
 * 機能ごとに違うと作者が戸惑う。plotMode を import しないのは、取り込みの
 * 経路（`workZip.ts`）から本の設計図まで引き込まないため。
 */
const EPISODE_NUMBER_JUMP = 100;

/**
 * 作品の話の並びから、話数の重複・欠番を見つける。
 *
 * **本文を読まない。** 取り込みの点検（`checkEpisodeNumbers`）は中身まで
 * 比べるが、ここは作品一覧の描画から呼ばれる——走査が持っている話数だけで
 * 決め、ファイルを読み直さない。外のツールで名前を付け直したときに
 * 起きやすい食い違いを、作者が一覧で気づけるようにするのが目的である。
 *
 * 数えないもの（どれも数えると誤検出になる）：
 * - **本編・不明以外の種別**（プロローグ・幕間など）。別の番号の並びを持つ
 *   （`formatChapterLabel` と同じ線引き）
 * - **日付で名付けた話**（SNS記事）。番号の並びではない
 * - **話数の読めない話**。並び順で番号を埋めない
 * - **創作メモ集の作品ぜんたい**。番号が無い・飛ぶのが普通で、不備ではない（6.70）
 *
 * **合本は範囲として数える**——1〜219話の合本1ファイルに「2〜218話が無い」と
 * 言わないため。範囲が1話ずつのファイルと重なれば、重なった話数は重複である。
 */
export function checkWorkEpisodeNumbers(
  episodes: readonly Pick<
    EpisodeFile,
    "kind" | "chapterStart" | "chapterEnd" | "date"
  >[],
  format?: WorkFormatKey
): WorkEpisodeNumberReport {
  if (format === "memo") return { duplicated: [], missing: [], jumps: [], format };

  const seen = new Map<number, number>();
  for (const episode of episodes) {
    if (episode.date) continue;
    if (episode.kind !== "本編" && episode.kind !== "不明") continue;
    const start = episode.chapterStart;
    if (start === null || !Number.isSafeInteger(start)) continue;
    const end = episode.chapterEnd;
    const last =
      end !== null &&
      Number.isSafeInteger(end) &&
      end > start &&
      end - start <= MAX_COLLECTED_SPAN
        ? end
        : start;
    for (let number = start; number <= last; number++) {
      seen.set(number, (seen.get(number) ?? 0) + 1);
    }
  }

  const duplicated = [...seen.entries()]
    .filter(([, count]) => count >= 2)
    .map(([number]) => number)
    .sort((a, b) => a - b);
  return { duplicated, ...missingWithinRuns(seen), format };
}

/**
 * 連番の並びの中の抜けだけを拾う。
 *
 * 直前の話数から `EPISODE_NUMBER_JUMP` 以上先の番号では並びを切り、
 * そのあいだは欠番に数えない（`jumps` へ）。切った先でも並びは続くので、
 * 第9997話と第9999話のあいだの第9998話は欠番に数える。
 *
 * 抜けを1つずつ数えるのは切らなかった隙間だけなので、番号がどれだけ
 * 離れていても仕事の量は話の数に比例する程度で収まる。
 */
function missingWithinRuns(
  seen: ReadonlyMap<number, unknown>
): Pick<WorkEpisodeNumberReport, "missing" | "jumps"> {
  const numbers = [...seen.keys()].sort((a, b) => a - b);
  const missing: number[] = [];
  const jumps: { from: number; to: number }[] = [];
  for (let i = 1; i < numbers.length; i++) {
    const from = numbers[i - 1];
    const to = numbers[i];
    if (to - from >= EPISODE_NUMBER_JUMP) {
      jumps.push({ from, to });
      continue;
    }
    for (let number = from + 1; number < to; number++) missing.push(number);
  }
  return { missing, jumps };
}

/**
 * 作品の行の題の前に添える印（`core/workRowLabel.ts`）。**無ければ空。**
 *
 * 重複と欠番は直し方が違う（片方を改名する／抜けを確かめる）ので、
 * 別々の印にする。
 */
export function workEpisodeNumberMarks(
  report: WorkEpisodeNumberReport
): string[] {
  const marks: string[] = [];
  if (report.duplicated.length > 0) {
    marks.push(`話数の重複${report.duplicated.length}件`);
  }
  if (report.missing.length > 0) {
    marks.push(`話数の欠番${report.missing.length}件`);
  }
  return marks;
}

/** 作品の行のホバーに並べる行（Markdown の箇条書き）。**無ければ空** */
export function describeWorkEpisodeNumbers(
  report: WorkEpisodeNumberReport
): string[] {
  const unit = episodeUnit(report.format);
  const label = (number: number): string => unit.label(number);
  const lines: string[] = [];
  if (report.duplicated.length > 0) {
    lines.push(
      `- 話数の重複: ${listNumbers(report.duplicated, label)}` +
        "（同じ話数のファイルが2つ以上あります。名前の付け直しで重なっていないか確かめてください）"
    );
  }
  if (report.missing.length > 0) {
    lines.push(
      `- 話数の欠番: ${listNumbers(report.missing, label)}` +
        // 下書き・非公開で番号は普通に飛ぶ。**知らせるだけ**で、直せとは言わない
        "（下書きや非公開の話があると番号は飛びます。名前の付け直しで抜けていないか確かめてください）"
    );
  }
  // 飛びは印に出さない（意図して離した番号のことがある）。ホバーで欠番に
  // 数えなかったことだけ言い、名前の付け直しの誤りなら作者が気づけるようにする
  const jumps = report.jumps;
  for (const jump of jumps.slice(0, 3)) {
    lines.push(
      `- ${label(jump.from)}のあと${label(jump.to)}へ飛んでいます（欠番には数えていません）`
    );
  }
  if (jumps.length > 3) {
    lines.push(`- ほかに${jumps.length - 3}か所、番号が大きく飛んでいます（欠番には数えていません）`);
  }
  return lines;
}
