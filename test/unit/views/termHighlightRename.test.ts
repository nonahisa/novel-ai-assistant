import * as nodePath from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { Character } from "../../../src/models/character";

/**
 * 名前を別名と入れ替えたあとも、本文の色分けが**両方の呼び方**を拾うか
 * （設計書6.5.6。実機確認リスト F-10 の代わり）。
 *
 * 入れ替えそのもの（元の名前が別名へ移る）は `swapNameWithAlias.test.ts` が
 * 見ている。ここで見るのは、その結果を**色分けの索引が本当に読むか**である。
 * 標準エディターも原稿エディタも、同じ `TermHighlighter.indexFor` の索引で
 * 色を付けている（`features/manuscriptEditor.ts`）。
 */

const state = vi.hoisted(() => ({ characters: [] as unknown[] }));

vi.mock("vscode", () => ({
  MarkdownString: class {
    value = "";
    supportThemeIcons = false;
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  },
  Uri: {
    file: (fsPath: string) => ({ scheme: "file", fsPath }),
    parse: (value: string) => ({ scheme: "file", fsPath: value }),
  },
  window: {
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorVisibleRanges: () => ({ dispose() {} }),
    activeTextEditor: undefined,
  },
  workspace: {
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
  },
}));

// 設定資料はこの試験が決める（ディスクは読まない）
vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters };
    }
  },
}));
vi.mock("../../../src/core/abilityStore", () => {
  const empty = () => ({ loadAll: async () => ({ records: [] }) });
  return {
    createAbilityStore: empty,
    createLocationStore: empty,
    createOrganizationStore: empty,
    AbilitySystemStore: class {
      async load() {
        return { abilityTerm: "能力" };
      }
    },
  };
});
vi.mock("../../../src/core/seriesSettings", () => ({
  clearSeriesCache: () => undefined,
  loadSeriesTerms: async () => [],
}));
vi.mock("../../../src/core/workRegistry", () => ({ WorkRegistry: class {} }));

import { TermHighlighter } from "../../../src/views/termHighlight";
import { emptyCharacter } from "../../../src/models/character";
import { swapNameWithAlias } from "../../../src/core/settingsEdit";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";

const workFolder = nodePath.resolve("rename-test-works", "novel");
const work = { id: "work_001", folderPath: workFolder } as WorkEntry;
const registry = { list: () => [work] } as unknown as WorkRegistry;
const episodePath = nodePath.join(workFolder, "本文", "001.txt");

/** 実機確認で使った人物の形（名前「三門太志」、別名に「太志」） */
function before(): Character {
  return { ...emptyCharacter("char_001", "三門太志"), aliases: ["太志"] };
}

/** 設定資料パネルで「太志」の札を押して保存したあとの人物 */
function afterSwap(): Character {
  const original = before();
  const swapped = swapNameWithAlias(
    original.name,
    "太志",
    original.aliases,
    original.aliases
  );
  return { ...original, name: swapped.name, aliases: swapped.aliases };
}

/** 本文の1行で、色を付ける語とその正式名 */
async function highlighted(
  highlighter: TermHighlighter,
  line: string
): Promise<Array<{ text: string; canonical: string }>> {
  const found = await highlighter.indexFor(episodePath);
  if (!found) throw new Error("作品の索引が取れない");
  return found.index.find(line).map((match) => ({
    text: line.slice(match.start, match.end),
    canonical: match.entry.canonicalName,
  }));
}

describe("名前と別名を入れ替えたあとの色分け", () => {
  test("新しい名前と、別名へ移った元の名前の両方に色が付く", async () => {
    state.characters = [afterSwap()];
    const highlighter = new TermHighlighter(registry);

    const matches = await highlighted(
      highlighter,
      "三門太志は振り返った。太志、と呼ぶ声がした。"
    );

    expect(matches.map((match) => match.text)).toEqual(["三門太志", "太志"]);
    // どちらの呼び方も、入れ替えた後の名前の人物として引かれる
    expect(matches.every((match) => match.canonical === "太志")).toBe(true);
  });

  test("保存のあと索引を捨てれば、入れ替えた名前で引き直す", async () => {
    // 開いたまま名前を変える流れ：入れ替える前の索引が残っている
    state.characters = [before()];
    const highlighter = new TermHighlighter(registry);
    const old = await highlighted(highlighter, "三門太志");
    expect(old[0]?.canonical).toBe("三門太志");

    state.characters = [afterSwap()];
    highlighter.invalidate();

    const fresh = await highlighted(highlighter, "三門太志");
    expect(fresh[0]?.canonical).toBe("太志");
  });

  test("設定資料パネルで保存したら、色分けの索引を捨てる配線がある", () => {
    // 上の試験は `invalidate()` を呼べば引き直すことまでしか言っていない。
    // 保存のたびに呼ばれているかは、繋いでいる `extension.ts` にしか無い
    const source = readFileSync("src/extension.ts", "utf8");
    const observer = source.slice(source.indexOf("setSettingsChangeObserver((work) => {"));
    expect(observer.slice(0, 400)).toContain("highlighter.invalidate();");
  });
});
