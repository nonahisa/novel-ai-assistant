import { DRIVE_DELETED, isSafeSyncPath } from "./driveSyncPlan";
import type { DriveSyncRecord } from "./driveSyncRecord";

/**
 * 作品ごとの送り先（GitHub ⇔ Google ドライブ）と、切り替えてよいかの判断
 * （設計書5.10.5・5.10.9。段階3）。`vscode`・`node:` を読まない
 * （`driveDestination.test.ts` が見張る）。
 *
 * ## 送り先の置き場：この機械の globalState（作品の ID → 送り先）
 *
 * 作品の設定（`config.json`）には書かない。送り先は「この機械が、この作品をどこと
 * そろえるか」で、作者の書いたデータではない。`config.json` に書くと、作者の作品の
 * 設定へ機械が1欄足すことになり（実装ルール2）、その欄が GitHub とドライブの両方で
 * 運ばれて、切り替えの途中の機械どうしで食い違う。2台目は2台目で切り替える。
 *
 * ## ドライブの中の作品のフォルダー名：`workUid`
 *
 * 2台で同じ番号（設計書6.13.7。`config.json` の `workUid`）。作品の名前は2台で
 * 変わりうる・同じ名前の作品がありうるので使わない。workUid の無い作品は、
 * 切り替えるときに `ensureWorkUid` で作って書く（既にある番号は変えない）。
 */

/** 送り先の種類。省いたもの（記録の無い作品）は GitHub（今までどおり） */
export type SyncDestination = "github" | "googleDrive";

/** globalState の鍵（作品の ID → `"googleDrive"`。GitHub の作品は載せない） */
export const SYNC_DESTINATION_KEY = "novelai.syncDestination";

/** globalState の口（読むだけ／書くだけ） */
export interface DestinationStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** 送り先の表を読む。形の違う値は無いもの（GitHub）として扱う */
export function readDestinations(storage: Pick<DestinationStorage, "get">): Map<string, SyncDestination> {
  const raw = storage.get(SYNC_DESTINATION_KEY);
  const out = new Map<string, SyncDestination>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [workId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "googleDrive") out.set(workId, "googleDrive");
  }
  return out;
}

export function destinationOf(storage: Pick<DestinationStorage, "get">, workId: string): SyncDestination {
  return readDestinations(storage).get(workId) ?? "github";
}

/** 送り先を書く。GitHub へ戻したら表から外す（表に残さない） */
export async function writeDestination(
  storage: DestinationStorage,
  workId: string,
  destination: SyncDestination
): Promise<void> {
  const table: Record<string, SyncDestination> = {};
  for (const [id, value] of readDestinations(storage)) table[id] = value;
  if (destination === "googleDrive") table[workId] = "googleDrive";
  else delete table[workId];
  await storage.update(SYNC_DESTINATION_KEY, table);
}

/**
 * まだドライブへ送っていない道（設計書5.10.5「未送信」）。
 *
 * 手元の今の中身のハッシュが、控えの系譜の頭と違う道。控えに頭があるのに手元に
 * 無い道（手元で消した）も、送れば「消えた」が向こうへ届くので未送信に数える。
 * 送らないもの（`isSendable` が偽）は数えない。
 */
export function findDriveUnsent(input: {
  record: DriveSyncRecord;
  /** 手元の道 → 中身のハッシュ（送らないものを含んでよい） */
  local: ReadonlyMap<string, string>;
  isSendable: (syncPath: string) => boolean;
}): string[] {
  const out = new Set<string>();
  for (const [entry, hash] of input.local) {
    if (!isSafeSyncPath(entry) || !input.isSendable(entry)) continue;
    if (input.record.lineage.get(entry)?.hash !== hash) out.add(entry);
  }
  for (const [entry, lineage] of input.record.lineage) {
    if (lineage.hash === DRIVE_DELETED || input.local.has(entry) || !input.isSendable(entry)) continue;
    out.add(entry);
  }
  return [...out].sort();
}

/** 作品の git の置き場の様子（切り替えの判断に要る所だけ。features が git の状態から作る） */
export type WorkGitState =
  /** git を使っていない・git が無い */
  | { kind: "none" }
  | {
      kind: "repo";
      /** 送っていない記録・記録していない変更がある（その作品の中） */
      unsent: boolean;
      /** 取り込んでいない記録がある（置き場ぜんぶ） */
      behind: boolean;
      /** git が未解決の食い違いを抱えている */
      conflicted: boolean;
      /** 同じ置き場に入っている、GitHub へ送るほかの作品の名前 */
      sharedWith: string[];
    };

export type SwitchCheck = { ok: true } | { ok: false; reasons: string[] };

/**
 * GitHub → Google ドライブへ切り替えてよいか（設計書5.10.5）。
 * **未送信・食い違い・未保存を残したまま移らない**（残っていれば理由を出して断る）。
 *
 * 同じ git の置き場（書庫）に GitHub へ送るほかの作品が入っていれば断る：記録と送信は
 * 置き場ごと（`commitAll`）なので、1作品だけを外すと、その作品がドライブと GitHub の
 * 両方へ黙って運ばれる（設計書5.10.1「1つの作品で GitHub と併用はしない」）
 */
export function checkSwitchToDrive(input: {
  unsavedFiles: number;
  git: WorkGitState;
  /** 作品の番号（`workUid`）。`invalid` は形が違って直さずに止めたもの */
  workUid: "present" | "absent" | "invalid";
  loggedIn: boolean;
}): SwitchCheck {
  const reasons: string[] = [];
  if (!input.loggedIn) reasons.push("Google ドライブにログインしていません");
  if (input.unsavedFiles > 0) reasons.push(`保存していないファイルがあります（${input.unsavedFiles}件）`);
  if (input.git.kind === "repo") {
    if (input.git.sharedWith.length > 0) {
      reasons.push(
        `同じ GitHub の置き場に、ほかの作品（${input.git.sharedWith.join("・")}）が入っています。この作品だけをドライブへ移すことはできません`
      );
    }
    if (input.git.conflicted) reasons.push("GitHub との食い違いが残っています");
    if (input.git.unsent) reasons.push("GitHub へ送っていない変更があります");
    if (input.git.behind) reasons.push("GitHub から受け取っていない変更があります");
  }
  if (input.workUid === "invalid") {
    reasons.push("作品設定の workUid の形が違います（直さずに止めました）");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Google ドライブ → GitHub へ戻してよいか（設計書5.10.5）。
 * ドライブへ送っていない変更・選んでいない食い違い・未保存があれば断る。
 * 控えが読めない作品も断る（未送信かどうかを言い切れない）
 */
export function checkSwitchToGithub(input: {
  unsavedFiles: number;
  /** ドライブへ送っていない道（`findDriveUnsent`）。控えが読めなければ undefined */
  unsent: readonly string[] | undefined;
  /** 前の受け取りで選んでいない食い違いの道 */
  pendingConflicts: readonly string[];
}): SwitchCheck {
  const reasons: string[] = [];
  if (input.unsavedFiles > 0) reasons.push(`保存していないファイルがあります（${input.unsavedFiles}件）`);
  if (input.unsent === undefined) reasons.push("ドライブの控えが読めません（直さずに止めました）");
  else if (input.unsent.length > 0) reasons.push(`ドライブへ送っていない変更があります（${input.unsent.length}件）`);
  if (input.pendingConflicts.length > 0) {
    reasons.push(`どれを残すか選んでいない食い違いがあります（${input.pendingConflicts.length}件）`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * 送る前に見つける、ドライブへ一度に送れない大きさのファイル（`driveApi.ts` の
 * `DRIVE_SIMPLE_UPLOAD_LIMIT`）。1つでもあると送りが途中で止まり、目録まで届かない
 * ——毎回同じ所で止まるので、送る前にファイル名つきで止める（黙って外さない）
 */
export function findTooLargeForDrive(
  sizes: ReadonlyMap<string, number>,
  limit: number,
  isSendable: (syncPath: string) => boolean
): string[] {
  return [...sizes]
    .filter(([entry, size]) => size > limit && isSendable(entry))
    .map(([entry]) => entry)
    .sort();
}

/** 選んでいない食い違いの控えの鍵（globalState。作品の ID → 道の一覧） */
export const DRIVE_PENDING_CONFLICTS_KEY = "novelai.googleDrive.pendingConflicts";

export function readPendingConflicts(storage: Pick<DestinationStorage, "get">, workId: string): string[] {
  const raw = storage.get(DRIVE_PENDING_CONFLICTS_KEY);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const value = (raw as Record<string, unknown>)[workId];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function writePendingConflicts(
  storage: DestinationStorage,
  workId: string,
  paths: readonly string[]
): Promise<void> {
  const raw = storage.get(DRIVE_PENDING_CONFLICTS_KEY);
  const table: Record<string, string[]> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, string[]>) } : {};
  if (paths.length === 0) delete table[workId];
  else table[workId] = [...paths].sort();
  await storage.update(DRIVE_PENDING_CONFLICTS_KEY, table);
}
