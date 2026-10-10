import type { Character } from "../models/character";
import { DESCRIPTIVE_ROLE_WORDS, FIRST_PERSON_PRONOUN_WORDS } from "./genericPersonWords";
import { narrationFirstPersonOf } from "./workStyleFacts";

/**
 * 名前の出てこない一人称の語り手を、「語り手（僕）」という記録にする
 * （作者の裁定、2026-10-10「『語り手（僕）』で登録」。設計書6.10.6）。
 *
 * 一人称の作品では、語り手が最後まで名乗らないことがある。抽出は「僕」という
 * 名前で返し、検算は代名詞として捨てる（「僕」という名前の人物が台帳に入ると、
 * 誰の台詞の「僕」でも引き当たって壊れる）。捨てる判定そのものは正しいが、
 * 語り手が台帳にいないと、語り手を手がかりにする機能——語り手の決定
 * （`narrator.ts`）・推敲の視点・名前のよじれ（設計書6.9.2）・矛盾検知の
 * 一人称——がその作品ではどれも働かない（「肉片とラジオと心霊現象」で発生）。
 *
 * そこで**名前の代わりに「語り手（僕）」を名乗らせ、一人称の欄に「僕」を入れる。**
 * 語り手の決定は一人称の欄で人物を選ぶので、名前が仮でも選べる。
 * 作者があとで本当の名前を付けられるよう、**仮の名前であることの印**
 * （`Character.unnamedNarrator`）を記録に残す。印は名前を付け直しても消さない
 * ——次の抽出も「僕」で返ってくるので、印が無いと同じ語り手がまた作られる。
 *
 * VS Code に依存しない（製品の抽出と MCP の抽出が同じものを通る）。
 */

const NAME_PREFIX = "語り手";
const NAME_PATTERN = /^語り手（(.+)）$/u;

/**
 * 語り手を指していると読める説明的な名前。
 * **「ヒロイン」「相手」などは入れない**——一人称の作品でも、語り手ではない
 * 人物をそう呼ぶことがある。
 */
const NARRATOR_ROLE_NAMES: ReadonlySet<string> = new Set(
  ["語り手", "話者", "主人公", "主役"].filter((word) =>
    DESCRIPTIVE_ROLE_WORDS.includes(word)
  )
);

const FIRST_PERSONS: ReadonlySet<string> = new Set(FIRST_PERSON_PRONOUN_WORDS);

/**
 * そのチャンクの地の文に、語り手の一人称が最低これだけ出ていること。
 *
 * 1回では決めない——三人称の地の文にも、心の声の「僕」が1つ混じることはある。
 * 作品全体での決定（`detectFirstPerson` の10回）より緩いのは、チャンクが
 * 1話ぶんで短いから（作者の作品は1話に3〜6回）。
 */
const MIN_NARRATION_HITS = 2;

/** 一人称から、仮の名前を作る（「僕」→「語り手（僕）」） */
export function unnamedNarratorName(firstPerson: string): string {
  return `${NAME_PREFIX}（${firstPerson}）`;
}

/** 仮の名前なら、その一人称を返す。仮の名前でなければ null */
export function firstPersonOfUnnamedNarratorName(name: string): string | null {
  const matched = NAME_PATTERN.exec(name.trim());
  return matched ? matched[1] : null;
}

/**
 * 名前がまだ仮のままか。
 *
 * **印ではなく名前で見る。** 印は作者が名前を付けたあとも残すので、印で
 * 判断すると、付けた名前（「佐藤は」）のよじれまで探さなくなる。
 */
export function hasUnnamedNarratorName(person: Pick<Character, "name">): boolean {
  return firstPersonOfUnnamedNarratorName(person.name) !== null;
}

/**
 * 抽出の答えの1件が「名前の決められない語り手」なら、その一人称を返す。
 * そうでなければ null（今までどおり、捨てるか通常の人物として扱う）。
 *
 * 次の全部が揃ったときだけ語り手とみる。
 *
 * 1. 名前が一人称の代名詞（「僕」）、語り手を指す説明的な名前
 *    （「語り手」「主人公」）でAIが一人称を添えている、または仮の名前
 *    （既知名として見せた「語り手（僕）」で返ってきた）
 * 2. **そのチャンクの地の文が、その一人称で語られている**
 *    （`narrationFirstPersonOf`）。台詞で「俺」と名乗る脇役や、「私」で語る
 *    作品に出た「主人公（俺）」を語り手にしないため
 *
 * 二人称・三人称の代名詞（「あんた」「彼」）は一人称ではないので通らない。
 */
export function unnamedNarratorFirstPerson(
  candidate: { name: string; firstPerson?: string | null },
  chunkText: string
): string | null {
  const bare = candidate.name.replace(/[\s　]/gu, "");
  const declared = candidate.firstPerson?.replace(/[\s　]/gu, "") ?? "";
  let firstPerson = firstPersonOfUnnamedNarratorName(bare);
  if (firstPerson === null) {
    if (FIRST_PERSONS.has(bare)) {
      firstPerson = bare;
    } else if (NARRATOR_ROLE_NAMES.has(bare) && FIRST_PERSONS.has(declared)) {
      firstPerson = declared;
    }
  }
  if (firstPerson === null) return null;

  const narration = narrationFirstPersonOf(chunkText, MIN_NARRATION_HITS);
  return narration?.word === firstPerson ? firstPerson : null;
}

/** その人物が使う一人称（既定と言い分け）。`detectNarrator` と同じ集め方 */
function firstPersonsOf(person: Character): string[] {
  return [
    person.firstPerson.default ?? "",
    ...person.firstPerson.variants.map((variant) => variant.form),
  ]
    .map((form) => form.trim())
    .filter(Boolean);
}

/**
 * 完了報告へ添える文面。**作ったものも、置けなかったものも無ければ空文字**。
 *
 * 作ったことを言うのは、作者が見ていない人物が台帳に増えるからである
 * （黙って増やしたことにしない）。名前を付け直せることもここで言う。
 * 先頭を改行で始めるのは、`buildExtractionSummary` の他の明細と揃えるため。
 */
export function describeUnnamedNarratorOutcome(
  created: readonly string[],
  unplaced: ReadonlyArray<{ firstPerson: string; candidates: string[] }>
): string {
  const lines: string[] = [];
  for (const name of created) {
    lines.push(
      `名前の出てこない地の文の語り手を「${name}」として登録しました。` +
        "名前が分かったら、設定資料で付け直せます。"
    );
  }
  for (const entry of unplaced) {
    lines.push(
      `地の文の語り手（一人称「${entry.firstPerson}」）は、同じ一人称の人物が` +
        `${entry.candidates.length}人いて（${entry.candidates.join("・")}）` +
        "どの人か決められないため、登録しませんでした。"
    );
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/** 語り手の候補をどこへ置くか（`placeUnnamedNarrator` の答え） */
export type UnnamedNarratorPlacement =
  /** 既存の記録へ寄せる（更新。既存なら承認待ちへ回る） */
  | { kind: "existing"; match: Character }
  /** 新しく作る */
  | { kind: "create" }
  /** 同じ一人称の人物が2人以上いて決められない。作らずに報告する */
  | { kind: "ambiguous"; candidates: Character[] };

/**
 * 語り手の候補を、台帳のどこへ置くかを決める（**重複を作らないため**）。
 *
 * 1. 印があって一人称が同じ記録（作者が名前を付け直したものも含む）
 * 2. 名前が同じ仮の名前の記録（作者が手で作ったものなど、印の無いもの）
 * 3. 同じ一人称を使う人物が**ちょうど1人**——`detectNarrator` が語り手として
 *    選ぶのと同じ人なので、そこへ寄せる。ここで新しく作ると、同じ一人称の
 *    人物が2人になって語り手を決められなくなる
 * 4. 2人以上なら決められないので作らない（どれが語り手か分からない）
 * 5. 誰もいなければ新しく作る
 *
 * モブ（集団名詞）は語り手にならないので数えない。
 */
export function placeUnnamedNarrator(
  people: readonly Character[],
  firstPerson: string
): UnnamedNarratorPlacement {
  const marked = people.find(
    (person) => person.unnamedNarrator?.firstPerson === firstPerson
  );
  if (marked) return { kind: "existing", match: marked };

  const placeholder = unnamedNarratorName(firstPerson);
  const sameName = people.find(
    (person) => person.name.replace(/[\s　]/gu, "") === placeholder
  );
  if (sameName) return { kind: "existing", match: sameName };

  const users = people.filter(
    (person) => !person.isMob && firstPersonsOf(person).includes(firstPerson)
  );
  if (users.length === 1) return { kind: "existing", match: users[0] };
  if (users.length > 1) return { kind: "ambiguous", candidates: users };
  return { kind: "create" };
}
