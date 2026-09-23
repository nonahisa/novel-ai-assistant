import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { WALKTHROUGH_ID } from "../../../src/features/firstRun";
import { isCommandAvailableInRuntime } from "../../../src/core/processAvailability";
import { ACTION_TREE, findAction } from "../../../src/views/actionList";
import { STEP_MENU } from "../../../src/views/stepMenu";

// 配布物の許可リスト（素の Node で動く .mjs。`secretScanParity.test.ts` と
// 同じ読み方）。段の Markdown が梱包から漏れると、Marketplace から入れた
// 人には段の右側が空になる
const { EXPECTED_ARCHIVE_FILES } = (await import(
  "../../../scripts/releaseSupport.mjs"
)) as { EXPECTED_ARCHIVE_FILES: string[] };

/**
 * 初回の道案内（`contributes.walkthroughs`。設計書6.104 の入口2）。
 *
 * **VS Code は、道案内の宣言が間違っていても何も言わない。** 押しても
 * 何も起きないボタン、済みにならない段、画面に無いメニュー名は、
 * どれも静かに残る。ここで見張るのは次の4つ。
 *
 * 1. 形——段ごとに説明・Markdown・済みになる条件が揃っている
 * 2. ボタンと済みの条件が、実在するコマンドを指している
 * 3. 案内の中のメニュー名が、いまのメニュー（`ACTION_TREE`・簡単ステップ
 *    メニュー）の名前と一致している（名前を変えたら、ここが落ちる）
 * 4. ブラウザ版で動かない操作の段は、ブラウザでは出さない（規則7）
 */

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media: { markdown?: string; image?: string; altText?: string };
  completionEvents?: string[];
  when?: string;
}

interface Walkthrough {
  id: string;
  title: string;
  description: string;
  steps: WalkthroughStep[];
  when?: string;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  contributes: {
    commands: Array<{ command: string }>;
    customEditors: Array<{ viewType: string }>;
    viewsContainers: { activitybar: Array<{ id: string }> };
    walkthroughs?: Walkthrough[];
  };
};

const declared = new Set(manifest.contributes.commands.map((c) => c.command));

/**
 * `novelai.` 以外で、ボタンから呼んでよい VS Code 本体のコマンド。
 * **増やすときは、実在を確かめてから足す**（本体のコマンドは宣言の
 * 一覧に無いので、ここ以外に見張る場所が無い）。
 */
const BUILTIN_COMMANDS = new Set(["workbench.view.extension.novelai"]);

function walkthrough(): Walkthrough {
  const found = manifest.contributes.walkthroughs?.find(
    (w) => w.id === WALKTHROUGH_ID
  );
  if (!found) throw new Error(`道案内 ${WALKTHROUGH_ID} が package.json に無い`);
  return found;
}

function markdownOf(step: WalkthroughStep): string {
  return step.media.markdown ? readFileSync(step.media.markdown, "utf8") : "";
}

/** 段の中の文（左の説明と右の Markdown）を両方 */
function textsOf(step: WalkthroughStep): string[] {
  return [step.description, markdownOf(step)];
}

/** `[文字](command:ID)` を拾う。引数付き（`?`）も ID だけにする */
function commandLinks(text: string): Array<{ label: string; command: string }> {
  return [...text.matchAll(/\[([^\]]+)\]\(command:([^)?\s]+)[^)]*\)/g)].map(
    (m) => ({ label: m[1], command: m[2] })
  );
}

/** 段が呼ぶコマンド（ボタンと済みの条件の両方） */
function commandsOf(step: WalkthroughStep): string[] {
  const fromLinks = textsOf(step).flatMap((t) => commandLinks(t).map((l) => l.command));
  const fromEvents = (step.completionEvents ?? [])
    .filter((e) => e.startsWith("onCommand:"))
    .map((e) => e.slice("onCommand:".length));
  return [...fromLinks, ...fromEvents];
}

/**
 * 「詳細メニュー › 分類 › 小分類 › 操作」を木でたどる。
 * **隠した操作（`hiddenFromActionList`）には着かない**——画面に無い。
 */
function resolveActionPath(parts: string[]): boolean {
  const [groupLabel, ...rest] = parts;
  const group = ACTION_TREE.find((g) => g.label === groupLabel);
  if (!group) return false;
  if (rest.length === 0) return true;
  const [second, third] = rest;
  const entry = group.entries.find((e) => e.label === second);
  if (!entry) return false;
  if (entry.kind === "action") return rest.length === 1 && !entry.hiddenFromActionList;
  if (rest.length === 1) return true;
  const item = entry.items.find((i) => i.label === third);
  return rest.length === 2 && item !== undefined && !item.hiddenFromActionList;
}

/** 文の中の「詳細メニュー › …」「簡単ステップメニュー › …」を拾う */
function menuPaths(text: string): Array<{ menu: string; parts: string[] }> {
  return [
    ...text.matchAll(/(詳細メニュー|簡単ステップメニュー)((?:\s*›\s*[^›「」\n。、（）*]+)+)/g),
  ].map((m) => ({
    menu: m[1],
    parts: m[2]
      .split("›")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  }));
}

describe("形", () => {
  test("道案内が1つあり、段が並んでいる", () => {
    const w = walkthrough();
    expect(w.title.length).toBeGreaterThan(0);
    expect(w.description.length).toBeGreaterThan(0);
    expect(w.steps.length).toBeGreaterThanOrEqual(5);
  });

  test("段の ID は重ならない", () => {
    const ids = walkthrough().steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const step of (manifest.contributes.walkthroughs ?? []).flatMap((w) => w.steps)) {
    test(`「${step.title}」は説明・Markdown・済みの条件を持つ`, () => {
      expect(step.description.length).toBeGreaterThan(0);
      // **右側の Markdown は実在し、配布物に入る**
      expect(step.media.markdown, "段の説明は Markdown で持つ").toBeDefined();
      const md = step.media.markdown ?? "";
      expect(existsSync(md), `${md} が無い`).toBe(true);
      expect(EXPECTED_ARCHIVE_FILES).toContain(`extension/${md}`);
      // 済みにならない段は、いつまでも「未完了」で残る
      expect(step.completionEvents?.length ?? 0).toBeGreaterThan(0);
    });
  }
});

describe("ボタンと済みの条件は、実在するコマンドを指す", () => {
  for (const step of walkthrough().steps) {
    test(`「${step.title}」`, () => {
      const commands = commandsOf(step);
      expect(commands.length, "ボタンも済みの条件も無い").toBeGreaterThan(0);
      for (const command of commands) {
        if (command.startsWith("novelai.")) {
          expect(declared.has(command), `${command} は宣言されていない`).toBe(true);
        } else {
          expect(BUILTIN_COMMANDS.has(command), `${command} は許可していない`).toBe(true);
        }
      }
    });
  }

  test("本体のコマンドが指すサイドバーは実在する", () => {
    const ids = manifest.contributes.viewsContainers.activitybar.map((v) => v.id);
    expect(ids).toContain("novelai");
  });

  // 押しただけで済みにすると、フォルダー選びを取りやめても印が付いた（2026-09-24）。
  // 済みの鍵を package.json にだけ書いて、拡張機能が立てていなければ永遠に済みにならない
  test("「作品を用意する」は作品が1つ以上あるときに済みになり、その鍵を拡張機能が立てている", () => {
    const step = walkthrough().steps.find((s) => s.id === "prepareWork");
    expect(step?.completionEvents).toEqual(["onContext:novelai.hasWorks"]);
    const source = readFileSync("src/extension.ts", "utf8");
    expect(source).toMatch(/"setContext",\s*"novelai\.hasWorks"/);
  });

  test("原稿エディターの段は、実在する画面の種類で済みになる", () => {
    const viewTypes = manifest.contributes.customEditors.map((e) => e.viewType);
    const contexts = walkthrough()
      .steps.flatMap((s) => s.completionEvents ?? [])
      .filter((e) => e.startsWith("onContext:"));
    expect(contexts.length).toBeGreaterThan(0);
    for (const event of contexts) {
      for (const m of event.matchAll(/'([^']+)'/g)) {
        expect(viewTypes).toContain(m[1]);
      }
    }
  });
});

describe("案内の中のメニュー名は、いまのメニューの名前と一致する", () => {
  for (const step of walkthrough().steps) {
    test(`「${step.title}」のボタンの文字は、詳細メニューのラベル`, () => {
      for (const text of textsOf(step)) {
        for (const link of commandLinks(text)) {
          if (!link.command.startsWith("novelai.")) continue;
          const action = findAction(link.command);
          expect(action, `${link.command} がメニューに無い`).toBeDefined();
          expect(link.label).toBe(action?.label);
        }
      }
    });

    test(`「${step.title}」の置き場所の道筋は、画面にある`, () => {
      for (const text of textsOf(step)) {
        for (const { menu, parts } of menuPaths(text)) {
          if (menu === "詳細メニュー") {
            expect(resolveActionPath(parts), `詳細メニュー › ${parts.join(" › ")}`).toBe(true);
          } else {
            // 簡単ステップメニューは段の名前（「1. 作品登録」）までを書く
            expect(STEP_MENU.map((s) => s.label)).toContain(parts[0]);
          }
        }
      }
    });
  }

  test("道筋を1つ以上書いている（見張りが空回りしていない）", () => {
    const all = walkthrough().steps.flatMap((s) => textsOf(s).flatMap(menuPaths));
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test("画面に内輪の呼び名を出さない", () => {
    for (const step of walkthrough().steps) {
      for (const text of [step.title, ...textsOf(step)]) {
        expect(text).not.toContain("母艦");
      }
    }
  });
});

describe("ブラウザ版（規則7）", () => {
  for (const step of walkthrough().steps) {
    const blocked = [
      ...new Set(
        commandsOf(step).filter(
          (c) => c.startsWith("novelai.") && !isCommandAvailableInRuntime(c, false)
        )
      ),
    ];
    const hiddenOnWeb = (step.when ?? "").includes("!isWeb");

    if (blocked.length > 0) {
      test(`「${step.title}」はブラウザで動かない操作（${blocked.join("・")}）なので出さない`, () => {
        expect(hiddenOnWeb).toBe(true);
      });
    } else {
      test(`「${step.title}」はブラウザでも出す`, () => {
        // **動く段まで隠すと、ブラウザの人には道案内が細切れになる**
        expect(hiddenOnWeb).toBe(false);
      });
    }
  }

  test("道案内そのものはブラウザでも出る", () => {
    expect(walkthrough().when ?? "").not.toContain("!isWeb");
  });
});

describe("順番", () => {
  test("作家タイプ診断が先、AIを決めるのが後（起動時の声かけと同じ順）", () => {
    // `extension.ts` の起動時の声かけは「診断 → AI」の順（作者の依頼、
    // 2026-09-13）。**何をしたいかが決まる前にAIを選ばせても、何のために
    // 要るのかが分からない。** 道案内だけ逆の順に並べると、2つの入口で
    // 言っていることが食い違う
    const steps = walkthrough().steps;
    const diagnosis = steps.findIndex((s) => commandsOf(s).includes("novelai.runWriterDiagnosis"));
    const chooseAi = steps.findIndex((s) => commandsOf(s).includes("novelai.setupAI"));
    expect(diagnosis).toBeGreaterThanOrEqual(0);
    expect(chooseAi).toBeGreaterThan(diagnosis);
  });
});
