import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * **設定の説明が、また長くならないための網**（作者の指示、2026-09-22
 * 「メニューや設定が口語体すぎるので、もっとメニューっぽく簡潔に。全部です」）。
 *
 * メニュー側（`actionList.test.ts`・`stepMenu.test.ts`）と同じ形の網を、
 * 設定側にも張る。**片方だけ縛ると、もう片方だけがまた読み物へ戻る。**
 *
 * 説明は二段組みに揃えてある。
 *
 * ```
 * 何を決める設定かの1行（体言止め）
 *
 * ・事柄
 * ・事柄
 *
 * 表・コマンドリンク・注意（あれば）
 * ```
 *
 * **見るのは1行目だけにする。** 設定の説明には、実測の表（`mergeChunkChars`）や
 * コマンドリンクのように**消すと値を決められなくなるもの**が入っている。
 * 全体の長さを縛ると、それを削ることになる。1行目が短ければ、設定画面を
 * 上から眺めて「何の設定か」を拾う分には足りる。
 *
 * 60字は、書き換えた時点の実測（1行目の最長51字）に余裕を持たせた値である。
 * メニューの40字より緩いのは、設定名が `novelai.lmstudio.contextWindow` のように
 * 機械の名前で、**1行目で機能の名前を言い直す必要がある**ため。
 */

type Property = {
  description?: string;
  markdownDescription?: string;
};

const manifest = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as {
  contributes: { configuration: { properties: Record<string, Property> } };
};

const properties = manifest.contributes.configuration.properties;

/** 設定画面に出る説明（Markdown版があればそちら） */
function descriptionOf(property: Property): string {
  return property.markdownDescription ?? property.description ?? "";
}

describe("設定の説明の長さ", () => {
  test("すべての設定に説明がある", () => {
    const missing = Object.entries(properties)
      .filter(([, property]) => descriptionOf(property).trim() === "")
      .map(([key]) => key);

    expect(missing, "説明が空だと、何のための設定か分からないまま並ぶ").toEqual(
      []
    );
  });

  test("説明の1行目は60字以内", () => {
    const tooLong = Object.entries(properties)
      .map(([key, property]) => ({
        key,
        head: descriptionOf(property).split("\n")[0],
      }))
      .filter((entry) => entry.head.length > 60)
      .map((entry) => `${entry.key}（${entry.head.length}字）：${entry.head}`);

    expect(
      tooLong,
      "1行目は「何を決める設定か」だけ。詳しいことは「・」の事柄へ"
    ).toEqual([]);
  });
});
