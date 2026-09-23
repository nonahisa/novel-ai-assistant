import { describe, expect, it } from "vitest";
import {
  addLine,
  addTimepoint,
  assignEpisode,
  ensureLine,
  moveTimepoint,
  toTimelineEpisodePath,
  unassignEpisode,
  validateTimeline,
} from "../../src/core/timelineEdit";
import { emptyTimeline, type Timeline } from "../../src/models/timeline";

/**
 * 時期と系統を作る流れの、純粋な部分（設計書6.39.3）。
 *
 * 採番・入れ替え・対応の置き換えは、選択画面の中に埋めると試しようが
 * なくなる。ここで固めておき、`features/chronicleEdit.ts` は
 * 「何を訊くか」だけを持つ。
 */

function base(): Timeline {
  return {
    ...emptyTimeline(),
    lines: [
      {
        id: "ln_001",
        label: "本編",
        kind: "main",
        canonical: true,
        branchFrom: null,
        note: "",
      },
    ],
    timepoints: [
      {
        id: "tp_001",
        lineId: "ln_001",
        label: "十年前",
        absolute: null,
        note: "",
      },
      {
        id: "tp_002",
        lineId: "ln_001",
        label: "本編開始",
        absolute: "四月",
        note: "",
      },
    ],
    episodes: [],
  };
}

describe("系統の用意", () => {
  it("1本も無ければ、本編を作る", () => {
    // 「まず系統を作ってください」と作者に言わせないための処理
    const { timeline, line } = ensureLine(emptyTimeline());

    expect(line.id).toBe("ln_001");
    expect(line.kind).toBe("main");
    expect(line.canonical).toBe(true);
    expect(timeline.lines).toHaveLength(1);
  });

  it("既に本編があれば、何も足さない", () => {
    const { timeline, line } = ensureLine(base());

    expect(line.id).toBe("ln_001");
    expect(timeline.lines).toHaveLength(1);
  });

  it("本編以外の系統しか無ければ、勝手に本編を足さない", () => {
    // 足すと「本編が2本」の検証に触れる余地を作る
    const dream: Timeline = {
      ...emptyTimeline(),
      lines: [
        {
          id: "ln_005",
          label: "太志の夢",
          kind: "dream",
          canonical: false,
          branchFrom: null,
          note: "",
        },
      ],
    };
    const { timeline, line } = ensureLine(dream);

    expect(line.id).toBe("ln_005");
    expect(timeline.lines).toHaveLength(1);
  });
});

describe("時期を作る", () => {
  it("既存の最大＋1で採番し、末尾へ足す", () => {
    const { timeline, timepoint } = addTimepoint(base(), {
      label: "王都陥落",
      absolute: "王暦312年春",
    });

    expect(timepoint.id).toBe("tp_003");
    expect(timepoint.lineId).toBe("ln_001");
    expect(timepoint.absolute).toBe("王暦312年春");
    expect(timeline.timepoints.map((point) => point.id)).toEqual([
      "tp_001",
      "tp_002",
      "tp_003",
    ]);
  });

  it("日付表記は任意。空欄なら null にする", () => {
    const { timepoint } = addTimepoint(base(), {
      label: "いつか",
      absolute: "   ",
    });

    expect(timepoint.absolute).toBeNull();
  });

  it("系統が1本も無い作品では、本編ごと作る", () => {
    const { timeline, timepoint } = addTimepoint(emptyTimeline(), {
      label: "はじまり",
    });

    expect(timeline.lines).toHaveLength(1);
    expect(timepoint.lineId).toBe(timeline.lines[0].id);
  });
});

describe("系統を作る", () => {
  it("種別ごとの既定で、本編の事実かを決める", () => {
    // 夢・IF編・劇中劇は実際には起きていない（設計書6.18の表）
    const { line } = addLine(base(), {
      label: "IF・もし文佳が生きていたら",
      kind: "branch",
      branchFrom: "tp_002",
    });

    expect(line.id).toBe("ln_002");
    expect(line.canonical).toBe(false);
    expect(line.branchFrom).toBe("tp_002");
  });

  it("並行する時間は、本編の事実として扱う", () => {
    const { line } = addLine(base(), { label: "異世界側", kind: "parallel" });

    expect(line.canonical).toBe(true);
  });

  it("作者が既定を上書きできる", () => {
    // 夢だと思わせて実は本当にあった記憶、という作品がある
    const { line } = addLine(base(), {
      label: "太志の夢",
      kind: "dream",
      canonical: true,
    });

    expect(line.canonical).toBe(true);
  });

  it("本編は分岐元を持てない", () => {
    const { line } = addLine(emptyTimeline(), {
      label: "本編",
      kind: "main",
      branchFrom: "tp_001",
    });

    expect(line.branchFrom).toBeNull();
  });
});

describe("話と時期の対応", () => {
  it("同じ話を2回足さず、置き換える", () => {
    // 2回出てくると「どちらが正しいか決められない」として読み込みが止まる
    const once = assignEpisode(base(), "本文/第01話.txt", "tp_001");
    const twice = assignEpisode(once, "本文/第01話.txt", "tp_002");

    expect(twice.episodes).toHaveLength(1);
    expect(twice.episodes[0].timepointId).toBe("tp_002");
  });

  it("区切りは `/` に揃える", () => {
    // `\` のまま保存すると、GitHubを介した別の端末で一致しない
    const timeline = assignEpisode(base(), "本文\\第01話.txt", "tp_001");

    expect(timeline.episodes[0].filePath).toBe("本文/第01話.txt");
  });

  it("時期を付け替えても、作者のメモは消さない", () => {
    const once = assignEpisode(base(), "本文/第03話.txt", "tp_001", "回想");
    const twice = assignEpisode(once, "本文/第03話.txt", "tp_002");

    expect(twice.episodes[0].note).toBe("回想");
  });

  it("対応を外すと、本編扱いへ戻る", () => {
    const assigned = assignEpisode(base(), "本文/第01話.txt", "tp_001");
    const removed = unassignEpisode(assigned, "本文\\第01話.txt");

    expect(removed.episodes).toEqual([]);
  });

  it("作品フォルダーからの相対パスにする", () => {
    expect(
      toTimelineEpisodePath("C:/works/w1", "C:/works/w1/本文/第01話.txt")
    ).toBe("本文/第01話.txt");
  });
});

describe("時期の並べ替え", () => {
  it("前へ動かすと、隣と入れ替わる", () => {
    const moved = moveTimepoint(base(), "tp_002", "up");

    expect(moved.timepoints.map((point) => point.id)).toEqual([
      "tp_002",
      "tp_001",
    ]);
  });

  it("端に居るものは動かさない", () => {
    const moved = moveTimepoint(base(), "tp_001", "up");

    expect(moved.timepoints.map((point) => point.id)).toEqual([
      "tp_001",
      "tp_002",
    ]);
  });

  it("別の系統の時期を追い越さない", () => {
    // 配列には全系統の時期が混ざって並ぶ。素朴に隣と入れ替えると、
    // 作者から見て何も起きていないように見える
    const mixed: Timeline = {
      ...base(),
      lines: [
        ...base().lines,
        {
          id: "ln_002",
          label: "夢",
          kind: "dream",
          canonical: false,
          branchFrom: null,
          note: "",
        },
      ],
      timepoints: [
        base().timepoints[0],
        {
          id: "tp_009",
          lineId: "ln_002",
          label: "夢の中",
          absolute: null,
          note: "",
        },
        base().timepoints[1],
      ],
    };

    const moved = moveTimepoint(mixed, "tp_002", "up");

    expect(moved.timepoints.map((point) => point.id)).toEqual([
      "tp_002",
      "tp_009",
      "tp_001",
    ]);
  });

  it("知らない時期を指されても、何もしない", () => {
    expect(moveTimepoint(base(), "tp_999", "down")).toEqual(base());
  });
});

describe("保存前の検証", () => {
  it("参照が切れていれば止める", () => {
    // 通してしまうと、行き先を見失った話が黙って本編扱いに落ちる
    const broken: Timeline = {
      ...base(),
      episodes: [
        { filePath: "本文/第01話.txt", timepointId: "tp_999", note: "" },
      ],
    };

    expect(() => validateTimeline(broken)).toThrow();
  });

  it("分岐が輪になっていれば止める", () => {
    const looped: Timeline = {
      ...base(),
      lines: [
        {
          id: "ln_001",
          label: "本編",
          kind: "parallel",
          canonical: true,
          branchFrom: "tp_003",
          note: "",
        },
        {
          id: "ln_002",
          label: "IF",
          kind: "branch",
          canonical: false,
          branchFrom: "tp_001",
          note: "",
        },
      ],
      timepoints: [
        ...base().timepoints,
        {
          id: "tp_003",
          lineId: "ln_002",
          label: "もしもの春",
          absolute: null,
          note: "",
        },
      ],
    };

    expect(() => validateTimeline(looped)).toThrow();
  });

  it("正しい形はそのまま通る", () => {
    expect(validateTimeline(base()).timepoints).toHaveLength(2);
  });
});
