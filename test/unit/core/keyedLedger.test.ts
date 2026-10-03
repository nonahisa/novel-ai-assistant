import { describe, expect, test } from "vitest";
import { KeyedLedger } from "../../../src/core/keyedLedger";

/**
 * 原稿エディターの台帳（作者の報告、2026-10-03。設計書6.25.11）。
 *
 * 校正・メモパネルの行を押すと、左で開いている同じ話があるのに右へもう1枚
 * 開き、元の画面が空白になった。台帳が「鍵1つに1件」で、**同じ原稿の2枚目が
 * 1枚目を上書きし、2枚目を閉じると鍵ごと消えていた**。1枚目はまだ開いて
 * いるのに台帳に無いので、飛ぶ道が「開いていない」と読んで開き直す。
 */

interface Face {
  name: string;
  active?: boolean;
  visible?: boolean;
}

const rank = (face: Face): number => (face.active ? 2 : face.visible ? 1 : 0);
const KEY = "c:/小説/たゆたう鉛/episode_0001.md";

describe("同じ原稿の面が2枚あるとき", () => {
  test("2枚目を閉じても、1枚目は台帳に残る", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左", visible: true };
    const right: Face = { name: "右", visible: true };
    ledger.add(KEY, left);
    ledger.add(KEY, right);

    ledger.remove(KEY, right);

    expect(ledger.get(KEY)).toBe(left);
    expect(ledger.has(KEY)).toBe(true);
    expect([...ledger.keys()]).toEqual([KEY]);
  });

  test("1枚目を閉じても、2枚目は台帳に残る", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左" };
    const right: Face = { name: "右" };
    ledger.add(KEY, left);
    ledger.add(KEY, right);

    ledger.remove(KEY, left);

    expect(ledger.get(KEY)).toBe(right);
  });

  test("両方閉じたら、鍵ごと消える", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左" };
    const right: Face = { name: "右" };
    ledger.add(KEY, left);
    ledger.add(KEY, right);

    ledger.remove(KEY, left);
    ledger.remove(KEY, right);

    expect(ledger.get(KEY)).toBeUndefined();
    expect(ledger.has(KEY)).toBe(false);
    expect(ledger.values()).toEqual([]);
  });

  test("前面の面を選ぶ（後から開いた面より、いま前にある面）", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左", active: true, visible: true };
    const hidden: Face = { name: "隠れた2枚目" };
    ledger.add(KEY, left);
    ledger.add(KEY, hidden);

    expect(ledger.get(KEY)).toBe(left);
  });

  test("同じ優先度なら、最後に使った面を選ぶ", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const first: Face = { name: "1枚目" };
    const second: Face = { name: "2枚目" };
    ledger.add(KEY, first);
    ledger.add(KEY, second);
    expect(ledger.get(KEY)).toBe(second);

    ledger.touch(KEY, first);

    expect(ledger.get(KEY)).toBe(first);
  });

  test("鍵をまたいだ一覧には、2枚とも並ぶ（窓の札で数える）", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左" };
    const right: Face = { name: "右" };
    const other: Face = { name: "別の話" };
    ledger.add(KEY, left);
    ledger.add(KEY, right);
    ledger.add("c:/小説/たゆたう鉛/episode_0002.md", other);

    expect(ledger.values()).toEqual([left, right, other]);
    expect(ledger.all(KEY)).toEqual([left, right]);
  });
});

describe("ほかの面を巻き添えにしない", () => {
  test("載っていない面を外しても、何も変わらない", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左" };
    ledger.add(KEY, left);

    expect(ledger.remove(KEY, { name: "知らない面" })).toBe(false);
    expect(ledger.get(KEY)).toBe(left);
  });

  test("同じ面を2度載せても、1件のまま", () => {
    const ledger = new KeyedLedger<Face>(rank);
    const left: Face = { name: "左" };
    ledger.add(KEY, left);
    ledger.add(KEY, left);

    expect(ledger.all(KEY)).toHaveLength(1);
    ledger.remove(KEY, left);
    expect(ledger.has(KEY)).toBe(false);
  });
});
