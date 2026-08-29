import { deriveReading } from "./reading";
import { NAME_PART_SEPARATOR } from "./termIndex";

/**
 * 名前の衝突の判定（設計書6.37.1）。
 *
 * **AIを使わない。** 機械的に確定できる規則だけで判定する。長い連載では
 * 「ミナ」と「ミナモト」、「アリア」と「アリサ」のように響きの近い名前が
 * 後から増え、読者が取り違える。これは規則で見つけられるものなので、
 * AIに判断させて誤りの余地を作る理由がない（表記ゆれ検知と同じ考え方）。
 *
 * **ここは指摘を作るだけで、何も書き換えない。** 付け替えは
 * `core/nameRename.ts` と提案パネルが受け持つ。
 *
 * VS Code API に依存しない純粋関数だけを置く（単体テストの対象）。
 */

/** 名前を持つレコードの種別。人物どうしを主とし、他は「紛らわしい」相手として見る */
export type NameEntryKind = "character" | "location" | "organization" | "ability";

export interface NameEntry {
  id: string;
  kind: NameEntryKind;
  name: string;
  /** 作者やAIが入れた読み。無ければ `deriveReading` に委ねる */
  reading?: string | null;
  aliases?: string[];
}

/** 判定の強さ。画面はこの順に並べる */
export type CollisionStrength = "strong" | "medium" | "weak";

/**
 * 当てはめた規則（設計書6.37.1の①〜⑥）。**強い順に1つだけ当てる。**
 * 同じ組を複数の理由で並べると、1つの取り違えが何行にも増えて数が読めなくなる。
 */
export type CollisionRule = 1 | 2 | 3 | 4 | 5 | 6;

export interface NameCollisionSide {
  id: string;
  /** レコードの正式名。画面ではこれを出す */
  name: string;
  /** 正式名そのものではなく、姓・名・別名で当たったときの、その文字列 */
  part?: string;
}

export interface NameCollision {
  a: NameCollisionSide;
  b: NameCollisionSide;
  rule: CollisionRule;
  strength: CollisionStrength;
  /** なぜ紛らわしいか。作者がそのまま読める日本語 */
  reason: string;
}

export interface NameCollisionResult {
  collisions: NameCollision[];
  /**
   * 読みが分からず、比較できなかった名前。
   *
   * **黙って見たことにしない。** 漢字で読みも無い名前は響きを比べようが
   * ないので、画面で「読みが無いので見ていません」と断る必要がある。
   */
  unreadable: Array<{ id: string; name: string }>;
}

/** 正規化した読み。清音化した形も一緒に持つ */
export interface NormalizedReading {
  /** ひらがな・長音を母音へ開いた形。区切りは落としてある */
  reading: string;
  /** 濁点・半濁点を落とした形（「がな」→「かな」） */
  dakutenFree: string;
}

const KATAKANA_START = 0x30a1; // ァ
const KATAKANA_END = 0x30f6; // ヶ

/** 読みの比較では見ない区切り。`deriveReading` と同じものを落とす */
const SEPARATORS = /[・･\s　=＝]/u;

/**
 * 長音「ー」を開くための母音表。
 *
 * 「ほんごー」と「ほんごお」は同じ響きなのに、文字としては違う。
 * 開いておかないと、片方をカタカナで、片方を送り仮名込みで書いた
 * 2つの名前が別物として通り抜ける。
 */
const VOWEL_OF = new Map<string, string>();
function registerVowels(row: string, vowel: string): void {
  for (const char of row) VOWEL_OF.set(char, vowel);
}
registerVowels("あかがさざただなはばぱまやゃらわゎぁ", "あ");
registerVowels("いきぎしじちぢにひびぴみりぃ", "い");
registerVowels("うくぐすずつづぬふぶぷむゆゅるゔぅ", "う");
registerVowels("えけげせぜてでねへべぺめれぇ", "え");
registerVowels("おこごそぞとどのほぼぽもよょろをぉ", "お");

/** 濁点・半濁点を落とすための対応。並びの位置どうしが対になる */
const VOICED = "がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔ";
const SEION = "かきくけこさしすせそたちつてとはひふへほはひふへほう";

/**
 * 小書きの仮名。**前の音とくっついて1音になる**（「きゃ」で1音）。
 *
 * 「っ」は入れない。促音は独立した1音として数えるのが日本語の数え方で、
 * ここを混ぜると「あっさり」と「あさり」の音数が同じになってしまう。
 */
const SMALL_KANA = "ぁぃぅぇぉゃゅょゎ";

/**
 * 読みを比較できる形に正規化する（設計書6.37.1）。
 *
 * カタカナ→ひらがな／長音→母音／区切りを落とす、の3つを行う。
 * **小書きの仮名はそのまま残す**——「アリア」と「アリャ」は別の響きである。
 */
export function normalizeReading(reading: string): NormalizedReading {
  let normalized = "";
  for (const char of reading.trim()) {
    if (SEPARATORS.test(char)) continue;

    if (char === "ー") {
      // 直前の音の母音へ開く。先頭に来た「ー」は開きようがないので落とす
      const previous = normalized[normalized.length - 1];
      const vowel = previous ? VOWEL_OF.get(previous) : undefined;
      if (vowel) normalized += vowel;
      continue;
    }

    const code = char.codePointAt(0);
    if (code !== undefined && code >= KATAKANA_START && code <= KATAKANA_END) {
      normalized += String.fromCodePoint(code - 0x60);
      continue;
    }
    // ひらがな以外（漢字・英字）が残ることもある。**落とさない**——
    // 落とすと別の名前どうしがたまたま一致して、ありもしない衝突が出る
    normalized += char;
  }

  let dakutenFree = "";
  for (const char of normalized) {
    const at = VOICED.indexOf(char);
    dakutenFree += at >= 0 ? SEION[at] : char;
  }

  return { reading: normalized, dakutenFree };
}

/**
 * 読みを「音」の並びに分ける。
 *
 * 音数と頭2音の比較に使う。小書きは前の音へくっつける（「きゃく」は2音）。
 */
export function toMoras(reading: string): string[] {
  const moras: string[] = [];
  for (const char of reading) {
    if (SMALL_KANA.includes(char) && moras.length > 0) {
      moras[moras.length - 1] += char;
      continue;
    }
    moras.push(char);
  }
  return moras;
}

/** 比較の最小単位。フルネーム・姓・名・別名を同じ形で扱う */
interface NameUnit {
  entryId: string;
  /** レコードの正式名 */
  recordName: string;
  kind: NameEntryKind;
  /** この単位そのものの表記 */
  surface: string;
  /** 比較に使う読み。作れなければこの単位は比べない */
  reading: NormalizedReading;
  moras: string[];
  dakutenFreeMoras: string[];
  /** 姓（区切りで分けた最初の部分）か。家族なら重なって当然なので弱くする */
  isFamilyPart: boolean;
  /** 区切りで切り出した部分か（フルネーム・別名そのものなら false） */
  isPart: boolean;
  /** この単位の表記に区切りが入っているか（＝姓名が並んだ形か） */
  hasSeparator: boolean;
}

/**
 * 名前の衝突を探す（設計書6.37.1）。
 *
 * 人物どうしを主とし、相手が場所・組織・能力のときは強さを1段落とす。
 * **人物以外どうしは見ない**——地名と能力名が似ていても、読者が人物を
 * 取り違える話にはならない。
 */
export function findNameCollisions(entries: NameEntry[]): NameCollisionResult {
  const unreadable: Array<{ id: string; name: string }> = [];
  const unitsByEntry = entries.map((entry) => buildUnits(entry, unreadable));

  const collisions: NameCollision[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      // 人物が片方も居ない組は見ない
      if (entries[i].kind !== "character" && entries[j].kind !== "character") {
        continue;
      }
      const found = strongestBetween(unitsByEntry[i], unitsByEntry[j]);
      if (found) collisions.push(found);
    }
  }

  const order: Record<CollisionStrength, number> = {
    strong: 0,
    medium: 1,
    weak: 2,
  };
  collisions.sort((a, b) => {
    if (a.strength !== b.strength) return order[a.strength] - order[b.strength];
    if (a.rule !== b.rule) return a.rule - b.rule;
    return a.a.name.localeCompare(b.a.name, "ja");
  });

  return { collisions, unreadable };
}

/** 候補の絞り込みの結果。落としたものは理由つきで残す */
export interface ScreenedNameCandidates<T> {
  kept: T[];
  dropped: Array<{ candidate: T; reason: string }>;
}

/** 候補として受け取れる最小限の形。AIの応答でも、作者の思いつきでもよい */
export interface CandidateName {
  name: string;
  reading?: string;
}

/**
 * 名前の候補から、既存の名前と重なるものを落とす（設計書6.37.2）。
 *
 * **AIには「避けて」と書いてあるが、守られない前提で組む。** 判定は
 * ここ（コード）で行い、当たった候補は**理由つきで落とす**——黙って
 * 減らすと、10件頼んだのに6件しか出ないのが不具合に見える。
 *
 * @param excludeId 付け替える本人のid。**自分自身とは比べない**——
 *   いまの名前と似ているかどうかは、この場面では意味がない
 */
export function screenNameCandidates<T extends CandidateName>(
  candidates: readonly T[],
  existing: readonly NameEntry[],
  options: { excludeId?: string } = {}
): ScreenedNameCandidates<T> {
  const others = existing.filter((entry) => entry.id !== options.excludeId);
  const kept: T[] = [];
  const dropped: Array<{ candidate: T; reason: string }> = [];
  const CANDIDATE_ID = "__candidate__";

  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!name) continue;

    const result = findNameCollisions([
      {
        id: CANDIDATE_ID,
        kind: "character",
        name,
        reading: candidate.reading?.trim() || null,
      },
      ...others,
    ]);

    // 候補が絡む組だけを見る。既存どうしの衝突は、この場面の話ではない
    const hit = result.collisions.find(
      (collision) =>
        collision.a.id === CANDIDATE_ID || collision.b.id === CANDIDATE_ID
    );
    if (!hit) {
      kept.push(candidate);
      continue;
    }

    const other = hit.a.id === CANDIDATE_ID ? hit.b : hit.a;
    dropped.push({
      candidate,
      reason: `「${other.name}」と重なります（${hit.reason}）`,
    });
  }

  return { kept, dropped };
}

/**
 * 1つのレコードから、比較できる単位を組み立てる。
 *
 * 正式名・別名と、それぞれを区切りで分けた部分（2文字以上）を並べる。
 * **読みが作れない表記は、ここで落として `unreadable` へ回す。**
 * 推測で読みを当てにいくと、当てた読みどうしで衝突が出てしまう。
 */
function buildUnits(
  entry: NameEntry,
  unreadable: Array<{ id: string; name: string }>
): NameUnit[] {
  const units: NameUnit[] = [];
  const surfaces = [entry.name, ...(entry.aliases ?? [])]
    .map((surface) => surface.trim())
    .filter(Boolean);

  for (const surface of surfaces) {
    // 正式名だけは、作者・AIが入れた読みを優先する（漢字名はこれしか手がない）
    const given =
      surface === entry.name.trim() ? entry.reading?.trim() : undefined;
    const source = given || deriveReading(surface);
    if (!source) {
      unreadable.push({ id: entry.id, name: surface });
    } else {
      units.push(makeUnit(entry, surface, source, false, false));
    }

    if (!NAME_PART_SEPARATOR.test(surface)) continue;
    const parts = surface.split(NAME_PART_SEPARATOR).filter(Boolean);
    parts.forEach((part, index) => {
      // 1文字の部分は普通名詞と重なりやすい（`expandNameVariants` と同じ判断）
      if (part.length < 2) return;
      // 部分の読みは機械的に作れるものだけ。フルネームの読みは
      // 姓と名の切れ目が分からないので、切り分けて当てはめない
      const partReading = deriveReading(part);
      if (!partReading) return;
      units.push(makeUnit(entry, part, partReading, index === 0, true));
    });
  }

  return units;
}

function makeUnit(
  entry: NameEntry,
  surface: string,
  readingSource: string,
  isFamilyPart: boolean,
  isPart: boolean
): NameUnit {
  const reading = normalizeReading(readingSource);
  return {
    entryId: entry.id,
    recordName: entry.name.trim(),
    kind: entry.kind,
    surface,
    reading,
    moras: toMoras(reading.reading),
    dakutenFreeMoras: toMoras(reading.dakutenFree),
    isFamilyPart,
    isPart,
    hasSeparator: NAME_PART_SEPARATOR.test(surface),
  };
}

/** 規則ごとの下地の強さ。ここから姓・種別で弱める */
const BASE_STRENGTH: Record<CollisionRule, CollisionStrength> = {
  1: "strong",
  2: "strong",
  3: "medium",
  4: "medium",
  5: "medium",
  6: "weak",
};

function weaken(strength: CollisionStrength): CollisionStrength {
  if (strength === "strong") return "medium";
  if (strength === "medium") return "weak";
  return "weak";
}

const KIND_LABEL: Record<NameEntryKind, string> = {
  character: "人物",
  location: "場所",
  organization: "組織",
  ability: "能力",
};

/**
 * 2つのレコードの間で、いちばん強い当たりを1つだけ返す。
 *
 * 単位（フルネーム・姓・名・別名）は総当たりで見るが、**出すのは1件**である。
 */
function strongestBetween(
  unitsA: NameUnit[],
  unitsB: NameUnit[]
): NameCollision | undefined {
  let best: NameCollision | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const a of unitsA) {
    for (const b of unitsB) {
      if (differentGranularity(a, b)) continue;
      const hit = matchRule(a, b);
      if (!hit) continue;

      let strength = BASE_STRENGTH[hit.rule];
      // 姓どうしの一致は「弱」。家族なら重なって当然で、作者は知っている
      if (a.isFamilyPart && b.isFamilyPart) strength = "weak";
      // 人物以外が相手なら1段落とす。取り違えの重さが違う
      if (a.kind !== "character" || b.kind !== "character") {
        strength = weaken(strength);
      }

      const score = { strong: 0, medium: 1, weak: 2 }[strength] * 10 + hit.rule;
      if (score >= bestScore) continue;

      bestScore = score;
      best = {
        a: sideOf(a),
        b: sideOf(b),
        rule: hit.rule,
        strength,
        reason: buildReason(hit, a, b),
      };
    }
  }

  return best;
}

/**
 * 姓名の並んだ名前を、相手の姓・名と直に比べない。
 *
 * 「ミナモト アリア」と「ミナモト ジュンイチロウ」を見るとき、
 * **前者のフルネームは後者の姓「ミナモト」を必ず先頭に含む**（規則②）。
 * これを拾うと、家族はすべて「強」の衝突として並び、姓どうしを弱く
 * 見る意味が消える（実際にそうなった）。
 *
 * 比べるのは「フルネームどうし」と「部分どうし」である。区切りの無い
 * 名前（「ミナ」）は部分としても扱うので、**「ミナ」と「ミナモト アリア」の
 * 姓は今までどおり当たる**——ここを閉じると、いちばん見たい形を落とす。
 */
function differentGranularity(a: NameUnit, b: NameUnit): boolean {
  return (a.isPart && b.hasSeparator) || (b.isPart && a.hasSeparator);
}

function sideOf(unit: NameUnit): NameCollisionSide {
  return unit.surface === unit.recordName
    ? { id: unit.entryId, name: unit.recordName }
    : { id: unit.entryId, name: unit.recordName, part: unit.surface };
}

interface RuleHit {
  rule: CollisionRule;
  /** 理由文に出す、実際に比べた形 */
  shownA: string;
  shownB: string;
}

/**
 * 2つの単位に、①〜⑥のどれが当たるかを見る（強い順に1つだけ）。
 *
 * ⑤は「清音化すると①〜④に当たる」なので、①〜④の判定をそのまま
 * 清音化した形へ当て直す。判定を2度書くと、片方だけ直る。
 */
function matchRule(a: NameUnit, b: NameUnit): RuleHit | undefined {
  const plain = soundRule(a.moras, b.moras);
  if (plain) {
    return { rule: plain, shownA: a.reading.reading, shownB: b.reading.reading };
  }

  const freed = soundRule(a.dakutenFreeMoras, b.dakutenFreeMoras);
  if (freed) {
    return {
      rule: 5,
      shownA: a.reading.dakutenFree,
      shownB: b.reading.dakutenFree,
    };
  }

  // ⑥ 表記の先頭2文字が同じ（漢字名。響きは違っても目が滑る）
  if (
    a.surface.length >= 2 &&
    b.surface.length >= 2 &&
    a.surface.slice(0, 2) === b.surface.slice(0, 2)
  ) {
    return { rule: 6, shownA: a.surface, shownB: b.surface };
  }

  return undefined;
}

/** 響きの規則①〜④。当たらなければ undefined */
function soundRule(a: string[], b: string[]): CollisionRule | undefined {
  if (a.length === 0 || b.length === 0) return undefined;

  // ① 読みが同じ
  if (a.length === b.length && a.every((mora, index) => mora === b[index])) {
    return 1;
  }

  // ② 片方がもう片方の先頭（「みな」「みなもと」）
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (
    shorter.length >= 2 &&
    shorter.every((mora, index) => mora === longer[index])
  ) {
    return 2;
  }

  // ③ 頭2音が同じで音数の差が1以内（「ありあ」「ありさ」）
  if (
    a.length >= 2 &&
    b.length >= 2 &&
    a[0] === b[0] &&
    a[1] === b[1] &&
    Math.abs(a.length - b.length) <= 1
  ) {
    return 3;
  }

  // ④ 音数が同じで1音だけ違う（「まりあ」「さりあ」）。
  //
  // **1音の名前どうしには当てない。** 1音は「必ず1音だけ違う」ので、
  // 「ミ」と「サ」のような似ていない組まで全部が当たってしまう
  // （②③が音数2以上を求めているのと同じ理由）
  if (a.length === b.length && a.length >= 2) {
    const differences = a.filter((mora, index) => mora !== b[index]).length;
    if (differences === 1) return 4;
  }

  return undefined;
}

function buildReason(hit: RuleHit, a: NameUnit, b: NameUnit): string {
  const pair = `${hit.shownA}／${hit.shownB}`;
  const head =
    hit.rule === 1
      ? `読みが同じ（${hit.shownA}）`
      : hit.rule === 2
        ? `片方がもう片方の先頭（${pair}）`
        : hit.rule === 3
          ? `頭2音が同じで音数も近い（${pair}）`
          : hit.rule === 4
            ? `1音だけ違う（${pair}）`
            : hit.rule === 5
              ? `濁点・半濁点を除くと重なる（${pair}）`
              : `表記の先頭2文字が同じ（${pair}）`;

  const notes: string[] = [];
  if (a.isFamilyPart && b.isFamilyPart) {
    notes.push("姓どうしなので弱く見ています");
  }
  // 種別の違いは、なぜ弱いのかの説明になる。片側だけを書く
  const other = a.kind !== "character" ? a.kind : b.kind !== "character" ? b.kind : undefined;
  if (other) notes.push(`相手は${KIND_LABEL[other]}です`);

  return notes.length > 0 ? `${head}。${notes.join("。")}` : head;
}
