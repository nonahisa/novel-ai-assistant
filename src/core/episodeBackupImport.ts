import { backupEpisodesOf } from "./backupMerge";
import { countEpisodeChars } from "./episodeCharCount";
import {
  IMPORT_CHOICE_LABELS,
  planEpisodeImport,
  trimImported,
  type ImportChoice,
  type ImportPlan,
} from "./episodeImport";
import { fromSiteNotation, stripRuby } from "./ruby";
import type { WorkZipInspection } from "./workZip";

/**
 * 原稿エディターの［入力］→「バックアップから」（0.150.0。設計書6.25.13）で、
 * 投稿サイトのバックアップの中の話を、**開いている作品へ足す**ときの判断。
 *
 * 0.147.0 の「テキストファイルから」「Word から」（`episodeImport.ts`）と同じ決まりに
 * 乗せる。違うのは、**1回で何話も足せる**ことだけである。
 *
 * - バックアップの読み方は作品の取り込み（`importWorkFromZip`）と同じ `inspectWorkBackup`、
 *   話への割り方と題の読み方は既にある作品へ足すとき（`backupMerge.ts` の
 *   `backupEpisodesOf`）と同じ。**ここで写さない**——写すと、同じバックアップから
 *   作品を作ったときと足したときで、話の切れ目や題が食い違う
 * - 何を訊くか：1話を選んだときは 0.147.0 とまったく同じ（`planEpisodeImport`）。
 *   2話以上は、空の話へ入れることも［上書きする］も出さない（1つの話へ何話ぶんも
 *   入れる道を作らない。0.150.0 で決めた）
 *
 * vscode にもファイルにも触らない（`episodeImport.ts` と同じ置き方）。
 */

/** 足せる1話ぶん */
export interface BackupImportEntry {
  /** バックアップの中の並び順（1始まり）。選ぶ一覧と足す順はこの順 */
  readonly order: number;
  /** 作者に見せる見出し（「3話　再会」。`backupEpisodesOf` の見出しのまま） */
  readonly label: string;
  /**
   * 新しく作る話のファイル名に付けるサブタイトル。読めなければ null（番号だけの名前）。
   * ルビ・傍点の印は落とす（ファイル名に記法を入れない。`titleCandidate` と同じ扱い）
   */
  readonly title: string | null;
  /** 本文（改行は LF。頭の空行と末尾の空白は落としてある） */
  readonly body: string;
  /** 本文の純文字数（原稿エディターの下の欄と同じ数え方） */
  readonly chars: number;
}

/**
 * バックアップの中の話を、足せる形に並べる。**本文の無い話は並べない**（区切りだけの話を
 * 足すと、空の話のファイルが増えるだけになる）。並べなかった話の見出しは `empty` で返す
 * ——黙って落とさない。
 */
export function backupImportEntries(inspection: WorkZipInspection): {
  entries: BackupImportEntry[];
  empty: string[];
} {
  const entries: BackupImportEntry[] = [];
  const empty: string[] = [];
  for (const episode of backupEpisodesOf(inspection)) {
    const body = trimImported(episode.body.replace(/\r\n?/g, "\n"));
    if (body.trim() === "") {
      empty.push(episode.label);
      continue;
    }
    const title = episode.title ? stripRuby(fromSiteNotation(episode.title)).trim() : "";
    entries.push({
      order: entries.length + 1,
      label: episode.label,
      title: title === "" ? null : title,
      body,
      chars: countEpisodeChars(body, { ext: ".txt", excludeRuby: false }).net,
    });
  }
  return { entries, empty };
}

/**
 * 訊くか、どれを並べるかを決める。
 *
 * - **1話**：0.147.0 と同じ（空の話なら訊かずにその話へ。入っていれば次の話・最後に加える・上書き）
 * - **2話以上**：空の話へは入れない（1つの話に何話ぶんも入る）。［上書きする］も出さない。
 *   ［次の話として足す］は、あとの話の番号をずらす話があるときだけ（1話のときと同じ）
 */
export function planBackupImport(
  input: Parameters<typeof planEpisodeImport>[0] & {
    /** 選んだ話の数（1以上） */
    readonly count: number;
  }
): ImportPlan {
  if (input.count <= 1) return planEpisodeImport(input);
  const plan = planEpisodeImport({ ...input, bodyEmpty: false });
  const choices =
    plan.kind === "ask" ? plan.choices.filter((choice) => choice !== "overwrite") : ["last" as const];
  return { kind: "ask", choices };
}

/** 確かめの窓に並べる見出しの数。多いときは残りを数で言う */
const LISTED_LABELS = 10;

/** 「第4話」「第4〜6話」 */
export function numberRangeLabel(from: number, count: number): string {
  return count <= 1 ? `第${from}話` : `第${from}〜${from + count - 1}話`;
}

/**
 * 確かめの窓の説明（1行に1つ）。**何話を・どこへ足すか**を先に、並べたボタンのぶんだけ書く。
 * 最後に、足す話の見出しを並べる。
 */
export function describeBackupImportChoices(input: {
  readonly choices: readonly ImportChoice[];
  readonly sourceName: string;
  /** 足す話（選んだ順） */
  readonly entries: readonly Pick<BackupImportEntry, "label" | "chars">[];
  /** ［次の話として足す］で作る最初の話の番号 */
  readonly nextFrom?: number;
  /** ［次の話として足す］で名前の変わる話の数 */
  readonly shiftCount: number;
  /** ［最後に加える］で作る最初の話の番号 */
  readonly lastFrom?: number;
  /** ［上書きする］で消える字数（1話のときだけ） */
  readonly erasedChars: number;
}): string[] {
  const count = input.entries.length;
  const chars = input.entries.reduce((total, entry) => total + entry.chars, 0);
  const lines = [`取り込む元：${input.sourceName}の${count}話（${chars}字）`];
  for (const choice of input.choices) {
    if (choice === "next") {
      const where =
        input.nextFrom === undefined ? "すぐ次の話" : numberRangeLabel(input.nextFrom, count);
      lines.push(
        `［${IMPORT_CHOICE_LABELS.next}］${where}として${count}話を足します。` +
          `あとの話のファイル名が変わります（${input.shiftCount}話。番号が${count}つずつ後ろへずれます）。`
      );
    } else if (choice === "last") {
      const where =
        input.lastFrom === undefined ? "" : `${numberRangeLabel(input.lastFrom, count)}として`;
      lines.push(
        `［${IMPORT_CHOICE_LABELS.last}］最後の話のあとに${where}${count}話を足します。ほかの話は変えません。`
      );
    } else {
      lines.push(
        `［${IMPORT_CHOICE_LABELS.overwrite}］いまの本文 ${input.erasedChars}字が消え、取り込む話の本文に置き換わります` +
          "（題・冒頭の欄・後書きはそのまま。書き換える前の本文は控え〈.novelai-recovery〉に残します）。"
      );
    }
  }
  lines.push("足す話：");
  for (const entry of input.entries.slice(0, LISTED_LABELS)) {
    lines.push(`　・${entry.label}（${entry.chars}字）`);
  }
  if (count > LISTED_LABELS) lines.push(`　ほか${count - LISTED_LABELS}話`);
  lines.push("前書き・後書き・リアクションなど、本文の外の欄は入りません。");
  return lines;
}
