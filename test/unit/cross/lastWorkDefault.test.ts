import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orderByLastWork } from "../../../src/core/workTarget";

/**
 * 作品を選ぶ一覧で、**直前に使った作品を一番上・選ばれた状態**にする
 * （作者の裁定 J13、2026-09-26）。
 *
 * ## 何が起きていたか
 *
 * 検知の操作（誤字脱字・推敲・矛盾）は毎回18作品の一覧を出し、
 * 伏線の操作も同じく一覧を出す形に揃っていた。作者の希望は
 * 「直前の作品を既定にして、変えたいときだけ選び直す形が負担は軽い」で、
 * 揃った方向が逆だった。
 *
 * ## 覚える場所は1つ
 *
 * 簡単ステップメニューの「選択作品」を直前の作品として使う。機能ごとに
 * 別々に覚えると、誤字脱字で選んだ作品と伏線で選んだ作品がずれ、
 * どちらが「直前」なのか作者から見えなくなる。
 */

describe("直前の作品を一番上へ", () => {
  const works = [{ id: "w-1" }, { id: "w-2" }, { id: "w-3" }];

  test("直前の作品を先頭へ出し、残りの順は変えない", () => {
    const result = orderByLastWork(works, "w-3");
    expect(result.ordered.map((w) => w.id)).toEqual(["w-3", "w-1", "w-2"]);
    expect(result.lastFirst).toBe(true);
  });

  test("直前の作品が無ければ、並びはそのまま", () => {
    const result = orderByLastWork(works, undefined);
    expect(result.ordered.map((w) => w.id)).toEqual(["w-1", "w-2", "w-3"]);
    expect(result.lastFirst).toBe(false);
  });

  test("登録から外れた作品は当てにしない", () => {
    const result = orderByLastWork(works, "w-9");
    expect(result.ordered.map((w) => w.id)).toEqual(["w-1", "w-2", "w-3"]);
    expect(result.lastFirst).toBe(false);
  });

  test("元の配列を書き換えない", () => {
    const original = [...works];
    orderByLastWork(works, "w-2");
    expect(works).toEqual(original);
  });
});

describe("検知と伏線の操作は、直前の作品を既定にする", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../src/extension.ts"),
    "utf8"
  );

  /** コマンドの登録から、次の登録までを切り出す */
  function commandBody(id: string): string {
    // 呼び出し（executeCommand）ではなく、登録の所を探す
    const start = source.search(
      new RegExp(`registerCommand\\(\\s*"${id.replace(/\./g, "\\.")}",`)
    );
    expect(start, `${id} の登録が見つからない`).toBeGreaterThan(0);
    const next = source.indexOf("registerCommand(", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  test.each([
    "novelai.checkTypos",
    "novelai.checkProofread",
    "novelai.checkContradictions",
    "novelai.checkFactContradictions",
    "novelai.openForeshadows",
    "novelai.setForeshadowStatus",
    "novelai.checkForeshadows",
    "novelai.checkForeshadowResolution",
  ])("%s は preferLast を付けて作品を決める", (id) => {
    expect(commandBody(id)).toMatch(/resolveWork\([^)]*preferLast: true/);
  });

  test("作品を選ぶ一覧は、直前の作品を先頭に並べる", () => {
    const start = source.indexOf("async function resolveWorkUnrouted(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("orderByLastWork(");
  });

  test("決まった作品を「直前の作品」として覚える（覚える所は1つ）", () => {
    const start = source.indexOf("async function resolveWork(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("lastWorkMemory?.set(work.id)");
    // 覚える先は簡単ステップメニューの「選択作品」
    expect(source).toMatch(/lastWorkMemory = \{[\s\S]{0,200}stepProvider\.selectWork\(/);
  });
});
