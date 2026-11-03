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
 * ヘルパーから届いた番号の預かり（設計書6.68.8）。
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
 *
 * ## 預かりは VS Code の保管庫に残す（作者の答え 2026-11-03 昼「残す」）
 *
 * 案内の途中で VS Code を閉じても、『投稿しました』を選ばずに終えても、番号は消さない。
 * 保管庫（`context.globalState`。作品の登録IDで引く）に残し、次に投稿キットがその作品の
 * 台帳を保存するとき・次に VS Code を開いたときに、上書きしない決まり（`planSiteEpisodeId`）を
 * 通してから台帳へ入れる。**作品の登録は窓をまたいで共通**なので、窓ごとの保管庫
 * （workspaceState）でなく全体の保管庫に置く。保管庫は機械ごとで、Git では同期しない。
 *
 * 片づけの決まり（`settlePendingUpdates`）：
 * - 入れられたもの・もう同じ番号が入っていたものは消す
 * - **投稿の記録がまだ無いものだけ、`PENDING_MAX_AGE_DAYS` 日まで残す**（作者があとで投稿キットの
 *   『投稿しました』を選べば入る）。それを過ぎたら、知らせとログに残して消す
 * - それ以外（別の番号がある・同じ番号を別の話が持っている・形が違う）は、待っても直らないので
 *   すぐ消し、知らせとログに残す（ヘルパーのボタンをもう一度押せば、訊く画面から入れ直せる）
 *
 * VS Code API には依存しない（保管庫は `usePostingPendingMemory` で渡す）。
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

/** 保管庫に置く預かり1つ（預けた日時つき。古いものを片づけるため） */
export interface StoredPostingUpdate {
  readonly update: QueuedPostingUpdate;
  /** 預けた日時（ISO8601） */
  readonly queuedAt: string;
}

/**
 * 投稿の記録がまだ無い預かりを残しておく日数。
 *
 * 番号が届いてから『投稿しました』を選ぶまでは、ふつうは同じ案内の中で済む。閉じてしまっても、
 * 作者はたいてい数日のうちに投稿キットを開き直す。2週間を過ぎても記録が無いのは、投稿を
 * やめた話か別の機械で記録した話なので、残しても入る先が無い（保管庫を太らせない）。
 */
export const PENDING_MAX_AGE_DAYS = 14;

/** 1作品に残す預かりの上限（古いものから捨てる。ふつうは数件で、これを超えるのは不具合） */
export const PENDING_MAX_PER_WORK = 50;

/** 保管庫の鍵 */
export const PENDING_MEMORY_KEY = "novelai.postedPending.v1";

/** 保管庫のうち使う分（`vscode.Memento` と同じ形） */
export interface PendingMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** 保管庫が渡されていないとき（単体テストなど）の置き場。閉じれば消える */
function memoryOnly(): PendingMemory {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return values.has(key) ? (values.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown): Thenable<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

let memory: PendingMemory = memoryOnly();

/** 保管庫を渡す（`extension.ts` の起動時に1回。`context.globalState`） */
export function usePostingPendingMemory(next: PendingMemory): void {
  memory = next;
}

type PendingTable = Record<string, StoredPostingUpdate[]>;

/**
 * 保管庫の預かりを読む。**形の崩れた行は読まない**（別の版が書いた・手で触った等。
 * 崩れた行で台帳を書き換えない）
 */
function readTable(): PendingTable {
  const raw = memory.get<unknown>(PENDING_MEMORY_KEY, {});
  const table: PendingTable = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return table;
  for (const [workId, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter(isStoredUpdate);
    if (kept.length > 0) table[workId] = kept;
  }
  return table;
}

function isStoredUpdate(value: unknown): value is StoredPostingUpdate {
  if (typeof value !== "object" || value === null) return false;
  const row = value as { update?: unknown; queuedAt?: unknown };
  if (typeof row.queuedAt !== "string") return false;
  const update = row.update as Record<string, unknown> | undefined;
  if (typeof update !== "object" || update === null || typeof update.site !== "string") return false;
  if (update.kind === "workNumber") {
    return typeof update.number === "string" && typeof update.recordedAt === "string";
  }
  if (update.kind !== "episode") return false;
  const target = update.target as unknown;
  const targetOk =
    typeof target === "string" ||
    (typeof target === "object" &&
      target !== null &&
      typeof (target as { episodePath?: unknown }).episodePath === "string");
  return (
    targetOk &&
    typeof update.episodeId === "string" &&
    typeof update.allowReplace === "boolean" &&
    typeof update.label === "string"
  );
}

async function writeTable(table: PendingTable): Promise<void> {
  const cleaned: PendingTable = {};
  for (const [workId, rows] of Object.entries(table)) {
    if (rows.length > 0) cleaned[workId] = rows;
  }
  await memory.update(PENDING_MEMORY_KEY, cleaned);
}

interface Session {
  /** 同じ作品で案内が入れ子になったときのための数（ふつうは1） */
  depth: number;
  readonly issued: Map<string, IssuedPostRef>;
}

const sessions = new Map<string, Session>();

/** 案内を始める（作品の登録ID）。**必ず `endPostingKitSession` と対で呼ぶ** */
export function beginPostingKitSession(workId: string): void {
  const current = sessions.get(workId);
  if (current) {
    current.depth++;
    return;
  }
  sessions.set(workId, { depth: 1, issued: new Map() });
}

/**
 * 案内を終える。**その作品の預かりを返す**（呼ぶ側が最後の保存に使い、`settlePendingUpdates`
 * で片づける）。入れ子の内側では空を返す。預かりは保管庫に残ったまま
 */
export function endPostingKitSession(workId: string): StoredPostingUpdate[] {
  const current = sessions.get(workId);
  if (!current) return [];
  current.depth--;
  if (current.depth > 0) return [];
  sessions.delete(workId);
  return [...storedPostingUpdatesOf(workId)];
}

/** その作品の案内が開いているか */
export function isPostingKitActive(workId: string): boolean {
  return sessions.has(workId);
}

/** 封筒をコピーしたときに、渡した札を覚える（札は案内の中でだけ引く。台帳には投稿の記録として残る） */
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
 * 預けた分は保管庫に残る（VS Code を閉じても消えない）。
 */
export async function queuePostingUpdate(
  workId: string,
  update: QueuedPostingUpdate,
  now: Date = new Date()
): Promise<boolean> {
  if (!sessions.has(workId)) return false;
  const table = readTable();
  const rows = (table[workId] ?? []).filter((row) => !sameSlot(row.update, update));
  rows.push({ update, queuedAt: now.toISOString() });
  table[workId] = rows.slice(Math.max(0, rows.length - PENDING_MAX_PER_WORK));
  await writeTable(table);
  return true;
}

function sameSlot(a: QueuedPostingUpdate, b: QueuedPostingUpdate): boolean {
  if (a.kind !== b.kind || a.site !== b.site) return false;
  if (a.kind === "episode" && b.kind === "episode") {
    return postingEpisodeKey(a.target) === postingEpisodeKey(b.target);
  }
  return true;
}

/** その作品の預かり（保管庫から読む） */
export function storedPostingUpdatesOf(workId: string): readonly StoredPostingUpdate[] {
  return readTable()[workId] ?? [];
}

/** その作品の預かりの書き込みだけ（案内が保存のたびに当てる） */
export function queuedPostingUpdatesOf(workId: string): readonly QueuedPostingUpdate[] {
  return storedPostingUpdatesOf(workId).map((row) => row.update);
}

/** 預かりのある作品の登録ID（起動時に片づける） */
export function workIdsWithPendingUpdates(): string[] {
  return Object.keys(readTable());
}

/** 待たせる理由（片づけで、残すか消すかを分ける） */
export type WaitingReason = "noPost" | "replace" | "taken" | "invalid";

/** 当てた結果 */
export interface QueuedApplyResult {
  readonly ledger: PostingLedger;
  /** 台帳が変わったか */
  readonly changed: boolean;
  /** まだ当てられないもの */
  readonly waiting: readonly {
    readonly update: QueuedPostingUpdate;
    readonly reason: string;
    readonly kind: WaitingReason;
  }[];
}

/**
 * 預かりを台帳へ当てる。**預かりは消さない**——案内は保存のたびに手元の台帳から
 * 次の台帳を作るので、一度当てて消すと、次の保存で手元の古い台帳から書いて消えてしまう。
 * 当てる操作はどれも何度当てても同じなので、保存のたびに当て直してよい。
 * 消すのは保存が済んだあとの `settlePendingUpdates`。
 */
export function applyQueuedPostingUpdates(
  ledger: PostingLedger,
  updates: readonly QueuedPostingUpdate[]
): QueuedApplyResult {
  let next = ledger;
  let changed = false;
  const waiting: { update: QueuedPostingUpdate; reason: string; kind: WaitingReason }[] = [];
  for (const update of updates) {
    if (update.kind === "workNumber") {
      const written = withSiteWorkNumber(next, update.site, update.number, update.recordedAt);
      if (!written) {
        waiting.push({ update, reason: "小説番号の形が正しくありません", kind: "invalid" });
        continue;
      }
      if (written !== next) changed = true;
      next = written;
      continue;
    }
    // 上書きしない決まりは受け取ったときと同じ（`planSiteEpisodeId`）。台帳が変わっていても当て直す
    const plan = planSiteEpisodeId(next, update.target, update.site, update.episodeId);
    if (plan.kind === "same") continue;
    if (plan.kind === "noPost") {
      waiting.push({ update, reason: "投稿の記録がまだありません", kind: "noPost" });
      continue;
    }
    if (plan.kind === "taken") {
      waiting.push({
        update,
        reason: `同じ番号が別の話（${plan.holder}）に記録されています`,
        kind: "taken",
      });
      continue;
    }
    if (plan.kind === "replace" && !update.allowReplace) {
      waiting.push({ update, reason: `別の番号（${plan.existing}）が記録されています`, kind: "replace" });
      continue;
    }
    const written = withSiteEpisodeId(next, update.target, update.site, update.episodeId);
    if (!written) {
      waiting.push({ update, reason: "番号を投稿の記録へ入れられませんでした", kind: "invalid" });
      continue;
    }
    next = written;
    changed = true;
  }
  return { ledger: next, changed, waiting };
}

/** 片づけの計画（`planPendingSettlement`） */
export interface PendingSettlement extends QueuedApplyResult {
  /** 保管庫に残すもの（投稿の記録を待つもの） */
  readonly keep: readonly StoredPostingUpdate[];
  /** 消すもの（待っても直らない・古くなった）。知らせとログに出す */
  readonly dropped: readonly { readonly update: QueuedPostingUpdate; readonly reason: string }[];
}

/**
 * 預かりを当て、残すものと消すものを分ける（まだ保管庫は変えない。純粋関数）。
 * 決まりは冒頭の「片づけの決まり」。
 */
export function planPendingSettlement(
  ledger: PostingLedger,
  stored: readonly StoredPostingUpdate[],
  now: Date = new Date()
): PendingSettlement {
  const applied = applyQueuedPostingUpdates(
    ledger,
    stored.map((row) => row.update)
  );
  const keep: StoredPostingUpdate[] = [];
  const dropped: { update: QueuedPostingUpdate; reason: string }[] = [];
  const limit = now.getTime() - PENDING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const item of applied.waiting) {
    const row = stored.find((entry) => entry.update === item.update);
    if (!row) continue;
    if (item.kind !== "noPost") {
      dropped.push({ update: item.update, reason: item.reason });
      continue;
    }
    const queuedAt = Date.parse(row.queuedAt);
    // 日時が読めない行は古いものとして扱う（いつまでも残さない）
    if (!Number.isFinite(queuedAt) || queuedAt < limit) {
      dropped.push({
        update: item.update,
        reason: `${PENDING_MAX_AGE_DAYS}日たっても投稿の記録ができませんでした`,
      });
      continue;
    }
    keep.push(row);
  }
  return { ...applied, keep, dropped };
}

/**
 * 片づけを保管庫へ書く。**台帳の保存が済んでから呼ぶ**（先に消すと、保存が止まったときに番号を失う）。
 *
 * 計画を立てたあとに預けられた分（`settled` に無い行）は消さない——片づけの間に
 * ヘルパーのボタンがもう一度押されることがある。
 */
export async function settlePendingUpdates(
  workId: string,
  settled: readonly StoredPostingUpdate[],
  keep: readonly StoredPostingUpdate[]
): Promise<void> {
  const table = readTable();
  const current = table[workId] ?? [];
  const isSettled = (row: StoredPostingUpdate): boolean =>
    settled.some((entry) => sameRow(entry, row));
  table[workId] = [
    ...current.filter((row) => !isSettled(row)),
    ...current.filter((row) => isSettled(row) && keep.some((entry) => sameRow(entry, row))),
  ];
  await writeTable(table);
}

function sameRow(a: StoredPostingUpdate, b: StoredPostingUpdate): boolean {
  return a.queuedAt === b.queuedAt && sameSlot(a.update, b.update) && sameValue(a.update, b.update);
}

function sameValue(a: QueuedPostingUpdate, b: QueuedPostingUpdate): boolean {
  if (a.kind === "episode" && b.kind === "episode") return a.episodeId === b.episodeId;
  if (a.kind === "workNumber" && b.kind === "workNumber") return a.number === b.number;
  return false;
}

/**
 * 登録の無い作品の預かりのうち、古いものを消す（起動時。作品を外したあとに残り続けないように）。
 * 登録が一時的に見えないだけのこともある（フォルダーを外した等）ので、新しいものは残す。
 *
 * @returns 消した数
 */
export async function prunePendingOfUnknownWorks(
  knownWorkIds: readonly string[],
  now: Date = new Date()
): Promise<number> {
  const table = readTable();
  const limit = now.getTime() - PENDING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [workId, rows] of Object.entries(table)) {
    if (knownWorkIds.includes(workId)) continue;
    const kept = rows.filter((row) => {
      const at = Date.parse(row.queuedAt);
      return Number.isFinite(at) && at >= limit;
    });
    removed += rows.length - kept.length;
    table[workId] = kept;
  }
  if (removed > 0) await writeTable(table);
  return removed;
}
