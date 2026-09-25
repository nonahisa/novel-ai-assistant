import { describe, expect, test, vi } from "vitest";
import { SettingsPanel } from "../../../src/features/settingsPanel";
import { emptyCharacter, type Character } from "../../../src/models/character";

/**
 * 「AIで再読込」の提案から、作品に無い話を挙げた値を落とす配線
 * （2026-09-25 精査 F5）。
 *
 * 作者の実機（2026-09-15）：2話しかない確認用の作品で「おばあさん」を
 * 再読込すると、gemma4:12b が「第17話を根拠に文佳の祖母」と返した。
 * 話数の読み方そのものは `core/chapterCitations.test.ts` で見る。ここで
 * 見るのは、**パネルが実際にその照合を通すか**と、**黙って落とさないか**。
 */

vi.mock("../../../src/ai/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/ai/registry")>();
  return {
    ...actual,
    ensureConfigured: async () => ({ model: "gemma4:12b" }),
  };
});

interface PanelInnards {
  work: { id: string; title: string; folderPath: string };
  characters: Character[];
  customFields: unknown[];
  excerptsFor(): Promise<Array<{ label: string; text: string }>>;
  describe(): string;
  generate(): Promise<string | undefined>;
  knownChapters(): Promise<Set<number>>;
  post(message: unknown): void;
  handleEnrich(kind: string, id: string, notes?: string): Promise<void>;
}

function panelAnswering(answer: object, known: number[]) {
  const posted: Array<Record<string, unknown>> = [];
  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "いじめられっ子_確認用", folderPath: "C:" };
  inner.characters = [
    { ...emptyCharacter("char_002", "おばあさん"), role: "霊媒師" },
  ];
  inner.customFields = [];
  inner.excerptsFor = async () => [
    { label: "第2話", text: "おばあさんは数珠を鳴らした。" },
  ];
  inner.describe = () => "名前: おばあさん\n役割: 霊媒師";
  inner.generate = async () => JSON.stringify(answer);
  inner.knownChapters = async () => new Set(known);
  inner.post = (message) => posted.push(message as Record<string, unknown>);
  return { inner, posted };
}

describe("AIで再読込：作品に無い話を挙げた提案", () => {
  test("第17話を挙げた役割は出さず、どの項目を除いたかを伝える", async () => {
    const { inner, posted } = panelAnswering(
      {
        role: "文佳の祖母（第17話）",
        summary: "プロの霊能者。太志を保護する（第2話から）。",
        misattributed: [],
      },
      [1, 2]
    );

    await inner.handleEnrich("character", "char_002", "文佳の祖母ではないです");

    const proposal = posted.find((message) => message.type === "proposal");
    expect(proposal).toBeDefined();
    const proposals = proposal?.proposals as Array<{ key: string; after: string }>;
    expect(proposals.map((entry) => entry.key)).toEqual(["summary"]);
    expect(String(proposal?.notice)).toContain("役割：第17話");
  });

  test("全部落ちたときも、落としたことを言う", async () => {
    const { inner, posted } = panelAnswering(
      { role: "文佳の祖母（第17話）", misattributed: [] },
      [1, 2]
    );

    await inner.handleEnrich("character", "char_002");

    const error = posted.find((message) => message.type === "error");
    expect(String(error?.message)).toContain("役割：第17話");
  });
});
