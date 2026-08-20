import { describe, expect, test, vi } from "vitest";
import {
  offerFirstRunSetup,
  shouldOfferSetup,
  type FirstRunDeps,
} from "../../src/features/firstRun";
import { readFileSync } from "node:fs";

/**
 * はじめて開いたときのAI選択（作者の指示、2026-08-19）。
 *
 * **これまでは作品一覧の歯車から自分で開く必要があった。**
 * 入れたばかりの人には、そこに何があるのか分からない。
 *
 * **いちばん気をつけるのは、毎回出さないこと。**
 * 起動のたびに選択画面が出ては邪魔である。
 */
function deps(overrides: Partial<FirstRunDeps> = {}): FirstRunDeps {
  return {
    isConfigured: async () => false,
    wasShown: () => false,
    markShown: async () => undefined,
    runWizard: async () => true,
    notify: async () => "AIを選ぶ",
    ...overrides,
  };
}

describe("出すかどうか", () => {
  test("はじめてで、AIが決まっていなければ出す", async () => {
    expect(await shouldOfferSetup(deps())).toBe(true);
  });

  test("一度出していれば、もう出さない", async () => {
    // **起動のたびに出るのは邪魔**
    expect(await shouldOfferSetup(deps({ wasShown: () => true }))).toBe(false);
  });

  test("既にAIが決まっていれば出さない", async () => {
    // 設定の同期などで、入れた直後から使えることがある
    expect(
      await shouldOfferSetup(deps({ isConfigured: async () => true }))
    ).toBe(false);
  });
});

describe("案内の流れ", () => {
  test("押されたら選択画面を開く", async () => {
    const runWizard = vi.fn(async () => true);
    await offerFirstRunSetup(deps({ runWizard }));

    expect(runWizard).toHaveBeenCalled();
  });

  test("いきなり選択画面を出さない", async () => {
    // **何のための画面か分からないまま一覧を見せられても選べない**
    const notify = vi.fn(async () => "AIを選ぶ");
    await offerFirstRunSetup(deps({ notify }));

    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain("AIなしでも使えます");
  });

  test("断られたら開かない", async () => {
    const runWizard = vi.fn(async () => true);
    await offerFirstRunSetup(deps({ notify: async () => undefined, runWizard }));

    expect(runWizard).not.toHaveBeenCalled();
  });

  test("断られても、出したことは覚える", async () => {
    // **次の起動でまた出るのは邪魔。** あとから「AI設定」でいつでも開ける
    const markShown = vi.fn(async () => undefined);
    await offerFirstRunSetup(deps({ notify: async () => undefined, markShown }));

    expect(markShown).toHaveBeenCalled();
  });

  test("出さないときは、何も呼ばない", async () => {
    const markShown = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    await offerFirstRunSetup(deps({ wasShown: () => true, markShown, notify }));

    expect(markShown).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("作品一覧のボタン", () => {
  test("「AI設定」の歯車を置かない", () => {
    // **作者の指示（2026-08-19）。** はじめて開いたときに出すので、
    // 作品一覧に常時置く必要が無くなった
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      contributes: {
        menus: Record<string, Array<{ command: string; when?: string }>>;
      };
    };
    const onWorks = pkg.contributes.menus["view/title"].filter((entry) =>
      String(entry.when ?? "").includes("novelai.works")
    );

    expect(onWorks.map((entry) => entry.command)).not.toContain(
      "novelai.setupAI"
    );
  });

  test("コマンド自体は残す（操作メニューから使える）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      contributes: { commands: Array<{ command: string }> };
    };

    expect(pkg.contributes.commands.map((c) => c.command)).toContain(
      "novelai.setupAI"
    );
  });
});

describe("Ollamaを選んで、つながらなかったとき", () => {
  test("セットアップの案内へ繋ぐ", () => {
    // **「設定を開く」と言われても、まだ何も入れていない人は何もできない**
    const source = readFileSync("src/ai/registry.ts", "utf-8");

    expect(source).toContain('providerPick.providerId === "ollama"');
    expect(source).toContain("novelai.setupOllama");
  });

  test("クラウドのAIは、今までどおり設定を開く", () => {
    // 鍵の入力で先に躓くので、ここへは来ない
    const source = readFileSync("src/ai/registry.ts", "utf-8");

    expect(source).toContain("workbench.action.openSettings");
  });
});

/**
 * 作品一覧のボタン（作者の指示、2026-08-19）。
 *
 * **「追加」どうしを隣に置く。** フォルダからとGitHubからは同じ目的なので、
 * 離すと片方を探すことになる。
 */
describe("作品一覧に並ぶボタン", () => {
  const onWorks = (): Array<{ command: string; group?: string }> => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      contributes: {
        menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
      };
    };
    return pkg.contributes.menus["view/title"]
      .filter((entry) => String(entry.when ?? "").includes("novelai.works"))
      .sort((a, b) => String(a.group).localeCompare(String(b.group)));
  };

  test("GitHubからの追加が並んでいる", () => {
    expect(onWorks().map((entry) => entry.command)).toContain(
      "novelai.addWorkFromGithub"
    );
  });

  test("「追加」どうしが隣り合っている", () => {
    const commands = onWorks().map((entry) => entry.command);
    const folder = commands.indexOf("novelai.addWork");
    const github = commands.indexOf("novelai.addWorkFromGithub");

    expect(Math.abs(folder - github)).toBe(1);
  });

  test("並び順が重ならない", () => {
    // 同じ番号だと、VS Code側の並びが安定しない
    const groups = onWorks().map((entry) => entry.group);

    expect(new Set(groups).size).toBe(groups.length);
  });

  test("アイコンが全部そろっている", () => {
    // ボタンは名前ではなくアイコンで出る。無いと空白になる
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      contributes: { commands: Array<{ command: string; icon?: string }> };
    };
    for (const entry of onWorks()) {
      const command = pkg.contributes.commands.find(
        (c) => c.command === entry.command
      );
      expect(command?.icon, entry.command).toBeTruthy();
    }
  });
});
