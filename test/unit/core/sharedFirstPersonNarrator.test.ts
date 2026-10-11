import { describe, expect, test } from "vitest";
import {
  foreignNarrationScenes,
  workNarratorContextOf,
  type WorkNarratorContext,
} from "../../../src/core/sceneNarrators";
import { findNarratorMoves } from "../../../src/core/narratorMoves";
import { validateCharacterExtractResult } from "../../../src/core/characterExtractionValidation";
import { mergeExtractedCharacters } from "../../../src/core/characterMerge";
import type { CharacterExtractResult, ExtractedCharacter } from "../../../src/prompts/characterExtract";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";
import type { Chunk } from "../../../src/core/chunker";
import {
  describeSharedFirstPersonNotices,
  findSharedFirstPersonNotices,
} from "../../../src/core/sharedFirstPersonNotice";

/**
 * **主人公と同じ一人称の脇役が語る場面**の動き（0.102.12 で調べ、0.102.14 で
 * 知らせを足した。作者の裁定 2026-10-11「案B：知らせるだけ」。設計書6.5.12）。
 *
 * 6.5.12 は場面の語り手を**地の文の一人称**で見分ける。主人公（春人、地の文
 * 「僕」）と同じ「僕」で脇役（健太）が語る場面は、一人称では見分けがつかない。
 *
 * **値の扱いは 0.102.12 のまま変えない**（自動では寄せも外しもしない）。
 * 変えたのは、抽出の完了報告と `novel.extract.commit` の結果に
 * 「第N話は、主人公へ入った値に語り手の取り違えの可能性があります」と
 * 知らせることだけ（`core/sharedFirstPersonNotice.ts`）。
 *
 * 動きは2つの場合に分かれる：
 *
 * - **脇役の「僕」が台帳に入っている**：`detectNarrator` は「僕」の持ち主が2人で
 *   語り手を決めない（null）。6.5.12 の歯止めは作品全体で働かない。名無しの「僕」の
 *   答えはどこにも寄せず、完了報告で名指しする（安全側）。名前で返った答えは
 *   AI の読みのまま入る——**入った話を知らせる**（条件1）
 * - **脇役の「僕」が台帳に無い**：主人公が語り手に決まり、脇役の場面は主人公の
 *   場面として扱われる。名無しの「僕」の答えは**コードが主人公へ寄せる**
 *   （`placeUnnamedNarrator`）。移す案にも出ない——**その話の「僕」の場面の地の文に
 *   主人公の名前が主語として出ていれば、知らせる**（条件2）
 */

function person(id: string, name: string, firstPerson: string | null): Character {
  return {
    ...emptyCharacter(id, name),
    firstPerson: { default: firstPerson, variants: [] },
  };
}

const HARUTO = person("char_001", "春人", "僕");
const KENTA_WITH_BOKU = person("char_002", "健太", "僕");
const KENTA_WITHOUT = person("char_002", "健太", null);

/** 主人公の場面（地の文の「僕」）。語り手が決まる数を満たすよう長めに */
const HARUTO_SCENE = Array.from(
  { length: 14 },
  (_, index) =>
    `　僕は${index + 1}枚目の答案を見直した。数字が合わない。僕は鉛筆を置き、窓の外の雨をしばらく眺めていた。`
).join("\n");

/** 脇役（健太）が「僕」で語る場面。地の文に主人公の名前が三人称で出る */
const KENTA_SCENE =
  "　僕は体育館の裏で待っていた。春人は約束の時間に遅れてきた。\n" +
  "　春人が謝る前に、僕は封筒を差し出した。春人は黙って受け取った。\n" +
  "「これで最後だからな」\n";

function chunkOf(text: string, chapter: number): Chunk {
  return {
    filePath: `本文/${chapter}_話.txt`,
    index: 0,
    text,
    startLine: 0,
    hash: `h${chapter}`,
    chapterStart: chapter,
    chapterEnd: chapter,
  };
}

function answerOf(character: Partial<ExtractedCharacter>): CharacterExtractResult {
  return {
    characters: [
      {
        name: "春人",
        entityType: "person",
        summary: "体育館の裏で封筒を渡す",
        relations: [],
        ...character,
      } as ExtractedCharacter,
    ],
  };
}

const WORK_TEXT = `${HARUTO_SCENE}\n${KENTA_SCENE}`;

/** 作品の話（第1話は主人公の場面、第3話は脇役の場面） */
const EPISODES = [
  { chapter: 1, text: HARUTO_SCENE },
  { chapter: 3, text: KENTA_SCENE },
];

/** 検算 → マージを通し、知らせまで出す（製品と MCP が通る順） */
function extractAndNotice(
  people: Character[],
  answer: CharacterExtractResult,
  chunk: Chunk,
  context: WorkNarratorContext | null
) {
  const validated = validateCharacterExtractResult(answer, chunk, {
    knownRecordNames: ["春人", "健太"],
    workNarrator: context,
  });
  const merged = mergeExtractedCharacters(
    people,
    validated.accepted.map((entry) => ({
      data: entry.data,
      chapters: entry.chapters,
      unnamedNarrator: entry.unnamedNarrator,
    }))
  );
  const notices = findSharedFirstPersonNotices({
    workBodyText: WORK_TEXT,
    people: merged.characters,
    landed: merged.landed,
    episodes: EPISODES,
  });
  return { validated, merged, notices };
}

const NOTICE_3 =
  "第3話は、主人公へ入った値に語り手の取り違えの可能性があります（主人公と同じ一人称「僕」を使う人物がいるため）";

describe("脇役の「僕」が台帳に入っているとき", () => {
  test("語り手が決まらず、6.5.12 の歯止めは作品全体で働かない", () => {
    expect(workNarratorContextOf(WORK_TEXT, [HARUTO, KENTA_WITH_BOKU])).toBeNull();
  });

  test("名無しの「僕」の答えは、どこへも寄せずに名指しで報告する（安全側）", () => {
    const validated = validateCharacterExtractResult(
      answerOf({ name: "僕", firstPerson: "僕", evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      { knownRecordNames: ["春人", "健太"] }
    );
    expect(validated.accepted).toHaveLength(1);
    expect(validated.accepted[0].unnamedNarrator).toEqual({ firstPerson: "僕" });

    const merged = mergeExtractedCharacters(
      [HARUTO, KENTA_WITH_BOKU],
      validated.accepted.map((entry) => ({
        data: entry.data,
        chapters: entry.chapters,
        unnamedNarrator: entry.unnamedNarrator,
      }))
    );
    expect(merged.updated).toEqual([]);
    expect(merged.unplacedNarrators).toEqual([{ firstPerson: "僕", candidates: ["春人", "健太"] }]);
  });

  test("名前で返った答えは AI の読みのまま入り、入った話を知らせる（条件1）", () => {
    const { merged, notices } = extractAndNotice(
      [HARUTO, KENTA_WITH_BOKU],
      answerOf({ evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      null
    );
    // 値の扱いは 0.102.12 のまま（寄せも外しもしない）
    expect(merged.updated).toEqual(["春人"]);
    expect(notices.map((notice) => notice.chapter)).toEqual([3]);
    expect(notices[0].reason).toBe("shared_owner");
    expect(describeSharedFirstPersonNotices(notices)).toEqual([NOTICE_3]);
  });

  test("どこにも入らなかった名無しの「僕」では知らせない（入った値が無い）", () => {
    const { notices } = extractAndNotice(
      [HARUTO, KENTA_WITH_BOKU],
      answerOf({ name: "僕", firstPerson: "僕", evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      null
    );
    expect(notices).toEqual([]);
  });

  test("同じ答えをもう一度通しても、新しく入る値が無ければ知らせない", () => {
    const first = extractAndNotice(
      [HARUTO, KENTA_WITH_BOKU],
      answerOf({ evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      null
    );
    const second = extractAndNotice(
      first.merged.characters,
      answerOf({ evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      null
    );
    expect(second.merged.landed).toEqual([]);
    expect(second.notices).toEqual([]);
  });
});

describe("脇役の「僕」が台帳に無いとき（値は主人公へ入り、知らせる）", () => {
  const context = workNarratorContextOf(WORK_TEXT, [HARUTO, KENTA_WITHOUT]) as WorkNarratorContext;

  test("主人公が語り手に決まり、脇役の場面は主人公の場面と区別されない", () => {
    expect(context?.narrator).toEqual({ firstPerson: "僕", name: "春人" });
    expect(foreignNarrationScenes(KENTA_SCENE, "僕")).toEqual([]);
  });

  test("脇役の場面を根拠にした主人公の答えは、そのまま通る", () => {
    const validated = validateCharacterExtractResult(
      answerOf({ firstPerson: "僕", evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      { knownRecordNames: ["春人", "健太"], workNarrator: context }
    );
    expect(validated.accepted).toHaveLength(1);
    expect(validated.rejected).toEqual([]);
  });

  test("名無しの「僕」の答えは、コードが主人公へ寄せる", () => {
    const validated = validateCharacterExtractResult(
      answerOf({ name: "僕", firstPerson: "僕", evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      { knownRecordNames: ["春人", "健太"], workNarrator: context }
    );
    const merged = mergeExtractedCharacters(
      [HARUTO, KENTA_WITHOUT],
      validated.accepted.map((entry) => ({
        data: entry.data,
        chapters: entry.chapters,
        unnamedNarrator: entry.unnamedNarrator,
      }))
    );
    expect(merged.updated).toEqual(["春人"]);
    expect(merged.unplacedNarrators).toEqual([]);
  });

  test("脇役の場面から主人公へ値が入った話を知らせる（条件2：地の文の主語に主人公の名前）", () => {
    const { merged, notices } = extractAndNotice(
      [HARUTO, KENTA_WITHOUT],
      answerOf({ name: "僕", firstPerson: "僕", evidence: "僕は封筒を差し出した" }),
      chunkOf(KENTA_SCENE, 3),
      context
    );
    // 値の扱いは 0.102.12 のまま（主人公へ寄せる）
    expect(merged.updated).toEqual(["春人"]);
    expect(notices.map((notice) => [notice.chapter, notice.reason])).toEqual([[3, "name_subject"]]);
    expect(describeSharedFirstPersonNotices(notices)).toEqual([NOTICE_3]);
  });

  test("主人公の場面（地の文に主人公の名前が出ない話）から入った値では知らせない", () => {
    const { merged, notices } = extractAndNotice(
      [HARUTO, KENTA_WITHOUT],
      answerOf({
        summary: "答案を見直す",
        firstPerson: "僕",
        evidence: "僕は1枚目の答案を見直した",
      }),
      chunkOf(HARUTO_SCENE, 1),
      context
    );
    expect(merged.updated).toEqual(["春人"]);
    expect(notices).toEqual([]);
  });

  test("入った値は移す案にも出ない（ほかの語り手の場面だけの話と数えない）", () => {
    const change: RecordChange = {
      field: "summary",
      value: "体育館の裏で封筒を渡す",
      chapters: [3],
      timepointId: null,
      note: null,
      evidence: "僕は封筒を差し出した",
      source: "extracted",
    };
    const contaminated: Character = {
      ...HARUTO,
      changes: [change],
      appearedChapters: [1, 3],
    };
    const moves = findNarratorMoves(contaminated, { ...context, people: [contaminated, KENTA_WITHOUT] }, [
      { label: "第1話", text: HARUTO_SCENE, chapter: 1 },
      { label: "第3話", text: KENTA_SCENE, chapter: 3 },
    ]);
    expect(moves).toEqual([]);
  });
});
