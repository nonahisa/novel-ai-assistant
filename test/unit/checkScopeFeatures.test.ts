import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { window } from "./support/vscodeStub";
import { disposeLog } from "../../src/core/logger";
import type { WorkEntry } from "../../src/models/types";
import {
  resolveCheckScope,
  scopeFeatureSpec,
  describeChosenScope,
  type ScopeFeature,
} from "../../src/features/typoCheckScope";

/**
 * 範囲の選択は、**機能ごとに分かれていなければならない**
 * （作者の指摘、2026-09-20）。
 *
 * 「誤字脱字の前回」と「矛盾検知の前回」は別物である。時刻を1つのファイルへ
 * まとめると、**誤字脱字を走らせた時刻で矛盾検知が絞られ、まだ一度も矛盾を
 * 見ていない話が黙って対象から外れる。** 覚え（「以降はこの選択で進む」）も
 * 同じ理由で分ける——誤字脱字は差分で足りても、矛盾は全体で見たいことがある。
 */

const FEATURES: ScopeFeature[] = [
  "typo",
  "contradiction",
  "proofread",
  "foreshadow",
  "deviation",
];

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

/** ログへ出た行。飛ばした中身を捨てていないことを、ここで確かめる */
let logged: string[] = [];

const stub = window as unknown as Record<string, unknown>;
const originalCreateOutputChannel = stub.createOutputChannel;

beforeEach(() => {
  logged = [];
  stub.createOutputChannel = () => ({
    appendLine: (line: string) => logged.push(line),
    show: () => undefined,
    dispose: () => undefined,
  });
});

afterEach(() => {
  // ログの出力先は module 側に覚えられているので、捨ててから戻す
  disposeLog();
  stub.createOutputChannel = originalCreateOutputChannel;
});

describe("時刻と覚えは、機能ごとに分ける", () => {
  test("時刻を控えるファイル名が、5つとも違う", () => {
    const names = FEATURES.map((feature) => scopeFeatureSpec(feature).fileName);

    expect(new Set(names).size).toBe(FEATURES.length);
  });

  test("「以降はこの選択で進む」の覚えも、5つとも違う", () => {
    const ids = FEATURES.map((feature) => scopeFeatureSpec(feature).rememberId);

    expect(new Set(ids).size).toBe(FEATURES.length);
  });

  test("誤字脱字のファイル名は変えない（手元の記録を無かったことにしない）", () => {
    expect(scopeFeatureSpec("typo").fileName).toBe("typo_last_check.json");
  });

  test("呼び名も5つとも違う（ログでどの検知か読める）", () => {
    const labels = FEATURES.map((feature) => scopeFeatureSpec(feature).label);

    expect(new Set(labels).size).toBe(FEATURES.length);
  });
});

/**
 * **まとめ実行では聞かない**（設計書6.80）。量と料金の確認を1枚へまとめた
 * のに、そのあと個々の検知が選択画面を出すと、作者はボタン1回で放置できない。
 */
describe("まとめ実行では聞かない", () => {
  for (const feature of FEATURES) {
    test(`${feature}：聞かずに全体を選んだことにする`, async () => {
      expect(await resolveCheckScope(work, feature, { suiteConfirmed: true }))
        .toEqual({ kind: "all" });
    });
  }

  test("飛ばしたことを、どの検知かが分かる形でログへ残す", async () => {
    // **黙って全体にしない。** あとから「なぜ全話ぶん走ったのか」を
    // 追えないと、料金や待ち時間の問い合わせに答えられない
    await resolveCheckScope(work, "contradiction", { suiteConfirmed: true });

    const text = logged.join("\n");
    expect(text).toContain("矛盾検知");
    expect(text).toContain("まとめ実行のため対象は全体");
  });
});

describe("絞ったことを、完了の知らせでも黙らない", () => {
  test("全体のときは何も添えない", () => {
    expect(describeChosenScope("all")).toBe("");
  });

  test("差分のときは、そう書く", () => {
    expect(describeChosenScope("changed")).toContain("前回から書いた分");
  });

  test("試したときは、話数まで書く", () => {
    // 「10話しか見ていない」ことが知らせに出ていないと、
    // 少ない指摘を「作品全体で問題なし」と読んでしまう
    expect(describeChosenScope("first")).toContain("10話");
  });
});
