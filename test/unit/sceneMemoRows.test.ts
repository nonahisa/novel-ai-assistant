import { describe, expect, test } from "vitest";
import { locateFindings } from "../../src/core/findingLocation";
import { parseMemos } from "../../src/core/sceneMemo";
import { normalizeForComparison } from "../../src/core/pathText";
import {
  arrangeRows,
  findingCategoryLabel,
  findingHeadline,
  findingLabelOf,
  findingNote,
  markSameLine,
  mergeNoteRows,
  nextNoteRow,
  prevNoteRow,
  type NoteRow,
  type PlacedFinding,
} from "../../src/core/sceneMemoRows";
import { visibleFindings } from "../../src/features/findingStore";
import type { Finding, FindingView } from "../../src/models/finding";

/**
 * 作者の付箋とAIの指摘を、1本の並びに混ぜる（設計書6.96.5）。
 *
 * 作者の指示（2026-09-19）：「ファイルを開いたら、そのファイルに関係する
 * 提案を種類にこだわらず、該当位置順でまとめて右側に幅を取らない感じで
 * 並べる機能が欲しい」。
 *
 * **置き場は分かれたままである。** 付箋は本文の中、指摘は
 * `.aiwriter/findings.jsonl`。ここで見るのは**画面に並ぶ順**だけで、
 * 位置の探し直しは `findingLocation.test.ts`、期限は
 * `findingStore.test.ts` が見る。ただし
 * **「消えた指摘」と「期限切れ」が一覧に出ない**ことは、繋いだ形でも
 * 1本ずつ確かめる——落とす役目が途中の関数にあるので、繋ぎ方を間違えると
 * 単体では通ったまま画面にだけ出る。
 */

const EPISODE_1 = "本文/episode_0001.txt";
const EPISODE_2 = "本文/episode_0002.txt";

/** 第1話の本文。12行目に付箋、18行目に指摘の原文が2つ */
const text1 = [
  "　港の朝は白い。", // 1
  ...Array.from({ length: 10 }, () => ""), // 2〜11
  "// TODO ここに潮の匂いの描写を足す", // 12
  ...Array.from({ length: 5 }, () => ""), // 13〜17
  "　彼女は海を見つめてた。主語がここで変わる。", // 18
  "", // 19
  "", // 20
  "　左足を引きずって歩く。", // 21
].join("\n");

/** 第2話の本文。3行目に付箋 */
const text2 = ["　夜の港。", "", "　／／ 要確認 距離が合わない"].join("\n");

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    id: "f-typo",
    time: "2026-09-19T09:00:00.000Z",
    file: EPISODE_1,
    hintLine: 18,
    original: "　彼女は海を見つめてた。主語がここで変わる。",
    target: "見つめてた",
    suggestion: "見つめていた",
    before: "",
    after: "",
    message: "送り仮名が抜けています",
    category: "typo",
    label: "誤字脱字",
  };
  return { ...base, ...overrides };
}

/** 一覧に出す形まで通す（本文の読み込みだけが画面側の仕事） */
function place(findings: readonly Finding[]): PlacedFinding[] {
  const texts = new Map([
    [EPISODE_1, text1],
    [EPISODE_2, text2],
  ]);
  return locateFindings(findings, texts).map((located) => ({
    ...located,
    filePath: located.file,
  }));
}

function memosOf(): ReturnType<typeof parseMemos> {
  return [...parseMemos(text1, EPISODE_1), ...parseMemos(text2, EPISODE_2)];
}

/** 並びを「話数　行　種類」の1行ずつにして見比べる */
function shape(rows: readonly NoteRow[]): string[] {
  return rows.map(
    (row) =>
      `${row.filePath}:${row.line}:${row.kind}` + (row.sameLine ? ":同じ行" : "")
  );
}

describe("並びは話数 → 行で、種類では分けない", () => {
  test("付箋とAIの指摘が、本文の順に混ざる", () => {
    const rows = mergeNoteRows(
      memosOf(),
      place([
        finding(),
        finding({
          id: "f-contradiction",
          hintLine: 21,
          original: "　左足を引きずって歩く。",
          target: "",
          suggestion: "",
          message: "第1話では右足でした",
          category: "contradiction",
        }),
      ]),
      [EPISODE_1, EPISODE_2]
    );

    expect(shape(rows)).toEqual([
      `${EPISODE_1}:12:memo`,
      `${EPISODE_1}:18:finding`,
      `${EPISODE_1}:21:finding`,
      `${EPISODE_2}:3:memo`,
    ]);
  });

  /**
   * **種類でまとめない。** 作者が直すときの順序は種類ではなく本文の順で
   * ある——誤字を全部直してから推敲を全部見る、という直し方を人はしない。
   */
  test("後ろの話の誤字が、前の話の矛盾より後に来る", () => {
    const rows = mergeNoteRows(
      [],
      place([
        finding({
          id: "f-late-typo",
          file: EPISODE_2,
          hintLine: 1,
          original: "　夜の港。",
          target: "夜",
          suggestion: "よる",
          before: "",
          after: "",
        }),
        finding({
          id: "f-early-contradiction",
          hintLine: 21,
          original: "　左足を引きずって歩く。",
          target: "",
          suggestion: "",
          category: "contradiction",
        }),
      ]),
      [EPISODE_1, EPISODE_2]
    );

    expect(shape(rows)).toEqual([
      `${EPISODE_1}:21:finding`,
      `${EPISODE_2}:1:finding`,
    ]);
  });

  /** 走査の並びに無いファイルは後ろへ回す（**捨てない**） */
  test("並びに無いファイルは後ろへ回る", () => {
    const rows = mergeNoteRows(memosOf(), [], [EPISODE_2]);

    expect(shape(rows)).toEqual([
      `${EPISODE_2}:3:memo`,
      `${EPISODE_1}:12:memo`,
    ]);
  });
});

describe("同じ行に複数来たら、その行にまとめて出す", () => {
  test("2件目から「同じ行」の印が立つ", () => {
    const rows = mergeNoteRows(
      [],
      place([
        finding(),
        finding({
          id: "f-proofread",
          target: "",
          suggestion: "",
          message: "この段落は主語が2回変わります",
          category: "proofread",
        }),
      ]),
      [EPISODE_1]
    );

    expect(shape(rows)).toEqual([
      `${EPISODE_1}:18:finding`,
      `${EPISODE_1}:18:finding:同じ行`,
    ]);
  });

  /** 同じ行に付箋と指摘が来たら、**作者が書いたものが先** */
  test("同じ行では付箋が先に出る", () => {
    const memo = {
      filePath: EPISODE_1,
      line: 18,
      tag: "TODO",
      text: "ここを直す",
      raw: "// TODO ここを直す",
    };

    const rows = mergeNoteRows([memo], place([finding()]), [EPISODE_1]);

    expect(shape(rows)).toEqual([
      `${EPISODE_1}:18:memo`,
      `${EPISODE_1}:18:finding:同じ行`,
    ]);
  });

  /**
   * パネルは「いま開いている話 → その他」で二分する。切り口はファイル
   * 単位なので同じ場所の行は離れないが、**先頭に来た行の印は付け直す**
   * 必要がある（付いたままだと、場所の表示が消えた行が先頭に立つ）。
   */
  test("並べ替えたあとに印を付け直せる", () => {
    const rows = mergeNoteRows(
      memosOf(),
      place([finding()]),
      [EPISODE_1, EPISODE_2]
    );
    const second = rows.filter((row) => row.filePath === EPISODE_2);
    const first = rows.filter((row) => row.filePath === EPISODE_1);

    expect(shape(markSameLine([...second, ...first]))).toEqual([
      `${EPISODE_2}:3:memo`,
      `${EPISODE_1}:12:memo`,
      `${EPISODE_1}:18:finding`,
    ]);
  });
});

describe("一覧に出してはいけないもの", () => {
  /** **当て推量で置かない**（6.96.6）。原文が消えていれば、その指摘は捨てる */
  test("本文から消えた指摘は並ばない", () => {
    const rows = mergeNoteRows(
      [],
      place([
        finding(),
        finding({
          id: "f-gone",
          hintLine: 18,
          original: "　作者がもう書き直した文。",
        }),
      ]),
      [EPISODE_1]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].kind === "finding" && rows[0].finding.id).toBe("f-typo");
  });

  /**
   * 期限切れは**隠すだけ**で、ファイルからは消えない（6.96.4）。
   * 並べる前に `visibleFindings` を通していることを、繋いだ形で確かめる。
   */
  test("期限切れの指摘は並ばない", () => {
    const now = new Date("2026-09-19T09:00:00.000Z");
    const views: FindingView[] = [
      { ...finding({ time: "2026-09-18T09:00:00.000Z" }), status: "pending" },
      {
        ...finding({
          id: "f-old",
          time: "2026-09-10T09:00:00.000Z",
          hintLine: 21,
          original: "　左足を引きずって歩く。",
        }),
        status: "pending",
      },
    ];

    const rows = mergeNoteRows(
      [],
      place(visibleFindings(views, 3, now)),
      [EPISODE_1]
    );

    expect(shape(rows)).toEqual([`${EPISODE_1}:18:finding`]);
  });

  /** 採った・退けたものも並べない（退けたものが翌日また出ては意味が無い） */
  test("判断の済んだ指摘は並ばない", () => {
    const views: FindingView[] = [
      { ...finding(), status: "dismissed" },
      {
        ...finding({
          id: "f-open",
          hintLine: 21,
          original: "　左足を引きずって歩く。",
        }),
        status: "pending",
      },
    ];

    const rows = mergeNoteRows(
      [],
      place(visibleFindings(views, 0, new Date("2026-09-19T09:00:00.000Z"))),
      [EPISODE_1]
    );

    expect(shape(rows)).toEqual([`${EPISODE_1}:21:finding`]);
  });
});

describe("1件に出す文", () => {
  test("直し方があれば、それが主文になる", () => {
    expect(findingHeadline(finding())).toBe("「見つめてた」→「見つめていた」");
    expect(findingNote(finding())).toBe("送り仮名が抜けています");
  });

  /** 矛盾と逸脱は直し方を出さないので、理由が主文になる */
  test("直し方が無ければ、理由が主文になる", () => {
    const item = finding({
      target: "",
      suggestion: "",
      message: "第1話では左足、ここでは右足です",
      category: "contradiction",
    });

    expect(findingHeadline(item)).toBe("第1話では左足、ここでは右足です");
    // 主文と同じものを、下にもう一度並べない
    expect(findingNote(item)).toBe("");
  });

  test("知らない種類は「指摘」と呼ぶ", () => {
    expect(findingCategoryLabel("typo")).toBe("誤字");
    expect(findingCategoryLabel("contradiction")).toBe("矛盾");
    expect(findingCategoryLabel("other")).toBe("指摘");
  });
});

/**
 * 「次へ」「戻る」（設計書6.96.5）。
 *
 * **付箋だけを回っていた。** 作者が直したい順は、付箋とAIの指摘を分けた
 * 順ではなく本文の順である——一覧を位置順に混ぜておきながら、飛ぶときだけ
 * 付箋しか止まらないのでは、混ぜた意味が半分になる。
 */
describe("次へ・戻るは、付箋と指摘の両方を回る", () => {
  const order = [EPISODE_1, EPISODE_2];

  function rows(): NoteRow[] {
    return mergeNoteRows(memosOf(), place([finding()]), order);
  }

  test("付箋の次に、AIの指摘で止まる", () => {
    // 第1話：12行目に付箋、18行目に指摘
    const target = nextNoteRow(rows(), { filePath: EPISODE_1, line: 12 }, order);

    expect(target?.kind).toBe("finding");
    expect(target?.line).toBe(18);
  });

  test("指摘の前に戻ると、手前の付箋で止まる", () => {
    const target = prevNoteRow(rows(), { filePath: EPISODE_1, line: 18 }, order);

    expect(target?.kind).toBe("memo");
    expect(target?.line).toBe(12);
  });

  test("話をまたいで進み、末尾なら先頭へ回る", () => {
    // 第2話の3行目が最後。そこから次へ進むと先頭（第1話12行目）へ
    const target = nextNoteRow(rows(), { filePath: EPISODE_2, line: 3 }, order);

    expect(target?.filePath).toBe(EPISODE_1);
    expect(target?.line).toBe(12);
  });

  test("先頭より前から戻ると、末尾へ回る", () => {
    const target = prevNoteRow(rows(), { filePath: EPISODE_1, line: 1 }, order);

    expect(target?.filePath).toBe(EPISODE_2);
    expect(target?.line).toBe(3);
  });

  test("起点が無ければ、次へは先頭・戻るは末尾", () => {
    expect(nextNoteRow(rows(), null, order)?.line).toBe(12);
    expect(prevNoteRow(rows(), null, order)?.filePath).toBe(EPISODE_2);
  });

  test("1件も無ければ、どこへも飛ばない", () => {
    expect(nextNoteRow([], null, order)).toBeUndefined();
    expect(prevNoteRow([], null, order)).toBeUndefined();
  });
});

/**
 * 呼び名は、記録してある分類名を先に使う（設計書6.88.9）。
 *
 * 「矛盾」と「矛盾（事実の照合）」はどちらも種類が `contradiction` だが、
 * 作者はこの2つを並行させて見比べる。
 */
describe("指摘の呼び名", () => {
  test("分類名があれば、そのまま出す", () => {
    expect(
      findingLabelOf({ category: "contradiction", label: "矛盾（事実の照合）" })
    ).toBe("矛盾（事実の照合）");
  });

  test("分類名の無い古い記録は、種類から決める", () => {
    expect(findingLabelOf({ category: "contradiction", label: "" })).toBe("矛盾");
    expect(findingLabelOf({ category: "typo" })).toBe("誤字");
  });
});

/**
 * **いま開いている話を先頭へ寄せる**（設計書6.40。0.74.11）。
 *
 * この並べ方は作者への約束（書いている場面のものが下のほうにあると、
 * 横に並べた意味が薄れる）なのに、0.74.10 まではパネルの private
 * メソッドの中にあり、**画面を動かすまで崩れに気づけなかった。**
 * `core` へ出して、ここで見張る。
 */
describe("いま開いている話を先頭へ", () => {
  /** 比べるための表記。パネルは `currentFile` をこれに通して渡す */
  const keyOf = (filePath: string) => normalizeForComparison(filePath);

  test("話数の順に関係なく、開いている話が先頭へ来る", () => {
    const rows = mergeNoteRows(memosOf(), place([finding()]), [
      EPISODE_1,
      EPISODE_2,
    ]);

    const arranged = arrangeRows(rows, keyOf(EPISODE_2));

    expect(shape(arranged)).toEqual([
      `${EPISODE_2}:3:memo`,
      `${EPISODE_1}:12:memo`,
      `${EPISODE_1}:18:finding`,
    ]);
  });

  test("同じ話の行は、塊のまま動く（中の並びは変わらない）", () => {
    // **第2話を先に並べた上で、第1話を開いている**という形。
    // 第1話の2行（12行目の付箋と18行目の指摘）は順序を保ったまま頭へ来る
    const rows = mergeNoteRows(memosOf(), place([finding()]), [
      EPISODE_2,
      EPISODE_1,
    ]);

    const arranged = arrangeRows(rows, keyOf(EPISODE_1));

    expect(shape(arranged)).toEqual([
      `${EPISODE_1}:12:memo`,
      `${EPISODE_1}:18:finding`,
      `${EPISODE_2}:3:memo`,
    ]);
  });

  test("開いている話が無ければ、並びを変えない", () => {
    // 原稿を開かずにパネルだけを出したとき。**勝手に並べ替えない**
    const rows = mergeNoteRows(memosOf(), place([finding()]), [
      EPISODE_1,
      EPISODE_2,
    ]);

    expect(shape(arrangeRows(rows, null))).toEqual(shape(rows));
  });

  test("「直前と同じ場所」の印は、入れ替えの**あと**に付け直す", () => {
    /*
      **順番を取り違えると、印が入れ替え前のまま残る。**

      それが見えるのは、同じ話の行が離れて並んでいるときである。下の
      3行は、真ん中に第2話が挟まっているせいで**この並びでは「同じ場所」に
      当たらない**。第1話を先頭へ寄せると18行目の2件が隣り合うので、
      2件目に印が立たなければならない——**入れ替えのあとに数え直して
      いなければ、ここは印が付かないまま出る。**
    */
    const placed = place([
      finding(),
      finding({
        id: "f-proofread",
        target: "",
        suggestion: "",
        message: "この段落は主語が2回変わります",
        category: "proofread",
      }),
    ]);
    const [memo2] = parseMemos(text2, EPISODE_2);
    const split: NoteRow[] = [
      { kind: "finding", filePath: EPISODE_1, line: 18, sameLine: false, finding: placed[0] },
      { kind: "memo", filePath: EPISODE_2, line: 3, sameLine: false, memo: memo2 },
      { kind: "finding", filePath: EPISODE_1, line: 18, sameLine: false, finding: placed[1] },
    ];

    const arranged = arrangeRows(split, keyOf(EPISODE_1));

    expect(shape(arranged)).toEqual([
      `${EPISODE_1}:18:finding`,
      `${EPISODE_1}:18:finding:同じ行`,
      `${EPISODE_2}:3:memo`,
    ]);
  });
});
