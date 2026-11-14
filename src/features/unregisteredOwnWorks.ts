import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import * as path from "../core/paths";
import {
  BACKUP_POLL_INTERVAL_MS,
  BACKUP_WAIT_LIMIT_MS,
  BackupArrivalWatch,
  type DownloadFolderLister,
} from "../core/backupArrivalWatch";
import { BACKUP_FILE_EXTENSIONS } from "../core/backupFileKinds";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { describeProcessesBlocked } from "../core/processAvailability";
import type { ReaderStatsEnvelope, ReaderStatsRanking } from "../core/readerStatsEnvelope";
import { canRunProcesses } from "../core/runtime";
import {
  holdOwnWorkRankings,
  holdOwnWorkStats,
  readPendingOwnWorkRankings,
  readPendingOwnWorkStats,
  storedPending,
  storedPendingRankings,
  takeRegisteredPending,
  type PendingOwnWorkRanking,
  type PendingOwnWorkStats,
} from "../core/ownWorkPendingStats";
import {
  backupEntryFor,
  forgetRegisteredOwnWorks,
  isRegisteredOwnWork,
  looksLikeBackupOf,
  hideUnregisteredOwnWork,
  hiddenUnregisteredOwnWorks,
  narouBackupIdFrom,
  unhideUnregisteredOwnWork,
  noteUnregisteredOwnWorks,
  ownWorkCandidates,
  ownWorkKey,
  ownWorkLabel,
  readUnregisteredOwnWorks,
  forgetUnregisteredOwnWork,
  setNarouBackupId,
  type UnregisteredOwnWork,
} from "../core/unregisteredOwnWorks";
import { messageOf } from "../core/errorMessage";
import { postingSiteInfo } from "../models/posting";
import type { WorkEntry } from "../models/types";
import { askText } from "../views/dialogs";
import { whenNoticePicked } from "../views/notify";
import type { TreeNode } from "../views/workTree";
import { showBackupOpenDialog } from "./backupPickFolder";
import { openSiteLink } from "./openSiteLink";
import type { ImportOwnWorkAsNew } from "./ownWorkBackupImport";

/**
 * 「未登録の自分の作品」の枠と、バックアップの受け渡し（作者の指示 2026-11-01。設計書6.99.8）。
 *
 * - 覚え（どの作品を枠に出すか）は `core/unregisteredOwnWorks.ts`。ここは保管庫へ書く口と、
 *   枠の3つの操作（［バックアップを取る］［ファイルから取り込む］［この作品を一覧に出さない］）
 * - **待ちは、この窓が開いているあいだだけ**動く。保管庫には書かない（閉じたら止まる）
 * - ダウンロードのフォルダーを見る部品（Node の `fs`）は**動的 import**。ブラウザ版では
 *   ［バックアップを取る］そのものを隠す（設計書5.8.16）
 * - ZIP を読む部品も、取り込みが押されてから動的 import する（起動を重くしない）
 * - **届いたバックアップは訊かずに取り込む**（作者の判断 2026-11-01「全部自動で取り込めない
 *   ものでしょうか？」）。どの作品のものか1つに決まらない・同じ作品が登録済み・読めない・
 *   中身が食い違うときだけ、今までどおり訊くか理由を言う。サイトのバックアップのボタンを
 *   押すのは作者の手に残す（ヘルパーもこちらも送信しない決まり）
 * - 管理画面で読んだ未登録の作品の読者の反応は控え（`core/ownWorkPendingStats.ts`）、
 *   登録されたらその作品へ取り込む
 */

/**
 * 覚えの置き場（`context.globalState` の鍵）。書く口は `save` の1か所だけ
 * （`mementoWrites.test.ts`）
 */
export const UNREGISTERED_OWN_WORKS_KEY = "novelai.ownWorks.unregistered";

/**
 * 読者の反応の控えの置き場（`context.globalState` の鍵）。書く口は `savePending` の1か所だけ
 * （`mementoWrites.test.ts`）
 */
export const PENDING_OWN_WORK_STATS_KEY = "novelai.ownWorks.pendingReaderStats";

/**
 * 順位の控えの置き場（`context.globalState` の鍵。2026-11-02）。書く口は `savePendingRankings` の
 * 1か所だけ（`mementoWrites.test.ts`）
 */
export const PENDING_OWN_WORK_RANKINGS_KEY = "novelai.ownWorks.pendingRankings";

/**
 * 届いたバックアップを訊かずに取り込むとき、前回「どこに作りますか」で選んだ書庫
 * （`context.globalState` の鍵。作者の指示 2026-11-01）。**作者の作品フォルダーには書かない。**
 * 書く口は `rememberUnattendedLibrary` の1か所だけ（`mementoWrites.test.ts`）
 */
export const UNATTENDED_LIBRARY_KEY = "novelai.ownWorks.unattendedLibrary";

/** 控えた読者の反応を、いま登録した作品へ移した結果（登録の知らせが言う） */
export interface HeldStatsOutcome {
  /** その作品の控えにあった画面の数 */
  readonly held: number;
  /** そのうち台帳に入った画面の数 */
  readonly imported: number;
}

/** 控えた読者の反応を取り込んだときの知らせの頭 */
export const HELD_STATS_LEAD = "登録した作品へ、登録の前に控えておいた読者の反応を移しました。";

/** 設定の名前（`novelai.` の下）。空ならホームの「ダウンロード」（Downloads） */
export const DOWNLOAD_FOLDER_SETTING = "ownWorks.downloadFolder";

/** 届いたときの問いのボタン */
export const IMPORT_ARRIVED_LABEL = "取り込む";
export const SKIP_ARRIVED_LABEL = "取り込まない";

/** 覚えの置き場（`vscode.Memento` のうち使う分だけ。`verifiedState` で包んだものを渡す） */
export interface OwnWorksMemory {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** 刻みを止める口 */
export interface ScheduledTask {
  dispose(): void;
}

export interface UnregisteredOwnWorksDeps {
  /** 新しい作品として取り込む口（`importWorkFromZip`。`extension.ts` が渡す） */
  importAsNew: ImportOwnWorkAsNew;
  /** 取り込んで登録したあと（一覧の読み直しなど） */
  afterImport?(work: WorkEntry): Promise<void>;
  /** サイトのリンクを開く（既定は `openSiteLink`。試験で差し替える） */
  openLink?(url: string): Promise<void>;
  /** ダウンロードのフォルダーを見られるか（既定は `canRunProcesses()`） */
  canWatch?(): boolean;
  /** 見る場所（既定は設定、空ならホームの「ダウンロード」） */
  downloadFolder?(): Promise<string>;
  /** その場所を見る口（既定は `core/downloadFolderNode.ts` を動的 import） */
  lister?(folder: string): Promise<DownloadFolderLister>;
  /** 刻み（既定は `setInterval`） */
  schedule?(tick: () => void, intervalMs: number): ScheduledTask;
  /**
   * いま登録済みのサイト・作品ID（と題）の組（既定は「何も登録されていない」）。
   * 届いたバックアップを訊かずに取り込む前に、同じ作品がもう登録されていないか見る
   */
  registeredKeys?(): Promise<ReadonlySet<string>>;
  /**
   * 控えておいた読者の反応を、登録した作品へ取り込む（束の取り込みと同じ関数を通す）。
   * `silent` が立っていたら知らせを出さない（登録の知らせが言う。記録には残す）。
   * @returns まだ台帳に入っていない画面（控えに残す）
   */
  importHeldStats?(
    envelopes: readonly ReaderStatsEnvelope[],
    lead: string,
    options?: { readonly silent?: boolean }
  ): Promise<readonly ReaderStatsEnvelope[]>;
  /**
   * 控えておいた順位を、登録した作品へ取り込む（束の取り込みと同じ関数を通す。知らせは出さない
   * ——読者の反応の控えの知らせと重ねない。積んだ順位はお祝いが言う）。
   * @returns まだ台帳に入っていない順位（控えに残す）
   */
  importHeldRankings?(
    rankings: readonly ReaderStatsRanking[]
  ): Promise<readonly ReaderStatsRanking[]>;
  /** 時計（試験で差し替える） */
  now?(): number;
  /** 待つ長さ（既定は30分） */
  limitMs?: number;
}

interface ActiveWait {
  readonly entry: UnregisteredOwnWork;
  readonly folder: string;
  readonly watch: BackupArrivalWatch;
  readonly task: ScheduledTask;
  /** 見直しが重ならないための印（前の見直しが終わる前に次の刻みが来たら飛ばす） */
  polling: boolean;
}

export class UnregisteredOwnWorks implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** 覚え・待ちが変わった（作品一覧の枠を描き直す） */
  readonly onDidChange = this.changed.event;
  private readonly waits = new Map<string, ActiveWait>();
  /** 訊かずに取り込んでいる最中の作品（同じ作品のファイルが続けて届いたら、2つ目は訊く） */
  private readonly importing = new Set<string>();
  /**
   * 控えの取り込みの列。**重なったら飛ばさず、前のが終わるのを待って順に走らせる。**
   * 飛ばす作りだったころは、登録の直後の一覧の描き直しが先に走ると、登録の道の取り込みが
   * 黙って何もせずに戻り、知らせが「取り込んだか」を言えなかった（2026-11-01 作者の実機）
   */
  private flushQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly memory: OwnWorksMemory,
    private readonly deps: UnregisteredOwnWorksDeps
  ) {}

  /** 覚えている作品（出さないを選んだもの・登録済みも含む。絞るのは作品一覧） */
  list(): UnregisteredOwnWork[] {
    return readUnregisteredOwnWorks(this.memory.get<unknown>(UNREGISTERED_OWN_WORKS_KEY, []));
  }

  /** その作品のバックアップを待っているか（枠に「バックアップ待ち」と出す） */
  isWaiting(entry: Pick<UnregisteredOwnWork, "site" | "workId">): boolean {
    return this.waits.has(ownWorkKey(entry.site, entry.workId));
  }

  /**
   * 作品の決まらなかった封筒を渡す。本人しか開けない画面で読んだ作品だけを覚える。
   * **失敗しても取り込みを止めない**（記録に残すだけ）
   */
  async note(envelopes: readonly ReaderStatsEnvelope[]): Promise<void> {
    try {
      const list = this.list();
      const next = noteUnregisteredOwnWorks(list, envelopes);
      if (next !== list) await this.save(next);
    } catch (error) {
      useLogFile(undefined);
      logFailure("未登録の自分の作品を覚える", { 詳細: messageOf(error) });
    }
    // 数も控える（作品が登録されたら、その作品へ取り込む。2026-11-01）
    try {
      const held = holdOwnWorkStats(this.pending(), envelopes, this.clock());
      if (held.changed) await this.savePending(held.next);
    } catch (error) {
      useLogFile(undefined);
      logFailure("未登録の自分の作品の読者の反応を控える", { 詳細: messageOf(error) });
    }
  }

  /**
   * 作品の決まらなかった順位を渡す（2026-11-02）。**順位には覚えた理由が無い**ので、
   * 同じ束の本人しか開けない画面で読んだ作品か、枠に覚えている作品（`note` が覚えたもの）
   * の順位だけを控える。**失敗しても取り込みを止めない**（記録に残すだけ）。
   * @returns 控えた順位（残りは呼ぶ側が記録に残して捨てる）
   */
  async noteRankings(
    rankings: readonly ReaderStatsRanking[],
    envelopes: readonly ReaderStatsEnvelope[]
  ): Promise<readonly ReaderStatsRanking[]> {
    try {
      const own = new Set(this.list().map((entry) => ownWorkKey(entry.site, entry.workId)));
      for (const envelope of ownWorkCandidates(envelopes)) {
        own.add(ownWorkKey(envelope.site, (envelope.workId ?? "").trim()));
      }
      const held = holdOwnWorkRankings(
        this.pendingRankings(),
        rankings,
        (site, workId) => own.has(ownWorkKey(site, workId)),
        this.clock()
      );
      if (held.changed) await this.savePendingRankings(held.next);
      return held.held;
    } catch (error) {
      useLogFile(undefined);
      logFailure("未登録の自分の作品の順位を控える", { 詳細: messageOf(error) });
      return [];
    }
  }

  /** 控えが残っているか（`OwnWorksSource.hasPendingStats`。覚えが空でも描き直しで取り込むため） */
  hasPendingStats(): boolean {
    return this.pending().length > 0 || this.pendingRankings().length > 0;
  }

  /** 控えている読者の反応（読み戻しの関所を通ったものだけ） */
  pendingStats(): readonly ReaderStatsEnvelope[] {
    return this.pending().map((entry) => entry.parsed);
  }

  /**
   * 作品一覧が描かれるたびに、登録済みの組を受け取る（`OwnWorksSource.noticeRegistered`）。
   * 枠の外の道（「投稿サイト設定」で作品IDを入れた・別の道で登録した）で登録された作品も、
   * ここで覚えから外し、控えておいた読者の反応をその作品へ取り込む。**答えは待たない**
   */
  noticeRegistered(registered: ReadonlySet<string>): void {
    void this.settleRegistered(registered).catch((error: unknown) => {
      useLogFile(undefined);
      logFailure("登録済みになった未登録の自分の作品を片づける", { 詳細: messageOf(error) });
    });
  }

  /** `noticeRegistered` の本体（試験から終わりを待てるように分ける） */
  async settleRegistered(registered: ReadonlySet<string>): Promise<void> {
    const list = this.list();
    const next = forgetRegisteredOwnWorks(list, registered);
    if (next !== list) {
      const gone = list.filter((entry) => !next.includes(entry));
      for (const entry of gone) this.stopWait(entry, "imported");
      await this.save(next);
      useLogFile(undefined);
      logStep(
        `登録済みになった作品を「未登録の自分の作品」から外しました：${gone
          .map((entry) => ownWorkLabel(entry))
          .join(" ／ ")}`
      );
    }
    const waiting = [...this.pending(), ...this.pendingRankings()].some((entry) =>
      registered.has(ownWorkKey(entry.site, entry.workId))
    );
    if (waiting) await this.flushHeldStats();
  }

  /**
   * 控えた読者の反応のうち、登録済みの作品の分を取り込む。
   * 作品が1つに決まらない画面・台帳に入らなかった画面は控えに残し、理由を記録に残す。
   *
   * **いま登録した作品は、呼ぶ側が名指しする**（`justRegistered`）。「登録済みか」を
   * 作品一覧の控え（`registeredKeys`）だけで見ると、登録の直後の描き直しが台帳に
   * 作品ID が書かれる前の空の台帳を控えに持つので、その作品が登録済みに見えない
   * （2026-11-01 作者の実機。控えが残ったまま、知らせは「手で足せます」と言った）。
   * 名指しした作品も、取り込み先は台帳を読み直して決めるので、台帳に作品ID が無ければ
   * 控えに残る（取り違えない）。
   *
   * @returns 名指しした作品の控えの数と、台帳に入った数（名指しが無ければ取り込み全体の数）
   */
  flushHeldStats(
    options: {
      readonly justRegistered?: Pick<UnregisteredOwnWork, "site" | "workId">;
      /** 知らせを出さない（登録の知らせが言う） */
      readonly silent?: boolean;
    } = {}
  ): Promise<HeldStatsOutcome> {
    const key = options.justRegistered
      ? ownWorkKey(options.justRegistered.site, options.justRegistered.workId)
      : undefined;
    // 前の取り込みが同じ控えを先に移しても数え違えないよう、**並ぶ前に**控えを数える
    const mine = key
      ? this.pending().filter((entry) => ownWorkKey(entry.site, entry.workId) === key)
      : [];
    const run = this.flushQueue.then(async () => {
      const outcome = await this.flushNow(key, options.silent === true);
      if (!key) return outcome;
      const still = new Set(this.pending().map((entry) => entry.envelope));
      return {
        held: mine.length,
        imported: mine.filter((entry) => !still.has(entry.envelope)).length,
      };
    });
    // 失敗しても列は止めない（失敗はこの呼び出しの答えとして返す）
    this.flushQueue = run.catch(() => undefined);
    return run;
  }

  private async flushNow(key: string | undefined, silent: boolean): Promise<HeldStatsOutcome> {
    const none: HeldStatsOutcome = { held: 0, imported: 0 };
    const pending = this.pending();
    if (pending.length === 0 && this.pendingRankings().length === 0) return none;
    const registered = new Set(
      await (this.deps.registeredKeys?.() ?? Promise.resolve(new Set<string>()))
    );
    if (key) registered.add(key);
    // 順位の控えを先に移す（数の控えの取り込みの知らせとは別に、黙って移す。2026-11-02）
    await this.flushHeldRankings(registered);
    const importHeld = this.deps.importHeldStats;
    if (!importHeld || pending.length === 0) return none;
    const { taken } = takeRegisteredPending(pending, (site, workId) =>
      registered.has(ownWorkKey(site, workId))
    );
    if (taken.length === 0) return none;
    let remaining: Set<ReaderStatsEnvelope>;
    try {
      remaining = new Set(
        await importHeld(
          taken.map((entry) => entry.parsed),
          HELD_STATS_LEAD,
          silent ? { silent: true } : {}
        )
      );
    } catch (error) {
      // **控えは消さない**（次に一覧を描き直したときにもう一度試す）
      useLogFile(undefined);
      logFailure("控えた読者の反応の取り込み", {
        作品: describeHeld(taken),
        詳細: `${messageOf(error)}（控えは残しました）`,
      });
      return { held: taken.length, imported: 0 };
    }
    const done = new Set(
      taken.filter((entry) => !remaining.has(entry.parsed)).map((entry) => entry.envelope)
    );
    const left = taken.filter((entry) => !done.has(entry.envelope));
    if (left.length > 0) {
      useLogFile(undefined);
      logFailure("控えた読者の反応の取り込み", {
        作品: describeHeld(left),
        詳細:
          `${left.length}画面が台帳に入りませんでした（取り込み先の作品が1つに決まらない・保存できない）。` +
          "控えは残し、次に作品一覧を描き直したときにもう一度試します。",
      });
    }
    if (done.size > 0) {
      // 取り込みのあいだに控えが増えていてもよいように、読み直してから外す
      const keep = this.pending().filter((entry) => !done.has(entry.envelope));
      await this.savePending(storedPending(keep));
    }
    return { held: taken.length, imported: done.size };
  }

  /** 控えた順位のうち、登録済みの作品の分を取り込む。台帳に入らなかったものは控えに残す */
  private async flushHeldRankings(registered: ReadonlySet<string>): Promise<void> {
    const importHeld = this.deps.importHeldRankings;
    if (!importHeld) return;
    const taken = this.pendingRankings().filter((entry) =>
      registered.has(ownWorkKey(entry.site, entry.workId))
    );
    if (taken.length === 0) return;
    let remaining: Set<ReaderStatsRanking>;
    try {
      remaining = new Set(await importHeld(taken.map((entry) => entry.parsed)));
    } catch (error) {
      // **控えは消さない**（次に一覧を描き直したときにもう一度試す）
      useLogFile(undefined);
      logFailure("控えた順位の取り込み", { 詳細: `${messageOf(error)}（控えは残しました）` });
      return;
    }
    const done = new Set(
      taken.filter((entry) => !remaining.has(entry.parsed)).map((entry) => entry.ranking)
    );
    if (done.size < taken.length) {
      useLogFile(undefined);
      logFailure("控えた順位の取り込み", {
        詳細:
          `${taken.length - done.size}件が台帳に入りませんでした（取り込み先の作品が1つに決まらない・保存できない）。` +
          "控えは残し、次に作品一覧を描き直したときにもう一度試します。",
      });
    }
    if (done.size > 0) {
      const keep = this.pendingRankings().filter((entry) => !done.has(entry.ranking));
      await this.savePendingRankings(storedPendingRankings(keep));
      useLogFile(undefined);
      logStep(`登録した作品へ、登録の前に控えておいた順位（${done.size}件）を移しました。`);
    }
  }

  /** ［この作品を一覧に出さない］ */
  async hide(entry: UnregisteredOwnWork): Promise<void> {
    this.stopWait(entry, "hidden");
    await this.save(hideUnregisteredOwnWork(this.list(), entry.site, entry.workId));
    useLogFile(undefined);
    logStep(
      `未登録の自分の作品「${ownWorkLabel(entry)}」（${postingSiteInfo(entry.site).label} ${entry.workId}）を一覧に出さないことにしました`
    );
  }

  /**
   * ［出さないにした作品を戻す］（見出しの右クリック）。出さないにした作品を並べ、
   * 選んだものの印を外す。何も選ばなければ変えない。
   * @param registered 登録済みの組（戻しても枠に出ないので並べない）
   */
  async restoreHidden(registered: ReadonlySet<string> = new Set()): Promise<void> {
    const hidden = hiddenUnregisteredOwnWorks(this.list(), registered);
    if (hidden.length === 0) {
      void vscode.window.showInformationMessage("出さないにした作品はありません。");
      return;
    }
    const picked = await showQuickPickKeepingFocus(
      hidden.map((entry) => ({
        label: ownWorkLabel(entry),
        description: `${postingSiteInfo(entry.site).label} 作品ID ${entry.workId}`,
        entry,
      })),
      {
        title: "一覧に戻す作品を選ぶ（未登録の自分の作品）",
        placeHolder: "戻す作品に印を付けて Enter",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked || picked.length === 0) return;
    let next: readonly UnregisteredOwnWork[] = this.list();
    for (const { entry } of picked) {
      next = unhideUnregisteredOwnWork(next, entry.site, entry.workId);
    }
    await this.save(next);
    useLogFile(undefined);
    logStep(
      `未登録の自分の作品を一覧に戻しました：${picked.map(({ entry }) => ownWorkLabel(entry)).join(" ／ ")}`
    );
  }

  /**
   * ［バックアップを取る］。サイトのバックアップの画面を開き、届くのを待つ（30分まで）。
   */
  async fetchBackup(entry: UnregisteredOwnWork): Promise<void> {
    useLogFile(undefined);
    if (!(this.deps.canWatch ?? canRunProcesses)()) {
      // メニューからは隠している（ブラウザ版）。ほかの道から呼ばれたときの受け皿
      void vscode.window.showInformationMessage(
        describeProcessesBlocked(FETCH_OWN_WORK_BACKUP_COMMAND)
      );
      return;
    }
    const label = ownWorkLabel(entry);
    let target = backupEntryFor(entry.site, entry.workId, entry.narouBackupId);
    if (target.kind === "needNarouId") {
      const id = await askNarouBackupId(label);
      if (!id) return;
      await this.save(setNarouBackupId(this.list(), entry.site, entry.workId, id));
      entry = { ...entry, narouBackupId: id };
      target = backupEntryFor(entry.site, entry.workId, id);
    }
    if (target.kind === "unsupported") {
      void vscode.window.showWarningMessage(`「${label}」のバックアップの画面を開けません。${target.reason}`);
      return;
    }
    if (target.kind === "needNarouId") return; // 上で入れたので来ない

    // **開く前に待ちを始める**——アルファポリスは開いた瞬間に落ちるので、あとで控えると
    // 届いたファイルを「押す前からあったもの」と取り違える
    const waiting = await this.startWait(entry);
    await (this.deps.openLink ?? defaultOpenLink)(target.url);
    logStep(`未登録の自分の作品「${label}」のバックアップの画面を開きました：${target.url}`);

    const how =
      target.kind === "page"
        ? `${postingSiteInfo(entry.site).label}の作品管理の画面を開きました。${target.hint}バックアップを落としてください。`
        : `${postingSiteInfo(entry.site).label}のバックアップの画面を開きました。`;
    void vscode.window.showInformationMessage(
      `「${label}」：${how}` +
        (waiting
          ? "ダウンロードのフォルダーに届いたら、そのまま取り込んで登録します（30分まで待ちます）。"
          : "落とし終えたら、枠の［ファイルから取り込む］で選んでください。")
    );
  }

  /** ［ファイルから取り込む］（選ぶ画面） */
  async importFromPicker(entry: UnregisteredOwnWork): Promise<void> {
    const picked = await showBackupOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "これを取り込む",
      title: `「${ownWorkLabel(entry)}」のバックアップを選ぶ（ZIP／テキスト）`,
      filters: { "バックアップ（ZIP／テキスト）": [...BACKUP_FILE_EXTENSIONS] },
    });
    if (!picked) return;
    await this.importFromUri(entry, picked);
  }

  /** 枠へ落とされたファイル・選んだファイル・届いたファイル */
  async importFromUri(
    entry: UnregisteredOwnWork,
    uri: vscode.Uri,
    options: { readonly unattended?: boolean } = {}
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      useLogFile(undefined);
      logFailure("未登録の自分の作品：バックアップを読む", {
        ファイル: uri.toString(),
        詳細: messageOf(error),
      });
      void vscode.window.showWarningMessage(`ファイルを読めませんでした：${messageOf(error)}`);
      return;
    }
    await this.importBytes(entry, { fileName: path.basename(uri.path), bytes }, options);
  }

  /** 取り込みの本体（ZIP を読む部品はここで初めて読み込む） */
  async importBytes(
    entry: UnregisteredOwnWork,
    source: { readonly fileName: string; readonly bytes: Uint8Array },
    /** 届いたバックアップを訊かずに取り込むか（`handleArrived` だけが立てる） */
    options: { readonly unattended?: boolean } = {}
  ): Promise<WorkEntry | undefined> {
    const { importOwnWorkBackup } = await import("./ownWorkBackupImport.js");
    const work = await importOwnWorkBackup(
      entry,
      source,
      this.deps.importAsNew,
      options.unattended === true,
      {
        /*
          登録の前に控えておいた読者の反応を、**台帳に作品ID を書いた直後・登録の知らせの前に**
          移す（知らせが「取り込みました」と言えるように。2026-11-01 作者の実機）
        */
        takeHeldStats: () => this.flushHeldStats({ justRegistered: entry, silent: true }),
        library: {
          remembered: this.rememberedUnattendedLibrary(),
          remember: (folderPath) => this.rememberUnattendedLibrary(folderPath),
        },
      }
    );
    if (!work) return undefined;
    // 取り込めたら待ちを止め、覚えを忘れる（台帳に作品ID が入ったので、覚えていても枠は出ない）
    this.stopWait(entry, "imported");
    await this.save(forgetUnregisteredOwnWork(this.list(), entry.site, entry.workId));
    await this.deps.afterImport?.(work);
    // 取り込みの途中で移せなかった分の受け皿（移し終えていれば何もしない。失敗しても登録は済んでいる）
    try {
      await this.flushHeldStats({ justRegistered: entry });
    } catch (error) {
      useLogFile(undefined);
      logFailure("控えた読者の反応の取り込み", { 作品: work.title, 詳細: messageOf(error) });
    }
    return work;
  }

  dispose(): void {
    for (const wait of this.waits.values()) wait.task.dispose();
    this.waits.clear();
    this.changed.dispose();
  }

  /** いま待っている作品を、試験から1回だけ見直す */
  async pollNow(entry: Pick<UnregisteredOwnWork, "site" | "workId">): Promise<void> {
    const wait = this.waits.get(ownWorkKey(entry.site, entry.workId));
    if (wait) await this.poll(wait);
  }

  /**
   * 待ちを始める。**フォルダーが読めなければ待たずに理由を言う**（リンクは開く）。
   * @returns 待ちを始めたか
   */
  private async startWait(entry: UnregisteredOwnWork): Promise<boolean> {
    const key = ownWorkKey(entry.site, entry.workId);
    // 押し直したら、待ちを始め直す（押した時点の名前を控え直す）
    this.waits.get(key)?.task.dispose();
    this.waits.delete(key);

    let folder = "";
    try {
      folder = await (this.deps.downloadFolder ?? defaultDownloadFolder)();
      const lister = await (this.deps.lister ?? defaultLister)(folder);
      const watch = new BackupArrivalWatch({
        target: entry,
        lister,
        ...(this.deps.now ? { now: this.deps.now } : {}),
        limitMs: this.deps.limitMs ?? BACKUP_WAIT_LIMIT_MS,
      });
      await watch.start();
      const wait: ActiveWait = {
        entry,
        folder,
        watch,
        polling: false,
        task: (this.deps.schedule ?? defaultSchedule)(
          () => void this.poll(wait),
          BACKUP_POLL_INTERVAL_MS
        ),
      };
      this.waits.set(key, wait);
      this.changed.fire();
      logStep(`「${ownWorkLabel(entry)}」のバックアップを待ちます（見る場所：${folder}）`);
      return true;
    } catch (error) {
      logFailure("ダウンロードのフォルダーを読む", { 場所: folder, 詳細: messageOf(error) });
      void vscode.window.showWarningMessage(
        `ダウンロードのフォルダー（${folder || "既定の場所"}）を読めなかったため、届いたことに気づけません。` +
          `設定「novelai.${DOWNLOAD_FOLDER_SETTING}」で見る場所を替えられます（${messageOf(error)}）。`
      );
      return false;
    }
  }

  private async poll(wait: ActiveWait): Promise<void> {
    if (wait.polling) return;
    wait.polling = true;
    try {
      const step = await wait.watch.poll();
      if (step.kind === "expired") {
        this.stopWait(wait.entry, "expired");
        void vscode.window.showInformationMessage(
          `「${ownWorkLabel(wait.entry)}」のバックアップを30分待ちましたが、届きませんでした。` +
            "落とし終えていれば、枠の［ファイルから取り込む］で選べます。"
        );
        return;
      }
      if (step.kind === "arrived") {
        // **ここでは取り込みを待たない**（見張りの印を立てたまま待つと、次の刻みが止まる）
        void this.handleArrived(wait, step.names).catch((error: unknown) => {
          useLogFile(undefined);
          logFailure("届いたバックアップの取り込み", {
            作品: ownWorkLabel(wait.entry),
            詳細: messageOf(error),
          });
          void vscode.window.showWarningMessage(
            `「${ownWorkLabel(wait.entry)}」のバックアップを取り込めませんでした：${messageOf(error)}`
          );
        });
      }
    } catch (error) {
      // フォルダーが一時的に読めないだけかもしれない。止めずに次の刻みで見直す（30分で止まる）
      useLogFile(undefined);
      logFailure("ダウンロードのフォルダーを見直す", { 場所: wait.folder, 詳細: messageOf(error) });
    } finally {
      wait.polling = false;
    }
  }

  /**
   * 届いたファイルを扱う（作者の判断 2026-11-01「届いたバックアップは訊かずに取り込む」）。
   *
   * 訊かずに取り込むのは、迷う所が無いときだけ：
   * - **一度に2つ以上届いた** → どれがこの作品のものか決まらないので、1つずつ訊く
   * - **名前がほかの枠の作品にも当たる**（本編と「〜別視点〜」など、題の頭が同じ） → 訊く
   * - **同じ作品がもう登録されている** → 取り込まずに理由を言い、待ちを止める
   * - **同じ作品をいま取り込んでいる**（続けて落とした） → 2つ目は訊く
   * - 読めない・中身が枠の作品と食い違う → 取り込みの側が理由を言う・訊く（今までどおり）
   *
   * 落としたファイルは消さない・動かさない（読むだけ）。
   */
  private async handleArrived(wait: ActiveWait, names: readonly string[]): Promise<void> {
    if (names.length !== 1) {
      for (const name of names) this.askArrived(wait, name, "several");
      return;
    }
    const name = names[0];
    const key = ownWorkKey(wait.entry.site, wait.entry.workId);
    const others = this.list().filter(
      (entry) =>
        !entry.hidden &&
        ownWorkKey(entry.site, entry.workId) !== key &&
        looksLikeBackupOf(name, entry)
    );
    if (others.length > 0) {
      this.askArrived(wait, name, "ambiguous", others);
      return;
    }
    const registered = await (this.deps.registeredKeys?.() ?? Promise.resolve(new Set<string>()));
    if (isRegisteredOwnWork(wait.entry, registered)) {
      const label = ownWorkLabel(wait.entry);
      this.stopWait(wait.entry, "imported");
      useLogFile(undefined);
      logStep(`「${label}」はもう登録してあるため、届いたバックアップ（${name}）は取り込みませんでした`);
      void vscode.window.showInformationMessage(
        `「${label}」はもう登録してある作品なので、届いたバックアップ（${name}）は取り込みませんでした。` +
          "ファイルはダウンロードのフォルダーにそのまま残っています。"
      );
      return;
    }
    if (this.importing.has(key)) {
      this.askArrived(wait, name, "again");
      return;
    }
    this.importing.add(key);
    try {
      useLogFile(undefined);
      logStep(`「${ownWorkLabel(wait.entry)}」のバックアップが届いたので、訊かずに取り込みます：${name}`);
      await this.importFromUri(this.current(wait.entry), path.toUri(path.join(wait.folder, name)), {
        unattended: true,
      });
    } finally {
      this.importing.delete(key);
    }
  }

  /** 覚えのいまの形（押されるまでに覚えが変わっていても、その作品で取り込む） */
  private current(entry: UnregisteredOwnWork): UnregisteredOwnWork {
    const key = ownWorkKey(entry.site, entry.workId);
    return this.list().find((known) => ownWorkKey(known.site, known.workId) === key) ?? entry;
  }

  /**
   * 訊かずには取り込めないとき、届いたことを知らせて訊く。**答えは待たない**
   * （押されたら後から取り込む）。なぜ訊くのかを1文で添える
   */
  private askArrived(
    wait: ActiveWait,
    name: string,
    why: "several" | "ambiguous" | "again",
    others: readonly UnregisteredOwnWork[] = []
  ): void {
    const label = ownWorkLabel(wait.entry);
    useLogFile(undefined);
    logStep(`「${label}」のバックアップらしいファイルが届きました：${name}`);
    const reason =
      why === "several"
        ? "一度に複数のファイルが届いたため、どれを取り込むかお訊きします。"
        : why === "ambiguous"
          ? `名前が「${others.map((entry) => ownWorkLabel(entry)).join("」「")}」にも当たるため、どの作品のものか決められませんでした。`
          : "同じ作品のファイルを取り込んでいる最中に、もう1つ届きました。";
    whenNoticePicked(
      vscode.window.showInformationMessage(
        `「${label}」のバックアップらしいファイル（${name}）が届きました。${reason}「${label}」として取り込みますか？`,
        IMPORT_ARRIVED_LABEL,
        SKIP_ARRIVED_LABEL
      ),
      async (answer) => {
        if (answer !== IMPORT_ARRIVED_LABEL) return;
        // 押されるまでに覚えが変わっていても（出さないにした等）、押した枠の作品で取り込む
        await this.importFromUri(this.current(wait.entry), path.toUri(path.join(wait.folder, name)));
      },
      { label: "未登録の自分の作品のバックアップの取り込み" }
    );
  }

  private stopWait(
    entry: Pick<UnregisteredOwnWork, "site" | "workId">,
    why: "imported" | "expired" | "hidden"
  ): void {
    const key = ownWorkKey(entry.site, entry.workId);
    const wait = this.waits.get(key);
    if (!wait) return;
    wait.task.dispose();
    this.waits.delete(key);
    this.changed.fire();
    const reason = why === "imported" ? "取り込んだ" : why === "expired" ? "30分たった" : "一覧に出さないことにした";
    logStep(`「${ownWorkLabel(wait.entry)}」のバックアップの待ちを止めました（${reason}ため）`);
  }

  /** 書く口はここだけ（`mementoWrites.test.ts`） */
  private async save(next: readonly UnregisteredOwnWork[]): Promise<void> {
    await this.memory.update(UNREGISTERED_OWN_WORKS_KEY, next);
    this.changed.fire();
  }

  private pending() {
    return readPendingOwnWorkStats(
      this.memory.get<unknown>(PENDING_OWN_WORK_STATS_KEY, []),
      this.clock()
    );
  }

  private pendingRankings() {
    return readPendingOwnWorkRankings(
      this.memory.get<unknown>(PENDING_OWN_WORK_RANKINGS_KEY, []),
      this.clock()
    );
  }

  /** 順位の控えの書く口はここだけ（`mementoWrites.test.ts`）。枠の見た目は変わらないので描き直さない */
  private async savePendingRankings(next: readonly PendingOwnWorkRanking[]): Promise<void> {
    await this.memory.update(PENDING_OWN_WORK_RANKINGS_KEY, next);
  }

  /** 控えの書く口はここだけ（`mementoWrites.test.ts`）。枠の見た目は変わらないので描き直さない */
  private async savePending(next: readonly PendingOwnWorkStats[]): Promise<void> {
    await this.memory.update(PENDING_OWN_WORK_STATS_KEY, next);
  }

  /** 訊かずに取り込む流れで、前回選んだ書庫（無ければ undefined） */
  private rememberedUnattendedLibrary(): string | undefined {
    const value = this.memory.get<unknown>(UNATTENDED_LIBRARY_KEY, undefined);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  }

  /** 書庫の覚えの書く口はここだけ（`mementoWrites.test.ts`）。覚えられなくても取り込みは止めない */
  private async rememberUnattendedLibrary(folderPath: string): Promise<void> {
    try {
      await this.memory.update(UNATTENDED_LIBRARY_KEY, folderPath);
    } catch (error) {
      useLogFile(undefined);
      logFailure("訊かずに取り込むときの書庫を覚える", { 場所: folderPath, 詳細: messageOf(error) });
    }
  }

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/**
 * 作品一覧の枠へファイルを落として取り込む（作者の指示 2026-11-01「ドラッグして落とす道も」）。
 *
 * **枠の上に落としたときだけ受ける。** 作品の行・話の行・見出しへ落としても何もしない
 * （作品の行へのバックアップは相談パネルの受け口が受け持つ。設計書6.99.7）。
 * エクスプローラーからは `text/uri-list`、OS からはファイルそのもので届く。
 * 2つ以上落とされたら、最初の1つだけを取り込む（1枠に1作品）
 */
export function ownWorkDropController(
  service: UnregisteredOwnWorks
): vscode.TreeDragAndDropController<TreeNode> {
  return {
    dragMimeTypes: [],
    dropMimeTypes: ["files", "text/uri-list"],
    async handleDrop(target, dataTransfer) {
      if (!target || target.type !== "ownWorkFrame") return;
      const entry = target.entry;
      for (const [, item] of dataTransfer) {
        const file = item.asFile();
        if (!file) continue;
        if (file.uri) {
          await service.importFromUri(entry, file.uri);
        } else {
          await service.importBytes(entry, { fileName: file.name, bytes: await file.data() });
        }
        return;
      }
      const uriList = await dataTransfer.get("text/uri-list")?.asString();
      const first = (uriList ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("#"));
      if (first) await service.importFromUri(entry, vscode.Uri.parse(first));
    },
  };
}

/** ［バックアップを取る］のコマンド（ブラウザ版の断りの文言を引くため） */
export const FETCH_OWN_WORK_BACKUP_COMMAND = "novelai.fetchOwnWorkBackup";

/**
 * なろうのバックアップの画面の番号を入れてもらう。**なろうのサイトは機械で読まない**ので、
 * 作者のブラウザのアドレス欄から写してもらう
 */
async function askNarouBackupId(label: string): Promise<string | undefined> {
  const input = await askText({
    title: `「${label}」の小説家になろうのバックアップの画面の番号`,
    // 例に出すのは確かめてあるバックアップの画面のアドレスだけ（2026-11-01 作者の Chrome で確認）
    prompt:
      "なろうのこの作品のバックアップの画面のアドレス" +
      "（https://syosetu.com/backup/top/ncode/〈数字〉/）にある数字を入れてください" +
      "（例：https://syosetu.com/backup/top/ncode/1702430/ なら 1702430）。" +
      "Nコード（n1234ab）とは別の番号です。アドレスをそのまま貼っても読み取ります。" +
      "一度入れると覚えておきます。",
    placeHolder: "1702430",
    validateInput: (value) =>
      value.trim() === "" || narouBackupIdFrom(value)
        ? undefined
        : "数字だけか、バックアップの画面のアドレス（https://syosetu.com/backup/top/ncode/〈数字〉/）を入れてください。Nコードは使えません。",
  });
  return narouBackupIdFrom(input);
}

/** 記録に出す、控えの作品の名前（題・サイト・作品ID。同じ作品は1つにまとめる） */
function describeHeld(
  entries: readonly { readonly site: string; readonly workId: string; readonly parsed: ReaderStatsEnvelope }[]
): string {
  const labels = entries.map(
    (entry) => `${ownWorkLabel({ title: entry.parsed.title, workId: entry.workId })}（${entry.site} ${entry.workId}）`
  );
  return [...new Set(labels)].join(" ／ ");
}

async function defaultOpenLink(url: string): Promise<void> {
  // Chrome でなければ初回だけ案内してから開く（ヘルパーの働くブラウザで開くため）
  await openSiteLink(url);
}

async function defaultDownloadFolder(): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration("novelai")
    .get<string>(DOWNLOAD_FOLDER_SETTING, "")
    .trim();
  if (configured) return configured;
  const { defaultDownloadFolder: folder } = await import("../core/downloadFolderNode.js");
  return folder();
}

async function defaultLister(folder: string): Promise<DownloadFolderLister> {
  const { downloadFolderLister } = await import("../core/downloadFolderNode.js");
  return downloadFolderLister(folder);
}

function defaultSchedule(tick: () => void, intervalMs: number): ScheduledTask {
  const timer = setInterval(tick, intervalMs);
  return { dispose: () => clearInterval(timer) };
}
