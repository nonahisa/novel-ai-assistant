import { describe, expect, it } from "vitest";
import {
  AI_ASSIGNMENTS_SNAPSHOT_PATH,
  AI_ASSIGNMENTS_SNAPSHOT_SCHEMA,
  buildAiAssignmentsSnapshot,
  parseAiAssignmentsSnapshot,
  serializeAiAssignmentsSnapshot,
} from "../../../src/core/aiAssignmentsSnapshot";

/**
 * 機能ごとのAIの割り当ての写し（MCP の `ai.settings`。作者の裁定、2026-10-01）。
 *
 * 見張るのは：割り当てのうち**プロバイダとモデルの名前だけ**が写ること
 * （鍵らしき欄が紛れていても写さない）、割り当ての無い機能が既定のAIで
 * 動くと読めること、壊れた写しを直さずに「読めない」と返すこと。
 */

const WRITER = { pid: 42, extensionVersion: "0.94.7", machineName: "DESKTOP" };
const NOW = new Date("2026-10-01T09:00:00.000Z");
const FEATURES = [
  { key: "extract", label: "設定資料の抽出" },
  { key: "typo", label: "誤字脱字" },
  { key: "chat", label: "AIに相談" },
];

describe("割り当ての写しを組み立てる", () => {
  it("割り当てのある機能はそのAI、無い機能は既定のAIで動くと読める", () => {
    const snapshot = buildAiAssignmentsSnapshot(
      {
        defaultProvider: "ollama",
        defaultModel: "gemma4:e4b",
        assignments: { typo: { provider: "sakura", model: "gpt-oss-120b" } },
        features: FEATURES,
      },
      WRITER,
      NOW
    );
    expect(snapshot.schema).toBe(AI_ASSIGNMENTS_SNAPSHOT_SCHEMA);
    expect(snapshot.writtenAt).toBe("2026-10-01T09:00:00.000Z");
    expect(snapshot.writtenBy).toEqual(WRITER);
    expect(snapshot.defaultAi).toEqual({ provider: "ollama", model: "gemma4:e4b" });
    expect(snapshot.features).toEqual([
      {
        feature: "extract",
        label: "設定資料の抽出",
        assigned: null,
        effective: { provider: "ollama", model: "gemma4:e4b" },
      },
      {
        feature: "typo",
        label: "誤字脱字",
        assigned: { provider: "sakura", model: "gpt-oss-120b" },
        effective: { provider: "sakura", model: "gpt-oss-120b" },
      },
      {
        feature: "chat",
        label: "AIに相談",
        assigned: null,
        effective: { provider: "ollama", model: "gemma4:e4b" },
      },
    ]);
  });

  it("既定のAIが未設定なら、割り当ての無い機能は effective が null", () => {
    const snapshot = buildAiAssignmentsSnapshot(
      { defaultProvider: undefined, defaultModel: undefined, assignments: undefined, features: FEATURES },
      WRITER,
      NOW
    );
    expect(snapshot.defaultAi).toBeNull();
    expect(snapshot.features.every((row) => row.assigned === null && row.effective === null)).toBe(true);
  });

  it("鍵らしき欄が割り当てに紛れていても、プロバイダとモデルの名前しか写さない", () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const snapshot = buildAiAssignmentsSnapshot(
      {
        defaultProvider: "claude",
        defaultModel: "claude-x",
        assignments: {
          typo: { provider: "claude", model: "claude-x", apiKey: secret, token: secret },
          // 一覧に無い機能の割り当て（古い版の残り）は写さない
          oldFeature: { provider: "gemini", model: "g", apiKey: secret },
        },
        features: FEATURES,
      },
      WRITER,
      NOW
    );
    const text = serializeAiAssignmentsSnapshot(snapshot);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("oldFeature");
    expect(snapshot.features[1].assigned).toEqual({ provider: "claude", model: "claude-x" });
  });

  it("形の崩れた割り当て（名前が空・文字でない）は「割り当て無し」として扱う", () => {
    const snapshot = buildAiAssignmentsSnapshot(
      {
        defaultProvider: "ollama",
        defaultModel: "m",
        assignments: { extract: { provider: "", model: "x" }, typo: { provider: "gemini", model: 3 } },
        features: FEATURES,
      },
      WRITER,
      NOW
    );
    expect(snapshot.features[0].assigned).toBeNull();
    expect(snapshot.features[1].assigned).toBeNull();
    expect(snapshot.features[1].effective).toEqual({ provider: "ollama", model: "m" });
  });
});

describe("割り当ての写しを読む", () => {
  it("書いたものをそのまま読み戻せる", () => {
    const snapshot = buildAiAssignmentsSnapshot(
      {
        defaultProvider: "ollama",
        defaultModel: "gemma4:e4b",
        assignments: { typo: { provider: "sakura", model: "gpt-oss-120b" } },
        features: FEATURES,
      },
      WRITER,
      NOW
    );
    expect(parseAiAssignmentsSnapshot(serializeAiAssignmentsSnapshot(snapshot))).toEqual(snapshot);
  });

  it("壊れた写し・版の違う写しは undefined（直しにいかない）", () => {
    expect(parseAiAssignmentsSnapshot("{")).toBeUndefined();
    expect(parseAiAssignmentsSnapshot("[]")).toBeUndefined();
    expect(
      parseAiAssignmentsSnapshot(JSON.stringify({ schema: 999, writtenAt: "x", features: [] }))
    ).toBeUndefined();
  });

  it("読むときも、行の余分な欄（鍵らしきもの）は落とす", () => {
    const secret = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456";
    const text = JSON.stringify({
      schema: AI_ASSIGNMENTS_SNAPSHOT_SCHEMA,
      writtenAt: "2026-10-01T09:00:00.000Z",
      writtenBy: { pid: 1, extensionVersion: "0.94.7", machineName: null, apiKey: secret },
      defaultAi: { provider: "gemini", model: "g", apiKey: secret },
      features: [
        {
          feature: "typo",
          label: "誤字脱字",
          assigned: null,
          effective: { provider: "gemini", model: "g", apiKey: secret },
          apiKey: secret,
        },
      ],
      apiKey: secret,
    });
    const parsed = parseAiAssignmentsSnapshot(text);
    expect(parsed).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  it("置き場は保管庫の .aiwriter の下", () => {
    expect(AI_ASSIGNMENTS_SNAPSHOT_PATH).toEqual([".aiwriter", "ai-assignments.json"]);
  });
});
