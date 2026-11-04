import * as path from "./pathText";
import { parseEpisodeFileName } from "./episodeParser";
import { normalizeEpisodePath } from "../models/chapter";

/**
 * 製品の外で話の名前が変わったときに、パスで話を指す4つの台帳（章立て・本の設計図・
 * 年表・投稿状態）をどう付け替えるかを決める（設計書6.68.2。作者の決定 2026-11-04）。
 *
 * ここは**判定だけ**で、台帳もファイルも読まない（`vscode` を知らない）。読むのと
 * 書くのは `features/episodeRenameWatch.ts`、付け替えそのものは
 * `features/episodeLedgers.ts` の `followEpisodeFileRenames`。
 *
 * 道は2つある：
 *
 * - **VS Code のエクスプローラーでの改名**（`onDidRenameFiles` が知らせる）：
 *   旧名と新名が分かっているので、訊かずに付け替える（`ledgerMovesForRenames`）
 * - **OS・git pull などでの改名**（何も知らせが来ない）：台帳にあるのに今は無い話と、
 *   今あるのに台帳に無い話を突き合わせ、話数が同じものを候補にして、次に作品を
 *   開いたときに訊く（`findRenameDriftCandidates` → `decideRenameDrift`）
 *
 * パスはすべて**作品フォルダーからの相対パス（区切りは `/`）**で受け取る。台帳が
 * その形で持っているので（`episodePathFor`）、絶対パスと混ぜない。
 */

/** 拡張機能の作業場所・退避・git の中は、本文ではない（`isManuscriptPath` と同じ3つ） */
const NON_MANUSCRIPT_SEGMENTS = new Set([".aiwriter", ".novelai-recovery", ".git"]);

/** 本文の拡張子（`SUPPORTED_EXTENSIONS` と同じ。`models/types.ts` は型の都合で引かない） */
const MANUSCRIPT_EXTENSIONS = new Set([".txt", ".md"]);

/**
 * その相対パスが、話の本文でありうる場所か。
 *
 * **単話プロット（`設定/episode-plots/003.md`）を外すのがいちばんの狙い。** 製品が
 * 単話プロットの名前を変えるときは `WorkspaceEdit.renameFile` を通すので
 * （開いているタブを追わせるため）、`onDidRenameFiles` に来る。話数の部分が本文と
 * 同じ名前なので、場所で外さないと取り違える。
 *
 * @param settingsRel 設定フォルダーの相対パス。作品の根と同じ（`""`・`"."`）なら見ない
 *   ——その形の作品では、設定フォルダーで外すと本文まで外れる
 */
export function isEpisodeBodyRelPath(rel: string, settingsRel?: string): boolean {
  const normalized = normalizeEpisodePath(rel);
  if (!normalized || normalized === "." || normalized.startsWith("../")) return false;
  if (!MANUSCRIPT_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => NON_MANUSCRIPT_SEGMENTS.has(segment))) return false;
  const settings = settingsRel === undefined ? "" : normalizeEpisodePath(settingsRel);
  if (settings && settings !== "." && isUnder(settings, normalized)) return false;
  return true;
}

/** `child` が `parent` そのものか、その下か（相対パスどうし） */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** 名前を変えた1件（作品フォルダーからの相対パス）。ファイルでもフォルダーでもよい */
export interface RelativeRename {
  fromRel: string;
  toRel: string;
}

/**
 * エクスプローラーでの改名から、台帳のパスの付け替え表（旧 → 新）を作る。
 *
 * - **ファイルの改名**：旧名が本文の場所で、新名も本文の場所なら、そのまま1件
 *   （台帳に載っていなくても入れる。載っているかは付け替えの側が見るので、
 *   壊れた台帳の失敗もそこで拾える）
 * - **フォルダーの改名**（章フォルダーなど）：VS Code は中身があっても知らせを
 *   1つしか出さない。**台帳に載っている話のうち、そのフォルダーの下にあるもの**を
 *   1件ずつ付け替える。台帳に無い話は付け替える物が無いので、フォルダーの中を
 *   歩かない
 * - 新しい場所が本文の場所でない（設定フォルダーへ動かした等）ものは入れない——
 *   話でなくなったものへ台帳を向けない。黙って外すこともしない（旧名のまま残す）
 *
 * 作品フォルダーそのもの（`fromRel` が空）は呼ぶ側で外す。相対パスは変わらない。
 */
export function ledgerMovesForRenames(
  renames: readonly RelativeRename[],
  ledgerPaths: Iterable<string>,
  settingsRel?: string
): Map<string, string> {
  const moves = new Map<string, string>();
  const ledger = [...new Set([...ledgerPaths].map(normalizeEpisodePath))];
  for (const rename of renames) {
    const from = normalizeEpisodePath(rename.fromRel);
    const to = normalizeEpisodePath(rename.toRel);
    if (!from || from === "." || from === to) continue;
    if (isEpisodeBodyRelPath(from, settingsRel) && isEpisodeBodyRelPath(to, settingsRel)) {
      moves.set(from, to);
      continue;
    }
    for (const entry of ledger) {
      if (!entry.startsWith(`${from}/`)) continue;
      const moved = `${to}${entry.slice(from.length)}`;
      if (isEpisodeBodyRelPath(moved, settingsRel)) moves.set(entry, moved);
    }
  }
  return moves;
}

/**
 * ファイル名から読む「話数の部分」。候補を決める鍵にする。
 *
 * 読み方は走査と同じ `parseEpisodeFileName`。**種別も鍵に入れる**——「幕間1」と
 * 「第1話」はどちらも数字は1だが別の話である。合本は範囲ごと（`3-5`）、日付で
 * 名付けた話（SNS記事）は日付と同じ日の並びで見る。話数の読めない名前
 * （「続き.txt」など）は鍵を持たず、候補を探さない（訊かない）。
 */
export function episodeKeyOfPath(rel: string): string | null {
  const parsed = parseEpisodeFileName(path.basename(normalizeEpisodePath(rel)));
  if (parsed.date) return `date:${parsed.date}#${parsed.dateSeq ?? 0}`;
  if (parsed.chapterStart === null) return null;
  return `${parsed.kind}:${parsed.chapterStart}-${parsed.chapterEnd ?? parsed.chapterStart}`;
}

/** 台帳にあるのに今は無い話1つと、その候補（話数が同じで、台帳に載っていない今の話） */
export interface RenameDriftCandidates {
  fromRel: string;
  candidates: string[];
}

/**
 * 台帳にあるのに今は無い話について、名前が変わった先の候補を集める。
 *
 * - 候補は「今ある話のうち、**どの台帳にも載っていない**もの」で、話数の部分が同じもの
 *   （台帳に載っている話は、その話として記録が既にあるので、別の話の新しい名前ではない）
 * - **同じフォルダーの候補を先に見る。** 章フォルダーごとに話数を1から振る作品では、
 *   別の章の同じ話数を拾ってしまう。同じフォルダーに無いときだけ、ほかのフォルダーも
 *   見る（git pull で章フォルダーごと名前が変わったとき）
 *
 * 候補が無い話も返す（`candidates` が空）。消えた話かもしれないので、呼ぶ側は
 * 訊かず、台帳も触らない。
 */
export function findRenameDriftCandidates(
  ledgerPaths: Iterable<string>,
  currentPaths: Iterable<string>
): RenameDriftCandidates[] {
  const ledger = new Set([...ledgerPaths].map(normalizeEpisodePath).filter(Boolean));
  const current = new Set([...currentPaths].map(normalizeEpisodePath).filter(Boolean));
  const missing = [...ledger].filter((entry) => !current.has(entry));
  if (missing.length === 0) return [];
  const unlisted = [...current].filter((entry) => !ledger.has(entry));
  const keyed = unlisted.map((entry) => ({ entry, key: episodeKeyOfPath(entry) }));

  return missing.map((fromRel) => {
    const key = episodeKeyOfPath(fromRel);
    if (key === null) return { fromRel, candidates: [] };
    const sameKey = keyed.filter((item) => item.key === key).map((item) => item.entry);
    const folder = path.dirname(fromRel);
    const sameFolder = sameKey.filter((entry) => path.dirname(entry) === folder);
    return { fromRel, candidates: sameFolder.length > 0 ? sameFolder : sameKey };
  });
}

/** 訊いてよい1組（旧 → 新。作品フォルダーからの相対パス） */
export interface RenameDriftPair {
  fromRel: string;
  toRel: string;
}

/**
 * 候補を1つに決められた組だけを残す。
 *
 * - 候補が1つ → その組
 * - 候補が2つ以上 → `confirmedByHash`（投稿したときの本文の印と今の本文が合うか）で
 *   **1つに絞れたときだけ**その組。印は強い手がかりだが、合わないことは「別の話」の
 *   証拠にしない（印には題も入るので、題を変える改名では合わない）
 * - **1つの新しい名前が、2つ以上の消えた話の候補に残ったら、どれも訊かない**
 *   （どちらの話の新しい名前か、こちらでは決められない）
 *
 * 決まらなかった話は `unresolved` に返す（呼ぶ側は訊かず、台帳も触らない）。
 */
export function decideRenameDrift(
  list: readonly RenameDriftCandidates[],
  confirmedByHash?: (fromRel: string, toRel: string) => boolean
): { pairs: RenameDriftPair[]; unresolved: string[] } {
  const chosen: RenameDriftPair[] = [];
  const unresolved: string[] = [];
  for (const item of list) {
    if (item.candidates.length === 1) {
      chosen.push({ fromRel: item.fromRel, toRel: item.candidates[0] });
      continue;
    }
    const confirmed =
      item.candidates.length > 1 && confirmedByHash
        ? item.candidates.filter((candidate) => confirmedByHash(item.fromRel, candidate))
        : [];
    if (confirmed.length === 1) {
      chosen.push({ fromRel: item.fromRel, toRel: confirmed[0] });
    } else {
      unresolved.push(item.fromRel);
    }
  }
  const claims = new Map<string, number>();
  for (const pair of chosen) claims.set(pair.toRel, (claims.get(pair.toRel) ?? 0) + 1);
  const pairs: RenameDriftPair[] = [];
  for (const pair of chosen) {
    if ((claims.get(pair.toRel) ?? 0) > 1) unresolved.push(pair.fromRel);
    else pairs.push(pair);
  }
  return { pairs, unresolved };
}

/**
 * ［付け替えない］を選んだ組を覚えるときの鍵。作品ごとに分ける。
 *
 * 区切りは `\u0000`（パスにも作品IDにも現れない字）。**組ごとに覚える**ので、
 * 別の話の名前が新しく変われば、その組だけを訊く。
 */
export function declinedRenameKey(workId: string, pair: RenameDriftPair): string {
  return [workId, normalizeEpisodePath(pair.fromRel), normalizeEpisodePath(pair.toRel)].join(
    "\u0000"
  );
}

/** 断った組を除く */
export function withoutDeclined(
  workId: string,
  pairs: readonly RenameDriftPair[],
  declined: ReadonlySet<string>
): RenameDriftPair[] {
  return pairs.filter((pair) => !declined.has(declinedRenameKey(workId, pair)));
}

/** 問いに並べる組の数。多いときは残りを数で言う（`backupMerge.ts` の `listEpisodes` と同じ形） */
const LISTED_PAIRS = 3;

/** 「第3話」の形。読めなければ空（ファイル名だけで分かる） */
function episodeLabelOf(rel: string): string {
  const parsed = parseEpisodeFileName(path.basename(rel));
  if (parsed.date) return "";
  if (parsed.chapterStart === null) return "";
  if (parsed.kind !== "本編") return "";
  if (parsed.chapterEnd !== null && parsed.chapterEnd !== parsed.chapterStart) {
    return `第${parsed.chapterStart}〜${parsed.chapterEnd}話`;
  }
  return `第${parsed.chapterStart}話`;
}

/** 名前の見せ方。同じフォルダーの中ならファイル名だけ、フォルダーごと変わったら相対パス */
function shownNames(pair: RenameDriftPair): { from: string; to: string } {
  const sameFolder = path.dirname(pair.fromRel) === path.dirname(pair.toRel);
  return sameFolder
    ? { from: path.basename(pair.fromRel), to: path.basename(pair.toRel) }
    : { from: pair.fromRel, to: pair.toRel };
}

/**
 * 作品を開いたときに出す問い（1回にまとめる）。
 *
 * 例：「氷の街」で名前が変わった話が2つあります。記録（章立て・本の設計図・年表・
 * 投稿状態）を新しい名前へ付け替えますか（第3話「003.txt」→「003_湖畔の誓い.txt」・…）
 */
export function describeRenameDriftQuestion(
  workTitle: string,
  pairs: readonly RenameDriftPair[]
): string {
  const listed = pairs.slice(0, LISTED_PAIRS).map((pair) => {
    const names = shownNames(pair);
    return `${episodeLabelOf(pair.fromRel)}「${names.from}」→「${names.to}」`;
  });
  const rest = pairs.length - LISTED_PAIRS;
  const list = `${listed.join("・")}${rest > 0 ? ` ほか${rest}話` : ""}`;
  return (
    `「${workTitle}」で名前が変わった話が${pairs.length}つあります。` +
    `記録（章立て・本の設計図・年表・投稿状態）を新しい名前へ付け替えますか（${list}）`
  );
}
