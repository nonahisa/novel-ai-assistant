import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { NAROU_API_CONSENT_KEY } from "../../../src/core/narouApiGate";
import { NAROU_GUIDELINE_URL } from "../../../src/core/narouApi";
import { setVerifiedStateReporter, verifiedState } from "../../../src/core/verifiedMemento";
import {
  openWritingStatsPanel,
  refreshWritingStatsAfterRepair,
} from "../../../src/features/writingStatsPanel";

/**
 * なろうAPIの同意のチェックが、描き直しで外れる弱さ（0.141.1。画面テストの担当の見立て）。
 *
 * VS Code の保管庫は、遅れて届いた古い塊で書いたばかりの鍵が一時消えることがある
 * （`core/verifiedMemento.ts` の頭）。同意を書いて確かめたあと、統計を組み直すまでの長い
 * 待ちの間にそれが起きると、読み直した「同意なし」で描き直してチェックが外れる。
 *
 * 偽の保管庫は「書いた直後の確かめの読みでは新しい値、そのあと古い値へ戻る」形にする
 * （書いた直後に古い値を返すと、確かめの書き直しが走って再現しない）。
 */

let work: WorkEntry = {
  id: "work_narou_agree_0",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "narou-agree"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;
const disk = new Map<string, Uint8Array>();

/** 同意の鍵だけ、確かめの読みのあとで古い値へ巻き戻る保管庫 */
class StaleChunkMemento {
  private readonly values = new Map<string, unknown>();
  /** 次の同意の書き込みのあと、確かめの読み1回だけ新しい値を返し、その後は書く前の値へ戻す */
  revertNextConsentWrite = false;
  private pendingRevert: { before: unknown; reads: number } | undefined;

  get(key: string, defaultValue?: unknown): unknown {
    if (key === NAROU_API_CONSENT_KEY && this.pendingRevert) {
      this.pendingRevert.reads++;
      if (this.pendingRevert.reads > 1) {
        // 遅れて届いた古い塊で、手元の値が書く前へ戻った
        this.values.set(key, this.pendingRevert.before);
        this.pendingRevert = undefined;
      }
    }
    return this.values.has(key) ? this.values.get(key) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (key === NAROU_API_CONSENT_KEY && this.revertNextConsentWrite) {
      this.revertNextConsentWrite = false;
      this.pendingRevert = { before: this.values.get(key), reads: 0 };
    }
    this.values.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

interface Posted {
  type: string;
  data?: { narouApi?: { agreed?: boolean } | null };
}

function stubPanel(): { posted: Posted[]; send: (message: unknown) => Promise<void> } {
  const posted: Posted[] = [];
  let listener: ((message: unknown) => Promise<void>) | undefined;
  Object.assign(window, {
    createWebviewPanel: () => ({
      webview: {
        html: "",
        cspSource: "vscode-webview:",
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          listener = handler;
          return { dispose: () => undefined };
        },
        postMessage: (message: Posted) => {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
      visible: false,
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    }),
  });
  return {
    posted,
    send: async (message) => {
      if (!listener) throw new Error("パネルが受け口をつないでいません");
      await listener(message);
    },
  };
}

function lastAgreed(posted: Posted[]): boolean | undefined {
  const stats = posted.filter((message) => message.type === "stats");
  return stats[stats.length - 1]?.data?.narouApi?.agreed;
}

let inner: StaleChunkMemento;
let repairs: Array<() => void>;

let nextWork = 0;

beforeEach(() => {
  // 作品ごとに1枚しか開かない仕組みがあるので、試験ごとに別の作品にする（台帳の場所は同じ）
  nextWork += 1;
  work = { ...work, id: `work_narou_agree_${nextWork}` };
  disk.clear();
  disk.set(
    ledgerPath,
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "1",
        sites: [{ site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/123/" }],
        siteProfiles: [{ site: "narou", workId: "n1234ab" }],
        posts: [],
      })
    )
  );
  workspace.textDocuments = [];
  workspace.fs = memoryFs(disk, {
    methods: ["createDirectory", "readFile", "writeFile", "stat", "readDirectory"],
  });
  inner = new StaleChunkMemento();
  // ガイドラインは開いてある（開く前は同意できない決まり）
  void inner.update(NAROU_API_CONSENT_KEY, {
    guidelineUrl: NAROU_GUIDELINE_URL,
    openedAt: "2026-11-07T00:00:00.000Z",
  });
  /*
    見張り（遅れて消えた値の当て直し）は、試験の中で時機を決めて走らせる。
    待ちを溜めておき、試験が呼んだときに進める
  */
  repairs = [];
  verifiedState(inner, {
    lateCheckDelays: [100],
    wait: () => new Promise<void>((resolve) => repairs.push(resolve)),
  });
});

afterEach(() => {
  setVerifiedStateReporter({});
});

async function openPanel() {
  const panel = stubPanel();
  const context = { subscriptions: [] as unknown[], globalState: inner };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await openWritingStatsPanel(context as any, work, "pc-1");
  return panel;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("なろうAPIの同意のチェック", () => {
  test("同意を書いた直後に古い値が届いても、描き直しで同意が外れない", async () => {
    const panel = await openPanel();
    inner.revertNextConsentWrite = true;
    await panel.send({ type: "narouAgree", checked: true });
    expect(lastAgreed(panel.posted), "確かめ済みの同意を捨て、読み直した古い値で描き直しました").toBe(true);
  });

  test("遅れて消えた同意を当て直したら、開いている統計を描き直す（同意ありで）", async () => {
    // 製品では extension.ts が当て直しの知らせを統計へ流す。同じつなぎ方をする
    setVerifiedStateReporter({ onRepaired: (key) => void refreshWritingStatsAfterRepair(key) });
    const panel = await openPanel();
    inner.revertNextConsentWrite = true;
    await panel.send({ type: "narouAgree", checked: true });
    const before = panel.posted.filter((message) => message.type === "stats").length;
    // 見張りを進める：古い値に戻っているので当て直し、知らせが鳴る
    for (const resolve of repairs.splice(0)) resolve();
    await settle();
    const stats = panel.posted.filter((message) => message.type === "stats");
    expect(stats.length, "当て直しのあと、統計を描き直していません").toBeGreaterThan(before);
    expect(lastAgreed(panel.posted)).toBe(true);
  });
});
