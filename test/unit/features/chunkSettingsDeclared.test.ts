import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNTUNED_CHUNK_CHARS, decideChunkSize } from "../../../src/core/chunker";
import { workspace } from "../support/vscodeStub";
import { readChunkSettings } from "../../../src/features/chunkSettings";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * **APIが読める長さを申告し、読める長さの測定を飛ばすモデル（Gemini・Claude）
 * には、未チューニングの安全既定（6,000字）を掛けない**（2026-10-08。
 * 設計書6.49.10）。
 *
 * 測定を飛ばすので、読める量の実測（`measuredChars`）はいつまでも入らない。
 * 上限をそのまま掛けると、測る道が無いのに「測っていない」として
 * 6,000字に抑え続けることになる。6,000字の上限は、もともと非力な手元の
 * 機械を守るためのものである。
 */

beforeEach(async () => {
  await useMemoryTuningStore({});
  workspace.getConfiguration = () =>
    ({
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async () => {},
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
});

afterEach(() => {
  workspace.getConfiguration = () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  });
});

describe("読める長さを API が申告するモデルのチャンク", () => {
  it("Claude は測っていなくても 6,000字に抑えない", () => {
    const settings = readChunkSettings(1_000_000, undefined, {
      providerId: "claude",
      model: "claude-opus-5-5",
    });

    expect(settings.chunk.chars).toBe(decideChunkSize(1_000_000));
    expect(settings.chunk.chars).toBeGreaterThan(UNTUNED_CHUNK_CHARS);
    expect(settings.chunkCharsBeforeUntunedCap).toBeUndefined();
  });

  it("Gemini も同じ", () => {
    const settings = readChunkSettings(1_048_576, undefined, {
      providerId: "gemini",
      model: "gemini-3-pro",
    });

    expect(settings.chunkCharsBeforeUntunedCap).toBeUndefined();
  });

  it("手元のモデル（Ollama・LM Studio）は今までどおり抑える", () => {
    for (const providerId of ["ollama", "lmstudio"]) {
      const settings = readChunkSettings(262_144, undefined, {
        providerId,
        model: "測っていないモデル",
      });
      expect(settings.chunk.chars).toBe(UNTUNED_CHUNK_CHARS);
    }
  });

  it("申告が作者の設定であるもの（さくら・ChatGPT）も今までどおり抑える", () => {
    for (const providerId of ["sakura", "openai"]) {
      const settings = readChunkSettings(128_000, undefined, {
        providerId,
        model: "測っていないモデル",
      });
      expect(settings.chunk.chars).toBe(UNTUNED_CHUNK_CHARS);
    }
  });
});
