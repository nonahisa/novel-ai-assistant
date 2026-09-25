import { describe, expect, test, vi } from "vitest";
import { SettingsPanel } from "../../../src/features/settingsPanel";
import { emptyCharacter, type Character } from "../../../src/models/character";

/**
 * 「AIで再読込」に口調の欄を届ける（2026-09-26。設計書6.5.11 の
 * 「まだ届いていないところ」、残課題 R3）。
 *
 * 見るのは配線——口調の提案が項目として並ぶこと、指示の言葉の写しは
 * 抽出と同じ見張り（`isSpeechStyleEcho`）で落とし、黙って消さないこと。
 */

vi.mock("../../../src/ai/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/ai/registry")>();
  return {
    ...actual,
    ensureConfigured: async () => ({ model: "gemma4:26b" }),
  };
});

// 落としたものはログへ残す配線だが、試験では手元の作品フォルダーへ書かない
vi.mock("../../../src/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/logger")>();
  return { ...actual, useLogFile: () => undefined, logFailure: () => undefined };
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

function panelAnswering(answer: object) {
  const posted: Array<Record<string, unknown>> = [];
  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "確認用", folderPath: "C:" };
  inner.characters = [{ ...emptyCharacter("char_001", "少年"), role: "灯台の当番" }];
  inner.customFields = [];
  inner.excerptsFor = async () => [
    { label: "第2話", text: "「ぼくが灯を守ります」と少年は言った。" },
  ];
  inner.describe = () => "名前: 少年\n役割: 灯台の当番";
  inner.generate = async () => JSON.stringify(answer);
  inner.knownChapters = async () => new Set([1, 2]);
  inner.post = (message) => posted.push(message as Record<string, unknown>);
  return { inner, posted };
}

describe("AIで再読込：口調", () => {
  test("口調の提案が、口調の項目として並ぶ", async () => {
    const { inner, posted } = panelAnswering({
      speechStyle: "一人称は「ぼく」。丁寧に話す。",
      misattributed: [],
    });

    await inner.handleEnrich("character", "char_001");

    const proposal = posted.find((message) => message.type === "proposal");
    const proposals = proposal?.proposals as Array<{
      key: string;
      label: string;
      after: string;
      selected: boolean;
    }>;
    expect(proposals).toEqual([
      expect.objectContaining({
        key: "speechStyle",
        label: "口調",
        after: "一人称は「ぼく」。丁寧に話す。",
        // 空欄を埋める提案なので、既定で選ぶ（ほかの項目と同じ）
        selected: true,
      }),
    ]);
  });

  test("指示の言葉の写しは出さず、除いたことを伝える", async () => {
    const { inner, posted } = panelAnswering({
      speechStyle: "一人称・語尾・口癖",
      role: "灯台の見張り番",
      misattributed: [],
    });

    await inner.handleEnrich("character", "char_001");

    const proposal = posted.find((message) => message.type === "proposal");
    const proposals = proposal?.proposals as Array<{ key: string }>;
    expect(proposals.map((entry) => entry.key)).toEqual(["role"]);
    expect(String(proposal?.notice)).toContain("口調の提案は、指示の言葉をそのまま写したもの");
  });
});
