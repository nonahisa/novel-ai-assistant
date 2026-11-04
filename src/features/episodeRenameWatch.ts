import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ChapterStore } from "../core/chapterStore";
import { BookStore, episodePathFor } from "../core/bookStore";
import { TimelineStore } from "../core/timelineStore";
import { PostingStore } from "../core/postingStore";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { scanWork } from "../core/scanner";
import { resolveManuscriptDir } from "../core/manuscriptFolder";
import { readTextFile } from "../core/textFile";
import { listReadingDictionaryEpisodes } from "../core/readingDictionaryStore";
import { parseEpisodeFileName } from "../core/episodeParser";
import { postingTextHashes, postingUnitsOf } from "../core/postingBodyHash";
import {
  decideRenameDrift,
  declinedRenameKey,
  describeRenameDriftQuestion,
  findRenameDriftCandidates,
  isEpisodeBodyRelPath,
  ledgerMovesForRenames,
  withoutDeclined,
  type RenameDriftPair,
} from "../core/episodeRenameDrift";
import { normalizeEpisodePath } from "../models/chapter";
import { logFailure, useLogFile } from "../core/logger";
import { notifyDone } from "../views/notify";
import {
  describeLedgerFollowSummary,
  followEpisodeFileRenames,
  type EpisodeFileRename,
  type LedgerFollowSummary,
} from "./episodeLedgers";

/**
 * 製品の外で変えた話の名前を、パスで話を指す4つの台帳（章立て・本の設計図・年表・
 * 投稿状態）へ付け替える（設計書6.68.2。作者の決定 2026-11-04）。
 *
 * 0.125.4 では製品の中の3つの改名（サブタイトルを付ける・サブタイトル案の採用・.md 化）
 * だけを追っていた。エクスプローラーや OS で名前を変えた話は投稿状態の台帳から
 * 見失われ、投稿済みなのに「未投稿」に見えていた。
 *
 * - **エクスプローラーでの改名**：`onDidRenameFiles` が旧名と新名を知らせるので、訊かずに
 *   付け替える（`followExplorerRenames`）。件数は製品の中の改名と同じく知らせる
 * - **OS・git pull での改名**：知らせが来ないので、次に作品を開いたときに台帳と今の話を
 *   突き合わせ、1つに決まる組だけを1回の問いで訊く（`RenameDriftChecker`）
 *
 * **製品自身の話の改名（3つの改名・話数の付け替え）は `workspace.fs.rename` を通すので
 * `onDidRenameFiles` には来ない**（VS Code の決まり。`applyEdit` とエクスプローラーの
 * 改名だけが来る）。来るのは単話プロット（`episodePlotFiles.ts`）で、これは話の本文では
 * ないので場所で外す（`isEpisodeBodyRelPath`）。仮に二重に来ても、2回目は台帳に旧名が
 * 無いので0件になり、何も知らせない。
 */

/** 名前を変えた1件（絶対パス）。ファイルでもフォルダーでもよい */
export interface RenamedPath {
  fromPath: string;
  toPath: string;
}

/** 4つの台帳にある、話を指す相対パス（同じパスは1つにまとめる） */
async function collectLedgerEpisodePaths(work: WorkEntry): Promise<string[]> {
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = value ? normalizeEpisodePath(value) : "";
    if (normalized) found.add(normalized);
  };
  /*
    **読めない台帳は飛ばす**（壊れた JSON は直さず止める決まり）。ここは「どの話を
    指しているか」を知りたいだけで、読めない台帳の付け替えは `followEpisodeFileRenames`
    の側がその台帳の失敗として拾い、作者へ警告する
  */
  const read = async (label: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      logFailure(`名前の変更の追従：${label}の読み込み`, {
        内容: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await read("章立て", async () => {
    for (const chapter of (await new ChapterStore(work).load()).chapters) {
      add(chapter.startEpisodePath);
    }
  });
  await read("本の設計図", async () => {
    const config = await new BookStore(work).load();
    for (const entry of config.illustrations) add(entry.episodePath);
    for (const entry of config.pageBreaks) add(entry.episodePath);
  });
  await read("年表", async () => {
    for (const episode of (await new TimelineStore(work).load()).episodes) add(episode.filePath);
  });
  await read("投稿状態", async () => {
    const ledger = await new PostingStore(work).load();
    for (const post of ledger.posts) add(post.episodePath);
    for (const revision of ledger.revisions ?? []) add(revision.episodePath);
  });
  return [...found];
}

/** 読みの辞書のある話の相対パス。読めなければ空（付け替えはせず、ログにだけ残す） */
async function collectReadingDictionaryPaths(work: WorkEntry): Promise<string[]> {
  try {
    return (await listReadingDictionaryEpisodes(work)).map((filePath) =>
      normalizeEpisodePath(episodePathFor(work.folderPath, filePath))
    );
  } catch (error) {
    logFailure("名前の変更の追従：読みの辞書の一覧", {
      内容: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 作品の本文フォルダーと設定フォルダー（相対パス）。作品設定が読めなければ既定の名前 */
async function workFolders(
  work: WorkEntry
): Promise<{ manuscriptRel: string; settingsRel: string; walkedRel: string }> {
  let config;
  try {
    config = await readWorkConfig(work);
  } catch (error) {
    // 作品設定が壊れていても、既定の名前で判定はできる（設定は直さない）
    logFailure("名前の変更の追従：作品設定の読み込み", {
      内容: error instanceof Error ? error.message : String(error),
    });
  }
  const p = workPaths(work, config);
  return {
    manuscriptRel: normalizeEpisodePath(episodePathFor(work.folderPath, p.manuscript)),
    settingsRel: episodePathFor(work.folderPath, p.settings),
    /*
      走査が実際に歩く場所（`resolveManuscriptDir`。走査と同じ決め方）。本文フォルダーが
      無い・空なら作品の根（`""`）になる。作品設定どおりなら `manuscriptRel` と同じ
    */
    walkedRel: normalizeEpisodePath(
      episodePathFor(work.folderPath, await resolveManuscriptDir(p))
    ),
  };
}

/** `child` が `parent` の下か（相対パスどうし。`parent` が根（`""`・`"."`）なら常に真） */
function isUnderRel(parent: string, child: string): boolean {
  if (!parent || parent === ".") return true;
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * 付け替えの知らせ（0件なら出さない）。
 *
 * **済んでいないものを先に書く**（失敗を含む知らせの決まり）。`renameFollowNotice` と
 * 同じ考えだが、こちらは作者が自分で名前を変えたあとなので、0件なら何も言わない。
 */
export function ledgerRenameNotice(
  lead: string,
  summary: LedgerFollowSummary
): { text: string; warn: boolean } | undefined {
  const followed = describeLedgerFollowSummary(summary);
  if (summary.failures.length > 0) {
    return {
      text:
        `記録の付け替えが済んでいないものがあります（${summary.failures.join("　")}）。` +
        (followed ? `${lead}${followed}` : ""),
      warn: true,
    };
  }
  return followed ? { text: `${lead}${followed}`, warn: false } : undefined;
}

function showLedgerNotice(notice: { text: string; warn: boolean } | undefined): void {
  if (!notice) return;
  if (notice.warn) void vscode.window.showWarningMessage(notice.text);
  else notifyDone(notice.text);
}

/** 1作品ぶんの、エクスプローラーでの改名の結果 */
export interface ExplorerRenameOutcome {
  work: WorkEntry;
  summary: LedgerFollowSummary;
  /** 出す知らせ。付け替えが0件で失敗も無ければ undefined（何も言わない） */
  notice?: { text: string; warn: boolean };
}

/**
 * エクスプローラーでの改名を、作品ごとに束ねて台帳へ付け替える。
 *
 * 1つの知らせに別の作品のファイルが混ざることがあるので、先に作品で分ける。
 *
 * 何もしないもの：
 * - 登録した作品の外のファイル（台帳が無い）
 * - **作品フォルダーそのもの**の改名：台帳は作品フォルダーからの相対パスなので変わらない
 *   （登録簿の場所が古くなるのは登録簿の話で、ここでは扱わない）
 * - **本文フォルダーそのもの**の改名：作品設定（`manuscriptDir`）が旧名を指したままになり、
 *   台帳だけ付け替えると走査と台帳が別の場所を見る。設定も直すかは作者の判断が要る
 * - 作品の外へ動かしたもの：消えたのと同じに見えるが、黙って台帳から外さない
 */
export async function followExplorerRenames(
  renamed: readonly RenamedPath[],
  lookup: (filePath: string) => WorkEntry | undefined
): Promise<ExplorerRenameOutcome[]> {
  const byWork = new Map<string, { work: WorkEntry; items: RenamedPath[] }>();
  for (const item of renamed) {
    const work = lookup(item.fromPath);
    if (!work) continue;
    const root = paths.normalizeForComparison(work.folderPath);
    if (paths.normalizeForComparison(item.fromPath) === root) continue;
    if (!paths.isPathInside(work.folderPath, item.toPath)) continue;
    const group = byWork.get(work.id) ?? { work, items: [] };
    group.items.push(item);
    byWork.set(work.id, group);
  }

  const outcomes: ExplorerRenameOutcome[] = [];
  for (const { work, items } of byWork.values()) {
    useLogFile(work.folderPath);
    const folders = await workFolders(work);
    const relative = items
      .map((item) => ({
        fromRel: normalizeEpisodePath(episodePathFor(work.folderPath, item.fromPath)),
        toRel: normalizeEpisodePath(episodePathFor(work.folderPath, item.toPath)),
      }))
      .filter((item) => item.fromRel !== normalizeEpisodePath(folders.manuscriptRel));
    if (relative.length === 0) continue;
    /*
      **フォルダーの改名では、読みの辞書のある話も歩く**（4つの台帳に載っていない話の辞書も
      付いてくるように）。各話あらすじは名前（フォルダーを含まない）で引くので、フォルダーの
      改名では変わらず引ける。ここだけで足し、開いたときに訊く道（`RenameDriftChecker`）の
      候補には入れない——辞書しか無い話まで訊くかは作者の判断が要る
    */
    const moves = ledgerMovesForRenames(
      relative,
      [
        ...(await collectLedgerEpisodePaths(work)),
        ...(await collectReadingDictionaryPaths(work)),
      ],
      folders.settingsRel
    );
    if (moves.size === 0) continue;
    const renames: EpisodeFileRename[] = [...moves].map(([fromRel, toRel]) => ({
      fromPath: paths.join(work.folderPath, fromRel),
      toPath: paths.join(work.folderPath, toRel),
    }));
    const summary = await followEpisodeFileRenames(work, renames);
    const lead =
      items.length === 1
        ? `「${work.title}」の ${paths.basename(items[0].fromPath)} を ` +
          `${paths.basename(items[0].toPath)} に変えたのに合わせて、`
        : `「${work.title}」で名前を変えた${items.length}件に合わせて、`;
    outcomes.push({ work, summary, notice: ledgerRenameNotice(lead, summary) });
  }
  return outcomes;
}

/**
 * `workspace.onDidRenameFiles` を購読する。知らせは作品ごとに1つ。
 * 登録簿は `extension.ts` が持つので、作品の引き方を受け取る。
 */
export function registerExplorerRenameFollow(
  lookup: (filePath: string) => WorkEntry | undefined
): vscode.Disposable {
  return vscode.workspace.onDidRenameFiles((event) => {
    const renamed = event.files.map((file) => ({
      fromPath: paths.fromUri(file.oldUri),
      toPath: paths.fromUri(file.newUri),
    }));
    void followExplorerRenames(renamed, lookup)
      .then((outcomes) => {
        for (const outcome of outcomes) showLedgerNotice(outcome.notice);
      })
      .catch((error: unknown) => {
        logFailure("名前の変更の追従", {
          内容: error instanceof Error ? error.message : String(error),
        });
        void vscode.window.showWarningMessage(
          "名前を変えた話の記録（章立て・投稿状態など）を付け替えられませんでした。詳しくはログを見てください。"
        );
      });
  });
}

/** ［付け替えない］を選んだ組を覚える鍵（この機械の保管。同期には載せない） */
export const DECLINED_RENAMES_KEY = "novelai.declinedEpisodeRenames";

/** 覚えておく［付け替えない］の組の数 */
const MAX_DECLINED = 200;

const ACCEPT_LABEL = "付け替える";
const DECLINE_LABEL = "付け替えない";

/** 保管の口（`vscode.Memento` の使う所だけ。試験で代役を渡せるように） */
export interface RenameMemento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * OS・git pull で名前が変わった話を、次に作品を開いたときに訊いて付け替える。
 *
 * - **1つの窓（起動）で、同じ作品には1度だけ見る。** 見た時点で印を付けるので、
 *   答えずに閉じても、その窓ではもう訊かない（次の窓でまた訊く）
 * - 訊くのは右下の知らせ（モーダルにしない）。原稿の入力欄から焦点を奪わないので、
 *   話を開いてすぐ打ち始めても打鍵は止まらない
 * - ［付け替えない］の組は覚え、同じ組では次の窓でも訊かない。組が変われば訊く
 */
export class RenameDriftChecker {
  private readonly checked = new Set<string>();
  private readonly memento: RenameMemento;
  private readonly listEpisodePaths: (work: WorkEntry) => Promise<string[]>;
  /** 作品を引けなかった、最後に開いた話（登録簿の読み込み待ち） */
  private pendingOpen:
    | { filePath: string; lookup: (filePath: string) => WorkEntry | undefined }
    | undefined;

  constructor(options: {
    memento: RenameMemento;
    /** 今ある話の絶対パス。省けば走査（`scanWork`）で集める */
    listEpisodePaths?: (work: WorkEntry) => Promise<string[]>;
  }) {
    this.memento = options.memento;
    this.listEpisodePaths =
      options.listEpisodePaths ??
      (async (work) => (await scanWork(work)).episodes.map((episode) => episode.filePath));
  }

  /**
   * 作品を開いた合図で呼ぶ。呼ぶ側は待たなくてよい（`void` で投げる）。
   * 答えを待つ間も旗は立てない（印は見る前に付け終えている）。
   */
  async checkOnOpen(work: WorkEntry): Promise<void> {
    if (this.checked.has(work.id)) return;
    this.checked.add(work.id);
    try {
      await this.check(work);
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("名前が変わった話の確かめ", {
        内容: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 話のファイルが前面に来た合図で呼ぶ（素のエディター・原稿エディターのタブ）。
   * **その作品の話の本文を開いたときだけ**作品を見る——単話プロットや設定資料を
   * 開いたのは「作品を書きに来た」合図ではないので、見ずに次の合図を待つ。
   */
  async checkOnEpisodeOpened(
    filePath: string,
    lookup: (filePath: string) => WorkEntry | undefined
  ): Promise<void> {
    const work = lookup(filePath);
    if (!work) {
      /*
        **作品を引けなかった話は覚えておく。** 開き直した直後は作品の登録簿がまだ空のことがあり、
        このまま捨てると、別の話を開くまで確かめが始まらない（作者の決めた「次に作品を開いたときに
        訊く」が効かない。2026-11-04 画面テストで見つかった）。登録簿が変わった合図で
        `retryPendingOpen` がもう一度見る。覚えるのは最後に開いた1件だけ
      */
      this.pendingOpen = { filePath, lookup };
      return;
    }
    this.pendingOpen = undefined;
    if (this.checked.has(work.id)) return;
    const { settingsRel } = await workFolders(work);
    const rel = normalizeEpisodePath(episodePathFor(work.folderPath, filePath));
    if (!isEpisodeBodyRelPath(rel, settingsRel)) return;
    await this.checkOnOpen(work);
  }

  /**
   * 作品の登録簿が変わった合図で呼ぶ。作品を引けずに覚えておいた話があれば、もう一度見る。
   * **新しく話を開いたことにはしない**——覚えているのは作者が実際に開いた話だけなので、
   * 起動時に元から開いていたタブ（数えない決まり）を拾い直すことはない
   */
  async retryPendingOpen(): Promise<void> {
    const pending = this.pendingOpen;
    if (!pending) return;
    if (!pending.lookup(pending.filePath)) return;
    this.pendingOpen = undefined;
    await this.checkOnEpisodeOpened(pending.filePath, pending.lookup);
  }

  private declined(): Set<string> {
    return new Set(this.memento.get<string[]>(DECLINED_RENAMES_KEY, []));
  }

  private async check(work: WorkEntry): Promise<void> {
    const ledgerPaths = await collectLedgerEpisodePaths(work);
    if (ledgerPaths.length === 0) return;
    /*
      **本文の置き場（作品設定の manuscriptDir。書いていなければ既定）が無くなっていたら、
      訊かず何もしない**（作者の裁定 2026-11-04。控えめな側に倒す）。本文フォルダーそのものの
      名前を変えると、走査は作品の根へ落ちて新しいフォルダーの話を見つけるが、台帳だけ付け替えると
      作品設定は旧名のまま残り、走査と台帳が別の場所を見る。根へ落ちて見つかった話は候補にしない
    */
    const folders = await workFolders(work);
    const placeGone =
      folders.walkedRel !== folders.manuscriptRel &&
      ledgerPaths.some((entry) => isUnderRel(folders.manuscriptRel, entry));
    if (placeGone) return;
    const current = (await this.listEpisodePaths(work))
      .map((filePath) => normalizeEpisodePath(episodePathFor(work.folderPath, filePath)))
      .filter((entry) => isUnderRel(folders.walkedRel, entry));
    const list = findRenameDriftCandidates(ledgerPaths, current);
    if (list.length === 0) return;
    const confirmed = await hashConfirmedPairs(work, list);
    const { pairs } = decideRenameDrift(list, (fromRel, toRel) =>
      confirmed.has(`${fromRel}\u0000${toRel}`)
    );
    const asking = withoutDeclined(work.id, pairs, this.declined());
    if (asking.length === 0) return;

    const picked = await vscode.window.showInformationMessage(
      describeRenameDriftQuestion(work.title, asking),
      ACCEPT_LABEL,
      DECLINE_LABEL
    );
    if (picked === DECLINE_LABEL) {
      const keys = this.declined();
      for (const pair of asking) keys.add(declinedRenameKey(work.id, pair));
      // 古いものから忘れる（保管庫を太らせない。`readerStatsRegister.ts` と同じ考え）
      await this.memento.update(DECLINED_RENAMES_KEY, [...keys].slice(-MAX_DECLINED));
      return;
    }
    if (picked !== ACCEPT_LABEL) return;
    showLedgerNotice(await applyRenameDrift(work, asking));
  }
}

/**
 * 訊いた組を付け替える。**答えを待つ間に状態が変わっていることがある**ので、旧名が
 * まだ無く、新名がまだあるものだけを付け替える。
 */
async function applyRenameDrift(
  work: WorkEntry,
  pairs: readonly RenameDriftPair[]
): Promise<{ text: string; warn: boolean } | undefined> {
  useLogFile(work.folderPath);
  const renames: EpisodeFileRename[] = [];
  for (const pair of pairs) {
    const fromPath = paths.join(work.folderPath, pair.fromRel);
    const toPath = paths.join(work.folderPath, pair.toRel);
    if ((await exists(fromPath)) || !(await exists(toPath))) continue;
    renames.push({ fromPath, toPath });
  }
  if (renames.length === 0) return undefined;
  const summary = await followEpisodeFileRenames(work, renames);
  return ledgerRenameNotice(`「${work.title}」で名前が変わった話に合わせて、`, summary);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(paths.toUri(filePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * 候補が2つ以上ある話について、投稿したときの本文の印（6.68.7）と今の本文が合う組を集める。
 *
 * 印には題も入る（`v2:`）。題は旧名から読んだものを使う——投稿したときの題は旧名の
 * ものなので、名前だけを変えた話なら印が合う。新名の題でも比べる（中身の題が
 * ファイル名より先に使われる話もある。`extractEpisodeParts`）。**印の無い話・合本の
 * 1話の記録は見ない**（読まなくてよい本文を読まない）。
 */
async function hashConfirmedPairs(
  work: WorkEntry,
  list: ReadonlyArray<{ fromRel: string; candidates: string[] }>
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const ambiguous = list.filter((item) => item.candidates.length > 1);
  if (ambiguous.length === 0) return confirmed;
  let ledger;
  try {
    ledger = await new PostingStore(work).load();
  } catch {
    return confirmed;
  }
  const records = [...ledger.posts, ...(ledger.revisions ?? [])];
  for (const item of ambiguous) {
    const sent = new Set(
      records
        .filter(
          (record) =>
            normalizeEpisodePath(record.episodePath) === item.fromRel &&
            record.bodyHash &&
            !("chapter" in record && record.chapter !== undefined) &&
            !("order" in record && record.order !== undefined)
        )
        .map((record) => record.bodyHash as string)
    );
    if (sent.size === 0) continue;
    const oldSubtitle = parseEpisodeFileName(paths.basename(item.fromRel)).subtitle;
    for (const candidate of item.candidates) {
      try {
        const { text } = await readTextFile(paths.join(work.folderPath, candidate));
        const newSubtitle = parseEpisodeFileName(paths.basename(candidate)).subtitle;
        const hit = [oldSubtitle, newSubtitle].some((subtitle) => {
          const { units, collected } = postingUnitsOf(text, subtitle);
          if (collected) return false;
          const hashes = postingTextHashes(units[0].subtitle, units[0].body);
          return (
            sent.has(hashes.notation) || sent.has(hashes.titled) || sent.has(hashes.bodyOnly)
          );
        });
        if (hit) confirmed.add(`${item.fromRel}\u0000${candidate}`);
      } catch {
        // 読めない候補は印で絞れないだけ（訊かない側へ倒れる）
      }
    }
  }
  return confirmed;
}
