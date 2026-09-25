import type { Character } from "../models/character";
import { detectNarrator, type NarratorHint } from "./narrator";
import { VIEWPOINT_INTENT_NOTE } from "./proofreadValidation";
import { maskQuoted } from "./quotedSpans";
import { sceneRanges, type SceneRange } from "./sceneBreaks";
import { blankMemoLines } from "./sceneMemo";
import { countNarrationFirstPersons } from "./workStyleFacts";

/**
 * 一人称の作品で、**語り手の名前が地の文に三人称で出ている所**を探す
 * （2026-09-25、人称のよじれ。設計書6.9.2）。
 *
 * 「俺」で語っている作品に「相沢は損をしたのだと思った」と書くと、その一文だけ
 * 三人称の語りに切り替わって読める。2026-09-24 の測定では、**矛盾検知も推敲も
 * これを拾わなかった**——どちらのAIにも「一人称の作品で、語り手の名前が
 * 地の文の主語に立つ」という観点が無い。
 *
 * **これはコードで数えられる。** 語り手が誰か（`narrator.ts`）と、その名前の形が
 * 分かれば、地の文（「」の外）で「名前＋は／が／も」になっている所を
 * 探せばよい。AIを呼ばないので処理量はかからない。
 *
 * **分からないときは黙る（誤検出を避ける）。** 出すのは次の全部が揃ったときだけ。
 *
 * 1. 作品全体で語り手が1人に決まる（`detectNarrator`。一人称が人物1人に結び付く）
 * 2. **その話も**、その一人称で語られている（多視点の作品で、千夏の「私」の章に
 *    出る「春人は」を拾わないため）。**さらに場面ごとに**確かめ、場面の区切り
 *    （「◆◇◆◇」「＊＊＊」。`sceneBreaks.ts`）の後の三人称の場面は見ない
 *    （2026-09-25 の2回目）。割合を見るときは、**よじれの候補を語り手の一人称として
 *    数え直す**（よじれ自身が一人称を1つ減らすため。`narratorShareHolds`）
 * 3.名前の形が、ほかの人物の名前・別名と重ならない（兄妹で同じ苗字なら苗字は見ない）
 * 4. 見つかった数が、その話の一人称の数に比べて少ない（多ければ、三人称の地の文に
 *    心の声の「俺」が混じる書き方なので、よじれではなく作者の文体である）
 *
 * VS Code に依存しない（製品と MCP の両方が同じ関数を呼ぶ）。
 */

/** その話の地の文に、語り手の一人称が最低これだけ出ていること */
const MIN_EPISODE_FIRST_PERSON_HITS = 3;
/** その話の地の文の一人称のうち、語り手のものが占める割合（場面ごとにも同じ割合を見る） */
const MIN_EPISODE_FIRST_PERSON_SHARE = 0.6;
/**
 * 1つの場面の地の文に、語り手の一人称が最低これだけ出ていること。
 *
 * 話全体（3回）より緩いのは、場面が短いから。**1回では決めない**——三人称の
 * 場面の地の文にも、心の声の「俺」が1つ混じることはある。
 */
const MIN_SCENE_FIRST_PERSON_HITS = 2;
/**
 * 一人称の数に対して、名前の出てよい数（この割合を超えたら黙る）。
 *
 * **よじれは「たまに混ざる」もの**で、1話に1〜2か所が普通である。
 * 一人称5回につき1回より多く名前が主語に立つなら、それは三人称の地の文に
 * 心の声の「俺」が混じる書き方（自由間接話法）であって、直すものではない。
 * 1か所だけなら、一人称が少ない話でも出す。
 */
const FIRST_PERSON_PER_SLIP = 5;

export interface NarratorNameSlip {
  /** 渡した本文の何行目か（1始まり） */
  line: number;
  /** 本文に実在する範囲（「相沢は」）。提案パネルはこの文字列を行から探す */
  original: string;
  /**
   * 一人称に置き換えた形（「俺は」）。
   *
   * **同じ行に同じ範囲が2か所あれば空にする。** 適用は行の中の最初の一致へ
   * 当たるので（`proofreadValidation.ts` の `isAmbiguousInLine`）、台詞の中の
   * 「相沢は」が先にあると、そちらが書き換わる。
   */
  suggestion: string;
  /** 地の文に出た名前の形（「相沢」） */
  nameForm: string;
  /** 語り手（一人称と、その人物の名前） */
  narrator: NarratorHint;
}

/** 探さなかった理由。**黙った理由を操作ログへ残す**ために返す */
export type NarratorSlipSkip =
  /** その話の地の文が、語り手の一人称で語られていない */
  | "not_narrator_episode"
  /** 見るべき名前の形が無い（ほかの人物と重なる・1字しか無い） */
  | "no_name_form"
  /** 見つかった数が多すぎる（作者の書き方とみて出さない） */
  | "too_many";

/**
 * 作品全体から語り手を決める。**決め方は矛盾検知と同じ**（`detectNarrator`）。
 *
 * 1話だけでは一人称の数が足りない（台の第1話は「俺」が9回で、決める下限の
 * 10回に届かない）ので、**全話を繋いだ本文**を渡すこと。
 */
export function resolveWorkNarrator(
  workBodyText: string,
  people: readonly Character[]
): NarratorHint | null {
  return detectNarrator({ narrationText: workBodyText, people });
}

/**
 * 地の文で探す、語り手の名前の形。長いものから並べる。
 *
 * - 正式名称そのまま（「相沢 春人」）と、空白を詰めた形（「相沢春人」）
 * - 空白・中黒で割った各部分（「相沢」「春人」）
 * - 別名のうち、**正式名称の一部であるもの**（「春人」）。あだ名（「兄貴」
 *   「部長」）は普通名詞として地の文に出るので見ない
 *
 * **1字の形は見ない**（「楓は」が木の話であることがある）。
 * **ほかの人物と同じ形は見ない**（兄妹の苗字。どちらの話か決められない）。
 */
export function narratorNameForms(
  narrator: NarratorHint,
  people: readonly Character[]
): string[] {
  const own = people.filter((person) => person.name.trim() === narrator.name);
  const others = people.filter((person) => person.name.trim() !== narrator.name);

  const forms = new Set<string>();
  for (const person of own) {
    for (const form of formsOf(person, true)) forms.add(form);
  }
  const taken = new Set<string>();
  for (const person of others) {
    for (const form of formsOf(person, false)) taken.add(form);
  }

  return [...forms]
    .filter((form) => Array.from(form).length >= 2)
    .filter((form) => !taken.has(form))
    .sort((left, right) => right.length - left.length);
}

function formsOf(person: Character, onlyNameParts: boolean): string[] {
  const full = person.name.trim();
  if (!full) return [];
  const compact = full.replace(/[\s　・･]+/gu, "");
  const parts = full.split(/[\s　・･]+/u).filter(Boolean);
  const forms = [full, compact, ...parts];
  for (const alias of person.aliases ?? []) {
    const trimmed = alias.trim();
    if (!trimmed) continue;
    // 語り手の側は「名前の一部」の別名だけ。ほかの人物の側は、別名を全部
    // 「取られている形」として数える（重なれば黙る側へ倒す）
    if (onlyNameParts && !compact.includes(trimmed.replace(/[\s　]+/gu, ""))) {
      continue;
    }
    forms.push(trimmed);
  }
  return forms;
}

/**
 * 1話ぶんの本文から、語り手の名前が地の文の主語に立つ所を探す。
 *
 * @param text その話の本文（ファイル全体でも、合本から切り出した1話でもよい）
 */
export function findNarratorNameSlips(options: {
  text: string;
  narrator: NarratorHint;
  people: readonly Character[];
}): { slips: NarratorNameSlip[]; skipped?: NarratorSlipSkip } {
  const { narrator } = options;
  // シーンメモは本文ではない。**行は消さずに空にする**（行番号を保つ）
  const body = blankMemoLines(options.text);
  const rawLines = body.split("\n");

  const forms = narratorNameForms(narrator, options.people);
  const pattern = forms.length > 0 ? slipPattern(forms) : null;
  // 台詞は**入れ子を数えて**伏せる（`quotedSpans.ts`）。「…『死の谷』…」の』で
  // 台詞が閉じたと見ると、残りの台詞を地の文として拾う（教科書チート18話）
  const maskedLines = maskQuoted(body, "　").split("\n");
  /** 行の範囲にある、よじれの候補の数（語り手の判定で一人称として数え直す分） */
  const candidatesIn = (start: number, end: number): number => {
    if (!pattern) return 0;
    let found = 0;
    for (let index = start; index < end; index++) {
      const masked = maskedLines[index] ?? "";
      if (/^\s*#/u.test(masked)) continue;
      for (const _ of masked.matchAll(pattern)) found += 1;
    }
    return found;
  };

  // **その話が、本当にその語り手の一人称で語られているか。** 多視点の作品で、
  // 千夏の「私」の章に出る「春人は」は、よじれではない
  const counts = countNarrationFirstPersons(body);
  const hits = counts.get(narrator.firstPerson) ?? 0;
  let total = 0;
  for (const count of counts.values()) total += count;
  if (
    hits < MIN_EPISODE_FIRST_PERSON_HITS ||
    !narratorShareHolds(hits, total, candidatesIn(0, rawLines.length))
  ) {
    return { slips: [], skipped: "not_narrator_episode" };
  }

  // **場面ごとに、その場面が語り手の一人称かを確かめる**（2026-09-25 の2回目）。
  // 一人称の話の後半に「◆◇◆◇」を挟んで三人称の場面が続くと、話の単位の判定を
  // 越えてそこの名前を拾っていた（教科書チート127話）
  const scenes: SceneRange[] = [];
  let sceneHits = 0;
  for (const scene of sceneRanges(rawLines)) {
    const sceneCounts = countNarrationFirstPersons(
      rawLines.slice(scene.start, scene.end).join("\n")
    );
    const own = sceneCounts.get(narrator.firstPerson) ?? 0;
    let sceneTotal = 0;
    for (const count of sceneCounts.values()) sceneTotal += count;
    if (
      own < MIN_SCENE_FIRST_PERSON_HITS ||
      !narratorShareHolds(own, sceneTotal, candidatesIn(scene.start, scene.end))
    ) {
      continue;
    }
    scenes.push(scene);
    // **ここは数え直さない**（多すぎるかの判定は、実際に書かれた一人称の数で見る）
    sceneHits += own;
  }
  if (scenes.length === 0) return { slips: [], skipped: "not_narrator_episode" };

  if (!pattern) return { slips: [], skipped: "no_name_form" };

  const slips: NarratorNameSlip[] = [];
  for (const scene of scenes) {
    for (let index = scene.start; index < scene.end; index++) {
      const masked = maskedLines[index] ?? "";
      // 見出しは地の文ではない
      if (/^\s*#/u.test(masked)) continue;
      const raw = rawLines[index] ?? "";
      for (const matched of masked.matchAll(pattern)) {
        const at = matched.index ?? 0;
        // **引用は元の行から取る**（伏せた側から取ると、台詞の穴が混ざる）。
        // 伏せたのは括弧の中だけなので、ここは元の行と同じ文字列である
        const original = raw.slice(at, at + matched[0].length);
        const particle = matched[3];
        slips.push({
          line: index + 1,
          original,
          suggestion: occursTwice(raw, original)
            ? ""
            : `${narrator.firstPerson}${particle}`,
          nameForm: matched[1] ?? matched[0],
          narrator,
        });
      }
    }
  }

  // **多すぎるなら、よじれではなく書き方である**（上の `FIRST_PERSON_PER_SLIP`）。
  // 数えるのは、探した場面の一人称だけ
  const allowed = Math.max(1, Math.floor(sceneHits / FIRST_PERSON_PER_SLIP));
  if (slips.length > allowed) return { slips: [], skipped: "too_many" };
  return { slips };
}

/**
 * 地の文の一人称のうち、語り手のものが一定の割合を占めるか。
 *
 * **よじれの候補を、語り手の一人称として数え直してから割合を見る**
 * （2026-09-25 午後の3巡目）。よじれは「俺は」を「相沢は」と書いたものなので、
 * それ自体が語り手の一人称を1つ減らす。一人称の少ない話では、それだけで割合が
 * 線を割り、話ごと「語り手の話ではない」と飛ばしていた（初恋相手の王女の第3話：
 * 「俺」5・ほか3 の 0.63 が、1か所のよじれで 4/7＝0.57 になり、下限 0.6 を割った）。
 *
 * **下限の数（`MIN_EPISODE_FIRST_PERSON_HITS` など）は数え直さない。** 名前だけで
 * 「語り手の話」に仕立てると、三人称の章で主語に立つ名前を拾いかねない。
 * 実際に書かれた一人称が下限に届いたうえで、割合だけを直す。
 */
function narratorShareHolds(own: number, total: number, candidates: number): boolean {
  const recounted = own + candidates;
  const recountedTotal = total + candidates;
  if (recountedTotal === 0) return false;
  return recounted / recountedTotal >= MIN_EPISODE_FIRST_PERSON_SHARE;
}

/**
 * 「名前＋は／が／も」の形。
 *
 * - **前に漢字・片仮名・英数字が付いていれば別の語**（「小相沢は」「千春人が」）
 * - ルビ（「|相沢《あいざわ》は」）はまたいで見る
 * - 「が」の後ろに丘・岡・谷などが続くのは地名（「相沢が丘」）
 * - 「、と」が続くのは、括弧を付けずに言葉を引いた形（「相沢は、と言いかけた」）
 */
function slipPattern(forms: readonly string[]): RegExp {
  const names = forms.map(escapeRegExp).join("|");
  return new RegExp(
    "(?<![\\p{Script=Han}\\p{Script=Katakana}ーA-Za-zＡ-Ｚａ-ｚ0-9０-９])" +
      `[|｜]?(${names})(《[^》\\n]*》)?` +
      "(は|が(?![丘岡谷崎浜原森関島池])|も)" +
      "(?![、，]と)",
    "gu"
  );
}

function occursTwice(line: string, original: string): boolean {
  const first = line.indexOf(original);
  return first >= 0 && line.indexOf(original, first + 1) >= 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 作者へ見せる説明（推敲の「視点」の札に載せる）。
 *
 * **直せとは言わない。** 夢の場面や回想で、わざと自分を三人称で書くことがある。
 * 視点の札にはいつも「わざとなら」の断りを添える（AIの視点の指摘と同じ文。
 * `proofreadValidation.ts` の `VIEWPOINT_INTENT_NOTE`）。
 */
export function describeNarratorNameSlip(slip: NarratorNameSlip): string {
  return (
    `「${slip.narrator.firstPerson}」（${slip.narrator.name}）の語りの地の文に` +
    `「${slip.original}」と名前が出ていて、ここだけ三人称の語りに読めます` +
    VIEWPOINT_INTENT_NOTE
  );
}
