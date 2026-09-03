import * as path from "./paths";
import { parseEpisodeFileName, sanitizeFileName } from "./episodeParser";
import { normalizeEpisodePath, type Chapter } from "../models/chapter";
import type { Character } from "../models/character";
import type {
  RecordChange,
  RecordConflict,
} from "../models/jsonValidation";
import type { BookIllustration, BookPageBreak } from "../models/book";

/**
 * 話数の付け替え（設計書6.67）。
 *
 * **本文の中身には一切触れない。** ここで決めるのは「どのファイルを何と
 * いう名前にするか」と「話数を指している台帳をどうずらすか」だけである。
 * 名前の変更と本文の書き換えを混ぜると、Gitが改名として見抜けなくなり、
 * GitHub上で履歴が切れる（6.67.1）。
 *
 * VS Code API にも `node:` にも依存しない。ブラウザ版でも同じ計画を作れる
 * ようにするためと、実際にファイルを動かさずに単体テストで確かめるためで
 * ある（実行の口は `applyRenumberPlan` に注入する）。
 */

/** 付け替えの対象になりうる話。走査結果から必要なものだけを受け取る */
export interface RenumberEpisode {
  filePath: string;
  fileName: string;
  /**
   * 1つのファイルに何話も入っている（合本）ときの、中の話数。合本でなければ null。
   *
   * **名前に範囲が無くても合本は動かさない。** なろうの一括ダウンロードは
   * `001.txt` のような単話と見分けの付かない名前で全話を入れてくる。
   * 名前だけを見て動かすと、中に書かれた219話ぶんの話数と食い違う。
   */
  collectedCount?: number | null;
}

/** 動かさなかった理由 */
export type SkipReason =
  /** 話数の範囲を持つ（合本）。片方だけ動かすことができない */
  | "range"
  /** ファイル名のどこが話数か決められない */
  | "ambiguous";

export interface SkippedEpisode {
  fileName: string;
  reason: SkipReason;
  /** 作者に見せる言葉 */
  detail: string;
}

export interface EpisodeRename {
  fromPath: string;
  toPath: string;
  fromFileName: string;
  toFileName: string;
  oldNumber: number;
  newNumber: number;
}

export interface RenumberPlan {
  /** 付け替えの基準になる話数（挿入する位置／削除する話の話数） */
  pivot: number;
  /** ずらす向き。+1 が挿入、−1 が削除 */
  delta: 1 | -1;
  /**
   * 対象のフォルダー。**基準の話と同じフォルダーの話しか動かさない**。
   *
   * 番外編や下書きは、本編とは別の番号で並んでいることが多い。作品の
   * 下を全部まとめて動かすと、**巻き込まれた番外編の番号が黙ってずれる**。
   */
  folder: string;
  /**
   * **実行する順に並んでいる**（6.67.2）。
   * 挿入（+1）は後ろから降順、削除（−1）は前から昇順。
   * 逆順で動かすと、先に居る相手のファイルを踏む。
   */
  renames: EpisodeRename[];
  /** 話数を持つのに動かせなかった話。理由つきで作者に見せる */
  skipped: SkippedEpisode[];
  /**
   * そもそも話数を持たない話（プロローグ・幕間・日付名・判定不能）。
   *
   * **これは異常ではない。** 番号を持たないものは番号がずれようがない
   * ので動かさないだけである。確認の場で「そのままです」と言うために持つ。
   */
  unnumbered: string[];
  /**
   * 付け替え先が、動かない話の名前とぶつかるもの。
   *
   * 実行してみれば分かるが、**始めてしまってからでは遅い**。
   * 途中で止まると話数が飛んだままになるので、始める前に断れるようにする。
   */
  collisions: EpisodeRename[];
}

/**
 * 話数を数字で持っている台帳をどうずらすか。
 *
 * **「pivot より後ろを ±1」という算術ではなく、実際に動いた話の対応表で
 * 動かす**（設計書6.67.3）。算術で動かすと、次の2つが黙って壊れる。
 *
 *   1. 付け替えが途中で止まったとき、**台帳だけが最後まで進む**
 *   2. 合本や名前の読めない話（`skipped`）は原稿が動いていないのに、
 *      台帳のその話数だけがずれる
 */
export interface EpisodeShift {
  /**
   * 旧話数 → 新話数。**実際に動いた話だけ**が入る（`outcome.done` から作る）。
   * **ここに無い話数は1つも触らない。**
   */
  moved: ReadonlyMap<number, number>;
  /**
   * 削除された話数。**その番号は台帳から落とす**。
   *
   * 残しておくと、詰めたあとに同じ番号へ来た**別の話**を指してしまう。
   * 落ちるのは「その話に出ていた」という事実だけで、**値（髪の色などの
   * 記述）は1つも消えない**——値は親のレコードが持っているからである。
   */
  removed?: number;
}

/** 半角へ揃えた数字。全角で名付けている作品があるので、比べる前に通す */
function toHalfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

function toFullWidthDigits(value: string): string {
  return value.replace(/[0-9]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0xfee0)
  );
}

/**
 * ファイル名の**話数の部分だけ**を差し替える。
 *
 * 置き換えるのは最初の数字の並び1か所だけで、区切りもサブタイトルも
 * 前置きも1文字も触らない。`007_湖畔の誓い.txt` は `008_湖畔の誓い.txt`
 * になり、`第12話 再会.md` は `第13話 再会.md` になる。
 *
 * **書き方を変えない。** ゼロ埋めしてある名前はゼロ埋めのまま、全角で
 * 書いてある名前は全角のまま返す。作者が選んだ書き方は、付け替えの
 * ついでに拡張機能が決め直してよいものではない。
 *
 * 話数を持たない名前（プロローグ・日付名）と、名前のどこが話数なのか
 * 決められない名前では null を返す。**当て推量で動かさない。**
 */
export function renameWithNumber(
  fileName: string,
  newNumber: number
): string | null {
  const parsed = parseEpisodeFileName(fileName);
  if (!isSingleNumbered(fileName)) return null;
  const current = parsed.chapterStart;
  if (current === null) return null;

  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);

  const found = /[0-9０-９]+/.exec(base);
  if (!found) return null;

  const run = found[0];
  // 解析結果と食い違うなら、そこは話数ではない。名前の別の場所を
  // 探しにいくより、動かさずに作者へ回すほうが安全である
  if (parseInt(toHalfWidthDigits(run), 10) !== current) return null;

  const fullWidth = /^[０-９]+$/.test(run);
  // ゼロ埋めしてある名前だけ桁を保つ。「第10話」を9へ詰めるときに
  // 「第09話」になると、作者の書き方が勝手に変わる
  const zeroPadded = /^[0０]/.test(run) && run.length > 1;
  let replacement = String(newNumber).padStart(zeroPadded ? run.length : 1, "0");
  if (fullWidth) replacement = toFullWidthDigits(replacement);

  return (
    base.slice(0, found.index) +
    replacement +
    base.slice(found.index + run.length) +
    ext
  );
}

/** ファイル名の書き方。**作者が選んだ形をそのまま写し取る** */
export interface EpisodeNameStyle {
  /** 番号までの部分（`003`／`第3話`／`ep03`）。桁も全角も書いてあるまま */
  numberPart: string;
  /** 番号とサブタイトルのあいだの区切り。隣にサブタイトルが無ければ null */
  separator: string | null;
  /** 拡張子（`.txt`／`.md`） */
  ext: string;
}

/** サブタイトルの前に置かれる区切り（`episodeParser` の読みと同じ並び） */
const SEPARATORS = /[\s_.．・-]+$/;

/**
 * ファイル名から書き方を読み取る（設計書6.67.4）。
 *
 * **番号の部分は差し替えない。** 読み取るのは隣の話の名前で、その番号は
 * これから作る話の番号と同じ（挿入位置に居た話だから）である。作り直すと
 * ゼロ埋めや全角の書き方が変わってしまう。
 *
 * 話数を持たない名前・サブタイトルの位置を決められない名前では null。
 * **当て推量で作らない**（`renameWithNumber` と同じ構え）。
 */
export function episodeNameStyleOf(fileName: string): EpisodeNameStyle | null {
  if (!isSingleNumbered(fileName)) return null;
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const subtitle = parseEpisodeFileName(fileName).subtitle;
  if (!subtitle) return { numberPart: base, separator: null, ext };

  const index = base.lastIndexOf(subtitle);
  if (index <= 0) return null;
  const numberPart = base.slice(0, index).replace(SEPARATORS, "");
  if (!numberPart) return null;
  return { numberPart, separator: base.slice(numberPart.length, index), ext };
}

/** サブタイトルを付けるときの既定の区切り（`episodeRename.ts` と同じ） */
const DEFAULT_SEPARATOR = "_";

/**
 * 挿入する新しい話のファイル名を決める（設計書6.67.4）。
 *
 * **作品のファイル名の流儀は、作品自身がいちばん知っている。** 設定
 * （`episodeNumberDigits`／`episodeFileExtension`）は、まだ話が1つも
 * 無いときの初期値である。`第3話 再会.md` で書いている作品に `003.txt` を
 * 作ると、その1話だけ書き方が違う話が混ざり、並びも読み方も揃わなくなる。
 *
 * @param neighborFileName 挿入位置に居た話の名前（付け替え**前**）。
 *   無い・読めないときだけ `fallback` の設定から作る
 */
export function insertedEpisodeFileName(input: {
  neighborFileName: string | null;
  number: number;
  subtitle: string;
  fallback: { digits: number; extension: string };
}): string {
  const style = input.neighborFileName
    ? episodeNameStyleOf(input.neighborFileName)
    : null;
  const numberPart =
    style?.numberPart ??
    String(input.number).padStart(input.fallback.digits, "0");
  const ext = style?.ext ?? input.fallback.extension;
  const cleaned = sanitizeFileName(input.subtitle).trim();
  if (!cleaned) return `${numberPart}${ext}`;
  // 隣にサブタイトルが無ければ、どの区切りを好むのかは分からない
  return `${numberPart}${style?.separator ?? DEFAULT_SEPARATOR}${cleaned}${ext}`;
}

/**
 * 単話の話数を1つだけ持つ話か。
 *
 * 日付で名付けたもの（SNS記事）・プロローグや幕間・話数の範囲（合本）は
 * 番号の並びの一員ではないので、付け替えの対象にしない
 * （`episodeParser` の読みにそのまま従う）。
 */
function isSingleNumbered(fileName: string): boolean {
  const parsed = parseEpisodeFileName(fileName);
  return (
    parsed.kind === "本編" &&
    parsed.date === null &&
    parsed.chapterStart !== null &&
    parsed.chapterStart === parsed.chapterEnd
  );
}

/**
 * 何話ぶんかが1つに入っているファイル（合本）か。
 *
 * **判断の材料は2つある。** 名前に範囲が書いてあるもの（`003-005_合本.txt`）
 * と、名前は単話に見えるのに中身が合本のもの（走査が数えた `collectedCount`）。
 * 片方だけ見ていると、なろうの一括ダウンロード（`001.txt` に全話）が
 * 単話として動かされ、中に書かれた話数と食い違う。
 */
function isCollected(episode: RenumberEpisode): boolean {
  if ((episode.collectedCount ?? 0) > 1) return true;
  const parsed = parseEpisodeFileName(episode.fileName);
  return (
    parsed.chapterStart !== null &&
    parsed.chapterEnd !== null &&
    parsed.chapterStart !== parsed.chapterEnd
  );
}

/** その話の話数。持たなければ null */
export function episodeNumberOf(fileName: string): number | null {
  return isSingleNumbered(fileName)
    ? parseEpisodeFileName(fileName).chapterStart
    : null;
}

/**
 * この話の前に1話ぶん割り込ませる計画（6.67.2）。
 *
 * @param position 挿入する位置の話数。**この話数以降が後ろへずれる**
 * @param folder 対象のフォルダー。**基準の話と同じフォルダーの話だけ**を動かす
 */
export function planInsertion(
  episodes: readonly RenumberEpisode[],
  position: number,
  folder: string
): RenumberPlan {
  return buildPlan(episodes, {
    pivot: position,
    delta: 1,
    folder,
    affects: (n) => n >= position,
  });
}

/**
 * この話を抜いて、後ろを詰める計画（6.67.2）。
 *
 * 消す話は**パスで指す**。同じ話数のファイルが2つある作品でも、
 * どちらを消すのか取り違えないためである。
 *
 * @throws 指した話が話数を持たないとき（詰める基準を決められない）
 */
export function planRemoval(
  episodes: readonly RenumberEpisode[],
  targetFilePath: string
): RenumberPlan {
  const target = episodes.find(
    (episode) =>
      path.normalizeForComparison(episode.filePath) ===
      path.normalizeForComparison(targetFilePath)
  );
  const fileName = target?.fileName ?? path.basename(targetFilePath);
  if (target && isCollected(target)) {
    // 合本の中には何話も入っている。1つ消して後ろを1つ詰めても、
    // 中の話数とは合わない（6.67.2の「合本は動かさない」と同じ理由）
    throw new Error(
      `「${fileName}」は複数の話がまとまったファイル（合本）です。` +
        "話数を詰められないため、先に「合本を話ごとに分ける」をお試しください。"
    );
  }
  const number = episodeNumberOf(fileName);
  if (number === null) {
    throw new Error(
      `「${fileName}」は話数を持たないため、後ろの話数を詰められません。`
    );
  }

  return buildPlan(
    // 消す話そのものは付け替えの対象でも、ぶつかりの相手でもない
    episodes.filter((episode) => episode !== target),
    {
      pivot: number,
      delta: -1,
      folder: path.dirname(target?.filePath ?? targetFilePath),
      affects: (n) => n > number,
    }
  );
}

function buildPlan(
  allEpisodes: readonly RenumberEpisode[],
  spec: {
    pivot: number;
    delta: 1 | -1;
    folder: string;
    affects: (n: number) => boolean;
  }
): RenumberPlan {
  /*
    **同じフォルダーの話だけを相手にする**（6.67.4）。番外編・下書き・
    連載中の別作品が下の階層に並んでいることがあり、それぞれ独自の番号で
    並んでいる。まとめて動かすと、作者が触っていない番号までずれる。
  */
  const folderKey = path.normalizeForComparison(spec.folder);
  const episodes = allEpisodes.filter(
    (episode) =>
      path.normalizeForComparison(path.dirname(episode.filePath)) === folderKey
  );

  const renames: EpisodeRename[] = [];
  const skipped: SkippedEpisode[] = [];
  const unnumbered: string[] = [];
  /**
   * 動かないファイルの場所。ぶつかりの相手になる。
   *
   * **名前ではなく場所で覚える。** 走査は下の階層まで見るので、
   * 「番外編/003.txt」と「本文/003.txt」が名前だけでは同じに見える。
   */
  const stationary = new Set<string>();

  for (const episode of episodes) {
    if (isCollected(episode)) {
      // 合本は中の各話のタイトルにも話数が書かれている。ファイル名だけ
      // 動かすと中身と食い違うが、**本文には触れない**約束なので直せない
      skipped.push({
        fileName: episode.fileName,
        reason: "range",
        detail:
          "複数の話がまとまったファイル（合本）です。" +
          "話数の付け替えでは動かしません。先に「合本を話ごとに分ける」をお試しください。",
      });
      stationary.add(path.normalizeForComparison(episode.filePath));
      continue;
    }

    const number = episodeNumberOf(episode.fileName);

    if (number === null) {
      unnumbered.push(episode.fileName);
      stationary.add(path.normalizeForComparison(episode.filePath));
      continue;
    }

    if (!spec.affects(number)) {
      stationary.add(path.normalizeForComparison(episode.filePath));
      continue;
    }

    const newNumber = number + spec.delta;
    const toFileName = renameWithNumber(episode.fileName, newNumber);
    if (!toFileName) {
      skipped.push({
        fileName: episode.fileName,
        reason: "ambiguous",
        detail:
          "ファイル名のどこが話数なのか決められませんでした。手で付け替えてください。",
      });
      stationary.add(path.normalizeForComparison(episode.filePath));
      continue;
    }

    renames.push({
      fromPath: episode.filePath,
      toPath: path.join(path.dirname(episode.filePath), toFileName),
      fromFileName: episode.fileName,
      toFileName,
      oldNumber: number,
      newNumber,
    });
  }

  // **挿入は後ろから、削除は前から**（6.67.2）。先に居る相手を踏まない
  renames.sort((left, right) =>
    spec.delta > 0
      ? right.oldNumber - left.oldNumber
      : left.oldNumber - right.oldNumber
  );

  return {
    pivot: spec.pivot,
    delta: spec.delta,
    folder: spec.folder,
    renames,
    skipped,
    unnumbered,
    collisions: findCollisions(renames, stationary),
  };
}

/**
 * 付け替え先がぶつかるもの。
 *
 * 2通りある。**どちらも実行してみれば分かるが、始めてからでは遅い。**
 * 途中で止まれば話数が飛んだままになる。
 *
 *   1. 動かない話が、その場所に居座っている
 *   2. **2つの話が同じ名前へ行き着く**（「9.txt」と「09.txt」は
 *      どちらも第9話で、1つずらすと両方 10.txt になる）
 */
function findCollisions(
  renames: readonly EpisodeRename[],
  stationary: ReadonlySet<string>
): EpisodeRename[] {
  const targets = new Map<string, number>();
  for (const rename of renames) {
    const key = path.normalizeForComparison(rename.toPath);
    targets.set(key, (targets.get(key) ?? 0) + 1);
  }
  return renames.filter((rename) => {
    const key = path.normalizeForComparison(rename.toPath);
    return stationary.has(key) || (targets.get(key) ?? 0) > 1;
  });
}

export interface RenumberOutcome {
  /** 済んだもの。**順番どおり**なので、どこまで進んだかが読める */
  done: EpisodeRename[];
  /** 途中で止まったところ。最後まで進めば undefined */
  stoppedAt?: { rename: EpisodeRename; detail: string };
}

/**
 * 計画を実行する。**1件でも失敗したらそこで止める**（6.67.2）。
 *
 * 続きを試すと、失敗した話の番号へ後続が乗り上げて上書きになる。
 * 途中で止まっても話数が飛ぶだけで、**本文は1文字も失われない**。
 *
 * 実際に動かす口は注入する。テストでファイルを作らずに順序と
 * 止まり方を確かめるためと、`vscode` をこの層へ持ち込まないためである。
 */
export async function applyRenumberPlan(
  plan: RenumberPlan,
  rename: (fromPath: string, toPath: string) => Promise<void>
): Promise<RenumberOutcome> {
  const done: EpisodeRename[] = [];
  for (const item of plan.renames) {
    try {
      await rename(item.fromPath, item.toPath);
    } catch (error) {
      return {
        done,
        stoppedAt: {
          rename: item,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    done.push(item);
  }
  return { done };
}

/**
 * 済んだ付け替えから「旧パス → 新パス」の対応表を作る。
 *
 * 台帳が話を指すのは**作品フォルダからの相対パス**（章立て・挿絵）なので、
 * ここで相対に直しておく。**済んだものだけ**を渡すこと——途中で止まった
 * 分まで書き換えると、台帳が実在しないファイルを指す。
 */
export function relativeMoves(
  done: readonly EpisodeRename[],
  toRelative: (filePath: string) => string
): Map<string, string> {
  const moves = new Map<string, string>();
  for (const item of done) {
    moves.set(
      normalizeEpisodePath(toRelative(item.fromPath)),
      normalizeEpisodePath(toRelative(item.toPath))
    );
  }
  return moves;
}

/**
 * 済んだ付け替えから「旧話数 → 新話数」の対応表を作る（6.67.3）。
 *
 * **算術（pivot と delta）で台帳を動かさないための土台である。**
 * 実際に名前が変わった話だけがここへ入り、止まった分・動かせなかった分は
 * 入らない。入らなかった話数は台帳でも触らない。
 */
export function episodeNumberMoves(
  done: readonly EpisodeRename[]
): Map<number, number> {
  const moves = new Map<number, number>();
  for (const item of done) moves.set(item.oldNumber, item.newNumber);
  return moves;
}

/**
 * 済んだ付け替えの「旧話数 → 旧・新のファイル名」。
 *
 * 各話あらすじだけが**ファイル名でも話を指している**ので、名前を
 * 付け替えるのに要る。**話数から引く**のは、同じ名前の話が別のフォルダーに
 * あっても取り違えないためである（`fileName` を鍵にすると、番外編の
 * `003.txt` のあらすじが本編の付け替えに巻き込まれる）。
 */
export function renamedFileNamesByNumber(
  done: readonly EpisodeRename[]
): Map<number, { fromFileName: string; toFileName: string }> {
  const names = new Map<number, { fromFileName: string; toFileName: string }>();
  for (const item of done) {
    names.set(item.oldNumber, {
      fromFileName: item.fromFileName,
      toFileName: item.toFileName,
    });
  }
  return names;
}

/** 削除した話と、その次の話（付け替え後）。章立ての追従に要る */
export interface RemovedEpisodePaths {
  /** 消えた話の相対パス */
  path: string;
  /** 次の話の、**付け替え後の**相対パス。後ろに話が無ければ undefined */
  nextPath?: string;
}

export interface ChapterRenumberResult {
  chapters: Chapter[];
  changed: number;
  /** 開始の話が消えたので、開始を次の話へ移した章 */
  movedStarts: Array<{ name: string; toPath: string }>;
  /** 中身が空になったので外した章 */
  dropped: string[];
}

/**
 * 章立ての開始の話を付け替える（6.67.3）。
 *
 * **削除された話から始まっていた章を、そのままにしない**（6.67.3の追記）。
 * 消えた話を指したままだと「開始の話が見つかりません」の章が残り、しかも
 * その場所へ繰り上がってきた次の話を別の章が指していると、**開始の重複で
 * 保存が丸ごと落ちる**（`duplicate_start`）。台帳の追従が黙って全部
 * 失敗するので、ここで畳んでおく。
 *
 *   - 開始が消えた章 → **開始を次の話へ移す**
 *   - 移した先が別の章の開始と重なる → **その章を外す**（中身が空になった章）
 *   - 後ろに話が無い → 同じく外す
 *
 * どちらも件数を返し、呼ぶ側が完了通知に出す（**黙って書き換えない**）。
 *
 * **元の配列は書き換えない。** 保存に失敗したときに、画面に出ている
 * 一覧だけが変わってしまうのを避ける（`models/chapter.ts` と同じ流儀）。
 */
export function renumberChapterSet(
  chapters: readonly Chapter[],
  moves: ReadonlyMap<string, string>,
  removed?: RemovedEpisodePaths
): ChapterRenumberResult {
  const removedPath = removed ? normalizeEpisodePath(removed.path) : null;
  const nextPath = removed?.nextPath
    ? normalizeEpisodePath(removed.nextPath)
    : null;

  /*
    **判断は「付け替える前のパス」で行う。** 削除では、消えた話の場所へ
    次の話が繰り上がってくる（`004.txt`→`003.txt`）。先に付け替えてから
    「消えた話から始まる章」を探すと、繰り上がってきた話を開始に持つ
    別の章を、消えた話の章と取り違える。
  */
  const slots = chapters.map((chapter) => {
    const start = normalizeEpisodePath(chapter.startEpisodePath);
    if (removedPath !== null && start === removedPath) {
      return { chapter, start: nextPath, fromRemoved: true, byMove: false };
    }
    const moved = moves.get(start);
    return {
      chapter,
      start: moved ?? start,
      fromRemoved: false,
      byMove: moved !== undefined,
    };
  });

  const otherStarts = new Set(
    slots
      .filter((slot) => !slot.fromRemoved && slot.start !== null)
      .map((slot) => slot.start as string)
  );

  const next: Chapter[] = [];
  const movedStarts: Array<{ name: string; toPath: string }> = [];
  const dropped: string[] = [];
  let changed = 0;

  for (const slot of slots) {
    if (slot.fromRemoved) {
      if (slot.start === null || otherStarts.has(slot.start)) {
        dropped.push(slot.chapter.name);
        changed++;
        continue;
      }
      movedStarts.push({ name: slot.chapter.name, toPath: slot.start });
      changed++;
      next.push({ ...slot.chapter, startEpisodePath: slot.start });
      continue;
    }
    if (slot.byMove) changed++;
    next.push({ ...slot.chapter, startEpisodePath: slot.start as string });
  }

  return { chapters: next, changed, movedStarts, dropped };
}

export interface BookPositions {
  illustrations: BookIllustration[];
  pageBreaks: BookPageBreak[];
}

/**
 * 挿絵とページ分割の指し先を付け替える（6.67.3）。
 *
 * **削除された話を指しているものは消さない。** 数えて返し、呼ぶ側が
 * 「対象の話が無い」と報せる（挿絵の指し先が見つからないときの既存の
 * 流儀、設計書6.65.10と同じ）。作者が置いた挿絵を、話を1つ消した
 * ついでに黙って捨ててはいけない。
 */
export function renumberBookPositions(
  positions: BookPositions,
  moves: ReadonlyMap<string, string>,
  removedPath?: string
): BookPositions & { changed: number; orphaned: number } {
  let changed = 0;
  let orphaned = 0;
  const removed = removedPath ? normalizeEpisodePath(removedPath) : null;

  function move<T extends { episodePath: string }>(entry: T): T {
    const key = normalizeEpisodePath(entry.episodePath);
    if (removed !== null && key === removed) {
      orphaned++;
      return { ...entry };
    }
    const moved = moves.get(key);
    if (!moved) return { ...entry };
    changed++;
    return { ...entry, episodePath: moved };
  }

  return {
    illustrations: positions.illustrations.map(move),
    pageBreaks: positions.pageBreaks.map(move),
    changed,
    orphaned,
  };
}

/**
 * 話数の数字の並びをずらす（6.67.3）。
 *
 * **対応表に載っている話数だけを動かす。** 載っていない話数は、原稿の
 * ほうも動いていない（途中で止まった・合本で動かせなかった）ので触らない。
 *
 * 削除された話の番号は**落とす**。詰めたあと、その番号には別の話が
 * 来ているので、残すと黙って別人の話にすり替わる。落ちるのは
 * 「その話に出ていた」という**事実**だけで、値は親のレコードに残る。
 */
function shiftChapters(
  chapters: readonly number[],
  shift: EpisodeShift
): { chapters: number[]; changed: number } {
  let changed = 0;
  const next: number[] = [];
  for (const chapter of chapters) {
    if (shift.removed !== undefined && chapter === shift.removed) {
      changed++;
      continue;
    }
    const moved = shift.moved.get(chapter);
    if (moved === undefined) {
      next.push(chapter);
      continue;
    }
    next.push(moved);
    changed++;
  }
  // 重複を作らない（削除で 4 と 5 が両方 4 になることがある）
  return {
    chapters: [...new Set(next)].sort((a, b) => a - b),
    changed,
  };
}

/**
 * 話数を1つだけずらす（`firstChapter` のように単独で持つもの）。
 *
 * 削除された話を指していたら null にする。**その値が消えるのではなく、
 * 「いつのことか分からなくなった」ことを表す**——呼び名や能力そのものは
 * レコードに残り、話数だけが空になる。
 */
function shiftOne(
  chapter: number | null,
  shift: EpisodeShift
): { chapter: number | null; changed: boolean } {
  if (chapter === null) return { chapter, changed: false };
  if (shift.removed !== undefined && chapter === shift.removed) {
    return { chapter: null, changed: true };
  }
  const moved = shift.moved.get(chapter);
  if (moved === undefined) return { chapter, changed: false };
  return { chapter: moved, changed: true };
}

/**
 * 設定資料の台帳が共通して持つ、話数の入れ物。
 *
 * 能力・場所・組織・世界観は、登場人物と**同じ形**で話数を持つ
 * （`appearedChapters` と食い違いの記録）。1つの関数で面倒を見る——
 * 台帳ごとに書き写すと、片方だけ直し忘れて設定資料がずれる。
 */
interface ChapteredRecord {
  appearedChapters: number[];
  conflicts: RecordConflict[];
}

/** 話数をずらす作業の途中経過。件数を数えながら畳んでいく */
class ShiftCounter {
  changed = 0;
  constructor(private readonly shift: EpisodeShift) {}

  list(chapters: readonly number[]): number[] {
    const result = shiftChapters(chapters, this.shift);
    this.changed += result.changed;
    return result.chapters;
  }

  one(chapter: number | null): number | null {
    const result = shiftOne(chapter, this.shift);
    if (result.changed) this.changed++;
    return result.chapter;
  }

  conflicts(conflicts: readonly RecordConflict[]): RecordConflict[] {
    return conflicts.map((conflict) => ({
      ...conflict,
      chapters: this.list(conflict.chapters),
      observations: conflict.observations?.map((observation) => ({
        ...observation,
        chapters: this.list(observation.chapters),
      })),
    }));
  }

  changes(changes: readonly RecordChange[]): RecordChange[] {
    return changes.map((change) => ({
      ...change,
      chapters: this.list(change.chapters),
    }));
  }
}

/**
 * 能力・場所・組織・世界観の話数を付け替える（6.67.3）。
 *
 * **元のレコードは書き換えない**——保存に失敗したときに、画面の中だけが
 * 動いた状態を作らないため（`models/chapter.ts` と同じ流儀）。
 */
export function renumberSettingsRecord<T extends ChapteredRecord>(
  record: T,
  shift: EpisodeShift
): { record: T; changed: number } {
  const counter = new ShiftCounter(shift);
  return {
    record: {
      ...record,
      appearedChapters: counter.list(record.appearedChapters),
      conflicts: counter.conflicts(record.conflicts),
    },
    changed: counter.changed,
  };
}

/**
 * 登場人物の話数を付け替える（6.67.3）。
 *
 * 話数を持つ場所は6か所ある——登場話数・一人称の使い分け・作中での変化・
 * 食い違い（値ごとの観測を含む）・呼び名の初出と最後・能力の初出と登場話数。
 * **どれか1つでも取りこぼすと、そこだけが別の話を指す。**
 */
export function renumberCharacter(
  character: Character,
  shift: EpisodeShift
): { character: Character; changed: number } {
  const counter = new ShiftCounter(shift);

  return {
    character: {
      ...character,
      appearedChapters: counter.list(character.appearedChapters),
      firstPerson: {
        ...character.firstPerson,
        variants: character.firstPerson.variants.map((variant) => ({
          ...variant,
          chapters: counter.list(variant.chapters),
        })),
      },
      addressTerms: character.addressTerms.map((term) => ({
        ...term,
        forms: term.forms.map((form) => ({
          ...form,
          firstChapter: counter.one(form.firstChapter),
          lastChapter: counter.one(form.lastChapter),
        })),
      })),
      abilities: character.abilities.map((ability) => ({
        ...ability,
        firstChapter: counter.one(ability.firstChapter),
        appearedChapters: counter.list(ability.appearedChapters),
      })),
      changes: counter.changes(character.changes),
      conflicts: counter.conflicts(character.conflicts),
    },
    changed: counter.changed,
  };
}

/**
 * 伏線の「張った話」「回収した話」を付け替える（6.67.3）。
 *
 * 削除された話を指していたら null（＝まだ張っていない／未回収）に戻る。
 * **伏線そのものは消さない**——作者が書いた伏線の記録を、話を1つ
 * 消したついでに捨ててはいけない。
 */
export function renumberForeshadow<
  T extends { plantedChapter: number | null; resolvedChapter: number | null }
>(foreshadow: T, shift: EpisodeShift): { record: T; changed: number } {
  const counter = new ShiftCounter(shift);
  return {
    record: {
      ...foreshadow,
      plantedChapter: counter.one(foreshadow.plantedChapter),
      resolvedChapter: counter.one(foreshadow.resolvedChapter),
    },
    changed: counter.changed,
  };
}

/**
 * 各話あらすじを付け替える（6.67.3）。
 *
 * **ここだけは話数とファイル名の両方を持つ**（`synopsisKey` が
 * 「話数があれば話数、無ければファイル名」で照合するため）。片方だけ
 * 直すと、同じ話のあらすじが2つに増える（`dedupeSynopsisEpisodes` が
 * 後始末をしている、まさにその重複である）。
 *
 * 削除された話のあらすじは**消さない**。話数を null にして残し、
 * 呼ぶ側が件数を報せる——AIが作ったとはいえ、作者が読んで直したものが
 * 入っていることがある。
 */
export function renumberSynopses<
  T extends { chapter: number | null; fileName: string }
>(
  episodes: readonly T[],
  shift: EpisodeShift,
  /** 旧話数 → 旧・新のファイル名（`renamedFileNamesByNumber`） */
  renamedFiles: ReadonlyMap<number, { fromFileName: string; toFileName: string }>
): { episodes: T[]; changed: number; orphaned: number } {
  let changed = 0;
  let orphaned = 0;

  const next = episodes.map((episode) => {
    const counter = new ShiftCounter(shift);
    const chapter = counter.one(episode.chapter);
    if (shift.removed !== undefined && episode.chapter === shift.removed) {
      orphaned++;
    }

    /*
      **名前を書き換えるのは、その話数の付け替えと名前が一致する行だけ。**
      あらすじは行ごとに話数とファイル名の両方を持つ（`synopsisKey`）。
      話数から引いた付け替えの元の名前と、その行の名前が食い違うなら、
      それは合本など別のファイルから作ったあらすじである——名前まで
      書き換えると、実在しないファイルを指すことになる。
    */
    const renamed =
      episode.chapter !== null ? renamedFiles.get(episode.chapter) : undefined;
    const fileName =
      renamed && sameFileName(renamed.fromFileName, episode.fileName)
        ? renamed.toFileName
        : episode.fileName;

    // **話数だけでなく、名前が変わった行も数える**（数えないと保存されない）
    if (counter.changed > 0 || fileName !== episode.fileName) changed++;
    return { ...episode, chapter, fileName };
  });

  return { episodes: next, changed, orphaned };
}

/** ファイル名が同じか。Windowsは大文字小文字を区別しない */
function sameFileName(left: string, right: string): boolean {
  return (
    path.normalizeForComparison(left) === path.normalizeForComparison(right)
  );
}

/**
 * 年表の話の指し先を付け替える（6.67.3）。
 *
 * 年表は**パスで話を指す**（章立て・挿絵と同じ理由）。削除された話の
 * 行は残す——その話に結び付けた時期の記録を、黙って消さない。
 */
export function renumberTimelineEpisodes<T extends { filePath: string }>(
  episodes: readonly T[],
  moves: ReadonlyMap<string, string>
): { episodes: T[]; changed: number } {
  let changed = 0;
  const next = episodes.map((episode) => {
    const moved = moves.get(normalizeEpisodePath(episode.filePath));
    if (!moved) return { ...episode };
    changed++;
    return { ...episode, filePath: moved };
  });
  return { episodes: next, changed };
}
