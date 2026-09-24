import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setWorkGoals } from "../../../src/features/setWorkGoals";
import { invalidateWorkGoals } from "../../../src/core/workGoalsStore";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 作品目標設定の「応募先の締切と目標」に、**いつの情報か**を添える
 * （設計書6.3.6.1。実機確認リスト 0.80.0 の「応募先を入れた作品目標設定・
 * 執筆量パネルに取り込み日（「9月23日時点の情報」）が出るか」）。
 *
 * 執筆量パネルの側は `views/writingStatsPanelContestAsOf.test.ts`、
 * 取り込み直して締切が変わったときの知らせは `contestImport.test.ts` が見る。
 */

const work: WorkEntry = {
  id: "w_goals_asof",
  title: "星を継ぐ者たち",
  folderPath: path.join("C:", "novels", "goals-asof"),
  registeredAt: "2026-09-01T00:00:00.000Z",
};

const goalsFile = Uri.file(path.join(work.folderPath, ".aiwriter", "goals.json")).fsPath;
const disk = new Map<string, Uint8Array>();
const shown: Array<Array<{ label: string; description?: string; detail?: string }>> = [];
const originals = { fs: workspace.fs, showQuickPick: window.showQuickPick };

function writeGoals(goals: unknown): void {
  disk.set(goalsFile, new TextEncoder().encode(`${JSON.stringify(goals, null, 2)}\n`));
  invalidateWorkGoals(work.id);
}

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;
  window.showQuickPick = (async (items: unknown) => {
    shown.push(items as Array<{ label: string; description?: string; detail?: string }>);
    return undefined; // 見るだけで閉じる
  }) as typeof window.showQuickPick;
});

afterEach(() => {
  workspace.fs = originals.fs;
  window.showQuickPick = originals.showQuickPick;
  invalidateWorkGoals(work.id);
});

const contest = {
  name: "第3回 みずうみ文学賞",
  url: "https://example.com/mizuumi",
  deadline: "2026-10-31",
  minChars: 20000,
  maxChars: 40000,
  dailyGoal: null,
};

describe("作品目標設定の応募先の行", () => {
  test("公募の一覧から入れた応募先には「9月23日時点の情報」を添える", async () => {
    writeGoals({
      version: 1,
      perEpisodeChars: null,
      contest: {
        ...contest,
        imported: {
          importedAt: "2026-09-23T10:00:00.000+09:00",
          sourcePage: "https://creative-story.net/bungakusyou/",
          organizer: "みずうみ文学振興会",
          deadlineText: "2026年10月31日",
          charText: "400字詰原稿用紙で50枚以上100枚以下",
        },
      },
    });

    await setWorkGoals(work);

    const row = shown[0].find((item) => item.label.includes("応募先の締切と目標"));
    expect(row?.description).toContain("第3回 みずうみ文学賞（2026-10-31）");
    expect(row?.detail).toContain("9月23日時点の情報");
    expect(row?.detail).toContain("応募の前に募集要項で確かめてください");
    // 募集要項を開く行にも、いつの情報かを添える
    const open = shown[0].find((item) => item.label.includes("応募先の募集要項を開く"));
    expect(open?.description).toBe("9月23日時点の情報");
  });

  test("手で入れた応募先には、取り込んだ日を出さない", async () => {
    writeGoals({ version: 1, perEpisodeChars: null, contest });

    await setWorkGoals(work);

    const text = JSON.stringify(shown[0]);
    expect(text).not.toContain("時点の情報");
  });
});
