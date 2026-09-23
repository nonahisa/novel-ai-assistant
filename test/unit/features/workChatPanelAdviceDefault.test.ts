import { describe, expect, test, vi } from "vitest";
import type * as vscode from "vscode";
import { AdvicePolicyStore } from "../../../src/core/advicePolicyStore";
import { scoreAnswers, type AdviceProfile } from "../../../src/core/advicePolicy";
import type { WorkEntry } from "../../../src/models/types";

/**
 * **作品が決まらない相談にも、作者の既定の助言方針を乗せる**（点検、2026-09-23）。
 *
 * 以前は `buildSystemPrompt` の条件が「作品があるとき」だけで、作品を
 * 開いていない相談（使い方を聞く・作品を決める前の相談）では、作者が
 * 答えた9問が一度も効かなかった。執筆スタイル（作者ごと）は作品が無くても
 * 乗るので、方針だけ抜けていた。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

/** `vscode.Memento` の代役 */
function memento(): vscode.Memento {
  const box = new Map<string, unknown>();
  return {
    keys: () => [...box.keys()],
    get: <T>(key: string, fallback?: T) =>
      (box.has(key) ? box.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) box.delete(key);
      else box.set(key, value);
    },
  } as vscode.Memento;
}

const ANSWERS = [2, 2, 2, 0, 0, 0, 0, 0, 0];
const PROFILE: AdviceProfile = {
  scores: scoreAnswers(ANSWERS),
  answers: ANSWERS,
  updatedAt: "2026-09-13T00:00:00.000Z",
};

const POLICY_HEADING = "【この作者への助言の方針】";

/** 試験から見る口（`buildSystemPrompt` は private） */
interface PromptBuilder {
  buildSystemPrompt(
    work: WorkEntry | undefined,
    featureIndex: boolean,
    question: string
  ): Promise<string>;
}

function panelWith(policies: AdvicePolicyStore): PromptBuilder {
  const registry = { list: () => [] };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
  };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2],
    policies
  );
  return panel as unknown as PromptBuilder;
}

describe("作品が決まらない相談の助言方針", () => {
  test("作者の既定があれば、作品が無くても乗る", async () => {
    const policies = new AdvicePolicyStore(memento());
    await policies.setDefault(PROFILE);

    const prompt = await panelWith(policies).buildSystemPrompt(
      undefined,
      false,
      "書き出しに迷っています"
    );

    expect(prompt).toContain(POLICY_HEADING);
  });

  test("既定も無ければ、何も足さない（推測で埋めない）", async () => {
    const policies = new AdvicePolicyStore(memento());

    const prompt = await panelWith(policies).buildSystemPrompt(
      undefined,
      false,
      "書き出しに迷っています"
    );

    expect(prompt).not.toContain(POLICY_HEADING);
  });
});
