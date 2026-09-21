import { beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import { SettingsPanel } from "../../src/features/settingsPanel";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { RecordChange } from "../../src/models/jsonValidation";

/**
 * 誤って記録された変化を、設定資料パネルから落とす（作者の裁定、2026-09-21）。
 *
 * 実データ（『教科書チート』のターナ先生）で、抽出が話者を取り違えた。
 * 根拠は「**ターナ先生**。魔物の数がちょっと多いようなので…」——これは
 * ターナ先生への呼びかけで、話し手は別人である。女性の人物の第1話に
 * 「リーダー格の男性。」という変化が残り、それが編集部へ渡す
 * `設定/characters.md` の「変化（summary）」の先頭に出ていた。
 *
 * **落とす判断は作者がする。** ここで見るのは段取りだけ——選ばれたものが
 * 消えること、選ばなければ何も書かないこと、そして**資料集を作り直すこと**
 * （パネルの保存経路は設定JSONを書くだけで、読み物のMarkdownは作らない）。
 */

const { generated } = vi.hoisted(() => ({
  generated: [] as Array<{ kinds?: readonly string[]; silent?: boolean }>,
}));

// 資料集の生成はファイルを読み書きする。ここで見たいのは
// 「呼ばれたか・人物だけを指しているか」なので、呼び出しだけを控える
vi.mock("../../src/features/generateSettingsDocs", () => ({
  generateSettingsDocs: (
    _work: unknown,
    options: { kinds?: readonly string[]; silent?: boolean } = {}
  ) => {
    generated.push(options);
    return Promise.resolve();
  },
}));

function change(
  value: string,
  chapters: number[],
  overrides: Partial<RecordChange> = {}
): RecordChange {
  return {
    field: "summary",
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
    ...overrides,
  };
}

/** ターナ先生と同じ形。第1話が取り違え、第7話が正しい */
function misread(): Character {
  return {
    ...emptyCharacter("char_002", "ターナ先生"),
    summary: "学院の教師。生徒を導く。",
    gender: "女性",
    appearedChapters: [1, 7],
    changes: [
      change("リーダー格の男性。仲間を指揮し、リナ救出を依頼する。", [1], {
        evidence: "ターナ先生。魔物の数がちょっと多いようなので……",
      }),
      change("学院の教師。生徒を導く。", [7]),
    ],
  };
}

interface PanelInnards {
  work: { id: string; title: string; folderPath: string };
  characters: Character[];
  persist(kind: string, record: Character): Promise<void>;
  reloadAfterSave(kind: string, id: string, notice: string): Promise<void>;
  post(message: unknown): void;
  handleDropChanges(id: string, field: string): Promise<void>;
}

function panelWith(character: Character) {
  const saved: Character[] = [];
  const notices: string[] = [];
  const posted: Array<{ type: string; message?: string }> = [];

  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "教科書チート", folderPath: "C:" };
  inner.characters = [character];
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

/** 選択画面の代役。並んだ選択肢を控えつつ、決まったものを選んだ体にする */
function choosing(pick: (items: readonly PickItem[]) => unknown): PickItem[][] {
  const shown: PickItem[][] = [];
  (
    vscode.window as unknown as {
      showQuickPick: (items: unknown, options?: unknown) => Promise<unknown>;
    }
  ).showQuickPick = async (items: unknown) => {
    const list = items as PickItem[];
    shown.push(list);
    return pick(list);
  };
  return shown;
}

interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  key: string;
}

beforeEach(() => {
  generated.length = 0;
});

describe("誤って記録された変化を落とす（設定資料パネル）", () => {
  test("選んだ記録だけが消え、資料集まで作り直す", async () => {
    const { inner, saved, notices } = panelWith(misread());
    choosing((items) => [items[0]]);

    await inner.handleDropChanges("char_002", "summary");

    expect(saved).toHaveLength(1);
    expect(saved[0].changes.map((entry) => entry.value)).toEqual([
      "学院の教師。生徒を導く。",
    ]);
    // 本体の項目は触らない。作者がすでに直している（CLAUDE.md 規則2）
    expect(saved[0].summary).toBe("学院の教師。生徒を導く。");
    expect(saved[0].gender).toBe("女性");
    // 黙って落としたことにしない。件数を伝える
    expect(notices[0]).toContain("1件");
    // 誤りが出るのは資料集のほう。人物のぶんだけ作り直す
    expect(generated).toEqual([{ kinds: ["characters"], silent: true }]);
  });

  test("選択肢には、値・話数・抽出根拠が並ぶ", async () => {
    const { inner } = panelWith(misread());
    const shown = choosing(() => undefined);

    await inner.handleDropChanges("char_002", "summary");

    expect(shown[0].map((item) => item.label)).toEqual([
      "リーダー格の男性。仲間を指揮し、リナ救出を依頼する。",
      "学院の教師。生徒を導く。",
    ]);
    expect(shown[0][0].description).toContain("第1話");
    // 取り違えに気づく手掛かりは根拠にしかない（呼びかけの台詞だった）
    expect(shown[0][0].detail).toContain("ターナ先生。魔物の数が");
  });

  test("何も選ばずに閉じたら、保存も作り直しもしない", async () => {
    const { inner, saved, notices } = panelWith(misread());
    choosing(() => undefined);

    await inner.handleDropChanges("char_002", "summary");

    expect(saved).toEqual([]);
    expect(notices).toEqual([]);
    expect(generated).toEqual([]);
  });

  test("落とす記録が無い項目なら、何も壊さずに伝えるだけ", async () => {
    const { inner, saved, notices } = panelWith(misread());
    const shown = choosing((items) => items.slice(0, 1));

    await inner.handleDropChanges("char_002", "appearance");

    // 選択画面すら出さない（押しても何も起きない、という見え方を避ける）
    expect(shown).toEqual([]);
    expect(saved).toEqual([]);
    expect(notices[0]).toContain("落とせる変化の記録はありません");
    expect(generated).toEqual([]);
  });

  test("選んでいる間に人物が消えていても、落ちずに伝える", async () => {
    const { inner, posted } = panelWith(misread());
    choosing((items) => [items[0]]);

    await inner.handleDropChanges("char_999", "summary");

    expect(posted[0]).toMatchObject({ type: "error" });
    expect(generated).toEqual([]);
  });

  test("同じ話・同じ値が二重にあっても、1つの選択肢としてまとめて落ちる", async () => {
    const character = misread();
    // 実データで起きた二重記録（0.60.x で表示側は畳んだが、台帳には残る）
    character.changes = [
      change("リーダー格の男性。", [1]),
      change("リーダー格の男性。", [1]),
      change("学院の教師。", [7]),
    ];
    const { inner, saved } = panelWith(character);
    const shown = choosing((items) => [items[0]]);

    await inner.handleDropChanges("char_002", "summary");

    expect(shown[0]).toHaveLength(2);
    expect(saved[0].changes.map((entry) => entry.value)).toEqual([
      "学院の教師。",
    ]);
  });
});
