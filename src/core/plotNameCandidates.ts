import { NAME_ORIGINS, type NameCandidate, type NameOrigin } from "../prompts/nameSuggest";
import { fitNameCandidates, type NameOriginPlan } from "./nameOriginFit";
import { screenNameCandidates, type NameEntry } from "./nameCollision";
import { classifyRoleName } from "./plotRoleNames";

/**
 * プロットの名前の候補（P-45）を、人物ごとに揃えて絞る（設計書6.4.8
 * 「名前の候補を出す」）。**AIの答えを信用しない**（実装ルール3）。
 *
 * 順に次を通す。落としたものは**理由つきで残す**（黙って減らさない）。
 *
 * 1. **系統を全員で1つに決める**。1つに決まっていればそれ、AIが名乗った
 *    系統が選択肢にあればそれ、無ければ全員の候補の系統の多数。
 *    人物ごとに決めると、主人公は和風・ヒロインは北欧、と割れる
 * 2. 系統と表記を揃える（`fitNameCandidates`。P-29 と同じ検算）
 * 3. 読みを揃える。**読みが無い名前は落とす**——資料には読みつきで置く約束で、
 *    漢字の名前は読みが無いと響きの重なりも確かめられない。カタカナの名前は
 *    表記から読みを作れるので落とさない
 * 4. 役名そのもの（「主人公」「魔物」）は名前ではないので落とす
 * 5. 既にある名前と、**先の人物に残した候補**と響きが重なるものを落とす
 *    （`screenNameCandidates`）。作者は1人に1つ選ぶので、どれを選んでも
 *    ほかの人物の候補と重ならないように、先の人物から順に確定させる
 *
 * VS Code API に依存しない（単体テストの対象）。
 */

export interface PlotNameDrop {
  name: string;
  reason: string;
}

export interface ScreenedPlotPerson {
  id: string;
  kept: NameCandidate[];
  dropped: PlotNameDrop[];
}

export interface ScreenedPlotNames {
  people: ScreenedPlotPerson[];
  /** 揃えた系統。決まらなければ undefined */
  origin?: NameOrigin;
  /** 英字からカタカナに直した名前（P-29 と同じく作者へ見せる） */
  converted: Array<{ from: string; to: string }>;
}

const HIRAGANA_READING = /^[\p{Script=Hiragana}ー・\s]+$/u;
const KATAKANA_NAME = /^[\p{Script=Katakana}ー・･＝=\s]+$/u;

function isOrigin(value: string): value is NameOrigin {
  return (NAME_ORIGINS as readonly string[]).includes(value);
}

/** カタカナをひらがなに（`toKatakana` の逆向き） */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

/** 全員で揃える系統。`decideOrigin`（nameOriginFit）と同じ順で決める */
function decideBatchOrigin(
  people: ReadonlyArray<{ candidates: readonly NameCandidate[] }>,
  plan: NameOriginPlan,
  declared: string
): NameOrigin | undefined {
  if (plan.choices.length === 1) return plan.choices[0];
  if (isOrigin(declared) && plan.choices.includes(declared)) return declared;
  const counts = new Map<NameOrigin, number>();
  for (const person of people) {
    for (const candidate of person.candidates) {
      if (isOrigin(candidate.origin) && plan.choices.includes(candidate.origin)) {
        counts.set(candidate.origin, (counts.get(candidate.origin) ?? 0) + 1);
      }
    }
  }
  let best: NameOrigin | undefined;
  for (const [origin, count] of counts) {
    if (best === undefined || count > (counts.get(best) ?? 0)) best = origin;
  }
  return best;
}

/**
 * 読みを揃える。ひらがなならそのまま、カタカナで返ったらひらがなへ、
 * 無ければカタカナの名前から作る。**作れなければ undefined**
 */
function settleReading(candidate: NameCandidate): string | undefined {
  const given = candidate.reading.trim();
  if (given) {
    const hiragana = toHiragana(given);
    if (HIRAGANA_READING.test(hiragana)) return hiragana.replace(/\s+/gu, " ");
  }
  if (KATAKANA_NAME.test(candidate.name)) {
    return toHiragana(candidate.name).replace(/[・･＝=]/gu, " ").trim();
  }
  return undefined;
}

/**
 * @param people 人物ごとの候補（AIの答え。人物の並び順に渡す——先の人物が優先される）
 * @param existing 既にある名前（人物・場所・組織・能力）
 * @param declared AIが名乗った系統（答えの頭の `origin`）
 */
export function screenPlotNameCandidates(
  people: ReadonlyArray<{
    id: string;
    /** 落とした理由に出す呼び名（役名）。無ければ id */
    label?: string;
    candidates: readonly NameCandidate[];
  }>,
  plan: NameOriginPlan,
  existing: readonly NameEntry[],
  declared = ""
): ScreenedPlotNames {
  const origin = decideBatchOrigin(people, plan, declared);
  // 全員を同じ系統で確かめる（1つに絞った計画を渡す）
  const fixedPlan: NameOriginPlan = origin ? { ...plan, choices: [origin] } : plan;
  const accepted: NameEntry[] = [];
  /** 残した候補の名前 → どの人物の候補か */
  const ownerOf = new Map<string, string>();
  const converted: Array<{ from: string; to: string }> = [];
  const result: ScreenedPlotPerson[] = [];

  for (const person of people) {
    const dropped: PlotNameDrop[] = [];
    const fitted = fitNameCandidates(person.candidates, fixedPlan, origin);
    converted.push(...fitted.converted);
    for (const entry of fitted.dropped) {
      dropped.push({ name: entry.candidate.name, reason: entry.reason });
    }

    const readable: NameCandidate[] = [];
    for (const candidate of fitted.kept) {
      if (classifyRoleName(candidate.name)?.kind === "role") {
        dropped.push({ name: candidate.name, reason: "役割を表す言葉で、名前ではありません" });
        continue;
      }
      const reading = settleReading(candidate);
      if (!reading) {
        dropped.push({
          name: candidate.name,
          reason: "ひらがなの読みが返らなかったため、響きを確かめられません",
        });
        continue;
      }
      readable.push({ ...candidate, reading });
    }

    const screened = screenNameCandidates(readable, [...existing, ...accepted]);
    for (const entry of screened.dropped) {
      // 相手がほかの人物の候補なら、そう添える（資料にある名前と見分けが付かない）
      const owner = [...ownerOf].find(([name]) => entry.reason.startsWith(`「${name}」`));
      dropped.push({
        name: entry.candidate.name,
        reason: owner ? `${entry.reason}。相手は「${owner[1]}」の候補です` : entry.reason,
      });
    }
    screened.kept.forEach((candidate, index) => {
      accepted.push({
        id: `plot-name:${person.id}:${index}`,
        kind: "character",
        name: candidate.name,
        reading: candidate.reading,
      });
      ownerOf.set(candidate.name, person.label ?? person.id);
    });
    result.push({ id: person.id, kept: screened.kept, dropped });
  }

  return { people: result, origin, converted };
}

