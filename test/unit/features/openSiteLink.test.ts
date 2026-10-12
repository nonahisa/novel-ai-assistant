import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ABOUT_HELPER_LABEL,
  initSiteLinkGuide,
  openSiteLink,
  SITE_LINK_GUIDE_SHOWN_KEY,
  USE_CHROME_LABEL,
} from "../../../src/features/openSiteLink";
import { HELPER_DOWNLOAD_URL } from "../../../src/core/postingEnvelope";
import { env, window, workspace } from "../support/vscodeStub";

/**
 * 投稿サイトのリンクを開く口（作者の依頼 2026-10-12）。
 * Chrome でないと分かったときだけ初回に案内し、どれを押してもリンクは開く。
 */

const KAKUYOMU = "https://kakuyomu.jp/my/works/1/episodes/new";

class MemoryStub {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

const original = {
  getConfiguration: workspace.getConfiguration,
  showInformationMessage: window.showInformationMessage,
};

let memory: MemoryStub;
let setting: string | undefined;
let written: { key: string; value: unknown; target: unknown }[];
let guides: string[];
let answer: string | undefined;
let progIdReads: number;

function init(progId: string | undefined): void {
  initSiteLinkGuide(memory, {
    readProgId: async () => {
      progIdReads += 1;
      return progId;
    },
  });
}

beforeEach(() => {
  memory = new MemoryStub();
  setting = undefined;
  written = [];
  guides = [];
  answer = undefined;
  progIdReads = 0;
  env.opened.length = 0;
  Object.assign(workspace, {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (key === "externalBrowser" ? setting : defaultValue) as T,
      update: async (key: string, value: unknown, target: unknown) => {
        written.push({ key, value, target });
      },
    }),
  });
  Object.assign(window, {
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const options = rest[0] as { detail?: string } | undefined;
      guides.push(`${message}\n${options?.detail ?? ""}`);
      return answer;
    },
  });
});

afterEach(() => {
  Object.assign(workspace, { getConfiguration: original.getConfiguration });
  Object.assign(window, { showInformationMessage: original.showInformationMessage });
});

describe("Chrome でないと分かったとき", () => {
  test("初回は案内してから開き、2回目は黙って開く", async () => {
    init("MSEdgeHTM");

    await openSiteLink(KAKUYOMU);
    expect(guides).toHaveLength(1);
    expect(guides[0]).toContain("Microsoft Edge");
    expect(guides[0]).toContain("ヘルパー");
    expect(guides[0]).toContain("Chrome");
    expect(env.opened).toEqual([KAKUYOMU]);
    expect(memory.get(SITE_LINK_GUIDE_SHOWN_KEY, false)).toBe(true);

    await openSiteLink(KAKUYOMU);
    expect(guides).toHaveLength(1);
    expect(env.opened).toEqual([KAKUYOMU, KAKUYOMU]);
    // 覚えていれば登録簿も読みに行かない
    expect(progIdReads).toBe(1);
  });

  test("閉じても（答えなし）リンクは開き、設定は書かない", async () => {
    init("MSEdgeHTM");
    answer = undefined;
    await openSiteLink(KAKUYOMU);
    expect(env.opened).toEqual([KAKUYOMU]);
    expect(written).toEqual([]);
  });

  test("［Chrome で開くようにする］を押したときだけ、ユーザー設定に chrome を書く", async () => {
    init("MSEdgeHTM");
    answer = USE_CHROME_LABEL;
    await openSiteLink(KAKUYOMU);
    expect(written).toEqual([{ key: "externalBrowser", value: "chrome", target: 1 }]);
    expect(env.opened).toEqual([KAKUYOMU]);
  });

  test("［ヘルパーについて］はヘルパーの案内を開き、リンクも開く", async () => {
    init("MSEdgeHTM");
    answer = ABOUT_HELPER_LABEL;
    await openSiteLink(KAKUYOMU);
    expect(env.opened).toEqual([HELPER_DOWNLOAD_URL, KAKUYOMU]);
  });

  test("設定が edge なら、登録簿を読まずに案内する", async () => {
    init("ChromeHTML");
    setting = "edge";
    await openSiteLink(KAKUYOMU);
    expect(guides).toHaveLength(1);
    expect(progIdReads).toBe(0);
  });
});

describe("案内を出さないとき", () => {
  test("既定が Chrome なら出さない（覚えも書かない）", async () => {
    init("ChromeHTML");
    await openSiteLink(KAKUYOMU);
    expect(guides).toEqual([]);
    expect(env.opened).toEqual([KAKUYOMU]);
    expect(memory.values.has(SITE_LINK_GUIDE_SHOWN_KEY)).toBe(false);
  });

  test("設定が chrome なら出さない", async () => {
    init("MSEdgeHTM");
    setting = "chrome";
    await openSiteLink(KAKUYOMU);
    expect(guides).toEqual([]);
  });

  test("登録簿を読めなければ出さない（推し量らない）", async () => {
    init(undefined);
    await openSiteLink(KAKUYOMU);
    expect(guides).toEqual([]);
    expect(env.opened).toEqual([KAKUYOMU]);
    expect(memory.values.has(SITE_LINK_GUIDE_SHOWN_KEY)).toBe(false);
  });

  test("ヘルパーと関わりの無いリンクは出さない", async () => {
    init("MSEdgeHTM");
    await openSiteLink("https://example.com/contest");
    expect(guides).toEqual([]);
    expect(env.opened).toEqual(["https://example.com/contest"]);
  });
});
