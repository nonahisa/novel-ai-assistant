import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  AI_ASSIGNMENTS_SNAPSHOT_PATH,
  buildAiAssignmentsSnapshot,
  serializeAiAssignmentsSnapshot,
} from "../../../src/core/aiAssignmentsSnapshot";
import { TUNING_STORE_FILE } from "../../../src/core/tuningStoreNames";
import { GLOBAL_STORAGE_ENV } from "../../../src/mcp/globalStorage";
import { aiSettings } from "../../../src/mcp/tools/aiSettings";
import { exposureOf } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";

/**
 * MCP の道具 `ai.settings`（作者の裁定、2026-10-01）。
 *
 * AIチューニングの記録（保管庫の `model-tuning.json`）と、機能ごとのAIの
 * 割り当て（`globalState` にあるので、拡張機能が書いた写し）を読む。
 * 見張るのは：両方が読めること・**鍵が1文字も載らないこと**・写しや記録が
 * 無い／壊れているときに断りを返して止まらないこと・保管庫を書き換えないこと・
 * 作品を取らないので門番を通らないこと。
 */

const NOW = new Date("2026-10-01T10:00:00.000Z");
const SECRET = "sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210";

let storage: string;
let previousEnv: string | undefined;

beforeEach(() => {
  storage = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-ai-settings-"));
  previousEnv = process.env[GLOBAL_STORAGE_ENV];
  process.env[GLOBAL_STORAGE_ENV] = storage;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[GLOBAL_STORAGE_ENV];
  else process.env[GLOBAL_STORAGE_ENV] = previousEnv;
  fs.rmSync(storage, { recursive: true, force: true });
});

const assignmentsFile = (): string => nodePath.join(storage, ...AI_ASSIGNMENTS_SNAPSHOT_PATH);
const tuningFile = (): string => nodePath.join(storage, TUNING_STORE_FILE);

function writeAssignments(text: string): void {
  fs.mkdirSync(nodePath.dirname(assignmentsFile()), { recursive: true });
  fs.writeFileSync(assignmentsFile(), text, "utf8");
}

function writeTuning(text: string): void {
  fs.writeFileSync(tuningFile(), text, "utf8");
}

function sampleAssignments(): string {
  return serializeAiAssignmentsSnapshot(
    buildAiAssignmentsSnapshot(
      {
        defaultProvider: "ollama",
        defaultModel: "gemma4:e4b",
        assignments: { typo: { provider: "sakura", model: "gpt-oss-120b" } },
        features: [
          { key: "typo", label: "誤字脱字" },
          { key: "chat", label: "AIに相談" },
        ],
      },
      { pid: 7, extensionVersion: "0.94.7", machineName: "DESKTOP" },
      new Date("2026-10-01T09:30:00.000Z")
    )
  );
}

/** 保管庫の中身をまるごと控える（読むだけであることを確かめる） */
function listing(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const full = nodePath.join(directory, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(`${full}|${stat.size}|${stat.mtimeMs}|${fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(storage);
  return out.sort();
}

describe("ai.settings", () => {
  it("割り当ての写しと、チューニングの記録の両方を返す", () => {
    writeAssignments(sampleAssignments());
    writeTuning(
      JSON.stringify({
        "ollama/gemma4:e4b": { contextWindow: 131072, workSecondsPer1000Chars: 12.5 },
      })
    );
    const result = aiSettings(NOW);

    expect(result.assignments.storage).toBe(assignmentsFile());
    expect(result.assignments.writtenAt).toBe("2026-10-01T09:30:00.000Z");
    expect(result.assignments.minutesSinceWritten).toBe(30);
    expect(result.assignments.defaultAi).toEqual({ provider: "ollama", model: "gemma4:e4b" });
    expect(result.assignments.features?.map((row) => [row.feature, row.effective?.model])).toEqual([
      ["typo", "gpt-oss-120b"],
      ["chat", "gemma4:e4b"],
    ]);

    expect(result.tuning.storage).toBe(tuningFile());
    expect(result.tuning.records?.map((row) => [row.key, row.contextWindow, row.secondsPer1000Chars])).toEqual([
      ["ollama/gemma4:e4b", 131072, 12.5],
    ]);
  });

  it("鍵・トークンらしきものは、どちらのファイルに紛れていても返さない", () => {
    const snapshot = JSON.parse(sampleAssignments()) as Record<string, unknown>;
    snapshot.apiKey = SECRET;
    (snapshot.defaultAi as Record<string, unknown>).token = SECRET;
    writeAssignments(JSON.stringify(snapshot));
    writeTuning(
      JSON.stringify({
        "claude/claude-x": { contextWindow: 200000, apiKey: SECRET, contextDeclared: SECRET },
      })
    );
    const text = JSON.stringify(aiSettings(NOW));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("apiKey");
  });

  it("写しが無ければ null と断り（記録は読む）", () => {
    writeTuning(JSON.stringify({ "ollama/m": { timeoutSeconds: 200 } }));
    const result = aiSettings(NOW);
    expect(result.assignments.features).toBeNull();
    expect(result.assignments.defaultAi).toBeNull();
    expect(result.assignments.note).toContain("写しがありません");
    expect(result.tuning.records).toHaveLength(1);
  });

  it("記録が無ければ空の一覧と断り（まだ測っていない）", () => {
    writeAssignments(sampleAssignments());
    const result = aiSettings(NOW);
    expect(result.tuning.records).toEqual([]);
    expect(result.tuning.note).toContain("まだありません");
    expect(result.assignments.features).toHaveLength(2);
  });

  it("壊れた写し・壊れた記録は直さずに null と断り", () => {
    writeAssignments("{");
    writeTuning("{");
    const before = listing();
    const result = aiSettings(NOW);
    expect(result.assignments.features).toBeNull();
    expect(result.assignments.note).toContain("写しの形になっていません");
    expect(result.tuning.records).toBeNull();
    expect(result.tuning.note).toContain("読めません");
    expect(listing()).toEqual(before);
  });

  it("保管庫を1バイトも書き換えない（読むだけ）", () => {
    writeAssignments(sampleAssignments());
    writeTuning(JSON.stringify({ "ollama/m": { timeoutSeconds: 200 } }));
    const before = listing();
    aiSettings(NOW);
    expect(listing()).toEqual(before);
  });
});

describe("作品を取らないので、門番を通らない。原稿は出ない", () => {
  it("許可の印が無くても断らない", () => {
    expect(() => assertExternalAccessAllowed({}, "ai.settings")).not.toThrow();
    expect(() => assertExternalAccessAllowed(undefined, "ai.settings")).not.toThrow();
  });

  it("原稿の出方は none", () => {
    expect(exposureOf("ai.settings", undefined)).toBe("none");
  });
});

describe("登録と文書", () => {
  const root = nodePath.join(__dirname, "../../..");
  const read = (file: string): string => fs.readFileSync(nodePath.join(root, file), "utf8");

  it("サーバーに登録され、記録の名前もそろっている", () => {
    const server = read("src/mcp/server.ts");
    expect(server).toContain(`registerTool(\n  "ai.settings"`);
    expect(server).toContain(`tool("ai.settings"`);
  });

  it("外部AIへ配るスキルに載っている", () => {
    expect(read("docs/skills/novel-assist.md")).toContain("`ai.settings`");
  });

  it("保管庫の場所は mcpGlobalStorageRoot の1か所から。読むだけで書かない", () => {
    const source = read("src/mcp/tools/aiSettings.ts");
    expect(source).toContain("mcpGlobalStorageRoot");
    expect(source).not.toMatch(/process\.argv/u);
    expect(source).not.toMatch(/\b(writeFileSync|writeFile|rmSync|unlinkSync|renameSync|mkdirSync)\b/u);
    // 鍵の置き場（SecretStorage）にも、VS Code の設定にも手を伸ばさない
    expect(source).not.toMatch(/secrets|getConfiguration|settings\.json/u);
  });

  it("拡張機能の写しの書き手は、鍵の置き場を読まない", () => {
    const writer = read("src/features/aiAssignmentsSnapshot.ts");
    expect(writer).not.toMatch(/secrets|getApiKey|SecretStorage/u);
  });
});
