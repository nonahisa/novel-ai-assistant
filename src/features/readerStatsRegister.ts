import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  postingSiteInfo,
  siteProfile,
  withSiteProfile,
  type PostingLedger,
  type PostingSiteId,
} from "../models/posting";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import type { ReaderStatsBundle, ReaderStatsEnvelope } from "../core/readerStatsEnvelope";
import {
  DECLINED_UNDO_HINT,
  planReaderStatsSiteId,
  readerStatsDeclineKey,
  readerStatsWorkPageUrl,
  suggestWorksByTitle,
} from "../core/readerStatsHelperLink";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { whenNoticePicked } from "../views/notify";
import { cancelItem } from "../views/dialogs";

/**
 * 登録の無い作品IDの読者の反応を、その場で作品に登録して取り込む（作者の裁定 2026-10-11）。
 *
 * ヘルパーが渡した画面の作品IDを、どの作品も登録していないと、これまでは
 * 「この作品IDを登録した作品が見つかりませんでした」で終わっていた。作者の書庫には
 * カクヨムを登録した作品が1つも無く、カクヨムの読者の反応は毎回そこで止まっていた。
 *
 * ## 作品名だけで決めない
 *
 * 作者の裁定「タイトルが同じとは限らないので、入力も必要」。作品名が近い作品は
 * 一覧の先頭に「おすすめ」として出すが、**選んだことにはしない**（一覧の先頭は
 * 「この中に無い」で、そのまま Enter を押しても何も登録しない）。
 * 封筒に作品名が無ければ（ヘルパー 0.13.1 の封筒には無い）、作品IDとURLだけで出す。
 *
 * ## 作者のデータを上書きしない
 *
 * 書き込みは「投稿サイト設定」と同じ道（`withSiteProfile` → `PostingStore.save`。
 * 読んだときのハッシュで照合する）。選んだ作品に**別の作品IDがあれば、確かめるまで
 * 書かない。** 置き換えるときも替えるのは作品IDだけで、作品ページ・ジャンル・
 * 作者のメモは残す。
 *
 * ## 知らせの答えは待たない
 *
 * ボタンつきの知らせは `whenNoticePicked` で、押されたら後から動く（スキル implement
 * 「ボタンつきの知らせ」）。押されたときには取り込みの呼び手はもう戻っているので、
 * 取り込んだあとの作り直し（執筆量パネル）は `afterImport` で受け取って呼ぶ。
 */

/** 知らせのボタンの文言 */
export const REGISTER_WORK_ID_LABEL = "作品に登録する";

/**
 * 「登録しない」と決めた作品IDの置き場（`context.globalState` の鍵）。
 * 値は `readerStatsDeclineKey` の並び。書く口は `saveDeclined` の1か所だけ
 */
export const DECLINED_READER_STATS_IDS_KEY = "novelai.readerStats.declinedWorkIds";

/** 覚えておく「登録しない」の数。古いものから忘れる（保管庫を太らせない） */
const MAX_DECLINED = 50;

/** 覚えの置き場（`vscode.Memento` のうち使う分だけ。`verifiedState` で包んだものを渡す） */
export interface DeclinedMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ReaderStatsRegisterOptions {
  memory: DeclinedMemory;
  /** その場で取り込んだあと（執筆量パネルを作り直す） */
  afterImport?(work: WorkEntry): Promise<void>;
  /**
   * 作者が「読者の反応を貼り付けて取り込む」を押したとき。**「登録しない」にした
   * IDでもボタンを出す**——自分で取り込みに来たのは、登録し直したいからである
   * （覚えを取り消す道。`DECLINED_UNDO_HINT`）
   */
  manual?: boolean;
}

/** 登録すれば取り込める、1つの作品IDの分 */
export interface PendingReaderStatsRegistration {
  readonly site: PostingSiteId;
  readonly workId: string;
  /** その作品IDの画面（溜めた順） */
  readonly envelopes: readonly ReaderStatsEnvelope[];
  /** サイトでの作品名（封筒に入っていれば）。おすすめにだけ使う */
  readonly title?: string;
}

/** 束を取り込む関数（`importReaderStatsBundle`。読み込みの輪を作らないよう、呼び手から渡す） */
export type ImportReaderStatsBundle = (
  bundle: ReaderStatsBundle,
  works: readonly WorkEntry[],
  options?: { lead?: string }
) => Promise<{ changed: boolean; changedWorks?: readonly WorkEntry[] }>;

/** 「登録しない」と決めた作品IDか */
export function isDeclinedReaderStatsId(
  memory: DeclinedMemory,
  site: PostingSiteId,
  workId: string
): boolean {
  return readDeclined(memory).includes(readerStatsDeclineKey(site, workId));
}

/**
 * 封筒を、作品IDごとの「登録すれば取り込める分」に束ねる（届いた順）。
 * 作品IDの無い封筒は登録しようがないので外す
 */
export function groupPendingRegistrations(
  envelopes: readonly ReaderStatsEnvelope[]
): PendingReaderStatsRegistration[] {
  const groups = new Map<string, { site: PostingSiteId; workId: string; envelopes: ReaderStatsEnvelope[] }>();
  for (const envelope of envelopes) {
    if (!envelope.workId) continue;
    const key = readerStatsDeclineKey(envelope.site, envelope.workId);
    const found = groups.get(key);
    if (found) found.envelopes.push(envelope);
    else groups.set(key, { site: envelope.site, workId: envelope.workId, envelopes: [envelope] });
  }
  return [...groups.values()];
}

/**
 * 知らせを出し、［作品に登録する］が押されたら登録の画面へ進む。**答えは待たない。**
 */
export function showNoticeWithRegister(
  level: "info" | "warning",
  message: string,
  pending: readonly PendingReaderStatsRegistration[],
  works: readonly WorkEntry[],
  options: ReaderStatsRegisterOptions,
  importBundle: ImportReaderStatsBundle
): void {
  const shown =
    level === "warning"
      ? vscode.window.showWarningMessage(message, REGISTER_WORK_ID_LABEL)
      : vscode.window.showInformationMessage(message, REGISTER_WORK_ID_LABEL);
  whenNoticePicked(
    shown,
    async (answer) => {
      if (answer !== REGISTER_WORK_ID_LABEL) return;
      await registerReaderStatsWorkIds(pending, works, options, importBundle);
    },
    { label: "読者の反応の作品IDの登録" }
  );
}

/**
 * 作品IDごとに、どの作品のものかを選んでもらい、登録して取り込む。
 * 選ぶ画面を閉じたら（Esc）、残りの作品IDも訊かずに終える
 */
export async function registerReaderStatsWorkIds(
  pending: readonly PendingReaderStatsRegistration[],
  works: readonly WorkEntry[],
  options: ReaderStatsRegisterOptions,
  importBundle: ImportReaderStatsBundle
): Promise<void> {
  for (const entry of pending) {
    const go = await registerOne(entry, works, options, importBundle);
    if (!go) return;
  }
}

interface LoadedWork {
  work: WorkEntry;
  /** 読めなければ undefined（選ばれたときに理由を出す。一覧からは外さない） */
  ledger?: PostingLedger;
}

interface RegisterPickItem extends vscode.QuickPickItem {
  workId?: string;
  choice?: "none" | "decline" | "undecline";
}

/** @returns 続けて次の作品IDを訊くか（選ぶ画面を閉じたら false） */
async function registerOne(
  entry: PendingReaderStatsRegistration,
  works: readonly WorkEntry[],
  options: ReaderStatsRegisterOptions,
  importBundle: ImportReaderStatsBundle
): Promise<boolean> {
  const siteLabel = postingSiteInfo(entry.site).label;
  /*
    **台帳はボタンが押されたいまの分を読む。** 知らせを出してから押されるまでに
    時間がたち、その間に「投稿サイト設定」で登録されていることがある
  */
  const loaded = await loadAll(works);
  const already = loaded.filter(
    (candidate) =>
      candidate.ledger &&
      planReaderStatsSiteId(candidate.ledger, entry.site, entry.workId).kind === "same"
  );
  if (already.length === 1) {
    // もう登録されている——選ばせずにその作品へ取り込む
    await importInto(already[0].work, entry, options, importBundle, undefined);
    return true;
  }

  const picked = await pickWork(entry, loaded, options);
  if (!picked) return false;
  if (picked.choice === "none") return true;
  if (picked.choice === "decline") {
    await saveDeclined(options.memory, withDeclined(readDeclined(options.memory), entry, true));
    logRegister(undefined, `${siteLabel}の作品ID ${entry.workId} は登録しないことにしました（次から知らせません）。`);
    return true;
  }
  if (picked.choice === "undecline") {
    await saveDeclined(options.memory, withDeclined(readDeclined(options.memory), entry, false));
    logRegister(undefined, `${siteLabel}の作品ID ${entry.workId} を、また知らせるようにしました。`);
    return true;
  }
  const target = loaded.find((candidate) => candidate.work.id === picked.workId);
  if (!target) return true;

  const work = target.work;
  const store = new PostingStore(work);
  let ledger: PostingLedger;
  try {
    ledger = await store.load();
  } catch (error) {
    await reportFailure("投稿状態の読み込み", work, error);
    return true;
  }

  const plan = planReaderStatsSiteId(ledger, entry.site, entry.workId);
  if (plan.kind === "replace") {
    const answer = await vscode.window.showWarningMessage(
      `「${work.title}」には、${siteLabel}の作品ID ${plan.existing} が登録されています。` +
        `${entry.workId} に置き換えますか？`,
      {
        modal: true,
        detail:
          `置き換えると、作品ID ${plan.existing} の読者の反応は、この作品へ取り込めなくなります。` +
          "これまでに取り込んだ記録は消えません。作品ページのURL・ジャンル・メモはそのまま残します。",
      },
      "置き換える"
    );
    if (answer !== "置き換える") {
      logRegister(work, `「${work.title}」の${siteLabel}の作品ID（${plan.existing}）は置き換えませんでした。`);
      return true;
    }
  }

  let lead: string | undefined;
  if (plan.kind !== "same") {
    // **替えるのは作品IDだけ。** `withSiteProfile` はそのサイトの作品情報を丸ごと
    // 差し替えるので、いまの欄を広げてから作品IDを入れる（作品ページ・ジャンル・メモを消さない）
    const next = withSiteProfile(ledger, entry.site, {
      ...(siteProfile(ledger, entry.site) ?? {}),
      workId: entry.workId,
    });
    try {
      await store.save(next);
    } catch (error) {
      await reportFailure("投稿状態の保存", work, error, "読者の反応の作品IDの登録");
      return true;
    }
    lead = `「${work.title}」に${siteLabel}の作品ID ${entry.workId} を登録しました。`;
    logRegister(work, lead);
  }
  // 登録したIDは「登録しない」の覚えから外す（手で貼り付けて登録し直したとき）
  if (isDeclinedReaderStatsId(options.memory, entry.site, entry.workId)) {
    await saveDeclined(options.memory, withDeclined(readDeclined(options.memory), entry, false));
  }
  await importInto(work, entry, options, importBundle, lead);
  return true;
}

/** 届いていた画面を、その作品へ取り込む（もう一度ヘルパーを押させない） */
async function importInto(
  work: WorkEntry,
  entry: PendingReaderStatsRegistration,
  options: ReaderStatsRegisterOptions,
  importBundle: ImportReaderStatsBundle,
  lead: string | undefined
): Promise<void> {
  const bundle: ReaderStatsBundle = {
    items: entry.envelopes.map((envelope, index) => ({
      position: index + 1,
      result: { ok: true, envelope },
    })),
  };
  const result = await importBundle(bundle, [work], { lead });
  for (const changed of result.changedWorks ?? []) {
    await options.afterImport?.(changed);
  }
}

async function pickWork(
  entry: PendingReaderStatsRegistration,
  loaded: readonly LoadedWork[],
  options: ReaderStatsRegisterOptions
): Promise<RegisterPickItem | undefined> {
  const siteLabel = postingSiteInfo(entry.site).label;
  const url = readerStatsWorkPageUrl(entry.site, entry.workId);
  const suggested = suggestWorksByTitle(
    loaded.map((candidate) => ({ id: candidate.work.id, title: candidate.work.title })),
    entry.title
  );
  const workItem = (candidate: LoadedWork, recommended: boolean): RegisterPickItem => ({
    label: candidate.work.title,
    description: [recommended ? "おすすめ：作品名が近い" : undefined, stateOf(candidate, entry)]
      .filter((part): part is string => Boolean(part))
      .join("・"),
    detail: candidate.work.folderPath,
    workId: candidate.work.id,
  });
  const declined = isDeclinedReaderStatsId(options.memory, entry.site, entry.workId);

  const rest: RegisterPickItem[] = [
    ...loaded
      .filter((candidate) => suggested.includes(candidate.work.id))
      .map((candidate) => workItem(candidate, true)),
    ...loaded
      .filter((candidate) => !suggested.includes(candidate.work.id))
      .map((candidate) => workItem(candidate, false)),
    ...(declined
      ? [
          {
            label: "$(bell) 知らせを戻す（次からまた知らせる）",
            detail: "登録はしません",
            choice: "undecline" as const,
          },
        ]
      : [
          {
            label: "$(circle-slash) 登録しない（この作品IDは今後知らせない）",
            detail: DECLINED_UNDO_HINT,
            choice: "decline" as const,
          },
        ]),
  ];
  return vscode.window.showQuickPick<RegisterPickItem>(
    [
      /*
        **先頭は作品でないものにする。** 一覧を出したまま Enter を押すと先頭が選ばれる
        ——作品名の近い作品を先頭に置くと、見ずに押しただけで登録したことになる
      */
      {
        ...cancelItem("この中に無い（いまは登録しない）"),
        detail:
          "作品を登録してから、ヘルパーの「もう一度渡す」で渡し直すと、ここからまた選べます",
        choice: "none",
      },
      ...rest,
    ],
    {
    title: `${siteLabel}の作品ID ${entry.workId} を登録する作品`,
    placeHolder:
      `どの作品の作品IDですか` +
      (url ? `（${url}）` : "") +
      (entry.title ? `。サイトでの作品名：${entry.title}` : ""),
    ignoreFocusOut: true,
    matchOnDescription: true,
    }
  );
}

/** 一覧に添える、その作品のいまの登録 */
function stateOf(candidate: LoadedWork, entry: PendingReaderStatsRegistration): string {
  const siteLabel = postingSiteInfo(entry.site).label;
  if (!candidate.ledger) return "投稿状態を読めません";
  const existing = siteProfile(candidate.ledger, entry.site)?.workId?.trim();
  return existing
    ? `${siteLabel}の作品ID ${existing} を登録済み（置き換えるときは確かめます）`
    : `${siteLabel}の作品ID 未登録`;
}

async function loadAll(works: readonly WorkEntry[]): Promise<LoadedWork[]> {
  const loaded: LoadedWork[] = [];
  for (const work of works) {
    try {
      loaded.push({ work, ledger: await new PostingStore(work).load() });
    } catch (error) {
      // 一覧には残す（選ばれたら、読み直して理由を出す）。ここでは記録だけ
      useLogFile(work.folderPath);
      logFailure("読者の反応の作品IDの登録：投稿状態の読み込み", {
        作品: work.title,
        内容: error instanceof Error ? error.message : String(error),
      });
      loaded.push({ work });
    }
  }
  return loaded;
}

function readDeclined(memory: DeclinedMemory): string[] {
  const value = memory.get<unknown>(DECLINED_READER_STATS_IDS_KEY, []);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function withDeclined(
  current: readonly string[],
  entry: PendingReaderStatsRegistration,
  declined: boolean
): string[] {
  const key = readerStatsDeclineKey(entry.site, entry.workId);
  const next = current.filter((value) => value !== key);
  if (declined) next.push(key);
  return next.slice(Math.max(0, next.length - MAX_DECLINED));
}

/** 「登録しない」の覚えを書く口（鍵ごとに1か所。`mementoWrites.test.ts`） */
async function saveDeclined(memory: DeclinedMemory, list: readonly string[]): Promise<void> {
  await memory.update(DECLINED_READER_STATS_IDS_KEY, list);
}

function logRegister(work: WorkEntry | undefined, message: string): void {
  // **記録の直前に書き先を向ける**（0.43.3 と同じ）
  useLogFile(work?.folderPath);
  logStep(message);
}

/** 失敗はログに残してから知らせる（`readerStats.ts` の `report` と同じ形） */
async function reportFailure(
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
    読み込んだ時刻: error instanceof PostingStoreError ? error.loadedAt : undefined,
    内容: message,
  });
  void vscode.window.showErrorMessage(message);
}
