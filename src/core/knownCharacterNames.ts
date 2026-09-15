import type { ExtractedCharacter } from "../prompts/characterExtract";

/**
 * 抽出のプロンプトへ渡す「既にいる人物の名前」を組み立てる。
 *
 * **`features/extractCharacters.ts` から移した**（0.64.3）。MCP から
 * 同じプロンプトを組むのに要るが、`features` は `vscode` に依存していて
 * 届かない。**写しを置けば、片方だけが直る日が必ず来る**——
 * `TYPO_DICTIONARY_LIMIT` を `prompts/` へ移したのと同じ考えである。
 *
 * VS Code APIに依存しない。
 */

/** プロンプトへ渡す人数の上限。**名前の件数ではなく、人で数える** */
const KNOWN_CHARACTER_PEOPLE_LIMIT = 100;
/**
 * プロンプトへ渡す名前の総数の上限。
 *
 * 人数で切っても、別名の多い作品では名前の数が2倍以上に伸びる
 * （21人の作品で46件＝2.2倍）。入力が際限なく膨らまないよう、
 * 総数にも歯止めを置く。**溢れたら別名から落とす**（下記）。
 */
const KNOWN_CHARACTER_NAME_LIMIT = 200;

/** 既知の人物を、人ごとにまとめる（同じ名前は1人に畳む） */
function collectKnownPeople(
  existing: Array<{ name: string; aliases: string[] }>,
  extracted: Array<{ data: ExtractedCharacter }>
): Array<{ name: string; aliases: string[] }> {
  const people = new Map<string, { name: string; aliases: string[] }>();

  const add = (rawName: string, rawAliases: readonly string[]): void => {
    const name = rawName.trim();
    if (!name) return;
    let person = people.get(name);
    if (!person) {
      person = { name, aliases: [] };
      people.set(name, person);
    }
    for (const raw of rawAliases) {
      const alias = raw.trim();
      if (!alias || alias === name) continue;
      if (!person.aliases.includes(alias)) person.aliases.push(alias);
    }
  };

  for (const character of existing) add(character.name, character.aliases);
  for (const item of extracted) {
    add(
      item.data.name,
      Array.isArray(item.data.aliases) ? item.data.aliases : []
    );
  }

  return [...people.values()];
}

/**
 * プロンプトへ渡す既知名を、**人数で**上限まで採る。
 *
 * ## なぜ人数で数えるか（2026-09-11）
 *
 * 以前は「名前＋別名」を1件ずつ数えて100件で切っていた。別名を持つ人が
 * 多いと**人数の2倍以上**になり（21人の作品で46件）、50人を超える作品では
 * **後ろの人物が丸ごと落ちて**同一人物の判定が効かなくなる。落ちるのは
 * 一覧の後ろ＝新しく出てきた人物なので、**いちばん取り違えやすい人**から
 * 消えていた。
 *
 * ## 溢れたら別名から落とす
 *
 * 総数の歯止め（`KNOWN_CHARACTER_NAME_LIMIT`）に当たったときは、**本名を
 * 最後まで残し、別名を後ろの人から落とす。** 本名が無ければその人物の存在
 * ごと伝わらないが、別名が1つ欠けても「同じ人かもしれない」の手掛かりが
 * 1つ減るだけで済む。
 */
export function buildKnownCharacterNamesForPrompt(
  existing: Array<{ name: string; aliases: string[] }>,
  extracted: Array<{ data: ExtractedCharacter }>
): string[] {
  const people = collectKnownPeople(existing, extracted).slice(
    0,
    KNOWN_CHARACTER_PEOPLE_LIMIT
  );

  // 本名は先に全部押さえる。別名が席を埋めて本名が落ちることが無いように
  const emitted = new Set(people.map((person) => person.name));
  let budget = Math.max(0, KNOWN_CHARACTER_NAME_LIMIT - emitted.size);

  const kept = new Map<string, string[]>();
  for (const person of people) {
    const aliases: string[] = [];
    for (const alias of person.aliases) {
      if (budget <= 0) break;
      // 他の人の本名や、既に出した別名は重ねない
      if (emitted.has(alias)) continue;
      emitted.add(alias);
      aliases.push(alias);
      budget--;
    }
    kept.set(person.name, aliases);
  }

  // 本名と別名は隣り合わせで渡す（AIが「同じ人の呼び方」と読めるように）
  return people.flatMap((person) => [
    person.name,
    ...(kept.get(person.name) ?? []),
  ]);
}
