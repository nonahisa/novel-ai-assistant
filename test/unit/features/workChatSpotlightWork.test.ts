import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "vscode";
import type { WorkEntry } from "../../../src/models/types";
import type {
  ActionSpotlight,
  SpotlightOptions,
  SpotlightResult,
} from "../../../src/features/actionSpotlight";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * 相談から光らせるときに、相談の作品を添えているか（作者の報告、2026-10-31）。
 *
 * 相談の作品は「教科書チート」だったのに、答えの「▶ 光らせる」で示された
 * 簡単ステップメニューの項目を押すと、別の作品「たゆたう鉛実験用」で走った。
 * 作品を合わせる仕組みそのものは `actionSpotlight.test.ts` が見る。ここでは
 * **相談の3つの入口（答えからの自動・札・案内の段）が作品を添えて呼ぶか**と、
 * 合わせたことを会話に1行出すかを見る。
 */

const response = vi.hoisted(() => ({ text: "" }));

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_textbook",
  title: "教科書チート",
  folderPath: "C:\\novels\\w_textbook",
  registeredAt: "2026-10-31T00:00:00.000Z",
};

interface Posted {
  type: string;
  message?: string;
}

/** 呼ばれ方を溜め、「合わせた」と答える光らせ役 */
function fakeSpotlight(): ActionSpotlight & {
  calls: Array<{ command: string; options?: SpotlightOptions }>;
} {
  const calls: Array<{ command: string; options?: SpotlightOptions }> = [];
  return {
    calls,
    async show(command, options): Promise<SpotlightResult> {
      calls.push({ command, options });
      return {
        shown: true,
        view: "steps",
        alignedWork: { id: WORK.id, title: WORK.title },
      };
    },
    clear: () => undefined,
  };
}

function harness(): {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
  spotlight: ReturnType<typeof fakeSpotlight>;
} {
  const posted: Posted[] = [];
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({ text: response.text }),
      },
      model: "gemma4:26b",
    }),
  };
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as never,
    ai as never,
    { run: async () => undefined } as never
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Posted) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as never);
  const spotlight = fakeSpotlight();
  panel.setTourSpotlight(spotlight);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = panel as any;
  inner.selectedWorkId = WORK.id;
  inner.findRelated = async () => ({ reference: [], searchTerms: [], materials: [] });
  inner.resolveContext = async () => ({
    work: WORK,
    kind: "workOnly",
    filePath: WORK.folderPath,
    label: WORK.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });
  return { panel, posted, spotlight };
}

const ALIGNED = "相談の作品「教科書チート」に合わせました";

const originalConfig = workspace.getConfiguration;
beforeEach(async () => {
  await useMemoryTuningStore({});
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
    update: async () => undefined,
  })) as unknown as typeof workspace.getConfiguration;
});
afterEach(() => {
  workspace.getConfiguration = originalConfig;
});

describe("相談から光らせるときは、相談の作品を添える", () => {
  test("答えで名指しされた項目を光らせるとき（再現）", async () => {
    response.text = JSON.stringify({
      reply: "簡単ステップメニューの「矛盾検知」を押してください。",
      options: [],
      needFiles: [],
      run: null,
    });
    const h = harness();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.panel as any).ask("矛盾を調べたいのですが、どこから？");

    expect(h.spotlight.calls.length, "光らせていない").toBeGreaterThan(0);
    expect(h.spotlight.calls[0].options?.workId).toBe(WORK.id);
    // 合わせたことは、答えのあとに1行出す
    const answerAt = h.posted.findIndex((m) => m.type === "answer");
    const noteAt = h.posted.findIndex(
      (m) => m.type === "note" && m.message?.includes(ALIGNED)
    );
    expect(noteAt, "合わせたことを伝えていない").toBeGreaterThan(answerAt);
  });

  test("「▶ 光らせる」の札を押したとき", async () => {
    const h = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.panel as any).spotlightCommand("novelai.checkContradictions");

    expect(h.spotlight.calls[0]?.options?.workId).toBe(WORK.id);
    expect(
      h.posted.some((m) => m.type === "note" && m.message?.includes(ALIGNED))
    ).toBe(true);
  });

  test("案内の段を光らせるとき", async () => {
    const h = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tourSpotlight = (h.panel as any).tour.spotlight as ActionSpotlight;
    await tourSpotlight.show("novelai.checkContradictions");

    expect(h.spotlight.calls[0]?.options?.workId).toBe(WORK.id);
  });
});
