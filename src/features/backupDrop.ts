import * as vscode from "vscode";
import * as path from "../core/paths";
import { isEditorMode } from "../core/actorContext";
import {
  backupIdentityOf,
  describeMatchBy,
  matchBackupToWorks,
  type BackupIdentity,
  type BackupMatch,
  type BackupMatchBy,
  type BackupMatchCandidate,
  type DifferentIdWork,
} from "../core/backupMatch";
import {
  BACKUP_DIFF_RECORD_KIND,
  buildBackupDiffRecord,
  describeMergePlan,
  describeReaderStatsCounts,
  isEmptyMergePlan,
  planBackupMerge,
  summarizeMergeResult,
  type BackupMergePlan,
  type LocalManuscriptSource,
} from "../core/backupMerge";
import { hunkProposalsOf, type BackupHunkProposal } from "../core/backupHunks";
import {
  missingEpisodeFiles,
  type MissingEpisodeFile,
} from "../core/backupMissingEpisodes";
import { readTextFile } from "../core/textFile";
import type { Chapter } from "../models/chapter";
import {
  nameNewEpisodes,
  writeNewEpisodes,
  type EpisodeNotAdded,
  type NamedEpisodeFile,
  type WorkScan,
} from "./addEpisodeFiles";
import { episodePathFor } from "../core/bookStore";
import { ChapterStore } from "../core/chapterStore";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { PostingStore } from "../core/postingStore";
import { scanWork } from "../core/scanner";
import {
  inspectWorkBackup,
  WorkZipError,
  type WorkZipInspection,
} from "../core/workZip";
import {
  BACKUP_DROP_MAX_BYTES,
  isBackupFileName,
  isWordFileName,
  tooLargeMessage,
} from "../core/backupFileKinds";
import { receiveWordManuscript } from "./wordDrop";
import type { ChapterSet } from "../models/chapter";
import {
  withReaderStats,
  withSiteProfile,
  type PostingLedger,
} from "../models/posting";
import type { WorkEntry } from "../models/types";
import { pickDropTarget } from "./dropTargetPick";
import { saveGeneratedMarkdown } from "../views/openDocument";
import { withProgress } from "../views/progress";
import type { PickedBackup } from "./importWorkFromZip";

/**
 * 相談パネルへ持ち込まれたバックアップを受け取る（作者の依頼、2026-09-23）。
 *
 * 「製品の相談パネルにバックアップファイルを放り込んだら、既存作品に該当
 * （タイトルなど）がないか確認して、あれば章やいいねやコメントや修正部分の
 * 取り込みだけ。なさそうなら作者に確認の上取り込み処理を走らせてください」
 *
 * ## 流れ
 *
 * 1. 読んで確かめる（`inspectWorkBackup`。**この時点では1文字も書かない**）
 * 2. どの作品のものかを決める（`core/backupMatch.ts`。作品ID→題→部分一致）
 * 3. **当たったと決めつけない。** 当たった作品と、足すものの一覧を見せて確かめる
 * 4. 当たらなければ、作者に確かめてから「バックアップから取り込む」と同じ
 *    処理で新しい作品にする（`importWorkFromZip`。写しを作らない）
 *
 * ## 原稿は書き換えない
 *
 * 本文の違いは数えて記録に書き出し、**違い1か所ずつを提案パネルへ並べる**
 * （作者の裁定、2026-09-23。理由は `core/backupMerge.ts`）。採るかどうかは
 * 提案パネルで作者が選び、書き込みもそちらが行う。ここで書き込むのは章立ての
 * 台帳と投稿状態の台帳だけで、どちらもハッシュ照合つきの保存口
 * （`ChapterStore`・`PostingStore`）を通す。
 */

/** 新しい作品として取り込む口（`extension.ts` の登録の道を持っている側が渡す） */
export type ImportAsNewWork = (picked: PickedBackup) => Promise<void>;

/**
 * 本文の違いを提案パネルへ並べる口（設計書6.99.7。作者の裁定、2026-09-23）。
 *
 * **提案パネルの実体は `extension.ts` にしか無い**ので、相談パネルからは
 * 直に届かない。`ImportAsNewWork` と同じ形で、持っている側から渡してもらう。
 */
export type ShowBackupProposals = (
  work: WorkEntry,
  proposals: readonly (BackupHunkProposal & { readonly filePath: string })[]
) => void;

/** `receiveBackup` へ渡す、拡張機能の側の口 */
export interface BackupDropDeps {
  readonly works: readonly WorkEntry[];
  /** 新しい作品として取り込む口。渡されなければメニューの取り込みを開く */
  readonly importAsNew?: ImportAsNewWork;
  /** 本文の違いを提案パネルへ並べる口。渡されなければ記録へ書き出すだけ */
  readonly showProposals?: ShowBackupProposals;
  /**
   * 手元に無い話をファイルとして足したあとに呼ぶ口（作品一覧の読み直しと、
   * 執筆量の基準の置き直し。どちらも `extension.ts` にしか無い）
   */
  readonly afterEpisodesAdded?: (work: WorkEntry) => Promise<void>;
}

/** 相談パネルに出す結果 */
export interface BackupDropResult {
  /** 短い一文 */
  readonly message: string;
  /** 本文の違いの記録を書き出せたら、その場所 */
  readonly recordPath?: string;
}

/**
 * 受け取ったバックアップを捌く。
 *
 * @returns 相談パネルに出す結果。**作者が取りやめたら undefined**（何も出さない）
 */
export async function receiveBackup(
  source: {
    readonly fileName: string;
    readonly bytes: Uint8Array;
    /**
     * 落とされたファイルの場所（エクスプローラーから落としたときだけ分かる）。
     * Word 原稿が作品フォルダーの中にあれば、その作品の続きと見る手掛かりになる
     */
    readonly sourcePath?: string;
  },
  deps: BackupDropDeps
): Promise<BackupDropResult | undefined> {
  /*
    **Word 原稿（.docx）は別の道へ**（作者の裁定、2026-09-23）。受け口は
    バックアップと同じ1つにして、中で分ける——相談パネルの側は、落とされた
    ものが何かを知らなくてよい。
  */
  if (isWordFileName(source.fileName)) {
    return receiveWordManuscript(source, deps);
  }
  // **編集部は取り込まない**（設計書5.6）。「バックアップから取り込む」は
  // 編集者モードで使えない操作なので、持ち込みの口からも開かない
  /*
    **作品が決まるまでは、拡張機能の保管庫の記録へ書く**（2026-09-23、実機）。

    書き先は `useLogFile` で切り替わるまで直前のままなので、切り替えずに
    照合を書くと、**直前に触った関係の無い作品の記録へ紛れる**。実機では
    確認用の作品へ取り込んだ回の照合が、作者の本物の作品（教科書チート）の
    記録に入り、取り込んだ先には何も残っていなかった。
    取り込み先が決まったら `mergeIntoWork` がその作品へ切り替え、照合の
    結果もそちらへ書き直す。
  */
  useLogFile(undefined);

  if (isEditorMode()) {
    return {
      message:
        "編集者モードでは、バックアップの取り込みはできません（作者の環境で行ってください）。",
    };
  }

  if (!isBackupFileName(source.fileName)) {
    return {
      message:
        `「${source.fileName}」はバックアップとして読めません。` +
        "投稿サイトからダウンロードした ZIP か .txt、または Word 原稿（.docx）を渡してください。",
    };
  }
  if (source.bytes.byteLength > BACKUP_DROP_MAX_BYTES) {
    return { message: tooLargeMessage(source.fileName) };
  }

  let inspection: WorkZipInspection;
  try {
    inspection = await withProgress("バックアップの中を見ています…", async () =>
      inspectWorkBackup(source.bytes, source.fileName)
    );
  } catch (error) {
    if (error instanceof WorkZipError) {
      return {
        message: [error.message, error.detail ?? ""].filter(Boolean).join(" "),
      };
    }
    logFailure("相談パネル：バックアップの読み取り", {
      ファイル: source.fileName,
      詳細: messageOf(error),
    });
    return { message: `バックアップを読めませんでした：${messageOf(error)}` };
  }

  const identity = backupIdentityOf(inspection);
  const candidates = await matchCandidates(deps.works);
  const match = matchBackupToWorks(identity, candidates);
  const matchNote = `「${path.basename(source.fileName)}」の照合：${describeMatchForLog(match)}`;
  logStep(`相談パネル：バックアップ${matchNote}`);

  const picked: PickedBackup = { fileName: source.fileName, inspection };
  const target = await chooseTarget(match, identity, inspection, deps.works);
  if (target === undefined) {
    logStep("相談パネル：バックアップの取り込みを取りやめました（取り込み先を決める前）");
    return undefined;
  }
  if (target === "new") {
    logStep("相談パネル：バックアップを新しい作品として取り込む道へ回しました");
    return importAsNewWork(picked, deps.importAsNew);
  }
  return mergeIntoWork(target.work, target.by, identity, picked, matchNote, deps);
}

/* ── どの作品に当たるか ───────────────────────────────── */

/**
 * 照らす相手の一覧を作る。**台帳を読めなかった作品も、題では照らす**
 * （作品IDが無いだけで、候補から外す理由にはならない）。
 */
async function matchCandidates(
  works: readonly WorkEntry[]
): Promise<BackupMatchCandidate[]> {
  const candidates: BackupMatchCandidate[] = [];
  for (const work of works) {
    let siteIds: BackupMatchCandidate["siteIds"] = [];
    try {
      const ledger = await new PostingStore(work).load();
      siteIds = (ledger.siteProfiles ?? [])
        .filter((entry) => typeof entry.workId === "string" && entry.workId !== "")
        .map((entry) => ({ site: entry.site, workId: entry.workId as string }));
    } catch (error) {
      logStep(
        `相談パネル：「${work.title}」の投稿状態を読めなかったため、題だけで照らします（${messageOf(error)}）`
      );
    }
    candidates.push({
      id: work.id,
      title: work.title,
      folderName: path.basename(work.folderPath),
      siteIds,
    });
  }
  return candidates;
}

type Target = { work: WorkEntry; by: BackupMatchBy | "chosen" } | "new";

/**
 * 取り込み先を決める。**どの道でも作者に確かめる。**
 *
 * @returns 作者が取りやめたら undefined
 */
async function chooseTarget(
  match: BackupMatch,
  identity: BackupIdentity,
  inspection: WorkZipInspection,
  works: readonly WorkEntry[]
): Promise<Target | undefined> {
  const byId = new Map(works.map((work) => [work.id, work]));

  if (match.kind === "matched") {
    const work = byId.get(match.workId);
    // 当たった作品は、このあと足すものの一覧と一緒に確かめる（`mergeIntoWork`）
    if (work) return { work, by: match.by };
  }

  if (match.kind === "ambiguous") {
    return pickWork(
      match.workIds
        .map((id) => byId.get(id))
        .filter((work): work is WorkEntry => work !== undefined),
      works,
      `「${identity.title}」に当たりそうな作品が${match.workIds.length}つあります（${describeMatchBy(match.by, identity)}）。どれへ取り込みますか？`
    );
  }

  // どれにも当たらない。**新しい作品にする前に、必ず確かめる**
  const differs = describeDifferentId(match.differentId, byId, identity);
  const answer = await vscode.window.showInformationMessage(
    `「${identity.title}」は、登録済みの作品には見当たりませんでした。新しい作品として取り込みますか？`,
    {
      modal: true,
      detail: [
        `話の数：${inspection.episodeCount}話`,
        ...(differs ? ["", differs] : []),
        "",
        "既にある作品のバックアップなら「既にある作品を選ぶ」から選べます。",
      ].join("\n"),
    },
    "新しい作品として取り込む",
    "既にある作品を選ぶ"
  );
  if (answer === "新しい作品として取り込む") return "new";
  if (answer === "既にある作品を選ぶ") {
    return pickWork([], works, "どの作品のバックアップですか？");
  }
  return undefined;
}

/**
 * 題では当たったが作品IDが違った作品について、一言添える。
 *
 * **一致の種類で言い分ける**（2026-09-23、実機）。題の一部しか合っていない
 * 作品に「題が同じですが」と言うと、作者は「同じ題の作品なんてあったか」と
 * 探しにいく。
 */
function describeDifferentId(
  differs: readonly DifferentIdWork[],
  byId: ReadonlyMap<string, WorkEntry>,
  identity: BackupIdentity
): string {
  const titlesBy = (by: DifferentIdWork["by"]): string[] =>
    differs
      .filter((entry) => entry.by === by)
      .map((entry) => byId.get(entry.workId)?.title)
      .filter((title): title is string => title !== undefined);
  const reason =
    `投稿状態に書いてある作品IDがこのバックアップ（${
      identity.workId?.toUpperCase() ?? ""
    }）と違うため、別の作品と見ました。`;
  const lines: string[] = [];
  const same = titlesBy("title");
  if (same.length > 0) {
    lines.push(`「${same.join("」「")}」は題が同じですが、${reason}`);
  }
  const partial = titlesBy("partial");
  if (partial.length > 0) {
    lines.push(`「${partial.join("」「")}」は題の一部が同じですが、${reason}`);
  }
  return lines.join("\n");
}

/**
 * 作品を選ばせる（選び方は Word 原稿と共有。`dropTargetPick.ts`）。
 */
async function pickWork(
  candidates: readonly WorkEntry[],
  works: readonly WorkEntry[],
  title: string
): Promise<Target | undefined> {
  const picked = await pickDropTarget(candidates, works, title);
  if (picked === undefined || picked === "new") return picked;
  return { work: picked, by: "chosen" };
}

/* ── 当たらなかった：新しい作品として ─────────────────── */

async function importAsNewWork(
  picked: PickedBackup,
  importer: ImportAsNewWork | undefined
): Promise<BackupDropResult> {
  if (importer) {
    // 確かめ・置き場・題・展開・登録は、すべて取り込みの道が持っている
    await importer(picked);
    return { message: `「${picked.inspection.title}」の取り込みを進めました。` };
  }
  /*
    **取り込みの道がまだ繋がっていないとき。** 登録の道は `extension.ts` が
    持っており、相談パネルからは直に呼べない。メニューの「バックアップから
    取り込む」を開き、同じファイルをもう一度選んでもらう（写しを作るより、
    ひと手間のほうが安全である）。
  */
  await vscode.commands.executeCommand("novelai.importWorkFromZip");
  return {
    message:
      "「バックアップ取込」を開きました。同じファイルをもう一度選んでください。",
  };
}

/* ── 当たった：足すものだけ足す ───────────────────────── */

async function mergeIntoWork(
  work: WorkEntry,
  by: BackupMatchBy | "chosen",
  identity: BackupIdentity,
  picked: PickedBackup,
  /** 照合の結果（保管庫の記録へ書いたものと同じ一文）。取り込み先の記録にも残す */
  matchNote: string,
  deps: BackupDropDeps
): Promise<BackupDropResult | undefined> {
  useLogFile(work.folderPath);
  // **取り込み先の記録だけで経緯が追えるようにする。** 照合の一文は作品が
  // 決まる前に保管庫へ書いたので、ここでもう一度書く
  logStep(
    `相談パネル：バックアップ${matchNote} → 取り込み先「${work.title}」（${
      by === "chosen" ? "作者が選んだ" : describeMatchBy(by, identity)
    }）`
  );

  const chapterStore = new ChapterStore(work);
  let chapterSet: ChapterSet | null = null;
  try {
    chapterSet = await chapterStore.load();
  } catch (error) {
    logFailure("相談パネル：バックアップの取り込みで章立てを読めなかった", {
      作品: work.title,
      詳細: messageOf(error),
    });
  }

  const postingStore = new PostingStore(work);
  let ledger: PostingLedger | null = null;
  try {
    ledger = await postingStore.load();
  } catch (error) {
    logFailure("相談パネル：バックアップの取り込みで投稿状態を読めなかった", {
      作品: work.title,
      詳細: messageOf(error),
    });
  }

  const { sources: local, scan } = await withProgress(
    "手元の原稿と比べています…",
    () => readLocalSources(work)
  );

  const plan = planBackupMerge({
    inspection: picked.inspection,
    local,
    existingChapters: chapterSet ? chapterSet.chapters : null,
    ledger,
    readAt: new Date().toISOString(),
  });

  const describeOptions = { proposals: deps.showProposals !== undefined };
  const heading =
    by === "chosen"
      ? `「${work.title}」へ取り込みますか？`
      : `「${work.title}」に当たりました（${describeMatchBy(by, identity)}）。取り込みますか？`;

  if (isEmptyMergePlan(plan)) {
    // 足すものが無くても、**当たった作品は見せる**（違う作品に当たっていないか
    // 作者が確かめられるように）。押すものは無いので、知らせるだけにする
    void vscode.window.showInformationMessage(heading.replace("取り込みますか？", ""), {
      modal: true,
      detail: [
        "足すものはありませんでした。",
        "",
        ...describeMergePlan(plan, describeOptions),
      ].join("\n"),
    });
    logStep(`相談パネル：「${work.title}」に足すものはありませんでした`);
    return { message: `「${work.title}」に足すものはありませんでした。` };
  }

  /*
    **手元に無い話は、押す前に名前まで決めて見せる**（作者の裁定、2026-09-23：
    「確認画面に話の題を並べ、押したら新しい話のファイルとして足す」）。
    名前を決められなかった話・中身を用意できなかった話も、ここで言う。
  */
  const prepared = missingEpisodeFiles(picked.inspection, plan.missingEpisodes);
  const naming = nameNewEpisodes(
    prepared.files,
    scan,
    local.map((source) => source.manuscriptName)
  );
  const notAdded = [...prepared.skipped, ...naming.skipped];
  const episodeLines: string[] = [];
  if (naming.named.length > 0) {
    episodeLines.push(
      `　足すファイル：${listNames(naming.named.map((entry) => entry.name))}` +
        `（${path.basename(scan.manuscriptDir)} の中）`
    );
  }
  if (notAdded.length > 0) {
    episodeLines.push(
      `　足せない話が${notAdded.length}話あります：` +
        notAdded
          .slice(0, 3)
          .map((entry) => `${entry.label}（${entry.reason}）`)
          .join("、")
    );
  }

  const ADD_ALL = "取り込む";
  const WITHOUT_EPISODES = "話は足さずに取り込む";
  const answer = await vscode.window.showInformationMessage(
    heading,
    {
      modal: true,
      detail: [
        `取り込む元：${path.basename(picked.fileName)}`,
        "",
        ...describeMergePlan(plan, describeOptions),
        ...(episodeLines.length > 0 ? ["", ...episodeLines] : []),
      ].join("\n"),
    },
    // **話を足すかは別に選べるようにする**（いいねだけ欲しい、ということがある）
    ...(naming.named.length > 0 ? [ADD_ALL, WITHOUT_EPISODES] : [ADD_ALL])
  );
  if (answer !== ADD_ALL && answer !== WITHOUT_EPISODES) {
    logStep(`相談パネル：「${work.title}」への取り込みを取りやめました（確かめの画面で押さなかった）`);
    return undefined;
  }

  return applyMergePlan(
    work,
    picked,
    plan,
    {
      chapterStore,
      chapterSet,
      postingStore,
      ledger,
    },
    deps,
    {
      scan,
      files: answer === ADD_ALL ? naming.named : [],
      notAdded: answer === ADD_ALL ? notAdded : [],
    }
  );
}

/** ファイル名を3つまで並べ、残りは数で言う */
function listNames(names: readonly string[]): string {
  const listed = names.slice(0, 3).join("、");
  return names.length > 3 ? `${listed} ほか${names.length - 3}件` : listed;
}

/**
 * 手元の原稿を読む。**読めないファイルがあっても止めない**（その話だけ比べない）。
 */
async function readLocalSources(
  work: WorkEntry
): Promise<{ sources: LocalManuscriptSource[]; scan: WorkScan }> {
  const scan = await scanWork(work);
  const sources: LocalManuscriptSource[] = [];
  for (const episode of scan.episodes) {
    let text: string | null = null;
    let hash: string | undefined;
    try {
      const file = await readTextFile(episode.filePath);
      text = file.text;
      // **読んだときのハッシュを持ち回る**（設計書6.99.7）。違いを提案にしたとき、
      // 当てる直前にこれと照らす——並べてから原稿が変わっていたら当てない
      hash = file.hash;
    } catch (error) {
      logFailure("相談パネル：バックアップと比べる原稿を読めなかった", {
        ファイル: episode.filePath,
        詳細: messageOf(error),
      });
    }
    sources.push({
      relPath: episodePathFor(work.folderPath, episode.filePath),
      manuscriptName: path
        .relative(scan.manuscriptDir, episode.filePath)
        .replace(/\\/g, "/"),
      text,
      ...(hash === undefined ? {} : { hash }),
    });
  }
  return { sources, scan };
}

/**
 * 足した話から始まる章を、章の台帳の**末尾へ足す**。
 *
 * **台帳に作者の章が既にあるときだけ**（空の台帳に章を立てるのは
 * `planChapters` の役目で、そちらは手元の全部の話が揃っていないと
 * 立てない）。作者の章は1つも変えない。同じ名前の章が既にあれば足さない。
 *
 * 章の台帳は「章の始まりの話」だけを持つので、章の途中に足した話は
 * 台帳に載せなくても、並びでその章に入る。
 *
 * @returns 足した章の数
 */
async function appendChaptersForAdded(
  work: WorkEntry,
  stores: { chapterStore: ChapterStore; chapterSet: ChapterSet | null },
  added: readonly { file: MissingEpisodeFile; path: string }[]
): Promise<number> {
  const set = stores.chapterSet;
  if (!set || set.chapters.length === 0) return 0;
  const names = new Set(set.chapters.map((chapter) => chapter.name));
  const extra: Chapter[] = [];
  for (const entry of [...added].sort((a, b) => a.file.order - b.file.order)) {
    const part = entry.file.part;
    if (!part || names.has(part)) continue;
    names.add(part);
    extra.push({ name: part, startEpisodePath: episodePathFor(work.folderPath, entry.path) });
  }
  if (extra.length === 0) return 0;
  await stores.chapterStore.save({ ...set, chapters: [...set.chapters, ...extra] });
  return extra.length;
}

/**
 * 決めたものを書く。**1つ失敗しても残りは続ける**（章が書けなくても、
 * いいねは足せる）。失敗したものは結果の一文に入れる。
 */
async function applyMergePlan(
  work: WorkEntry,
  picked: PickedBackup,
  plan: BackupMergePlan,
  stores: {
    chapterStore: ChapterStore;
    chapterSet: ChapterSet | null;
    postingStore: PostingStore;
    ledger: PostingLedger | null;
  },
  deps: BackupDropDeps,
  episodes: {
    scan: WorkScan;
    /** 足す話（作者が「話は足さずに」を選んだら空） */
    files: readonly NamedEpisodeFile[];
    /** 押す前から足せないと分かっていた話 */
    notAdded: readonly EpisodeNotAdded[];
  }
): Promise<BackupDropResult> {
  const failures: string[] = [];

  let chapters = 0;
  if (plan.chapters.kind === "create" && stores.chapterSet) {
    try {
      // 確認のあいだに外で台帳が変わっていれば、保存の照合が止める
      await stores.chapterStore.save({
        ...stores.chapterSet,
        chapters: [...plan.chapters.chapters],
      });
      chapters = plan.chapters.chapters.length;
    } catch (error) {
      failures.push("章");
      logFailure("相談パネル：バックアップの章を書けなかった", {
        作品: work.title,
        詳細: messageOf(error),
      });
    }
  }

  let stats = { work: false, episodes: 0 };
  if (stores.ledger && (plan.readerStats.length > 0 || plan.profile)) {
    try {
      let next = stores.ledger;
      if (plan.profile) {
        next = withSiteProfile(next, plan.profile.site, plan.profile.value);
      }
      for (const record of plan.readerStats) {
        next = withReaderStats(next, record);
      }
      await stores.postingStore.save(next);
      stats = describeReaderStatsCounts(plan.readerStats);
    } catch (error) {
      failures.push("読者の反応");
      logFailure("相談パネル：バックアップの読者の反応を書けなかった", {
        作品: work.title,
        詳細: messageOf(error),
      });
    }
  }

  /*
    **手元に無い話を、新しい話のファイルとして足す**（作者の裁定、2026-09-23）。
    既存の話には触らない（`mode: "create"` だけ）。章のある作品では、
    足した話から始まる章を台帳の末尾へ足す。
  */
  const written = await writeNewEpisodes(work, episodes.scan, episodes.files);
  const notAdded = [...episodes.notAdded, ...written.skipped];
  let appendedChapters = 0;
  if (written.added.length > 0) {
    try {
      appendedChapters = await appendChaptersForAdded(work, stores, written.added);
    } catch (error) {
      failures.push("足した話の章");
      logFailure("相談パネル：足した話の章を台帳へ書けなかった", {
        作品: work.title,
        詳細: messageOf(error),
      });
    }
    // 作品一覧と執筆量の基準を直してもらう（基準を置き直さないと、次に書いた分が
    // 「ファイル数が変わった回」として数えられずに消える。設計書6.3.2）
    if (deps.afterEpisodesAdded) {
      try {
        await deps.afterEpisodesAdded(work);
      } catch (error) {
        logFailure("相談パネル：話を足したあとの一覧の読み直し", {
          作品: work.title,
          詳細: messageOf(error),
        });
      }
    }
  }

  let recordPath: string | undefined;
  if (plan.bodyDiffs.length > 0) {
    recordPath = await saveGeneratedMarkdown(
      BACKUP_DIFF_RECORD_KIND,
      buildBackupDiffRecord({
        workTitle: work.title,
        sourceName: path.basename(picked.fileName),
        diffs: plan.bodyDiffs,
      }),
      work
    );
    if (!recordPath) failures.push("本文の違いの記録");
  }

  /*
    **違い1か所ずつを提案パネルに並べる**（作者の裁定、2026-09-23）。
    ここでは原稿に1文字も触らない——採るかどうかは提案パネルで作者が
    箇所ごとに選び、書き込みはそちら（ハッシュの照合つき）が行う。
    位置を決められなかった違いは提案にしない（記録にだけ残る）。
  */
  let proposals = 0;
  if (deps.showProposals && plan.bodyDiffs.length > 0) {
    const hunks = plan.bodyDiffs.flatMap((diff) =>
      hunkProposalsOf(diff).map((proposal) => ({
        ...proposal,
        filePath: path.join(work.folderPath, proposal.relPath),
      }))
    );
    if (hunks.length > 0) {
      try {
        deps.showProposals(work, hunks);
        proposals = hunks.length;
      } catch (error) {
        failures.push("提案パネルへの並べ");
        logFailure("相談パネル：バックアップとの違いを提案パネルへ並べられなかった", {
          作品: work.title,
          詳細: messageOf(error),
        });
      }
    }
  }

  /*
    **取り込み先の記録に、何を足したかを残す**（2026-09-23、実機）。
    以前は照合の1行しか書かず、しかもそれが別の作品の記録へ落ちていたので、
    取り込んだ先には成功したことも足したものも残っていなかった。
  */
  const wroteProfile = plan.profile !== null && !failures.includes("読者の反応");
  logStep(
    `相談パネル：「${path.basename(picked.fileName)}」を「${work.title}」へ取り込みました：` +
    [
      `章${chapters}`,
      `いいね${stats.episodes}話ぶん`,
      `作品全体の評価${stats.work ? "あり" : "なし"}`,
      `作品ID${wroteProfile ? "を書いた" : "は書かず"}`,
      `本文の違い${plan.bodyDiffs.length}話${recordPath ? `（記録：${recordPath}）` : ""}`,
      `提案パネルへ${proposals}か所`,
      `新しい話${written.added.length}話${
        written.added.length > 0
          ? `（${written.added.map((entry) => path.basename(entry.path)).join("、")}）`
          : ""
      }`,
      ...(appendedChapters > 0 ? [`足した話の章${appendedChapters}`] : []),
      ...(notAdded.length > 0
        ? [
            `足せなかった話：${notAdded
              .map((entry) => `${entry.label}（${entry.reason}）`)
              .join("、")}`,
          ]
        : []),
      ...(failures.length > 0 ? [`書けなかったもの：${failures.join("・")}`] : []),
    ].join("・")
  );

  const summary = summarizeMergeResult({
    workTitle: work.title,
    chapters,
    likesEpisodes: stats.episodes,
    workStats: stats.work,
    bodyDiffs: plan.bodyDiffs.length,
    recorded: recordPath !== undefined,
    proposals,
    addedEpisodes: written.added.length,
  });
  // **足せなかった話は黙って落とさない**（同じ名前のファイルがあった等）
  const notAddedNote =
    notAdded.length > 0
      ? `（足せなかった話${notAdded.length}話：${notAdded
          .slice(0, 3)
          .map((entry) => `${entry.label}——${entry.reason}`)
          .join("、")}）`
      : "";
  return {
    message:
      (failures.length > 0
        ? `${summary}（${failures.join("・")}は書けませんでした。詳しくは記録（ログ）をご覧ください）`
        : summary) + notAddedNote,
    recordPath,
  };
}

/* ── 小物 ─────────────────────────────────────────────── */

function describeMatchForLog(match: BackupMatch): string {
  switch (match.kind) {
    case "matched":
      return `当たり（${match.by}）`;
    case "ambiguous":
      return `候補${match.workIds.length}件（${match.by}）`;
    case "none":
      return "当たりなし";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
