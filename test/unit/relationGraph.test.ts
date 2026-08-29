import { describe, expect, test } from "vitest";
import {
  emptyCharacter,
  type AddressTerm,
  type Character,
} from "../../src/models/character";
import {
  buildRelationGraph,
  egoGraph,
  filterRelationGraph,
  isolatedNodes,
  UNRESOLVED_ID_PREFIX,
} from "../../src/core/relationGraph";

/**
 * 人物相関図の材料（設計書6.38.1）。
 *
 * 画面は描くだけで、組み立てはすべてここが持つ。図の見え方の不具合は
 * 実機でしか気づけないが、材料の組み立て違い（線が二重になる・相手を
 * 取り違える・黙って落とす）はここで止められる。
 */

function character(
  id: string,
  name: string,
  extra: Partial<Character> = {}
): Character {
  return { ...emptyCharacter(id, name), ...extra };
}

/** 呼称を1件作る。forms の中身は term しか見ないので、ほかは空にする */
function address(
  targetName: string,
  terms: string[],
  targetId: string | null = null
): AddressTerm {
  return {
    targetName,
    targetId,
    authorLocked: false,
    forms: terms.map((term) => ({
      term,
      category: null,
      context: null,
      firstChapter: null,
      lastChapter: null,
      status: "current" as const,
      evidence: null,
    })),
  };
}

describe("辺のまとめ方", () => {
  test("向きの違う関係が1本にまとまる", () => {
    // A→B「師匠」とB→A「弟子」で線を2本引くと、同じ2人の間に
    // 線が何本も走って読めない図になる
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "月島", relation: "師匠" }],
      }),
      character("char_002", "月島", {
        relations: [{ name: "灯", relation: "弟子" }],
      }),
    ]);

    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0];
    expect([edge.a, edge.b]).toEqual(["char_001", "char_002"]);
    expect(edge.weight).toBe(2);
    expect(edge.labels).toEqual([
      { from: "char_001", to: "char_002", kind: "relation", text: "師匠" },
      { from: "char_002", to: "char_001", kind: "relation", text: "弟子" },
    ]);
  });

  test("呼称と関係が同じ辺に載る", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "月島", relation: "師匠" }],
        addressTerms: [address("月島", ["先生", "師匠殿"])],
      }),
      character("char_002", "月島", {}),
    ]);

    expect(graph.edges).toHaveLength(1);
    // 関係1つ＋呼称2つ。太さは本数で決まる
    expect(graph.edges[0].weight).toBe(3);
    expect(graph.edges[0].labels.map((label) => label.kind)).toEqual([
      "relation",
      "address",
      "address",
    ]);
    expect(graph.edges[0].labels.map((label) => label.text)).toEqual([
      "師匠",
      "先生",
      "師匠殿",
    ]);
  });

  test("同じ言葉を二度数えない", () => {
    // 資料の重複で太さだけが増えると、関係の濃さを読み違える
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [
          { name: "月島", relation: "師匠" },
          { name: "月島", relation: "師匠" },
        ],
      }),
      character("char_002", "月島", {}),
    ]);
    expect(graph.edges[0].weight).toBe(1);
  });

  test("自分への呼称は辺にしない", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        addressTerms: [address("灯", ["わたし"])],
      }),
    ]);
    expect(graph.edges).toHaveLength(0);
    expect(graph.unresolved).toHaveLength(0);
  });
});

describe("相手の解決", () => {
  test("targetId があればそれを使う", () => {
    // 名前で引くと別人に当たる場面でも、idの指し先が正である
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        addressTerms: [address("月島", ["先生"], "char_003")],
      }),
      character("char_002", "月島", {}),
      character("char_003", "マルキオ", {}),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect([graph.edges[0].a, graph.edges[0].b]).toEqual([
      "char_001",
      "char_003",
    ]);
  });

  test("targetId の指し先が消えていれば、名前で引き直す", () => {
    // 人物を消したり分けたりしたあと、古いidが残っていることがある。
    // 辺ごと落とすと、資料にある関係が黙って消える
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        addressTerms: [address("月島", ["先生"], "char_999")],
      }),
      character("char_002", "月島", {}),
    ]);

    expect([graph.edges[0].a, graph.edges[0].b]).toEqual([
      "char_001",
      "char_002",
    ]);
  });

  test("別名でも引き当てる", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "灯火", relation: "幼なじみ" }],
      }),
      character("char_002", "月島", { aliases: ["灯火"] }),
    ]);

    expect([graph.edges[0].a, graph.edges[0].b]).toEqual([
      "char_001",
      "char_002",
    ]);
  });

  test("長い名前が勝つ", () => {
    // 「マルキオ・イークェス」を「マルキオ」で引き当てて別人にしない
    const graph = buildRelationGraph([
      character("char_001", "マルキオ", {}),
      character("char_002", "マルキオ・イークェス", {}),
      character("char_003", "灯", {
        relations: [{ name: "マルキオ・イークェス", relation: "同僚" }],
      }),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect([graph.edges[0].a, graph.edges[0].b]).toEqual([
      "char_002",
      "char_003",
    ]);
  });

  test("解決できない相手は unresolved に残り、仮ノードになる", () => {
    // 落とすと、抽出漏れに気づく機会が消える（設計書6.38.5）
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "名も無き剣士", relation: "恩人" }],
        addressTerms: [address("名も無き剣士", ["旦那", "先生"])],
      }),
    ]);

    expect(graph.unresolved).toEqual([
      { fromId: "char_001", targetName: "名も無き剣士", kind: "relation" },
      { fromId: "char_001", targetName: "名も無き剣士", kind: "address" },
    ]);

    const provisional = graph.nodes.filter((node) => node.provisional);
    expect(provisional).toHaveLength(1);
    expect(provisional[0].id).toBe(UNRESOLVED_ID_PREFIX + "名も無き剣士");
    // 呼び方が3通りあっても、足りていない相手は1人である
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].weight).toBe(3);
  });
});

describe("個人中心図", () => {
  /** 灯 — 月島 — マルキオ — 遠い人 の鎖 */
  function chain(): Character[] {
    return [
      character("char_001", "灯", {
        relations: [{ name: "月島", relation: "師匠" }],
      }),
      character("char_002", "月島", {
        relations: [{ name: "マルキオ", relation: "同僚" }],
      }),
      character("char_003", "マルキオ", {
        relations: [{ name: "遠い人", relation: "親" }],
      }),
      character("char_004", "遠い人", {}),
    ];
  }

  test("1次だけを出す", () => {
    const ego = egoGraph(buildRelationGraph(chain()), "char_001");
    expect(ego.nodes.map((node) => [node.id, node.ring])).toEqual([
      ["char_001", 0],
      ["char_002", 1],
    ]);
    expect(ego.edges).toHaveLength(1);
  });

  test("2次まで出す", () => {
    const ego = egoGraph(buildRelationGraph(chain()), "char_001", 2);
    expect(ego.nodes.map((node) => [node.id, node.ring])).toEqual([
      ["char_001", 0],
      ["char_002", 1],
      ["char_003", 2],
    ]);
    // 1次と2次のあいだの線も出す（誰と誰が繋がって2次に居るのかが要る）
    expect(ego.edges).toHaveLength(2);
  });

  test("中心が図に居なければ空を返す", () => {
    // 絞り込みで落ちた中心を開いたときに、例外で画面ごと止めない
    const ego = egoGraph(buildRelationGraph(chain()), "char_999");
    expect(ego.nodes).toEqual([]);
    expect(ego.edges).toEqual([]);
  });
});

describe("孤立している人物", () => {
  test("関係も呼称も無い人物を拾う", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "月島", relation: "師匠" }],
      }),
      character("char_002", "月島", {}),
      character("char_003", "通行人", {}),
    ]);
    expect(isolatedNodes(graph).map((node) => node.id)).toEqual(["char_003"]);
  });
});

describe("絞り込み", () => {
  function sample(): Character[] {
    return [
      character("char_001", "灯", {
        affiliation: "窓口課",
        appearedChapters: [1, 2, 3],
        relations: [{ name: "月島", relation: "師匠" }],
        addressTerms: [address("月島", ["先生"])],
      }),
      character("char_002", "月島", {
        affiliation: "窓口課",
        appearedChapters: [1, 2],
      }),
      character("char_003", "顔だけの人", {
        affiliation: "生活保護課",
        appearedChapters: [7],
      }),
    ];
  }

  test("孤立ノードは既定で畳む", () => {
    const result = filterRelationGraph(buildRelationGraph(sample()));
    expect(result.graph.nodes.map((node) => node.id)).toEqual([
      "char_001",
      "char_002",
    ]);
    expect(result.hiddenIsolated.map((node) => node.name)).toEqual([
      "顔だけの人",
    ]);
  });

  test("全部出す切替で戻る", () => {
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      showIsolated: true,
    });
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.hiddenIsolated).toEqual([]);
  });

  test("種類で辺を絞ると、太さも数え直す", () => {
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      kinds: ["address"],
    });
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0].weight).toBe(1);
    expect(result.graph.edges[0].labels[0].text).toBe("先生");
  });

  test("登場話数の下限で落とすと、相手の辺も消える", () => {
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      minChapters: 3,
      showIsolated: true,
    });
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["char_001"]);
    expect(result.graph.edges).toEqual([]);
  });

  test("仮ノードは登場話数では落とさない", () => {
    // 登場話数が空なのは資料が無いからで、条件に外れたわけではない
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [1, 2, 3],
        relations: [{ name: "名も無き剣士", relation: "恩人" }],
      }),
    ]);
    const result = filterRelationGraph(graph, { minChapters: 2 });
    expect(result.graph.nodes.map((node) => node.provisional)).toEqual([
      false,
      true,
    ]);
    expect(result.graph.unresolved).toHaveLength(1);
  });

  test("所属で絞る", () => {
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      affiliations: ["生活保護課"],
      showIsolated: true,
    });
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["char_003"]);
  });

  test("所属を1つも選ばなければ、誰も出ない", () => {
    // チェックを全部外したのに全員出てくると、外した意味が分からない
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      affiliations: [],
      showIsolated: true,
    });
    expect(result.graph.nodes).toEqual([]);
  });
});
