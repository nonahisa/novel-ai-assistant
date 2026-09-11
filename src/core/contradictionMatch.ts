import {
  transitionToPersona,
  type SceneIdentity,
} from "../models/identity";
import type {
  FactModality,
  FactPosition,
  IdentityTransition,
  StoryFact,
} from "../models/storyFact";
import {
  buildAttributeIntervals,
  compareFactPosition,
  isFactOrderUnknown,
  orderFacts,
  positionOf,
  type AttributeInterval,
} from "./attributeIntervals";
import { sha1Text } from "./hash";
import { formatRelativeTime } from "./relativeTime";

/**
 * 矛盾の候補を機械だけで挙げる（設計書6.88.6。**LLMを使わない**）。
 *
 * ## なぜ機械なのか
 *
 * いまの矛盾検知（P-12）は本文と設定資料を丸ごとLLMに見せて「食い違いを
 * 挙げよ」と頼んでいる。**精度がモデルの賢さと指示文の言い回しに全部
 * かかっている**ため、締めれば見逃し、緩めれば誤検出で、綱引きから出られない。
 *
 * ここは綱引きの場所を変える。**LLMには「事実」を抜かせ、矛盾は機械が決める。**
 * 機械の照合は確定的で、安く、何度走らせても同じ結果が出る。LLMは最後に、
 * 絞り込まれた候補2か所だけを見て判定する（第4段）。
 *
 * ## 出さないもの
 *
 * **迷ったら出さない。** 「知り得たかどうか分からない」「所要時間の表が無い」
 * ものは候補にしない。誤検出は、作者が本文ではなくこちらの推測を
 * 直しに行かせることになる。
 *
 * VS Code APIに依存しない。
 */

export type CandidateType =
  | "設定"
  | "時系列"
  | "状態"
  | "知識"
  | "視点"
  | "規則";

export type CandidateConfidence = "high" | "medium" | "low";

export interface ContradictionCandidate {
  type: CandidateType;
  subject: string;
  predicate: string;
  /** 前側の事実の id */
  left: string;
  /** 後側の事実の id */
  right: string;
  confidence: CandidateConfidence;
  /** 容認リスト（6.88.8）の鍵。中身が同じなら何度走らせても同じ値になる */
  fingerprint: string;
  /** 作者が読む1文 */
  reason: string;
}

/** 場所どうしの最短の所要日数。**表が無ければ移動の照合はしない**（推測しない） */
export interface TravelTime {
  from: string;
  to: string;
  minDays: number;
}

export interface MatchInput {
  facts: readonly StoryFact[];
  /** 6.88.5。「死亡後の登場」の除外と、組の変化が正当かの判断に使う */
  transitions?: readonly IdentityTransition[];
  /** 場面ごとの肉体・人格・身分の組（6.88.5。第2段） */
  scenes?: readonly SceneIdentity[];
  travelTimes?: readonly TravelTime[];
}

/** 指紋の材料。候補そのものは値を持たないので、作るときに渡す */
export interface FingerprintInput {
  type: CandidateType;
  subject: string;
  predicate: string;
  values: readonly string[];
}

/**
 * 時間にまつわる項目。
 *
 * これらの食い違いは「設定」ではなく「時系列」として出したい——
 * 作者が確かめに行く先が違う（年齢の食い違いは、年表を見ないと直せない）。
 */
const TIME_PREDICATES = ["年齢", "日付", "季節", "曜日", "年号", "時刻"];

/** 所在を表す項目名。移動可能性の照合はこれだけを見る */
const WHEREABOUTS = "所在";

/** 死亡イベントの項目名 */
const DEATH = "死亡";

/** 同一性の食い違いを出すときの項目名（作者が読む言葉） */
const PERSONA = "人格";
const IDENTITY = "身分";

/** 死んだあとに出てきても矛盾にならない遷移（6.88.5） */
const REVIVAL_KINDS: ReadonlyArray<IdentityTransition["kind"]> = [
  "ghost",
  "reincarnation",
  "possession",
];

const CONFIDENCE_ORDER: readonly CandidateConfidence[] = [
  "low",
  "medium",
  "high",
];

/**
 * すべての照合器を通して候補を挙げる。
 *
 * 同じ指紋の候補は1件にまとめる（同じ食い違いを別の照合器が拾うことがある）。
 */
export function findContradictionCandidates(
  input: MatchInput
): ContradictionCandidate[] {
  const intervals = buildAttributeIntervals(input.facts);
  const all = [
    ...findIntervalConflicts(intervals),
    ...findPostDeathAppearances(input.facts, input.transitions ?? []),
    ...findKnowledgeViolations(input.facts),
    ...findTravelImpossibilities(input.facts, input.travelTimes ?? []),
    ...findIdentityDrift(input.scenes ?? [], input.transitions ?? []),
  ];

  const seen = new Set<string>();
  return all.filter((candidate) => {
    if (seen.has(candidate.fingerprint)) return false;
    seen.add(candidate.fingerprint);
    return true;
  });
}

/**
 * 同じ `(subject, predicate)` で、区間が重なっているのに値が違う。
 *
 * 変化イベントがあれば区間が閉じているので重ならない——
 * **「間に変化の記録があるものは除外」は、区間の組み方が既に果たしている。**
 */
export function findIntervalConflicts(
  intervals: readonly AttributeInterval[]
): ContradictionCandidate[] {
  const groups = new Map<string, AttributeInterval[]>();
  for (const interval of intervals) {
    // **所在は区間の重なりで見ない**（本体の判断、0.46.0）。移動は作中で
    // 常に起きるので、変化イベントが無ければ必ず区間が重なり、「状態」の
    // 候補を大量に吐く。所在は移動可能性の照合（`findTravelImpossibilities`）
    // だけが見る——所要時間の表が無ければ何も言わない側へ倒す
    if (interval.predicate === WHEREABOUTS) continue;
    const key = JSON.stringify([interval.subject, interval.predicate]);
    const bucket = groups.get(key);
    if (bucket) bucket.push(interval);
    else groups.set(key, [interval]);
  }

  const candidates: ContradictionCandidate[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) ?? [];
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a.value === b.value) continue;
        if (!overlaps(a, b)) continue;

        const [left, right] =
          compareFactPosition(a.start, b.start) <= 0 ? [a, b] : [b, a];
        const unknownOrder = isFactOrderUnknown(left.start, right.start);
        const type = conflictType(left, right);
        candidates.push(
          buildCandidate({
            type,
            subject: left.subject,
            predicate: left.predicate,
            values: [left.value, right.value],
            left: left.sources[0],
            right: right.sources[0],
            confidence: lowerConfidence(
              confidenceFromModality(left.modality),
              confidenceFromModality(right.modality)
            ),
            unknownOrder,
            reason:
              `${formatPosition(left.start)}に『${left.value}』、` +
              `${formatPosition(right.start)}に『${right.value}』。` +
              `あいだに変化の記録が無い`,
          })
        );
      }
    }
  }
  return candidates;
}

/**
 * 死亡イベントより後に、その人物の事実がある。
 *
 * 回想（`modality: thought`）は外す。幽霊・転生・憑依の遷移が記録されて
 * いるなら、出てくるのは矛盾ではないのでその人物ごと外す。
 *
 * **出すのは死亡後の最初の1件だけ。** そのあと何十回出てこようと、
 * 作者が直すべき場所は同じ1か所である。
 */
export function findPostDeathAppearances(
  facts: readonly StoryFact[],
  transitions: readonly IdentityTransition[] = []
): ContradictionCandidate[] {
  const ordered = orderFacts(facts);

  const deaths = new Map<string, StoryFact>();
  for (const fact of ordered) {
    if (fact.kind !== "event" || fact.predicate !== DEATH) continue;
    if (!deaths.has(fact.subject)) deaths.set(fact.subject, fact);
  }
  if (deaths.size === 0) return [];

  // 死んだあとに遷移が記録されている人物は、そもそも照合しない
  const revived = new Set<string>();
  for (const transition of transitions) {
    if (!REVIVAL_KINDS.includes(transition.kind)) continue;
    const death = deaths.get(transition.subject);
    if (!death) continue;
    if (compareFactPosition(positionOf(death), transition.at) < 0) {
      revived.add(transition.subject);
    }
  }

  const reported = new Set<string>();
  const candidates: ContradictionCandidate[] = [];
  for (const fact of ordered) {
    const death = deaths.get(fact.subject);
    if (!death || fact.id === death.id) continue;
    if (revived.has(fact.subject) || reported.has(fact.subject)) continue;
    // 回想は、死んだあとに書かれていても「死後の登場」ではない
    if (fact.modality === "thought") continue;
    if (compareFactPosition(positionOf(death), positionOf(fact)) >= 0) continue;

    reported.add(fact.subject);
    const unknownOrder = isFactOrderUnknown(
      positionOf(death),
      positionOf(fact)
    );
    candidates.push(
      buildCandidate({
        type: "状態",
        subject: fact.subject,
        predicate: DEATH,
        values: [factLabel(death), factLabel(fact)],
        left: death.id,
        right: fact.id,
        confidence: lowerConfidence(
          confidenceFromModality(death.modality),
          confidenceFromModality(fact.modality)
        ),
        unknownOrder,
        reason:
          `${formatPosition(positionOf(death))}に死亡の記録がある。` +
          `${formatPosition(positionOf(fact))}に『${factLabel(fact)}』が出てくる`,
      })
    );
  }
  return candidates;
}

/**
 * 発言者が、その時点でまだ知らないはずの事柄に触れている。
 *
 * **獲得の記録が無い `topic` は候補にしない。** 知り得たかどうかが
 * 分からないものを矛盾と言わない——ここを緩めると、作中で当然知っている
 * ことまで全部指摘されて使い物にならなくなる。
 */
export function findKnowledgeViolations(
  facts: readonly StoryFact[]
): ContradictionCandidate[] {
  const ordered = orderFacts(facts);

  // (知った人, 何を) ごとに、いちばん早い獲得
  const acquired = new Map<string, StoryFact>();
  for (const fact of ordered) {
    if (fact.kind !== "knowledge" || !fact.topic) continue;
    const key = JSON.stringify([fact.subject, fact.topic]);
    if (!acquired.has(key)) acquired.set(key, fact);
  }
  if (acquired.size === 0) return [];

  const candidates: ContradictionCandidate[] = [];
  for (const fact of ordered) {
    if (fact.modality !== "dialogue" || !fact.speaker || !fact.topic) continue;
    const got = acquired.get(JSON.stringify([fact.speaker, fact.topic]));
    if (!got) continue;
    if (compareFactPosition(positionOf(fact), positionOf(got)) >= 0) continue;

    const unknownOrder = isFactOrderUnknown(positionOf(fact), positionOf(got));
    candidates.push(
      buildCandidate({
        type: "知識",
        subject: fact.speaker,
        predicate: fact.topic,
        values: [factLabel(fact), factLabel(got)],
        left: fact.id,
        right: got.id,
        confidence: lowerConfidence(
          confidenceFromModality(fact.modality),
          confidenceFromModality(got.modality)
        ),
        unknownOrder,
        reason:
          `${formatPosition(positionOf(fact))}で${fact.speaker}が` +
          `『${fact.topic}』に触れているが、知ったのは` +
          `${formatPosition(positionOf(got))}である`,
      })
    );
  }
  return candidates;
}

/**
 * 所要日数より短い間に、別の場所にいる。
 *
 * **所要時間の表が無ければ照合しない。** 作品ごとに地理も移動手段も違う
 * のに、こちらが日数を推測すると、転移門のある作品で毎回誤検出する。
 */
export function findTravelImpossibilities(
  facts: readonly StoryFact[],
  travelTimes: readonly TravelTime[] = []
): ContradictionCandidate[] {
  if (travelTimes.length === 0) return [];

  const table = new Map<string, number>();
  for (const entry of travelTimes) {
    table.set(JSON.stringify([entry.from, entry.to]), entry.minDays);
  }

  const bySubject = new Map<string, StoryFact[]>();
  for (const fact of orderFacts(facts)) {
    if (fact.predicate !== WHEREABOUTS) continue;
    // 時期が読めない事実は、経過日数が出せないので照合しない
    if (!fact.storyTime) continue;
    const bucket = bySubject.get(fact.subject);
    if (bucket) bucket.push(fact);
    else bySubject.set(fact.subject, [fact]);
  }

  const candidates: ContradictionCandidate[] = [];
  for (const key of [...bySubject.keys()].sort()) {
    const list = bySubject.get(key) ?? [];
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1];
      const to = list[i];
      if (from.value === to.value) continue;
      // 道のりは向きで変わらないことが多いので、逆向きも見る
      const minDays =
        table.get(JSON.stringify([from.value, to.value])) ??
        table.get(JSON.stringify([to.value, from.value]));
      if (minDays === undefined) continue;

      const elapsed =
        (to.storyTime?.day ?? 0) - (from.storyTime?.day ?? 0);
      if (elapsed >= minDays) continue;

      candidates.push(
        buildCandidate({
          type: "時系列",
          subject: from.subject,
          predicate: WHEREABOUTS,
          values: [from.value, to.value],
          left: from.id,
          right: to.id,
          confidence: lowerConfidence(
            confidenceFromModality(from.modality),
            confidenceFromModality(to.modality)
          ),
          unknownOrder: isFactOrderUnknown(positionOf(from), positionOf(to)),
          reason:
            `${formatPosition(positionOf(from))}に『${from.value}』、` +
            `${formatPosition(positionOf(to))}に『${to.value}』。` +
            `${minDays}日かかる道のりを${elapsed}日で移っている`,
        })
      );
    }
  }
  return candidates;
}

/**
 * 遷移の記録が無いのに、同じ体で人格（や身分）が変わっている（6.88.5）。
 *
 * **憑依・多重人格・転生・入れ替わりを正当な遷移として表すのが、この照合の
 * 狙いである。** 体と人格を1つのidで持っているかぎり「文佳の体で太志の口調」
 * は必ず矛盾に見え、逆に人格の入れ替わりを全部許すと**入れ替わったまま
 * 元に戻っていない**書き落としが拾えない。遷移を鍵にすると両方が立つ。
 *
 * **記録の無い項目では厳しくしない。** 遷移に `body` が書かれていなければ
 * 体は問わない——抽出が項目を落とした作品で、正当な憑依が矛盾として出る
 * ほうが害が大きい（迷ったら出さない）。
 */
export function findIdentityDrift(
  scenes: readonly SceneIdentity[],
  transitions: readonly IdentityTransition[] = []
): ContradictionCandidate[] {
  const groups = new Map<string, SceneIdentity[]>();
  for (const scene of orderScenes(scenes)) {
    const bucket = groups.get(scene.triple.bodyId);
    if (bucket) bucket.push(scene);
    else groups.set(scene.triple.bodyId, [scene]);
  }

  const candidates: ContradictionCandidate[] = [];
  // 同じ入力なら同じ並びで返す（報告の順が入力の偶然で変わらないように）
  for (const body of [...groups.keys()].sort()) {
    const list = groups.get(body) ?? [];
    for (let i = 1; i < list.length; i += 1) {
      const before = list[i - 1];
      const after = list[i];
      const from = scenePosition(before);
      const to = scenePosition(after);

      if (before.triple.personaId !== after.triple.personaId) {
        const excused = transitions.some(
          (transition) =>
            coversBody(transition, body) &&
            within(transition.at, from, to) &&
            transitionToPersona(transition) === after.triple.personaId
        );
        if (excused) continue;
        candidates.push(
          driftCandidate({
            body,
            predicate: PERSONA,
            noun: "人格",
            before: before.triple.personaId,
            after: after.triple.personaId,
            left: before.source,
            right: after.source,
            from,
            to,
          })
        );
        // **人格が変わっていれば、身分の違いはその結果である。**
        // 両方出すと、作者は同じ1か所を二度直しに行くことになる
        continue;
      }

      if (before.triple.identityId !== after.triple.identityId) {
        const excused = transitions.some(
          (transition) =>
            coversBody(transition, body) &&
            within(transition.at, from, to) &&
            transition.identity === after.triple.identityId
        );
        if (excused) continue;
        candidates.push(
          driftCandidate({
            body,
            predicate: IDENTITY,
            noun: "身分",
            before: before.triple.identityId,
            after: after.triple.identityId,
            left: before.source,
            right: after.source,
            from,
            to,
          })
        );
      }
    }
  }
  return candidates;
}

/**
 * 容認リスト（6.88.8）の鍵。
 *
 * 値は昇順に並べてから混ぜる。**どちらを左に置いたかで指紋が変わると、
 * 「これは意図的」と一度登録したものが次回また出てくる。**
 */
export function fingerprintOf(input: FingerprintInput): string {
  const values = [...input.values].sort();
  return sha1Text(
    [input.type, input.subject, input.predicate, ...values].join("|")
  );
}

/** 作者が「これは意図的」と決めたものを落とす */
export function filterAllowed(
  candidates: readonly ContradictionCandidate[],
  allowed: readonly string[]
): ContradictionCandidate[] {
  const set = new Set(allowed);
  return candidates.filter((candidate) => !set.has(candidate.fingerprint));
}

/** modality を確信度に写す（6.88.3） */
export function confidenceFromModality(
  modality: FactModality
): CandidateConfidence {
  if (modality === "narration") return "high";
  if (modality === "dialogue" || modality === "thought") return "medium";
  return "low";
}

/** 両側のうち低いほうを採る */
export function lowerConfidence(
  a: CandidateConfidence,
  b: CandidateConfidence
): CandidateConfidence {
  return CONFIDENCE_ORDER.indexOf(a) <= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

/** 前後が読めないときに1段下げる */
function downgrade(confidence: CandidateConfidence): CandidateConfidence {
  const index = CONFIDENCE_ORDER.indexOf(confidence);
  return CONFIDENCE_ORDER[Math.max(0, index - 1)];
}

interface CandidateDraft extends FingerprintInput {
  left: string;
  right: string;
  confidence: CandidateConfidence;
  /** 同じ日で前後が読めない組か。候補にはするが、確信度を1段下げる */
  unknownOrder: boolean;
  reason: string;
}

function buildCandidate(draft: CandidateDraft): ContradictionCandidate {
  return {
    type: draft.type,
    subject: draft.subject,
    predicate: draft.predicate,
    left: draft.left,
    right: draft.right,
    confidence: draft.unknownOrder
      ? downgrade(draft.confidence)
      : draft.confidence,
    fingerprint: fingerprintOf(draft),
    reason: draft.unknownOrder
      ? `${draft.reason}。同じ日で前後が読めない`
      : draft.reason,
  };
}

interface DriftDraft {
  body: string;
  predicate: string;
  /** 理由の文に入る言葉（「人格」「身分」） */
  noun: string;
  before: string;
  after: string;
  left: string;
  right: string;
  from: FactPosition;
  to: FactPosition;
}

function driftCandidate(draft: DriftDraft): ContradictionCandidate {
  return buildCandidate({
    // 体の状態が場面のあいだで変わっているので「状態」に入れる。
    // 「設定」に入れると、作者は人物の資料を直しに行ってしまう
    type: "状態",
    subject: draft.body,
    predicate: draft.predicate,
    values: [draft.before, draft.after],
    left: draft.left,
    right: draft.right,
    // 場面の組は地の文から読むもの（誰かの台詞ではない）ので narration 相当
    confidence: confidenceFromModality("narration"),
    unknownOrder: isFactOrderUnknown(draft.from, draft.to),
    reason:
      `${formatPosition(draft.from)}から${formatPosition(draft.to)}のあいだ、` +
      `遷移の記録が無いのに、同じ体で${draft.noun}が` +
      `〈${draft.before}〉から〈${draft.after}〉へ変わっている`,
  });
}

/**
 * 場面を時期順に並べる。
 *
 * **事実の並べ方をそのまま使う**（`orderFacts`）。時期が `null` の場面を
 * 本文の順で挟み込む仕掛け（6.88.4）は、場面でも同じものが要る——
 * ここで別に書くと、事実の並びと場面の並びが静かに食い違う。
 */
function orderScenes(scenes: readonly SceneIdentity[]): SceneIdentity[] {
  const byId = new Map<string, SceneIdentity>();
  const facts: StoryFact[] = scenes.map((scene, index) => {
    const id = `scene:${index}`;
    byId.set(id, scene);
    return {
      id,
      chapter: scene.chapter,
      lineRange: scene.lineRange,
      subject: scene.triple.bodyId,
      predicate: PERSONA,
      value: scene.triple.personaId,
      kind: "state",
      storyTime: scene.storyTime,
      modality: "narration",
      pov: null,
      speaker: null,
      topic: null,
    };
  });

  const ordered: SceneIdentity[] = [];
  for (const fact of orderFacts(facts)) {
    const scene = byId.get(fact.id);
    if (scene) ordered.push(scene);
  }
  return ordered;
}

function scenePosition(scene: SceneIdentity): FactPosition {
  return {
    storyTime: scene.storyTime,
    chapter: scene.chapter,
    line: scene.lineRange[0],
  };
}

/**
 * その遷移は、この体のことか。
 *
 * **体が書かれていなければ「問わない」。** 分からない項目で照合を厳しく
 * すると、抽出が体を落とした作品で正当な憑依が矛盾として出る。
 */
function coversBody(transition: IdentityTransition, body: string): boolean {
  return transition.body === undefined || transition.body === body;
}

/**
 * 2つの場面のあいだに置かれた遷移か。**両端を含める**——遷移は場面の中で
 * 描かれるので、場面の先頭行と同じ位置に記録されることがある。
 */
function within(at: FactPosition, from: FactPosition, to: FactPosition): boolean {
  return compareFactPosition(from, at) <= 0 && compareFactPosition(at, to) <= 0;
}

function conflictType(
  left: AttributeInterval,
  right: AttributeInterval
): CandidateType {
  if (TIME_PREDICATES.some((word) => left.predicate.includes(word))) {
    return "時系列";
  }
  if (left.kind === "state" || right.kind === "state") return "状態";
  return "設定";
}

/**
 * 区間が重なるか。`end` が `null` なら「まだ閉じていない」ので、
 * その先はどこまでも重なる。
 */
function overlaps(a: AttributeInterval, b: AttributeInterval): boolean {
  return startsBeforeEnd(a.start, b.end) && startsBeforeEnd(b.start, a.end);
}

function startsBeforeEnd(start: FactPosition, end: FactPosition | null): boolean {
  if (end === null) return true;
  return compareFactPosition(start, end) < 0;
}

/** 作者に見せる場所の書き方。時期が読めなければ本文の位置で示す */
function formatPosition(position: FactPosition): string {
  if (position.storyTime) return formatRelativeTime(position.storyTime);
  if (position.chapter !== null) {
    return `第${position.chapter}話 ${position.line}行目`;
  }
  return `${position.line}行目`;
}

/** 値が空の事実（死亡イベントなど）は、項目名だけで示す */
function factLabel(fact: StoryFact): string {
  return fact.value.trim().length === 0
    ? fact.predicate
    : `${fact.predicate}＝${fact.value}`;
}
