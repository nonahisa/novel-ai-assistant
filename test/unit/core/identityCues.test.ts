import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import {
  findContradictionCandidates,
  findDwellingDrift,
  findIdentityDrift,
  type DwellingSpan,
} from "../../../src/core/contradictionMatch";
import {
  describeFactRun,
  describeFactSide,
  describeIdentityCues,
  IDENTITY_CUES_NO_DWELLINGS_NOTE,
} from "../../../src/core/factContradiction";
import {
  candidateSidesOf,
  type FactPlace,
} from "../../../src/core/factContradictionFlow";
import { afterlifeMarksFromCharacters, factsFromCharacters } from "../../../src/core/factsFromRecords";
import {
  buildIdentityLedger,
  identityChunkId,
  isIdentityChunk,
  plannedIdentityCueCalls,
  reassignMindFacts,
  registerIdentitySceneFacts,
  runIdentityCues,
  sceneMindCacheKey,
  transitionsFromDwellings,
  validateSceneMinds,
  type IdentityCueAskRequest,
  type IdentityCuesResult,
} from "../../../src/core/identityCues";
import { parseCharacter, type Character } from "../../../src/models/character";
import type { SceneIdentity } from "../../../src/models/identity";
import type { FactKind, FactModality, IdentityTransition, StoryFact } from "../../../src/models/storyFact";
import {
  SCENE_MIND_EXTRACT_SYSTEM_PROMPT,
  SCENE_MIND_EXTRACT_VERSION,
} from "../../../src/prompts/sceneMindExtract";

/**
 * 体と心の組（憑依・入れ替わり）の照合（設計書6.88.14）。
 *
 * 台は `test/fixtures/seeded/contradiction-identity/`——心と体の記録が2組ある6話。
 * **AIは呼ばない。** 事実は `facts.json`、P-53 の答えは `identityCues.json`（手で書いた
 * 正しい答えと、読み違えたときの答え）で固定し、検算・付け替え・照合だけを決まった答えで
 * 採点する（設計書6.88.11 の流し方）。
 */

const SEEDED = path.resolve(__dirname, "../../fixtures/seeded");
const FIXTURE = path.join(SEEDED, "contradiction-identity");

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

interface MindAnswer {
  file: string;
  body: string;
  mind: string;
  evidence: string;
  line: number;
  reason?: string;
}

interface TransitionAnswer {
  file: string;
  kind: string;
  body: string;
  toMind: string;
  evidence: string;
  line: number;
  reason?: string;
}

interface Answers {
  mustNotFlag: Array<{ file: string; lines?: { start: number; end: number } }>;
  episodes: Array<{ file: string; seeded: Array<{ lines: { start: number; end: number } }> }>;
}

function loadCharacters(folder: string): Character[] {
  const directory = path.join(folder, "設定", "characters");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseCharacter(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))))
    .filter((character) => !character.isMob);
}

function loadEpisodes(folder: string) {
  const files = fs
    .readdirSync(path.join(folder, "本文"))
    .sort()
    .map((name) => `本文/${name}`);
  return files.map((filePath, index) => ({
    filePath,
    chapter: index + 1,
    text: fs.readFileSync(path.join(folder, filePath), "utf8"),
  }));
}

/** 1話1チャンク（製品のチャンクと同じ形。行番号は元のファイルのまま） */
function chunksOf(episodes: ReturnType<typeof loadEpisodes>): Chunk[] {
  return episodes.map((episode) => ({
    filePath: episode.filePath,
    index: 0,
    text: episode.text,
    startLine: 0,
    chapterStart: episode.chapter,
    chapterEnd: episode.chapter,
    hash: `hash:${episode.filePath}`,
    wholeFile: true,
  }));
}

function loadFixture() {
  const read = (relative: string) => fs.readFileSync(path.join(FIXTURE, relative), "utf8");
  const characters = loadCharacters(FIXTURE);
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
    speaker: entry.modality === "dialogue" ? entry.subject : null,
    topic: null,
  }));
  const places = new Map<string, FactPlace>(
    fixed.map((entry) => [entry.id, { filePath: entry.file, line: entry.line }])
  );
  const episodes = loadEpisodes(FIXTURE);
  const chunks = chunksOf(episodes);
  const cues = JSON.parse(read("identityCues.json")) as {
    minds: MindAnswer[];
    transitions: TransitionAnswer[];
    trapMinds: MindAnswer[];
    trapTransitions: TransitionAnswer[];
  };
  const answers = JSON.parse(read("answers.json")) as Answers;
  return { characters, facts, places, episodes, chunks, cues, answers };
}

const fixture = loadFixture();
const { characters, facts, places, episodes, chunks, cues, answers } = fixture;
const chunkOf = (file: string) => chunks.find((chunk) => chunk.filePath === file) as Chunk;
const ledger = buildIdentityLedger(characters);

/** 作り物の AI：送られたチャンクの1行目でファイルを引き、そのファイルの答えを返す */
function fakeAsk(
  minds: readonly MindAnswer[],
  transitions: readonly TransitionAnswer[],
  log: IdentityCueAskRequest[] = []
) {
  return async (request: IdentityCueAskRequest) => {
    log.push(request);
    const file = chunks.find((chunk) => request.userPrompt.includes(chunk.text.split("\n")[0]))?.filePath;
    return {
      minds: minds.filter((answer) => answer.file === file),
      transitions: transitions.filter((answer) => answer.file === file),
    };
  };
}

/** 製品と同じ並び（runIdentityCues → 照合器）で候補を挙げる */
async function runLikeProduct(
  minds: readonly MindAnswer[] = cues.minds,
  transitions: readonly TransitionAnswer[] = cues.transitions
): Promise<{ result: IdentityCuesResult; flagged: FactPlace[]; candidates: ReturnType<typeof findContradictionCandidates> }> {
  const result = await runIdentityCues({
    characters,
    facts,
    places,
    episodes,
    chunks,
    ask: fakeAsk(minds, transitions),
  });
  const recordFacts = factsFromCharacters(characters);
  const allFacts = [...result.facts, ...recordFacts];
  const candidates = findContradictionCandidates({
    facts: allFacts,
    transitions: result.transitions,
    scenes: result.scenes,
    dwellings: result.dwellings,
    names: result.names,
    afterlives: afterlifeMarksFromCharacters(characters),
  });
  const factById = new Map([...allFacts, ...result.sceneFacts].map((fact) => [fact.id, fact]));
  const allPlaces = new Map([...places, ...result.scenePlaces]);
  const flagged = candidates.map((candidate) => {
    const sides = candidateSidesOf({ candidate, factById, places: allPlaces });
    if (!sides) throw new Error(`候補の両側が引けない: ${candidate.reason}`);
    return sides.place;
  });
  return { result, flagged, candidates };
}

function hits(flagged: FactPlace[], file: string, lines?: { start: number; end: number }) {
  return flagged.filter(
    (place) =>
      place.filePath === file && (!lines || (place.line >= lines.start && place.line <= lines.end))
  );
}

function scene(source: string, chapter: number, line: number, persona: string, body = "char_0001"): SceneIdentity {
  return {
    chapter,
    lineRange: [line, line],
    storyTime: null,
    triple: { bodyId: body, personaId: persona, identityId: body },
    source,
  };
}

describe("再現：製品の道では体と心の照合が働かない", () => {
  it("場面の source が事実の id でないと、candidateSidesOf が候補を黙って落とす", () => {
    const scenes = [scene("本文/001.txt:2", 1, 2, "char_0001"), scene("本文/002.txt:5", 2, 5, "char_0002")];
    const [candidate] = findIdentityDrift(scenes, []);
    expect(candidate).toBeDefined();
    // 製品の factById は事実だけで組むので、場面の source は引けない
    const factById = new Map<string, StoryFact>();
    expect(candidateSidesOf({ candidate, factById, places: new Map() })).toBeUndefined();
  });

  it("場面を表示用の事実として登録すれば、候補の両側が引ける", () => {
    const registered = registerIdentitySceneFacts([
      { bodyId: "char_0001", mindId: "char_0001", mindName: "文佳", filePath: "本文/001.txt", line: 2, chapter: 1 },
      { bodyId: "char_0001", mindId: "char_0002", mindName: "太志", filePath: "本文/002.txt", line: 5, chapter: 2 },
    ]);
    const [candidate] = findIdentityDrift(registered.scenes, []);
    const sides = candidateSidesOf({
      candidate,
      factById: new Map(registered.sceneFacts.map((fact) => [fact.id, fact])),
      places: registered.places,
    });
    expect(sides?.place).toEqual({ filePath: "本文/002.txt", line: 5 });
    expect(sides?.right.value).toBe("太志");
    expect(registered.sceneFacts.map((fact) => fact.id)).toEqual(["scene:1:2:1", "scene:2:5:1"]);
  });

  it("製品と同じ入力（場面も遷移も空）では、台の仕込み（記録の範囲の外・第三の心）に当たらない", () => {
    const candidates = findContradictionCandidates({
      facts: [...facts, ...factsFromCharacters(characters)],
      transitions: [],
      scenes: [],
      afterlives: afterlifeMarksFromCharacters(characters),
    });
    expect(candidates.filter((candidate) => candidate.predicate === "人格")).toEqual([]);
  });
});

describe("心と体の記録（AIを使わない段）", () => {
  it("宿りを体と心の id に結び、範囲を持つ", () => {
    expect(ledger.spans).toEqual([
      { bodyId: "char_0001", mindId: "char_0002", fromChapter: 2, untilChapter: 4 },
      { bodyId: "char_0003", mindId: "char_0004", fromChapter: 1, untilChapter: 2 },
    ]);
    expect([...ledger.bodies].sort()).toEqual(["char_0001", "char_0003"]);
    expect(ledger.names.get("太志")).toBe("char_0002");
    expect(ledger.names.get("密倉文佳")).toBe("char_0001");
    // 組に出てこない人物（祖母）は呼び名の表に入れない
    expect(ledger.names.get("ハツ")).toBeUndefined();
  });

  it("体の持ち主が見つからない宿りは捨てて数える", () => {
    const stray = { ...characters[1], dwellings: [{ body: "存在しない人" }] };
    const other = buildIdentityLedger([characters[0], stray]);
    expect(other.spans).toEqual([]);
    expect(other.unlinked).toBe(1);
  });

  it("汚染で体の別名に入った心の名前は、体の呼び名にしない", () => {
    const polluted = { ...characters[0], aliases: ["文佳", "太志"] };
    const other = buildIdentityLedger([polluted, ...characters.slice(1)]);
    expect(other.names.get("太志")).toBe("char_0002");
  });

  it("宿りから遷移を作る（範囲の頭に憑依、終わりの次の話に交代）", () => {
    expect(transitionsFromDwellings(ledger.spans)).toEqual([
      {
        subject: "char_0002",
        kind: "possession",
        at: { storyTime: null, chapter: 2, line: 0 },
        body: "char_0001",
        toPersona: "char_0002",
        fromDwelling: true,
      },
      {
        subject: "char_0001",
        kind: "switch",
        at: { storyTime: null, chapter: 5, line: 0 },
        body: "char_0001",
        toPersona: "char_0001",
        fromDwelling: true,
      },
      {
        subject: "char_0004",
        kind: "possession",
        at: { storyTime: null, chapter: 1, line: 0 },
        body: "char_0003",
        toPersona: "char_0004",
        fromDwelling: true,
      },
      {
        subject: "char_0003",
        kind: "switch",
        at: { storyTime: null, chapter: 3, line: 0 },
        body: "char_0003",
        toPersona: "char_0003",
        fromDwelling: true,
      },
    ]);
  });

  it("送るのは、組の人物の名前を含むチャンクだけ", () => {
    expect(chunks.every((chunk) => isIdentityChunk(chunk, ledger))).toBe(true);
    expect(isIdentityChunk({ text: "　真央は駅前で待っていた。" }, ledger)).toBe(false);
    expect(plannedIdentityCueCalls(chunks, characters)).toBe(6);
    expect(plannedIdentityCueCalls(chunks, [characters[0], characters[2], characters[4]])).toBe(0);
  });

  it("控えの鍵は版とプロバイダとモデルを持ち、チャンクの指紋は組の一覧で変わる", () => {
    expect(sceneMindCacheKey({ providerId: "ollama", model: "gemma4:e4b" })).toEqual({
      feature: "scene_mind_extract",
      promptVersion: SCENE_MIND_EXTRACT_VERSION,
      providerId: "ollama",
      model: "gemma4:e4b",
    });
    const fewer = buildIdentityLedger(characters.filter((character) => character.id !== "char_0004"));
    expect(identityChunkId(chunks[0], ledger)).not.toBe(identityChunkId(chunks[0], fewer));
  });
});

describe("P-53 の検算", () => {
  it("正しい答えは通る（場面の読み11件・本文の遷移4件）", () => {
    const readings = cues.minds.flatMap(
      (answer) => validateSceneMinds({ minds: [answer], transitions: [] }, chunkOf(answer.file), ledger).readings
    );
    expect(readings).toHaveLength(11);
    const third = readings.find((reading) => reading.filePath === "本文/002_目覚め.txt" && reading.line === 11);
    expect(third).toMatchObject({ bodyId: "char_0001", mindId: "char_0004", chapter: 2 });
    const moves = cues.transitions.flatMap(
      (answer) => validateSceneMinds({ minds: [], transitions: [answer] }, chunkOf(answer.file), ledger).transitions
    );
    expect(moves.map((move) => `${move.kind}:${move.bodyId ?? "-"}:${move.toMindId}`)).toEqual([
      "possession:char_0001:char_0002",
      "switch:char_0001:char_0002",
      "switch:char_0001:char_0001",
      "ghost:-:char_0004",
    ]);
  });

  it("読み違えの答え（identityCues.json の trapMinds・trapTransitions）はすべて捨てる", () => {
    for (const trap of cues.trapMinds) {
      const checked = validateSceneMinds({ minds: [trap], transitions: [] }, chunkOf(trap.file), ledger);
      expect(checked.readings, trap.evidence).toEqual([]);
      expect(checked.rejected.map((entry) => entry.reason), trap.evidence).toEqual([trap.reason]);
    }
    for (const trap of cues.trapTransitions) {
      const checked = validateSceneMinds({ minds: [], transitions: [trap] }, chunkOf(trap.file), ledger);
      expect(checked.transitions, trap.evidence).toEqual([]);
      expect(checked.rejected.map((entry) => entry.reason), trap.evidence).toEqual([trap.reason]);
    }
  });

  it("「分からない」は読みとして受け取るが、心は決めない", () => {
    const checked = validateSceneMinds(
      {
        minds: [{ body: "文佳", mind: "分からない", evidence: "文佳の体の太志は、笑ってごまかした", line: 3 }],
        transitions: [],
      },
      chunkOf("本文/004_別人みたい.txt"),
      ledger
    );
    expect(checked.readings).toEqual([
      expect.objectContaining({ bodyId: "char_0001", mindId: null, line: 3 }),
    ]);
  });

  it("答えの形が崩れていれば何も受け取らない", () => {
    expect(validateSceneMinds({ minds: "x" }, chunks[0], ledger).rejected).toEqual([
      { reason: "malformed", what: "mind" },
    ]);
  });
});

describe("体と心の照合器（記録の範囲で見る）", () => {
  const spans: DwellingSpan[] = [{ bodyId: "char_0001", mindId: "char_0002", fromChapter: 2, untilChapter: 4 }];

  it("範囲の中の体の持ち主と心の行き来（同居）は出さない（作者の判断②）", () => {
    const scenes = [
      scene("a", 2, 1, "char_0002"),
      scene("b", 3, 1, "char_0001"),
      scene("c", 3, 3, "char_0002"),
      scene("d", 3, 5, "char_0001"),
    ];
    expect(findDwellingDrift(scenes, [], spans)).toEqual([]);
  });

  it("範囲が切れたあとも心が体にいれば、人格が変わらなくても出す", () => {
    const scenes = [scene("a", 4, 1, "char_0002"), scene("b", 6, 6, "char_0002")];
    const [candidate] = findDwellingDrift(scenes, [], spans, new Map([["char_0001", "文佳"], ["char_0002", "太志"]]));
    expect(candidate).toMatchObject({ left: "a", right: "b", origin: "identity", type: "状態", predicate: "人格" });
    expect(candidate.reason).toContain("文佳の体に〈太志〉の心がいる");
    expect(candidate.reason).toContain("第2話から第4話");
    expect(candidate.basis).toContain("心と体の記録");
  });

  it("記録から組んだ遷移は、範囲の外を許す描写として数えない", () => {
    const scenes = [scene("a", 1, 1, "char_0001"), scene("b", 6, 6, "char_0002")];
    expect(findDwellingDrift(scenes, transitionsFromDwellings(spans), spans)).toHaveLength(1);
  });

  it("本文の遷移があれば範囲の外でも許し、同じ心が続くあいだも許す", () => {
    const text: IdentityTransition = {
      subject: "char_0002",
      kind: "possession",
      at: { storyTime: null, chapter: 6, line: 2 },
      body: "char_0001",
      toPersona: "char_0002",
    };
    const scenes = [scene("a", 6, 1, "char_0001"), scene("b", 6, 6, "char_0002"), scene("c", 7, 1, "char_0002")];
    expect(findDwellingDrift(scenes, [text], spans)).toEqual([]);
  });

  it("組に無い第三の心は出す", () => {
    const [candidate] = findDwellingDrift([scene("a", 2, 1, "char_0002"), scene("b", 2, 11, "char_0004")], [], spans);
    expect(candidate.right).toBe("b");
    expect(candidate.reason).toContain("記録に無い組");
  });

  it("記録が無ければ、これまでの findIdentityDrift のまま（既存の判定を変えない）", () => {
    const scenes = [scene("a", 3, 1, "char_0001"), scene("b", 5, 1, "char_0002")];
    expect(findContradictionCandidates({ facts: [], scenes })).toEqual(findIdentityDrift(scenes, []));
  });
});

describe("心の項目の付け替え（作者の判断⑥）", () => {
  const readingsOf = (minds: readonly MindAnswer[]) =>
    minds.flatMap(
      (answer) => validateSceneMinds({ minds: [answer], transitions: [] }, chunkOf(answer.file), ledger).readings
    );

  it("心が1人に決まる場面だけ心の側へ付け替え、決まらない場面（同居で2人）は外す", () => {
    const moved = reassignMindFacts({ facts, places, episodes, readings: readingsOf(cues.minds), ledger });
    expect([...moved.reassigned].map(([id, entry]) => `${id}>${entry.mindName}`)).toEqual([
      "fact:2:2:1>三門太志",
      "fact:2:12:1>宮下千早",
    ]);
    expect(moved.excluded).toEqual(["fact:3:2:1", "fact:3:4:1"]);
    // 事実の id と行はそのまま（飛び先を変えない）。範囲の外（第1話の「私」）は本人のまま
    const first = moved.facts.find((fact) => fact.id === "fact:2:2:1");
    expect(first).toMatchObject({ subject: "char_0002", lineRange: [2, 2] });
    expect(moved.facts.find((fact) => fact.id === "fact:1:2:1")?.subject).toBe("char_0001");
  });

  it("「分からない」と答えた場面・読みの無い場面では付け替えず外す", () => {
    const unknown = cues.minds.map((answer) =>
      answer.file === "本文/002_目覚め.txt" && answer.line === 1 ? { ...answer, mind: "分からない" } : answer
    );
    const moved = reassignMindFacts({ facts, places, episodes, readings: readingsOf(unknown), ledger });
    expect(moved.excluded).toContain("fact:2:2:1");
    const none = reassignMindFacts({ facts, places, episodes, readings: [], ledger });
    expect(none.reassigned.size).toBe(0);
    expect(none.excluded).toEqual(["fact:2:2:1", "fact:2:12:1", "fact:3:2:1", "fact:3:4:1"]);
  });

  it("付け替えた事実には、候補の根拠で分かる印が付く", () => {
    const moved = reassignMindFacts({ facts, places, episodes, readings: readingsOf(cues.minds), ledger });
    const fact = moved.facts.find((entry) => entry.id === "fact:2:2:1") as StoryFact;
    expect(describeFactSide(fact, moved.reassigned)).toBe(
      "第2話 2行目・台詞：一人称＝俺（密倉文佳の体で三門太志の心が話している場面なので、三門太志の事実として照合）"
    );
  });

  it("付け替えなければ、範囲の中の憑依の場面が文佳の一人称の食い違いになる（付け替えが要る理由）", () => {
    const candidates = findContradictionCandidates({ facts });
    expect(candidates.some((candidate) => candidate.right === "fact:2:2:1")).toBe(true);
  });
});

describe("体と心の台（手で書いた正しい答えで採点）", () => {
  it("仕込み3件にすべて当たる", async () => {
    const { flagged, candidates } = await runLikeProduct();
    const seeded = answers.episodes.flatMap((episode) =>
      episode.seeded.map((entry) => ({ file: episode.file, ...entry.lines }))
    );
    expect(seeded).toHaveLength(3);
    for (const target of seeded) {
      expect(hits(flagged, target.file, target), target.file).toHaveLength(1);
    }
    expect(candidates).toHaveLength(3);
    expect(candidates.filter((candidate) => candidate.origin === "identity")).toHaveLength(2);
  });

  it("罠6件（範囲の中の憑依・同居・幽霊の描写のある死者・回想の死者・台詞の別人・変装の偽名）には当たらない", async () => {
    const { flagged } = await runLikeProduct();
    expect(answers.mustNotFlag).toHaveLength(6);
    for (const trap of answers.mustNotFlag) {
      expect(hits(flagged, trap.file, trap.lines), trap.file).toEqual([]);
    }
  });

  it("検算を通った幽霊の遷移だけが、死亡後の登場の除外に効く", async () => {
    // 台詞の「灯、泣かないで」を根拠にした幽霊の遷移は捨てられ、千早の死亡後の登場が残る
    const withoutGhost = cues.transitions.filter((answer) => answer.kind !== "ghost");
    const trapGhost = cues.trapTransitions.filter((answer) => answer.kind === "ghost");
    const { flagged } = await runLikeProduct(cues.minds, [...withoutGhost, ...trapGhost]);
    expect(hits(flagged, "本文/005_台所.txt", { start: 6, end: 6 })).toHaveLength(1);
  });

  it("完了報告に体と心の照合の数と、記録に無い読みの案内が出る", async () => {
    const { result } = await runLikeProduct();
    expect(result.stats).toMatchObject({
      noDwellings: false,
      pairs: 2,
      chunks: 6,
      readings: 11,
      transitions: 4,
      reassignedFacts: 2,
      excludedFacts: 2,
      unrecordedTotal: 2,
      failures: 0,
    });
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
      candidateNote: "状態 3件",
      kept: 3,
      verifyNote: "",
      cancelled: false,
      identity: result.stats,
    });
    expect(line).toContain("体と心の照合（心と体の記録 2組・訊いたチャンク 6件・場面の読み 11件・本文の遷移 4件");
    expect(line).toContain("心の側へ付け替えた事実 2件");
    expect(line).toContain("心が決まらず照合から外した事実 2件");
    expect(line).toContain(
      "本文で別の心が入っている読み（第2話「その晩、文佳の体を動かしていたのは、灯に宿っているはずの千早だった」（密倉文佳の体に宮下千早の心）"
    );
    expect(line).toContain("が心と体の記録にありません");
  });

  it("送る頼みは P-53 の文面・スキーマ・控えの指紋を持つ", async () => {
    const log: IdentityCueAskRequest[] = [];
    await runIdentityCues({ characters, facts, places, episodes, chunks, ask: fakeAsk([], [], log) });
    expect(log).toHaveLength(6);
    expect(log[0].systemPrompt).toBe(SCENE_MIND_EXTRACT_SYSTEM_PROMPT);
    expect(log[0].userPrompt).toContain("- 体: 密倉文佳（別名: 文佳） ／ 宿ることがある心: 三門太志（別名: 太志）");
    expect(log[0].cacheId).toBe(identityChunkId(chunks[0], ledger));
    const schema = log[0].schema as { properties: { minds: { items: { properties: { mind: { enum: string[] } } } } } };
    expect(schema.properties.minds.items.properties.mind.enum).toContain("分からない");
  });

  it("AIが答えられなくても止めず、失敗を数える。中止されたらそれ以上訊かない", async () => {
    const failed = await runIdentityCues({
      characters, facts, places, episodes, chunks, ask: async () => undefined,
    });
    expect(failed.stats.failures).toBe(6);
    let asked = 0;
    await runIdentityCues({
      characters, facts, places, episodes, chunks,
      ask: async () => {
        asked += 1;
        return undefined;
      },
      isCancelled: () => asked >= 2,
    });
    expect(asked).toBe(2);
  });
});

describe("心と体の記録が無い作品（作者の判断①）", () => {
  it("AIを呼ばず、事実はそのまま返し、案内を出す", async () => {
    let asked = 0;
    const result = await runIdentityCues({
      characters: characters.map(({ dwellings: _dwellings, ...rest }) => rest),
      facts,
      places,
      episodes,
      chunks,
      ask: async () => {
        asked += 1;
        return {};
      },
    });
    expect(asked).toBe(0);
    expect(result.stats.noDwellings).toBe(true);
    expect(result.facts).toEqual(facts);
    expect(result.scenes).toEqual([]);
    expect(describeIdentityCues(result.stats)).toBe(IDENTITY_CUES_NO_DWELLINGS_NOTE);
  });

  /** 既存の3台は宿りを持たないので、体と心の段を足しても決まった答えの採点は変わらない */
  it.each(["contradiction", "contradiction-travel", "contradiction-travel-ai"])(
    "既存の台 %s は宿りが無く、事実も候補も変わらない",
    async (name) => {
      const folder = path.join(SEEDED, name);
      const people = loadCharacters(folder);
      expect(people.some((person) => (person.dwellings ?? []).length > 0)).toBe(false);
      const sample: StoryFact[] = facts.slice(0, 3);
      const result = await runIdentityCues({
        characters: people,
        facts: sample,
        places,
        episodes: loadEpisodes(folder),
        chunks: chunksOf(loadEpisodes(folder)),
        ask: async () => {
          throw new Error("呼ばれてはいけない");
        },
      });
      expect(result.stats.noDwellings).toBe(true);
      expect(result.facts).toEqual(sample);
      expect(result.dwellings).toEqual([]);
      expect(result.transitions).toEqual([]);
    }
  );
});
