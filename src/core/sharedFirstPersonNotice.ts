import type { Character } from "../models/character";
import type { MergeResult } from "./characterMerge";
import { firstPersonOwners } from "./narrator";
import { narratorNameSubjectPattern } from "./narratorNamePattern";
import { narratorNameForms } from "./narratorNameSlip";
import { maskQuoted } from "./quotedSpans";
import { sceneRanges } from "./sceneBreaks";
import { blankMemoLines } from "./sceneMemo";
import { FOREIGN_SCENE_MIN_FIRST_PERSON } from "./sceneNarrators";
import { detectFirstPerson, narrationFirstPersonOf } from "./workStyleFacts";

/**
 * **主人公と同じ一人称の脇役が語る場面**から、主人公の資料へ値が入ったかも
 * しれない話を知らせる（作者の裁定 2026-10-11「案B：知らせるだけ」。設計書6.5.12）。
 *
 * 6.5.12 は場面の語り手を地の文の一人称で見分けるので、主人公と同じ「僕」で
 * 脇役が語る場面は見分けられない。**値は自動では寄せも外しもしない**（作者の
 * データ。どちらへ直すかはコードには決められない）。抽出の完了報告と
 * `novel.extract.commit` の結果に、疑わしい話を名指しするだけである。
 *
 * 知らせるのは次のどちらかで、**その話から主人公へ値が新しく入ったとき**だけ
 * （`MergeResult.landed`。キャッシュの答えを通し直しただけの回は黙る）。
 *
 * 1. **主人公と同じ一人称を持つ人物が台帳にいる**（持ち主が2人以上で、
 *    `detectNarrator` が語り手を決めない作品）。どれが主人公かはコードに
 *    決められないので、その一人称の持ち主のどれかへ値が入った話を知らせる
 * 2. **持ち主が主人公1人だけ**で、その話の「主人公の一人称で語られる場面」の
 *    地の文に、主人公の名前が主語として出る（「春人は約束の時間に遅れてきた」）。
 *    脇役が「僕」で語ると、主人公は三人称で出てくるため。材料は人称のよじれ
 *    （`narratorNameSlip.ts`）と同じ名前の形・同じ主語の見分け方
 *
 * **作者の書き方と読める作品では黙る。** 条件2の手がかりは、人称のよじれの
 * 「多ければ作者の文体」（三人称の地の文に心の声の「僕」が混じる書き方）と
 * 同じものを見る。そういう作品では主人公の名前がほとんどの話で主語に立つので、
 * 主人公の一人称の場面を持つ話のうち、名前が主語に立つ話が**半分を超える**なら
 * 書き方とみて、作品ごと知らせない。脇役が語る話は作品の中の例外のはずである。
 *
 * VS Code に依存しない（製品と MCP の両方が同じ関数を呼ぶ）。
 */

/** 知らせ1件（1話ぶん） */
export interface SharedFirstPersonNotice {
  /** 値が入った話 */
  chapter: number;
  /** 主人公と同じ一人称（「僕」） */
  firstPerson: string;
  /**
   * shared_owner: 同じ一人称の人物が台帳にいる（条件1）
   * name_subject: その話の地の文に主人公の名前が主語として出る（条件2）
   */
  reason: "shared_owner" | "name_subject";
  /** 値が入った人物 */
  characterName: string;
}

/** 話ごとの本文（`ExcerptSource` の形をそのまま受ける。話数が無いものは見ない） */
export interface NoticeEpisode {
  chapter?: number | null;
  text: string;
}

export function findSharedFirstPersonNotices(input: {
  /** 全話を繋いだ本文（シーンメモは空にしたもの。`workNarratorContextOf` と同じ） */
  workBodyText: string;
  /** マージしたあとの人物（今回の抽出で増えた一人称も数える） */
  people: readonly Character[];
  /** 今回のマージで値が入った人物と話数（`MergeResult.landed`） */
  landed: MergeResult["landed"];
  /** 作品の話ごとの本文（条件2の手がかりを探す） */
  episodes: readonly NoticeEpisode[];
}): SharedFirstPersonNotice[] {
  if (input.landed.length === 0) return [];
  // 語り手の一人称の数え方は `detectNarrator` と同じ（10回未満・6割未満なら決めない）
  const firstPerson = detectFirstPerson(input.workBodyText);
  if (!firstPerson) return [];
  const owners = firstPersonOwners(input.people, firstPerson);
  if (owners.length === 0) return [];

  if (owners.length >= 2) {
    const ownerSet = new Set(owners);
    return collect(
      input.landed.filter((entry) => ownerSet.has(entry.characterName)),
      firstPerson,
      "shared_owner"
    );
  }

  const narrator = { firstPerson, name: owners[0] };
  const landedOnNarrator = input.landed.filter((entry) => entry.characterName === narrator.name);
  if (landedOnNarrator.length === 0) return [];
  const forms = narratorNameForms(narrator, input.people);
  if (forms.length === 0) return [];
  const pattern = narratorNameSubjectPattern(forms);

  const byChapter = new Map<number, ChapterLook>();
  for (const episode of input.episodes) {
    const chapter = episode.chapter;
    if (typeof chapter !== "number" || !Number.isSafeInteger(chapter)) continue;
    const look = lookAtEpisode(episode.text, firstPerson, pattern);
    const before = byChapter.get(chapter);
    byChapter.set(chapter, {
      narrated: (before?.narrated ?? false) || look.narrated,
      nameSubject: (before?.nameSubject ?? false) || look.nameSubject,
    });
  }
  const narrated = [...byChapter.values()].filter((look) => look.narrated);
  const named = narrated.filter((look) => look.nameSubject);
  // 半分を超える話で名前が主語に立つなら、作者の書き方とみて黙る（上の断り書き）
  if (narrated.length >= 2 && named.length * 2 > narrated.length) return [];

  return collect(
    landedOnNarrator.map((entry) => ({
      ...entry,
      chapters: entry.chapters.filter((chapter) => byChapter.get(chapter)?.nameSubject === true),
    })),
    firstPerson,
    "name_subject"
  );
}

interface ChapterLook {
  /** 主人公の一人称で語られる場面がある */
  narrated: boolean;
  /** その場面の地の文に、主人公の名前が主語として出る */
  nameSubject: boolean;
}

/**
 * 1話の本文を場面に割り、主人公の一人称で語られる場面の地の文に名前が
 * 主語として出るかを見る。**場面で見る**——三人称の場面に主人公の名前が
 * 出るのは当たり前なので、そこは数えない。
 */
function lookAtEpisode(text: string, firstPerson: string, pattern: RegExp): ChapterLook {
  // シーンメモは本文ではない。行は消さずに空にする（場面の区切りの位置を保つ）
  const body = blankMemoLines(text);
  const lines = body.split("\n");
  // 台詞は入れ子を数えて伏せる（人称のよじれと同じ。`quotedSpans.ts`）
  const masked = maskQuoted(body, "　").split("\n");
  const look: ChapterLook = { narrated: false, nameSubject: false };
  for (const scene of sceneRanges(lines)) {
    const sceneText = lines.slice(scene.start, scene.end).join("\n");
    const found = narrationFirstPersonOf(sceneText, FOREIGN_SCENE_MIN_FIRST_PERSON);
    if (!found || found.word !== firstPerson) continue;
    look.narrated = true;
    for (let index = scene.start; index < scene.end; index++) {
      const line = masked[index] ?? "";
      // 見出しは地の文ではない
      if (/^\s*#/u.test(line)) continue;
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        look.nameSubject = true;
        return look;
      }
    }
  }
  return look;
}

function collect(
  entries: MergeResult["landed"],
  firstPerson: string,
  reason: SharedFirstPersonNotice["reason"]
): SharedFirstPersonNotice[] {
  const notices: SharedFirstPersonNotice[] = [];
  for (const entry of entries) {
    for (const chapter of entry.chapters) {
      // 同じ話は1件にまとめる（知らせは話ごと。誰に入ったかは最初の1人で足りる）
      if (notices.some((notice) => notice.chapter === chapter)) continue;
      notices.push({ chapter, firstPerson, reason, characterName: entry.characterName });
    }
  }
  return notices.sort((left, right) => left.chapter - right.chapter);
}

/** 知らせの文で名指しする話の数（それより多い分は「ほかN話」にまとめる） */
const MAX_LISTED_CHAPTERS = 5;

/**
 * 作者へ見せる文（一人称ごとに1文）。
 *
 * **話が多いときは1文にまとめる。** 完了の知らせは数行しか読まれないので、
 * 話ごとに1行ずつ並べない。名指しは5話までで、残りは件数だけ言う。
 */
export function describeSharedFirstPersonNotices(
  notices: readonly SharedFirstPersonNotice[]
): string[] {
  const byFirstPerson = new Map<string, number[]>();
  for (const notice of notices) {
    const chapters = byFirstPerson.get(notice.firstPerson) ?? [];
    if (!chapters.includes(notice.chapter)) chapters.push(notice.chapter);
    byFirstPerson.set(notice.firstPerson, chapters);
  }
  const sentences: string[] = [];
  for (const [firstPerson, chapters] of byFirstPerson) {
    const sorted = [...chapters].sort((left, right) => left - right);
    const listed = sorted.slice(0, MAX_LISTED_CHAPTERS).map((chapter) => `第${chapter}話`);
    const rest = sorted.length - listed.length;
    sentences.push(
      `${listed.join("・")}${rest > 0 ? `ほか${rest}話` : ""}は、` +
        "主人公へ入った値に語り手の取り違えの可能性があります" +
        `（主人公と同じ一人称「${firstPerson}」を使う人物がいるため）`
    );
  }
  return sentences;
}
