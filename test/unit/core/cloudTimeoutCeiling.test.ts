import { afterEach, describe, expect, test } from "vitest";
import {
  CLOUD_TIMEOUT_CEILING_SETTING,
  MAX_TIMEOUT_SECONDS,
  PROBE_MAX_TIMEOUT_SECONDS,
  maxTimeoutSeconds,
  raisableTimeoutCeiling,
} from "../../../src/core/modelTuning";
import { workspace } from "../support/vscodeStub";

/**
 * クラウドのAIの待ち時間の上限を、設定で延ばせるようにする
 * （作者の裁定「上げられるようにする」、2026-10-03）。
 *
 * 既定は600秒のまま。延ばせるのは測定の上限（1800秒）まで。
 */

const original = workspace.getConfiguration;

function useSetting(value: unknown): void {
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === CLOUD_TIMEOUT_CEILING_SETTING ? (value as T) : defaultValue,
  })) as typeof workspace.getConfiguration;
}

afterEach(() => {
  workspace.getConfiguration = original;
});

describe("クラウドのAIの待ち時間の上限", () => {
  test("設定が無ければ600秒のまま", () => {
    expect(maxTimeoutSeconds("gemini")).toBe(MAX_TIMEOUT_SECONDS);
  });

  test("設定で延ばした値が上限になる", () => {
    useSetting(1200);
    expect(maxTimeoutSeconds("gemini")).toBe(1200);
    expect(maxTimeoutSeconds("sakura")).toBe(1200);
  });

  test("600秒未満・1800秒超・数でない値は、その範囲に収める", () => {
    useSetting(100);
    expect(maxTimeoutSeconds("gemini")).toBe(MAX_TIMEOUT_SECONDS);
    useSetting(99999);
    expect(maxTimeoutSeconds("gemini")).toBe(PROBE_MAX_TIMEOUT_SECONDS);
    useSetting("長く");
    expect(maxTimeoutSeconds("gemini")).toBe(MAX_TIMEOUT_SECONDS);
  });

  test("手元のAIの上限（1800秒）は、この設定で変わらない", () => {
    useSetting(600);
    expect(maxTimeoutSeconds("ollama")).toBe(1800);
  });

  test("まだ延ばせるときだけ、延ばせる設定の名前を返す", () => {
    expect(raisableTimeoutCeiling("gemini")).toEqual({
      setting: `novelai.${CLOUD_TIMEOUT_CEILING_SETTING}`,
      maxSeconds: PROBE_MAX_TIMEOUT_SECONDS,
    });
    useSetting(1800);
    expect(raisableTimeoutCeiling("gemini")).toBeUndefined();
    // 手元のAIは設定で延ばす上限を持たない
    expect(raisableTimeoutCeiling("ollama")).toBeUndefined();
  });
});
