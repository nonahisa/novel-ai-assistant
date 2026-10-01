import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { novelPropose } from "../../../src/mcp/tools/propose";
import { typoPrompt } from "../../../src/mcp/tools/typo";
import { McpToolError } from "../../../src/mcp/tools/shared";
import {
  exposureOf,
  recordExternalAccess,
  setExternalClientName,
} from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import {
  FINDING_PROPOSE_KEY,
  permissionKeyOf,
} from "../../../src/core/externalAccessPermission";
import { parseExternalAccessLog } from "../../../src/core/externalAccessLog";
import {
  parseFindingLines,
  resolveFindings,
  type FindingLine,
} from "../../../src/models/finding";

/**
 * 外部AIの指摘を提案パネルへ置く道（MCP `novel.propose` の `kind: "finding"`。
 * 作者の裁定、2026-10-01）。
 *
 * **いちばん見張りたいのは2つ。**
 *
 * 1. **検算を通ったものだけが置かれる。** 呼んだ側の言い分を信じると、
 *    本文に無い引用や固有名詞の「直し」が提案パネルに並び、作者が［適用］を
 *    押せば原稿が壊れる（実装ルール3）
 * 2. **原稿と設定資料が1バイトも変わらない。** 置くのは提案の置き場だけ
 *
 * 落ちる側だけを見ると、何も置かない実装が満点になる。**通る側も必ず見る**
 * （CLAUDE.md「見逃しと誤検出の両方を測ること」）。
 */

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";
const NUM_CTX = 32768;
const CLIENT = "試験";

const temporary: string[] = [];

function workCopy(tools: string[] = ["*"]): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-finding-"));
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

/** 原稿と設定資料の指紋。**1バイトでも変われば変わる** */
function manuscriptFingerprint(folder: string): string {
  const hash = createHash("sha256");
  for (const dir of ["本文", "設定"]) {
    const walk = (current: string): void => {
      for (const name of fs.readdirSync(current).sort()) {
        const full = nodePath.join(current, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else {
          hash.update(full.slice(folder.length));
          hash.update(fs.readFileSync(full));
        }
      }
    };
    walk(nodePath.join(folder, dir));
  }
  return hash.digest("hex");
}

function chunkIdOf(folder: string): string {
  return typoPrompt({ folder, filePath: EPISODE, numCtx: NUM_CTX }).chunks[0].chunkId;
}

function findingsFile(folder: string): string {
  return nodePath.join(folder, ".aiwriter", "findings.jsonl");
}

function readLines(folder: string): FindingLine[] {
  return parseFindingLines(fs.readFileSync(findingsFile(folder), "utf8"));
}

/** 本文にある語の誤字脱字（検算を通る） */
const GOOD_TYPO = {
  line: 2,
  original: "まず最初に、少年は窓を開けた。",
  target: "窓を開けた",
  suggestion: "窓を空けた",
  reason: "誤変換",
  confidence: "high",
};

/** 固有名詞を誤字だと言う（検算で落ちる） */
const PROTECTED_TYPO = {
  line: 2,
  original: "まず最初に、少年は窓を開けた。",
  target: "少年",
  suggestion: "少女",
  reason: "変換ミス",
  confidence: "high",
};

beforeEach(() => {
  setExternalClientName(CLIENT);
});

afterEach(() => {
  setExternalClientName("");
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("検算を通った指摘だけが置かれる", () => {
  it("本文にある語の指摘は、出どころと指紋つきで置かれる", () => {
    const folder = workCopy();
    const before = manuscriptFingerprint(folder);

    const result = novelPropose({
      folder,
      kind: "finding",
      feature: "typo",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({ issues: [GOOD_TYPO] }),
      model: "claude-sonnet-4-5",
    });

    expect(result.placedCount).toBe(1);
    expect(result.notPlacedCount).toBe(0);
    expect(result.category).toBe("誤字脱字");

    const lines = readLines(folder);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (line.kind !== "finding") throw new Error("指摘の行ではない");
    expect(line.target).toBe("窓を開けた");
    expect(line.suggestion).toBe("窓を空けた");
    // **提案パネルのタブへ戻す鍵**（`core/findingSource.ts` の表と同じ名前）
    expect(line.label).toBe("誤字脱字");
    expect(line.category).toBe("typo");
    // **本文の行**（チャンクの番号ではない）と、作品からの相対パス
    expect(line.file).toBe(EPISODE);
    expect(line.hintLine).toBe(2);
    expect(line.origin).toEqual({
      kind: "external",
      client: CLIENT,
      model: "claude-sonnet-4-5",
    });
    expect(line.fingerprint?.fileHash).toMatch(/\S/);
    expect(line.fingerprint?.chunkHash).toMatch(/\S/);
    // 採った率をモデルごとに数える鍵（中のAIと混ざらない名前）
    expect(line.producer).toEqual({
      providerId: `external:${CLIENT}`,
      model: "claude-sonnet-4-5",
    });

    // **原稿も設定資料も1バイトも変わらない**
    expect(manuscriptFingerprint(folder)).toBe(before);
  });

  it("検算で落ちる指摘は置かれず、理由が返る", () => {
    const folder = workCopy();

    const result = novelPropose({
      folder,
      kind: "finding",
      feature: "typo",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({ issues: [PROTECTED_TYPO] }),
    });

    expect(result.placedCount).toBe(0);
    expect(result.notPlaced).toHaveLength(1);
    expect(result.notPlaced[0].stage).toBe("validate");
    // **理由まで見る**（件数だけだと、形が違って落ちた回も通ってしまう）
    expect(result.notPlaced[0].reason).toBe("protected_term");
    // 置くものが無ければ、置き場も作らない
    expect(fs.existsSync(findingsFile(folder))).toBe(false);
  });

  it("通るものと落ちるものが混ざれば、通ったものだけを置く", () => {
    const folder = workCopy();

    const result = novelPropose({
      folder,
      kind: "finding",
      feature: "typo",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({
        issues: [
          GOOD_TYPO,
          PROTECTED_TYPO,
          {
            line: 2,
            original: "この語は本文のどこにもない",
            target: "この語は本文のどこにもない",
            suggestion: "なおす",
            reason: "脱字",
            confidence: "high",
          },
        ],
      }),
    });

    expect(result.placedCount).toBe(1);
    expect(result.notPlacedCount).toBe(2);
    expect(readLines(folder)).toHaveLength(1);
  });

  it("推敲も置ける（説明は提案パネルと同じ組み方）", () => {
    const folder = workCopy();

    const result = novelPropose({
      folder,
      kind: "finding",
      feature: "proofread",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({
        issues: [
          {
            line: 2,
            original: "まず最初に",
            suggestion: "まず",
            reason: "冗長",
            explanation: "同じ意味が重なっている",
            confidence: "high",
          },
        ],
      }),
    });

    expect(result.placedCount).toBe(1);
    const line = readLines(folder)[0];
    if (line.kind !== "finding") throw new Error("指摘の行ではない");
    expect(line.label).toBe("推敲");
    expect(line.message).toBe("冗長：同じ意味が重なっている");
  });

  it("矛盾も置ける（左右を分けたまま）", () => {
    const folder = workCopy();

    const result = novelPropose({
      folder,
      kind: "finding",
      feature: "contradiction",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({
        contradictions: [
          {
            line: 2,
            excerpt: "少年は窓を開けた",
            category: "人物",
            settingSays: "少年は窓の無い部屋に住んでいる",
            textSays: "少年が窓を開けている",
            note: "",
            severity: "medium",
            confidence: "medium",
          },
        ],
      }),
    });

    expect(result.placedCount).toBe(1);
    const line = readLines(folder)[0];
    if (line.kind !== "finding") throw new Error("指摘の行ではない");
    expect(line.label).toBe("矛盾");
    expect(line.target).toBe("");
    expect(line.compared?.leftLabel).toBe("設定では");
    expect(line.compared?.right).toBe("少年が窓を開けている");
  });

  it("同じ指摘は2度置かない。作者が退けたものも置き直さない", () => {
    const folder = workCopy();
    const call = () =>
      novelPropose({
        folder,
        kind: "finding",
        feature: "typo",
        chunkId: chunkIdOf(folder),
        response: JSON.stringify({ issues: [GOOD_TYPO] }),
      });

    expect(call().placedCount).toBe(1);
    const again = call();
    expect(again.placedCount).toBe(0);
    expect(again.notPlaced[0].reason).toBe("already_placed");

    // 作者が提案パネルで退けた（判断の行が足される）
    const id = resolveFindings(readLines(folder))[0].id;
    fs.appendFileSync(
      findingsFile(folder),
      JSON.stringify({
        kind: "decision",
        findingId: id,
        time: new Date().toISOString(),
        status: "dismissed",
        note: "",
      }) + "\n",
      "utf8"
    );
    const afterDismiss = call();
    expect(afterDismiss.placedCount).toBe(0);
    expect(afterDismiss.notPlaced[0].reason).toBe("already_dismissed");
  });
});

describe("断りどころ", () => {
  it("置けない機能は、理由を挙げて断る", () => {
    const folder = workCopy();
    expect(() =>
      novelPropose({
        folder,
        kind: "finding",
        feature: "notation",
        chunkId: chunkIdOf(folder),
        response: "{}",
      })
    ).toThrow(/表記ゆれ/);
  });

  it("chunkId が無ければ断る", () => {
    const folder = workCopy();
    expect(() =>
      novelPropose({ folder, kind: "finding", feature: "typo", response: "{}" })
    ).toThrow(McpToolError);
  });

  it("答えが検算の形に読めなければ、何も置かずに断る", () => {
    const folder = workCopy();
    expect(() =>
      novelPropose({
        folder,
        kind: "finding",
        feature: "typo",
        chunkId: chunkIdOf(folder),
        response: "これはJSONではありません",
      })
    ).toThrow(/JSON/);
    expect(fs.existsSync(findingsFile(folder))).toBe(false);
  });

  it("設定資料の道で name などが無ければ、指摘の道を案内して断る", () => {
    const folder = workCopy();
    expect(() => novelPropose({ folder })).toThrow(/kind: "finding"/);
  });
});

describe("許可（設計書6.87.14）", () => {
  it("鍵は設定資料の案（novel.propose）と分ける", () => {
    expect(permissionKeyOf("novel.propose", "typo", "finding")).toBe(FINDING_PROPOSE_KEY);
    expect(permissionKeyOf("novel.propose", undefined, undefined)).toBe("novel.propose");
    // **ほかの道具の kind には反応しない**
    expect(permissionKeyOf("novel.run", "typo", "finding")).toBe("typo");
  });

  it("設定資料の案だけを許した接続元には、指摘を置かせない", () => {
    const folder = workCopy(["novel.propose"]);
    const args = { folder, kind: "finding", feature: "typo" };
    expect(() => assertExternalAccessAllowed(args, "novel.propose")).toThrow();
    // 設定資料の案はこれまでどおり通る
    expect(() =>
      assertExternalAccessAllowed({ folder, name: "少年" }, "novel.propose")
    ).not.toThrow();
  });

  it("断った回はノックとして指摘の鍵で残り、後から許せば置ける", () => {
    const folder = workCopy(["novel.propose"]);
    const args = {
      folder,
      kind: "finding",
      feature: "typo",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({ issues: [GOOD_TYPO] }),
    };
    expect(() => assertExternalAccessAllowed(args, "novel.propose")).toThrow();
    recordExternalAccess({ tool: "novel.propose", args, ok: false, denied: true });
    const log = parseExternalAccessLog(
      fs.readFileSync(nodePath.join(folder, ".aiwriter", "history", "external.jsonl"), "utf8")
    );
    // **作者がノックの画面で許すのは、この鍵**（ずれると、いくら許しても通らない）
    expect(log[0].key).toBe(FINDING_PROPOSE_KEY);

    // 作者が許した（ノックの画面が足すのと同じ形）
    writePermission(folder, ["novel.propose", FINDING_PROPOSE_KEY]);
    expect(() => assertExternalAccessAllowed(args, "novel.propose")).not.toThrow();
    expect(novelPropose({ ...args, kind: "finding" }).placedCount).toBe(1);
  });
});

describe("外から触られた記録（設計書6.87.9）", () => {
  it("置いた件数と落とした件数を残す。原稿は外へ出ていない", () => {
    const folder = workCopy();
    const args = {
      folder,
      kind: "finding" as const,
      feature: "typo",
      chunkId: chunkIdOf(folder),
      response: JSON.stringify({ issues: [GOOD_TYPO, PROTECTED_TYPO] }),
      model: "claude-sonnet-4-5",
    };
    const result = novelPropose(args);
    recordExternalAccess({ tool: "novel.propose", args, ok: true, result });

    const log = parseExternalAccessLog(
      fs.readFileSync(nodePath.join(folder, ".aiwriter", "history", "external.jsonl"), "utf8")
    );
    expect(log[0].key).toBe(FINDING_PROPOSE_KEY);
    expect(log[0].detail).toContain("置いた 1件");
    expect(log[0].detail).toContain("落とした 1件");
    expect(log[0].file).toBe(EPISODE);
    expect(log[0].model).toBe("claude-sonnet-4-5");
    expect(exposureOf("novel.propose", args)).toBe("none");
  });
});
