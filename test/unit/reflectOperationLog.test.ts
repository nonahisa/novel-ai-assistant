import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { reflectIntoChecklist } from "../../src/dev/reflectOperationLog";
import {
  initOperationLog,
  logOperation,
  readOperationSummary,
  type OperationCount,
} from "../../src/dev/operationLog";
import type { PendingCheckSection } from "../../src/views/pendingChecks";

/**
 * F5の操作ログと、その確認リストへの反映（作者の依頼、2026-08-27）。
 *
 * **いちばん確かめたいのは「合否の印に触らないこと」。** 押したことと
 * 通ったことは別で、ここが自動で進むと**確かめていないものが済んだことになる**。
 */

/** 手元の時刻で書くので、**手元の時刻から**記録を作る（時差で揺れないように） */
const RAN_AT = new Date(2026, 7, 27, 14, 5);
const EARLIER = new Date(2026, 7, 26, 9, 30);

const CHECKLIST = [
  "# 実機（F5）確認リスト",
  "",
  "## A. 原稿が壊れうるもの（最優先）",
  "",
  "### A-1. 誤字脱字・推敲の適用",
  "",
  "<!-- 対象: novelai.checkTypos, novelai.checkProofread -->",
  "",
  "**適用そのものは確認済み**である。",
  "",
  "- [ ] まとめて適用のあと、各ファイルが1か所ずつだけ変わっているか",
  "- [x] 編集部が校閲中のファイルでは、戻せないか",
  "",
  "### A-2. 表記ゆれ",
  "",
  "<!-- 対象: novelai.checkNotation -->",
  "",
  "- [ ] 選んだ組が反映されるか",
  "",
].join("\n");

const SECTIONS: readonly PendingCheckSection[] = [
  {
    id: "A-1",
    title: "誤字脱字・推敲の適用",
    commands: ["novelai.checkTypos", "novelai.checkProofread"],
    count: 1,
  },
  {
    id: "A-2",
    title: "表記ゆれ",
    commands: ["novelai.checkNotation"],
    count: 1,
  },
];

function summaryOf(
  entries: Record<string, { count: number; at: Date }>
): ReadonlyMap<string, OperationCount> {
  return new Map(
    Object.entries(entries).map(([command, { count, at }]) => [
      command,
      { count, lastTs: at.toISOString() },
    ])
  );
}

describe("操作ログを確認リストへ反映する", () => {
  test("記録のある節に、見出しの直後へ1行入る", () => {
    const { text, updatedSections } = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({ "novelai.checkTypos": { count: 3, at: RAN_AT } })
    );

    const lines = text.split("\n");
    const heading = lines.indexOf("### A-1. 誤字脱字・推敲の適用");
    expect(lines[heading + 1]).toBe("＊操作ログ：最終実行 2026-08-27 14:05（計3回）");
    expect(updatedSections).toEqual(["A-1"]);
  });

  test("同じ節の操作は、合わせて数える", () => {
    // 1つの節に複数の操作がぶら下がる（誤字脱字と推敲）。
    // どちらを押しても「その節を触った」ことに変わりはない
    const { text } = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({
        "novelai.checkTypos": { count: 3, at: EARLIER },
        "novelai.checkProofread": { count: 2, at: RAN_AT },
      })
    );

    expect(text).toContain("＊操作ログ：最終実行 2026-08-27 14:05（計5回）");
  });

  test("2回通しても、行は増えない（置き換わる）", () => {
    const summary = summaryOf({
      "novelai.checkTypos": { count: 3, at: RAN_AT },
    });
    const once = reflectIntoChecklist(CHECKLIST, SECTIONS, summary).text;
    const twice = reflectIntoChecklist(once, SECTIONS, summary).text;

    expect(twice).toBe(once);
    expect(twice.split("＊操作ログ：")).toHaveLength(2);
  });

  test("回数が増えたら、同じ行が新しい値に書き換わる", () => {
    const once = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({ "novelai.checkTypos": { count: 3, at: EARLIER } })
    ).text;
    const twice = reflectIntoChecklist(
      once,
      SECTIONS,
      summaryOf({ "novelai.checkTypos": { count: 8, at: RAN_AT } })
    ).text;

    expect(twice).toContain("＊操作ログ：最終実行 2026-08-27 14:05（計8回）");
    expect(twice).not.toContain("計3回");
    expect(twice.split("＊操作ログ：")).toHaveLength(2);
  });

  test("合否の印と、対象の行には触らない", () => {
    // **ここが自動で進むと、確かめていないものが済んだことになる**
    const { text } = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({
        "novelai.checkTypos": { count: 3, at: RAN_AT },
        "novelai.checkNotation": { count: 1, at: RAN_AT },
      })
    );

    const before = CHECKLIST.split("\n");
    const after = text.split("\n");
    const kept = (lines: readonly string[]) =>
      lines.filter(
        (line) => line.startsWith("- [") || line.startsWith("<!-- 対象:")
      );

    expect(kept(after)).toEqual(kept(before));
    // 未確認の項目が済みに変わっていないこと（数で見る）
    expect(after.filter((line) => line.startsWith("- [x]"))).toHaveLength(1);
    expect(after.filter((line) => line.startsWith("- [ ]"))).toHaveLength(2);
  });

  test("文章の行は、1つも変わらない", () => {
    const { text } = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({ "novelai.checkTypos": { count: 3, at: RAN_AT } })
    );

    expect(text).toContain("**適用そのものは確認済み**である。");
    // 足したのは1行だけ
    expect(text.split("\n")).toHaveLength(CHECKLIST.split("\n").length + 1);
  });

  test("記録の無い節は、そのままにする", () => {
    const { text, updatedSections } = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({ "novelai.checkTypos": { count: 3, at: RAN_AT } })
    );

    const lines = text.split("\n");
    const heading = lines.indexOf("### A-2. 表記ゆれ");
    expect(lines[heading + 1]).toBe("");
    expect(updatedSections).not.toContain("A-2");
  });

  test("複数の節へ入れても、行のずれで壊れない", () => {
    // 前の節へ1行挿すと、後ろの節の行番号がずれる。
    // **節ごとに探し直していないと、別の場所へ書き込む**
    const { text, updatedSections } = reflectIntoChecklist(
      CHECKLIST,
      SECTIONS,
      summaryOf({
        "novelai.checkTypos": { count: 3, at: RAN_AT },
        "novelai.checkNotation": { count: 1, at: EARLIER },
      })
    );

    const lines = text.split("\n");
    expect(lines[lines.indexOf("### A-1. 誤字脱字・推敲の適用") + 1]).toBe(
      "＊操作ログ：最終実行 2026-08-27 14:05（計3回）"
    );
    expect(lines[lines.indexOf("### A-2. 表記ゆれ") + 1]).toBe(
      "＊操作ログ：最終実行 2026-08-26 09:30（計1回）"
    );
    expect(updatedSections).toEqual(["A-1", "A-2"]);
  });

  test("確認リストに無い節は、黙って飛ばす", () => {
    const missing: PendingCheckSection[] = [
      { id: "Z-9", title: "存在しない節", commands: ["novelai.gone"], count: 1 },
    ];

    const { text, updatedSections } = reflectIntoChecklist(
      CHECKLIST,
      missing,
      summaryOf({ "novelai.gone": { count: 2, at: RAN_AT } })
    );

    expect(text).toBe(CHECKLIST);
    expect(updatedSections).toEqual([]);
  });

  test("改行がCRLFの文書へ、LFの行を混ぜない", () => {
    const crlf = CHECKLIST.split("\n").join("\r\n");

    const { text } = reflectIntoChecklist(
      crlf,
      SECTIONS,
      summaryOf({ "novelai.checkTypos": { count: 3, at: RAN_AT } })
    );

    expect(text).toContain(
      "\r\n＊操作ログ：最終実行 2026-08-27 14:05（計3回）\r\n"
    );
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

/** 使い捨ての拡張機能フォルダー。ログはこの下の `logs/` に溜まる */
async function temporaryExtensionFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "novelai-oplog-"));
  temporaryDirectories.push(folder);
  return folder;
}

describe("操作ログの集計", () => {
  test("コマンドごとに、回数と最後の時刻をまとめる", async () => {
    initOperationLog(await temporaryExtensionFolder());
    logOperation("novelai.checkTypos");
    logOperation("novelai.checkNotation");
    logOperation("novelai.checkTypos");

    const summary = readOperationSummary();

    expect(summary.get("novelai.checkTypos")?.count).toBe(2);
    expect(summary.get("novelai.checkNotation")?.count).toBe(1);
    expect(summary.get("novelai.checkTypos")?.lastTs).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
  });

  test("壊れた行は飛ばして、読める行だけを数える", async () => {
    // 追記の途中でVS Codeが落ちれば、最後の行は欠ける。
    // **1行読めないだけで全部を捨てると、記録の意味が無くなる**
    const folder = await temporaryExtensionFolder();
    initOperationLog(folder);
    await writeFile(
      join(folder, "logs", "operations.jsonl"),
      [
        '{"ts":"2026-08-27T05:05:00.000Z","command":"novelai.checkTypos"}',
        "{壊れた行",
        "",
        '{"ts":"2026-08-27T05:06:00.000Z","command":"novelai.checkTypos"}',
        // 形はJSONだが、要る項目が無い
        '{"ts":"2026-08-27T05:07:00.000Z"}',
        '{"command":"novelai.checkNotation"}',
        // 書きかけで落ちた最後の行
        '{"ts":"2026-08-27T05:08:00.000Z","comm',
      ].join("\n"),
      "utf8"
    );

    const summary = readOperationSummary();

    expect(summary.get("novelai.checkTypos")).toEqual({
      count: 2,
      lastTs: "2026-08-27T05:06:00.000Z",
    });
    expect(summary.has("novelai.checkNotation")).toBe(false);
  });

  test("時計が戻っても、いちばん新しい時刻を採る", async () => {
    const folder = await temporaryExtensionFolder();
    initOperationLog(folder);
    await writeFile(
      join(folder, "logs", "operations.jsonl"),
      [
        '{"ts":"2026-08-27T05:06:00.000Z","command":"novelai.checkTypos"}',
        '{"ts":"2026-08-27T05:05:00.000Z","command":"novelai.checkTypos"}',
      ].join("\n"),
      "utf8"
    );

    expect(readOperationSummary().get("novelai.checkTypos")).toEqual({
      count: 2,
      lastTs: "2026-08-27T05:06:00.000Z",
    });
  });

  test("まだ一度も操作していなければ、空で返す", async () => {
    initOperationLog(await temporaryExtensionFolder());

    expect(readOperationSummary().size).toBe(0);
  });
});
