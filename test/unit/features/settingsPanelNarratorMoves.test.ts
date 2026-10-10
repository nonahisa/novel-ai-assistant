import { describe, expect, test, vi } from "vitest";
import {
  NARRATOR_MOVE_PREFIX,
  SettingsPanel,
  narratorMoveChoicesOf,
  narratorMoveProposal,
} from "../../../src/features/settingsPanel";
import { findNarratorMoves, type NarratorMoveItem } from "../../../src/core/narratorMoves";
import type { WorkNarratorContext } from "../../../src/core/sceneNarrators";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";
import "../support/vscodeStub";

/**
 * 設定資料パネルの「AIで再読込」に並ぶ、語り手の取り違えの移す案
 * （作者の裁定 2026-10-10「殿下の資料へ移す案」。設計書6.5.12）。
 * 承認したときだけ動き、移し先を先に・主人公をあとに保存する。
 */
vi.mock("../../../src/features/generateSettingsDocs", () => ({
  generateSettingsDocs: () => Promise.resolve(),
}));

const PRINCE_SCENE =
  "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
  "「これは経済の基本です。殿下、聞いていますか」\n" +
  "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
const HERO_SCENE = "　俺は串焼きを頬張った。旨い。\n　俺はもう一本頼むことにした。\n";
const SOURCES = [
  { label: "第10話", text: HERO_SCENE, chapter: 10 },
  { label: "第12話", text: PRINCE_SCENE, chapter: 12 },
];

function change(field: string, value: string, chapters: number[]): RecordChange {
  return { field, value, chapters, timepointId: null, note: null, evidence: null, source: "extracted" };
}

function hero(): Character {
  return {
    ...emptyCharacter("char_007", "アジャーノ"),
    affiliation: "皇室",
    firstPerson: { default: "俺", variants: [] },
    changes: [change("affiliation", "冒険者ギルド", [10]), change("affiliation", "皇室", [12])],
    appearedChapters: [10, 12],
  };
}
const EMPEROR: Character = {
  ...emptyCharacter("char_012", "皇帝"),
  firstPerson: { default: "余", variants: [] },
  appearedChapters: [12],
};
const PRINCE = emptyCharacter("char_016", "殿下");

function contextOf(people: Character[]): WorkNarratorContext {
  return {
    narrator: { firstPerson: "俺", name: "アジャーノ" },
    narratorNames: ["アジャーノ"],
    people,
  };
}

interface PanelInnards {
  work: { id: string; title: string; folderPath: string };
  characters: Character[];
  abilities: unknown[];
  organizations: unknown[];
  locations: unknown[];
  worldItems: unknown[];
  customFields: unknown[];
  narratorMoves: { recordId: string; items: NarratorMoveItem[] } | undefined;
  characterStore: { saveOrUpdate(record: Character): Promise<void> };
  persist(kind: string, record: Character): Promise<void>;
  reloadAfterSave(kind: string, id: string, notice: string): Promise<void>;
  post(message: unknown): void;
  handleApplyProposal(message: {
    type: "applyProposal";
    kind: "character";
    id: string;
    values: Record<string, string>;
  }): Promise<void>;
}

function panel() {
  const people = [hero(), EMPEROR, PRINCE];
  const items = findNarratorMoves(people[0], contextOf(people), SOURCES);
  const writes: Array<{ via: string; record: Character }> = [];
  const notices: string[] = [];
  const inner = Object.create(SettingsPanel.prototype) as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "試し", folderPath: "C:" };
  inner.characters = people;
  inner.abilities = [];
  inner.organizations = [];
  inner.locations = [];
  inner.worldItems = [];
  inner.customFields = [];
  inner.narratorMoves = { recordId: "char_007", items };
  inner.characterStore = {
    saveOrUpdate: async (record) => {
      writes.push({ via: "saveOrUpdate", record });
    },
  };
  inner.persist = async (_kind, record) => {
    writes.push({ via: "persist", record });
  };
  inner.reloadAfterSave = async (_kind, _id, notice) => {
    notices.push(notice);
  };
  inner.post = () => undefined;
  return { inner, items, writes, notices };
}

function keyOf(items: NarratorMoveItem[], value: string): string {
  const index = items.findIndex((item) => item.value === value);
  if (index < 0) throw new Error(`案が無い：${value}`);
  return `${NARRATOR_MOVE_PREFIX}${index}`;
}

describe("移す案の行", () => {
  test("既定では選ばず、移し先の候補と「外すだけ」を並べる", () => {
    const { items } = panel();
    const row = narratorMoveProposal(items[0], 0);
    expect(row).toMatchObject({
      key: "narratorMove:0",
      label: "移す案：所属「皇室」（第12話）",
      before: "皇室（第12話）",
      selected: false,
      // 名指しできない（皇帝は場面に出ない）ので既定は外すだけ
      after: "",
      destinations: [
        { id: "char_016", name: "「殿下」へ移す" },
        { id: "", name: "外すだけ（どこにも移さない）" },
      ],
    });
  });

  test("候補に無い移し先・控えに無い位置は通さない", () => {
    const { items } = panel();
    const key = keyOf(items, "皇室");
    expect(narratorMoveChoicesOf({ [key]: "char_012" }, items)).toEqual([]);
    expect(narratorMoveChoicesOf({ "narratorMove:99": "char_016" }, items)).toEqual([]);
    expect(narratorMoveChoicesOf({ [key]: "" }, items)).toEqual([
      { item: items[0], destinationId: null },
    ]);
  });
});

describe("反映", () => {
  test("選んだ移す案だけを動かす。移し先を先に、主人公をあとに保存する", async () => {
    const { inner, items, writes, notices } = panel();
    await inner.handleApplyProposal({
      type: "applyProposal",
      kind: "character",
      id: "char_007",
      values: { [keyOf(items, "皇室")]: "char_016" },
    });
    expect(writes.map((entry) => `${entry.via}:${entry.record.name}`)).toEqual([
      "saveOrUpdate:殿下",
      "persist:アジャーノ",
    ]);
    expect(writes[0].record.affiliation).toBe("皇室");
    expect(writes[1].record.affiliation).toBe("冒険者ギルド");
    // 選ばなかった登場話の案は動かない
    expect(writes[1].record.appearedChapters).toEqual([10, 12]);
    expect(notices[0]).toContain("1 件を「殿下」の資料へ移しました。");
  });

  test("移す案を選ばなければ、移し先にも主人公の値にも触れない", async () => {
    const { inner, writes } = panel();
    await inner.handleApplyProposal({
      type: "applyProposal",
      kind: "character",
      id: "char_007",
      values: { summary: "冒険者" },
    });
    expect(writes.map((entry) => entry.via)).toEqual(["persist"]);
    expect(writes[0].record.affiliation).toBe("皇室");
    expect(writes[0].record.summary).toBe("冒険者");
  });

  test("別の人物の案の控えでは動かさない（古い画面から届いた鍵）", async () => {
    const { inner, items, writes } = panel();
    inner.narratorMoves = { recordId: "char_999", items };
    await inner.handleApplyProposal({
      type: "applyProposal",
      kind: "character",
      id: "char_007",
      values: { [keyOf(items, "皇室")]: "char_016" },
    });
    expect(writes.map((entry) => entry.via)).toEqual(["persist"]);
    expect(writes[0].record.affiliation).toBe("皇室");
  });
});
