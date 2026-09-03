import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  FOCUS_CHAT_KEY,
  SOLO_VIEW_KEY,
  initialViewContext,
  resetViewVisibility,
} from "../../src/views/viewVisibility";

/**
 * 左側の4つのビューの出し入れ（作者の報告、2026-09-03）。
 *
 * 「VSCodeを再起動したとき、詳細メニューの下に『AIに相談』が無いことがある」。
 *
 * 出し入れは `package.json` のビューの `when` 式が、2つの印
 * （`novelai.focusChat`・`novelai.soloView`）を見て決めている。印は
 * `setContext` だけで持っており、**拡張機能は起動時に初期値を入れていなかった。**
 * 印が前の状態のまま残っていると（拡張機能ホストだけが再起動した場合など）、
 * 相談のビューだけ消えた状態で立ち上がる。
 *
 * ここでは**実際の `when` 式を `package.json` から読んで**評価する。
 * 式を試験側へ書き写すと、`package.json` を直したときに嘘をつく。
 */

interface Manifest {
  contributes: { views: { novelai: Array<{ id: string; when?: string }> } };
}

const VIEWS = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as Manifest
).contributes.views.novelai;

/**
 * `when` 式を評価する。
 *
 * 式に出てくる語は**印の名前か、引用符つきの文字列**しかないので、
 * 印の名前だけを表の引きに置き換えればJavaScriptとして読める。
 */
function evaluateWhen(
  expression: string | undefined,
  context: Record<string, unknown>
): boolean {
  if (!expression) return true;
  const js = expression.replace(
    /'[^']*'|[A-Za-z_][\w.]*/g,
    (token) =>
      token.startsWith("'") ? token : `ctx[${JSON.stringify(token)}]`
  );
  return Boolean(new Function("ctx", `return (${js});`)(context));
}

function visibleViews(context: Record<string, unknown>): string[] {
  return VIEWS.filter((view) => evaluateWhen(view.when, context)).map(
    (view) => view.id
  );
}

describe("起動直後は、4つのビューがすべて出る", () => {
  test("印の初期値では、どのビューも隠れない", () => {
    const shown = visibleViews(initialViewContext());

    expect(shown).toEqual(VIEWS.map((view) => view.id));
    // 相談のビューが落ちるのが、作者の見た症状である
    expect(shown).toContain("novelai.chatView");
  });

  test("4つとも `package.json` に在る（式の取り違えを防ぐ）", () => {
    expect(VIEWS.map((view) => view.id)).toEqual([
      "novelai.works",
      "novelai.steps",
      "novelai.actions",
      "novelai.chatView",
    ]);
  });
});

describe("印が残っていると、相談のビューが消える", () => {
  test("「他のメニューを閉じる」の残りで、相談だけ落ちる", () => {
    // これが作者の見た状態。詳細メニューは出ているのに相談が無い
    const shown = visibleViews({
      [FOCUS_CHAT_KEY]: false,
      [SOLO_VIEW_KEY]: "actions",
    });

    expect(shown).toContain("novelai.actions");
    expect(shown).not.toContain("novelai.chatView");
  });

  test("相談に集中する表示の残りでは、ほかが全部落ちる", () => {
    const shown = visibleViews({
      [FOCUS_CHAT_KEY]: true,
      [SOLO_VIEW_KEY]: undefined,
    });

    expect(shown).toEqual(["novelai.chatView"]);
  });
});

describe("起動のたびに素の状態へ戻す", () => {
  test("2つの印を、両方とも入れ直す", async () => {
    const written: Array<{ key: string; value: unknown }> = [];
    await resetViewVisibility((key, value) => {
      written.push({ key, value });
    });

    expect(written).toEqual([
      { key: FOCUS_CHAT_KEY, value: false },
      { key: SOLO_VIEW_KEY, value: undefined },
    ]);
  });

  test("入れ直した印で、4つのビューがすべて出る", async () => {
    // **「戻した」と「出る」を別々に見る。** 印を入れ直しても、
    // 値が when 式の期待と食い違っていれば意味がない
    const context: Record<string, unknown> = {
      [FOCUS_CHAT_KEY]: true,
      [SOLO_VIEW_KEY]: "works",
    };
    await resetViewVisibility((key, value) => {
      context[key] = value;
    });

    expect(visibleViews(context)).toEqual(VIEWS.map((view) => view.id));
  });

  test("印の名前は、`package.json` の式に実在する", () => {
    // 名前が食い違うと、戻したつもりの印が別のものになる
    const all = VIEWS.map((view) => view.when ?? "").join(" ");

    expect(all).toContain(FOCUS_CHAT_KEY);
    expect(all).toContain(SOLO_VIEW_KEY);
  });
});
