import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsPanel } from "../../../src/features/settingsPanel";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { window } from "../support/vscodeStub";

/**
 * 設定資料パネルの「口調の変化」から、第N話から口調が変わったと記録する
 * （作者の裁定、2026-09-26 夕。残課題 J9）。
 */
vi.mock("../../../src/features/generateSettingsDocs", () => ({
  generateSettingsDocs: () => Promise.resolve(),
}));

interface ReferenceLine {
  label: string;
  value: string;
  action?: { kind: string; label: string };
}

interface PanelInnards {
  work: { id: string; title: string; folderPath: string };
  characters: Character[];
  abilities: unknown[];
  organizations: unknown[];
  locations: unknown[];
  worldItems: unknown[];
  customFields: unknown[];
  showAllAddresses: boolean;
  persist(kind: string, record: Character): Promise<void>;
  reloadAfterSave(kind: string, id: string, notice: string): Promise<void>;
  post(message: unknown): void;
  detailOf(kind: string, id: string): { reference: ReferenceLine[] } | undefined;
  handleMarkSpeechStyleChange(id: string): Promise<void>;
}

function speaker(): Character {
  return {
    ...emptyCharacter("char_001", "ミナ"),
    speechStyle: "敬語",
    speechStyleFacets: [{ value: "敬語", chapters: [1], evidence: "おはようございます" }],
    appearedChapters: [1, 8],
  };
}

function panelWith(character: Character) {
  const saved: Array<{ kind: string; record: Character }> = [];
  const notices: string[] = [];
  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "試し", folderPath: "C:" };
  inner.characters = [character];
  inner.abilities = [];
  inner.organizations = [];
  inner.locations = [];
  inner.worldItems = [];
  inner.customFields = [];
  inner.showAllAddresses = false;
  inner.persist = async (kind, record) => {
    saved.push({ kind, record });
  };
  inner.reloadAfterSave = async (_kind, _id, notice) => {
    notices.push(notice);
  };
  inner.post = () => undefined;
  return { inner, saved, notices };
}

const originalInputBox = window.showInputBox;
afterEach(() => {
  window.showInputBox = originalInputBox;
});

function answer(...replies: Array<string | undefined>): void {
  let index = 0;
  window.showInputBox = async () => replies[index++];
}

describe("口調の変化を記録する（J9）", () => {
  test("口調のある人物に「口調の変化」の行と操作が出る", () => {
    const { inner } = panelWith(speaker());
    const line = inner
      .detailOf("character", "char_001")!
      .reference.find((entry) => entry.label === "口調の変化");
    expect(line?.action?.kind).toBe("markSpeechStyleChange");
  });

  test("口調の欄も面も空の人物には出さない", () => {
    const { inner } = panelWith(emptyCharacter("char_009", "通行人"));
    const line = inner
      .detailOf("character", "char_009")!
      .reference.find((entry) => entry.label === "口調の変化");
    expect(line).toBeUndefined();
  });

  test("話数と口調を入れると、作者の記録として人物の台帳へ保存する", async () => {
    const { inner, saved, notices } = panelWith(speaker());
    // 全角の話数でも受ける
    answer("第８話", "ため口");

    await inner.handleMarkSpeechStyleChange("char_001");

    expect(saved).toHaveLength(1);
    expect(saved[0].kind).toBe("character");
    const speech = saved[0].record.changes.filter(
      (change) => change.field === "speechStyle"
    );
    expect(speech).toEqual([
      expect.objectContaining({ value: "敬語", chapters: [7], source: "author" }),
      expect.objectContaining({ value: "ため口", chapters: [8], source: "author" }),
    ]);
    // 本体・作者の欄は変えない
    expect(saved[0].record.speechStyle).toBe("敬語");
    expect(saved[0].record.authorNotes).toBe("");
    expect(notices[0]).toContain("第8話から「ため口」");
  });

  test("途中で取りやめれば何も保存しない", async () => {
    const { inner, saved } = panelWith(speaker());
    answer("8", undefined);

    await inner.handleMarkSpeechStyleChange("char_001");

    expect(saved).toEqual([]);
  });
});
