import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  inferredWorkSource,
  markInferredWork,
} from "../../src/core/workTarget";
import { confirmRun } from "../../src/views/notify";
import { window, workspace } from "./support/vscodeStub";

/**
 * 「以降は訊かない」を覚えていても、**作品を推し量ったときは訊く**
 * （作者の裁定、2026-09-23）。
 *
 * ## 何が起きたか
 *
 * ノートPCで作品一覧の行を誤って選んでいたため、詳細メニューの「場所を抽出」が
 * **作者の本物の作品**で確認画面（15チャンク・約1時間30分）まで進んだ。
 * f7c6a075 で確認画面に作品名を出したが、「以降は訊かない」を選んでいると
 * **確認そのものが出ず、1時間30分の抽出が黙って走る。**
 *
 * ## 裁定
 *
 * - 作品一覧の選択・相談パネルの対象・開いているファイルの作品から決めたとき
 *   （推し量ったとき）→ 覚えていても確認を出す
 * - 作品を右クリックしたとき・作品を選ぶ画面で選んだとき（名指し）→ これまでどおり訊かない
 */

/** 「以降は訊かない」の覚え書きを差し替える（`notify.test.ts` と同じ形） */
function stubConfirmMemory(initial: Record<string, string>): () => void {
  const original = workspace.getConfiguration;
  workspace.getConfiguration = ((section?: string) => {
    if (section !== "novelai") return original();
    return {
      get: (_key: string) => initial,
      update: async () => undefined,
    };
  }) as typeof workspace.getConfiguration;
  return () => {
    workspace.getConfiguration = original;
  };
}

function captureModal(answer: string | undefined): {
  calls: unknown[][];
  restore: () => void;
} {
  const calls: unknown[][] = [];
  const original = window.showInformationMessage;
  window.showInformationMessage = async (message, ...items) => {
    calls.push([message, ...items]);
    return answer;
  };
  return {
    calls,
    restore: () => {
      window.showInformationMessage = original;
    },
  };
}

const WORK = { id: "w-1", title: "こちら冒険者ギルド生活保護課!!", folderPath: "/w" };

describe("推し量った作品の印", () => {
  test("印を付けたのは写しで、元の作品には付かない", () => {
    const marked = markInferredWork(WORK, "tree");
    expect(marked).not.toBe(WORK);
    expect(marked).toEqual(WORK);
    expect(inferredWorkSource(marked)).toBe("tree");
    // 登録簿の作品そのものに印を付けると、あとで右クリックしたときまで
    // 「推し量った」ことになる
    expect(inferredWorkSource(WORK)).toBeUndefined();
  });

  test("作品が無ければ、推し量ってもいない", () => {
    expect(inferredWorkSource(undefined)).toBeUndefined();
  });
});

describe("confirmRun：推し量った作品は、覚えていても訊く", () => {
  test("名指しの作品なら、これまでどおり窓を出さない", async () => {
    const restoreMemory = stubConfirmMemory({ "ai.run.extractCharacters": "実行" });
    const modal = captureModal("実行");
    try {
      const result = await confirmRun("15 チャンクを処理します。", "実行", {
        remember: { id: "ai.run.extractCharacters" },
        work: WORK,
      });
      expect(result).toBe(true);
      expect(modal.calls).toEqual([]);
    } finally {
      modal.restore();
      restoreMemory();
    }
  });

  test("作品一覧の選択から決めた作品なら、窓を出す（理由と作品名を添える）", async () => {
    const restoreMemory = stubConfirmMemory({ "ai.run.extractCharacters": "実行" });
    const modal = captureModal("実行");
    try {
      const result = await confirmRun("15 チャンクを処理します。", "実行", {
        remember: { id: "ai.run.extractCharacters" },
        work: markInferredWork(WORK, "tree"),
      });
      expect(result).toBe(true);
      expect(modal.calls).toHaveLength(1);
      const [message, options, ...buttons] = modal.calls[0];
      expect(options).toMatchObject({ modal: true });
      const text = String(message);
      expect(text.startsWith(`作品：${WORK.title}`)).toBe(true);
      expect(text).toContain("作品一覧");
      expect(text).toContain("推し量ったので、確かめています");
      expect(text).toContain("15 チャンクを処理します。");
      // もう覚えてあるので「以降は訊かない」は並べない（押しても何も変わらない）
      expect(buttons).toEqual(["実行"]);
    } finally {
      modal.restore();
      restoreMemory();
    }
  });

  test("キャンセルすれば走らない", async () => {
    const restoreMemory = stubConfirmMemory({ "ai.run.extractCharacters": "実行" });
    const modal = captureModal(undefined);
    try {
      const result = await confirmRun("15 チャンクを処理します。", "実行", {
        remember: { id: "ai.run.extractCharacters" },
        work: markInferredWork(WORK, "chat"),
      });
      expect(result).toBe(false);
      expect(String(modal.calls[0]?.[0])).toContain("相談パネル");
    } finally {
      modal.restore();
      restoreMemory();
    }
  });

  test("開いているファイルから決めた作品でも訊く", async () => {
    const restoreMemory = stubConfirmMemory({ "ai.run.checkTypos": "実行" });
    const modal = captureModal("実行");
    try {
      await confirmRun(`${WORK.title} の誤字脱字を検知します。`, "実行", {
        remember: { id: "ai.run.checkTypos" },
        work: markInferredWork(WORK, "file"),
      });
      expect(modal.calls).toHaveLength(1);
      expect(String(modal.calls[0]?.[0])).toContain("開いているファイル");
    } finally {
      modal.restore();
      restoreMemory();
    }
  });

  test("覚えていなければ、推し量っていても確認はいつもの形（理由の一言は出さない）", async () => {
    const restoreMemory = stubConfirmMemory({});
    const modal = captureModal(undefined);
    try {
      await confirmRun("15 チャンクを処理します。", "実行", {
        remember: { id: "ai.run.extractCharacters" },
        work: markInferredWork(WORK, "tree"),
      });
      const [message, , ...buttons] = modal.calls[0];
      expect(message).toBe(`作品：${WORK.title}\n15 チャンクを処理します。`);
      expect(buttons).toEqual(["実行", "実行（以降は訊かない）"]);
    } finally {
      modal.restore();
      restoreMemory();
    }
  });

  test("文に作品名が既に入っていれば、作品の行を重ねない（覚えていないとき）", async () => {
    const restoreMemory = stubConfirmMemory({});
    const modal = captureModal(undefined);
    try {
      await confirmRun(`${WORK.title} の推敲を行います。`, "実行", {
        remember: { id: "ai.run.checkProofread" },
        work: WORK,
      });
      expect(modal.calls[0]?.[0]).toBe(`${WORK.title} の推敲を行います。`);
    } finally {
      modal.restore();
      restoreMemory();
    }
  });
});

/*
  配線はソースの形で押さえる。`resolveWork` は画面の部品を大量に偽らないと
  動かせない（`workTargetOrder.test.ts` と同じ理由）。
*/
describe("作品を推し量る所は、どれも印を付けて返す", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/extension.ts"),
    "utf8"
  );

  test("resolveWork：作品一覧・相談の対象から決めたら印を付ける（1作品だけのときは付けない）", () => {
    const start = source.indexOf("async function resolveWork(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toMatch(/markInferredWork\(\s*found,\s*hinted\.source\s*\)/);
    expect(body).toContain('hinted.source === "single"');
  });

  test("開いているファイルから作品を決める所は、印を付ける", () => {
    // 前提の関門（詳細メニュー・簡単ステップ・コマンドパレットの共通の口）と、
    // 単話プロットの検査
    const matches = [
      ...source.matchAll(
        /openedPath \? findWorkForPath\(registry, openedPath\) : undefined/g
      ),
    ];
    expect(matches).toHaveLength(0);
    const marked = [...source.matchAll(/inferredWorkOfPath\(registry, openedPath\)/g)];
    expect(marked.length).toBeGreaterThanOrEqual(2);
  });

  test("相談パネルからの実行は、相談の対象として印を付ける", () => {
    const run = source.slice(source.indexOf("const command = CHAT_RUN_COMMANDS[kind];"));
    expect(run.slice(0, 600)).toMatch(/markInferredWork\(work, "chat"\)/);
  });
});

/**
 * 作品に対してAIを走らせる確認は、**作品そのもの**（`work`）を渡す。
 * 題名の文字列だけでは、推し量ったかどうかが確認まで届かない。
 */
const FEATURES = join(__dirname, "..", "..", "src", "features");
const WORK_CONFIRMS: ReadonlyArray<readonly [string, string]> = [
  ["extractCharacters.ts", "ai.run.extractCharacters"],
  ["checkTypos.ts", "ai.run.checkTypos"],
  ["checkContradictions.ts", "ai.run.checkContradictions"],
  ["checkFactContradictions.ts", "ai.run.checkFactContradictions"],
  ["checkProofread.ts", "ai.run.checkProofread"],
  ["checkForeshadows.ts", "ai.run.checkForeshadows"],
  ["checkForeshadows.ts", "ai.run.checkForeshadowResolutions"],
  ["checkDeviations.ts", "ai.run.checkDeviations"],
  ["checkEpisodePlot.ts", "ai.run.checkEpisodePlotDesign"],
  ["checkEpisodePlot.ts", "ai.run.checkEpisodePlotContrast"],
  ["checkOpening.ts", "ai.paid.checkOpening"],
  ["generateSynopses.ts", "ai.run.generateSynopses"],
  ["generatePlot.ts", "ai.run.generatePlot"],
  ["generateBlurb.ts", "ai.run.generateBlurb"],
  ["generateBlurb.ts", "ai.run.generateCatchphrase"],
  ["generateAnnouncement.ts", "ai.run.generateAnnouncement"],
  ["proposeChapters.ts", "ai.run.proposeChapters"],
  ["proposeChapters.ts", "ai.run.proposeChapterName"],
  ["nameCheck.ts", "ai.paid.nameCheck"],
  ["notationAdvice.ts", "ai.paid.notationAdvice"],
  ["readerTargetDiagnosis.ts", "ai.paid.readerTarget"],
  ["readerAdvice.ts", "ai.run.readerAdvice"],
];

/** 呼び出しの括弧の中身（文字列の中の括弧は数えない。`confirmShowsWorkTitle.test.ts` と同じ） */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openParen; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, index);
    }
  }
  return source.slice(openParen + 1);
}

describe("作品に対する確認は、作品そのものを渡す", () => {
  test.each(WORK_CONFIRMS)("%s（%s）", (file, id) => {
    const text = readFileSync(join(FEATURES, file), "utf8");
    const calls = [...text.matchAll(/\b(confirmRun|confirmPaidUsage)\(/g)]
      .map((match) =>
        callArguments(text, (match.index ?? 0) + match[0].length - 1)
      )
      .filter((args) => args.includes(`remember: { id: "${id}" }`));
    expect(calls, `${file} に ${id} の確認が無い`).toHaveLength(1);
    // `work` か `work: request.work` のように、作品そのものを渡している
    expect(calls[0]).toMatch(/(^|[\s{,])work(: [\w.?]+)?\s*[,}]/);
    // 題名だけの渡し方（`workTitle:`）は残っていない
    expect(calls[0]).not.toMatch(/workTitle:/);
  });
});
