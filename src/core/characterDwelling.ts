import type { Character, CharacterDwelling } from "../models/character";
import type { RecordChange } from "../models/jsonValidation";
import { stripHonorific } from "./nameHonorific";

/**
 * 宿り：この人物の心が、別の人物の体にいる（作者の裁定、2026-10-18。設計書6.5.13）。
 *
 * 憑依・転生・入れ替わりのある作品（いじめられっ子：太志の心が文佳の体に入る）では、
 * 名前1つで人物を分ける記録が、体と心と時期を見失う。実データでは、文佳の体の記録に
 * 「前世は男子小学生でイジメを受け死亡」が入り、統合の候補に体と心の組が並び、
 * 文佳の別名に「太志」が入り込んでいた。
 *
 * **どの心がどの体にいるかは、作者が記録する**（`Character.dwellings`）。
 * ここはその記録を読むだけで、記録そのものを作ったり直したりはしない。
 * 読む先は3つ——
 *   1. 統合の候補・別名の取り込み：体と心の組を同一人物として扱わない
 *   2. 資料の表示：両方の人物に「体」「心」「いつから」を出す
 *   3. 変化の仕分け：体の記録のうち、心の側の記述を本人の変化から分けて見せる
 *
 * **記録（変化の値）は書き換えない**（CLAUDE.md 規則2）。仕分けは表示と材料の
 * 並べ方だけで、ファイルの中身はそのまま残る。
 */

/** 宿りを、心の側と体の側の人物に結んだもの */
export interface DwellingLink {
  /** 心の側（宿りを記録した人物） */
  dweller: Character;
  /** 体の持ち主。資料に見つからなければ undefined */
  body: Character | undefined;
  dwelling: CharacterDwelling;
}

function spacingKey(name: string): string {
  return name.replace(/[\s　]/gu, "");
}

/**
 * 体の持ち主の名前から、資料の人物を引き当てる。
 *
 * **名前の一致を先に見る。** 別名まで同列に見ると、文佳の別名に入り込んだ「太志」の
 * ような汚染で、別の人物へ結ばれる。名前で見つからなければ、別名で1人だけに
 * 当たるときに限って結ぶ（作者が人物をまとめたあと、体の名前が別名へ移った場合）。
 */
export function findDwellingBody(
  bodyName: string,
  characters: readonly Character[],
  dweller?: Character
): Character | undefined {
  const key = spacingKey(bodyName);
  if (!key) return undefined;
  const others = characters.filter((character) => character.id !== dweller?.id);
  const byName = others.filter((character) => spacingKey(character.name) === key);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return undefined;
  const byAlias = others.filter((character) =>
    character.aliases.some((alias) => spacingKey(alias) === key)
  );
  return byAlias.length === 1 ? byAlias[0] : undefined;
}

/** 作品の宿りをすべて、心と体の人物に結ぶ */
export function dwellingLinks(characters: readonly Character[]): DwellingLink[] {
  return characters.flatMap((dweller) =>
    (dweller.dwellings ?? []).map((dwelling) => ({
      dweller,
      body: findDwellingBody(dwelling.body, characters, dweller),
      dwelling,
    }))
  );
}

/** この2人は、作者が記録した宿りの組（心と体）か。向きは問わない */
export function isDwellingPair(
  a: Character,
  b: Character,
  characters: readonly Character[]
): boolean {
  if (a.id === b.id) return false;
  return dwellingLinks(characters).some(
    (link) =>
      (link.dweller.id === a.id && link.body?.id === b.id) ||
      (link.dweller.id === b.id && link.body?.id === a.id)
  );
}

/**
 * その人物と宿りで結ばれた相手（心から見た体、体から見た心）。
 */
export function dwellingPartners(
  character: Character,
  characters: readonly Character[]
): Character[] {
  const partners = new Map<string, Character>();
  for (const link of dwellingLinks(characters)) {
    if (link.dweller.id === character.id && link.body) {
      partners.set(link.body.id, link.body);
    }
    if (link.body?.id === character.id) {
      partners.set(link.dweller.id, link.dweller);
    }
  }
  return [...partners.values()];
}

/**
 * その人物を指す呼び名のうち、**本人のものと確かめられる形**（空白を落とした形）。
 *
 * 名前と、名前を含む／名前に含まれる別名（敬称を外して比べる）。「三門太志」なら
 * 「太志」「三門くん」まで。**名前と関係のない別名は入れない**——文佳の別名には
 * 汚染で「太志」が入っている。それを文佳の呼び名として扱うと、太志の側で
 * 本人の「太志」まで取り込めなくなる。
 */
export function ownAppellations(character: Character): string[] {
  const name = spacingKey(character.name);
  const result = new Set<string>(name ? [name] : []);
  for (const alias of character.aliases) {
    const key = spacingKey(alias);
    const bare = spacingKey(stripHonorific(alias));
    if (!key || !bare || !name) continue;
    if (name.includes(bare) || bare.includes(name)) result.add(key);
  }
  return [...result];
}

/**
 * 別名として取り込まない呼び名（空白を落とした形）。宿りで結ばれた相手の、
 * 本人のものと確かめられる呼び名。抽出が文佳の別名へ「太志」を足すのを止める。
 */
export function dwellingBlockedNames(
  character: Character,
  characters: readonly Character[]
): Set<string> {
  return new Set(
    dwellingPartners(character, characters).flatMap((partner) =>
      ownAppellations(partner)
    )
  );
}

/** 「第4話〜第16話」「第4話〜」「〜第16話」。範囲が無ければ空文字 */
export function describeDwellingRange(dwelling: CharacterDwelling): string {
  const from = dwelling.fromChapter;
  const until = dwelling.untilChapter;
  if (from === undefined && until === undefined) return "";
  if (from !== undefined && until !== undefined && from === until) return `第${from}話`;
  return `${from !== undefined ? `第${from}話` : ""}〜${until !== undefined ? `第${until}話` : ""}`;
}

/** 資料に出す1行の中身。「文佳（第4話〜）。補足」 */
function describeOne(name: string, dwelling: CharacterDwelling): string {
  const range = describeDwellingRange(dwelling);
  const note = dwelling.note?.trim();
  return `${name}${range ? `（${range}）` : ""}${note ? `。${note}` : ""}`;
}

/** 資料に出す宿りの行。心の側と体の側の両方で出す */
export interface DwellingLine {
  label: string;
  value: string;
}

export const DWELLER_LABEL = "心が宿っている体";
export const BODY_LABEL = "この体に宿る心";

export function describeDwellings(
  character: Character,
  characters: readonly Character[]
): DwellingLine[] {
  const links = dwellingLinks(characters);
  const lines: DwellingLine[] = [];
  const asDweller = links.filter((link) => link.dweller.id === character.id);
  if (asDweller.length > 0) {
    lines.push({
      label: DWELLER_LABEL,
      value: asDweller
        .map((link) =>
          describeOne(link.body?.name ?? `${link.dwelling.body}（資料に見つかりません）`, link.dwelling)
        )
        .join("／"),
    });
  }
  const asBody = links.filter((link) => link.body?.id === character.id);
  if (asBody.length > 0) {
    lines.push({
      label: BODY_LABEL,
      value: asBody.map((link) => describeOne(link.dweller.name, link.dwelling)).join("／"),
    });
  }
  return lines;
}

/**
 * 体の記録から、心の側の記述として分ける目印の語。
 *
 * **宿った心の名前では分けない**（実データで確かめた、2026-10-18）。文佳の記録の
 * 「太志に身体を憑依され、イジメっ子をビンタする」「太志のために怒る情の厚さ」は、
 * 太志の名前を含むが、体の持ち主（文佳）の事実である。名前で分けると、文佳本人の
 * 性格まで心の側へ寄った。混線しているのは「前世は男子小学生」のように、
 * **体の持ち主を、宿った心の過去の姿として書いた値**であり、目印は「前世」「生前」である
 */
const PAST_LIFE_TERMS = ["前世", "生前"];

/**
 * 体の人物の変化の記録を、本人の変化と、宿った心の側の記述に分ける。
 *
 * 心の側とみるのは、**「前世」「生前」を含む値**（字面で決める。AIに判断させない。
 * 名前で分けない理由は `PAST_LIFE_TERMS`）。文佳の記録の「前世の名は太志で、
 * 死後文佳に転生した」は体の持ち主の変化ではなく、中にいる心の過去である。
 * 紹介や関与度にそのまま渡すと、「前世は男子小学生」と「会長の孫娘」が同じ人物の
 * 変化として並ぶ。
 *
 * 宿りに「何話から」があれば、それより前の話だけの値は分けない（宿る前の体の記述）。
 * 体として宿られていない人物（宿りが無い・心の側だけの人物）は、そのまま返す。
 *
 * **記録は書き換えない**——分けた値も消えず、`dwelling` として並べて見せる。
 */
export function splitDwellingChanges(
  character: Character,
  characters: readonly Character[]
): { own: RecordChange[]; dwelling: RecordChange[]; dwellers: Character[] } {
  const links = dwellingLinks(characters).filter((link) => link.body?.id === character.id);
  if (links.length === 0) return { own: character.changes, dwelling: [], dwellers: [] };

  const terms = PAST_LIFE_TERMS;
  const earliest = Math.min(
    ...links.map((link) => link.dwelling.fromChapter ?? Number.NEGATIVE_INFINITY)
  );

  const own: RecordChange[] = [];
  const dwelling: RecordChange[] = [];
  for (const entry of character.changes) {
    const text = spacingKey(entry.value);
    const before =
      entry.chapters.length > 0 && Math.max(...entry.chapters) < earliest;
    if (!before && terms.some((term) => text.includes(term))) dwelling.push(entry);
    else own.push(entry);
  }
  return {
    own,
    dwelling,
    dwellers: [...new Map(links.map((link) => [link.dweller.id, link.dweller])).values()],
  };
}

/**
 * 宿りの欄の書き方（1行に1つ）。「文佳=第4話〜第16話：補足」
 *
 * 画面の欄は文字列で行き来するので、読み書きの規則をここに1か所で持つ。
 */
export function formatDwellingsForEdit(dwellings: readonly CharacterDwelling[] | undefined): string {
  return (dwellings ?? [])
    .map((dwelling) => {
      // 表示の「第4話」（始まりと終わりが同じ）は、読み戻すと「第4話から」になる。
      // 欄には必ず「〜」を入れて、読み書きで範囲が変わらないようにする
      const from = dwelling.fromChapter;
      const until = dwelling.untilChapter;
      const range =
        from === undefined && until === undefined
          ? ""
          : `${from !== undefined ? `第${from}話` : ""}〜${until !== undefined ? `第${until}話` : ""}`;
      const note = dwelling.note?.trim();
      return `${dwelling.body}${range ? `=${range}` : ""}${note ? `：${note}` : ""}`;
    })
    .join("\n");
}

/** 宿りの欄が読めなかった。画面へそのまま出す文を持つ */
export class DwellingEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DwellingEditError";
  }
}

const RANGE_PATTERN =
  /^(?:第?\s*(\d+)\s*話?)?\s*(?:から|[〜~～\-－ー])?\s*(?:第?\s*(\d+)\s*話?\s*(?:まで)?)?$/u;

/**
 * 宿りの欄を読む。書き方は「体の持ち主=範囲：補足」で、範囲と補足は省いてよい。
 *
 * - 範囲：「第4話〜」「第4話〜第16話」「4〜16」「第4話から」「〜第16話」。
 *   数字1つは「何話から」と読む（「第4話から文佳の体にいる」が普通の言い方のため）
 * - 補足は「：」か「:」のあと
 *
 * 読めない行は黙って捨てず、何行目かを添えて止める（関係の欄と同じ扱い）。
 */
export function parseDwellingsEdit(text: string, ownName: string): CharacterDwelling[] {
  const result: CharacterDwelling[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/[０-９]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  ).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    const noteAt = raw.search(/[：:]/u);
    const head = noteAt < 0 ? raw : raw.slice(0, noteAt);
    const note = noteAt < 0 ? "" : raw.slice(noteAt + 1).trim();
    const at = head.search(/[=＝]/u);
    const body = (at < 0 ? head : head.slice(0, at)).trim();
    const rangeText = at < 0 ? "" : head.slice(at + 1).trim();
    const fail = (why: string): never => {
      throw new DwellingEditError(
        `宿りの${index + 1}行目「${raw}」が読めません。${why}` +
          "1行に1つ「体の持ち主=第4話〜第16話：補足」の形で書いてください（範囲と補足は省けます）。"
      );
    };
    if (!body) fail("体の持ち主の名前がありません。");
    if (spacingKey(body) === spacingKey(ownName)) {
      fail("自分自身の体は書けません。");
    }
    const dwelling: CharacterDwelling = { body };
    if (rangeText) {
      const match = RANGE_PATTERN.exec(rangeText);
      if (!match || (match[1] === undefined && match[2] === undefined)) {
        fail("話数の範囲が読めません。");
      }
      const from = match?.[1] !== undefined ? Number(match[1]) : undefined;
      const until = match?.[2] !== undefined ? Number(match[2]) : undefined;
      if ((from !== undefined && from < 1) || (until !== undefined && until < 1)) {
        fail("話数は1から数えます。");
      }
      if (from !== undefined && until !== undefined && until < from) {
        fail("終わりの話が始まりより前です。");
      }
      if (from !== undefined) dwelling.fromChapter = from;
      if (until !== undefined) dwelling.untilChapter = until;
    }
    if (note) dwelling.note = note;
    const key = formatDwellingsForEdit([dwelling]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dwelling);
  }
  return result;
}

/**
 * まとめる2人の宿りを合わせる（`unifyCharacters`）。
 *
 * まとめる相手そのものを体とする宿りは落とす（2人が1人になれば、自分の体に宿る
 * ことになり意味が無い）。どちらにも無ければ undefined（欄ごと置かない）。
 */
export function unifyDwellings(
  keep: Character,
  absorb: Character
): CharacterDwelling[] | undefined {
  const selfKeys = new Set(
    [keep.name, ...keep.aliases, absorb.name, ...absorb.aliases].map(spacingKey)
  );
  const seen = new Set<string>();
  const result: CharacterDwelling[] = [];
  for (const dwelling of [...(keep.dwellings ?? []), ...(absorb.dwellings ?? [])]) {
    if (selfKeys.has(spacingKey(dwelling.body))) continue;
    const key = formatDwellingsForEdit([dwelling]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...dwelling });
  }
  return result.length > 0 ? result : undefined;
}
