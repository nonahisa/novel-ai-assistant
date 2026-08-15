import { describe, expect, test } from "vitest";
import {
  emptyTimeline,
  episodesOfTimepoint,
  isCanonicalEpisode,
  lineOfEpisode,
  nextLineId,
  nextTimepointId,
  parseTimeline,
  timepointOfEpisode,
  timepointsOfLine,
} from "../../src/models/timeline";

/** 本編＋IF編＋夢＋並行世界を持つ作品。多くのテストで使う */
function sample() {
  return parseTimeline({
    lines: [
      { id: "ln_001", label: "本編", kind: "main" },
      {
        id: "ln_002",
        label: "IF・もし文佳が生きていたら",
        kind: "branch",
        branchFrom: "tp_002",
      },
      { id: "ln_003", label: "太志の夢", kind: "dream" },
      { id: "ln_004", label: "常夜の国", kind: "parallel" },
    ],
    timepoints: [
      { id: "tp_001", lineId: "ln_001", label: "十年前・火事の夜" },
      { id: "tp_002", lineId: "ln_001", label: "本編開始", absolute: "四月" },
      { id: "tp_003", lineId: "ln_001", label: "王都陥落からの三日間" },
      { id: "tp_101", lineId: "ln_002", label: "分かれたあとの春" },
      { id: "tp_201", lineId: "ln_003", label: "見た夢" },
      { id: "tp_301", lineId: "ln_004", label: "常夜の国の一日目" },
    ],
    episodes: [
      { filePath: "本文/第01話.txt", timepointId: "tp_002" },
      { filePath: "本文/第03話.txt", timepointId: "tp_001", note: "回想" },
      { filePath: "本文/第20話.txt", timepointId: "tp_101" },
      { filePath: "本文/第21話.txt", timepointId: "tp_201" },
      { filePath: "本文/第22話.txt", timepointId: "tp_301" },
    ],
  });
}

describe("系統を作っていない作品", () => {
  test("すべての話が本編の事実として扱われる", () => {
    // 時間を設定していない作品にまで設定を強いない。
    // ここが false に倒れると、既存の作品が軒並み資料から消える
    const timeline = emptyTimeline();
    expect(isCanonicalEpisode(timeline, "本文/第01話.txt")).toBe(true);
    expect(lineOfEpisode(timeline, "本文/第01話.txt")).toBeUndefined();
  });
});

describe("本編ではない筋を分ける", () => {
  test("IF編の話は本編の事実として扱わない", () => {
    // IF編で死んだ人物が本編の資料で死んでいたら、資料として使えない
    expect(isCanonicalEpisode(sample(), "本文/第20話.txt")).toBe(false);
  });

  test("夢の話も本編の事実として扱わない", () => {
    expect(isCanonicalEpisode(sample(), "本文/第21話.txt")).toBe(false);
  });

  test("並行する世界は、時間が別なだけで実際に起きたこととして扱う", () => {
    expect(isCanonicalEpisode(sample(), "本文/第22話.txt")).toBe(true);
  });

  test("種別の既定は作者が上書きできる", () => {
    // 夢だと思わせて実は本当にあった記憶、という作品はいくらでもある。
    // 決め打ちにすると、そういう作品で使えなくなる
    const timeline = parseTimeline({
      lines: [
        { id: "ln_001", label: "本編", kind: "main" },
        { id: "ln_002", label: "夢に見た記憶", kind: "dream", canonical: true },
      ],
      timepoints: [{ id: "tp_101", lineId: "ln_002", label: "あの日" }],
      episodes: [{ filePath: "本文/第09話.txt", timepointId: "tp_101" }],
    });
    expect(isCanonicalEpisode(timeline, "本文/第09話.txt")).toBe(true);
  });

  test("対応づけの無い話は本編とみなす", () => {
    // 作者は例外（夢・IF編）だけを設定すればよい。
    // 本編の話を1つずつ登録させると、19話の作品でも面倒で使われなくなる
    const timeline = sample();
    expect(isCanonicalEpisode(timeline, "本文/第05話.txt")).toBe(true);
    expect(lineOfEpisode(timeline, "本文/第05話.txt")?.id).toBe("ln_001");
  });
});

describe("群像劇", () => {
  test("同じ時期に複数の話を置ける（同時性は並びでなく共有で表す）", () => {
    // A視点の第3話とB視点の第8話が同じ出来事の裏表なら、両方を同じ時期へ。
    // 話数では5話離れていて、時系列では同じ地点になる
    const timeline = parseTimeline({
      lines: [{ id: "ln_001", label: "本編", kind: "main" }],
      timepoints: [{ id: "tp_005", lineId: "ln_001", label: "王都陥落の日" }],
      episodes: [
        { filePath: "本文/第03話.txt", timepointId: "tp_005" },
        { filePath: "本文/第08話.txt", timepointId: "tp_005" },
      ],
    });

    expect(episodesOfTimepoint(timeline, "tp_005").map((e) => e.filePath)).toEqual([
      "本文/第03話.txt",
      "本文/第08話.txt",
    ]);
    expect(timepointOfEpisode(timeline, "本文/第03話.txt")?.id).toBe(
      timepointOfEpisode(timeline, "本文/第08話.txt")?.id
    );
  });
});

describe("時期の並び", () => {
  test("並び順は配列の順そのもの", () => {
    // 番号を振ると、間に1つ挿し込むたびに振り直しになる
    expect(timepointsOfLine(sample(), "ln_001").map((p) => p.label)).toEqual([
      "十年前・火事の夜",
      "本編開始",
      "王都陥落からの三日間",
    ]);
  });

  test("回想の話は、話数では後ろでも時系列では前に来る", () => {
    const timeline = sample();
    const order = timepointsOfLine(timeline, "ln_001").map((p) => p.id);
    const first = timepointOfEpisode(timeline, "本文/第01話.txt");
    const third = timepointOfEpisode(timeline, "本文/第03話.txt");
    expect(order.indexOf(third!.id)).toBeLessThan(order.indexOf(first!.id));
  });
});

describe("パスの揺れ", () => {
  test("Windowsの区切り文字でも同じ話とみなす", () => {
    // 揃えないと「設定されていない」と判定され、IF編が黙って本編に落ちる
    expect(isCanonicalEpisode(sample(), "本文\\第20話.txt")).toBe(false);
  });

  test("保存する形は / に揃える", () => {
    const timeline = parseTimeline({
      lines: [{ id: "ln_001", label: "本編", kind: "main" }],
      timepoints: [{ id: "tp_001", lineId: "ln_001", label: "開始" }],
      episodes: [{ filePath: "本文\\第01話.txt", timepointId: "tp_001" }],
    });
    // GitHubを介して別の端末と行き来するため、区切りを環境依存にしない
    expect(timeline.episodes[0].filePath).toBe("本文/第01話.txt");
  });
});

describe("壊れた設定は読み込まずに止める", () => {
  test("時期の参照が切れていたら例外", () => {
    // 黙って本編扱いに落ちるのが、資料としていちばん困る壊れ方
    expect(() =>
      parseTimeline({
        lines: [{ id: "ln_001", label: "本編", kind: "main" }],
        timepoints: [{ id: "tp_001", lineId: "ln_001", label: "開始" }],
        episodes: [{ filePath: "本文/第01話.txt", timepointId: "tp_999" }],
      })
    ).toThrow(/tp_999/);
  });

  test("系統の参照が切れていたら例外", () => {
    expect(() =>
      parseTimeline({
        lines: [{ id: "ln_001", label: "本編", kind: "main" }],
        timepoints: [{ id: "tp_001", lineId: "ln_999", label: "開始" }],
      })
    ).toThrow(/ln_999/);
  });

  test("本編が2本あったら例外", () => {
    expect(() =>
      parseTimeline({
        lines: [
          { id: "ln_001", label: "本編", kind: "main" },
          { id: "ln_002", label: "もう一つの本編", kind: "main" },
        ],
      })
    ).toThrow(/本編は1本/);
  });

  test("本編に分岐元は書けない", () => {
    expect(() =>
      parseTimeline({
        lines: [
          { id: "ln_001", label: "本編", kind: "main", branchFrom: "tp_101" },
        ],
      })
    ).toThrow(/branchFrom/);
  });

  test("自分自身から分岐していたら例外", () => {
    expect(() =>
      parseTimeline({
        lines: [
          { id: "ln_001", label: "本編", kind: "main" },
          { id: "ln_002", label: "IF", kind: "branch", branchFrom: "tp_101" },
        ],
        timepoints: [
          { id: "tp_001", lineId: "ln_001", label: "開始" },
          { id: "tp_101", lineId: "ln_002", label: "分かれたあと" },
        ],
      })
    ).toThrow(/自分自身/);
  });

  test("分岐が輪になっていたら例外", () => {
    // 年表を組むときに無限に回る
    expect(() =>
      parseTimeline({
        lines: [
          { id: "ln_001", label: "本編", kind: "main" },
          { id: "ln_002", label: "IF-A", kind: "branch", branchFrom: "tp_301" },
          { id: "ln_003", label: "IF-B", kind: "branch", branchFrom: "tp_201" },
        ],
        timepoints: [
          { id: "tp_001", lineId: "ln_001", label: "開始" },
          { id: "tp_201", lineId: "ln_002", label: "Aの分岐後" },
          { id: "tp_301", lineId: "ln_003", label: "Bの分岐後" },
        ],
      })
    ).toThrow(/輪/);
  });

  test("同じ話が2回出てきたら例外", () => {
    // どちらの時期が正しいか決められない。黙って片方を採ると事故になる
    expect(() =>
      parseTimeline({
        lines: [{ id: "ln_001", label: "本編", kind: "main" }],
        timepoints: [
          { id: "tp_001", lineId: "ln_001", label: "開始" },
          { id: "tp_002", lineId: "ln_001", label: "その後" },
        ],
        episodes: [
          { filePath: "本文/第01話.txt", timepointId: "tp_001" },
          { filePath: "本文/第01話.txt", timepointId: "tp_002" },
        ],
      })
    ).toThrow(/2回/);
  });

  test("IDの形式が違ったら例外", () => {
    expect(() =>
      parseTimeline({ lines: [{ id: "line1", label: "本編", kind: "main" }] })
    ).toThrow(/id/);
  });
});

describe("採番", () => {
  test("既存の続きから振る", () => {
    const timeline = sample();
    expect(nextLineId(timeline.lines)).toBe("ln_005");
    expect(nextTimepointId(timeline.timepoints)).toBe("tp_302");
  });

  test("空なら001から", () => {
    expect(nextLineId([])).toBe("ln_001");
    expect(nextTimepointId([])).toBe("tp_001");
  });
});
