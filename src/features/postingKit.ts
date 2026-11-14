import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { openSiteLink } from "./openSiteLink";
import {
  firstUnpostedEpisodePath,
  hasBodyHashFor,
  latestRanking,
  parseRankInput,
  POSTING_SITES,
  postingSiteInfo,
  postedSites,
  postingSiteLabels,
  postRecordFor,
  rankingBoardLabel,
  rankingBoards,
  revisionFor,
  siteEpisodeIdFor,
  siteFactsFor,
  siteWorkNumberFor,
  sitesNeedingRevision,
  siteProfile,
  titleChangedSinceSent,
  unpostedSites,
  validateNewEpisodeUrl,
  validateRankInput,
  validateSiteWorkIdInput,
  validateWorkPageUrl,
  withBaselinePosts,
  WORK_COMPLETIONS,
  withPost,
  withRanking,
  withRevision,
  withSiteProfile,
  withSites,
  withWorkCompletion,
  workCompletionLabel,
  type PostingEpisodeTarget,
  type PostingLedger,
  type PostingSiteEntry,
  type PostingSiteId,
  type WorkCompletion,
} from "../models/posting";
import { buildWorkPostingFacts } from "../core/postingSiteRecords";
import { READER_SITE_TABS_HINT, readerSiteTabLabel } from "../core/readerSiteTabNames";
import {
  PostingStore,
  PostingStoreError,
  type PostingUnknownValues,
} from "../core/postingStore";
import { episodePathFor } from "../core/bookStore";
// 章の題は作品一覧と同じ源（章立ての台帳を話の並びで束ねたもの）から引く
import { ChapterStore, ChapterStoreError } from "../core/chapterStore";
import { chapterNameOfEpisode } from "../core/chapterGrouping";
import type { Chapter } from "../models/chapter";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { extractEpisodeParts } from "../core/episodeCopy";
// 貼り付け先ごとの分岐は、入口ではなく変換の側に置く（設計書6.84）
import { convertForPosting } from "../core/postingConvert";
import { postingCopyTargetFor } from "../core/postingCopyTargets";
import {
  buildPostingEnvelope,
  newPostRef,
  supportsPasteHelper,
} from "../core/postingEnvelope";
// 案内のあいだにヘルパーから届いた番号の預かり（6.68.8）
import {
  applyQueuedPostingUpdates,
  beginPostingKitSession,
  endPostingKitSession,
  queuedPostingUpdatesOf,
  rememberIssuedPostRef,
  type StoredPostingUpdate,
} from "./postingKitSession";
import { settlePendingForWork } from "./postedPendingSettle";
// 同じ数字を2度打たせない——投稿ページのURLから作品IDと作品ページを導く
import {
  deriveSiteProfile,
  followNewEpisodeUrl,
  NEW_EPISODE_URL_FOLLOW_QUESTION,
  newEpisodeUrlDraft,
  planNewEpisodeUrlOnWorkIdChange,
  revisionPageUrl,
} from "../core/postingSiteUrls";
// 投稿したときの本文の印（6.68.7）。投稿の道と判定の道で同じ切り出しを通す
import {
  postingTextHashes,
  postingTitleHash,
  postingTitleHashCandidates,
  postingUnitsOf,
  type PostingUnit,
} from "../core/postingBodyHash";
import { hasEmphasis } from "../core/ruby";
// 合本の中の話の呼び方は1か所に置く（作品ごとの数え方を通す）
import {
  collectedChapterLabel,
  formatChapterLabel,
} from "../core/episodeLabel";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
// 合本かどうかの判断と、話の選ばせ方は1か所に置く（写しを作らない）
import { pickCollectedEpisode } from "./pickCollectedEpisode";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { logFailure, logLine, useLogFile } from "../core/logger";
import type { AIRegistry } from "../ai/registry";
import { generateAnnouncement } from "./generateAnnouncement";
import { notifyDone } from "../views/notify";

/**
 * 投稿キット——「貼るだけ」の新話更新（設計書6.68）。
 *
 * ## 自動投稿はしない（6.68.1）
 *
 * なろう・カクヨム・アルファポリス・noteのいずれにも投稿用の公式APIが無く、
 * 画面の自動操作による投稿は**規約違反でアカウント凍結の危険がある**。
 * **この機能が使う道具は2つだけ**——クリップボードと、URLを開くこと。
 * サイトへHTTPで触りにいく処理は1行も書かない（クロールもしない）。
 *
 * 機械がやるのは「未投稿の話を探す」「サイトの記法へ直す」「クリップボードへ
 * 積む」「投稿ページを開く」「どこまで出したかを記録する」まで。
 * **貼って公開するのは作者**である。
 *
 * ## 原稿には触らない
 *
 * 変換した本文はクリップボードへ入れるだけで、手元の原稿は1文字も
 * 書き換えない（6.12.1と同じ約束）。書き込むのは `設定/投稿状態.json` だけ。
 */

/** 1サイトぶんの案内で、作者が選べること */
type SiteAnswer =
  | "posted"
  /** 修正版を出し直した（6.68.7。出し直しの案内だけに出る） */
  | "revised"
  /** 話の編集画面か作品の管理画面をもう一度開く（出し直しの案内で、開ける画面があるときだけ） */
  | "reopen"
  | "subtitle"
  | "body"
  /** 貼り込み係（ブラウザ拡張）へ渡すJSON封筒でコピーする（設計書6.79.3） */
  | "envelope"
  | "skip"
  | "abort";

export interface PostingKitResult {
  /** 台帳を書き換えたか。呼ぶ側が作品一覧を作り直すのに使う */
  changed: boolean;
}

/** 新話を投稿（`postNewEpisode`）の結果 */
export interface PostNewEpisodeResult extends PostingKitResult {
  /**
   * 新しい話の投稿を1サイトでも記録したか（6.68.7。作者の裁定 2026-11-03 夜）。
   * 手順（はじめの案内など）の「済んだ」はこちらで見る。
   *
   * **`changed` で済んだと数えない。** 台帳は出し直しの記録・初回の設定（基準線）・
   * ヘルパーから届いた番号の預かりでも変わるので、出し直しだけで終えた回まで
   * 「新話投稿を済ませた」ことになり、手順が先へ進んでいた
   */
  postedNew: boolean;
}

/**
 * 新話を投稿（6.68.3）。
 *
 * @param episode 話ノードの右クリックから始めたときの話。
 *   省略すると**未投稿のいちばん古い話**から始める
 */
export async function postNewEpisode(
  work: WorkEntry,
  registry: AIRegistry,
  episode?: EpisodeFile
): Promise<PostNewEpisodeResult> {
  /*
    **案内が開いている間、ヘルパーから届いた番号は預かりへ入る**（設計書6.68.8。`postingKitSession.ts`）。
    受け手が台帳を書くと、この案内の保存が「外部で変更」で止まるため。預かりは『投稿しました』の
    保存に相乗りし、終えるときに残りを書く
  */
  beginPostingKitSession(work.id);
  const store = new PostingStore(work);
  let result: PostNewEpisodeResult = { changed: false, postedNew: false };
  try {
    result = await postNewEpisodeInSession(work, registry, store, episode);
  } finally {
    const flushed = await flushQueuedUpdates(work, store, endPostingKitSession(work.id));
    // 預かりを書いても新しい話を出したことにはならない——投稿したかは案内の結果のまま
    if (flushed) result = { ...result, changed: true };
  }
  return result;
}

async function postNewEpisodeInSession(
  work: WorkEntry,
  registry: AIRegistry,
  store: PostingStore,
  episode?: EpisodeFile
): Promise<PostNewEpisodeResult> {
  // **この先の記録は、その作品のログファイルへ残す**（0.43.3 と同じ）。
  // 本文を読む処理は話しか受け取らないので、入口で向ける
  useLogFile(work.folderPath);
  let ledger = await load(store, work);
  if (!ledger) return { changed: false, postedNew: false };
  let changed = false;
  /** 新しい話の投稿を記録したサイト。出し直し・基準線・預かりの書き込みは入れない（6.68.7） */
  const posted: PostingSiteId[] = [];

  const format = await readWorkFormat(work);
  const relativePathOf = (file: EpisodeFile) =>
    episodePathFor(work.folderPath, file.filePath);

  /*
    **話が決まっているなら走査しない。** 走査は作品の本文を全部読んで
    文字数まで数えるので、200話の作品では体感で分かるほど待たされる。
    右クリックから始めた回は、どの話かが既に分かっている。
    ——ただし初回の設定（基準線）には話の一覧が要るので、そのときは読む。
  */
  let scanned: EpisodeFile[] | undefined;
  const episodesOf = async (): Promise<EpisodeFile[]> =>
    (scanned ??= (await scanWork(work)).episodes);

  // **対象サイトは作品ごとに選ぶ**（6.68.3の3）。noteに出していない作品で
  // noteを訊かないための設定で、初回の1度だけ答えてもらう
  if (ledger.sites.length === 0) {
    const configured = await setUpPosting(
      store,
      work,
      ledger,
      await episodesOf(),
      format
    );
    if (!configured) return { changed: false, postedNew: false };
    ledger = configured.ledger;
    changed = configured.changed;
  }

  /*
    **作品から始めた回は、投稿のあとに本文を直した話があれば先に出し直しを促す**（設計書6.68.7。
    作者の裁定 2026-11-03 昼「『投稿』ボタンを押した時に再投稿を促すように」）。新しい入口は
    足さない。**未投稿の話を選ぶ前に置く**——あとに置くと、全話を出し終えた作品では
    「未投稿の話はありません」で帰ってしまい、促しが出ない。
  */
  if (!episode) {
    const offered = await offerRevisionOfEditedEpisodes({
      store,
      work,
      ledger,
      episodes: await episodesOf(),
      relativePathOf,
      format,
    });
    if (offered.kind === "cancel") return { changed, postedNew: posted.length > 0 };
    if (offered.kind === "revised") return { changed: changed || offered.changed, postedNew: false };
    /*
      出し直しを済ませてから新しい話へ続ける回は、**出し直しを記録したあとの台帳で続ける**。
      手前の台帳のまま続けると、次の保存で出し直しの記録を消してしまう
    */
    if (offered.ledger) {
      ledger = offered.ledger;
      changed = changed || offered.changed === true;
    }
  }

  const target =
    episode ?? pickOldestUnposted(ledger, await episodesOf(), relativePathOf);
  if (!target) {
    void vscode.window.showInformationMessage(
      `${work.title} に未投稿の話はありません（${postingSiteLabels(
        ledger.sites.map((entry) => entry.site)
      )}）。`
    );
    return { changed, postedNew: posted.length > 0 };
  }

  const parts = await readEpisode(target, format);
  if (!parts) return { changed, postedNew: posted.length > 0 };

  /*
    **台帳は話単位で引く**（設計書6.68.2）。合本（1ファイルに全話）からは
    1話だけをコピーして出すので、ファイル単位のままだと第3話を出した時点で
    そのファイル全体が投稿済みになり、第4話が出せなくなっていた。
    合本でないファイルは話数を付けない＝これまでと同じ鍵のままである。
  */
  const postTarget: PostingEpisodeTarget = {
    episodePath: relativePathOf(target),
    ...(parts.collected
      ? { chapter: parts.collected.chapter, order: parts.collected.order }
      : {}),
  };
  const label = postingLabelOf(target, parts.collected, format);
  /*
    投稿・出し直しの記録に残す印（6.68.7）。題と本文の両方で取る（0.124.1。題だけ直した話も促す）。
    合本の1話は、その話の題と本文だけで取る。古い記録（本文だけの印）と比べる形も一緒に作る。
    記録に残すのはルビ・傍点の書き方を寄せた印（`v3:`。0.127.0）——.md にしただけの話を
    「投稿のあとに直した」と言わないため
  */
  const hashes = postingTextHashes(parts.subtitle, parts.body);
  const bodyHash = hashes.notation;

  const sites = unpostedSites(ledger, postTarget);

  /*
    **話を名指しで選び、どこかへもう出している話なら、出し直すかを訊く**（設計書6.68.7。
    作者の依頼 2026-11-03「修正後再投稿に対応してください」）。

    入口を別の命令にせず、ここ（話の右クリックの「この話を投稿する」）に置いた。直した話を
    出し直すときは、どの話かが先に決まっている——作者は直した話の上で右クリックする。
    別の命令にすると話を選び直すことになり、`walkSite` の「選び直させない」流儀と合わない。

    作品から始めた回（話を名指ししない「新話投稿」）はここでは訊かない。未投稿のいちばん古い話を
    出すための入口で、出し直しは「投稿のあとに本文を直した話」があるときだけ、話を選ぶ前に
    促す（`offerRevisionOfEditedEpisodes`）。直した話が無ければ1手も増えない。
  */
  const alreadyPosted = postedSites(ledger, postTarget);
  if (episode && alreadyPosted.length > 0) {
    const edited = sitesNeedingRevision(ledger, postTarget, hashes);
    /*
      **全部のサイトへ出した話は、出し直しだけ**（作者の裁定 2026-11-03 昼。0.123.0 にあった
      「新しい話としてもう一度すべてのサイトへ出す」は消した——同じ話を新しい話として
      2本公開する道になっていた）。選べることが1つしか無いので、出し方は訊かずにサイト選びへ進む
    */
    const mode =
      sites.length === 0 ? "revise" : await askPostingMode(label, sites, alreadyPosted, edited);
    if (!mode) return { changed, postedNew: posted.length > 0 };
    if (mode === "revise") {
      const result = await reviseEpisode({
        store,
        work,
        ledger,
        postTarget,
        label,
        parts,
        bodyHash,
        candidates: alreadyPosted,
        edited,
        allPosted: sites.length === 0,
      });
      return { changed: changed || result.changed, postedNew: false };
    }
  }
  if (sites.length === 0) return { changed, postedNew: posted.length > 0 };

  /*
    **章の題は、封筒を選んだときに1度だけ引く**（作者の頼み 2026-11-01）。
    章の切れ目は話の並びで決まるので、章立てのある作品では走査が要る——
    封筒を使わない回や章の無い作品まで、200話を読ませない。
  */
  let chapterName: Promise<string | undefined> | undefined;
  const chapterOf = () =>
    (chapterName ??= chapterNameOf(work, target, episodesOf));

  const skipped: PostingSiteId[] = [];
  let aborted = false;

  for (const site of sites) {
    /*
      **札はサイトごとに1つ**（6.68.8）。封筒を何度コピーし直しても同じ札を入れる——
      ヘルパーが覚えるのは作品ごとに最後の1件なので、札が変わっても困らないが、
      同じ貼り込みを指す札が2つあると、どちらで照らせばよいかが揺れる
    */
    const postRef = newPostRef();
    let postRefCopied = false;
    const answer = await walkSite({
      ledger,
      site,
      label,
      subtitle: parts.subtitle,
      body: parts.body,
      chapterOf,
      postRef: {
        value: postRef,
        onCopied: (title) => {
          postRefCopied = true;
          rememberIssuedPostRef(work.id, postRef, { site, target: postTarget, title });
        },
      },
    });
    if (answer === "abort") {
      aborted = true;
      break;
    }
    if (answer === "skip") {
      skipped.push(site);
      continue;
    }

    // **1サイトごとに書く**（まとめて最後に書かない）。途中で閉じても、
    // そこまで出したことは残る。台帳の保存はハッシュ照合つき
    // 本文の印も残す（6.68.7。投稿のあとに直したかを、あとで比べるため）
    // 封筒で渡した札も残す（6.68.8。投稿のあとにヘルパーが送り返す番号を、この話へ結ぶため）
    const recorded = withPost(
      ledger,
      postTarget,
      site,
      new Date().toISOString(),
      bodyHash,
      postRefCopied ? postRef : undefined,
      // 題だけの印も残す（出し直しで「題も貼り替えて」を添えるかを、あとで比べるため）
      postingTitleHash(parts.subtitle)
    );
    // 案内のあいだに届いた番号を、同じ保存に相乗りさせる（預かりは終えるときにも当て直す）
    const next = applyQueuedPostingUpdates(recorded, queuedPostingUpdatesOf(work.id)).ledger;
    if (!(await save(store, work, next, "投稿済みの記録（投稿キット）"))) {
      // 同期やヘルパーからの取り込みが先に書いた等。ここで止める——読み直さずに
      // 続けると、こちらの古い手持ちで次のサイトぶんも上書きしてしまう
      return { changed, postedNew: posted.length > 0 };
    }
    ledger = next;
    changed = true;
    posted.push(site);
  }

  await reportResult({ label, posted, skipped, aborted });

  // **最後に更新告知（任意）**（6.68.3の4）。中止したときは誘わない
  if (!aborted && posted.length > 0) {
    await offerAnnouncement(work, registry);
  }

  return { changed, postedNew: posted.length > 0 };
}

/**
 * 貼り込む話が属する章の題（封筒の `chapter`。作者の頼み 2026-11-01）。
 * 章に入っていなければ undefined。
 *
 * **作品一覧が章として見せているものと同じ源**——`設定/章立て.json`
 * （`ChapterStore`）を話の並びで束ねたもの——から引く。本文の見出し行や
 * バックアップは章立てを立てるときの材料で、立てたあとの正は台帳である。
 *
 * 台帳が読めなくても**投稿は止めない**。章の欄が埋まらないだけで、作者は
 * 投稿画面で章を選べる。ただし黙って落とさず、ログと知らせに残す。
 */
async function chapterNameOf(
  work: WorkEntry,
  target: EpisodeFile,
  episodesOf: () => Promise<EpisodeFile[]>
): Promise<string | undefined> {
  let chapters: Chapter[];
  try {
    chapters = (await new ChapterStore(work).load()).chapters;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("投稿キットの章立ての読み込み", {
      作品: work.title,
      種類: error instanceof ChapterStoreError ? error.kind : "unknown",
      内容: detail,
    });
    void vscode.window.showWarningMessage(
      `章立てを読めなかったため、章の題は入れずにコピーします: ${detail}`
    );
    return undefined;
  }
  // 章の無い作品では走査しない（話が決まっている回は走査しない約束を守る）
  if (chapters.length === 0) return undefined;
  return chapterNameOfEpisode(
    await episodesOf(),
    chapters,
    work.folderPath,
    target.filePath
  );
}

/**
 * 未投稿のいちばん古い話（6.68.3の1）。
 *
 * **走査の並びをそのまま使う**（話数順・日付順は走査のほうが正しく知って
 * いる）。競合マーカーのある話は**そもそも候補にしない**——本文を読めない
 * ものを「次に出す話」として案内しても、その先で断ることになる。
 */
function pickOldestUnposted(
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  relativePathOf: (file: EpisodeFile) => string
): EpisodeFile | undefined {
  const candidates = episodes.filter((file) => !file.hasConflictMarkers);
  const found = firstUnpostedEpisodePath(
    ledger,
    candidates.map(relativePathOf)
  );
  if (!found) return undefined;
  return candidates.find((file) => relativePathOf(file) === found);
}

/**
 * 1つのサイトぶんの案内（6.68.3の2）。
 *
 * 変換 → クリップボード → 投稿ページを開く → 「投稿しましたか？」の順。
 * **通知のボタンではなく選択画面にしてある**——サブタイトルと本文を
 * 行き来しながら貼るので、選び直せる必要がある（通知は押すと閉じる）。
 *
 * **貼り込み係へ渡す形（設計書6.79.3）も、この選択画面の1項目に置く。**
 * 別のコマンドを立てると、サイトと話をもう一度選び直すことになる——ここは
 * 既に「どのサイトへ、どの話を」が決まっていて、投稿画面も開いている。
 */
async function walkSite(input: {
  ledger: PostingLedger;
  site: PostingSiteId;
  label: string;
  subtitle: string | null;
  body: string;
  /** 封筒へ入れる章の題（章に入っていなければ undefined） */
  chapterOf: () => Promise<string | undefined>;
  /**
   * 修正版の出し直しか（6.68.7）。出し直しでは、開く画面・案内の文・選べることが変わる。
   * **変換とコピーは同じ道を通す**——案内を2つ書くと、片方だけ変換が古くなる
   */
  revise?: boolean;
  /**
   * 出し直す話の、サイトの話の番号（投稿の記録の `siteEpisodeId`）。
   * あれば話の編集画面を直に開く（6.68.7）。無ければ作品の管理画面
   */
  siteEpisodeId?: string;
  /**
   * 出し直しで、最後にこのサイトへ渡した題と今の題が違うと分かっているか（6.68.7。
   * 作者の裁定 2026-11-03 夜）。真なら案内に題の貼り替えも添える。分からないときは偽
   */
  titleChanged?: boolean;
  /**
   * 封筒へ入れる貼り込みの札（6.68.8）。封筒をコピーしたら `onCopied` を呼ぶ（題の欄へ入れた字を渡す）。
   * 出し直しでは封筒を出さないので渡さない
   */
  postRef?: PostRefSlot;
}): Promise<SiteAnswer> {
  const info = postingSiteInfo(input.site);
  const entry = input.ledger.sites.find((site) => site.site === input.site);
  if (!entry) return "skip";
  const revise = input.revise === true;

  // **4つ目の入口も、同じ変換を通す**（設計書6.84）。記法だけを直して
  // いたころは、noteへ貼る本文だけが整えられないままだった（見出しの段・
  // 引用の空行・画像の目印が抜ける）——貼り付け先ごとの分岐は変換の側にある
  // 1話まるごとを渡すので、前後の空行は落とす（`trimEdges`）
  const body = convertForPosting(input.body, postingCopyTargetFor(input.site), {
    trimEdges: true,
  }).text;
  await vscode.env.clipboard.writeText(body);

  /*
    **出し直しでは、新しい話の投稿ページを開かない**（6.68.7）。修正版をそこへ貼ると、
    同じ話がもう1本の新しい話として公開される。サイトの話の番号が記録にあれば話の編集画面を
    直に開き、無ければ作品の管理画面を開いて、そこから作者に話を選んでもらう。なろうで小説番号が
    まだ届いていなければ、自分の作品の一覧を開く（作者の答え 2026-11-03 昼）。
    どれも組み立てられないサイト（note）では何も開かず、どこを開くかを言う
  */
  const revisionPage = revise
    ? revisionPageUrl({
        site: input.site,
        profile: siteProfile(input.ledger, input.site),
        postUrl: entry.newEpisodeUrl,
        siteEpisodeId: input.siteEpisodeId,
        siteWorkNumber: siteWorkNumberFor(input.ledger, input.site),
      })
    : undefined;
  const pageUrl = revise ? revisionPage?.url : entry.newEpisodeUrl;

  // **開くだけ。** ページの中身は読まないし、操作もしない（6.68.1）
  // Chrome でなければ初回だけ案内してから開く（`openSiteLink`）
  if (pageUrl) await openSiteLink(pageUrl);

  const copiedText = `本文（${body.length.toLocaleString("ja-JP")}字）をコピーしました。`;
  let hint = revise
    ? copiedText +
      (revisionPage?.kind === "episode"
        ? `開いた${input.label}の編集画面で、本文を貼り替えてください。`
        : revisionPage?.kind === "work"
          ? `開いた作品の管理画面から${input.label}の編集画面を開いて、本文を貼り替えてください。`
          : revisionPage?.kind === "list"
            ? `開いた作品の一覧からこの作品を選び、${input.label}の編集画面を開いて、本文を貼り替えてください。`
            : `${info.label}で作品の管理画面を開き、${input.label}の編集画面を開いて、本文を貼り替えてください（${info.label}の管理画面はこちらからは開けません）。`) +
      /*
        題を直した話は、題の欄も貼り替えないとサイトの題が古いまま残る。本文の貼り替えだけを
        案内すると見落とされる。題が同じ・分からない話には添えない（直していない欄まで触らせない）
      */
      (input.titleChanged === true
        ? "題（サブタイトル）も貼り替えてください（「サブタイトルをコピー」でコピーできます）。"
        : "") +
      "保存したら「出し直しました」を選んでください"
    : `${copiedText}貼り付けて公開したら「投稿しました」を選んでください`;
  // **黙って落とさない**（6.68.3）。noteには傍点の記法が無いので印を外す
  if (info.notation === "paren" && hasEmphasis(input.body)) {
    hint += `／${info.label}には傍点の記法が無いため、傍点の印は外しました`;
  }

  for (;;) {
    const picked = await showQuickPickKeepingFocus(
      [
        revise
          ? {
              label: "$(check) 出し直しました",
              // 新しい話を出したとは数えないことを、押す前に言う（未投稿の印は変わらない）
              detail: "修正版を出した日時を記録して、次へ進みます（投稿した日時はそのまま）",
              answer: "revised" as const,
            }
          : {
              label: "$(check) 投稿しました",
              detail: "投稿の記録に残して、次へ進みます",
              answer: "posted" as const,
            },
        {
          label: "$(clippy) サブタイトルをコピー",
          detail: input.subtitle
            ? `「${input.subtitle}」を題名の欄へ貼れます`
            : "この話からはサブタイトルを読み取れませんでした",
          answer: "subtitle" as const,
        },
        {
          label: "$(clippy) 本文をもう一度コピー",
          detail: "クリップボードへ入れ直します",
          answer: "body" as const,
        },
        /*
          貼り込み係へ渡す形（設計書6.79.3）。**対応していないサイトでは
          選択肢そのものを出さない**——押せる形で置いておくと、noteの
          投稿画面で待っても何も起きない理由が作者に分からない。

          **出し直しでも出さない**（6.68.7）。ヘルパーが欄を埋めるのは新しい話の
          投稿画面だけで、話の編集画面ではボタンを押しても何も起きない。
          編集画面へ貼り込めるようになったら（ヘルパー側の仕事）、ここで出す
        */
        ...(!revise && supportsPasteHelper(input.site)
          ? [
              {
                label: "$(link-external) ヘルパーへ渡す形でコピー",
                detail:
                  "題名と本文をまとめた形でコピーします。" +
                  "投稿画面でブラウザ拡張のボタンを押すと、欄が埋まります",
                answer: "envelope" as const,
              },
            ]
          : []),
        ...(revise && pageUrl
          ? [
              {
                label:
                  revisionPage?.kind === "episode"
                    ? "$(link-external) 話の編集画面をもう一度開く"
                    : revisionPage?.kind === "list"
                      ? "$(link-external) 作品の一覧をもう一度開く"
                      : "$(link-external) 作品の管理画面をもう一度開く",
                detail: "閉じてしまったときに。本文はコピーし直しません",
                answer: "reopen" as const,
              },
            ]
          : []),
        {
          label: "$(debug-step-over) このサイトは飛ばす",
          detail: revise
            ? "記録せずに次のサイトへ進みます"
            : "記録せずに次のサイトへ進みます（あとでまた案内します）",
          answer: "skip" as const,
        },
        cancelItem("中止する"),
      ],
      {
        // 題で新しい話の案内と見分けられるようにする（同じ形の画面が続くため）
        title: revise
          ? `${input.label} の修正版を ${info.label} へ`
          : `${input.label} を ${info.label} へ`,
        placeHolder: hint,
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked)) return "abort";
    if (!("answer" in picked)) return "abort";

    if (picked.answer === "subtitle") {
      // **サブタイトルは別口でコピーする**（6.68.3の5）。投稿欄が
      // 題名と本文で分かれているサイトが多い
      if (!input.subtitle) {
        void vscode.window.showWarningMessage(
          `${input.label} からサブタイトルを読み取れませんでした。` +
            "ファイル名か、本文の中の【タイトル】から読み取ります。"
        );
        continue;
      }
      await vscode.env.clipboard.writeText(input.subtitle);
      hint = `「${input.subtitle}」をコピーしました。次は「本文をもう一度コピー」で本文に戻れます`;
      continue;
    }
    if (picked.answer === "reopen") {
      if (pageUrl) await openSiteLink(pageUrl);
      continue;
    }
    if (picked.answer === "body") {
      await vscode.env.clipboard.writeText(body);
      hint = `本文（${body.length.toLocaleString("ja-JP")}字）をコピーし直しました`;
      continue;
    }
    if (picked.answer === "envelope") {
      /*
        **渡すのは、いま作ったものと同じ変換済みの本文**（6.79.3）。
        封筒に包むだけで、サイトごとの変換は上の `convertForPosting` が
        通っている——ここで作り直すと、傍点の扱いが2か所に散る。

        **題名の欄にはサブタイトルを入れる。** 「サブタイトルをコピー」で
        案内しているのと同じ値で揃える（読み取れなければ話の見出し）。

        作品IDは**入っていれば**添える（6.68.5）。貼り込み係が投稿画面の
        URLと突き合わせて、別の作品の画面への貼り込みを止める（6.79.6 の貼り込み先の照合）。

        章の題も**入っていれば**添える（作者の頼み 2026-11-01）。アルファポリスの
        章を選ぶ欄をヘルパーが埋める。ほかのサイトのヘルパーは読まずに済ます。
      */
      const chapter = await input.chapterOf();
      const title = input.subtitle?.trim() || input.label;
      await vscode.env.clipboard.writeText(
        buildPostingEnvelope({
          site: input.site,
          workId: siteProfile(input.ledger, input.site)?.workId,
          title,
          chapter,
          body,
          // 札（6.68.8）。ヘルパーが投稿のあとに送り返し、こちらはそれで話を決める
          postRef: input.postRef?.value,
        })
      );
      input.postRef?.onCopied(title);
      hint =
        "ヘルパーへ渡す形でコピーしました。投稿画面を開いて、" +
        "統合小説執筆環境ヘルパー（ブラウザ拡張）のボタンを押してください。送信はご自身で";
      continue;
    }
    return picked.answer;
  }
}

/** 封筒へ入れる貼り込みの札と、コピーしたときの知らせ先（6.68.8） */
interface PostRefSlot {
  readonly value: string;
  /** 封筒をコピーしたとき（題の欄へ入れた字を渡す） */
  onCopied(title: string): void;
}

/** 名指しした話を、どう出すか（6.68.7） */
type PostingMode = "post" | "revise";

/**
 * まだ出していないサイトと、もう出したサイトの両方がある話を名指しで投稿するとき、
 * どう出すかを訊く（6.68.7）。
 *
 * **先頭に置くのは、今までの既定の動き**（「未投稿のサイトへ出す」。Enter だけで今までどおり進む）。
 * 全部のサイトへ出した話はここへ来ない——出し直ししか無いので、訊かずにサイト選びへ進む。
 *
 * @param edited 投稿のあとに本文を直したサイト（印で分かったものだけ）。出し直しの項目に添える
 * @returns 取りやめたら undefined
 */
async function askPostingMode(
  label: string,
  unposted: readonly PostingSiteId[],
  posted: readonly PostingSiteId[],
  edited: readonly PostingSiteId[]
): Promise<PostingMode | undefined> {
  type ModeItem = vscode.QuickPickItem & { mode: PostingMode };
  const items: ModeItem[] = [
    {
      label: "$(rocket) 未投稿のサイトへ出す",
      description: postingSiteLabels(unposted),
      detail: "新しい話として、投稿ページを開いて案内します",
      mode: "post",
    },
    {
      label: "$(edit) 修正版を出し直す",
      description: postingSiteLabels(posted),
      detail:
        (edited.length > 0
          ? `${postingSiteLabels(edited)}へ投稿したあとに本文を直しています。`
          : "") +
        "投稿済みのサイトで、この話の編集画面へ本文を貼り替えます" +
        "（新しい話としては数えません）",
      mode: "revise",
    },
  ];
  const picked = await showQuickPickKeepingFocus([...items, cancelItem()], {
    title: `${label} の出し方`,
    placeHolder: `${postingSiteLabels(posted)}へは投稿済みです。どう出しますか`,
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !("mode" in picked)) return undefined;
  return picked.mode;
}

/**
 * 修正版を出し直す（6.68.7）。サイトを選ぶ → 1サイトずつ案内 → 「出し直しました」を記録。
 *
 * **記録は `revisions` へ**（`withRevision`）。`posts` には触らないので、未投稿の数も
 * 投稿した日時も変わらない。1サイトごとに書くのは新しい話の投稿と同じ理由（途中で閉じても
 * そこまでの記録は残る。保存はハッシュ照合つき）。記録には出し直したときの本文の印を持たせる
 * （次に「直したか」を比べる相手は、この出し直しになる）。
 *
 * **更新告知は誘わない。** 告知は「新しい話が読めます」を知らせるもので、直した話を
 * 新着として告げると読者の受け取りと食い違う。
 */
/** 出し直しの流れの結果 */
interface RevisionOutcome {
  changed: boolean;
  /** 出し直しを記録したあとの台帳（続けて新しい話を投稿するときは、これで続ける） */
  ledger: PostingLedger;
  /** 最後まで通ったか（サイト選びを閉じた・中止した・保存で止まったときは偽） */
  finished: boolean;
}

async function reviseEpisode(input: {
  store: PostingStore;
  work: WorkEntry;
  ledger: PostingLedger;
  postTarget: PostingEpisodeTarget;
  label: string;
  parts: { subtitle: string | null; body: string };
  /** 出し直す話の印（題と本文。`postingTextHash`） */
  bodyHash: string;
  candidates: readonly PostingSiteId[];
  /** 投稿のあとに本文を直したと分かっているサイト。あれば既定でこれだけに印を付ける */
  edited: readonly PostingSiteId[];
  /** 登録したサイトすべてへ投稿済みか（サイト選びの文を変える） */
  allPosted: boolean;
}): Promise<RevisionOutcome> {
  let ledger = input.ledger;
  const sites = await askRevisionSites({
    ledger,
    target: input.postTarget,
    label: input.label,
    candidates: input.candidates,
    edited: input.edited,
    allPosted: input.allPosted,
  });
  if (!sites || sites.length === 0) return { changed: false, ledger, finished: false };

  let changed = false;
  const revised: PostingSiteId[] = [];
  const skipped: PostingSiteId[] = [];
  let aborted = false;
  // 今の題の印。最後にそのサイトへ渡した題と比べ、違うと分かるサイトだけ題の貼り替えも案内する
  const titleHash = postingTitleHash(input.parts.subtitle);
  // 比べるときは、題を投稿サイトの書き方へ戻した写しも候補にする（.md 化でルビの書き方だけ変わった題）
  const titleCandidates = postingTitleHashCandidates(input.parts.subtitle);
  for (const site of sites) {
    const answer = await walkSite({
      ledger,
      site,
      label: input.label,
      subtitle: input.parts.subtitle,
      body: input.parts.body,
      // 出し直しでは封筒を出さないので、章の題は引かない
      chapterOf: async () => undefined,
      revise: true,
      siteEpisodeId: siteEpisodeIdFor(ledger, input.postTarget, site),
      titleChanged: titleChangedSinceSent(ledger, input.postTarget, site, titleCandidates),
    });
    if (answer === "abort") {
      aborted = true;
      break;
    }
    if (answer !== "revised") {
      skipped.push(site);
      continue;
    }
    const next = withRevision(
      ledger,
      input.postTarget,
      site,
      new Date().toISOString(),
      input.bodyHash,
      titleHash
    );
    if (!(await save(input.store, input.work, next, "修正版の出し直しの記録（投稿キット）"))) {
      return { changed, ledger, finished: false };
    }
    ledger = next;
    changed = true;
    revised.push(site);
  }

  const notes: string[] = [];
  if (revised.length > 0) {
    notes.push(`${postingSiteLabels(revised)}へ修正版を出し直したと記録しました`);
  }
  if (skipped.length > 0) notes.push(`${postingSiteLabels(skipped)}は飛ばしました`);
  if (aborted) notes.push("途中で中止しました");
  if (notes.length > 0) {
    void vscode.window.showInformationMessage(`${input.label}：${notes.join("／")}。`);
  }
  return { changed, ledger, finished: !aborted };
}

/**
 * 出し直すサイトを選ぶ（投稿済みのサイトだけ）。
 *
 * **既定で印を付けるのは、投稿のあとに直したと分かっているサイト**（本文の印で比べた結果）。
 * 分かっているサイトが無ければ全部に付ける——直した話は出したサイトすべてで直すのがふつうで、
 * 1つだけ直すときに外すほうが手数が少ない。
 *
 * 投稿した日と、**いちばん新しい**出し直しの日を添える。出し直しの履歴は台帳に全部残るが、
 * 画面には出さない（作者の裁定 2026-11-03 昼「履歴は見れなくするか、折り畳んでください」）。
 */
async function askRevisionSites(input: {
  ledger: PostingLedger;
  target: PostingEpisodeTarget;
  label: string;
  candidates: readonly PostingSiteId[];
  edited: readonly PostingSiteId[];
  allPosted: boolean;
}): Promise<PostingSiteId[] | undefined> {
  const { ledger, target } = input;
  const dateOf = (iso: string | undefined): string | undefined =>
    iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined;
  const edited = new Set(input.edited);
  const picked = await showQuickPickKeepingFocus(
    input.candidates.map((site) => {
      const post = postRecordFor(ledger, target, site);
      const revision = revisionFor(ledger, target, site);
      const notes = [
        edited.has(site) ? "投稿後に直しています" : undefined,
        post
          ? post.importedBaseline
            ? "導入前に投稿済み"
            : `投稿 ${dateOf(post.postedAt) ?? post.postedAt}`
          : undefined,
        revision ? `修正版 ${dateOf(revision.revisedAt) ?? revision.revisedAt}` : undefined,
      ].filter((note): note is string => Boolean(note));
      return {
        label: postingSiteInfo(site).label,
        description: notes.join("／"),
        site,
        picked: edited.size === 0 || edited.has(site),
      };
    }),
    {
      title: `${input.label} の修正版を出し直すサイト`,
      placeHolder: input.allPosted
        ? `${input.label} は登録したサイトすべてへ投稿済みです。出し直すサイトを選んでください（複数選べます）`
        : "出し直すサイトを選んでください（複数選べます）",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked) return undefined;
  return picked.map((item) => item.site);
}

/** 投稿のあとに本文か題を直した話（作品から投稿を始めたときの促しに使う） */
interface EditedEpisode {
  file: EpisodeFile;
  postTarget: PostingEpisodeTarget;
  label: string;
  unit: PostingUnit;
  /** 記録に残す印（題と本文。`postingTextHash`） */
  bodyHash: string;
  /** 投稿のあとに直したサイト（印が違うもの） */
  sites: PostingSiteId[];
}

/**
 * 投稿のあとに本文か題を直した話を探す（6.68.7）。
 *
 * **本文の印つきの記録がある話だけを読む**（`hasBodyHashFor`）。印の無い話は直したかどうかが
 * 分からないので、読んでも促せない。競合の印がある話は飛ばす（そのまま出し直すと競合の印ごと
 * 公開される。名指しして出すときは `readEpisode` が止める）。
 *
 * 切り出しは投稿の道と同じ `postingUnitsOf`（合本は話ごと、その話の題と本文だけで印を取る）。
 * **読めない話があっても探すのは止めない**——ログへ残して次の話へ進む（促しは補助で、
 * 新しい話の投稿を止める理由にしない）。
 */
async function findEditedEpisodes(input: {
  ledger: PostingLedger;
  episodes: readonly EpisodeFile[];
  relativePathOf: (file: EpisodeFile) => string;
  format: WorkFormatKey | undefined;
}): Promise<EditedEpisode[]> {
  const found: EditedEpisode[] = [];
  for (const file of input.episodes) {
    if (file.hasConflictMarkers) continue;
    const episodePath = input.relativePathOf(file);
    if (!hasBodyHashFor(input.ledger, episodePath)) continue;
    let text: string;
    try {
      const read = await readTextFile(file.filePath);
      if (read.hasConflictMarkers) continue;
      text = read.text;
    } catch (error) {
      logFailure("投稿のあとに直した話の確かめ（本文の読み込み）", {
        ファイル: file.fileName,
        内容: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const unit of postingUnitsOf(text, file.subtitle).units) {
      if (!unit.body.trim()) continue;
      const postTarget: PostingEpisodeTarget = {
        episodePath,
        ...(unit.collected
          ? { chapter: unit.collected.chapter, order: unit.collected.order }
          : {}),
      };
      const hashes = postingTextHashes(unit.subtitle, unit.body);
      const sites = sitesNeedingRevision(input.ledger, postTarget, hashes);
      if (sites.length === 0) continue;
      found.push({
        file,
        postTarget,
        label: postingLabelOf(file, unit.collected, input.format),
        unit,
        bodyHash: hashes.notation,
        sites,
      });
    }
  }
  return found;
}

/** 未投稿の話が残っているか（競合の印がある話は数えない。`pickOldestUnposted` と同じ線） */
function hasUnpostedEpisode(
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  relativePathOf: (file: EpisodeFile) => string
): boolean {
  return (
    firstUnpostedEpisodePath(
      ledger,
      episodes.filter((file) => !file.hasConflictMarkers).map(relativePathOf)
    ) !== undefined
  );
}

/**
 * 作品から投稿を始めたとき、投稿のあとに本文か題を直した話があれば出し直しを促す（6.68.7。
 * 作者の裁定 2026-11-03 昼）。
 *
 * - `"continue"`：直した話が無い、「出し直さない」を選んだ、または出し直しのあと「続けて新しい話を
 *   投稿する」を選んだ（新しい話の投稿へ進む。出し直したときは、記録したあとの台帳を `ledger` に返す）
 * - `"revised"`：出し直しの流れを通り、新しい話へは続けない（未投稿の話が無い・続けないを選んだ・
 *   途中で中止した）
 * - `"cancel"`：取りやめた
 */
async function offerRevisionOfEditedEpisodes(input: {
  store: PostingStore;
  work: WorkEntry;
  ledger: PostingLedger;
  episodes: readonly EpisodeFile[];
  relativePathOf: (file: EpisodeFile) => string;
  format: WorkFormatKey | undefined;
}): Promise<
  | { kind: "continue"; ledger?: PostingLedger; changed?: boolean }
  | { kind: "cancel" }
  | { kind: "revised"; changed: boolean }
> {
  const edited = await findEditedEpisodes(input);
  if (edited.length === 0) return { kind: "continue" };

  // 促しの文は短く保つ（並べるのは3話まで。残りは数だけ）
  const shown = edited.slice(0, 3).map((entry) => entry.label);
  const rest = edited.length - shown.length;
  const names = shown.join("・") + (rest > 0 ? `ほか${rest}話` : "");
  const hasUnposted = hasUnpostedEpisode(input.ledger, input.episodes, input.relativePathOf);

  type OfferItem = vscode.QuickPickItem & { edited?: EditedEpisode; skip?: true };
  const items: OfferItem[] = [
    ...edited.map((entry) => ({
      label: `$(edit) ${entry.label} を出し直す`,
      description: postingSiteLabels(entry.sites),
      detail: "投稿済みのサイトで、この話の編集画面へ本文を貼り替えます（新しい話としては数えません）",
      edited: entry,
    })),
    {
      label: hasUnposted ? "$(rocket) 出し直さずに、新しい話を投稿する" : "$(close) 出し直さない",
      detail: hasUnposted ? "未投稿のいちばん古い話を案内します" : "未投稿の話はありません",
      skip: true as const,
    },
  ];
  const picked = await showQuickPickKeepingFocus([...items, cancelItem()], {
    title: "投稿のあとに直した話があります",
    placeHolder: `${names}は投稿後に直しています。出し直しますか`,
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked)) return { kind: "cancel" };
  if ("skip" in picked && picked.skip) {
    return hasUnposted ? { kind: "continue" } : { kind: "cancel" };
  }
  if (!("edited" in picked) || !picked.edited) return { kind: "cancel" };

  const target = picked.edited;
  const result = await reviseEpisode({
    store: input.store,
    work: input.work,
    ledger: input.ledger,
    postTarget: target.postTarget,
    label: target.label,
    parts: target.unit,
    bodyHash: target.bodyHash,
    candidates: postedSites(input.ledger, target.postTarget),
    edited: target.sites,
    allPosted: unpostedSites(input.ledger, target.postTarget).length === 0,
  });

  /*
    **出し直しを済ませたら、未投稿の話があるときだけ続けるかを訊く**（作者の答え 2026-11-03 昼）。
    中止した・サイト選びを閉じた・保存で止まった回は訊かない（作者が止めた流れを先へ進めない）。
    出し直しは未投稿の数を変えないので、ここで数え直さなくてよいが、台帳は記録したあとのもので見る
  */
  if (
    !result.finished ||
    !hasUnpostedEpisode(result.ledger, input.episodes, input.relativePathOf)
  ) {
    return { kind: "revised", changed: result.changed };
  }
  const next = await showQuickPickKeepingFocus(
    [
      {
        label: "$(rocket) 続けて新しい話を投稿する",
        detail: "未投稿のいちばん古い話を案内します",
        proceed: true as const,
      },
      // 閉じる道（取りやめ）を兼ねる。あとで「新話投稿」を押せば続きから案内する
      cancelItem("ここで終える"),
    ],
    {
      title: "続けて新しい話を投稿しますか",
      placeHolder: `${target.label}の出し直しを終えました。続けて新しい話を投稿しますか`,
      ignoreFocusOut: true,
    }
  );
  if (next && "proceed" in next && next.proceed) {
    return { kind: "continue", ledger: result.ledger, changed: result.changed };
  }
  return { kind: "revised", changed: result.changed };
}

/**
 * 初回の設定（6.68.3の2・3）。**サイト → 投稿済みの基準線**の順に訊く。
 *
 * 基準線をここで訊くのは、**導入前に出した話まで「未投稿」と数えない**
 * ためである。19話まで書いた作品でこの機能を使い始めると、印を付けた
 * 途端に全話へ「未投稿2」が並ぶ——それでは印が何も伝えない。
 */
async function setUpPosting(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined
): Promise<{ ledger: PostingLedger; changed: boolean } | undefined> {
  const entries = await askSites(work, ledger);
  if (!entries || entries.length === 0) return undefined;

  const withNewSites = withSites(ledger, entries);
  if (!(await save(store, work, withNewSites, "投稿先の登録（投稿キットの初回）"))) {
    return undefined;
  }

  const next = await applyBaseline(store, work, withNewSites, episodes, format);
  return { ledger: next ?? withNewSites, changed: true };
}

/**
 * 投稿サイトの設定をやり直す（作者の指示、2026-09-04）。
 *
 * サイトの追加・URLの変更・外すと、投稿済みの基準線の引き直しができる。
 * **画面の部品は初回の設定と同じもの**を使う——2つ書くと、片方だけに
 * 検証や案内が足されて食い違う。
 *
 * **サイトを外しても、そのサイトへ出した記録は消さない。** 出した事実は
 * 変わらないし、また出すことにしたときに戻ってくる（未投稿の印は登録した
 * サイトしか見ないので、外している間は数えられない）。
 *
 * **作品情報と順位も同じ**（設計書6.68.5）。どちらも台帳直下にあり、
 * `sites` の置き換えでは動かない——0.32.0では作品情報がサイトの欄の中に
 * あったため、チェックを外すと作者が書いたメモごと消えていた。
 */
export async function configurePostingSites(
  work: WorkEntry
): Promise<PostingKitResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return { changed: false };

  const chosen = await askSites(work, ledger);
  if (!chosen) return { changed: false };

  /*
    **設定は2段に分ける**（設計書6.68.5）。1段目は投稿の入口（サイトと
    投稿ページのURL）で、これが無いと投稿キットが動かない。作品ID・
    作品ページ・ジャンルは「あると便利」なだけなので、**入れるかどうかを
    先に訊いてから**訊く。

    3サイト登録している作品では、まとめて訊くと入力欄が6つ続く。
    そこまで並ぶと、必須の答えまで「まだ終わらないのか」と読まれる。
  */
  // **作品情報はサイトの登録と別の配列に持つ**（設計書6.68.5）。だから
  // チェックを外しても、そのサイトの作品IDも作者のメモも消えない
  let next = withSites(ledger, chosen);
  if (chosen.length > 0) next = await askSiteProfiles(work, next, chosen);

  if (chosen.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      `${work.title} の投稿先をすべて外しますか？`,
      {
        modal: true,
        detail:
          "作品一覧の「未投稿」の印が出なくなります。\n" +
          "これまでに投稿した記録は消えません。" +
          "またサイトを登録すれば、そのまま続きから使えます。",
      },
      "すべて外す"
    );
    if (answer !== "すべて外す") return { changed: false };
  }

  const withNewSites = next;
  if (!(await save(store, work, withNewSites, "投稿先の設定"))) {
    return { changed: false };
  }
  /*
    **済んだ記録も、設定した作品のログへ向けてから書く**（0.81.4。実機）。
    向けるのが失敗の道（`report`）だけだったので、「投稿先を〜にしました」が
    直前に触った**関係の無い作品**のログへ入っていた
  */
  useLogFile(work.folderPath);
  notifyDone(
    chosen.length === 0
      ? `${work.title} の投稿先をすべて外しました（記録は残っています）。`
      : `${work.title} の投稿先を ${postingSiteLabels(
          chosen.map((entry) => entry.site)
        )} にしました。`
  );

  // **基準線は、続けて引き直せるようにする**（サイトを足した直後は、
  // その新しいサイトだけ全話が未投稿になっている）
  if (chosen.length > 0) {
    /*
      **まだ1件も記録が無いなら、2択を挟まずに話の一覧を出す**
      （作者の実機の指摘、2026-09-22）。

      「投稿済みの基準線」の2択を**数字を打つ欄**と読んだ作者が「219」と
      打ち、絞り込みで2つとも消えて Enter が効かなくなった。初回は
      「引き直すかどうか」を訊く意味が無い（引き直す前の線が無い）ので、
      そのまま選ばせる。**2択を挟むのは、引き直しになるときだけ。**
    */
    const redoing = withNewSites.posts.length > 0;
    let goAhead = !redoing;
    if (redoing) {
      const picked = await showQuickPickKeepingFocus(
        [
          cancelItem("引き直さずに終わる"),
          {
            label: "$(history) 投稿済みの基準線を引き直す",
            detail:
              "「どの話まで出したか」を選び直します（記録は増えるだけです）",
            redo: true,
          },
        ],
        {
          // **一覧から選ぶ画面だと、題にも書く**（打った瞬間に消える
          // placeHolder と違い、題は絞り込んでも残る）
          title: `${work.title} の投稿済みの基準線（一覧から選びます）`,
          placeHolder: "下の2つから選んでください（数字を打つ欄ではありません）",
          ignoreFocusOut: true,
        }
      );
      goAhead = Boolean(picked && !isCancelItem(picked) && "redo" in picked);
    }
    if (goAhead) {
      const format = await readWorkFormat(work);
      const { episodes } = await scanWork(work);
      await applyBaseline(store, work, withNewSites, episodes, format);
    }
  }

  return { changed: true };
}

/**
 * 対象サイトと投稿ページのURLを訊く（6.68.3の2）。
 *
 * **訊くのは選んだサイトだけ。** noteに出さない作品でnoteのURLを
 * 訊かれるのは、答えようのない質問である。
 *
 * URLの検証は**そのサイトのドメインかどうかだけ**（6.68.1）。
 * 中身は見ない——見るにはページを読みにいくことになる。
 *
 * @param ledger 今の台帳。登録済みのサイトは選択済みにして、URLは初期値に入れる。
 *   URL が無くて作品IDがあれば、作品IDから組み立てた URL を初期値にする
 * @returns 取りやめたら undefined。空配列は「1つも出さない」という答え
 */
async function askSites(
  work: WorkEntry,
  ledger: PostingLedger
): Promise<PostingSiteEntry[] | undefined> {
  const current = ledger.sites;
  const picked = await showQuickPickKeepingFocus(
    POSTING_SITES.map((site) => ({
      label: site.label,
      description: current.some((entry) => entry.site === site.id)
        ? "登録済み"
        : undefined,
      detail:
        site.notation === "paren"
          ? "ルビの記法が無いため、読みは括弧書きにして貼ります"
          : `ルビ・傍点を${site.label}の書き方に直して貼ります`,
      site: site.id,
      // 既に登録してあるものは選択済みで出す。選び直しが「追加と削除」
      // の1画面で済む（外すのはチェックを外すだけ）
      picked: current.some((entry) => entry.site === site.id),
    })),
    {
      title: `${work.title} を出すサイト`,
      placeHolder: "出しているサイトを選んでください（複数選べます）",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!picked) return undefined;

  const entries: PostingSiteEntry[] = [];
  for (const item of picked) {
    const info = postingSiteInfo(item.site);
    const existing = current.find((entry) => entry.site === item.site);
    const url = await askText({
      title: `${info.label} の新規エピソード投稿ページ`,
      prompt:
        `${info.label}で「新しい話を書く」画面を開き、そのURLを貼り付けてください。` +
        "この作品のページを毎回ここから開きます",
      /*
        **作品IDが分かっていれば、URL を下書きで入れる**（作者に約束済み、
        2026-10-12）。読者の反応から作品IDだけ登録されたカクヨムの作品で、
        同じ番号の入った URL をもう一度探して貼らせない。入っている URL は
        そのまま（`newEpisodeUrlDraft`）。Enter を押すまで台帳には入らない
      */
      value: newEpisodeUrlDraft(
        item.site,
        existing?.newEpisodeUrl,
        siteProfile(ledger, item.site)?.workId
      ),
      placeHolder: info.urlExample,
      ignoreFocusOut: true,
      validateInput: (value) =>
        validateNewEpisodeUrl(item.site, value) ?? undefined,
    });
    // **1つでも取りやめたら、何も覚えない。** 半分だけ登録されると、
    // 次に押したときに「なぜこのサイトを訊かれないのか」が分からない
    if (url === undefined) return undefined;
    // **作品情報の持ち越しは要らない**（6.68.5）。作品情報は台帳直下の
    // `siteProfiles` にあり、サイトの一覧を置き換えても動かない
    entries.push({ site: item.site, newEpisodeUrl: url.trim() });
  }
  return entries;
}

/**
 * サイトごとの作品情報を訊く（設計書6.68.5）。
 *
 * **全部が任意で、空のまま飛ばせる。** サイトの作品IDやジャンルは、
 * 覚えていないこともあれば、まだ決めていないこともある。答えられない
 * 質問を必須にすると、設定そのものを最後まで通せなくなる。
 *
 * **取りやめ（Esc）は「ここまでで終える」**として扱い、それまでに
 * 入れたぶんは残す。投稿ページのURL（必須）とは扱いを変えている——
 * あちらは半端に登録されると次の案内が壊れるが、こちらは入っている
 * ところまでが素直に使える。
 */
async function askSiteProfiles(
  work: WorkEntry,
  ledger: PostingLedger,
  entries: readonly PostingSiteEntry[]
): Promise<PostingLedger> {
  const picked = await showQuickPickKeepingFocus(
    [
      // **入れないほうを先頭に置く**（更新告知の誘いと同じ形）。ここまでで
      // 投稿はできる状態になっており、作品情報は「あると便利」なだけである
      cancelItem("作品情報は入れずに終える"),
      {
        label: "$(edit) 作品ID・作品ページ・ジャンルも入れる",
        detail:
          "サイトごとに3つ訊きます（どれも空のままで構いません）。" +
          `${READER_SITE_TABS_HINT}に出ます`,
        detailed: true,
      },
    ],
    {
      title: `${work.title} の投稿サイトの情報`,
      placeHolder: "サイトごとの作品情報も入れますか（あとからでも足せます）",
      ignoreFocusOut: true,
    }
  );
  // **取りやめても、選んだサイトは失わない。** ここで捨てると、必須の
  // 答え（サイトとURL）まで任意の質問の巻き添えになる
  if (!picked || isCancelItem(picked) || !("detailed" in picked)) {
    return ledger;
  }

  let next = ledger;
  for (const entry of entries) {
    const info = postingSiteInfo(entry.site);
    // 既に入っている値を初期値に出す。**外して再登録しても残っている**
    // （作品情報はサイトの登録と別に持つので、外した間も消えていない）
    const current = siteProfile(next, entry.site);
    /*
      **同じ数字を2度打たせない**（作者の指摘、2026-09-22）。直前に貼って
      もらった投稿ページのURLに作品IDが書いてあるので、そこから導いて
      初期値に出す——「ジャンル以外は更新用URLから抽出できます」。

      **作者が入れた値が勝つ**（`current` が先）。導けるのは形の確かめられた
      サイトだけで、それ以外は今までどおり空で訊く（`postingSiteUrls.ts`）。
    */
    const derived = deriveSiteProfile(entry.site, entry.newEpisodeUrl);

    const workId = await askText({
      title: `${info.label} での作品ID`,
      /*
        **例はサイトごとに出す**（`info.workIdExample`）。IDの形はサイトで
        まるきり違い、なろうのNコードだけを例に出していたころは、
        アルファポリスの欄に作者番号だけが入った。アルファポリスの作品IDは
        投稿画面の URL の末尾にある数字9桁（2026-11-01 に確かめた）で、
        ヘルパーはこの9桁で貼り込み先を照合する。
      */
      prompt:
        `${info.label}のこの作品のIDを入れてください。` +
        "分からなければ空のままで構いません",
      value: current?.workId || derived.workId,
      placeHolder: info.workIdExample,
      ignoreFocusOut: true,
      /*
        アルファポリスは数字9桁でなければ、どこを写すかを言って止める（作者の判断 2026-11-01）。
        違う形のまま入ると、ヘルパーの照合で取り違えとして止まり、原因にたどり着きにくい。
        空は通す（作品IDは任意）
      */
      validateInput: (value) => validateSiteWorkIdInput(entry.site, value) ?? undefined,
    });
    // **Escは「ここまでで終える」。** 入れたぶんはそのまま残し、
    // まだ訊いていないサイトの作品情報にも触らない
    if (workId === undefined) return next;

    /*
      **作品IDを書き換えたら、投稿ページのURLを合わせるか一言訊く**
      （作者の裁定、2026-10-12 22時台）。黙って組み直すと作者が手で貼った
      URL が消え、黙って残すと投稿キットが古い作品の投稿欄を開く。
      いいえ・閉じたなら URL はそのまま
    */
    const postUrl = next.sites.find((one) => one.site === entry.site)?.newEpisodeUrl;
    const follow = planNewEpisodeUrlOnWorkIdChange(
      entry.site,
      postUrl,
      current?.workId,
      workId
    );
    let followedUrl: string | undefined;
    if (follow.kind === "ask") {
      const answer = await vscode.window.showInformationMessage(
        NEW_EPISODE_URL_FOLLOW_QUESTION,
        {
          modal: true,
          detail:
            `今の URL：${postUrl ?? ""}\n` +
            `合わせると：${follow.rebuilt}\n\n` +
            "合わせなければ、今の URL のままにします。",
        },
        "合わせる"
      );
      const accepted = answer === "合わせる";
      next = withSites(
        next,
        followNewEpisodeUrl(next.sites, entry.site, follow.rebuilt, accepted)
      );
      if (accepted) followedUrl = follow.rebuilt;
    }

    const workUrl = await askText({
      title: `${info.label} の作品ページのURL`,
      prompt:
        "読者が見る作品ページのURLを貼ってください（空のままで構いません）。" +
        "執筆統計からここを開けるようになります",
      // URL を新しい作品IDへ合わせたなら、作品ページの下書きもそちらから導く
      value:
        current?.workUrl ||
        (followedUrl
          ? deriveSiteProfile(entry.site, followedUrl).pageUrl
          : derived.pageUrl),
      placeHolder: `https://${info.domain}/`,
      ignoreFocusOut: true,
      // **確かめるのはドメインだけ**（6.68.1）。ページは読みにいかない
      validateInput: (value) =>
        validateWorkPageUrl(entry.site, value) ?? undefined,
    });
    if (workUrl === undefined) return next;

    const genre = await askText({
      title: `${info.label} でのジャンル`,
      prompt:
        `${info.label}で選んでいるジャンルを入れてください（空のままで構いません）`,
      value: current?.genre,
      placeHolder: "ハイファンタジー",
      ignoreFocusOut: true,
    });
    if (genre === undefined) return next;

    next = withSiteProfile(next, entry.site, {
      workId,
      workUrl,
      genre,
      // **作者が書いたメモは訊かないし、消さない**（台帳を手で直したときの
      // 書き込みが、この画面を通るたびに消えてはいけない）
      note: current?.note,
    });
  }
  return next;
}

/**
 * ランキングを記録（設計書6.68.5）。
 *
 * **サイトへは取りにいかない。** ランキングのページを機械で読むのは、
 * 自動投稿を断ったのと同じ線の内側にある（6.68.1）。ここが記録するのは
 * **作者が画面で見て打った値だけ**である。
 *
 * 訊く順は「サイト → 種別 → 順位 → メモ」。日時は書き留めた時刻を自動で
 * 入れる（順位が出た時刻は、作者にも分からないことがある）。
 */
export async function recordRanking(
  work: WorkEntry
): Promise<PostingKitResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return { changed: false };

  /*
    **サイトが1つも登録されていなければ、そこへ誘導する。**
    どのサイトの順位かを訊いても答えようがないので、選択画面すら出さない。
  */
  if (ledger.sites.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      `${work.title} には投稿サイトが登録されていません。` +
        "「投稿サイト設定」でサイトを登録すると、そのサイトの順位を記録できます。",
      "投稿サイト設定"
    );
    if (answer === "投稿サイト設定") return await configurePostingSites(work);
    return { changed: false };
  }

  const site = await askRankingSite(work, ledger);
  if (!site) return { changed: false };
  const info = postingSiteInfo(site);

  const board = await askRankingBoard(ledger, site);
  if (board === undefined) return { changed: false };

  const rankText = await askText({
    title: `${info.label} の${board}の順位`,
    prompt: "いま何位でしたか。数字で入れてください（1位なら 1）",
    placeHolder: "12",
    ignoreFocusOut: true,
    validateInput: (value) => validateRankInput(value) ?? undefined,
  });
  if (rankText === undefined) return { changed: false };
  const rank = parseRankInput(rankText);
  // 入力欄で断っているので、ここへ来るのは画面の作りが変わったときだけ
  if (rank === null) return { changed: false };

  const note = await askText({
    title: "メモ（任意）",
    prompt:
      "覚えておきたいことがあれば入れてください" +
      "（空のままでも、取りやめても、順位は記録します）",
    placeHolder: "更新直後",
    ignoreFocusOut: true,
  });

  const next = withRanking(ledger, {
    site,
    recordedAt: new Date().toISOString(),
    board,
    rank,
    // **メモの取りやめは「メモ無し」**として扱う（ここまでの答えを
    // 捨てるほうが、作者にとっては大きな損である）
    ...(note?.trim() ? { note: note.trim() } : {}),
  });
  if (!(await save(store, work, next, "順位の記録"))) return { changed: false };

  void vscode.window.showInformationMessage(
    `${info.label} ${board} ${rank}位 を記録しました。` +
      `執筆統計の「${readerSiteTabLabel(info.id)}」で履歴を見られます。`
  );
  return { changed: true };
}

/**
 * 作品の「連載中／完結」を作者が決める（作者の選択「両方」2026-11-01）。
 *
 * **作品の印を書き換えるのは、ここだけ**。ヘルパーから届くサイトごとの印は台帳の
 * `siteFacts` にしか入らず、作品の印へは写さない（作者が決めた値が勝つ。実装ルール2）。
 * まだ決めていない作品では、届いた印が揃っていれば**提案として先頭に置く**——選ぶのは作者。
 *
 * サイトの登録が無い作品でも決められる（投稿していない作品の完結も、作者が記録したい）。
 */
/** 知らせた台帳と中身（同じ知らせは、VS Code を起こしている間に一度だけ出す） */
const toldUnknownValues = new Set<string>();

/**
 * 投稿状態の台帳で、この版が知らない値を読まなかったことを**一度だけ**知らせる
 * （作者の判断 2026-11-01。`onPostingUnknownValues` に付ける）。
 *
 * 台帳は執筆統計・作品一覧・投稿キットが開くたびに読み直すので、毎回出すと直すまで
 * 邪魔になる。**台帳の場所と中身の組で一度**——中身が変わったら（別の値が増えたら）また言う。
 * 黙ってもいない：読まなかった値は保存でも消さずに持ち回るが、それをこちらが黙って
 * 抱えていると、作者は「選んだはずの状態が出ない」理由にたどり着けない。
 */
export function notifyPostingUnknownValuesOnce(info: PostingUnknownValues): void {
  const key = [info.filePath.toLowerCase(), ...info.notes].join("\u0000");
  if (toldUnknownValues.has(key)) return;
  toldUnknownValues.add(key);
  void vscode.window.showWarningMessage(
    `投稿状態（${info.filePath}）に、この版が知らない値がありました：${info.notes.join("、")}。` +
      "その欄だけを読まずに、ほかの記録はそのまま使います（台帳からは消しません）。" +
      "拡張機能を新しい版にすると読めるようになります。"
  );
}

export async function setWorkCompletion(work: WorkEntry): Promise<PostingKitResult> {
  const store = new PostingStore(work);
  const ledger = await load(store, work);
  if (!ledger) return { changed: false };

  const facts = buildWorkPostingFacts(ledger);
  const current = ledger.completion?.value;
  const suggested = facts.suggestion?.value;
  // サイトの印を説明に添える（「カクヨム：連載中」）。食い違いに気づけるように
  const siteNotes = POSTING_SITES.flatMap((info) => {
    const value = siteFactsFor(ledger, info.id)?.completion;
    return value === undefined ? [] : [`${info.label}は${workCompletionLabel(value)}`];
  });
  type Choice = vscode.QuickPickItem & { value: WorkCompletion | null };
  const describe = (value: WorkCompletion): string =>
    value === current
      ? "いまの印"
      : value === suggested
        ? "サイトから届いた印と同じ"
        : "";
  const choices: Choice[] = WORK_COMPLETIONS.map((value) => ({
    label: workCompletionLabel(value),
    description: describe(value),
    value,
  }));
  // 提案があれば先頭へ（決めていない作品だけ。決めてある作品は並びを変えない）
  if (current === undefined && suggested !== undefined) {
    choices.sort((left, right) => (left.value === suggested ? -1 : right.value === suggested ? 1 : 0));
  }
  if (current !== undefined) {
    choices.push({ label: "決めない（印を外す）", description: "", value: null });
  }

  const picked = await showQuickPickKeepingFocus([...choices, cancelItem()], {
    title: `${work.title} の連載の状態`,
    placeHolder:
      (current !== undefined
        ? `いまは「${workCompletionLabel(current)}」です。`
        : "まだ決めていません。") +
      (siteNotes.length > 0 ? `（${siteNotes.join("、")}）` : ""),
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !("value" in picked)) return { changed: false };
  if ((picked.value ?? undefined) === current) return { changed: false };

  const next = withWorkCompletion(ledger, picked.value, new Date().toISOString());
  if (!(await save(store, work, next, "連載の状態"))) return { changed: false };

  // 決めたあとに食い違うサイトがあれば、その場で言う（あとで執筆統計の概要にも出る）
  const notice = buildWorkPostingFacts(next).notice;
  void vscode.window.showInformationMessage(
    (picked.value === null
      ? `${work.title} の連載の状態の印を外しました。`
      : `${work.title} を「${workCompletionLabel(picked.value)}」にしました。`) +
      (notice ? ` ${notice}` : "")
  );
  return { changed: true };
}

/** どのサイトの順位か。**登録してあるサイトの中から選ぶ** */
async function askRankingSite(
  work: WorkEntry,
  ledger: PostingLedger
): Promise<PostingSiteId | undefined> {
  const picked = await showQuickPickKeepingFocus(
    [
      ...ledger.sites.map((entry) => {
        const info = postingSiteInfo(entry.site);
        const latest = latestRanking(ledger, entry.site);
        return {
          label: info.label,
          // 前回の記録を添える。「前より上がったか」がこの操作の関心である
          description: latest
            ? `前回 ${rankingBoardLabel(latest)} ${latest.rank}位`
            : "記録はまだありません",
          site: entry.site,
        };
      }),
      cancelItem(),
    ],
    {
      title: `${work.title} のランキングを記録`,
      placeHolder: "どのサイトの順位ですか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("site" in picked)) return undefined;
  return picked.site;
}

/**
 * 種別（日間・週間・ジャンル別…）を訊く。
 *
 * **候補はこちらで決め打ちしない**（6.68.5）。サイトごとに呼び方が違い、
 * 企画やジャンル別の名前は作品ごとに違う。**作者が過去に使った言葉**を
 * 候補に出し、無ければそのまま入力欄で訊く（空の候補一覧を見せない）。
 */
async function askRankingBoard(
  ledger: PostingLedger,
  site: PostingSiteId
): Promise<string | undefined> {
  const info = postingSiteInfo(site);
  const boards = rankingBoards(ledger, site);

  if (boards.length > 0) {
    const used = new Set(
      ledger.rankings
        .filter((entry) => entry.site === site)
        .map((entry) => entry.board)
    );
    const picked = await showQuickPickKeepingFocus(
      [
        ...boards.map((board) => ({
          label: board,
          description: used.has(board)
            ? undefined
            : "ほかのサイトで使った種別",
          board,
        })),
        {
          label: "$(edit) 別の種別を入力する",
          detail: "日間・週間・月間・ジャンル別など、サイトの呼び方のままで結構です",
          board: null,
        },
        cancelItem(),
      ],
      {
        title: `${info.label} のランキングの種別`,
        placeHolder: "どのランキングの順位ですか",
        ignoreFocusOut: true,
      }
    );
    if (!picked || isCancelItem(picked) || !("board" in picked)) {
      return undefined;
    }
    if (typeof picked.board === "string") return picked.board;
  }

  const value = await askText({
    title: `${info.label} のランキングの種別`,
    prompt:
      "ランキングの種別を入れてください（日間・週間・月間・ジャンル別など、" +
      "サイトの呼び方のままで結構です）",
    placeHolder: "日間",
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim() ? undefined : "種別を入れてください。",
  });
  return value?.trim() || undefined;
}

/**
 * 「どの話まで投稿済みとみなすか」を訊いて、台帳へ入れる（基準線）。
 *
 * **日時は導入した時刻でしかない**ので、`importedBaseline` の印を付けて
 * 実際の投稿の記録と見分けられるようにする（`models/posting.ts`）。
 * 既にある記録は1つも書き換えない。
 *
 * @returns 記録を足したら新しい台帳。足さなかった・取りやめたら undefined
 */
async function applyBaseline(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger,
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined
): Promise<PostingLedger | undefined> {
  if (episodes.length === 0) return undefined;

  const picked = await showQuickPickKeepingFocus(
    [
      // **新しい話を上に置く**（たいてい「最新話まで出した」が答えになる）
      ...[...episodes].reverse().map((episode, index) => ({
        label: `$(check) ${episodeLabelOf(episode, format)} まで投稿済み`,
        detail: episode.fileName,
        // 逆順にしたので、元の並びでの位置に直す
        upto: episodes.length - index,
      })),
      {
        label: "$(circle-outline) 最初から（まだ1話も出していない）",
        detail: "記録を1件も入れません",
        upto: 0,
      },
      cancelItem("いま決めない"),
    ],
    {
      title: `${work.title} は、どの話まで投稿済みですか`,
      /*
        **数字を打つ欄ではないことを、先に言う**（作者の実機の指摘、
        2026-09-22。話数を打つ欄だと読んで「219」と入れられた）。

        何が起きるかの説明は後ろへ回すが、**落とさない**——登録したサイト
        すべてへ入ることは、選ぶ前に知っていないと困る。
      */
      placeHolder:
        "一覧から選んでください（数字を打つと絞り込めます）。" +
        "選んだ話までを、登録したサイトすべてへ投稿済みとして記録します",
      ignoreFocusOut: true,
    }
  );
  // **決めないまま進める。** ここで止めると、サイトの登録までやり直しになる
  if (!picked || isCancelItem(picked) || !("upto" in picked)) return undefined;
  if (picked.upto === 0) return undefined;

  const next = withBaselinePosts(
    ledger,
    episodes
      .slice(0, picked.upto)
      .map((episode) => episodePathFor(work.folderPath, episode.filePath)),
    ledger.sites.map((entry) => entry.site),
    new Date().toISOString()
  );
  const added = next.posts.length - ledger.posts.length;
  if (added === 0) return undefined;
  if (!(await save(store, work, next, "投稿済みの基準線"))) return undefined;

  void vscode.window.showInformationMessage(
    `${episodeLabelOf(episodes[picked.upto - 1], format)} までを、` +
      `${postingSiteLabels(
        ledger.sites.map((entry) => entry.site)
      )}へ投稿済みとして記録しました（${added}件）。` +
      "実際に投稿した記録とは分けて残しています。"
  );
  return next;
}

/** 話の呼び名。話数が読めない話はファイル名で呼ぶ */
function episodeLabelOf(
  episode: EpisodeFile,
  format: WorkFormatKey | undefined
): string {
  return formatChapterLabel(episode, format) || episode.fileName;
}

/**
 * 案内に出す呼び名。**合本から選んだ話は、その話の呼び名にする**
 * （設計書6.12.1）。ファイル単位の呼び名のままだと、「第3話を出しますか」
 * と訊くべきところで合本のファイル名が出て、どの話の話なのか分からない。
 *
 * 数え方は作品の形式を通す（`collectedChapterLabel`）——SNS記事なら
 * 「3本目」になる。話数が読めない話は**並び順で呼ぶ**。並び順を話数として
 * 名乗らせると、プロローグのある合本で別の話の話数になる。
 */
function postingLabelOf(
  episode: EpisodeFile,
  collected: { chapter: number | null; order: number } | undefined,
  format: WorkFormatKey | undefined
): string {
  const fileLabel = episodeLabelOf(episode, format);
  if (!collected) return fileLabel;
  return collectedChapterLabel(
    { insideCollected: true, chapterStart: collected.chapter },
    `${fileLabel}の${collected.order}番目`,
    format
  );
}

/** 何をしたかを1回でまとめて伝える（黙って終わらない） */
async function reportResult(input: {
  label: string;
  posted: PostingSiteId[];
  skipped: PostingSiteId[];
  aborted: boolean;
}): Promise<void> {
  const parts: string[] = [];
  if (input.posted.length > 0) {
    parts.push(`${postingSiteLabels(input.posted)}へ投稿と記録しました`);
  }
  if (input.skipped.length > 0) {
    parts.push(`${postingSiteLabels(input.skipped)}は飛ばしました`);
  }
  if (input.aborted) parts.push("途中で中止しました");
  if (parts.length === 0) return;

  void vscode.window.showInformationMessage(
    `${input.label}：${parts.join("／")}。`
  );
}

/**
 * 更新告知（P-30）へ繋ぐ（6.68.3の4）。
 *
 * **作らない選択肢を先に置く。** ここまでで用は足りており、告知は
 * おまけである（しかもAIを呼ぶ＝有料のAIでは料金が出る）。
 */
async function offerAnnouncement(
  work: WorkEntry,
  registry: AIRegistry
): Promise<void> {
  const picked = await showQuickPickKeepingFocus(
    [
      // **作らないほうを先頭に置く。** 既定の答えは「作らない」である
      cancelItem("告知は作らずに終わる"),
      {
        label: "$(megaphone) 更新告知文を作る",
        detail: "X用・活動報告用・後書き用の3種を作ります（AIを呼びます）",
        announce: true,
      },
    ],
    {
      title: "投稿おつかれさまでした",
      placeHolder: "更新告知文も作りますか",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("announce" in picked)) return;
  await generateAnnouncement(work, registry);
}

/**
 * 本文とサブタイトルを読む。
 *
 * **競合マーカーのある話は断る**（実装ルール1）。マーカーごと投稿欄へ
 * 貼られては取り返しがつかない。
 *
 * **合本（1ファイルに全話）なら、どの話を出すかを訊く**（設計書6.12.1）。
 * 以前は全話を区切り行と頭書きごと渡したうえで「投稿済み」を記録して
 * いた。**取りやめたときは undefined を返す**——呼び出し側はそこで止まる
 * ので、1話も出していないのに記録が残ることはない。
 */
async function readEpisode(
  episode: EpisodeFile,
  format: WorkFormatKey | undefined
): Promise<
  | {
      subtitle: string | null;
      body: string;
      /**
       * 合本から選んだ話の指し方（台帳の鍵と案内の見出しに使う）。
       * 合本でなければ入らない＝ファイルまるごとを指す
       */
      collected?: { chapter: number | null; order: number };
    }
  | undefined
> {
  let file;
  try {
    file = await readTextFile(episode.filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("投稿キットの本文の読み込み", {
      ファイル: episode.fileName,
      内容: detail,
    });
    void vscode.window.showErrorMessage(
      `${episode.fileName} を読み込めませんでした: ${detail}`
    );
    return undefined;
  }

  if (file.hasConflictMarkers) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に未解決の競合（<<<<<<<）があります。` +
        "そのまま投稿すると競合の印ごと公開されるため、中止しました。" +
        "競合を解決してからお試しください。"
    );
    return undefined;
  }

  const parts = extractEpisodeParts(file.text, episode.subtitle);

  // 合本なら1話ぶんに絞る。`null` は「合本ではない」、`undefined` は取りやめ
  const picked = await pickCollectedEpisode(file.text, format);
  if (picked === undefined) return undefined;
  const found = picked
    ? {
        subtitle: picked.title ?? parts.subtitle,
        body: picked.body,
        // **どの話を選んだかを呼び出し側へ渡す。** 台帳の鍵も案内の見出しも
        // ここで決まった1話を指す（ファイルではなく）
        collected: { chapter: picked.chapter, order: picked.order },
      }
    : parts;

  if (!found.body.trim()) {
    void vscode.window.showWarningMessage(
      `${episode.fileName} に本文が見つかりませんでした。`
    );
    return undefined;
  }
  return found;
}

/**
 * その店が最後に読んだ・書いた台帳（6.68.8）。案内を終えるとき、預かった番号を
 * **案内が最後に持っていた台帳**へ当てて書く——読み直すと、店の照合の手がかり
 * （読み込んだときの中身）が入れ替わり、照合の意味が無くなる。
 */
const lastLedgerOf = new WeakMap<PostingStore, PostingLedger>();

async function load(
  store: PostingStore,
  work: WorkEntry
): Promise<PostingLedger | undefined> {
  try {
    const ledger = await store.load();
    lastLedgerOf.set(store, ledger);
    return ledger;
  } catch (error) {
    await report("投稿状態の読み込み", work, error);
    return undefined;
  }
}

/**
 * 案内を終えるとき、預かりを台帳へ入れて片づける（6.68.8）。**案内が最後に持っていた台帳と店で**
 * 当てる（読み直すと、店の照合の手がかりが入れ替わる）。台帳を読めていなければ何もしない
 * ——預かりは保管庫に残り、次の機会（次の案内・次の起動）に入る。
 *
 * 入らなかったもの（『投稿しました』を選ばずに終えた話など）の扱いは `postingKitSession.ts` の冒頭。
 *
 * @returns 台帳を書いたか
 */
async function flushQueuedUpdates(
  work: WorkEntry,
  store: PostingStore,
  stored: readonly StoredPostingUpdate[]
): Promise<boolean> {
  if (stored.length === 0) return false;
  const ledger = lastLedgerOf.get(store);
  if (!ledger) {
    useLogFile(work.folderPath);
    logLine("投稿の記録を読めていないので、預かった番号はそのまま残します。");
    return false;
  }
  return settlePendingForWork({
    work,
    store,
    ledger,
    trigger: "kitEnd",
    stored,
    save: (next) => save(store, work, next, "ヘルパーから届いた話の番号（投稿キットを終えるとき）"),
  });
}

async function save(
  store: PostingStore,
  work: WorkEntry,
  ledger: PostingLedger,
  /**
   * 何の保存か（0.81.4）。**ログに残す。** 実機で「外部で変更」で止まったとき、
   * 「投稿状態の保存」とだけあって、どの操作の保存が止まったのか追えなかった
   */
  purpose: string
): Promise<boolean> {
  try {
    await store.save(ledger);
    lastLedgerOf.set(store, ledger);
    return true;
  } catch (error) {
    await report("投稿状態の保存", work, error, purpose);
    return false;
  }
}

/** 失敗はログに残してから知らせる（原因にたどり着けるようにする） */
async function report(
  what: string,
  work: WorkEntry,
  error: unknown,
  purpose?: string
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  useLogFile(work.folderPath);
  logFailure(what, {
    作品: work.title,
    保存しようとしたもの: purpose,
    種類: error instanceof PostingStoreError ? error.kind : "unknown",
    読み込んだ時刻:
      error instanceof PostingStoreError ? error.loadedAt : undefined,
    内容: message,
  });
  await vscode.window.showErrorMessage(message);
}
