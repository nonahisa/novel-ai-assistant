import { beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import { SettingsPanel } from "../../src/features/settingsPanel";

/**
 * 右クリック→設定資料の1件を出す（作者の報告、2026-08-28）。
 *
 * 「用語ハイライト上を右クリックした場合で、すでに設定資料パネルが
 * 開いている場合は、該当項目の設定資料を表示してください」。
 *
 * 経路そのものは繋がっていた。落ちていたのは `showRecord` の中で、
 * **開きっぱなしのパネルが持っている資料が古い**と `find` が外れ、
 * そこで黙って戻っていた（`openSettingsPanel` は既に開いていれば
 * `reveal` するだけで読み直さない）。
 *
 * 用語ハイライトはディスクの資料から引いているので、**画面のほうが
 * 古いと疑って一度だけ読み直す。** それでも無ければ、黙って終わらずに
 * 作者へ伝える——押しても何も起きないと、壊れているようにしか見えない。
 */

const notified: string[] = [];

// 共通の代役（test/unit/support/vscodeStub.ts）には知らせの口が無い。
// **ファイルごとに読み込み直されるので、ここで足しても他へは漏れない**
(
  vscode.window as unknown as {
    showInformationMessage: (message: string) => Promise<undefined>;
  }
).showInformationMessage = (message: string) => {
  notified.push(message);
  return Promise.resolve(undefined);
};

interface PanelInnards {
  detailOf(kind: string, id: string): unknown;
  refreshFromDisk(): Promise<void>;
  post(message: unknown): void;
  /** 記録（logStep）に作品名を出すので、代役にも持たせる */
  work: { id: string; title: string };
  /** 画面が動き出したか（`whenReady` が見ている） */
  ready: boolean;
  readyWaiters: Array<() => void>;
  markReady(): void;
}

/**
 * 資料の読み込みと画面を差し替えた `SettingsPanel`。
 *
 * **ここで見たいのは「見つからなかったときの段取り」だけ**なので、
 * ファイルの読み込み（ストア7つ）とWebViewは作らない。
 */
interface FocusMessage {
  type: string;
  kind?: string;
  id?: string;
  collapseList?: boolean;
}

function panelWith(options: {
  foundAfterReload: boolean;
  /** 画面がまだ動き出していない場面（開いたその場で用語から呼ばれたとき） */
  ready?: boolean;
}) {
  const posted: FocusMessage[] = [];
  let reloads = 0;
  let present = false;

  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "灯の塔" };
  inner.ready = options.ready !== false;
  inner.readyWaiters = [];
  inner.detailOf = (kind: string, id: string) =>
    present ? { kind, id, name: "灯" } : undefined;
  inner.refreshFromDisk = async () => {
    reloads++;
    if (options.foundAfterReload) present = true;
  };
  inner.post = (message: unknown) => {
    posted.push(message as FocusMessage);
  };

  return { panel, inner, posted, reloads: () => reloads };
}

beforeEach(() => {
  notified.length = 0;
});

describe("開いているパネルへ、その1件を出す", () => {
  test("画面の資料が古ければ、読み直して出す", async () => {
    const { panel, posted, reloads } = panelWith({ foundAfterReload: true });

    await panel.showRecord("character", "c-akari");

    expect(reloads()).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "focus",
      kind: "character",
      id: "c-akari",
    });
  });

  test("読み直しても無ければ、黙って終わらずに伝える", async () => {
    const { panel, posted, reloads } = panelWith({ foundAfterReload: false });

    await panel.showRecord("character", "c-missing");

    // **読み直しは1回だけ。** 何度も読むと、押すたびに資料を全部読み返す
    expect(reloads()).toBe(1);
    expect(posted).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("設定資料に見つかりませんでした");
  });

  /** 画面が持っていれば、読み直さない（毎回7つのストアを読まない） */
  test("すでに持っていれば、読み直さずに出す", async () => {
    const { panel, inner, posted, reloads } = panelWith({
      foundAfterReload: false,
    });
    // 1回目から見つかる状態にする
    inner.detailOf = (kind: string, id: string) => ({ kind, id, name: "灯" });

    await panel.showRecord("character", "c-akari");

    expect(reloads()).toBe(0);
    expect(posted).toHaveLength(1);
    expect(notified).toEqual([]);
  });

  /**
   * **開いたばかりの画面へ送っても捨てられる**（スクリプトがまだ走っていない）。
   * 用語から開くときは、パネルもその場で作られていることがある。
   */
  test("画面が動き出すまで待ってから出す", async () => {
    const { panel, inner, posted } = panelWith({
      foundAfterReload: true,
      ready: false,
    });

    const done = panel.showRecord("character", "c-akari");
    // 資料の読み直し（await）を1周ぶん進めても、まだ送っていない
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([]);

    inner.markReady();
    await done;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "focus", id: "c-akari" });
  });

  /**
   * **開きっぱなしのパネルは、待たずにその場で送る**（作者の報告、
   * 2026-08-28「用語上で右クリックしたとき、パネルの説明は
   * 切り替わりません」の調べもの）。
   *
   * `ready` は開いたときの一度きりしか来ない。**受け取った印を持たずに
   * 毎回待つと、二度目からは制限時間ぶん（5秒）遅れる**——押しても
   * すぐには変わらない画面になる。ここは印を持っているので即座に通る。
   *
   * 時計を偽物にしておくと、もし待ちに入っていれば**永久に解決しない**
   * （進める側が誰もいない）ので、待ったかどうかがはっきり分かる。
   */
  test("ready 済みのパネルなら、待たずにその場で送る", async () => {
    const { panel, inner, posted } = panelWith({ foundAfterReload: false });
    inner.detailOf = (kind: string, id: string) => ({ kind, id, name: "灯" });

    vi.useFakeTimers();
    try {
      await panel.showRecord("character", "c-akari", { collapseList: true });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        type: "focus",
        kind: "character",
        id: "c-akari",
        collapseList: true,
      });
      // 待ち行列にも積まれていない（＝待たずに解決した）
      expect(inner.readyWaiters).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 本文の用語から開いたときは、一覧を畳んで出す（作者の依頼、2026-08-28
 * 「本文から用語を右側に出す際は、デフォルトで一覧を出さない状態に
 * してください」）。
 *
 * **メニューなど他の入口では畳まない。** そちらは一覧から選ぶための画面で、
 * 畳むと何も選べなくなる。
 */
describe("用語から開いたときは、一覧を畳む", () => {
  test("用語から開いたら、畳む印を付ける", async () => {
    const { panel, inner, posted } = panelWith({ foundAfterReload: false });
    inner.detailOf = (kind: string, id: string) => ({ kind, id, name: "灯" });

    await panel.showRecord("character", "c-akari", { collapseList: true });

    expect(posted[0]).toMatchObject({ type: "focus", collapseList: true });
  });

  test("それ以外の入口では、印を付けない", async () => {
    const { panel, inner, posted } = panelWith({ foundAfterReload: false });
    inner.detailOf = (kind: string, id: string) => ({ kind, id, name: "灯" });

    await panel.showRecord("character", "c-akari");

    expect(posted[0]).toMatchObject({ type: "focus" });
    expect(posted[0].collapseList).toBeUndefined();
  });
});
