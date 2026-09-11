import type { Character } from "../models/character";
import type { RecordChange } from "../models/jsonValidation";
import type { FactKind, StoryFact } from "../models/storyFact";
import { CHARACTER_FIELD_LABELS } from "./chronicle";
import { CHARACTER_AS_OF_FIELDS } from "./contradictionMaterial";

/**
 * 既にある設定資料から「事実」を組む（設計書6.88.5・6.88.6の第2段）。
 *
 * ## なぜ要るのか
 *
 * 機械照合（`contradictionMatch.ts`）は事実の列を食べるが、事実を本文から
 * 抜くのは第3段（P-37）である。**その前に、既に手元にある資料で照合を
 * 動かせるようにする。** 人物レコードの `changes`（作者が「これは作中の
 * 変化だ」と確定させたもの）と現在値だけでも、区間の状態表は組める。
 *
 * ## 変化の記録は、そのまま変化イベントにする
 *
 * `changes` は**作者が確定させた作中の変化**である。だから話数が変われば
 * そこに `event` の事実を置き、区間を切る。切らないと「第3話は黒髪、
 * 第7話は銀髪」が重なったままになり、**作者が一度判断したことを毎回
 * 蒸し返す**（設計書6.18）。
 *
 * 逆に、**同じ話の中に別の値が2つあるときは切らない。** 両方が同時に
 * 正しいことはないので、候補として作者へ返すのが正しい（6.18の
 * 「同じ話の中で矛盾」）。
 *
 * ## 出さないもの
 *
 * - **`conflicts` は事実にしない。** 食い違いは既に作者の判断へ回っている
 *   （6.18）。ここから候補を作ると、同じ食い違いが提案パネルと矛盾の候補に
 *   二重に出る
 * - **年表（`設定/timeline.json` の時期ID）は使わない。** 時期IDは作者が
 *   付ける粗い区分、相対時期（`storyTime`）は本文から読む細かい目盛りで、
 *   **対応表を持たない**（6.88.4）。`changes.timepointId` から相対時期を
 *   作ると、作者が付けた区分を日数に読み替えたことになる
 *
 * VS Code APIに依存しない（LLMも使わない）。
 */

/**
 * 作中で変わりうる項目（`state`）。ほかは `static`。
 *
 * **区別が効くのは候補の型**である（`state` が混ざると「状態」、
 * どちらも `static` なら「設定」として出る）。作者が確かめに行く先が違う。
 *
 * `CHARACTER_AS_OF_FIELDS` のうち、所属（異動・離反）と役割（立場の変化）は
 * 作中で変わる。外見は髪を切れば変わるが、**設計書6.88.3が `static` の例に
 * 「髪の色」を挙げている**ので静的側に置く——変化は `changes` が `event` を
 * 生むので、どちらでも区間は正しく切れる。紹介・性格・性別は静的。
 *
 * 人物レコードにはまだ無いが、状態を表す語（`status`・`injury`・
 * `possessions`）も並べてある。作者が足した項目（`customFields`）や、
 * 第3段の抽出が同じ語を返したときに、型の振り分けを1か所で済ませるため。
 */
const STATE_FIELDS: ReadonlySet<string> = new Set([
  "affiliation",
  "role",
  "status",
  "injury",
  "possessions",
]);

/**
 * 人物レコードから事実を組む。
 *
 * @returns 話数順に並べていない生の列。並べ替えは `orderFacts` が行う
 */
export function factsFromCharacters(
  characters: readonly Character[]
): StoryFact[] {
  const facts: StoryFact[] = [];
  for (const character of characters) {
    facts.push(...factsFromCharacter(character));
  }
  return facts;
}

function factsFromCharacter(character: Character): StoryFact[] {
  const facts: StoryFact[] = [];

  const byField = new Map<string, RecordChange[]>();
  for (const change of character.changes) {
    const bucket = byField.get(change.field);
    if (bucket) bucket.push(change);
    else byField.set(change.field, [change]);
  }

  for (const [field, changes] of byField) {
    facts.push(...factsFromChanges(character, field, changes));
  }

  // 現在値は「`changes` に無い項目」だけ。変化のある項目の現在値は
  // 最後の変化と同じ値なので、足すと同じ値の区間が二重になる
  const firstChapter = earliestChapter(character.appearedChapters);
  for (const field of CHARACTER_AS_OF_FIELDS) {
    if (byField.has(field)) continue;
    const value = currentValue(character, field);
    if (value === null) continue;
    facts.push(
      buildFact({
        id: factId(character.id, field, 1),
        subject: character.id,
        predicate: labelOf(field),
        value,
        // **登場話数の最初の話**に置く。資料には「いつ書かれた値か」が
        // 無いので、分かっている中でいちばん早い話へ寄せる
        chapter: firstChapter,
        kind: kindOf(field),
      })
    );
  }

  return facts;
}

function factsFromChanges(
  character: Character,
  field: string,
  changes: readonly RecordChange[]
): StoryFact[] {
  const predicate = labelOf(field);
  const kind = kindOf(field);
  // 話数の分からない変化（「それ以前」）は末尾へ。並びを推測で作らない
  const ordered = [...changes].sort(
    (left, right) =>
      (chapterOf(left) ?? Number.MAX_SAFE_INTEGER) -
      (chapterOf(right) ?? Number.MAX_SAFE_INTEGER)
  );

  const facts: StoryFact[] = [];
  let previousChapter: number | null = null;
  ordered.forEach((change, index) => {
    const chapter = chapterOf(change);
    const number = index + 1;

    // **話が変わっていれば、そこで変わったと読む**（6.18）。両方の話数が
    // 分かっているときだけ切る——片方でも分からなければ前後を決められない
    if (
      index > 0 &&
      chapter !== null &&
      previousChapter !== null &&
      chapter !== previousChapter
    ) {
      facts.push(
        buildFact({
          id: `${factId(character.id, field, number)}:change`,
          subject: character.id,
          predicate,
          // 値は空でよい。何に変わったかは、直後の事実が持っている
          value: "",
          chapter,
          kind: "event",
        })
      );
    }

    facts.push(
      buildFact({
        id: factId(character.id, field, number),
        subject: character.id,
        predicate,
        value: change.value,
        chapter,
        kind,
      })
    );
    previousChapter = chapter;
  });

  return facts;
}

interface FactDraft {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  chapter: number | null;
  kind: FactKind;
}

function buildFact(draft: FactDraft): StoryFact {
  return {
    id: draft.id,
    chapter: draft.chapter,
    // 資料に本文の行は無い。話の先頭に置く（並びは話数だけで決まる）
    lineRange: [0, 0],
    subject: draft.subject,
    predicate: draft.predicate,
    value: draft.value,
    kind: draft.kind,
    // **時期IDから相対時期は作らない**（6.88.4。対応表を持たない）
    storyTime: null,
    // 設定資料は地の文相当。作者が確定させた値なので、いちばん強い
    modality: "narration",
    pov: null,
    speaker: null,
    topic: null,
  };
}

/** `changes` の話数。空なら「それ以前」で、話数は分からない */
function chapterOf(change: RecordChange): number | null {
  return change.chapters[0] ?? null;
}

function earliestChapter(chapters: readonly number[]): number | null {
  const valid = chapters.filter((chapter) => Number.isSafeInteger(chapter));
  return valid.length === 0 ? null : Math.min(...valid);
}

function factId(characterId: string, field: string, index: number): string {
  return `fact:${characterId}:${field}:${index}`;
}

function labelOf(field: string): string {
  return CHARACTER_FIELD_LABELS[field] ?? field;
}

function kindOf(field: string): FactKind {
  return STATE_FIELDS.has(field) ? "state" : "static";
}

/**
 * レコード本体の値。
 *
 * **項目ごとに取り出し方を書く。** 文字列のキーでレコードを引くと、
 * 項目が増えたときに型が助けてくれない（`CHARACTER_AS_OF_FIELDS` に
 * 足しただけで黙って `undefined` を読む）。
 */
function currentValue(character: Character, field: string): string | null {
  const readers: Record<string, () => string | null> = {
    summary: () => character.summary,
    role: () => character.role,
    personality: () => character.personality,
    appearance: () => character.appearance,
    gender: () => character.gender,
    affiliation: () => character.affiliation,
  };
  const read = readers[field];
  if (!read) return null;
  const value = read();
  return value !== null && value.trim().length > 0 ? value : null;
}
