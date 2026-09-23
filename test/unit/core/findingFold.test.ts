import { describe, expect, test } from "vitest";
import { foldSameFindings } from "../../../src/core/proposalBuckets";

/**
 * 番号の作り方が違うだけの同じ指摘を畳む（設計書6.96.4）。
 *
 * **作者が必ず踏む形**だった——置き場から戻した指摘の番号は中身から作った
 * `f…`、検知が出す番号は `チャンク:行:並び` で、`mergeProposals` は
 * 番号でしか突き合わせないため、**同じ指摘が二重に並んでいた。**
 *
 * ここで見るのは「どちらを残すか」と「残してはいけないものを消していない
 * こと」である。
 */

interface Row {
  id: string;
  status: string;
  /**
   * 置き場での番号。**2つ名乗ることがある**——置き場から戻した行は
   * 残っていた番号を、検知の結果は中身から作り直した番号を持つ。
   */
  identity?: string | string[];
}

const identitiesOf = (row: Row): string[] =>
  row.identity === undefined
    ? []
    : Array.isArray(row.identity)
      ? row.identity
      : [row.identity];

function fold(
  existing: Row[],
  incoming: Row[],
  keepIncoming: boolean
): { existing: Row[]; incoming: Row[] } {
  return foldSameFindings(existing, incoming, identitiesOf, { keepIncoming });
}

describe("同じ指摘を、番号が違っても1件にする", () => {
  test("戻した指摘は、もう一度検知したものに譲る", () => {
    const restored: Row = { id: "fabc", status: "pending", identity: "fabc" };
    const detected: Row = { id: "h1:12:0", status: "pending", identity: "fabc" };

    const folded = fold([restored], [detected], true);

    // **戻した側が消える。** 検知したてのほうはチャンクのハッシュを持ち、
    // 再チェックへ渡せる
    expect(folded.existing).toEqual([]);
    expect(folded.incoming).toEqual([detected]);
  });

  test("置き場から戻す側は、画面に出ている検知の結果を消さない", () => {
    const detected: Row = { id: "h1:12:0", status: "pending", identity: "fabc" };
    const restored: Row = { id: "fabc", status: "pending", identity: "fabc" };

    const folded = fold([detected], [restored], false);

    expect(folded.existing).toEqual([detected]);
    // 届いたほうを捨てる（二重に並べない）
    expect(folded.incoming).toEqual([]);
  });

  test("作者の判断が入っている行は、番号が違っても落とさない", () => {
    const applied: Row = { id: "fabc", status: "applied", identity: "fabc" };
    const detected: Row = { id: "h1:12:0", status: "pending", identity: "fabc" };

    const folded = fold([applied], [detected], true);

    // 適用済みを消すと、戻す（undo）先が画面から消える
    expect(folded.existing).toEqual([applied]);
    expect(folded.incoming).toEqual([detected]);
  });

  test("番号まで同じものは、ここでは触らない（mergeProposals が畳む）", () => {
    const before: Row = { id: "fabc", status: "pending", identity: "fabc" };
    const after: Row = { id: "fabc", status: "pending", identity: "fabc" };

    const folded = fold([before], [after], true);

    expect(folded.existing).toEqual([before]);
    expect(folded.incoming).toEqual([after]);
  });

  test("置き場の番号を作れない行（設定資料の更新など）は、そのまま通る", () => {
    const existing: Row = { id: "a", status: "pending" };
    const incoming: Row = { id: "b", status: "pending" };

    const folded = fold([existing], [incoming], true);

    expect(folded.existing).toEqual([existing]);
    expect(folded.incoming).toEqual([incoming]);
  });

  /**
   * 番号の作り方を変えた直後に起きる。置き場に残っていた行は前の決まりの
   * 番号を名乗り、検知は新しい決まりで名乗る——**どちらで呼ばれても
   * 同じものと分かる**必要がある。
   */
  test("番号の作り方が変わった時期でも、同じ指摘だと分かる", () => {
    const restored: Row = {
      id: "fOLD",
      status: "pending",
      identity: ["fOLD", "fNEW"],
    };
    const detected: Row = { id: "h1:12:0", status: "pending", identity: "fNEW" };

    const folded = fold([restored], [detected], true);

    expect(folded.existing).toEqual([]);
    expect(folded.incoming).toEqual([detected]);
  });

  test("中身の違う指摘は、同じ分類に並んでいても畳まない", () => {
    const existing: Row = { id: "fabc", status: "pending", identity: "fabc" };
    const incoming: Row = { id: "h1:9:0", status: "pending", identity: "fxyz" };

    const folded = fold([existing], [incoming], true);

    expect(folded.existing).toEqual([existing]);
    expect(folded.incoming).toEqual([incoming]);
  });
});
