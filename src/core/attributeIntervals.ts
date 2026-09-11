import type {
  FactModality,
  FactPosition,
  StoryFact,
} from "../models/storyFact";
import {
  compareRelativeTime,
  isOrderUnknown,
  relativeTimeKey,
} from "./relativeTime";

/**
 * 属性を「点」ではなく「区間」で持つ状態表（設計書6.88.6）。
 *
 * ## なぜ区間なのか
 *
 * 「髪の色＝銀」と「髪の色＝黒」が本文に両方あるとき、点で持つと
 * **どちらかが間違い**としか言えない。しかし小説では髪を染めるし、
 * 怪我は治るし、人は引っ越す。**`[開始, 終了) = 値` で持てば、
 * 「12話で髪を切った」という出来事が区間を切り、両方が正しくなる。**
 *
 * 矛盾として出すのは「区間が重なっているのに値が違う」ときだけでよい。
 *
 * ## 変化の記録が無いまま値が変わったら
 *
 * **区間は閉じずに、新しい区間を重ねて始める。** 閉じてしまうと
 * 「12日目は銀、14日目は黒」がきれいに並んでしまい、**矛盾が消える**。
 * 重なりを残しておくことが、そのまま照合の候補になる。
 *
 * VS Code APIに依存しない（LLMも使わない）。
 */

export type { FactPosition };

/** 同じ値が続くあいだの1区間 */
export interface AttributeInterval {
  subject: string;
  predicate: string;
  value: string;
  /**
   * この区間を支えた事実の種類。
   *
   * 候補の型を「設定」と「状態」に振り分けるのに要る（6.88.6）。
   * `static` と `state` が混ざったら `state` を採る——
   * **一度でも「状態」として書かれた属性は、変わりうる属性である。**
   */
  kind: "static" | "state";
  start: FactPosition;
  /** `null` は「まだ閉じていない」。変化イベントに出会うまで開いたまま */
  end: FactPosition | null;
  /** この区間を支える事実の id */
  sources: string[];
  /** 支える事実のうち最も強い modality。確信度の元になる */
  modality: FactModality;
}

/** modality の強さ。地の文の断定がいちばん強い */
const MODALITY_STRENGTH: Record<FactModality, number> = {
  narration: 3,
  dialogue: 2,
  thought: 2,
  rumor: 1,
  lie_suspect: 1,
};

/**
 * `(subject, predicate)` をまとめるための鍵。
 *
 * 区切りは本文に出てこないNUL。空白で繋ぐと「名前に空白のある人物」と
 * 「空白のある項目名」が同じ鍵になる。**ソースには生の制御文字を置かない**
 * ので、エスケープで書く（`test/unit/sourceHygiene.test.ts`）。
 */
const SEPARATOR = "\u0000";

/** 事実の置き場所を取り出す。行は範囲の先頭で代表させる */
export function positionOf(fact: StoryFact): FactPosition {
  return {
    storyTime: fact.storyTime,
    chapter: fact.chapter,
    line: fact.lineRange[0],
  };
}

/**
 * 2つの置き場所の前後。
 *
 * 両方に時期があればそれで比べ、**同じ時期（や順序不明）なら本文の位置**で
 * 決める。時期が片方でも無ければ本文の位置だけで比べる——
 * 時期のあるものと無いものを無理に突き合わせない（6.88.4）。
 */
export function compareFactPosition(a: FactPosition, b: FactPosition): number {
  if (a.storyTime && b.storyTime) {
    const byTime = compareRelativeTime(a.storyTime, b.storyTime);
    if (byTime !== 0) return byTime;
  }
  const chapterA = a.chapter ?? Number.MAX_SAFE_INTEGER;
  const chapterB = b.chapter ?? Number.MAX_SAFE_INTEGER;
  if (chapterA !== chapterB) return chapterA < chapterB ? -1 : 1;
  if (a.line !== b.line) return a.line < b.line ? -1 : 1;
  return 0;
}

/** 同じ日で区分が分からず、前後が読めない組か */
export function isFactOrderUnknown(a: FactPosition, b: FactPosition): boolean {
  if (!a.storyTime || !b.storyTime) return false;
  return isOrderUnknown(a.storyTime, b.storyTime);
}

/**
 * 事実を時期順に並べる。
 *
 * **時期が `null` の事実は、話数と行の順で挟み込む**（6.88.4）。
 * やり方は「本文の順に並べてから、直前にあった『時期の分かる事実』の
 * 目盛りを借りる」。こうすると、時期の分かるものどうしは時期で並び、
 * 分からないものは**書かれた場所のとおりの位置**に収まる。
 *
 * 目盛りを借りられる事実が前に1つも無ければ、いちばん前に置く。
 */
export function orderFacts(facts: readonly StoryFact[]): StoryFact[] {
  const indexed = facts.map((fact, index) => ({ fact, index }));

  // まず本文の順。話数が分からないものは、並びを乱さないよう末尾へ回す
  const byText = [...indexed].sort((a, b) => {
    const chapterA = a.fact.chapter ?? Number.MAX_SAFE_INTEGER;
    const chapterB = b.fact.chapter ?? Number.MAX_SAFE_INTEGER;
    if (chapterA !== chapterB) return chapterA - chapterB;
    const lineA = a.fact.lineRange[0];
    const lineB = b.fact.lineRange[0];
    if (lineA !== lineB) return lineA - lineB;
    return a.index - b.index;
  });

  const keys = new Map<number, number>();
  const ranks = new Map<number, number>();
  let lastKey = Number.NEGATIVE_INFINITY;
  byText.forEach((entry, rank) => {
    if (entry.fact.storyTime) lastKey = relativeTimeKey(entry.fact.storyTime);
    keys.set(entry.index, lastKey);
    ranks.set(entry.index, rank);
  });

  return [...byText]
    .sort((a, b) => {
      const keyA = keys.get(a.index) ?? 0;
      const keyB = keys.get(b.index) ?? 0;
      if (keyA !== keyB) return keyA < keyB ? -1 : 1;
      return (ranks.get(a.index) ?? 0) - (ranks.get(b.index) ?? 0);
    })
    .map((entry) => entry.fact);
}

/**
 * 事実から区間の状態表を組む。
 *
 * `static` と `state` の事実を `(subject, predicate)` ごとに集め、時期順に
 * 並べて区間にする。同じ `(subject, predicate)` の `event`（「髪を切った」）
 * に出会ったら、その位置で開いている区間を全部閉じる。
 */
export function buildAttributeIntervals(
  facts: readonly StoryFact[]
): AttributeInterval[] {
  const groups = new Map<string, StoryFact[]>();
  for (const fact of orderFacts(facts)) {
    if (fact.kind === "knowledge") continue;
    const key = `${fact.subject}${SEPARATOR}${fact.predicate}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(fact);
    else groups.set(key, [fact]);
  }

  const result: AttributeInterval[] = [];
  // 同じ入力なら同じ並びで返す（報告の順が入力の偶然で変わらないように）
  for (const key of [...groups.keys()].sort()) {
    result.push(...buildGroup(groups.get(key) ?? []));
  }
  return result;
}

function buildGroup(facts: readonly StoryFact[]): AttributeInterval[] {
  const created: AttributeInterval[] = [];
  let open: AttributeInterval[] = [];

  for (const fact of facts) {
    const position = positionOf(fact);

    if (fact.kind === "event") {
      // 変化の記録。ここで区間を閉じ、次の値から新しい区間が始まる
      for (const interval of open) interval.end = position;
      open = [];
      continue;
    }

    const same = open.find((interval) => interval.value === fact.value);
    if (same) {
      // 同じ値が続くあいだは1つの区間。支える事実だけを足す
      same.sources.push(fact.id);
      if (MODALITY_STRENGTH[fact.modality] > MODALITY_STRENGTH[same.modality]) {
        same.modality = fact.modality;
      }
      if (fact.kind === "state") same.kind = "state";
      continue;
    }

    // 変化の記録が無いのに値が変わった。**閉じずに重ねる**（重なり＝候補）
    const interval: AttributeInterval = {
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      kind: fact.kind === "state" ? "state" : "static",
      start: position,
      end: null,
      sources: [fact.id],
      modality: fact.modality,
    };
    created.push(interval);
    open.push(interval);
  }

  return created;
}
