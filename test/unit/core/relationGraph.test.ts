import { describe, expect, test } from "vitest";
import {
  emptyCharacter,
  type AddressTerm,
  type Character,
} from "../../../src/models/character";
import {
  buildRelationGraph,
  countUnresolved,
  egoGraph,
  filterRelationGraph,
  isolatedNodes,
  lastChapterOf,
  normalizeUpToChapter,
  restrictUnresolved,
  shortPairLabel,
  UNRESOLVED_ID_PREFIX,
  type RelationGraph,
} from "../../../src/core/relationGraph";

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

/** 呼称の1形態を、使い始めた話数つきで作る */
function addressForm(term: string, firstChapter: number | null) {
  return {
    term,
    category: null,
    context: null,
    firstChapter,
    lastChapter: null,
    status: "current" as const,
    evidence: null,
  };
}

describe("最終話", () => {
  test("登場話数の件数ではなく、話番号のいちばん後ろを返す", () => {
    // 第1話と第5話に出た人物1人だけなら、最終話は5（件数の2ではない）
    const graph = buildRelationGraph([
      character("char_001", "灯", { appearedChapters: [1, 5] }),
    ]);
    expect(lastChapterOf(graph)).toBe(5);
  });

  test("呼称が始まった話も数える", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [1, 2],
        addressTerms: [
          {
            targetName: "月島",
            targetId: null,
            authorLocked: false,
            forms: [addressForm("先生", 8)],
          },
        ],
      }),
      character("char_002", "月島", { appearedChapters: [1] }),
    ]);
    expect(lastChapterOf(graph)).toBe(8);
  });

  test("つまみの値：最終話以上は「最終話まで」（null）へ寄せる", () => {
    // 数字のまま持つと、資料が増えたときに古い最終話で図が止まる
    expect(normalizeUpToChapter(19, 19)).toBeNull();
    expect(normalizeUpToChapter(25, 19)).toBeNull();
    expect(normalizeUpToChapter(null, 19)).toBeNull();
    expect(normalizeUpToChapter(undefined, 19)).toBeNull();
    expect(normalizeUpToChapter(Number.NaN, 19)).toBeNull();
  });

  test("つまみの値：途中の話はそのまま、1より前は第1話", () => {
    expect(normalizeUpToChapter(5, 19)).toBe(5);
    expect(normalizeUpToChapter(4.6, 19)).toBe(5);
    expect(normalizeUpToChapter(0, 19)).toBe(1);
  });

  test("つまみの値：話数の記録が無い作品では絞らない", () => {
    expect(normalizeUpToChapter(3, 0)).toBeNull();
  });

  test("話数の記録が1つも無ければ0", () => {
    const graph = buildRelationGraph([character("char_001", "灯")]);
    expect(lastChapterOf(graph)).toBe(0);
  });
});

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
      // 関係は話数を持たない（`relations` は名前と言葉だけ）
      {
        from: "char_001",
        to: "char_002",
        kind: "relation",
        text: "師匠",
        firstChapter: null,
      },
      {
        from: "char_002",
        to: "char_001",
        kind: "relation",
        text: "弟子",
        firstChapter: null,
      },
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

describe("名前の解決の厳しさ（設計書6.38.1）", () => {
  test("名前の一部が一致しただけでは結ばない", () => {
    // 未登録の「アリシア」の中に登録済みの「リシア」が入っているだけで
    // 結ぶと、資料のどこにも無い線が図に現れる
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "アリシア", relation: "友人" }],
      }),
      character("char_002", "リシア", {}),
    ]);

    expect(graph.unresolved).toEqual([
      {
        fromId: "char_001",
        targetName: "アリシア",
        kind: "relation",
        reason: "notFound",
      },
    ]);
    expect(graph.edges[0].b).toBe(UNRESOLVED_ID_PREFIX + "アリシア");
  });

  test("同じ名前が複数の人物に当たるときは結ばない", () => {
    // 先勝ちで結ぶと、別人に線が引かれたまま誰も気づけない
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "ハナ", relation: "友人" }],
      }),
      character("char_002", "花村", { aliases: ["ハナ"] }),
      character("char_003", "華岡", { aliases: ["ハナ"] }),
    ]);

    expect(graph.unresolved).toEqual([
      {
        fromId: "char_001",
        targetName: "ハナ",
        kind: "relation",
        reason: "ambiguous",
      },
    ]);
    expect(graph.edges[0].b).toBe(UNRESOLVED_ID_PREFIX + "ハナ");
  });

  test("姓だけ・名だけで呼んでいれば結ぶ", () => {
    // 名前の広げ方（`expandNameVariants`）はそのまま効かせる。
    // 厳しくするのは「全体が一致すること」だけである
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        relations: [{ name: "マルキオ", relation: "師匠" }],
      }),
      character("char_002", "マルキオ・イークェス", {}),
    ]);

    expect(graph.unresolved).toHaveLength(0);
    expect(graph.edges[0].b).toBe("char_002");
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
      {
        fromId: "char_001",
        targetName: "名も無き剣士",
        kind: "relation",
        reason: "notFound",
      },
      {
        fromId: "char_001",
        targetName: "名も無き剣士",
        kind: "address",
        reason: "notFound",
      },
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

  test("第N話までに出ていない人物は落ちる", () => {
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      upToChapter: 6,
      showIsolated: true,
    });
    // 第7話が初登場の「顔だけの人」は、第6話までの図にはまだ居ない
    expect(result.graph.nodes.map((node) => node.id)).toEqual([
      "char_001",
      "char_002",
    ]);
  });

  test("初登場が第N話より後なら、そのあと何話出ていても落ち、相手の辺も消える", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [1, 2],
        relations: [{ name: "月島", relation: "師匠" }],
      }),
      character("char_002", "月島", { appearedChapters: [3, 4, 5, 6] }),
    ]);
    const result = filterRelationGraph(graph, {
      upToChapter: 2,
      showIsolated: true,
    });
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["char_001"]);
    expect(result.graph.edges).toEqual([]);
  });

  test("飛び飛びに登場していても、初登場が第N話までなら残る", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", { appearedChapters: [1, 3] }),
    ]);
    const result = filterRelationGraph(graph, {
      upToChapter: 2,
      showIsolated: true,
    });
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["char_001"]);
    // 大きさは第2話までの登場話数で数える（第3話はまだ来ていない）
    expect(result.graph.nodes[0].chapterCount).toBe(1);
  });

  test("話数の記録がある呼称は、第N話より後に始まったものを引かない", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [1, 2, 3, 4, 5],
        addressTerms: [
          {
            targetName: "月島",
            targetId: null,
            authorLocked: false,
            forms: [addressForm("月島さん", 1), addressForm("先生", 5)],
          },
        ],
      }),
      character("char_002", "月島", { appearedChapters: [1, 5] }),
    ]);
    const atThree = filterRelationGraph(graph, { upToChapter: 3 });
    expect(atThree.graph.edges).toHaveLength(1);
    expect(atThree.graph.edges[0].labels.map((label) => label.text)).toEqual([
      "月島さん",
    ]);
    expect(atThree.graph.edges[0].weight).toBe(1);

    const atFive = filterRelationGraph(graph, { upToChapter: 5 });
    expect(atFive.graph.edges[0].labels.map((label) => label.text)).toEqual([
      "月島さん",
      "先生",
    ]);
  });

  test("呼称がまだ1つも始まっていなければ、その線は引かない", () => {
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [1, 2, 3],
        addressTerms: [
          {
            targetName: "月島",
            targetId: null,
            authorLocked: false,
            forms: [addressForm("先生", 3)],
          },
        ],
      }),
      character("char_002", "月島", { appearedChapters: [1] }),
    ]);
    const result = filterRelationGraph(graph, { upToChapter: 2 });
    expect(result.graph.edges).toEqual([]);
    // 線が無くなった2人は孤立として畳む（消えたのではない）
    expect(result.hiddenIsolated.map((node) => node.name)).toEqual([
      "灯",
      "月島",
    ]);
  });

  test("話数の記録が無い関係と呼称は、両端が出ていれば引く", () => {
    // 関係（relations）は話数を持たない。呼称も firstChapter が空のものがある。
    // 分からないものを消すと、作者が手で書いた線が黙って消える
    const result = filterRelationGraph(buildRelationGraph(sample()), {
      upToChapter: 1,
    });
    expect(result.graph.edges).toHaveLength(1);
    expect(
      result.graph.edges[0].labels.map((label) => label.text).sort()
    ).toEqual(["先生", "師匠"].sort());
  });

  test("話数を指定しなければ全部出て、最終話を指定したときと同じになる", () => {
    const graph = buildRelationGraph(sample());
    const all = filterRelationGraph(graph, { showIsolated: true });
    const atLast = filterRelationGraph(graph, {
      upToChapter: lastChapterOf(graph),
      showIsolated: true,
    });
    expect(all.graph.nodes.map((node) => node.id)).toEqual([
      "char_001",
      "char_002",
      "char_003",
    ]);
    expect(atLast).toEqual(all);
  });

  test("登場話数の記録が無い人物は、どの話でも出す", () => {
    // 古い資料や作者が手で足した人物。分からないものを消さない
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [1],
        relations: [{ name: "月島", relation: "師匠" }],
      }),
      character("char_002", "月島", {}),
    ]);
    const result = filterRelationGraph(graph, { upToChapter: 1 });
    expect(result.graph.nodes.map((node) => node.id)).toEqual([
      "char_001",
      "char_002",
    ]);
  });

  test("仮ノードは登場話数では落とさない", () => {
    // 登場話数が空なのは資料が無いからで、条件に外れたわけではない
    const graph = buildRelationGraph([
      character("char_001", "灯", {
        appearedChapters: [2, 3],
        relations: [{ name: "名も無き剣士", relation: "恩人" }],
      }),
    ]);
    const result = filterRelationGraph(graph, { upToChapter: 2 });
    expect(result.graph.nodes.map((node) => node.provisional)).toEqual([
      false,
      true,
    ]);
    expect(result.graph.unresolved).toHaveLength(1);

    // 呼んだ側がまだ出ていなければ、仮ノードも一緒に消える
    const before = filterRelationGraph(graph, { upToChapter: 1 });
    expect(before.graph.nodes).toEqual([]);
    expect(before.graph.unresolved).toEqual([]);
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

describe("注記の件数（設計書6.38.5）", () => {
  /**
   * 灯 — 月島 の鎖。月島だけが「ハナ」（同名が2人いて決められない）を呼ぶ。
   *
   * 灯を中心にして1次までを出すと、点線の「ハナ」は2次なので図に出ない。
   */
  function ambiguousAtSecondRing(): Character[] {
    return [
      character("char_001", "灯", {
        relations: [{ name: "月島", relation: "師匠" }],
      }),
      character("char_002", "月島", {
        relations: [{ name: "ハナ", relation: "友人" }],
      }),
      character("char_003", "花村", { aliases: ["ハナ"] }),
      character("char_004", "華岡", { aliases: ["ハナ"] }),
    ];
  }

  /** 画面（`relationGraphPanel`）が個人中心図を組み立てる手順と同じ形にする */
  function ego(characters: Character[], centerId: string): RelationGraph {
    const filtered = filterRelationGraph(buildRelationGraph(characters), {
      showIsolated: true,
    });
    const graph = egoGraph(filtered.graph, centerId);
    const visible = new Set(graph.nodes.map((node) => node.id));
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      unresolved: restrictUnresolved(filtered.graph, visible),
    };
  }

  test("全体図では、内訳が全体を超えない", () => {
    const graph = buildRelationGraph(ambiguousAtSecondRing());
    const counts = countUnresolved(graph);

    expect(counts).toEqual({ unresolvedCount: 1, ambiguousCount: 1 });
  });

  test("個人中心図で、点線を出していない相手は内訳にも入らない", () => {
    // 「6人のうち8人」と、内訳が全体を超える注記が出ていた。呼んだ側
    // （月島）が図に居るだけで一覧に残り、点線の出ていない相手まで
    // 内訳に数えていたため
    const graph = ego(ambiguousAtSecondRing(), "char_001");

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "char_001",
      "char_002",
    ]);
    const counts = countUnresolved(graph);
    expect(counts).toEqual({ unresolvedCount: 0, ambiguousCount: 0 });
    expect(counts.ambiguousCount).toBeLessThanOrEqual(counts.unresolvedCount);
  });

  test("個人中心図に点線が出ていれば、その分は内訳に入る", () => {
    // 絞り込んだ結果を黙って0にしてしまわないこと。中心の相手なら残る
    const graph = ego(
      [
        character("char_001", "灯", {
          relations: [
            { name: "ハナ", relation: "友人" },
            { name: "居ない人", relation: "隣人" },
          ],
        }),
        character("char_003", "花村", { aliases: ["ハナ"] }),
        character("char_004", "華岡", { aliases: ["ハナ"] }),
      ],
      "char_001"
    );

    // 点線は「ハナ」と「居ない人」の2人。うち同名で決められないのは1人
    expect(countUnresolved(graph)).toEqual({
      unresolvedCount: 2,
      ambiguousCount: 1,
    });
  });

  test("一覧を絞るときは、呼んだ側だけでなく相手も見る", () => {
    // 直った経路のうち「一覧の絞り込み」だけを取り出して見る。ここが
    // 呼んだ側（fromId）だけを見ると、点線の出ていない相手が残る
    const filtered = filterRelationGraph(
      buildRelationGraph(ambiguousAtSecondRing()),
      { showIsolated: true }
    );
    // 月島（呼んだ側）は図に居るが、点線の「ハナ」は1次までに入らない
    const visible = new Set(["char_001", "char_002"]);

    expect(restrictUnresolved(filtered.graph, visible)).toEqual([]);
  });

  test("一覧に残っていても、点線が出ていない相手は数えない", () => {
    // 直った経路のうち「数え方」だけを取り出して見る。一覧の絞り込みが
    // 甘くても、注記の内訳が全体を超えないことをここで担保する
    const graph: RelationGraph = {
      nodes: [
        {
          id: "char_001",
          name: "灯",
          affiliation: null,
          chapterCount: 1,
          appearedChapters: [1],
          provisional: false,
        },
      ],
      edges: [],
      unresolved: [
        {
          fromId: "char_001",
          targetName: "ハナ",
          kind: "relation",
          reason: "ambiguous",
        },
      ],
    };

    expect(countUnresolved(graph)).toEqual({
      unresolvedCount: 0,
      ambiguousCount: 0,
    });
  });
});

/**
 * 線の上に置く短い言葉（作者の裁定、2026-10-03「線の文字を絞る」）。
 *
 * 実機（教科書チート、「アブス」の個人中心図）で、両向きの関係を全部並べた
 * 長い文字（「→同席・兼職男子・同席／←…」）が中心の近くで重なって読めなかった。
 * 線の上には向きごとに1つだけ置き、全部は右の「つながっている人」で読む。
 */
describe("線の上の短い言葉", () => {
  function edgeOf(characters: Character[]) {
    const graph = buildRelationGraph(characters);
    expect(graph.edges).toHaveLength(1);
    return graph.edges[0];
  }

  test("向きごとに1つだけ置き、残りは「ほかN」にする", () => {
    const edge = edgeOf([
      character("char_001", "アブス", {
        relations: [
          { name: "イント", relation: "同席" },
          { name: "イント", relation: "兼職男子" },
        ],
        addressTerms: [address("イント", ["イント君"])],
      }),
      character("char_002", "イント", {
        relations: [{ name: "アブス", relation: "上司" }],
      }),
    ]);
    expect(shortPairLabel(edge, "char_001")).toBe("→同席 ほか2／←上司");
    expect(shortPairLabel(edge, "char_002")).toBe("→上司／←同席 ほか2");
  });

  test("関係が無ければ呼び方を『』で置く", () => {
    const edge = edgeOf([
      character("char_001", "マイナ", {
        addressTerms: [address("イント", ["イント君"])],
      }),
      character("char_002", "イント", {}),
    ]);
    expect(shortPairLabel(edge, "char_001")).toBe("→『イント君』／←なし");
  });

  test("長い言葉は途中で切る", () => {
    const edge = edgeOf([
      character("char_001", "アブス", {
        relations: [{ name: "イント", relation: "電気について教えを受けている相手" }],
      }),
      character("char_002", "イント", {}),
    ]);
    const text = shortPairLabel(edge, "char_001");
    expect(text).toBe("→電気について教え…／←なし");
  });

  test("全部を並べた長い形にはしない（線の上は短く）", () => {
    const edge = edgeOf([
      character("char_001", "アブス", {
        relations: [
          { name: "イント", relation: "同席" },
          { name: "イント", relation: "兼職男子" },
          { name: "イント", relation: "部下" },
        ],
      }),
      character("char_002", "イント", {
        relations: [
          { name: "アブス", relation: "上司" },
          { name: "アブス", relation: "同席" },
        ],
      }),
    ]);
    const text = shortPairLabel(edge, "char_001");
    expect(text).not.toContain("・");
    expect([...text].length).toBeLessThanOrEqual(24);
  });
});
