import { describe, expect, test } from "vitest";
import { SettingsPanel } from "../../../src/features/settingsPanel";
import { findMergeCandidates } from "../../../src/core/characterMerge";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { buildSettingsPanelHtml } from "../../../src/views/settingsPanelHtml";

/**
 * 設定資料パネルの登場人物タブで、重複の候補を一覧から片づける
 * （作者の依頼と裁定 2026-10-19 夜「一回ごとにメニューが出るのはツライ」。設計書6.5.4）。
 *
 * ここで見るのは受け口——押した組の「残す名前」「別人」が core へ正しく渡ること、
 * 押したあとに候補が1組ずつ減ること、0組なら欄を出さないこと、確認の窓を出さないこと。
 * 書く順番そのものは `core/characterPairDecision.test.ts` が見ている。
 */

function person(id: string, name: string, overrides: Partial<Character> = {}): Character {
  return { ...emptyCharacter(id, name), ...overrides };
}

/** E2E（`test/e2e/settingsMergeCandidates.test.ts`）と同じ顔ぶれ：候補がちょうど3組 */
function threePairs(): Character[] {
  return [
    person("char_001", "ギルドマスター"),
    person("char_002", "ギルマス"),
    person("char_003", "三門太志"),
    person("char_004", "太志"),
    person("char_005", "近所のおばあさん"),
    person("char_006", "ばあさん"),
  ];
}

interface MergeView {
  ids: [string, string];
  names: [string, string];
  labels: [string, string];
  reason: string;
  distinctRefusal: string | null;
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
  characterLoadErrors: Array<{ file: string; message: string }>;
  mergeBusy: boolean;
  characterStore: unknown;
  loadAll(): Promise<void>;
  post(message: unknown): void;
  discardPendingFor(id: string): Promise<void>;
  mergeCandidateViews(): MergeView[];
  handleUnifyPair(keepId: string, absorbId: string, selectedId?: string): Promise<void>;
  handleDistinctPair(ids: [string, string], selectedId?: string): Promise<void>;
}

/**
 * 人物をディスクの代わりに記憶で持つパネル。退避で消え、保存で入る。
 * `loadAll` はその記憶を読み直す（製品も書いたあとに必ず読み直す）
 */
function panelWith(initial: Character[]) {
  let disk = new Map(initial.map((c) => [c.id, c]));
  const calls: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const discarded: string[] = [];

  const panel = Object.create(SettingsPanel.prototype) as SettingsPanel;
  const inner = panel as unknown as PanelInnards;
  inner.work = { id: "w-1", title: "見本の作品", folderPath: "C:" };
  inner.characters = [...disk.values()];
  inner.abilities = [];
  inner.organizations = [];
  inner.locations = [];
  inner.worldItems = [];
  inner.customFields = [];
  inner.showAllAddresses = false;
  inner.characterLoadErrors = [];
  inner.mergeBusy = false;
  inner.characterStore = {
    async retire(id: string): Promise<string> {
      calls.push(`retire:${id}`);
      disk.delete(id);
      return `C:/設定/characters/.novelai-recovery/${id}.json`;
    },
    async save(character: Character): Promise<void> {
      calls.push(`save:${character.id}`);
      disk.set(character.id, character);
    },
    async saveOrUpdate(character: Character): Promise<void> {
      calls.push(`saveOrUpdate:${character.id}`);
      disk.set(character.id, character);
    },
  };
  inner.loadAll = async () => {
    inner.characters = [...disk.values()];
  };
  inner.post = (message) => {
    posted.push(message as Record<string, unknown>);
  };
  inner.discardPendingFor = async (id) => {
    discarded.push(id);
  };
  return {
    inner,
    calls,
    posted,
    discarded,
    disk: () => disk,
    replaceDisk: (next: Character[]) => {
      disk = new Map(next.map((c) => [c.id, c]));
    },
  };
}

describe("候補の欄に出すもの", () => {
  test("見本の顔ぶれは、ちょうど3組の候補になる（E2E の台を固める）", () => {
    // E2E は走らせずに置くので、台そのものがずれていないことをここで見張る
    const pairs = findMergeCandidates(threePairs()).map((candidate) => candidate.ids);
    expect(pairs).toEqual([
      ["char_001", "char_002"],
      ["char_003", "char_004"],
      ["char_005", "char_006"],
    ]);
  });

  test("1組ごとに両方の名前と手掛かりを出し、同じ名前なら id を添える", () => {
    const { inner } = panelWith([
      ...threePairs(),
      person("char_007", "お母さん"),
      person("char_008", "お母さん"),
    ]);

    const views = inner.mergeCandidateViews();

    expect(views).toHaveLength(4);
    expect(views[0]).toMatchObject({
      ids: ["char_001", "char_002"],
      names: ["ギルドマスター", "ギルマス"],
      labels: ["ギルドマスター", "ギルマス"],
      distinctRefusal: null,
    });
    expect(views[0].reason).toContain("省略形");
    const mothers = views.find((view) => view.ids.includes("char_007"));
    expect(mothers?.labels).toEqual(["お母さん（char_007）", "お母さん（char_008）"]);
    // 同じ名前の組には［別人］を出さず、理由を出す（押せない札を並べない）
    expect(mothers?.distinctRefusal).toContain("書き分けてください");
  });

  test("候補が0組なら空（画面は欄ごと出さない）", () => {
    const { inner } = panelWith([person("char_001", "密倉文佳"), person("char_002", "春原月夜")]);
    expect(inner.mergeCandidateViews()).toEqual([]);
  });

  test("読み込めない人物のファイルがあれば、候補を出さない（読めていない人物を見落とす）", () => {
    const { inner } = panelWith(threePairs());
    inner.characterLoadErrors = [{ file: "char_099.json", message: "壊れています" }];
    expect(inner.mergeCandidateViews()).toEqual([]);
  });
});

describe("［「A」を残してまとめる］", () => {
  test("押した「残す名前」の人物を残す側として core へ渡し、候補が1組減る", async () => {
    const { inner, calls, posted, disk } = panelWith(threePairs());

    // 「ギルマス」を残す（並びの2人目を残す側にしても、取り違えない）
    await inner.handleUnifyPair("char_002", "char_001");

    expect(calls).toEqual(["retire:char_002", "save:char_002", "retire:char_001"]);
    expect(disk().get("char_002")?.aliases).toContain("ギルドマスター");
    expect(disk().has("char_001")).toBe(false);

    const resolved = posted.find((message) => message.type === "mergeResolved");
    expect(resolved?.band).toContain("「ギルドマスター」を「ギルマス」にまとめました");
    // 戻す道を帯に書く（既存の「別の人物に分ける」）
    expect(resolved?.band).toContain("別の人物に分ける");
    expect(inner.mergeCandidateViews()).toHaveLength(2);
  });

  test("確認の窓は出さない（窓を出す口を一度も呼ばない）", async () => {
    // vscode の窓を出せば、ここでは stub の showWarningMessage が呼ばれて止まる。
    // 受け口が post だけで済んでいることを、送ったものの種類で確かめる
    const { inner, posted } = panelWith(threePairs());
    await inner.handleUnifyPair("char_003", "char_004");
    expect(posted.map((message) => message.type)).toEqual(["mergeResolved"]);
  });

  test("開いていた人物がまとめられたら、残した人物の中身へ切り替える", async () => {
    const { inner, posted } = panelWith(threePairs());

    await inner.handleUnifyPair("char_003", "char_004", "char_004");

    const resolved = posted.find((message) => message.type === "mergeResolved") as {
      detail?: { id: string };
    };
    expect(resolved.detail?.id).toBe("char_003");
  });

  test("関係の無い人物を開いていたら、その中身には触らない（書きかけを消さない）", async () => {
    const { inner, posted } = panelWith(threePairs());

    await inner.handleUnifyPair("char_003", "char_004", "char_005");

    const resolved = posted.find((message) => message.type === "mergeResolved");
    expect(resolved && "detail" in resolved).toBe(false);
  });

  test("もう候補に無い組（別の窓で先に片づけた）なら、何も書かずに伝える", async () => {
    const { inner, calls, posted } = panelWith(threePairs());

    await inner.handleUnifyPair("char_001", "char_004");

    expect(calls).toEqual([]);
    expect(posted[0]).toMatchObject({ type: "mergeResolved" });
    expect(posted[0].notice).toContain("もう候補にありません");
  });

  test("読み込めないファイルがあれば断る", async () => {
    const { inner, calls, posted } = panelWith(threePairs());
    inner.characterLoadErrors = [{ file: "char_099.json", message: "壊れています" }];

    await inner.handleUnifyPair("char_001", "char_002");

    expect(calls).toEqual([]);
    expect(posted[0]).toMatchObject({ type: "error" });
    expect(posted[0].message).toContain("char_099.json");
  });

  test("書いている途中に続けて押されても、2回目は受けない", async () => {
    const { inner, calls } = panelWith(threePairs());

    await Promise.all([
      inner.handleUnifyPair("char_001", "char_002"),
      inner.handleUnifyPair("char_003", "char_004"),
    ]);

    expect(calls).toEqual(["retire:char_001", "save:char_001", "retire:char_002"]);
  });
});

describe("［別人］", () => {
  test("押した組の2人を core へ渡し、互いを別人として書き、候補が1組減る", async () => {
    const { inner, calls, posted, disk, discarded } = panelWith(threePairs());

    await inner.handleDistinctPair(["char_005", "char_006"]);

    expect(calls).toEqual(["saveOrUpdate:char_005", "saveOrUpdate:char_006"]);
    expect(disk().get("char_005")?.distinctFrom).toEqual([{ name: "ばあさん", id: "char_006" }]);
    expect(disk().get("char_006")?.distinctFrom).toEqual([
      { name: "近所のおばあさん", id: "char_005" },
    ]);
    // 承認待ちの更新案は人物まるごとの写しなので、残すと別人の記録が巻き戻る（6.5.8 と同じ）
    expect(discarded).toEqual(["char_005", "char_006"]);
    const resolved = posted.find((message) => message.type === "mergeResolved");
    expect(resolved?.band).toContain("「近所のおばあさん」と「ばあさん」を別人として覚えました");
    expect(inner.mergeCandidateViews()).toHaveLength(2);
  });

  test("同じ名前の組は書かずに断る", async () => {
    const { inner, calls, posted } = panelWith([
      person("char_007", "お母さん"),
      person("char_008", "お母さん"),
    ]);

    await inner.handleDistinctPair(["char_007", "char_008"]);

    expect(calls).toEqual([]);
    expect(posted[0]).toMatchObject({ type: "error" });
  });
});

describe("3組を、メニューを開かずに押し切る", () => {
  test("まとめる2回と別人1回で、候補が0組になる", async () => {
    const { inner } = panelWith(threePairs());

    await inner.handleUnifyPair("char_001", "char_002");
    expect(inner.mergeCandidateViews()).toHaveLength(2);
    await inner.handleUnifyPair("char_003", "char_004");
    expect(inner.mergeCandidateViews()).toHaveLength(1);
    await inner.handleDistinctPair(["char_005", "char_006"]);
    expect(inner.mergeCandidateViews()).toEqual([]);
  });
});

describe("画面", () => {
  const html = buildSettingsPanelHtml("test-nonce", "vscode-resource:");

  test("候補の欄は登場人物タブの一覧の上に置き、0組なら出さない", () => {
    expect(html).toContain('activeKind === "character" && mergeCandidates.length > 0');
    expect(html).toContain("重複の候補 ");
  });

  test("ボタンは id で送る（名前では同じ名前の組を特定できない）", () => {
    expect(html).toContain('post("unifyPair", { keepId:');
    expect(html).toContain('post("distinctPair", { ids:');
  });

  test("押したら返事が来るまでその組のボタンを押せなくする", () => {
    expect(html).toContain("mergePending");
  });
});
