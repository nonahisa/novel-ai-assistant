import {
  postingEpisodeKey,
  withSiteEpisodeId,
  withSiteWorkNumber,
  type PostingEpisodeTargetLike,
  type PostingLedger,
  type PostingSiteId,
} from "../models/posting";
import { planSiteEpisodeId } from "../core/postedEnvelope";

/**
 * 投稿キットの案内が開いている間の、ヘルパーから届いた番号の預かり（設計書6.68.8）。
 *
 * ## なぜ預かるのか
 *
 * 自然な順は「封筒をコピー → ブラウザで貼って投稿 → ヘルパーのボタン → 番号が届く →
 * そのあとで VS Code の『投稿しました』を押す」である。番号が届いた時点では投稿の記録が無く、
 * 番号を付ける先が無い。しかも受け手がその場で台帳を保存すると、案内が読み込んだときの
 * 台帳と食い違い、『投稿しました』の保存が「外部で変更されています」で止まる
 * （`postingStore.ts` の照合。0.81.4 の実機で、同じ機械のヘルパーの取り込みが先に書いた）。
 *
 * そこで**案内が開いている作品には、受け手は台帳を書かない。** 番号をここへ預け、案内が
 * 『投稿しました』を記録するときの保存に相乗りさせ、案内を終えるときに残りを書く。
 * 預かりは VS Code の中（メモリ）だけで、閉じれば消える——取りこぼしは作品管理の画面から
 * 章立てを渡したとき（`novelai-chapters` の `episodeId`）に埋まる。
 *
 * VS Code API には依存しない。
 */

/** ヘルパーへ渡した札1つ（案内の中でコピーしたもの） */
export interface IssuedPostRef {
  readonly site: PostingSiteId;
  readonly target: PostingEpisodeTargetLike;
  /** 封筒の題の欄へ入れた字（札が無い封筒を題で照らすときの手がかり） */
  readonly title: string;
}

/** 預かった書き込み1つ。**何度当てても同じ結果になる形だけ**（保存のたびに当て直すため） */
export type QueuedPostingUpdate =
  | {
      readonly kind: "episode";
      readonly site: PostingSiteId;
      readonly target: PostingEpisodeTargetLike;
      readonly episodeId: string;
      /** 作者が「替える」と答えたか（別の番号が入っていたら、答えたときだけ替える） */
      readonly allowReplace: boolean;
      /** 記録に残す呼び名（「第13話」） */
      readonly label: string;
    }
  | {
      readonly kind: "workNumber";
      readonly site: PostingSiteId;
      readonly number: string;
      readonly recordedAt: string;
    };

interface Session {
  /** 同じ作品で案内が入れ子になったときのための数（ふつうは1） */
  depth: number;
  readonly issued: Map<string, IssuedPostRef>;
  readonly queued: QueuedPostingUpdate[];
}

const sessions = new Map<string, Session>();

/** 案内を始める（作品の登録ID）。**必ず `endPostingKitSession` と対で呼ぶ** */
export function beginPostingKitSession(workId: string): void {
  const current = sessions.get(workId);
  if (current) {
    current.depth++;
    return;
  }
  sessions.set(workId, { depth: 1, issued: new Map(), queued: [] });
}

/**
 * 案内を終える。**まだ当たっていない預かりを返す**（呼ぶ側が最後の保存に使い、
 * それでも当たらなかったものは知らせとログに残す）。入れ子の内側では空を返す。
 */
export function endPostingKitSession(workId: string): QueuedPostingUpdate[] {
  const current = sessions.get(workId);
  if (!current) return [];
  current.depth--;
  if (current.depth > 0) return [];
  sessions.delete(workId);
  return [...current.queued];
}

/** その作品の案内が開いているか */
export function isPostingKitActive(workId: string): boolean {
  return sessions.has(workId);
}

/** 封筒をコピーしたときに、渡した札を覚える */
export function rememberIssuedPostRef(workId: string, postRef: string, issued: IssuedPostRef): void {
  sessions.get(workId)?.issued.set(postRef, issued);
}

/** 開いている案内のどれかが渡した札か。渡した作品の登録IDと中身を返す */
export function findIssuedPostRef(
  postRef: string
): { readonly workId: string; readonly issued: IssuedPostRef } | undefined {
  for (const [workId, session] of sessions) {
    const issued = session.issued.get(postRef);
    if (issued) return { workId, issued };
  }
  return undefined;
}

/** その作品の案内が渡した札の一覧（題で照らすときの候補） */
export function issuedPostRefsOf(workId: string): readonly IssuedPostRef[] {
  return [...(sessions.get(workId)?.issued.values() ?? [])];
}

/**
 * 書き込みを預ける。**案内が開いていなければ false**（呼ぶ側がそのまま保存する）。
 * 同じ話・同じサイトの番号は新しいもので置き換える（同じ封筒を2度受けても積まない）。
 */
export function queuePostingUpdate(workId: string, update: QueuedPostingUpdate): boolean {
  const session = sessions.get(workId);
  if (!session) return false;
  const sameSlot = (entry: QueuedPostingUpdate): boolean =>
    entry.kind === update.kind &&
    entry.site === update.site &&
    (entry.kind !== "episode" ||
      (update.kind === "episode" &&
        postingEpisodeKey(entry.target) === postingEpisodeKey(update.target)));
  const kept = session.queued.filter((entry) => !sameSlot(entry));
  session.queued.length = 0;
  session.queued.push(...kept, update);
  return true;
}

/** 当てた結果 */
export interface QueuedApplyResult {
  readonly ledger: PostingLedger;
  /** 台帳が変わったか */
  readonly changed: boolean;
  /** まだ当てられないもの（投稿の記録がまだ無い・別の番号があって替える答えが無い等） */
  readonly waiting: readonly { readonly update: QueuedPostingUpdate; readonly reason: string }[];
}

/**
 * 預かりを台帳へ当てる。**預かりは消さない**——案内は保存のたびに手元の台帳から
 * 次の台帳を作るので、一度当てて消すと、次の保存で手元の古い台帳から書いて消えてしまう。
 * 当てる操作はどれも何度当てても同じなので、保存のたびに当て直してよい。
 */
export function applyQueuedPostingUpdates(
  ledger: PostingLedger,
  updates: readonly QueuedPostingUpdate[]
): QueuedApplyResult {
  let next = ledger;
  let changed = false;
  const waiting: { update: QueuedPostingUpdate; reason: string }[] = [];
  for (const update of updates) {
    if (update.kind === "workNumber") {
      const written = withSiteWorkNumber(next, update.site, update.number, update.recordedAt);
      if (!written) {
        waiting.push({ update, reason: "小説番号の形が正しくありません" });
        continue;
      }
      if (written !== next) changed = true;
      next = written;
      continue;
    }
    const plan = planSiteEpisodeId(next, update.target, update.site, update.episodeId);
    if (plan.kind === "same") continue;
    if (plan.kind === "noPost") {
      waiting.push({ update, reason: "投稿の記録がまだありません" });
      continue;
    }
    if (plan.kind === "taken") {
      waiting.push({ update, reason: `同じ番号が別の話（${plan.holder}）に記録されています` });
      continue;
    }
    if (plan.kind === "replace" && !update.allowReplace) {
      waiting.push({ update, reason: `別の番号（${plan.existing}）が記録されています` });
      continue;
    }
    const written = withSiteEpisodeId(next, update.target, update.site, update.episodeId);
    if (!written) {
      waiting.push({ update, reason: "番号を投稿の記録へ入れられませんでした" });
      continue;
    }
    next = written;
    changed = true;
  }
  return { ledger: next, changed, waiting };
}

/** その作品の預かり（案内が保存のたびに当てる） */
export function queuedPostingUpdatesOf(workId: string): readonly QueuedPostingUpdate[] {
  return [...(sessions.get(workId)?.queued ?? [])];
}
