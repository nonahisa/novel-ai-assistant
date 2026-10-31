import * as vscode from "vscode";
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
import type { ReaderStatsEnvelope } from "../core/readerStatsEnvelope";
import { canRunProcesses } from "../core/runtime";
import {
  backupEntryFor,
  hideUnregisteredOwnWork,
  narouBackupIdFrom,
  noteUnregisteredOwnWorks,
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
 */

/**
 * 覚えの置き場（`context.globalState` の鍵）。書く口は `save` の1か所だけ
 * （`mementoWrites.test.ts`）
 */
export const UNREGISTERED_OWN_WORKS_KEY = "novelai.ownWorks.unregistered";

/** 設定の名前（`novelai.` の下）。空なら Windows の「ダウンロード」 */
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
  /** 見る場所（既定は設定、空なら Windows の「ダウンロード」） */
  downloadFolder?(): Promise<string>;
  /** その場所を見る口（既定は `core/downloadFolderNode.ts` を動的 import） */
  lister?(folder: string): Promise<DownloadFolderLister>;
  /** 刻み（既定は `setInterval`） */
  schedule?(tick: () => void, intervalMs: number): ScheduledTask;
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
          ? "ダウンロードのフォルダーに届いたら、取り込むかお訊きします（30分まで待ちます）。"
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
  async importFromUri(entry: UnregisteredOwnWork, uri: vscode.Uri): Promise<void> {
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
    await this.importBytes(entry, { fileName: path.basename(uri.path), bytes });
  }

  /** 取り込みの本体（ZIP を読む部品はここで初めて読み込む） */
  async importBytes(
    entry: UnregisteredOwnWork,
    source: { readonly fileName: string; readonly bytes: Uint8Array }
  ): Promise<WorkEntry | undefined> {
    const { importOwnWorkBackup } = await import("./ownWorkBackupImport.js");
    const work = await importOwnWorkBackup(entry, source, this.deps.importAsNew);
    if (!work) return undefined;
    // 取り込めたら待ちを止め、覚えを忘れる（台帳に作品ID が入ったので、覚えていても枠は出ない）
    this.stopWait(entry, "imported");
    await this.save(forgetUnregisteredOwnWork(this.list(), entry.site, entry.workId));
    await this.deps.afterImport?.(work);
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
        for (const name of step.names) this.askArrived(wait, name);
      }
    } catch (error) {
      // フォルダーが一時的に読めないだけかもしれない。止めずに次の刻みで見直す（30分で止まる）
      useLogFile(undefined);
      logFailure("ダウンロードのフォルダーを見直す", { 場所: wait.folder, 詳細: messageOf(error) });
    } finally {
      wait.polling = false;
    }
  }

  /** 届いたことを知らせて訊く。**答えは待たない**（押されたら後から取り込む） */
  private askArrived(wait: ActiveWait, name: string): void {
    const label = ownWorkLabel(wait.entry);
    useLogFile(undefined);
    logStep(`「${label}」のバックアップらしいファイルが届きました：${name}`);
    whenNoticePicked(
      vscode.window.showInformationMessage(
        `「${label}」のバックアップ（${name}）が届きました。取り込みますか？`,
        IMPORT_ARRIVED_LABEL,
        SKIP_ARRIVED_LABEL
      ),
      async (answer) => {
        if (answer !== IMPORT_ARRIVED_LABEL) return;
        // 押されるまでに覚えが変わっていても（出さないにした等）、押した枠の作品で取り込む
        const current =
          this.list().find(
            (entry) =>
              ownWorkKey(entry.site, entry.workId) === ownWorkKey(wait.entry.site, wait.entry.workId)
          ) ?? wait.entry;
        await this.importFromUri(current, path.toUri(path.join(wait.folder, name)));
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
    prompt:
      "なろうにログインして、この作品の管理の画面（作品の編集など）を開いたときの" +
      "アドレスにある「/ncode/」の後ろの数字を入れてください（例：1702430）。" +
      "Nコード（n1234ab）とは別の番号です。アドレスをそのまま貼っても読み取ります。" +
      "一度入れると覚えておきます。",
    placeHolder: "1702430",
    validateInput: (value) =>
      value.trim() === "" || narouBackupIdFrom(value)
        ? undefined
        : "数字だけか、なろうのアドレス（…/ncode/〈数字〉/）を入れてください。Nコードは使えません。",
  });
  return narouBackupIdFrom(input);
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
