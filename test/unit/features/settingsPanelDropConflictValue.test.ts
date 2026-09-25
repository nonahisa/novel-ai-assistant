import { beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsPanel } from "../../../src/features/settingsPanel";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { buildSettingsPanelHtml } from "../../../src/views/settingsPanelHtml";

/**
 * 資料の食い違いを「誤り」として一度で落とす（作者の裁定、2026-09-26 深夜）。
 *
 * **再現**：これまでは［作中の変化として記録］→ 変化の行の［誤りを落とす］の
 * 2手が要った（0.89.5 の F4 の担当の報告）。食い違いの行に、値ごとの
 * ［「…」は誤り（落とす）］を置き、押した1回で落とす。
 *
 * ここで見るのは段取り——札が値ごとに並ぶこと、押した値だけが落ちること、
 * 資料集を作り直すこと、黙って消さずに「誤りとして落とした値」に残ること。
 */

const { generated } = vi.hoisted(() => ({
  generated: [] as Array<{ kinds?: readonly string[]; silent?: boolean }>,
}));

vi.mock("../../../src/features/generateSettingsDocs", () => ({
  generateSettingsDocs: (
    _work: unknown,
    options: { kinds?: readonly string[]; silent?: boolean } = {}
  ) => {
    generated.push(options);
    return Promise.resolve();
  },
}));

/** 精査 F4 と同じ形：同じ第3話から、別人（エルシー）の記述が混ざった */
function mixedUp(): Character {
  return {
    ...emptyCharacter("char_002", "プラム"),
    summary: "明るい見習い魔法使い。",
    appearedChapters: [3],
    conflicts: [
      {
        field: "summary",
        values: ["明るい見習い魔法使い。", "寡黙な騎士。"],
        chapters: [3],
        note: null,
        observations: [
          { value: "明るい見習い魔法使い。", chapters: [3] },
          {
            value: "寡黙な騎士。",
            chapters: [3],
            evidence: "エルシーは黙って剣を抜いた。",
            resembles: "エルシー",
          },
        ],
      },
    ],
  };
}

interface ReferenceLine {
  label: string;
  value: string;
  action?: { kind: string };
  valueActions?: Array<{
    label: string;
    title: string;
    field: string;
    value: string;
    kind: string;
  }>;
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
  handleDropConflictValue(id: string, field: string, value: string): Promise<void>;
}

function panelWith(character: Character) {
  const saved: Character[] = [];
  const notices: string[] = [];
  const posted: Array<{ type: string; message?: string }> = [];

  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "教科書チート", folderPath: "C:" };
  inner.characters = [character];
  inner.abilities = [];
  inner.organizations = [];
  inner.locations = [];
  inner.worldItems = [];
  inner.customFields = [];
  inner.showAllAddresses = false;
  inner.persist = async (_kind, record) => {
    saved.push(record);
  };
  inner.reloadAfterSave = async (_kind, _id, notice) => {
    notices.push(notice);
  };
  inner.post = (message) => {
    posted.push(message as { type: string; message?: string });
  };
  return { inner, saved, notices, posted };
}

beforeEach(() => {
  generated.length = 0;
});

describe("食い違いの行に「こちらは誤り」を値ごとに置く", () => {
  test("値ごとに札が並び、押すと送る値は札の文字ではなく値そのもの", () => {
    const { inner } = panelWith(mixedUp());

    const line = inner
      .detailOf("character", "char_002")!
      .reference.find((entry) => entry.label === "変化かもしれない（summary）");

    // 昇格の札はこれまでどおり残る（作中で変わったと読むなら、そちら）
    expect(line?.action?.kind).toBe("promoteConflict");
    expect(line?.valueActions?.map((action) => action.value)).toEqual([
      "明るい見習い魔法使い。",
      "寡黙な騎士。",
    ]);
    expect(line?.valueActions?.[1]).toMatchObject({
      kind: "dropConflictValue",
      field: "summary",
      label: "「寡黙な騎士。」は誤り（落とす）",
    });
  });

  test("長い値は札に頭だけ出し、全文は指を載せると出る", () => {
    const character = mixedUp();
    const long = "学院で最も古い図書館の司書を務める、物静かな老魔法使い。";
    character.conflicts[0].values[1] = long;
    character.conflicts[0].observations![1].value = long;
    const { inner } = panelWith(character);

    const action = inner
      .detailOf("character", "char_002")!
      .reference.find((entry) => entry.valueActions)!.valueActions![1];

    // 頭の12字だけ（札が横へ伸びて、行の値を押し流さないように）
    expect(action.label).toBe("「学院で最も古い図書館の司…」は誤り（落とす）");
    expect(action.title).toContain(long);
    expect(action.value).toBe(long);
  });

  test("落とした値は「誤りとして落とした値」の行に残る（黙って消したことにしない）", () => {
    const character = mixedUp();
    character.conflicts = [];
    character.rejectedValues = [
      { field: "summary", value: "寡黙な騎士。", chapters: [3], rejectedAt: "x" },
    ];
    const { inner } = panelWith(character);

    const line = inner
      .detailOf("character", "char_002")!
      .reference.find((entry) => entry.label === "誤りとして落とした値（summary）");

    expect(line?.value).toBe("寡黙な騎士。（第3話）");
  });
});

describe("押した1回で落とす", () => {
  test("押した値だけが落ち、本体はそのまま、資料集まで作り直す", async () => {
    const { inner, saved, notices } = panelWith(mixedUp());

    await inner.handleDropConflictValue("char_002", "summary", "寡黙な騎士。");

    expect(saved).toHaveLength(1);
    expect(saved[0].conflicts).toEqual([]);
    // 本体は作者の値のまま（CLAUDE.md 規則2）
    expect(saved[0].summary).toBe("明るい見習い魔法使い。");
    expect(saved[0].rejectedValues).toMatchObject([
      {
        field: "summary",
        value: "寡黙な騎士。",
        chapters: [3],
        evidence: "エルシーは黙って剣を抜いた。",
      },
    ]);
    expect(notices[0]).toContain("誤りとして落としました");
    expect(notices[0]).toContain("誤りとして落とした値");
    expect(generated).toEqual([{ kinds: ["characters"], silent: true }]);
  });

  test("本体の値を誤りとしたら、残った値を欄に入れたと伝える", async () => {
    const { inner, saved, notices } = panelWith(mixedUp());

    await inner.handleDropConflictValue(
      "char_002",
      "summary",
      "明るい見習い魔法使い。"
    );

    expect(saved[0].summary).toBe("寡黙な騎士。");
    expect(notices[0]).toContain("欄は「寡黙な騎士。」にしました");
  });

  test("もう無い値（別の窓で先に落とした）なら、何も書かずに伝える", async () => {
    const { inner, saved, notices } = panelWith(mixedUp());

    await inner.handleDropConflictValue("char_002", "summary", "金髪");

    expect(saved).toEqual([]);
    expect(generated).toEqual([]);
    expect(notices[0]).toContain("その値はもうありません");
  });

  test("人物が消えていても、落ちずに伝える", async () => {
    const { inner, posted } = panelWith(mixedUp());

    await inner.handleDropConflictValue("char_999", "summary", "寡黙な騎士。");

    expect(posted[0]).toMatchObject({ type: "error" });
    expect(generated).toEqual([]);
  });
});

describe("画面の札", () => {
  const html = buildSettingsPanelHtml("test-nonce", "vscode-resource:");

  test("値ごとの札は、拡張機能が組んだ種別と値をそのまま送る", () => {
    expect(html).toContain("entry.valueActions");
    expect(html).toContain("post(valueAction.kind");
    expect(html).toContain("value: valueAction.value");
    // 長い値の全文を、指を載せたときに出す
    expect(html).toContain("valueButton.title = valueAction.title");
  });
});
