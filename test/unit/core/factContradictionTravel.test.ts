import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findContradictionCandidates } from "../../../src/core/contradictionMatch";
import {
  buildFactVerifyIssue,
  describeFactRun,
  type FactRunSummary,
} from "../../../src/core/factContradiction";
import {
  buildFactContradictionIssue,
  buildTravelMaterial,
  factVerifyPromptVersion,
  factVerifySourceOf,
  travelVerifyMaterialOf,
  type FactPlace,
} from "../../../src/core/factContradictionFlow";
import {
  CONTRADICTION_VERIFY_TRAVEL_VERSION,
  CONTRADICTION_VERIFY_VERSION,
} from "../../../src/prompts/contradictionVerify";
import { parseLocation, type Location } from "../../../src/models/location";
import type { FactKind, FactModality, StoryFact } from "../../../src/models/storyFact";

/**
 * 移動の照合の第1段（AIを使わない段）を、測定台で決まった答えに採点する
 * （設計書6.88。台は `test/fixtures/seeded/contradiction-travel/`）。
 *
 * 事実は `facts.json`（P-37 が正しく返したときの形を手で書いたもの）で固定し、
 * **場所の記録・本文・事実だけから、仕込み3件に当たり罠に当たらない**ことを確かめる。
 * AIの抽出の出来は別に測る（`scripts/measure.mjs`）。
 */

const FIXTURE = path.resolve(
  __dirname,
  "../../fixtures/seeded/contradiction-travel"
);

interface FixedFact {
  file: string;
  id: string;
  line: number;
  subject: string;
  predicate: string;
  value: string;
  kind: FactKind;
  modality: FactModality;
}

interface Answers {
  mustNotFlag: Array<{ file: string; lines?: { start: number; end: number } }>;
  episodes: Array<{
    file: string;
    seeded: Array<{ lines: { start: number; end: number } }>;
  }>;
}

function loadFixture() {
  const read = (relative: string) =>
    fs.readFileSync(path.join(FIXTURE, relative), "utf8");
  const locations: Location[] = fs
    .readdirSync(path.join(FIXTURE, "設定", "locations"))
    .map((name) => parseLocation(JSON.parse(read(path.join("設定", "locations", name)))));
  const fixed = JSON.parse(read("facts.json")).facts as FixedFact[];
  const facts: StoryFact[] = fixed.map((entry) => ({
    id: entry.id,
    chapter: Number(entry.id.split(":")[1]),
    lineRange: [entry.line, entry.line],
    subject: entry.subject,
    predicate: entry.predicate,
    value: entry.value,
    kind: entry.kind,
    storyTime: null,
    modality: entry.modality,
    pov: null,
    speaker: null,
    topic: null,
  }));
  const places = new Map<string, FactPlace>(
    fixed.map((entry) => [entry.id, { filePath: entry.file, line: entry.line }])
  );
  const files = fs
    .readdirSync(path.join(FIXTURE, "本文"))
    .sort()
    .map((name) => `本文/${name}`);
  const episodes = files.map((filePath, index) => ({
    filePath,
    chapter: index + 1,
    text: read(filePath),
  }));
  const answers = JSON.parse(read("answers.json")) as Answers;
  return { locations, facts, places, episodes, answers };
}

describe("移動の照合（旅の台・固定の事実）", () => {
  const { locations, facts, places, episodes, answers } = loadFixture();
  const material = buildTravelMaterial({ locations, facts, places, episodes });
  const candidates = findContradictionCandidates({
    facts,
    travelTimes: material.travelTimes,
    whereabouts: material.whereabouts,
  }).filter((candidate) => candidate.predicate === "所在");
  /** 候補の飛び先（後ろ側の事実の場所。製品の `candidateSidesOf` と同じ） */
  const flagged = candidates.map((candidate) => places.get(candidate.right) as FactPlace);

  it("所要時間の表は、いちばん速い値で1日以上の2組だけ（港—港町の徒歩10分は載らない）", () => {
    expect(material.travelTimes).toEqual([
      { from: "loc_0001", to: "loc_0002", minDays: 3 },
      { from: "loc_0001", to: "loc_0004", minDays: 3 },
    ]);
  });

  it("仕込み3件にすべて当たる", () => {
    const seeded = answers.episodes.flatMap((episode) =>
      episode.seeded.map((entry) => ({ file: episode.file, ...entry.lines }))
    );
    expect(seeded).toHaveLength(3);
    for (const target of seeded) {
      expect(
        flagged.some(
          (place) =>
            place.filePath === target.file &&
            place.line >= target.start &&
            place.line <= target.end
        )
      ).toBe(true);
    }
    expect(candidates).toHaveLength(3);
  });

  it("罠（矛盾の無い話・回想・数日後・港と港町・手紙と台詞・印の無い飛び）には当たらない", () => {
    for (const trap of answers.mustNotFlag) {
      const hit = flagged.filter(
        (place) =>
          place.filePath === trap.file &&
          (!trap.lines ||
            (place.line >= trap.lines.start && place.line <= trap.lines.end))
      );
      expect(hit, trap.file).toEqual([]);
    }
  });

  it("工程ごとの件数を数える（所在の形→地の文で引けた→時計に載った）", () => {
    expect(material.stats).toEqual({
      // 17件のうち、居場所の項目名か着いた出来事の形をしているもの（台詞の「帰った」も数える）
      whereaboutsFacts: 17,
      // 地の文でない4件（手紙・台詞・回想）と、台帳に無い「市場」を除く
      resolved: 13,
      clocked: 13,
      tablePairs: 2,
    });
  });

  it("完了報告に工程ごとの件数が出る", () => {
    const summary: FactRunSummary = {
      chunksDone: 6,
      chunksTotal: 6,
      skippedChunks: 0,
      failedChunks: 0,
      acceptedFacts: facts.length,
      recordFacts: 0,
      rejectedFacts: 0,
      rejectionNote: "",
      candidates: 3,
      candidateNote: "時系列 3件",
      kept: 3,
      verifyNote: "",
      cancelled: false,
      travel: material.stats,
    };
    expect(describeFactRun(summary)).toContain(
      "移動の照合（所在の事実 17件・場所に引けた 13件・時計に載った 13件・所要時間の表 2組）"
    );
  });

  /**
   * 再現（2026-10-25、gemma4:26b）：判定（P-12b）は所要時間を知らないので、
   * 「翌朝という時間の経過により移動したことが示されている」と作中の変化で取り下げた。
   * 判定へ渡す「設定では」に、場所の記録の所要時間を添える
   */
  it("判定へ渡す設定の側に、場所の記録の所要時間が載る", () => {
    const candidate = candidates.find((entry) => entry.right === "fact:6:12:1");
    if (!candidate) throw new Error("第6話12行目の候補が無い");
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const issue = buildFactVerifyIssue({
      candidate,
      left: byId.get(candidate.left) as StoryFact,
      right: byId.get(candidate.right) as StoryFact,
      rightLineText: "翌朝、エドは港町に着いた。",
    });
    expect(issue.settingSays).toContain("場所の記録では、王都と港町のあいだは3日かかる");
  });

  /**
   * 判定（P-12b travel 1.0）へ渡す材料。26b は第2話の「その頃」を同じ時と読まずに
   * 「8行目で港町にいるのは移動として成立する」と取り下げた。判定は後ろ側の ±5行しか
   * 見ないので、前側（2行目「リナは王都にいた」）が窓の外にあった
   */
  it("移動の照合の候補には、時の手がかりと前側の前後を添える", () => {
    const read = (file: string) => episodes.find((episode) => episode.filePath === file)?.text;
    const materialFor = (rightId: string, rightLineText: string) => {
      const candidate = candidates.find((entry) => entry.right === rightId);
      if (!candidate) throw new Error(`${rightId} の候補が無い`);
      expect(factVerifySourceOf(candidate)).toBe("travel");
      const leftPlace = places.get(candidate.left) as FactPlace;
      return travelVerifyMaterialOf({
        candidate,
        leftPlace,
        leftSourceText: read(leftPlace.filePath),
        rightPlace: places.get(rightId) as FactPlace,
        rightLineText,
      });
    };

    const second = materialFor("fact:2:8:1", "　その頃、リナは港町にいた。朝に揚がったばかりの魚を、市場で選んでいる。");
    expect(second?.timeCue).toBe("「その頃」（前の場面と同じ時と読みました）");
    expect(second?.leftContext).toContain("2: 　リナは王都にいた。");
    expect(second?.travelTime).toContain("王都と港町のあいだは3日かかる");
    // 第2話は「四月九日」の日付で暦に載り、その日のいつか分からないので幅1日をとる
    expect(second?.reading).toContain("長く見積もっても1日で移っている");

    const sixth = materialFor("fact:6:12:1", "　翌朝、エドは港町に着いた。");
    expect(sixth?.timeCue).toBe("「翌朝」（前の場面の1日後と読みました）");
    expect(sixth?.leftContext).toContain("6: 　王都に戻ったエドは");

    const fourth = materialFor("fact:4:8:1", "　二日後、ゴドーは王都に到着した。");
    expect(fourth?.timeCue).toBe("「二日後」（前の場面の2日後と読みました）");
  });

  it("前側が判定の窓（±5行）に入っていれば、前後を重ねて渡さない。移動の照合でない候補には材料を作らない", () => {
    const candidate = candidates[0];
    const inWindow = travelVerifyMaterialOf({
      candidate,
      leftPlace: { filePath: "本文/x.txt", line: 7 },
      leftSourceText: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12",
      rightPlace: { filePath: "本文/x.txt", line: 12 },
    });
    expect(inWindow?.leftContext).toBe("");
    expect(
      travelVerifyMaterialOf({
        candidate: { ...candidate, origin: undefined },
        rightPlace: { filePath: "本文/x.txt", line: 12 },
      })
    ).toBeUndefined();
    expect(factVerifySourceOf({ origin: undefined })).toBe("settled");
  });

  /**
   * 作者の裁定（2026-10-25 夜）：e4b は判定を「採用」にしながら説明に「矛盾とは断定できない」
   * と書いた。画面の補足に逆向きの説明を出さず、機械の根拠（所要時間）だけを添える。
   * 指摘そのものは残す。移動の照合の候補だけに効かせる
   */
  it("採用なのに説明が逆向きなら、説明を伏せて機械の根拠だけを添える（移動の照合だけ）", () => {
    const candidate = candidates.find((entry) => entry.right === "fact:6:12:1");
    if (!candidate) throw new Error("第6話12行目の候補が無い");
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const sides = {
      left: byId.get(candidate.left) as StoryFact,
      right: byId.get(candidate.right) as StoryFact,
      place: places.get(candidate.right) as FactPlace,
      rightInBody: true,
    };
    const noteWith = (explanation: string, travel = true) =>
      buildFactContradictionIssue({ candidate: { ...candidate, origin: travel ? "travel" : undefined }, sides, explanation }).note;

    for (const reversed of [
      "「その頃」という表現は、時間経過の描写が省略されていることを示唆するため、矛盾とは断定できない。",
      "「二日後」という記述は、物語上の経過時間として機能するため、矛盾とは言えない。",
      "移動したので矛盾ではない。",
      "時間が経っているので両立する。",
    ]) {
      const note = noteWith(reversed);
      expect(note).not.toContain(reversed);
      expect(note).not.toContain("判定:");
      expect(note).toContain("長く見積もっても1日で移っている");
      expect(note).toContain("場所の記録では、王都と港町のあいだは3日かかる");
    }

    // 向きの合った説明はそのまま。指示の文（「両立の理由になりません」「同時に成り立ちません」）を
    // 写した採用の説明も、逆向きとは読まない（指示の言葉は答えに返ってくる）
    for (const agreeing of [
      "翌朝（1日後）に到着しており、移動手段の記述もないため矛盾している。",
      "人物が場所を移ったこと自体は、この指摘の前提であって、両立の理由になりません。",
      "書かれた経過が所要時間より短く、速く移る手段も本文に書かれていないなら、同時に成り立ちません。",
    ]) {
      expect(noteWith(agreeing)).toContain(`判定: ${agreeing}`);
    }

    // 移動の照合でない候補には効かせない（本命の候補の補足は変えない）
    expect(noteWith("矛盾とは言えない。", false)).toContain("判定: 矛盾とは言えない。");
  });

  /** 控えの鍵：移動の照合だけ版を分ける。本命の鍵は変えない（作者のクラウドAIの控えを作り直さない） */
  it("判定の控えの版は、移動の照合だけ travel の印が付く", () => {
    expect(factVerifyPromptVersion("settled")).toBe(CONTRADICTION_VERIFY_VERSION);
    expect(factVerifyPromptVersion("travel")).toBe(
      `${CONTRADICTION_VERIFY_VERSION}:travel${CONTRADICTION_VERIFY_TRAVEL_VERSION}`
    );
  });

  /**
   * travel 1.1 の1文は承認待ちの距離を使った候補にだけ置くので、使わない候補の文面は
   * 1.0 と同じ。**控えも 1.0 の鍵のまま使う**（同じ文面の答えを作り直さない。実装ルール4）
   */
  it("承認待ちの距離を使わない移動の候補は 1.0 の鍵、使う候補は 1.1 の鍵", () => {
    expect(factVerifyPromptVersion("travel", false)).toBe(`${CONTRADICTION_VERIFY_VERSION}:travel1.0`);
    expect(factVerifyPromptVersion("travel", true)).toBe(`${CONTRADICTION_VERIFY_VERSION}:travel1.1`);
    // 本命は承認待ちの印に関わらず変わらない
    expect(factVerifyPromptVersion("settled", true)).toBe(CONTRADICTION_VERIFY_VERSION);
  });

  /**
   * 作者の選択③（含みで引く）と、その夜の裁定（名前が2字以下の場所は含みで引かない）。
   * この台の場所は「王都」「港町」と2字なので、値が「港町の宿」「王都の城門の詰所」の形だと
   * 引けない。引けなかった分は照合しないだけで、罠（回想の「王都の城門の前」）には当たらない
   */
  it("2字の名前の場所は、値が名前そのものでないと引かない（罠には当たらない）", () => {
    const loose: Record<string, string> = {
      "fact:2:2:1": "王都の城門の詰所",
      "fact:2:8:1": "港町の市場",
      "fact:3:1:1": "港町の宿",
      "fact:5:1:1": "港町の灯台の下",
      "fact:5:8:1": "王都の城門の前",
      "fact:6:1:1": "港町の宿",
    };
    const looseFacts = facts.map((fact) =>
      loose[fact.id] ? { ...fact, value: loose[fact.id] } : fact
    );
    const looseMaterial = buildTravelMaterial({ locations, facts: looseFacts, places, episodes });
    // 地の文の5件（回想の 5:8 はもとから数えない）が引けなくなる
    expect(looseMaterial.stats.resolved).toBe(material.stats.resolved - 5);
    const looseFlagged = findContradictionCandidates({
      facts: looseFacts,
      travelTimes: looseMaterial.travelTimes,
      whereabouts: looseMaterial.whereabouts,
    })
      .filter((candidate) => candidate.predicate === "所在")
      .map((candidate) => places.get(candidate.right) as FactPlace);
    for (const trap of answers.mustNotFlag) {
      expect(
        looseFlagged.filter(
          (place) =>
            place.filePath === trap.file &&
            (!trap.lines || (place.line >= trap.lines.start && place.line <= trap.lines.end))
        ),
        trap.file
      ).toEqual([]);
    }
  });

  /**
   * 受け入れ条件：既存の台（`seeded/contradiction`、2/4・誤検出0）の成績を変えない。
   * あちらの場所の記録には距離の関係が無いので、表は0組——移動の照合は
   * 何も出さず、ほかの照合器へ渡る事実も並びも変わらない。
   */
  it("既存の矛盾の台では表が0組（移動の照合は何も足さない）", () => {
    const dir = path.resolve(FIXTURE, "..", "contradiction", "設定", "locations");
    const existing = fs
      .readdirSync(dir)
      .map((name) => parseLocation(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))));
    expect(
      buildTravelMaterial({ locations: existing, facts, places, episodes }).travelTimes
    ).toEqual([]);
  });

  /** 場所の記録に距離が1つも無ければ、黙らずに「していない」と書く */
  it("表が0組なら、移動の照合はしていないと書く", () => {
    const bare = buildTravelMaterial({
      locations: locations.map((location) => ({ ...location, relations: [] })),
      facts,
      places,
      episodes,
    });
    expect(bare.travelTimes).toEqual([]);
    expect(
      findContradictionCandidates({
        facts,
        travelTimes: bare.travelTimes,
        whereabouts: bare.whereabouts,
      }).filter((candidate) => candidate.predicate === "所在")
    ).toEqual([]);
    const line = describeFactRun({
      chunksDone: 6,
      chunksTotal: 6,
      skippedChunks: 0,
      failedChunks: 0,
      acceptedFacts: facts.length,
      recordFacts: 0,
      rejectedFacts: 0,
      rejectionNote: "",
      candidates: 0,
      candidateNote: "",
      kept: 0,
      verifyNote: "",
      cancelled: false,
      travel: bare.stats,
    });
    expect(line).toContain("所要時間の表が0組なので移動の照合はしていません");
  });
});
