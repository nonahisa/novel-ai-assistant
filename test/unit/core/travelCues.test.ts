import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { findContradictionCandidates } from "../../../src/core/contradictionMatch";
import {
  describeFactRun,
  describeTravelCues,
  TRAVEL_CUES_NO_LOCATIONS_NOTE,
} from "../../../src/core/factContradiction";
import {
  buildTravelMaterial,
  travelVerifyMaterialOf,
  type FactPlace,
  type TravelMaterial,
} from "../../../src/core/factContradictionFlow";
import {
  buildSceneClock,
  describeTimeCue,
  sceneTimeMarkerKey,
  type SceneTimeMarker,
} from "../../../src/core/sceneClock";
import {
  buildTravelDistanceProposals,
  isTravelDistanceChunk,
  pendingDistancesOf,
  planTimeCueRequests,
  plannedTravelCueCalls,
  runTravelCues,
  travelDistanceDismissKey,
  travelDistanceDismissKeysOf,
  validateSceneTimeCue,
  validateTravelDistances,
  type TravelCueAskRequest,
} from "../../../src/core/travelCues";
import { parseLocation, type Location } from "../../../src/models/location";
import type { FactKind, FactModality, StoryFact } from "../../../src/models/storyFact";
import { TRAVEL_DISTANCE_EXAMPLE } from "../../../src/prompts/travelDistanceExtract";
import { SCENE_TIME_CUE_EXAMPLE } from "../../../src/prompts/sceneTimeCue";

/**
 * 移動の照合の AI の手がかり（P-51 本文の距離・P-52 場面の頭の時の経過。設計書6.88.13）。
 *
 * 台は `test/fixtures/seeded/contradiction-travel-ai/`——場所の記録はあるが距離は無く、
 * 時の経過も文の途中にしか書かれていない所がある。**AIは呼ばない。** 事実は `facts.json`、
 * AIの答えは `aiCues.json`（手で書いた正しい答えと、読み違えたときの答え）で固定し、
 * 検算・時計・照合だけを決まった答えで採点する（設計書6.88.11 の流し方）。
 */

const FIXTURE = path.resolve(__dirname, "../../fixtures/seeded/contradiction-travel-ai");

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

interface DistanceAnswer {
  file: string;
  from: string;
  to: string;
  value: string;
  evidence: string;
  line: number;
  dialogue?: boolean;
}

interface TimeCueAnswer {
  file: string;
  line: number;
  kind: string | null;
  days: number;
  evidence: string;
}

interface Answers {
  mustNotFlag: Array<{ file: string; lines?: { start: number; end: number } }>;
  episodes: Array<{ file: string; seeded: Array<{ lines: { start: number; end: number } }> }>;
}

function loadFixture() {
  const read = (relative: string) => fs.readFileSync(path.join(FIXTURE, relative), "utf8");
  const locations: Location[] = fs
    .readdirSync(path.join(FIXTURE, "設定", "locations"))
    .sort()
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
  const files = fs.readdirSync(path.join(FIXTURE, "本文")).sort().map((name) => `本文/${name}`);
  const episodes = files.map((filePath, index) => ({
    filePath,
    chapter: index + 1,
    text: read(filePath),
  }));
  // 1話1チャンク（製品のチャンクと同じ形。行番号は元のファイルのまま）
  const chunks: Chunk[] = episodes.map((episode) => ({
    filePath: episode.filePath,
    index: 0,
    text: episode.text,
    startLine: 0,
    chapterStart: episode.chapter,
    chapterEnd: episode.chapter,
    hash: `hash:${episode.filePath}`,
    wholeFile: true,
  }));
  const cues = JSON.parse(read("aiCues.json")) as {
    distances: DistanceAnswer[];
    trapDistances: DistanceAnswer[];
    timeCues: TimeCueAnswer[];
    trapTimeCues: TimeCueAnswer[];
  };
  const answers = JSON.parse(read("answers.json")) as Answers;
  return { locations, facts, places, episodes, chunks, cues, answers };
}

const fixture = loadFixture();
const { locations, facts, places, episodes, chunks, cues, answers } = fixture;
const chunkOf = (file: string) => chunks.find((chunk) => chunk.filePath === file) as Chunk;

/** 移動の照合の候補の飛び先（後ろ側の事実の場所。製品の `candidateSidesOf` と同じ） */
function flaggedOf(material: TravelMaterial) {
  const candidates = findContradictionCandidates({
    facts,
    travelTimes: material.travelTimes,
    whereabouts: material.whereabouts,
  }).filter((candidate) => candidate.origin === "travel");
  return {
    candidates,
    flagged: candidates.map((candidate) => places.get(candidate.right) as FactPlace),
  };
}

function hits(flagged: FactPlace[], file: string, lines?: { start: number; end: number }) {
  return flagged.filter(
    (place) =>
      place.filePath === file && (!lines || (place.line >= lines.start && place.line <= lines.end))
  );
}

/** 手で書いた正しい答えを、検算を通して材料にする（製品と同じ関数の並び） */
function materialFromAnswers() {
  const distances = cues.distances.flatMap(
    (answer) =>
      validateTravelDistances({ distances: [answer] }, chunkOf(answer.file), locations).accepted
  );
  const pendingDistances = pendingDistancesOf(distances);
  const first = buildTravelMaterial({ locations, facts, places, episodes, pendingDistances });
  const plan = planTimeCueRequests({ material: first, facts, episodes });
  const markers = new Map<string, SceneTimeMarker>();
  for (const request of plan.requests) {
    const answer = cues.timeCues.find(
      (cue) => cue.file === request.filePath && cue.line === request.line
    );
    if (!answer) continue;
    const checked = validateSceneTimeCue(answer, request);
    if (checked.marker) markers.set(request.key, checked.marker);
  }
  const material = buildTravelMaterial({
    locations,
    facts,
    places,
    episodes,
    pendingDistances,
    aiMarkers: markers,
  });
  return { distances, plan, markers, material };
}

describe("再現：AIの手がかりが無いと、距離が本文にしか無い台では何も比べられない", () => {
  it("第1段（AIを使わない段）の候補は0件・表も0組", () => {
    const material = buildTravelMaterial({ locations, facts, places, episodes });
    expect(material.travelTimes).toEqual([]);
    expect(flaggedOf(material).candidates).toEqual([]);
  });
});

describe("AIの手がかりの台（手で書いた正しい答えで採点）", () => {
  const { distances, plan, material } = materialFromAnswers();
  const { candidates, flagged } = flaggedOf(material);

  it("本文の距離3件が検算を通り、台詞の噂には印が付く", () => {
    expect(
      distances.map((distance) => [distance.fromName, distance.toName, distance.value, distance.dialogue])
    ).toEqual([
      ["王都", "港町", "馬で三日", false],
      ["王都", "北の砦", "馬で三日", false],
      ["港町", "北の砦", "徒歩で十日", true],
    ]);
    expect(distances.map((distance) => [distance.filePath, distance.line, distance.chapter])).toEqual([
      ["本文/001_馬で三日.txt", 2, 1],
      ["本文/002_二日目の砦.txt", 2, 2],
      ["本文/004_港町の宿.txt", 3, 4],
    ]);
  });

  it("P-52 へ訊くのは、比べられない組のあいだで鎖が切れた場面の頭だけ（7件）", () => {
    expect(plan.requests.map((request) => `${request.filePath}:${request.line}`)).toEqual([
      "本文/002_二日目の砦.txt:7",
      "本文/003_城門へ帰る.txt:1",
      "本文/004_港町の宿.txt:1",
      "本文/004_港町の宿.txt:8",
      "本文/005_港へ下りる.txt:1",
      "本文/006_灯台の下.txt:1",
      "本文/006_灯台の下.txt:6",
    ]);
    expect(plan.skipped).toBe(0);
    // 前の場面の終わり（話をまたぐ）と、この場面の頭（区切りで止まる）
    const third = plan.requests[1];
    expect(third.previousParagraphs).toEqual([
      "　リナは支度を整え、城門を出た。",
      "　王都を出て二日目の夕方、リナは北の砦に着いた。",
      "　門番のゴドーが、目を丸くして迎えた。",
    ]);
    expect(third.headParagraphs[0]).toBe("　ゴドーが王都の城門に着いたのは、翌朝のことだった。");
  });

  it("仕込み3件にすべて当たる", () => {
    const seeded = answers.episodes.flatMap((episode) =>
      episode.seeded.map((entry) => ({ file: episode.file, ...entry.lines }))
    );
    expect(seeded).toHaveLength(3);
    for (const target of seeded) {
      expect(hits(flagged, target.file, target), target.file).toHaveLength(1);
    }
    expect(candidates).toHaveLength(3);
  });

  it("罠（三日三晩・台詞の噂・港と港町・回想の三年前・数日後）には当たらない", () => {
    for (const trap of answers.mustNotFlag) {
      expect(hits(flagged, trap.file, trap.lines), trap.file).toEqual([]);
    }
  });

  it("根拠に「承認待ち」と本文の引用が出る（作者の判断②）", () => {
    for (const candidate of candidates) {
      expect(candidate.basis).toContain("承認待ち");
    }
    const first = candidates.find((candidate) => candidate.right === "fact:1:8:1");
    expect(first?.basis).toContain("本文「王都から港町までは、馬で三日の道のりだ」");
  });

  it("判定へ渡す時の手がかりに、AIの読みと分かる形で出る", () => {
    const candidate = candidates.find((entry) => entry.right === "fact:2:7:1");
    if (!candidate) throw new Error("第2話7行目の候補が無い");
    const travel = travelVerifyMaterialOf({
      candidate,
      rightPlace: places.get("fact:2:7:1") as FactPlace,
      rightLineText: "　王都を出て二日目の夕方、リナは北の砦に着いた。",
      aiMarkers: material.aiMarkers,
    });
    expect(travel?.timeCue).toBe("「王都を出て二日目」（AIの読み：前の場面から2日後）");
  });

  it("完了報告に AI の手がかりの数が出る", () => {
    const line = describeFactRun({
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
      travel: {
        ...material.stats,
        aiCues: {
          noLocations: false,
          distanceChunks: 5,
          distancesAccepted: 3,
          distancesRejected: 1,
          distancesDismissed: 0,
          proposedLocations: 2,
          timeCueRequests: 7,
          timeCueSkipped: 0,
          timeCuesApplied: 2,
          timeCuesCut: 2,
          failures: 0,
        },
      },
    });
    expect(line).toContain("所要時間の表 3組");
    expect(line).toContain("AIの手がかり（本文の距離 3件（捨てた 1件）・設定資料へ提案 2か所（承認待ち）");
    expect(line).toContain("場面の頭の時の手がかり 2/7件（分からないとした 2件）");
  });
});

describe("P-51 の検算（落とし方）", () => {
  const chunk = chunkOf("本文/001_馬で三日.txt");
  const one = (entry: Record<string, unknown>) =>
    validateTravelDistances({ distances: [entry] }, chunk, locations);
  const good = {
    from: "王都",
    to: "港町",
    value: "馬で三日",
    evidence: "王都から港町までは、馬で三日の道のりだ",
    line: 2,
  };

  it("正しい答えは通る。別名でも引ける", () => {
    expect(one(good).accepted).toHaveLength(1);
  });

  it.each([
    ["malformed", { ...good, value: 3 }],
    ["example_echo", { ...good, value: TRAVEL_DISTANCE_EXAMPLE.value }],
    ["unknown_place", { ...good, to: "白砂の町" }],
    ["same_place", { ...good, to: "リヴェルス" }],
    ["unreadable_value", { ...good, value: "馬ですぐ" }],
    // 引用が本文に無い
    ["ungrounded", { ...good, evidence: "王都から港町までは、馬で二日の道のりだ" }],
    // 値が引用に無い
    ["ungrounded", { ...good, value: "徒歩で三日" }],
    // 出発の場所が引用に無い（相手だけで付け替えさせない）
    ["ungrounded", { ...good, from: "北の砦", evidence: "港町までは、馬で三日の道のりだ" }],
  ])("%s で捨てる", (reason, entry) => {
    const result = one(entry);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual([reason]);
  });

  it("入れ子（港と港町）は捨てる", () => {
    const result = validateTravelDistances(
      { distances: [{ ...cues.trapDistances[0], value: "徒歩で十分" }] },
      chunkOf("本文/005_港へ下りる.txt"),
      locations
    );
    expect(result.rejected.map((item) => item.reason)).toEqual(["nested"]);
  });

  it("読み違えの答え（aiCues.json の trapDistances）はすべて捨てる", () => {
    for (const trap of cues.trapDistances) {
      expect(
        validateTravelDistances({ distances: [trap] }, chunkOf(trap.file), locations).accepted,
        trap.evidence
      ).toEqual([]);
    }
  });

  it("答えの形が崩れていれば何も受け取らない", () => {
    expect(validateTravelDistances({ items: [] }, chunk, locations).rejected).toEqual([
      { reason: "malformed" },
    ]);
  });

  it("送るのは、場所の名前と道のりの語を含むチャンクだけ", () => {
    expect(isTravelDistanceChunk({ text: "王都から港町までは馬で三日" }, locations)).toBe(true);
    expect(isTravelDistanceChunk({ text: "馬で三日の道のり" }, locations)).toBe(false);
    expect(isTravelDistanceChunk({ text: "王都は静かだった" }, locations)).toBe(false);
    // 第5話は道のりの語が無い（「歩いてすぐ」「翌朝」）ので送らない
    expect(plannedTravelCueCalls(chunks, locations)).toEqual({ distance: 5, timeCue: 30 });
    expect(plannedTravelCueCalls(chunks, locations.slice(0, 1))).toEqual({ distance: 0, timeCue: 0 });
  });
});

describe("P-52 の検算（分からないとする）", () => {
  const request = (headParagraph: string) => ({ headParagraphs: [headParagraph, "　次の段落。"] });
  const head = "　王都を出て二日目の夕方、リナは北の砦に着いた。";

  it("正しい答えは通る（数の無い「翌朝」は1日）", () => {
    expect(validateSceneTimeCue({ kind: "advance", days: 2, evidence: "王都を出て二日目" }, request(head))).toEqual({
      marker: { kind: "advance", days: 2, evidence: "王都を出て二日目" },
      outcome: "accepted",
    });
    expect(
      validateSceneTimeCue(
        { kind: "advance", days: 1, evidence: "翌朝" },
        request("　ゴドーが王都の城門に着いたのは、翌朝のことだった。")
      ).outcome
    ).toBe("accepted");
    expect(
      validateSceneTimeCue({ kind: "simultaneous", days: 0, evidence: "ちょうどその頃" }, request("　ちょうどその頃、エドは港町にいた。")).outcome
    ).toBe("accepted");
    expect(validateSceneTimeCue({ kind: null, days: 0, evidence: "" }, request(head))).toEqual({ outcome: "none" });
  });

  it.each([
    ["数が合わない", { kind: "advance", days: 3, evidence: "王都を出て二日目" }, head],
    ["引用が台詞の中", { kind: "advance", days: 1, evidence: "翌朝" }, "　「翌朝には着くさ」とリナは言った。"],
    ["引用が最初の段落に無い", { kind: "advance", days: 1, evidence: "次の段落" }, head],
    ["見本がそのまま返った", { ...SCENE_TIME_CUE_EXAMPLE }, `　${SCENE_TIME_CUE_EXAMPLE.evidence}、リナは着いた。`],
    ["同じ日を言う語が無い", { kind: "sameDay", days: 0, evidence: "王都を出て" }, head],
    ["知らない種類", { kind: "later", days: 1, evidence: "王都を出て" }, head],
  ])("%s → cut", (_label, answer, paragraph) => {
    expect(validateSceneTimeCue(answer, request(paragraph)).outcome).toBe("cut");
  });

  it("読み違えの答え（aiCues.json の trapTimeCues）はすべて cut になる", () => {
    for (const trap of cues.trapTimeCues) {
      const text = episodes.find((episode) => episode.filePath === trap.file)?.text ?? "";
      const paragraph = text.split("\n")[trap.line - 1];
      expect(validateSceneTimeCue(trap, request(paragraph)).outcome, trap.evidence).toBe("cut");
    }
  });
});

describe("時計のAIの印", () => {
  const marker = (evidence: string, days = 2): SceneTimeMarker => ({ kind: "advance", days, evidence });

  it("区切りのあとの印の無い段落にだけ効き、引用は場面の途中の経過に数えない", () => {
    const text = ["　リナは王都にいた。", "", "　＊", "", "　王都を出て二日目の夕方、リナは砦に着いた。", "　翌朝、リナは発った。"].join("\n");
    const markers = new Map([[sceneTimeMarkerKey("1.txt", 5), marker("王都を出て二日目")]]);
    const clock = buildSceneClock([{ filePath: "1.txt", chapter: 1, text }], markers);
    expect(clock.readingAt("1.txt", 5)?.chain).toBe(clock.readingAt("1.txt", 1)?.chain);
    expect(clock.readingAt("1.txt", 5)).toMatchObject({ dayLow: 2, dayHigh: 2 });
    // 引用を外して経過を探すので、次の「翌朝」も同じ鎖で数えられる
    expect(clock.readingAt("1.txt", 6)).toMatchObject({ dayLow: 3, dayHigh: 3 });
    expect(clock.stats.aiMarkers).toBe(1);
    expect(clock.heads.map((head) => [head.line, head.chainStart, head.aiMarked])).toEqual([
      [1, true, false],
      [5, false, true],
      [6, false, false],
    ]);
  });

  it("決まった語の印が先。AIの読みは使わない", () => {
    const text = ["　リナは王都にいた。", "", "　＊", "", "　翌朝、リナは砦に着いた。"].join("\n");
    const markers = new Map([[sceneTimeMarkerKey("1.txt", 5), marker("翌朝", 5)]]);
    const clock = buildSceneClock([{ filePath: "1.txt", chapter: 1, text }], markers);
    expect(clock.readingAt("1.txt", 5)).toMatchObject({ dayLow: 1, dayHigh: 1 });
    expect(clock.stats.aiMarkers).toBe(0);
    expect(describeTimeCue("　翌朝、リナは砦に着いた。", marker("翌朝", 5))).toBe(
      "「翌朝」（前の場面の1日後と読みました）"
    );
  });

  it("場面の途中の段落と、台詞で始まる段落には効かない", () => {
    const text = ["　リナは王都にいた。", "　王都を出て二日目の夕方だった。", "　「二日目だ」"].join("\n");
    const markers = new Map([
      [sceneTimeMarkerKey("1.txt", 2), marker("王都を出て二日目")],
      [sceneTimeMarkerKey("1.txt", 3), marker("二日目")],
    ]);
    const clock = buildSceneClock([{ filePath: "1.txt", chapter: 1, text }], markers);
    expect(clock.readingAt("1.txt", 2)?.segment).toBe(clock.readingAt("1.txt", 1)?.segment);
    expect(clock.stats.aiMarkers).toBe(0);
  });

  it("AIの読みの「分からない」は手がかりとして見せない", () => {
    // 決まった語の印（「数日」）があれば、これまでどおりそちらを見せる
    expect(describeTimeCue("　数日後のことだ。", { kind: "cut", days: 0, evidence: "数日後" })).toBe(
      "「数日」（何日経ったか分からないと読みました）"
    );
    expect(describeTimeCue("　リナは数日後に戻った。", { kind: "cut", days: 0, evidence: "数日後" })).toBe("");
  });
});

describe("距離の提案（承認待ちの写し）", () => {
  const { distances } = materialFromAnswers();
  const proposals = buildTravelDistanceProposals(distances, locations);

  it("出発の場所ごとに、今回足す関係だけを写しに入れる", () => {
    expect(proposals.map((proposal) => proposal.record.name)).toEqual(["王都", "港町"]);
    const capital = proposals[0];
    expect(capital.record.relations?.map((relation) => [relation.target, relation.targetId, relation.value])).toEqual([
      ["港町", "loc_0002", "馬で三日"],
      ["北の砦", "loc_0004", "馬で三日"],
    ]);
    expect(capital.record.relations?.every((relation) => relation.authorLocked === false)).toBe(true);
    expect(capital.reason).toContain("事実の照合で本文「王都から港町までは、馬で三日の道のりだ」（第1話）から読んだ所要時間");
  });

  it("台詞の距離は理由に「台詞」と書く（作者の判断④）", () => {
    expect(proposals[1].reason).toContain("台詞");
    expect(proposals[0].reason).not.toContain("台詞");
  });

  it("同じ（距離, 相手, 値）がもう記録にあれば足さない", () => {
    const withRelation = locations.map((location) =>
      location.id === "loc_0001"
        ? {
            ...location,
            relations: [
              {
                kind: "distance" as const,
                target: "港町",
                targetId: "loc_0002",
                value: "馬で三日",
                chapters: [],
                evidence: null,
                authorLocked: true,
              },
            ],
          }
        : location
    );
    const again = buildTravelDistanceProposals(distances, withRelation);
    expect(again[0].record.relations?.map((relation) => relation.target)).toEqual(["北の砦"]);
  });
});

describe("通し（runTravelCues）", () => {
  /** aiCues.json の正しい答えを返す AI の代役 */
  function fakeAsk(log: TravelCueAskRequest[]) {
    return async (request: TravelCueAskRequest): Promise<unknown> => {
      log.push(request);
      if (request.stage === "distance") {
        const file = chunks.find((chunk) => request.userPrompt.includes(chunk.text.split("\n")[0]))?.filePath;
        return { distances: cues.distances.filter((answer) => answer.file === file) };
      }
      const answer = cues.timeCues.find((cue) => {
        const text = episodes.find((episode) => episode.filePath === cue.file)?.text ?? "";
        const headLine = text.split("\n")[cue.line - 1];
        return request.userPrompt.includes(`## この場面の頭\n${headLine}`);
      });
      return answer ?? { kind: null, days: 0, evidence: "" };
    };
  }

  it("製品と同じ並びで回すと、仕込み3件に当たり罠に当たらない", async () => {
    const log: TravelCueAskRequest[] = [];
    const result = await runTravelCues({ locations, facts, places, episodes, chunks, ask: fakeAsk(log) });
    const { flagged } = flaggedOf(result.material);
    expect(flagged.map((place) => `${place.filePath}:${place.line}`).sort()).toEqual([
      "本文/001_馬で三日.txt:8",
      "本文/002_二日目の砦.txt:7",
      "本文/003_城門へ帰る.txt:1",
    ]);
    expect(result.stats).toMatchObject({
      noLocations: false,
      distancesAccepted: 3,
      proposedLocations: 2,
      timeCueRequests: 7,
      timeCuesApplied: 2,
      timeCuesCut: 2,
      failures: 0,
    });
    expect(result.material.stats.aiCues).toEqual(result.stats);
    expect(log.filter((request) => request.stage === "distance")).toHaveLength(result.stats.distanceChunks);
    expect(log.every((request) => request.cacheId.length > 0)).toBe(true);
  });

  it("上限を超えた場面の頭は訊かずに数える（母艦の判断⑤）", async () => {
    const log: TravelCueAskRequest[] = [];
    const result = await runTravelCues({
      locations,
      facts,
      places,
      episodes,
      chunks,
      ask: fakeAsk(log),
      timeCueLimit: 2,
    });
    expect(result.stats.timeCueRequests).toBe(2);
    expect(result.stats.timeCueSkipped).toBe(5);
  });

  it("AIが答えられなくても止めず、失敗を数える", async () => {
    const result = await runTravelCues({
      locations,
      facts,
      places,
      episodes,
      chunks,
      ask: async () => undefined,
    });
    expect(result.stats.failures).toBeGreaterThan(0);
    expect(result.proposals).toEqual([]);
    expect(flaggedOf(result.material).candidates).toEqual([]);
  });

  it("場所の記録が無い作品では AI を呼ばず、設定資料の抽出へ案内する（作者の判断③）", async () => {
    const log: TravelCueAskRequest[] = [];
    const result = await runTravelCues({
      locations: [],
      facts,
      places,
      episodes,
      chunks,
      ask: fakeAsk(log),
    });
    expect(log).toEqual([]);
    expect(result.stats.noLocations).toBe(true);
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
      travel: result.material.stats,
    });
    expect(line).toContain(TRAVEL_CUES_NO_LOCATIONS_NOTE);
  });

  /**
   * 見送った距離はもう出さない（作者の裁定 2026-10-26「見送ったものはもう出さない」）。
   * 場所の記録に却下の欄が無いので、見送るたびに次の実行で同じ提案が積まれていた
   */
  it("見送った距離は、同じ2か所・同じ値なら提案せず、照合にも使わない", async () => {
    const dismissedKeys = new Set([travelDistanceDismissKey("loc_0002", "loc_0001", "馬で三日")]);
    const result = await runTravelCues({
      locations,
      facts,
      places,
      episodes,
      chunks,
      ask: fakeAsk([]),
      dismissedKeys,
    });
    const capital = result.proposals.find((proposal) => proposal.record.id === "loc_0001");
    // 王都→港町の「馬で三日」は出ない。同じ記録の北の砦はそのまま出る
    expect(capital?.record.relations?.map((relation) => relation.target)).toEqual(["北の砦"]);
    expect(result.distances.some((d) => d.fromId === "loc_0001" && d.toId === "loc_0002")).toBe(false);
    expect(result.stats.distancesDismissed).toBe(1);
    expect(result.stats.distancesAccepted).toBe(2);
    // 黙って落とさない：完了報告に数を出す
    expect(describeTravelCues(result.stats)).toContain("前に見送った距離 1件は出していません");
    // 見送った距離を根拠にした指摘（第1話8行目）は立たない
    const { flagged } = flaggedOf(result.material);
    expect(flagged.map((place) => `${place.filePath}:${place.line}`)).not.toContain(
      "本文/001_馬で三日.txt:8"
    );
  });

  it("本文の値が変わったら、見送ったものとは別の提案として出す", async () => {
    const dismissedKeys = new Set([travelDistanceDismissKey("loc_0001", "loc_0002", "馬で四日")]);
    const result = await runTravelCues({
      locations,
      facts,
      places,
      episodes,
      chunks,
      ask: fakeAsk([]),
      dismissedKeys,
    });
    const capital = result.proposals.find((proposal) => proposal.record.id === "loc_0001");
    expect(capital?.record.relations?.map((relation) => relation.target)).toEqual(["港町", "北の砦"]);
    expect(result.stats.distancesDismissed).toBe(0);
  });

  it("見送った承認待ちの案から、距離の鍵を取り出す（相手が引けない関係は覚えない）", () => {
    const { distances } = materialFromAnswers();
    const [capital] = buildTravelDistanceProposals(distances, locations);
    const record = structuredClone(capital.record);
    record.relations = [
      ...(record.relations ?? []),
      // 相手のidが無い関係は、どの2か所か決められないので覚えない
      { kind: "distance", target: "どこか", targetId: null, value: "一日", chapters: [], evidence: null, authorLocked: false },
      // 距離でない関係は対象外
      { kind: "direction", target: "港町", targetId: "loc_0002", value: "東", chapters: [], evidence: null, authorLocked: false },
    ];
    expect(travelDistanceDismissKeysOf(record)).toEqual([
      travelDistanceDismissKey("loc_0001", "loc_0002", "馬で三日"),
      travelDistanceDismissKey("loc_0001", "loc_0004", "馬で三日"),
    ]);
    // 向きは問わず、空白や全角の揺れもそろえる
    expect(travelDistanceDismissKey("loc_0002", "loc_0001", "馬で　三日")).toBe(
      travelDistanceDismissKey("loc_0001", "loc_0002", "馬で三日")
    );
  });

  it("中止されたら、それ以上訊かない", async () => {
    const log: TravelCueAskRequest[] = [];
    const result = await runTravelCues({
      locations,
      facts,
      places,
      episodes,
      chunks,
      ask: fakeAsk(log),
      isCancelled: () => true,
    });
    expect(log).toEqual([]);
    expect(result.stats.distanceChunks).toBe(0);
  });
});
