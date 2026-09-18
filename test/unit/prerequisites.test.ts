import { afterEach, describe, expect, it } from "vitest";
import { commands, window } from "vscode";
import {
  missingPrerequisites,
  prerequisiteNote,
  PREREQUISITES,
  type Prerequisite,
  type PrerequisiteInfo,
} from "../../src/core/prerequisites";
import {
  askPrerequisiteRoute,
  checkPrerequisites,
  prerequisiteRoute,
} from "../../src/features/prerequisiteGate";
import { findAction, prerequisiteNoteOf } from "../../src/views/actionList";
import { buildGuideBundles } from "../../src/features/featureGuide";
import { buildUserManual } from "../../src/features/openManual";
import type { WorkEntry } from "../../src/models/types";

/**
 * 前提（設定資料・あらすじ・プロット・単話プロット）の扱い（設計書6.94）。
 *
 * 作者の要望（2026-09-18）は「順路を教えてほしい」と「代替で実行できる
 * ようにもしてほしい」の2つ。前者は相談とマニュアルへ届くか、後者は
 * 画面でその場から走れるかを見る。
 */

const WORK: WorkEntry = {
  id: "w1",
  title: "試作",
  folderPath: "C:/works/試作",
  registeredAt: "2026-09-18T00:00:00.000Z",
};

/** 差し替えた窓口を戻す（残すと、あとのテストが前の答えを拾う） */
const originalQuickPick = window.showQuickPick;
const originalExecute = commands.executeCommand;
afterEach(() => {
  window.showQuickPick = originalQuickPick;
  commands.executeCommand = originalExecute;
});

/** 選択画面に並んだ項目を覗き、指定の1つを選んだことにする */
function answerWith(pick: (labels: string[]) => number | undefined): {
  labels: () => string[];
  title: () => string;
} {
  let seen: Array<{ label: string; detail?: string }> = [];
  let title = "";
  window.showQuickPick = (async (items: unknown, options: unknown) => {
    seen = items as Array<{ label: string; detail?: string }>;
    title = (options as { title?: string } | undefined)?.title ?? "";
    const index = pick(seen.map((entry) => entry.label));
    return index === undefined ? undefined : seen[index];
  }) as typeof window.showQuickPick;
  return {
    labels: () => seen.map((entry) => entry.label),
    title: () => title,
  };
}

/** 画面に並んだ道と関わりなく、この道を選んだことにする */
function answerWithChoice(choice: unknown): void {
  window.showQuickPick = (async () => choice) as typeof window.showQuickPick;
}

/** 走ったコマンドを積む */
function recordCommands(): string[] {
  const ran: string[] = [];
  commands.executeCommand = (async (command: string) => {
    ran.push(command);
    return undefined;
  }) as typeof commands.executeCommand;
  return ran;
}

describe("前提をデータとして持つ", () => {
  it("説明文に前提が書いてある4操作が、needs を持っている", () => {
    const expected: Array<[string, string]> = [
      ["novelai.generatePlot", "synopsis"],
      ["novelai.checkDeviations", "plot"],
      ["novelai.checkEpisodePlot", "episodePlot"],
      ["novelai.checkContradictions", "settings"],
    ];
    for (const [command, kind] of expected) {
      expect(findAction(command)?.needs, command).toEqual([kind]);
    }
  });

  it("前提を作る操作は、どれも操作の木に実在する", () => {
    // 木に無いコマンドを指すと、案内の先で「そんな操作はありません」になる。
    // 名前（`makeLabel`）は画面の名前と同じとは限らない——小分類の外で
    // 読まれる文なので、「まとめて抽出」では何のことか分からない
    for (const info of Object.values(PREREQUISITES)) {
      expect(findAction(info.makeCommand), info.makeCommand).toBeTruthy();
      expect(info.makeLabel.length, info.makeCommand).toBeGreaterThan(0);
    }
  });

  it("代わりの道は、矛盾検知の1組だけ（推測で増やさない）", () => {
    const withAlternative = [
      "novelai.generatePlot",
      "novelai.checkDeviations",
      "novelai.checkEpisodePlot",
      "novelai.checkContradictions",
    ].filter((command) => findAction(command)?.insteadOf);
    expect(withAlternative).toEqual(["novelai.checkContradictions"]);
    expect(findAction("novelai.checkContradictions")?.insteadOf?.command).toBe(
      "novelai.checkFactContradictions"
    );
    // 指し先が実在しないと、代わりの道が押せない案内になる
    expect(findAction("novelai.checkFactContradictions")).toBeTruthy();
  });

  it("足りないものだけを返す", () => {
    expect(missingPrerequisites(["settings", "plot"], ["plot"])).toEqual([
      "settings",
    ]);
    expect(missingPrerequisites(["settings"], ["settings"])).toEqual([]);
    expect(missingPrerequisites(undefined, [])).toEqual([]);
  });
});

describe("足りないときだけ、道を出す", () => {
  it("前提の無い操作では、選択画面を出さない", async () => {
    let asked = false;
    window.showQuickPick = (async () => {
      asked = true;
      return undefined;
    }) as typeof window.showQuickPick;

    const item = findAction("novelai.showWritingStats");
    expect(item?.needs).toBeUndefined();
    expect(await checkPrerequisites(item!, WORK)).toBe("proceed");
    expect(asked).toBe(false);
  });

  it("代わりの道がある操作では、作る道と代わりの道と取りやめるが並ぶ", async () => {
    const seen = answerWith(() => undefined);
    const item = findAction("novelai.checkContradictions")!;

    expect(await askPrerequisiteRoute(item, WORK, ["settings"])).toBe("handled");

    const labels = seen.labels();
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain("設定資料をまとめて抽出");
    expect(labels[1]).toContain("矛盾検知（事実の照合）");
    // 閉じる道は画面に出す（`quickPickCancel.test.ts` と同じ決まり）
    expect(labels[2]).toContain("取りやめる");
  });

  /**
   * ここが 2026-09-18 の裁定の肝である。前の版は足りないときに必ず
   * 「このまま実行する」を出していたが、いまの4操作はどれも前提が無いと
   * 走らない。出せば、押した先で機能の側が同じ案内をもう一度出すだけに
   * なる——**動かないものを勧めることになる。**
   */
  it("走れない操作では、このまま実行するを出さない", async () => {
    for (const [command, kind] of [
      ["novelai.checkContradictions", "settings"],
      ["novelai.generatePlot", "synopsis"],
      ["novelai.checkDeviations", "plot"],
      ["novelai.checkEpisodePlot", "episodePlot"],
    ] as Array<[string, Prerequisite]>) {
      const seen = answerWith(() => undefined);
      await askPrerequisiteRoute(findAction(command)!, WORK, [kind]);
      expect(
        seen.labels().some((label) => label.startsWith("このまま")),
        command
      ).toBe(false);
    }
  });

  it("走れず代わりも無い操作では、作る道と取りやめるの2つになる", async () => {
    const seen = answerWith(() => undefined);
    const item = findAction("novelai.checkDeviations")!;

    await askPrerequisiteRoute(item, WORK, ["plot"]);

    const labels = seen.labels();
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain("プロットをつくる");
    expect(labels[1]).toContain("取りやめる");
    // 見出しは事実だけ。選べる道が1つしか無い場面で問いを強めない
    expect(seen.title()).toBe(
      "「プロットからの逸脱を検知」には「プロット」が要ります"
    );
  });

  /**
   * **無くても走る前提は、いまこの作品に1つも無い**（4つとも `blocking`）。
   * それでも道は残してある。ここでは種類を1つこしらえて、残した道が
   * ちゃんと出ることを見る。
   */
  it("走るが質が落ちるだけの前提なら、このまま実行するが出る", () => {
    const soft: PrerequisiteInfo = {
      kind: "settings",
      label: "ためしの前提",
      makeCommand: "novelai.extractSettings",
      makeLabel: "ためしの前提を作る",
      severity: "degrades",
      withoutWarning: "無いと出来が落ちます。",
    };

    const route = prerequisiteRoute({
      actionLabel: "ためしの操作",
      missing: [soft],
    });
    const labels = route.items.map((entry) => entry.label);
    expect(labels).toHaveLength(2);
    expect(labels[1]).toBe("このまま「ためしの操作」を実行する");
    // 何が起きるかを一文で断る。黙って走らせない
    expect(route.items[1]?.detail).toBe("無いと出来が落ちます。");
  });

  it("走れない前提が1つでも混じれば、このまま実行するは消える", () => {
    const soft: PrerequisiteInfo = {
      kind: "synopsis",
      label: "ためしの前提",
      makeCommand: "novelai.generateSynopses",
      makeLabel: "ためしの前提を作る",
      severity: "degrades",
      withoutWarning: "無いと出来が落ちます。",
    };

    const route = prerequisiteRoute({
      actionLabel: "ためしの操作",
      missing: [soft, PREREQUISITES.plot],
    });
    expect(route.items.map((entry) => entry.label)).toHaveLength(1);
    expect(route.title).toBe(
      "「ためしの操作」には「ためしの前提」と「プロット」が要ります"
    );
  });
});

describe("選んだ道が、その場で走る", () => {
  /*
    いまの4操作には「このまま実行する」が出ない（どれも前提が無いと
    走らないため）。それでも受け側の道は残してあるので、画面を介さず
    その道を選んだことにして確かめる。
  */
  it("このまま進むと、元の操作を走らせてよいと答える", async () => {
    answerWithChoice({ label: "このまま", choice: { act: "anyway" } });
    const ran = recordCommands();
    const item = findAction("novelai.checkContradictions")!;

    // 関門は「走らせてよい」と答えるだけで、自分では呼ばない
    // （呼ぶと、押された操作が二重に走る）
    expect(await askPrerequisiteRoute(item, WORK, ["settings"])).toBe("proceed");
    expect(ran).toEqual([]);
  });

  it("代わりの道は、名前を出すだけでなくその場で走る", async () => {
    answerWith((labels) => labels.findIndex((l) => l.startsWith("代わりに")));
    const ran = recordCommands();
    const item = findAction("novelai.checkContradictions")!;

    expect(await askPrerequisiteRoute(item, WORK, ["settings"])).toBe("handled");
    expect(ran).toEqual(["novelai.checkFactContradictions"]);
  });

  it("取りやめると、何も走らない", async () => {
    answerWith((labels) => labels.findIndex((l) => l.includes("取りやめる")));
    const ran = recordCommands();
    const item = findAction("novelai.checkContradictions")!;

    expect(await askPrerequisiteRoute(item, WORK, ["settings"])).toBe("handled");
    expect(ran).toEqual([]);
  });
});

describe("前提の1行", () => {
  it("代わりの道があれば添える", () => {
    expect(
      prerequisiteNote({ needs: ["settings"], alternativeLabel: "別の道" })
    ).toBe("先に「設定資料」が要ります。無いときは「別の道」で代われます。");
    expect(prerequisiteNote({ needs: ["plot"] })).toBe(
      "先に「プロット」が要ります。"
    );
    expect(prerequisiteNote({ needs: [] })).toBe("");
  });

  it("相談へ渡す説明に入り、切り詰めで落ちない", () => {
    const bundles = buildGuideBundles();
    const text = bundles.map((bundle) => bundle.text).join("\n");

    /*
      **ここが今回の肝である。** `shorten` は1文目と「〜ません」で終わる
      文しか残さないので、説明文の中に書いた前提はこれまで全部落ちていた。
      データから組み直した1行が、切り詰めのあとに残っていることを見る。
    */
    for (const command of [
      "novelai.generatePlot",
      "novelai.checkDeviations",
      "novelai.checkEpisodePlot",
      "novelai.checkContradictions",
    ]) {
      const note = prerequisiteNoteOf(findAction(command)!);
      expect(note, command).not.toBe("");
      expect(text, command).toContain(note);
    }
    // 代わりの道の名前も届く（順路を答えるのに要る）
    expect(text).toContain("無いときは「矛盾検知（事実の照合）」で代われます。");
  });

  it("マニュアルにも出る", () => {
    const manual = buildUserManual();
    expect(manual).toContain("先に「設定資料」が要ります。");
    expect(manual).toContain("先に「プロット」が要ります。");
    expect(manual).toContain("先に「各話あらすじ」が要ります。");
    expect(manual).toContain("先に「単話プロット」が要ります。");
  });
});
