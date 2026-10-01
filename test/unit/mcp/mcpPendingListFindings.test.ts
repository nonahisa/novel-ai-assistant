import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { pendingListTool } from "../../../src/mcp/tools/pendingList";
import { McpToolError } from "../../../src/mcp/tools/shared";
import {
  exposureOf,
  recordExternalAccess,
  setExternalClientName,
} from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import {
  FINDING_LIST_KEY,
  permissionKeyOf,
} from "../../../src/core/externalAccessPermission";
import { parseExternalAccessLog } from "../../../src/core/externalAccessLog";
import { buildFinding, findingRestoreOf } from "../../../src/core/findingSource";
import { locateFindings } from "../../../src/core/findingLocation";
import { visibleFindings } from "../../../src/features/findingStore";
import {
  parseFindingLines,
  resolveFindings,
  type Finding,
  type FindingDecision,
} from "../../../src/models/finding";

/**
 * 提案パネルの指摘を外から読む（MCP `pending.list` の `kind: "finding"`。
 * 作者の裁定、2026-10-01）。
 *
 * 目的：外部AIや手元のAIが出した指摘を、作者が採ったかを外から確かめる
 * （AIごとの当たり率の測定にも使う）。
 *
 * **見張ることは4つ。**
 *
 * 1. **製品の指摘と外部AIの指摘が混ざった置き場から、状態つきで読める**
 *    ——状態の決め方は提案パネルと同じ関数（`visibleFindings` →
 *    `locateFindings` → `findingRestoreOf`）。パネルに並ぶものと
 *    `pending` の集合が一致することを読み比べる
 * 2. **出どころ・モデルごとの集計**
 * 3. **許可が無ければ断る**（鍵は承認待ちの読み取りと分ける）
 * 4. **読むだけ**——置き場も原稿も1バイトも変えない
 */

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";
const CLIENT = "試験";
const NOW = new Date();
const temporary: string[] = [];

function workCopy(tools: string[] = ["*"]): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-finding-list-"));
  fs.cpSync(FIXTURE, folder, { recursive: true });
  writePermission(folder, tools);
  temporary.push(folder);
  return folder;
}

function writePermission(folder: string, tools: string[]): void {
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "external-access.json"),
    JSON.stringify({
      clients: [
        {
          name: CLIENT,
          tools,
          sampling: false,
          decidedAt: "2026-10-01T00:00:00.000Z",
          decidedOn: "テスト",
          note: "",
        },
      ],
    }),
    "utf8"
  );
}

function findingsFile(folder: string): string {
  return nodePath.join(folder, ".aiwriter", "findings.jsonl");
}

/** 作品フォルダー全体の指紋（`.aiwriter/history` の記録は除く）。**1バイトでも変われば変わる** */
function folderFingerprint(folder: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "history") continue;
        walk(full);
      } else {
        hash.update(nodePath.relative(folder, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(folder);
  return hash.digest("hex");
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 本物の組み立て（`buildFinding`）で1件を作る。原文が本文に無ければ作れない */
function made(
  folder: string,
  partial: {
    original: string;
    target: string;
    suggestion: string;
    category: Finding["category"];
    label: string;
    time: string;
    producer?: Finding["producer"];
    origin?: Finding["origin"];
  }
): Finding {
  const text = fs.readFileSync(nodePath.join(folder, EPISODE), "utf8");
  const finding = buildFinding(
    folder,
    {
      filePath: nodePath.join(folder, EPISODE),
      line: 2,
      original: partial.original,
      target: partial.target,
      suggestion: partial.suggestion,
      message: "なぜ挙げたか",
      category: partial.category,
      label: partial.label,
      producer: partial.producer,
      origin: partial.origin,
    },
    text,
    partial.time
  );
  if (!finding) throw new Error(`本文に無い原文: ${partial.original}`);
  return finding;
}

const SONNET = { kind: "external" as const, client: "claude-code", model: "claude-sonnet-4-5" };
const SONNET_PRODUCER = { providerId: "external:claude-code", model: "claude-sonnet-4-5" };
const GEMMA = { providerId: "ollama", model: "gemma4:e4b" };

/**
 * 混ざった置き場を作る。
 *
 * - 製品（gemma）：未処理1・採用1
 * - 外部AI（sonnet）：未処理1・却下1・期限切れ1
 * - 製品：原文が本文から消えた（陳腐化）1
 * - 製品：パネルへ戻す道の無い種類（other）1
 * - 外部AI：採用してから戻した（＝未処理に戻る）1
 */
function seed(folder: string): Record<string, Finding> {
  const internalPending = made(folder, {
    original: "まず最初に、少年は窓を開けた。",
    target: "まず最初に",
    suggestion: "まず",
    category: "typo",
    label: "誤字脱字",
    time: daysAgo(0.1),
    producer: GEMMA,
  });
  const internalAccepted = made(folder, {
    original: "それから湯を沸かし、便りをもう一度読み返した。",
    target: "もう一度",
    suggestion: "再び",
    category: "proofread",
    label: "推敲",
    time: daysAgo(0.2),
    producer: GEMMA,
  });
  const externalPending = made(folder, {
    original: "夜が明けた。",
    target: "夜が明けた",
    suggestion: "夜があけた",
    category: "typo",
    label: "誤字脱字",
    time: daysAgo(0.1),
    producer: SONNET_PRODUCER,
    origin: SONNET,
  });
  const externalDismissed = made(folder, {
    original: "少年は窓を開けた。",
    target: "開けた",
    suggestion: "あけた",
    category: "proofread",
    label: "推敲",
    time: daysAgo(0.3),
    producer: SONNET_PRODUCER,
    origin: SONNET,
  });
  const externalExpired = made(folder, {
    original: "湯を沸かし",
    target: "沸かし",
    suggestion: "わかし",
    category: "typo",
    label: "誤字脱字",
    time: daysAgo(10),
    producer: SONNET_PRODUCER,
    origin: SONNET,
  });
  const externalUndone = made(folder, {
    original: "便りをもう一度読み返した。",
    target: "便り",
    suggestion: "手紙",
    category: "typo",
    label: "誤字脱字",
    time: daysAgo(0.1),
    producer: SONNET_PRODUCER,
    origin: SONNET,
  });
  // 原文が本文から消えた（作者が自分で書き直した）指摘。組み立てたあとで原文を差し替える
  const internalLost: Finding = {
    ...made(folder, {
      original: "窓を開けた",
      target: "窓",
      suggestion: "まど",
      category: "typo",
      label: "誤字脱字",
      time: daysAgo(0.1),
      producer: GEMMA,
    }),
    id: "flost",
    original: "この一文は本文にもう無い。",
  };
  const internalOther: Finding = {
    ...made(folder, {
      original: "夜が明けた",
      target: "夜",
      suggestion: "よる",
      category: "other",
      label: "",
      time: daysAgo(0.1),
      producer: GEMMA,
    }),
    id: "fother",
  };

  const decisions: FindingDecision[] = [
    { findingId: internalAccepted.id, time: daysAgo(0.05), status: "accepted", note: "" },
    { findingId: externalDismissed.id, time: daysAgo(0.04), status: "dismissed", note: "" },
    { findingId: externalUndone.id, time: daysAgo(0.03), status: "accepted", note: "" },
    { findingId: externalUndone.id, time: daysAgo(0.02), status: "pending", note: "" },
  ];
  const lines = [
    ...[
      internalPending,
      internalAccepted,
      externalPending,
      externalDismissed,
      externalExpired,
      externalUndone,
      internalLost,
      internalOther,
    ].map((finding) => JSON.stringify({ kind: "finding", ...finding })),
    ...decisions.map((decision) => JSON.stringify({ kind: "decision", ...decision })),
  ];
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(findingsFile(folder), `${lines.join("\n")}\n`, "utf8");
  return {
    internalPending,
    internalAccepted,
    externalPending,
    externalDismissed,
    externalExpired,
    externalUndone,
    internalLost,
    internalOther,
  };
}

beforeEach(() => {
  setExternalClientName(CLIENT);
});

afterEach(() => {
  while (temporary.length > 0) {
    const folder = temporary.pop();
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("状態つきで読む", () => {
  it("製品の指摘と外部AIの指摘が混ざった置き場から、1件ずつ状態を返す", () => {
    const folder = workCopy();
    const seeded = seed(folder);
    const result = pendingListTool({ folder, kind: "finding" });

    expect(result.kind).toBe("finding");
    const stateOf = (id: string): string | undefined =>
      result.items.find((item) => item.id === id)?.state;
    expect(stateOf(seeded.internalPending.id)).toBe("pending");
    expect(stateOf(seeded.internalAccepted.id)).toBe("accepted");
    expect(stateOf(seeded.externalPending.id)).toBe("pending");
    expect(stateOf(seeded.externalDismissed.id)).toBe("dismissed");
    expect(stateOf(seeded.externalExpired.id)).toBe("expired");
    // 採ってから戻したものは、パネルにもう一度並ぶ（最後の判断が勝つ）
    expect(stateOf(seeded.externalUndone.id)).toBe("pending");
    expect(stateOf(seeded.internalLost.id)).toBe("stale");
    expect(stateOf(seeded.internalOther.id)).toBe("unrestorable");
    expect(result.total).toBe(8);
  });

  it("1件ごとに 機能・ファイル・行・引用・提案・判断した日時・出どころ を返す", () => {
    const folder = workCopy();
    const seeded = seed(folder);
    const result = pendingListTool({ folder, kind: "finding" });

    const external = result.items.find((item) => item.id === seeded.externalDismissed.id);
    expect(external).toMatchObject({
      feature: "proofread",
      label: "推敲",
      file: EPISODE,
      line: 2,
      quote: "開けた",
      suggestion: "あけた",
      state: "dismissed",
      source: "external",
      client: "claude-code",
      model: "claude-sonnet-4-5",
    });
    expect(external?.decidedAt).toBe(
      resolveFindings(parseFindingLines(fs.readFileSync(findingsFile(folder), "utf8"))).find(
        (view) => view.id === seeded.externalDismissed.id
      )?.decision?.time
    );
    expect(external?.stateLabel).toMatch(/却下/);

    const internal = result.items.find((item) => item.id === seeded.internalPending.id);
    expect(internal).toMatchObject({
      feature: "typo",
      label: "誤字脱字",
      source: "internal",
      providerId: "ollama",
      model: "gemma4:e4b",
      decidedAt: null,
    });
    // 未処理は、いまの本文で探し直した行
    expect(internal?.line).toBe(2);
  });

  it("引用と説明は短く切る（原稿をまとめて渡さない）", () => {
    const folder = workCopy();
    const long = "あ".repeat(400);
    const finding: Finding = {
      ...made(folder, {
        original: "夜が明けた。",
        target: "夜",
        suggestion: "い".repeat(400),
        category: "typo",
        label: "誤字脱字",
        time: daysAgo(0.1),
      }),
      message: long,
    };
    fs.writeFileSync(findingsFile(folder), `${JSON.stringify({ kind: "finding", ...finding })}\n`);
    const [item] = pendingListTool({ folder, kind: "finding" }).items;
    expect(item.suggestion.length).toBeLessThanOrEqual(81);
    expect(item.message.length).toBeLessThanOrEqual(121);
  });

  /**
   * **提案パネルに並ぶものと、pending の集合が一致する。** パネルは
   * `visibleFindings` → `locateFindings` → `findingRestoreOf` の順で
   * 落とす（`features/primeFindings.ts`）。同じ置き場をその順で通した結果と比べる。
   */
  it("pending の集合は、提案パネルが戻す集合と同じ", () => {
    const folder = workCopy();
    seed(folder);
    const views = resolveFindings(parseFindingLines(fs.readFileSync(findingsFile(folder), "utf8")));
    const text = fs.readFileSync(nodePath.join(folder, EPISODE), "utf8");
    const panel = locateFindings(visibleFindings(views, 3), new Map([[EPISODE, text]]))
      .filter((finding) => findingRestoreOf(finding) !== undefined)
      .map((finding) => finding.id)
      .sort();

    const listed = pendingListTool({ folder, kind: "finding" })
      .items.filter((item) => item.state === "pending")
      .map((item) => item.id)
      .sort();
    expect(listed).toEqual(panel);
    expect(listed).toHaveLength(3);
  });

  it("retentionDays を渡すと、期限切れの判定がそれに従う（0 は無期限）", () => {
    const folder = workCopy();
    const seeded = seed(folder);
    const result = pendingListTool({ folder, kind: "finding", retentionDays: 0 });
    expect(result.items.find((item) => item.id === seeded.externalExpired.id)?.state).toBe(
      "pending"
    );
    expect(result.retentionDays).toBe(0);
  });

  it("置き場が無ければ空で返す（断らない）", () => {
    const folder = workCopy();
    const result = pendingListTool({ folder, kind: "finding" });
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("source: external で外部AIの指摘だけに絞れる。件数は絞る前", () => {
    const folder = workCopy();
    seed(folder);
    const result = pendingListTool({ folder, kind: "finding", source: "external" });
    expect(result.items.every((item) => item.source === "external")).toBe(true);
    expect(result.matched).toBe(4);
    expect(result.total).toBe(8);
  });

  it("指摘で使えない source は断る", () => {
    const folder = workCopy();
    seed(folder);
    expect(() => pendingListTool({ folder, kind: "finding", source: "plot" })).toThrow(McpToolError);
  });
});

describe("集計", () => {
  it("出どころ・モデルごとに 採用／却下／未処理 などを数える", () => {
    const folder = workCopy();
    seed(folder);
    const result = pendingListTool({ folder, kind: "finding" });

    expect(result.counts).toEqual({
      pending: 3,
      accepted: 1,
      dismissed: 1,
      expired: 1,
      stale: 1,
      unchecked: 0,
      unrestorable: 1,
    });

    const sonnet = result.byProducer.find(
      (group) => group.source === "external" && group.model === "claude-sonnet-4-5"
    );
    expect(sonnet).toMatchObject({
      client: "claude-code",
      total: 4,
      counts: { pending: 2, accepted: 0, dismissed: 1, expired: 1 },
    });
    const gemma = result.byProducer.find(
      (group) => group.source === "internal" && group.model === "gemma4:e4b"
    );
    expect(gemma).toMatchObject({
      providerId: "ollama",
      total: 4,
      counts: { pending: 1, accepted: 1, dismissed: 0, stale: 1, unrestorable: 1 },
    });
  });
});

describe("許可（設計書6.87.14）", () => {
  it("鍵は承認待ちの読み取り（pending.list）と分ける", () => {
    expect(permissionKeyOf("pending.list", undefined, "finding")).toBe(FINDING_LIST_KEY);
    expect(permissionKeyOf("pending.list", undefined, "character")).toBe("pending.list");
    expect(permissionKeyOf("pending.list", undefined, undefined)).toBe("pending.list");
  });

  it("承認待ちだけを許した接続元には、指摘を読ませない", () => {
    const folder = workCopy(["pending.list"]);
    expect(() =>
      assertExternalAccessAllowed({ folder, kind: "finding" }, "pending.list")
    ).toThrow();
    expect(() => assertExternalAccessAllowed({ folder }, "pending.list")).not.toThrow();
  });

  it("許可の無い作品では断り、ノックは指摘の鍵で残る。許せば通る", () => {
    const folder = workCopy([]);
    const args = { folder, kind: "finding" };
    expect(() => assertExternalAccessAllowed(args, "pending.list")).toThrow();
    recordExternalAccess({ tool: "pending.list", args, ok: false, denied: true });
    const log = parseExternalAccessLog(
      fs.readFileSync(nodePath.join(folder, ".aiwriter", "history", "external.jsonl"), "utf8")
    );
    expect(log[0].key).toBe(FINDING_LIST_KEY);

    writePermission(folder, [FINDING_LIST_KEY]);
    expect(() => assertExternalAccessAllowed(args, "pending.list")).not.toThrow();
  });
});

describe("読むだけ・記録（設計書6.87.9）", () => {
  it("置き場も原稿も1バイトも変えない", () => {
    const folder = workCopy();
    seed(folder);
    const before = folderFingerprint(folder);
    pendingListTool({ folder, kind: "finding" });
    pendingListTool({ folder, kind: "finding", source: "external", limit: 1 });
    expect(folderFingerprint(folder)).toBe(before);
  });

  it("記録には指摘を読んだことが残り、原稿の出方は excerpt", () => {
    const folder = workCopy();
    seed(folder);
    const args = { folder, kind: "finding" as const };
    const result = pendingListTool(args);
    recordExternalAccess({ tool: "pending.list", args, ok: true, result });
    const log = parseExternalAccessLog(
      fs.readFileSync(nodePath.join(folder, ".aiwriter", "history", "external.jsonl"), "utf8")
    );
    expect(log[0].key).toBe(FINDING_LIST_KEY);
    expect(log[0].detail).toContain("提案パネルの指摘を読んだ");
    expect(exposureOf("pending.list", args)).toBe("excerpt");
  });

  it("limit で切っても、件数と集計は絞る前", () => {
    const folder = workCopy();
    seed(folder);
    const result = pendingListTool({ folder, kind: "finding", limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.matched).toBe(8);
    expect(result.byProducer.reduce((sum, group) => sum + group.total, 0)).toBe(8);
    // 未処理（パネルに並ぶもの）が先
    expect(result.items.every((item) => item.state === "pending")).toBe(true);
  });
});
