import { describe, expect, test } from "vitest";
import {
  describeSharedFirstPersonNotices,
  findSharedFirstPersonNotices,
  type SharedFirstPersonNotice,
} from "../../../src/core/sharedFirstPersonNotice";
import { emptyCharacter, type Character } from "../../../src/models/character";

/**
 * 主人公と同じ一人称の脇役の知らせ（作者の裁定 2026-10-11「案B：知らせるだけ」。
 * 設計書6.5.12）の、出しすぎない線。抽出からの通し方は
 * `sharedFirstPersonNarrator.test.ts` が見ている。
 */

function person(id: string, name: string, firstPerson: string | null): Character {
  return { ...emptyCharacter(id, name), firstPerson: { default: firstPerson, variants: [] } };
}

const HARUTO = person("char_001", "春人", "僕");
const KENTA = person("char_002", "健太", null);

/** 主人公の「僕」の話（名前は主語に出ない） */
function plainEpisode(chapter: number): string {
  return Array.from(
    { length: 10 },
    (_, index) => `　僕は第${chapter}話の${index + 1}枚目の答案を見直した。僕は鉛筆を置き、窓の外の雨を眺めていた。`
  ).join("\n");
}

/** 「僕」の地の文に主人公の名前が主語で出る話（脇役の語り、または作者の書き方） */
function namedEpisode(chapter: number): string {
  return (
    `　僕は第${chapter}話の体育館の裏で待っていた。春人は約束の時間に遅れてきた。\n` +
    "　春人が謝る前に、僕は封筒を差し出した。僕は黙って空を見た。\n"
  );
}

function noticesOf(
  episodes: Array<{ chapter: number; text: string }>,
  landedChapters: number[]
): SharedFirstPersonNotice[] {
  return findSharedFirstPersonNotices({
    workBodyText: episodes.map((episode) => episode.text).join("\n"),
    people: [HARUTO, KENTA],
    landed: [{ characterId: HARUTO.id, characterName: "春人", chapters: landedChapters }],
    episodes,
  });
}

describe("条件2（持ち主が主人公1人）の出しすぎない線", () => {
  test("名前が主語に立つ話が作品の例外なら、その話だけを知らせる", () => {
    const episodes = [
      { chapter: 1, text: plainEpisode(1) },
      { chapter: 2, text: plainEpisode(2) },
      { chapter: 3, text: namedEpisode(3) },
    ];
    expect(noticesOf(episodes, [1, 2, 3]).map((notice) => notice.chapter)).toEqual([3]);
  });

  test("その話から主人公へ値が入っていなければ、名前が主語に立っても知らせない", () => {
    const episodes = [
      { chapter: 1, text: plainEpisode(1) },
      { chapter: 2, text: plainEpisode(2) },
      { chapter: 3, text: namedEpisode(3) },
    ];
    expect(noticesOf(episodes, [1, 2])).toEqual([]);
  });

  test("半分を超える話で名前が主語に立つ作品は、作者の書き方とみて黙る", () => {
    const episodes = [
      { chapter: 1, text: plainEpisode(1) },
      { chapter: 2, text: namedEpisode(2) },
      { chapter: 3, text: namedEpisode(3) },
      { chapter: 4, text: plainEpisode(4) + "\n" + namedEpisode(4) },
    ];
    expect(noticesOf(episodes, [1, 2, 3, 4])).toEqual([]);
  });

  test("台詞の中の名前は数えない", () => {
    const quoted =
      "　僕は体育館の裏で待っていた。「春人は来ないよ」と誰かが言った。\n" +
      "　僕は封筒を握りしめた。僕は空を見上げた。\n";
    const episodes = [
      { chapter: 1, text: plainEpisode(1) },
      { chapter: 2, text: plainEpisode(2) },
      { chapter: 3, text: quoted },
    ];
    expect(noticesOf(episodes, [3])).toEqual([]);
  });
});

describe("知らせの文", () => {
  test("話が6つ以上なら5話まで名指しし、残りは件数でまとめる", () => {
    const notices = [1, 2, 3, 4, 5, 6, 7].map(
      (chapter): SharedFirstPersonNotice => ({
        chapter,
        firstPerson: "僕",
        reason: "shared_owner",
        characterName: "春人",
      })
    );
    expect(describeSharedFirstPersonNotices(notices)).toEqual([
      "第1話・第2話・第3話・第4話・第5話ほか2話は、主人公へ入った値に語り手の取り違えの可能性があります（主人公と同じ一人称「僕」を使う人物がいるため）",
    ]);
  });

  test("知らせが無ければ文も無い", () => {
    expect(describeSharedFirstPersonNotices([])).toEqual([]);
  });
});
