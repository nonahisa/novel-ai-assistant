import { describe, expect, test } from "vitest";
import {
  emptyCharacter,
  type Character,
} from "../../../src/models/character";
import { buildRelationGraph, egoGraph } from "../../../src/core/relationGraph";
import {
  EDGE_LABEL_FONT_SIZE,
  estimateTextWidth,
  layoutCircle,
  layoutEgo,
  NODE_RADII,
  type GraphLayout,
  type LayoutArc,
} from "../../../src/core/relationGraphLayout";

/**
 * 人物相関図の配置（設計書6.38.2）。
 *
 * 力学配置を採らなかった理由は「開くたびに形が変わらないこと」なので、
 * 決定的であることを機械で見張る。並びが環境の言語設定で変わる書き方
 * （`localeCompare`）を入れると、ここが落ちる。
 */

const SIZE = { width: 900, height: 900 };

function character(
  id: string,
  name: string,
  extra: Partial<Character> = {}
): Character {
  return { ...emptyCharacter(id, name), ...extra };
}

function sample(): Character[] {
  return [
    character("char_001", "灯", {
      affiliation: "窓口課",
      appearedChapters: [1, 2, 3, 4, 5, 6],
      relations: [{ name: "月島", relation: "師匠" }],
    }),
    character("char_002", "月島", {
      affiliation: "窓口課",
      appearedChapters: [1, 2, 3],
    }),
    character("char_003", "マルキオ", {
      affiliation: "生活保護課",
      appearedChapters: [1],
    }),
    character("char_004", "名無し", { appearedChapters: [2] }),
  ];
}

const TWO_PI = Math.PI * 2;

function angleOf(layout: GraphLayout, id: string): number {
  const node = layout.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`${id} が配置に居ません`);
  return Math.atan2(node.y - layout.center.y, node.x - layout.center.x);
}

/** 弧の中に居るか。角度は一周で戻るので、弧の始まりからの差で見る */
function inArc(arc: LayoutArc, angle: number): boolean {
  const relative = ((angle - arc.start) % TWO_PI + TWO_PI) % TWO_PI;
  return relative <= arc.end - arc.start + 1e-9;
}

describe("全体図の円周配置", () => {
  const graph = buildRelationGraph(sample());
  const layout = layoutCircle(graph, { ...SIZE, groupBy: "affiliation" });

  test("所属ごとに弧が分かれ、所属なしは最後にまとまる", () => {
    expect(layout.arcs.map((arc) => arc.affiliation)).toEqual([
      "生活保護課",
      "窓口課",
      null,
    ]);
  });

  test("人物は自分の所属の弧の中に居る", () => {
    const arcs = new Map(layout.arcs.map((arc) => [arc.affiliation, arc]));
    expect(inArc(arcs.get("窓口課")!, angleOf(layout, "char_001"))).toBe(true);
    expect(inArc(arcs.get("窓口課")!, angleOf(layout, "char_002"))).toBe(true);
    expect(inArc(arcs.get("生活保護課")!, angleOf(layout, "char_003"))).toBe(
      true
    );
    expect(inArc(arcs.get(null)!, angleOf(layout, "char_004"))).toBe(true);
    // 弧をまたいでいないこと（弧が分かれている意味が無くなる）
    expect(inArc(arcs.get("生活保護課")!, angleOf(layout, "char_001"))).toBe(
      false
    );
  });

  test("弧は重ならず、隙間が空いている", () => {
    for (let index = 1; index < layout.arcs.length; index++) {
      expect(layout.arcs[index].start).toBeGreaterThan(
        layout.arcs[index - 1].end
      );
    }
  });

  test("同じ入力なら同じ座標になる", () => {
    // 開くたびに形が変わると、前に見た場所が無くなる
    const again = layoutCircle(buildRelationGraph(sample()), {
      ...SIZE,
      groupBy: "affiliation",
    });
    expect(again).toEqual(layout);
  });

  test("すべての人物が円周の上に載る", () => {
    for (const node of layout.nodes) {
      const distance = Math.hypot(
        node.x - layout.center.x,
        node.y - layout.center.y
      );
      expect(distance).toBeCloseTo(layout.radius, 6);
    }
  });

  test("大きさは登場話数で3段階になる", () => {
    const radiusOf = (id: string) =>
      layout.nodes.find((node) => node.id === id)!.r;
    expect(radiusOf("char_001")).toBe(NODE_RADII.large);
    expect(radiusOf("char_002")).toBe(NODE_RADII.medium);
    expect(radiusOf("char_003")).toBe(NODE_RADII.small);
  });

  test("辺のラベルは弦の中点に置く", () => {
    expect(layout.edges).toHaveLength(1);
    const label = layout.edges[0];
    const a = layout.nodes.find((node) => node.id === label.a)!;
    const b = layout.nodes.find((node) => node.id === label.b)!;
    expect(label.x).toBeCloseTo((a.x + b.x) / 2, 6);
    expect(label.y).toBeCloseTo((a.y + b.y) / 2, 6);
  });

  test("所属が多くても弧が壊れない", () => {
    // 隙間を固定にすると、集団が多いときに隙間の合計が円周を超えて
    // 使える角度が負になる。弧が逆さまになり、人物が1点に重なる
    const many = buildRelationGraph(
      Array.from({ length: 90 }, (_, index) =>
        character(`char_${String(index).padStart(3, "0")}`, `人${index}`, {
          affiliation: `所属${String(index).padStart(2, "0")}`,
        })
      )
    );
    const crowded = layoutCircle(many, { ...SIZE, groupBy: "affiliation" });

    expect(crowded.arcs).toHaveLength(90);
    for (const arc of crowded.arcs) {
      expect(arc.end).toBeGreaterThan(arc.start);
    }
    // 弧は重ならず、順に進む（一周ぶんを超えない）
    for (let index = 1; index < crowded.arcs.length; index++) {
      expect(crowded.arcs[index].start).toBeGreaterThanOrEqual(
        crowded.arcs[index - 1].end
      );
    }
    expect(
      crowded.arcs[crowded.arcs.length - 1].end - crowded.arcs[0].start
    ).toBeLessThanOrEqual(TWO_PI + 1e-9);

    // 座標が重ならない（重なると押し分けられない）
    for (let index = 1; index < crowded.nodes.length; index++) {
      const previous = crowded.nodes[index - 1];
      const current = crowded.nodes[index];
      expect(
        Math.hypot(current.x - previous.x, current.y - previous.y)
      ).toBeGreaterThan(NODE_RADII.small * 2);
    }
  });

  test("人物が居なくても落ちない", () => {
    // まだ何も抽出していない作品でも画面は開く
    const empty = layoutCircle(buildRelationGraph([]), SIZE);
    expect(empty.nodes).toEqual([]);
    expect(empty.arcs).toEqual([]);
  });
});

describe("個人中心図の配置", () => {
  function star(): Character[] {
    return [
      character("char_001", "灯", {
        relations: [
          { name: "月島", relation: "師匠" },
          { name: "マルキオ", relation: "同僚" },
          { name: "名無し", relation: "隣人" },
        ],
      }),
      character("char_002", "月島", {
        relations: [{ name: "遠い人", relation: "親" }],
      }),
      character("char_003", "マルキオ", {}),
      character("char_004", "名無し", {}),
      character("char_005", "遠い人", {}),
    ];
  }

  const graph = buildRelationGraph(star());
  const layout = layoutEgo(egoGraph(graph, "char_001", 2), SIZE);

  test("中心は画面の真ん中に置く", () => {
    const center = layout.nodes.find((node) => node.id === "char_001")!;
    expect(center.x).toBeCloseTo(SIZE.width / 2, 6);
    expect(center.y).toBeCloseTo(SIZE.height / 2, 6);
    expect(center.r).toBe(NODE_RADII.large);
  });

  test("1次の相手は等間隔に並ぶ", () => {
    const angles = ["char_002", "char_003", "char_004"]
      .map((id) => ((angleOf(layout, id) % TWO_PI) + TWO_PI) % TWO_PI)
      .sort((left, right) => left - right);
    for (let index = 1; index < angles.length; index++) {
      expect(angles[index] - angles[index - 1]).toBeCloseTo(TWO_PI / 3, 6);
    }
  });

  test("2次の相手は外の環に置く", () => {
    const inner = Math.hypot(
      layout.nodes.find((node) => node.id === "char_002")!.x - layout.center.x,
      layout.nodes.find((node) => node.id === "char_002")!.y - layout.center.y
    );
    const outer = Math.hypot(
      layout.nodes.find((node) => node.id === "char_005")!.x - layout.center.x,
      layout.nodes.find((node) => node.id === "char_005")!.y - layout.center.y
    );
    expect(outer).toBeGreaterThan(inner);
    expect(layout.rings).toHaveLength(2);
  });

  test("所属の弧は出さない", () => {
    // 個人中心図でまとめるのは環であって、集団ではない
    expect(layout.arcs).toEqual([]);
  });

  test("同じ入力なら同じ座標になる", () => {
    const again = layoutEgo(
      egoGraph(buildRelationGraph(star()), "char_001", 2),
      SIZE
    );
    expect(again).toEqual(layout);
  });
});

/**
 * 個人中心図の線の文字（作者の裁定、2026-10-03「線の文字を絞る」）。
 *
 * 実機（教科書チート、「アブス」の個人中心図）で、中心から出る線の文字が
 * 中心の近くに集まって重なった。中心から出る線は中点がみな同じ小さな円の上に
 * 並ぶので、文字は相手の側へ寄せ、それでも重なるなら線に沿ってずらす。
 */
describe("個人中心図の線の文字", () => {
  /** 中心1人と、両向きの関係を持つ相手 n人 */
  function crowd(n: number): Character[] {
    const names = Array.from({ length: n }, (_, index) => `相手${index}`);
    return [
      character("char_000", "アブス", {
        relations: names.flatMap((name) => [
          { name, relation: "同席" },
          { name, relation: "兼職男子" },
        ]),
      }),
      ...names.map((name, index) =>
        character(`char_${String(index + 1).padStart(3, "0")}`, name, {
          relations: [{ name: "アブス", relation: "上司にあたる人" }],
        })
      ),
    ];
  }

  test("線の文字は短い形で、中心から見た向きで置く", () => {
    const layout = layoutEgo(
      egoGraph(buildRelationGraph(crowd(3)), "char_000", 1),
      SIZE
    );
    for (const label of layout.edges) {
      expect(label.text).toBe("→同席 ほか1／←上司にあたる人");
    }
  });

  test("中心から出る線の文字は、中点より相手の側に置く", () => {
    const layout = layoutEgo(
      egoGraph(buildRelationGraph(crowd(3)), "char_000", 1),
      SIZE
    );
    const inner = Math.hypot(
      layout.nodes.find((node) => node.id === "char_001")!.x - layout.center.x,
      layout.nodes.find((node) => node.id === "char_001")!.y - layout.center.y
    );
    for (const label of layout.edges) {
      const distance = Math.hypot(
        label.x - layout.center.x,
        label.y - layout.center.y
      );
      expect(distance).toBeGreaterThan(inner / 2 + 1);
    }
  });

  test("相手が多くても、線の文字どうしが重ならない", () => {
    const layout = layoutEgo(
      egoGraph(buildRelationGraph(crowd(10)), "char_000", 1),
      SIZE
    );
    expect(layout.edges).toHaveLength(10);
    const boxes = layout.edges.map((label) => {
      const width = estimateTextWidth(label.text ?? "", EDGE_LABEL_FONT_SIZE);
      return {
        left: label.x - width / 2,
        right: label.x + width / 2,
        top: label.y - EDGE_LABEL_FONT_SIZE / 2,
        bottom: label.y + EDGE_LABEL_FONT_SIZE / 2,
      };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap =
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlap, `${i} と ${j} が重なる`).toBe(false);
      }
    }
  });

  test("全体図の線には文字を置かない", () => {
    const layout = layoutCircle(buildRelationGraph(crowd(3)), {
      ...SIZE,
      groupBy: "affiliation",
    });
    for (const label of layout.edges) {
      expect(label.text).toBeUndefined();
    }
  });
});
