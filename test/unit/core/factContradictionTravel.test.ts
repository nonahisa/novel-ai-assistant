import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findContradictionCandidates } from "../../../src/core/contradictionMatch";
import {
  describeFactRun,
  type FactRunSummary,
} from "../../../src/core/factContradiction";
import {
  buildTravelMaterial,
  type FactPlace,
} from "../../../src/core/factContradictionFlow";
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
