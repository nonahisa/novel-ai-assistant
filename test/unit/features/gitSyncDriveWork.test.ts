import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { GitSyncMonitor } from "../../../src/features/gitSync";
import { present, setUpMissingWork, type MissingWorkHarness } from "../support/missingWorkHarness";
import { window } from "../support/vscodeStub";
import { blockAfter } from "../support/sourceBlock";

/**
 * 送り先が Google ドライブの作品では、git の記録・取り込み・送信をしない（設計書5.10.9。
 * 1つの作品で GitHub と併用しない）。見張りの取り込み・受け取り・送信も、作品一覧の右クリックの
 * 同期・受け取り・送信も止め、理由を出す。
 */

let harness: MissingWorkHarness;
const originalQuickPick = window.showQuickPick;
const originalInfo = window.showInformationMessage;
let shown: string[] = [];
beforeEach(() => {
  harness = setUpMissingWork();
  harness.bringBack();
  harness.porcelain = "";
  shown = [];
  Object.assign(window, {
    showInformationMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});
afterEach(() => {
  harness.restore();
  Object.assign(window, { showQuickPick: originalQuickPick, showInformationMessage: originalInfo });
});

type Private = {
  runPull(work: { id: string }, afterRecording: boolean): Promise<boolean>;
  runPush(work: { id: string }): Promise<boolean>;
};

const monitor = () =>
  new GitSyncMonitor(harness.registry as never, { run: harness.run, isGitDisabled: () => true });

const wrote = () => harness.calls.filter((args) => ["pull", "push", "add", "commit", "merge", "stash"].includes(args[0]));

describe("見張り（GitSyncMonitor）", () => {
  test("取り込み：git を呼ばずに理由を出す", async () => {
    harness.counts.behind = 1;
    harness.counts.ahead = 0;
    const one = monitor();
    try {
      expect(await (one as unknown as Private).runPull(present, false)).toBe(false);
      expect(wrote()).toEqual([]);
      expect(shown.join()).toContain("Google ドライブ");
    } finally {
      one.dispose();
    }
  });

  test("受け取るだけ：受け取らなかったと答える", async () => {
    harness.counts.behind = 1;
    harness.counts.ahead = 0;
    const one = monitor();
    try {
      expect((await one.receive(present)).kind).toBe("skipped");
      expect(wrote()).toEqual([]);
    } finally {
      one.dispose();
    }
  });

  test("送信：確認も送信もしない", async () => {
    harness.counts.behind = 0;
    harness.counts.ahead = 1;
    let asked = 0;
    Object.assign(window, {
      showQuickPick: async () => {
        asked += 1;
        return undefined;
      },
    });
    const one = monitor();
    try {
      expect(await (one as unknown as Private).runPush(present)).toBe(false);
      expect(asked).toBe(0);
      expect(wrote()).toEqual([]);
    } finally {
      one.dispose();
    }
  });
});

describe("命令（extension.ts）", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "src", "extension.ts"), "utf8");
  for (const command of ["novelai.gitSync", "novelai.gitPull", "novelai.gitPush"]) {
    test(`${command} は、選んだ作品がドライブの作品なら理由を出して止める`, () => {
      const body = blockAfter(source, `"${command}",`);
      expect(body).toContain("refuseGitForDriveWork(work)");
    });
  }
  test("novelai.syncAllWorks は、ドライブの作品を飛ばし、飛ばしたことを知らせに書く", () => {
    const body = blockAfter(source, `registerCommand("novelai.syncAllWorks"`);
    expect(body).toContain("skipWork:");
    expect(body).toContain("noteSkippedWorks: true");
  });
  test("見張りへ、ドライブの作品を渡している", () => {
    expect(source).toMatch(/GitSyncMonitor\(registry, \{[^}]*isGitDisabled:/);
  });
});
