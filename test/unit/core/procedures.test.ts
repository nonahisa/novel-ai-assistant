import * as path from "path";
import { describe, expect, test } from "vitest";
import { SRC, chainTo, walkStaticImports } from "./support/importGraph";
import {
  PROCEDURES,
  PROCEDURE_CHAR_LIMIT,
  PROCEDURE_REFERENCED_COMMANDS,
  renderProcedure,
  selectProcedure,
} from "../../src/core/procedures";
import {
  allActions,
  findAction,
  prerequisiteNoteOf,
} from "../../src/views/actionList";
import { buildFeatureGuideForQuestion } from "../../src/features/featureGuide";

/**
 * 手順書き——よくある仕事の「順番と判断」（`src/core/procedures.ts`）。
 *
 * ここで守るのは4つ。
 *
 * 1. 話題に合う手順書きが**1本だけ**選ばれる（2本渡すと、どちらに従えば
 *    よいか分からなくなる）
 * 2. 合うものが無ければ**渡さない**（関係の薄い紙を毎回払わない）
 * 3. 段が指す操作の名前が `ACTION_TREE` と**一致する**（写しになっていない）
 * 4. 前提のある段では、それが**分かる**（順路の紙に「先に何が要るか」が
 *    無ければ、順路として用を成さない）
 */

/** 製品と同じ引き方（`featureGuide.ts` の `procedureActionLookup` と同じ材料） */
const lookup = (command: string) => {
  const action = findAction(command);
  if (!action) return undefined;
  const needs = prerequisiteNoteOf(action);
  return {
    label: action.label,
    ...(action.note ? { note: action.note } : {}),
    ...(needs ? { prerequisiteNote: needs } : {}),
  };
};

describe("手順書きの中身", () => {
  test("まず4〜7本だけを持つ", () => {
    // 増やすときは、本当に繰り返し通る仕事かを確かめる。
    // 選ばれてしまえば毎回払う。
    //
    // 7本目は「狙いと実態のずれを見る」（設計書6.108）。読者の手順書きを
    // 2本に分けたのは、**決める仕事と、決めたあとの仕事**が別だからである
    // （1本にまとめると600字に収まらず、当たりの文も混ざる）
    expect(PROCEDURES.length).toBeGreaterThanOrEqual(4);
    expect(PROCEDURES.length).toBeLessThanOrEqual(7);
  });

  test("段が指す操作は、すべて詳細メニューに実在する", () => {
    // 参照が切れると、その段は黙って落ちる（`renderProcedure`）。
    // 画面からは1行消えるだけで気づけないので、ここで止める
    const known = new Set(allActions().map((action) => action.command));
    const missing = PROCEDURE_REFERENCED_COMMANDS.filter(
      (command) => !known.has(command)
    );

    expect(missing).toEqual([]);
  });

  test("操作の名前を書き写していない", () => {
    /*
      **手順書きはコマンドIDしか持たない。** 名前を持つと、操作を改名した
      ときに手順書きだけが古くなり、画面を見比べるまで気づけない
      （`stepMenu.ts` と同じ決まり）。

      組み上げた文には `ACTION_TREE` の名前がそのまま出ることを見る。
    */
    for (const procedure of PROCEDURES) {
      const text = renderProcedure(procedure, lookup);
      for (const step of procedure.steps) {
        const action = findAction(step.command);
        expect(text, `${procedure.key}/${step.command}`).toContain(
          action!.label
        );
      }
      /*
        段の側には、名前が1つも書かれていない。

        **見るのは段（`steps`）だけにする。** 「どんなときに読むか」は
        話題と結びつけるための文なので、操作の名前と同じ言葉がたまたま
        並ぶことがある（「名前」「点検」）。そこまで禁じると、当たりに
        要る言葉が書けなくなる。
      */
      const raw = JSON.stringify(procedure.steps);
      for (const step of procedure.steps) {
        const action = findAction(step.command);
        expect(raw, `${procedure.key}: ${action!.label}`).not.toContain(
          action!.label
        );
      }
    }
  });

  test("前提のある段では、先に何が要るかが分かる", () => {
    // 「矛盾を洗う」は、設定資料が無いと走らない操作（`needs: settings`）を
    // 通る。前提は `shorten` で落ちる位置にあるので、データから組み直して
    // 手順書きにも確実に載せる（設計書6.94）
    const consistency = PROCEDURES.find(
      (procedure) => procedure.key === "consistency"
    );
    const text = renderProcedure(consistency!, lookup);

    expect(text).toContain("先に「設定資料」が要ります。");
    // 代わりの道も、名前を木から引いて出す
    expect(text).toContain("矛盾検知（事実の照合）");
  });

  test("前提のある操作を通る手順書きは、必ずその断りを持つ", () => {
    // 1本を名指しで見るだけでは、あとから足した手順書きで落ちる
    for (const procedure of PROCEDURES) {
      const text = renderProcedure(procedure, lookup);
      for (const step of procedure.steps) {
        const note = prerequisiteNoteOf(findAction(step.command)!);
        if (!note) continue;
        expect(text, `${procedure.key}/${step.command}`).toContain(note);
      }
    }
  });

  test("1本は600字以内に収まる", () => {
    /*
      **上限を上げない。** 相談は1回ごとに全部送るので、足した分だけ毎回
      払う。収まらないときは段を減らすか、理由と見どころを短くする
      （設計書6.27の行き止まりへ戻らないため）。
    */
    const tooLong = PROCEDURES.map((procedure) => ({
      key: procedure.key,
      length: renderProcedure(procedure, lookup).length,
    })).filter((entry) => entry.length > PROCEDURE_CHAR_LIMIT);

    expect(tooLong.map((entry) => `${entry.key}: ${entry.length}字`)).toEqual(
      []
    );
  });

  test("段が1つも解けなければ、題だけの紙は作らない", () => {
    expect(renderProcedure(PROCEDURES[0], () => undefined)).toBe("");
  });

  test("`vscode` へ静的 import で届かない", () => {
    /*
      **手順書きは `core` の住人である。** 名前を引くのは `views` の仕事
      なので、関数で受け取る形にしてある（`ProcedureActionLookup`）。
      うっかり `views/actionList.ts` を直接指すと依存の向きが逆流し、
      外（MCP・テスト）からこの判断だけを測れなくなる。

      `mcpReach.test.ts` は `scripts/coreEntries.mjs` に挙げた起点しか
      歩かず、手順書きはまだ外へ出す口が無いので挙げていない。
      **見張りが要らなくなったわけではない**ので、ここで同じ歩き方をする。
    */
    const reach = walkStaticImports([
      path.join(SRC, "core", "procedures.ts"),
    ]);
    const offenders = reach.bare
      .filter((bare) => bare.spec === "vscode")
      .map((bare) => `${chainTo(reach, bare.file)} -> vscode`);

    expect(offenders).toEqual([]);
  });
});

describe("手順書きの選び方", () => {
  test("話題に合う手順書きが、1本だけ選ばれる", () => {
    const cases: Array<[string, string]> = [
      ["誤字脱字の検知はどこから", "推敲して仕上げる"],
      ["設定資料と本文の矛盾を検知したい", "矛盾を洗う"],
      ["新話を投稿する前の準備を教えて", "投稿の準備をする"],
      ["新規作品を登録してプロットを作成したい", "新しい作品を始める"],
    ];

    for (const [question, title] of cases) {
      const picked = selectProcedure({ question });
      expect(picked?.title, question).toBe(title);
    }
  });

  test("合うものが無ければ渡さない", () => {
    // 作品の中身の相談。順路を教える場面ではない
    for (const question of [
      "主人公の動機が弱い気がします",
      "この段落は冗長ですか",
      "第12話の終わり方が唐突でしょうか",
      "タイトルはこれでいいと思う？",
    ]) {
      expect(selectProcedure({ question }), question).toBeUndefined();
    }
  });

  test("追い質問では、直前の発言から話題を引き継ぐ", () => {
    const picked = selectProcedure({
      question: "それはどこから？",
      recentAuthorTurns: ["誤字脱字の検知を掛けたい"],
    });

    expect(picked?.key).toBe("polish");
  });
});

describe("相談1回ぶんへの載り方", () => {
  test("操作の相談では、手順書きが1本だけ載る", () => {
    const built = buildFeatureGuideForQuestion({
      question: "誤字脱字の検知はどこから",
    });

    expect(built.procedure).toBe("推敲して仕上げる");
    // 見出しは1つだけ。2本載ると、どちらに従えばよいか分からなくなる
    const headings = built.text
      .split("\n")
      .filter((line) => line.startsWith("【この仕事の手順"));
    expect(headings.length).toBe(1);
  });

  test("創作の相談には、手順書きを渡さない", () => {
    const built = buildFeatureGuideForQuestion({
      question: "主人公の動機が弱い気がします",
    });

    expect(built.procedure).toBeUndefined();
    expect(built.text).not.toContain("この仕事の手順");
  });
});
