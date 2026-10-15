import { describe, expect, test } from "vitest";
import {
  MANUSCRIPT_READONLY_RESCUE_MAX,
  MANUSCRIPT_READONLY_RESCUE_TTL_MS,
  dropReadonlyRescue,
  makeReadonlyRescue,
  parseReadonlyRescues,
  putReadonlyRescue,
  settleReadonlyRescue,
  takeReadonlyRescue,
} from "../../../src/core/manuscriptReadonlyRescue";
import { screenTextHash, textFingerprint } from "../../../src/core/screenEditRebase";

/**
 * 読み取り専用の原稿に打った字の、拡張機能の側の控え（作者の裁定、2026-10-15 23時。
 * 設計書6.25.9）。タブを閉じると画面の控え（setState）は消えるので、拡張機能の側にも置き、
 * 次に同じ原稿を開いたときに既存の控えの帯で［戻す］を出す。
 *
 * ここで見るのは、形を信用しないこと・古い控えを出さないこと・別の原稿の控えに触らないこと・
 * 取り戻したり捨てたりした控えだけを消すこと。
 */
const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("控えを作る", () => {
  test("元の本文の字数と指紋（画面の textHash と同じ8桁）を持つ", () => {
    const rescue = makeReadonlyRescue("doc-1", "元の本文に打った字", "元の本文", T0);
    expect(rescue).toEqual({
      docKey: "doc-1",
      text: "元の本文に打った字",
      at: T0,
      baseLength: 4,
      baseHash: screenTextHash("元の本文"),
    });
    // 画面へ送る指紋（字数つき）の頭と同じ計算
    expect(textFingerprint("元の本文").startsWith(rescue.baseHash + ":")).toBe(true);
  });
});

describe("置く・取り出す", () => {
  test("置いた控えは、同じ原稿で取り出せる（取り出しても消えない）", () => {
    const rescue = makeReadonlyRescue("doc-1", "打った字", "元", T0);
    const put = putReadonlyRescue(undefined, rescue, T0);
    expect(put.changed).toBe(true);
    expect(takeReadonlyRescue(put.value, "doc-1", T0 + 1000)).toEqual(rescue);
    // 作者が［戻す］か［捨てる］を選ぶまで残す（決める前にもう一度閉じられても失わない）
    expect(takeReadonlyRescue(put.value, "doc-1", T0 + 2000)).toEqual(rescue);
  });

  test("別の原稿の控えは取り出さない", () => {
    const put = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "打った字", "元", T0), T0);
    expect(takeReadonlyRescue(put.value, "doc-2", T0)).toBeUndefined();
  });

  test("同じ原稿へ置き直すと、新しい控えに入れ替わる（1原稿に1件）", () => {
    const first = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "打った字", "元", T0), T0);
    const second = putReadonlyRescue(
      first.value,
      makeReadonlyRescue("doc-1", "打った字を足した", "元", T0 + 10),
      T0 + 10
    );
    expect(second.changed).toBe(true);
    expect(takeReadonlyRescue(second.value, "doc-1", T0 + 20)?.text).toBe("打った字を足した");
    expect(Object.keys(parseReadonlyRescues(second.value, T0 + 20))).toEqual(["doc-1"]);
  });

  test("同じ本文・同じ元なら書き直さない（送り直しのたびに書かない）", () => {
    const first = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "打った字", "元", T0), T0);
    const again = putReadonlyRescue(
      first.value,
      makeReadonlyRescue("doc-1", "打った字", "元", T0 + 4000),
      T0 + 4000
    );
    expect(again.changed).toBe(false);
  });

  test("別の原稿の控えは、置いても残る", () => {
    const first = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "一の字", "元", T0), T0);
    const second = putReadonlyRescue(first.value, makeReadonlyRescue("doc-2", "二の字", "元", T0), T0);
    expect(takeReadonlyRescue(second.value, "doc-1", T0)?.text).toBe("一の字");
    expect(takeReadonlyRescue(second.value, "doc-2", T0)?.text).toBe("二の字");
  });

  test(`原稿の数は ${MANUSCRIPT_READONLY_RESCUE_MAX} 件まで（古い控えから落とす）`, () => {
    let value: unknown = undefined;
    for (let i = 0; i <= MANUSCRIPT_READONLY_RESCUE_MAX; i++) {
      value = putReadonlyRescue(value, makeReadonlyRescue(`doc-${i}`, `字${i}`, "元", T0 + i), T0 + i).value;
    }
    const kept = parseReadonlyRescues(value, T0 + 100);
    expect(Object.keys(kept)).toHaveLength(MANUSCRIPT_READONLY_RESCUE_MAX);
    expect(kept["doc-0"]).toBeUndefined();
    expect(kept[`doc-${MANUSCRIPT_READONLY_RESCUE_MAX}`]).toBeDefined();
  });
});

describe("古い控え・壊れた形", () => {
  test("期限（7日。画面の控えと同じ）を過ぎた控えは出さない", () => {
    expect(MANUSCRIPT_READONLY_RESCUE_TTL_MS).toBe(7 * DAY);
    const put = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "打った字", "元", T0), T0);
    expect(takeReadonlyRescue(put.value, "doc-1", T0 + 7 * DAY)).toBeDefined();
    expect(takeReadonlyRescue(put.value, "doc-1", T0 + 7 * DAY + 1)).toBeUndefined();
  });

  test("期限を過ぎた控えは、次に書くときに刈る", () => {
    const old = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "古い字", "元", T0), T0);
    const fresh = putReadonlyRescue(
      old.value,
      makeReadonlyRescue("doc-2", "新しい字", "元", T0 + 8 * DAY),
      T0 + 8 * DAY
    );
    expect(Object.keys(fresh.value as object)).toEqual(["doc-2"]);
  });

  test("未来の時刻（時計のずれ）の控えは出さない", () => {
    const put = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "打った字", "元", T0 + DAY), T0 + DAY);
    expect(takeReadonlyRescue(put.value, "doc-1", T0)).toBeUndefined();
  });

  test.each([
    ["空", undefined],
    ["文字列", "控え"],
    ["配列", [1, 2]],
    ["本文が無い", { "doc-1": { docKey: "doc-1", at: T0, baseLength: 1, baseHash: "x" } }],
    ["鍵と中の原稿が違う", { "doc-1": { docKey: "doc-2", text: "字", at: T0, baseLength: 1, baseHash: "x" } }],
    ["時刻が文字列", { "doc-1": { docKey: "doc-1", text: "字", at: "きのう", baseLength: 1, baseHash: "x" } }],
  ])("壊れた形（%s）は使わない", (_label, raw) => {
    expect(takeReadonlyRescue(raw, "doc-1", T0)).toBeUndefined();
  });
});

describe("消す", () => {
  test("［戻す］［捨てる］で片づいた本文と同じ控えだけを消す", () => {
    const put = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "打った字", "元", T0), T0);
    // 別の帯（重なって入らなかった字など）を片づけただけでは消さない
    expect(settleReadonlyRescue(put.value, "doc-1", "別の本文", T0).changed).toBe(false);
    const settled = settleReadonlyRescue(put.value, "doc-1", "打った字", T0);
    expect(settled.changed).toBe(true);
    expect(takeReadonlyRescue(settled.value, "doc-1", T0)).toBeUndefined();
    // 最後の1件が消えたら、覚えの鍵ごと消す（空の箱を残さない）
    expect(settled.value).toBeUndefined();
  });

  test("原稿に入ったら（読み取り専用が外れた）、その原稿の控えを消す", () => {
    const first = putReadonlyRescue(undefined, makeReadonlyRescue("doc-1", "一の字", "元", T0), T0);
    const second = putReadonlyRescue(first.value, makeReadonlyRescue("doc-2", "二の字", "元", T0), T0);
    const dropped = dropReadonlyRescue(second.value, "doc-1", T0);
    expect(dropped.changed).toBe(true);
    expect(takeReadonlyRescue(dropped.value, "doc-1", T0)).toBeUndefined();
    expect(takeReadonlyRescue(dropped.value, "doc-2", T0)?.text).toBe("二の字");
    // 無い控えを消しても書き直さない
    expect(dropReadonlyRescue(dropped.value, "doc-1", T0).changed).toBe(false);
  });
});
