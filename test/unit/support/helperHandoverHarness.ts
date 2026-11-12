import * as path from "path";
import { beforeAll, beforeEach } from "vitest";
import {
  ReaderStatsHelperLink,
  type FingerprintMemory,
} from "../../../src/features/readerStatsHelperLink";
import {
  emptyPostingLedger,
  readPostingLedger,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { memoryFs } from "./memoryDisk";
import { env, Uri, window, workspace } from "./vscodeStub";

/**
 * ヘルパーが渡す束を、**本物の受け口**（`ReaderStatsHelperLink.handleUri`）から取り込んで、
 * ディスクの台帳を読み直す試験の土台。クリップボードへ束を置き、合図（`/import-reader-stats`）を渡す
 * ところまで、製品と同じ道を通る。知らせは `informed`（情報）と `warned`（注意・失敗）に集める。
 *
 * `readerStatsBundle.test.ts` の前準備と同じ作りだが、あちらは書き込みの失敗を差し込む別の道を
 * 持つので写しとして分けてある（こちらは台帳を読み直すだけ）。
 */

class MemoryStub implements FingerprintMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

export function workEntry(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: path.join("C:", "novels", id),
    registeredAt: "2026-10-31T00:00:00.000Z",
  };
}

export function onKakuyomu(workId: string): PostingLedger {
  return withSiteProfile(
    withSites(emptyPostingLedger(), [
      { site: "kakuyomu", newEpisodeUrl: `https://kakuyomu.jp/my/works/${workId}/episodes/new` },
    ]),
    "kakuyomu",
    { workId }
  );
}

export function onNarou(workId: string): PostingLedger {
  return withSiteProfile(
    withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/" },
    ]),
    "narou",
    { workId }
  );
}

export interface HandoverHarness {
  readonly informed: string[];
  readonly warned: string[];
  /** 作品を登録し、台帳をディスクへ置く */
  addWork(entry: WorkEntry, ledger: PostingLedger): void;
  /** ディスクの台帳（製品の読み込みを通す） */
  ledgerOf(entry: WorkEntry): PostingLedger;
  /** ディスクの台帳の生の中身（書き換わっていないことの確認に使う） */
  rawLedgerOf(entry: WorkEntry): string | undefined;
  rowsOf(entry: WorkEntry): ReaderStatsRecord[];
  /** 束（文字列）をクリップボードへ置き、ヘルパーと同じ合図で渡す */
  handOver(bundle: string): Promise<void>;
  /** 取り込みのあとに更新された作品の ID（作品の絵や一覧を作り直す合図） */
  readonly refreshed: string[];
}

/** `beforeEach` を登録して、台を返す（describe の外・中のどちらでも呼べる） */
export function setupHandoverHarness(): HandoverHarness {
  const disk = new Map<string, Uint8Array>();
  const informed: string[] = [];
  const warned: string[] = [];
  const refreshed: string[] = [];
  const works: WorkEntry[] = [];
  let memory = new MemoryStub();

  const ledgerPath = (entry: WorkEntry): string =>
    Uri.file(path.join(entry.folderPath, "設定", "投稿状態.json")).fsPath;

  beforeAll(() => {
    Object.assign(window, {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    });
  });

  beforeEach(() => {
    disk.clear();
    informed.length = 0;
    warned.length = 0;
    refreshed.length = 0;
    works.length = 0;
    memory = new MemoryStub();
    env.clipboard.text = "";
    env.clipboard.readText = async () => env.clipboard.text;
    workspace.textDocuments = [];
    workspace.getConfiguration = (() => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    })) as typeof workspace.getConfiguration;
    workspace.fs = memoryFs(disk);
    Object.assign(window, {
      // 束の取り込みは作品を選ばせない。選ばせる道に入ったら落とす
      showQuickPick: async () => {
        throw new Error("束の取り込みでは、作品を選ばせない");
      },
      showInputBox: async () => undefined,
      showInformationMessage: async (message: string) => {
        informed.push(message);
        return undefined;
      },
      showWarningMessage: async (message: string) => {
        warned.push(message);
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        warned.push(message);
        return undefined;
      },
    });
  });

  const link = (): ReaderStatsHelperLink =>
    new ReaderStatsHelperLink({
      listWorks: () => works,
      memory,
      afterImport: async (entry) => {
        refreshed.push(entry.id);
      },
    });

  return {
    informed,
    warned,
    refreshed,
    addWork(entry, ledger) {
      works.push(entry);
      disk.set(ledgerPath(entry), new TextEncoder().encode(`${JSON.stringify(ledger, null, 2)}\n`));
    },
    ledgerOf(entry) {
      const bytes = disk.get(ledgerPath(entry));
      if (!bytes) return emptyPostingLedger();
      return readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger;
    },
    rawLedgerOf(entry) {
      const bytes = disk.get(ledgerPath(entry));
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    },
    rowsOf(entry) {
      const bytes = disk.get(ledgerPath(entry));
      if (!bytes) return [];
      return readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger.readerStats ?? [];
    },
    async handOver(bundle) {
      env.clipboard.text = bundle;
      await link().handleUri({ path: "/import-reader-stats" });
    },
  };
}
