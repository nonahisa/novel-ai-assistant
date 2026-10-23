/**
 * 矛盾検知の「あとで判明する事実」（設計書6.10.4）の一覧と、その事実から来た指摘の
 * 「この設定が分かる話」（6.10.5）。
 *
 * **文面だけでなく、組み立てた事実の一覧も持ち回る**（作者の裁定 2026-10-19 夜「A+C」）。
 * 以前は文面（文字列）だけを返していたので、確かめの段（P-12b）は話数を `settingSays`
 * の文から引くしかなかった。AI が言い換えたり（「瀬戸は元刑事で、…」）、頭に
 * 「あとの話で判明する事実：…」を付けたりすると空になり、小さいモデルには
 * 「この話より後で明かされる設定だという記録はありません」と、事実と逆の案内が渡った。
 *
 * **`vscode` を持ち込まない**（MCP の束や測定の台本からも呼べるように。
 * `test/unit/cross/mcpReach.test.ts` が見張る）。
 */

import { factsRevealedAfter } from "./settingsAsOf";
import { CHARACTER_AS_OF_FIELDS } from "./contradictionMaterial";
import {
  lookupSettingKnownAt,
  type KnownAtEntry,
  type KnownAtScope,
} from "./contradictionValidation";

/**
 * 項目の名前を、作者に読める言葉にする（`features/checkContradictions.ts` から移した。
 * 中身は1文字も変えていない）。
 *
 * `core/characterFieldLabels.ts` の表とは別に持つ。あちらには `region`・`description`
 * が無く、こちらの文面（＝検出の段へ送る「あとの話で判明する事実」の欄）を変えると、
 * 文面を鍵に含めない `contradiction_future` の控えに、別の材料で得た答えが混ざる。
 */
export const FUTURE_FACT_FIELD_LABELS: Record<string, string> = {
  summary: "紹介",
  role: "役割",
  personality: "性格",
  speechStyle: "口調",
  appearance: "外見",
  gender: "性別",
  affiliation: "所属",
  region: "地域",
  description: "説明",
};

/** 一覧に載せる人物の形。製品の `Character` をそのまま渡せる */
export interface FutureFactPerson {
  name: string;
  aliases?: readonly string[];
}

/** あとの話で判明する事実の1件（文面の1行と対になる） */
export interface FutureFactEntry {
  /** 持ち主の名前 */
  owner: string;
  /** 持ち主の別名（話数を名前で絞るのに使う） */
  aliases: readonly string[];
  /** 項目（`summary` など） */
  field: string;
  /** 項目の読める名前（「紹介」など） */
  label: string;
  value: string;
  /** 何話で判明するか */
  chapter: number;
}

export interface FutureFactsList {
  /** 検出の段へ送る文面。無ければ空文字 */
  text: string;
  /** 文面に載せた事実（`text` の行と同じ並び・同じ件数） */
  facts: readonly FutureFactEntry[];
}

export const EMPTY_FUTURE_FACTS: FutureFactsList = { text: "", facts: [] };

/** 一覧の上限。**多すぎると、1件ずつの吟味が薄まる** */
const MAX_FUTURE_FACTS = 20;

/**
 * その本文より**あと**で判明する事実を組む（設計書6.10.4）。
 *
 * @param people 本文に出た人物（索引で見つけた順。同じ人が何度出てもよい）
 * @param chapter その本文が何話か。分からなければ空
 *
 * 文面は直す前（`checkContradictions.ts` の `futureFactsFor`）と1バイトも変えない。
 */
export function buildFutureFacts<T extends FutureFactPerson>(
  people: readonly T[],
  chapter: number | null
): FutureFactsList {
  if (chapter === null) return EMPTY_FUTURE_FACTS;
  const lines: string[] = [];
  const facts: FutureFactEntry[] = [];
  for (const person of people) {
    for (const fact of factsRevealedAfter(person, CHARACTER_AS_OF_FIELDS, chapter)) {
      const label = FUTURE_FACT_FIELD_LABELS[fact.field] ?? fact.field;
      const entry: FutureFactEntry = {
        owner: person.name,
        aliases: person.aliases ?? [],
        field: fact.field,
        label,
        value: fact.value,
        chapter: fact.chapter,
      };
      const line = futureFactLine(entry);
      if (lines.includes(line)) continue;
      lines.push(line);
      facts.push(entry);
    }
  }
  return {
    text: lines.slice(0, MAX_FUTURE_FACTS).join("\n"),
    facts: facts.slice(0, MAX_FUTURE_FACTS),
  };
}

/**
 * 事実の1行。**検出の段へ送った一覧の行と同じ書式**（確かめの段へも同じ文を渡す。
 * 書式を2つ持つと、片方だけ直ってずれる）
 */
export function futureFactLine(fact: FutureFactEntry): string {
  return `${fact.owner}の${fact.label}（第${fact.chapter}話で判明）: ${fact.value}`;
}

/** 話数を引くのに見る、指摘の欄（`AcceptedContradiction` の一部） */
export interface FutureIssueFields {
  settingSays: string;
  note: string;
}

/**
 * 「あとで判明する事実」から来た指摘の、「この設定が分かる話」を引く（P-12b 1.3）。
 * 決められなければ空配列。
 *
 * 次の順で決める（作者の裁定 2026-10-19 夜「C」）。
 * 1. `settingSays`・`note` に書き写された「（第N話で判明）」
 * 2. 事実の一覧から、`lookupSettingKnownAt` と同じ考え方で引く
 * 3. 文に名前が出た人物で1つの話に絞れれば、その話
 * 4. 決められなければ空
 *
 * 1字の名前（「渚」）も3では見る。一覧に載るのはこの本文に出た人物の、あとで判明する
 * 事実だけなので、別の人を指す取り違えは起きにくい（`lookupSettingKnownAt` が2字未満を
 * 見ないのは、作品の全人物の索引を引くため）。
 */
export function lookupFutureKnownAt(
  issue: FutureIssueFields,
  facts: readonly FutureFactEntry[],
  scope?: KnownAtScope
): number[] {
  const written = writtenRevealChapters(issue.settingSays);
  if (written.length > 0) return written;
  const inNote = writtenRevealChapters(issue.note);
  if (inNote.length > 0) return inNote;
  if (facts.length === 0) return [];

  const entries: KnownAtEntry[] = facts.map((fact) => ({
    field: fact.field,
    value: fact.value,
    chapters: [fact.chapter],
    owners: [fact.owner, ...fact.aliases],
    // 話の絞り込み（その話に出ている人）は使わない。一覧の人はみなこの本文に出ている
    appeared: [],
    fromChanges: true,
  }));
  const byValue = lookupSettingKnownAt({ entries }, issue.settingSays, scope);
  if (byValue.length > 0) return byValue;

  const named = factsOfNamedOwners(facts, issue.settingSays);
  const owned = named.length > 0 ? named : factsOfNamedOwners(facts, scope?.alsoText ?? "");
  const chapters = [...new Set(owned.map((fact) => fact.chapter))];
  return chapters.length === 1 ? chapters : [];
}

/** `lookupFutureKnownAt` の結果を、確かめのプロンプトへ書く形にする。引けなければ空文字 */
export function describeFutureKnownAt(
  issue: FutureIssueFields,
  facts: readonly FutureFactEntry[],
  scope?: KnownAtScope
): string {
  return lookupFutureKnownAt(issue, facts, scope)
    .map((at) => `第${at}話`)
    .join("、");
}

/** 「第N話で判明」と書き写された話数（全角の数字も読む）。昇順 */
function writtenRevealChapters(text: string): number[] {
  const found = new Set<number>();
  for (const match of toHalfWidthDigits(text).matchAll(/第\s*(\d+)\s*話で判明/g)) {
    const at = Number(match[1]);
    if (Number.isFinite(at) && at > 0) found.add(at);
  }
  return [...found].sort((a, b) => a - b);
}

function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0)
  );
}

function factsOfNamedOwners(
  facts: readonly FutureFactEntry[],
  text: string
): FutureFactEntry[] {
  const haystack = text.replace(/\s+/g, "");
  if (!haystack) return [];
  return facts.filter((fact) =>
    [fact.owner, ...fact.aliases].some((name) => {
      const compact = name.replace(/\s+/g, "");
      return compact.length > 0 && haystack.includes(compact);
    })
  );
}

/** 照らした事実を選ぶのに見る、指摘の欄 */
export interface FutureIssueMaterial extends FutureIssueFields {
  excerpt: string;
  textSays: string;
}

/**
 * future の指摘が照らした「あとの話で判明する事実」を、一覧から選ぶ（P-12b 1.4、
 * 作者の裁定「事実の文を渡す」2026-10-23）。一覧が空なら空配列。
 *
 * **AI の書いた `settingSays` の文を、照らした事実の代わりにしない。** 台Bで 26b は
 * 本当の食い違い（第5話の「四十歳まで東京で教師」）を note に書き、settingSays には
 * 「宗一は七十八歳である。」と書いた。確かめの段がその文と本文だけを比べて消した。
 *
 * 選び方：
 * 1. 持ち主を絞る——`settingSays`・`note`・引用と本文の欄の順に、名前（別名を含む）が
 *    出た人の事実。どこにも出なければ一覧の全部
 * 2. 話数（`lookupFutureKnownAt`）が決まれば、その話の事実に絞る。持ち主の中に
 *    その話の事実が無ければ、一覧からその話の事実を取る
 *
 * **絞れないときに空にしない。** 一覧はこの本文に出た人物の、あとで判明する事実だけ
 * （20件まで）で、検出の段が見たのと同じものである。
 */
export function selectFutureFactsForIssue(
  issue: FutureIssueMaterial,
  facts: readonly FutureFactEntry[],
  scope?: KnownAtScope
): FutureFactEntry[] {
  if (facts.length === 0) return [];
  const owned = [
    issue.settingSays,
    issue.note,
    scope?.alsoText ?? `${issue.excerpt}\n${issue.textSays}`,
  ]
    .map((text) => factsOfNamedOwners(facts, text))
    .find((found) => found.length > 0);
  const pool = owned ?? [...facts];
  const chapters = lookupFutureKnownAt(issue, facts, scope);
  if (chapters.length > 0) {
    const inPool = pool.filter((fact) => chapters.includes(fact.chapter));
    if (inPool.length > 0) return inPool;
    const inList = facts.filter((fact) => chapters.includes(fact.chapter));
    if (inList.length > 0) return inList;
  }
  return pool;
}

/** `selectFutureFactsForIssue` の結果を、確かめのプロンプトへ書く行にする */
export function futureFactLinesForIssue(
  issue: FutureIssueMaterial,
  facts: readonly FutureFactEntry[],
  scope?: KnownAtScope
): string[] {
  return selectFutureFactsForIssue(issue, facts, scope).map(futureFactLine);
}
