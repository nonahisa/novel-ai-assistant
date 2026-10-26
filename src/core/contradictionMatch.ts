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
import { canonicalPredicate, isExclusivePredicate } from "./predicateArity";
import { formatRelativeTime } from "./relativeTime";
import type { SceneClockReading } from "./sceneClock";
import { statesBeforeEvents } from "./stateFromEvent";

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
  /**
   * 設定資料の側の根拠（本文の事実の外から持ってきたもの）。判定（P-12b）の
   * 「設定では」に添える。
   *
   * **移動の照合で要る。** 判定は所要時間を知らないので、「翌朝という時間の経過で
   * 移動したことが示されている」と作中の変化で取り下げた（2026-10-25、gemma4:26b）。
   * 指紋には混ぜない（同じ食い違いの鍵を変えない）
   */
  basis?: string;
  /**
   * どの照合器から来たか。移動の照合（`findTravelImpossibilities`）は travel、
   * 体と心の照合（`findDwellingDrift`）は identity を付ける。
   * 判定（P-12b）は、それぞれ専用の文面を送る（travel 1.0、2026-10-25／identity 1.0、
   * 2026-10-26）。指紋には混ぜない
   */
  origin?: "travel" | "identity";
  /**
   * 移動の照合で、所要時間に承認待ちの距離（P-51 が本文から読んだもの）を使ったか。
   * 判定（P-12b travel 1.1）は、これが付いた候補にだけ「承認待ちの距離も根拠として扱う」
   * 1文を送り、控えの版も分ける。指紋には混ぜない
   */
  pendingDistance?: true;
}

/**
 * 場所どうしの最短の所要日数。**表が無ければ移動の照合はしない**（推測しない）。
 *
 * `from`・`to` は**場所の id**（`loc_0001`）。本文の自由文で引くと、
 * 「港町」と「港町の宿」が別の場所になり、同じ場所の言い換えが移動に見える
 * （2026-10-25 に直した）。組み立ては `core/travelTable.ts`。
 */
export interface TravelTime {
  from: string;
  to: string;
  /** 日（小数あり。1.5＝1日半）。**1日に満たない組は照合しない** */
  minDays: number;
  /**
   * 設定資料にまだ入っていない、承認待ちの距離から来た値なら、その本文の引用
   * （P-51。設計書6.88.13、作者の判断②）。
   *
   * 承認前の距離もその回の照合に使うが、**指摘の根拠に「承認待ち」と出す**——
   * AIの読み違いがそのまま指摘になりうるので、作者が見分けられるようにする。
   * 指紋には混ぜない（承認しても同じ食い違いの鍵が変わらないように）
   */
  pendingEvidence?: string;
}

/**
 * 所在の事実1件を、台帳の場所と時計に結び付けたもの（組み立ては `core/whereabouts.ts`）。
 *
 * **`StoryFact.storyTime` には書き込まない。** 書くと `orderFacts` を通じて
 * ほかの照合器の並びまで変わる。時計は移動の照合だけが見る。
 */
export interface WhereaboutsEntry {
  /** もとの事実の id。候補の `left`／`right` になる */
  factId: string;
  subject: string;
  /** 台帳の場所の id。**名前と別名の完全一致で、1か所に決まったものだけ** */
  locationId: string;
  /** 作者に見せる場所の名前（台帳の名前） */
  locationName: string;
  /** 時計（`sceneClock.ts`）。読めなければ null（照合しない） */
  clock: SceneClockReading | null;
}

/**
 * 設定資料から分かる「死んだあとも心が別の体で出てくる人物」の印（2026-10-24）。
 *
 * 作者が付けた心と体の記録（宿り、`Character.dwellings`。設計書6.5.13）の心の側から
 * 組む（`factsFromRecords.ts` の `afterlifeMarksFromCharacters`）。作者の裁定「設定資料から除く」。
 * 遷移の表（`transitions`）は、心と体の記録がある作品でだけ製品の道から渡る（6.88.14）。
 * 記録の無い作品では、幽霊・転生・憑依の除外はこの印だけが効く。
 */
export interface AfterlifeMark {
  /** 人物の id（事実の `subject` と同じ） */
  subject: string;
  /** その宿りが何話までか。無ければ今も続いている */
  untilChapter?: number;
}

/**
 * 作者の心と体の記録（宿り）1件を、体と心の id に結んだもの（設計書6.88.14）。
 * 組み立ては `core/identityCues.ts` の `buildIdentityLedger`。
 */
export interface DwellingSpan {
  /** 体の持ち主の人物 id */
  bodyId: string;
  /** 宿る心の人物 id */
  mindId: string;
  /** 何話から。無ければ決めない（最初から） */
  fromChapter?: number;
  /** 何話まで。無ければ今も */
  untilChapter?: number;
}

export interface MatchInput {
  facts: readonly StoryFact[];
  /**
   * 心と体の記録（6.88.14）。**1件でもあれば、体と心の照合は記録の範囲で見る**
   * （`findDwellingDrift`）。無ければこれまでの `findIdentityDrift`
   */
  dwellings?: readonly DwellingSpan[];
  /** 人物 id → 作者が読む名前。理由の文にだけ使う（指紋は id のまま） */
  names?: ReadonlyMap<string, string>;
  /** 6.88.5。「死亡後の登場」の除外と、組の変化が正当かの判断に使う */
  transitions?: readonly IdentityTransition[];
  /** 設定資料の宿りの印。「死亡後の登場」の除外にだけ使う */
  afterlives?: readonly AfterlifeMark[];
  /** 場面ごとの肉体・人格・身分の組（6.88.5。第2段） */
  scenes?: readonly SceneIdentity[];
  travelTimes?: readonly TravelTime[];
  /** 所在の時計（場所の id と、作中のいつか）。無ければ移動の照合はしない */
  whereabouts?: readonly WhereaboutsEntry[];
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
  // **項目名を寄せるのはここ1か所**（`canonicalPredicate`）。照合器ごとに
  // 寄せると、区間を切る出来事だけ生の名前のまま残る、といったずれが出る。
  // 事実そのものは書き換えず、写しの項目名だけを差し替える——
  // 呼ぶ側は `left`/`right` の id から元の事実を引き、作者には抽出が
  // 付けた名前のまま見せられる
  const facts = input.facts.map((fact) => {
    const predicate = canonicalPredicate(fact.predicate);
    return predicate === fact.predicate ? fact : { ...fact, predicate };
  });
  const intervals = buildAttributeIntervals(facts);
  const all = [
    ...findIntervalConflicts(intervals),
    ...findEventImpliedConflicts(facts, intervals),
    ...findPostDeathAppearances(
      facts,
      input.transitions ?? [],
      input.afterlives ?? []
    ),
    ...findKnowledgeViolations(facts),
    ...findTravelImpossibilities(
      facts,
      input.travelTimes ?? [],
      input.whereabouts ?? []
    ),
    ...((input.dwellings ?? []).length > 0
      ? findDwellingDrift(
          input.scenes ?? [],
          input.transitions ?? [],
          input.dwellings ?? [],
          input.names
        )
      : findIdentityDrift(input.scenes ?? [], input.transitions ?? [])),
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
    // **同時にいくつも成り立つ項目は候補にしない**（`predicateArity.ts`）。
    // 所持品のようなものを排他として突き合わせると、合羽と郵便と松葉杖が
    // 互いに矛盾したことになる（2026-09-18 の測定では候補の全部がこれだった）
    if (!isExclusivePredicate(interval.predicate)) continue;
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
        // **言い回しの違いは食い違いにしない**（`overlapsInMeaning`）。
        // 値が同じ場合もここで落ちる。出来事から導いた側には同じ歯止めが
        // 最初から入っていたのに、区間どうしの照合には無かった——
        // 資料の「背が高い。右目の下に小さなほくろがある。」と本文の
        // 「右目の下に小さなほくろがある」が食い違いとして出ていた（0.67.5）
        if (overlapsInMeaning(a.value, b.value)) continue;
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
 * 出来事から導いた「それ以前の状態」が、その時点の状態と食い違う。
 *
 * **`event` は区間を切る側なので、`state` の値とは比べられない。** 項目名が
 * 揃っていても、片方が出来事として書かれているだけで照合から漏れる——
 * 2026-09-18 の測定は、まさにそこで目当ての食い違いを落としていた
 * （第2話「怪我＝左の足首」は `state`、第4話「怪我＝右足のギプスが外れた」は
 * `event`）。
 *
 * ここは `stateFromEvent.ts` に**出来事から直前の状態を導かせ**、その値を、
 * 出来事の時点で成り立っていた区間と突き合わせる。
 *
 * **作者が飛ぶ先は、導いた状態ではなく元の出来事の行にする。** 導いた状態は
 * 本文のどこにも書かれていないので、引用も行番号も持たない。
 */
export function findEventImpliedConflicts(
  facts: readonly StoryFact[],
  intervals: readonly AttributeInterval[]
): ContradictionCandidate[] {
  const candidates: ContradictionCandidate[] = [];

  for (const derived of statesBeforeEvents(orderFacts(facts))) {
    // 所在は移動可能性の照合だけが見る（区間の重なりと同じ扱い）
    if (derived.predicate === WHEREABOUTS) continue;
    if (!isExclusivePredicate(derived.predicate)) continue;

    const at = positionOf(derived);
    for (const interval of intervals) {
      if (interval.subject !== derived.subject) continue;
      if (interval.predicate !== derived.predicate) continue;
      if (!covers(interval, at)) continue;
      if (overlapsInMeaning(interval.value, derived.value)) continue;

      const unknownOrder = isFactOrderUnknown(interval.start, at);
      candidates.push(
        buildCandidate({
          type: TIME_PREDICATES.some((word) =>
            derived.predicate.includes(word)
          )
            ? "時系列"
            : "状態",
          subject: derived.subject,
          predicate: derived.predicate,
          values: [interval.value, derived.value],
          left: interval.sources[0],
          // **元の出来事を指す**（導いた状態には本文の行が無い）
          right: derived.derivedFrom?.eventId ?? derived.id,
          confidence: lowerConfidence(
            confidenceFromModality(interval.modality),
            confidenceFromModality(derived.modality)
          ),
          unknownOrder,
          reason:
            `${formatPosition(interval.start)}に『${interval.value}』。` +
            `${formatPosition(at)}の『${derived.value}${derived.derivedFrom?.rule ?? ""}』から、` +
            `それ以前は『${derived.value}』だったと読める`,
        })
      );
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
 * **設定資料に宿り（心と体の記録）がある人物も、その人物ごと外す**（`afterlives`。
 * 作者の裁定 2026-10-24「設定資料から除く」）。死んだ人の心が別の体で出てくる
 * 作品では、名前での登場は矛盾ではない。宿りの記録は作者だけが付けるので、
 * 印のある人物だけを外し、印の無い人物はいまのまま出す（見逃しを増やさない）。
 * ただし宿りが死んだ話より前に終わっていれば（生きているあいだの憑依）、
 * 死後の登場は宿りでは説明できないので外さない。
 *
 * **出すのは死亡後の最初の1件だけ。** そのあと何十回出てこようと、
 * 作者が直すべき場所は同じ1か所である。
 */
export function findPostDeathAppearances(
  facts: readonly StoryFact[],
  transitions: readonly IdentityTransition[] = [],
  afterlives: readonly AfterlifeMark[] = []
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
  for (const mark of afterlives) {
    const death = deaths.get(mark.subject);
    if (!death) continue;
    const deathChapter = positionOf(death).chapter;
    // 終わりの話が分からない／死んだ話が分からないときは、続いているとみなす
    // （作者が「この人の心は別の体にいる」と記録した以上、話数で縛らない）
    if (
      mark.untilChapter === undefined ||
      deathChapter === null ||
      mark.untilChapter >= deathChapter
    ) {
      revived.add(mark.subject);
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
 * **所要時間の表と所在の時計が無ければ照合しない。** 作品ごとに地理も
 * 移動手段も違うのに、こちらが日数を推測すると、転移門のある作品で毎回
 * 誤検出する。表は場所の記録（`core/travelTable.ts`）、時計は本文の語と日付
 * （`core/sceneClock.ts`）から、所在は事実を台帳の場所に引いて（`core/whereabouts.ts`）作る。
 *
 * ## 2026-10-25 に直した3つ
 *
 * - **経過を日でしか数えていなかった。** 徒歩10分（0.007日）の道を同じ日のうちに
 *   移ると「0日 < 0.007日」で候補になり、同じ日の場所替わりが全部出た。
 *   **1日に満たない道のりは比べない**（時計が時刻を読まないので、比べようがない）
 * - **場所を自由文で比べていた**（`from.value === to.value`）。「港町」と「ミレア」
 *   （別名）が別の場所になる。**台帳の場所の id で比べる**
 * - **回想（`thought`）を除いていなかった。** 回想の中の場所は、その時点の所在ではない。
 *   伝聞・嘘の疑いも同じく外す
 *
 * ## 経過は「上限」で比べる
 *
 * 時計は場面ごとに「早くて何日目・遅くて何日目」の幅を持つ。2つの所在の
 * あいだに**長く見積もっても**所要日数に届かないときだけ候補にする。
 * **同じ鎖に載っていない組（何日経ったか分からない）・同じ場面の中の組は比べない**
 * ——同じ場面の中で時が流れる書き方（「三日かけて港町へ着いた」）を、時計は読まない。
 */
export function findTravelImpossibilities(
  facts: readonly StoryFact[],
  travelTimes: readonly TravelTime[] = [],
  whereabouts: readonly WhereaboutsEntry[] = []
): ContradictionCandidate[] {
  if (travelTimes.length === 0 || whereabouts.length === 0) return [];

  const table = new Map<string, { minDays: number; pendingEvidence?: string }>();
  for (const entry of travelTimes) {
    // **1日に満たない道のりは比べない**（上の注の1つ目）
    if (!(entry.minDays >= 1)) continue;
    const key = placePairKey(entry.from, entry.to);
    const known = table.get(key);
    // 同じ組が2度来たら、速いほうを採る（いちばん速い値。作者の裁定）。
    // 同じ速さなら設定資料の値を採る（承認待ちの読みより、作者の記録を根拠に見せる）
    if (
      known === undefined ||
      entry.minDays < known.minDays ||
      (entry.minDays === known.minDays &&
        known.pendingEvidence !== undefined &&
        entry.pendingEvidence === undefined)
    ) {
      table.set(key, {
        minDays: entry.minDays,
        ...(entry.pendingEvidence !== undefined
          ? { pendingEvidence: entry.pendingEvidence }
          : {}),
      });
    }
  }
  if (table.size === 0) return [];

  const entryByFact = new Map(whereabouts.map((entry) => [entry.factId, entry]));
  const bySubject = new Map<string, Array<{ fact: StoryFact; entry: WhereaboutsEntry }>>();
  for (const fact of orderFacts(facts)) {
    const entry = entryByFact.get(fact.id);
    if (!entry || !entry.clock) continue;
    // 回想・伝聞・嘘の疑いの中の場所は、その時点の所在ではない
    if (fact.modality !== "narration" && fact.modality !== "dialogue") continue;
    const bucket = bySubject.get(entry.subject);
    const item = { fact, entry };
    if (bucket) bucket.push(item);
    else bySubject.set(entry.subject, [item]);
  }

  const candidates: ContradictionCandidate[] = [];
  for (const key of [...bySubject.keys()].sort()) {
    const list = bySubject.get(key) ?? [];
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1];
      const to = list[i];
      if (from.entry.locationId === to.entry.locationId) continue;
      const fromClock = from.entry.clock as SceneClockReading;
      const toClock = to.entry.clock as SceneClockReading;
      if (fromClock.chain !== toClock.chain) continue;
      if (fromClock.segment === toClock.segment) continue;

      const known = table.get(
        placePairKey(from.entry.locationId, to.entry.locationId)
      );
      if (known === undefined) continue;
      const minDays = known.minDays;

      // 向きは問わない（「その頃」は前の場面と同じ時を指す）。長く見積もった経過
      const elapsedMax = Math.max(
        toClock.dayHigh - fromClock.dayLow,
        fromClock.dayHigh - toClock.dayLow
      );
      if (elapsedMax >= minDays) continue;

      candidates.push(
        buildCandidate({
          type: "時系列",
          subject: from.entry.subject,
          predicate: WHEREABOUTS,
          values: [from.entry.locationName, to.entry.locationName],
          left: from.fact.id,
          right: to.fact.id,
          confidence: lowerConfidence(
            confidenceFromModality(from.fact.modality),
            confidenceFromModality(to.fact.modality)
          ),
          unknownOrder: false,
          reason:
            `${formatPosition(positionOf(from.fact))}に『${from.entry.locationName}』、` +
            `${formatPosition(positionOf(to.fact))}に『${to.entry.locationName}』。` +
            `${formatDays(minDays)}かかる道のりを、` +
            `${elapsedMax <= 0 ? "同じ日のうちに" : `長く見積もっても${elapsedMax}日で`}移っている`,
          basis:
            known.pendingEvidence !== undefined
              ? // 作者の判断②：承認前の距離を使ったことを、根拠の頭に出す
                `承認待ちの距離（本文「${known.pendingEvidence}」からAIが読んだもの。設定資料にはまだ入っていません）では、` +
                `${from.entry.locationName}と${to.entry.locationName}のあいだは${formatDays(minDays)}かかる`
              : `場所の記録では、${from.entry.locationName}と${to.entry.locationName}のあいだは` +
                `${formatDays(minDays)}かかる（書かれた所要時間のうち、いちばん速いもの）`,
          origin: "travel",
          ...(known.pendingEvidence !== undefined ? { pendingDistance: true as const } : {}),
        })
      );
    }
  }
  return candidates;
}

/** 場所の組の鍵（向きは問わない） */
function placePairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

/** 日数を作者が読む形にする（1.5日→「1日半」） */
function formatDays(days: number): string {
  const whole = Math.floor(days);
  const rest = days - whole;
  if (rest === 0) return `${whole}日`;
  if (rest === 0.5) return `${whole}日半`;
  return `約${Math.round(days * 10) / 10}日`;
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
 * 心と体の記録（宿り）があるときの、体と心の照合（設計書6.88.14。作者の判断②）。
 *
 * `findIdentityDrift` は「隣り合う2場面で人格が変わったら、あいだに遷移が要る」と見る。
 * それでは**同居**（第17話から文佳の心も戻り、2人の心が行き来する）が表せない——
 * 行き来のたびに遷移が要り、作者の記録どおりの場面が全部候補になる。逆に、範囲が
 * 切れたあとも心が体に残っている場面は、人格が変わらないので拾えない。
 *
 * そこで、体ごとに場面を時期順にたどり、**場面1つずつ**「この心がこの体にいてよいか」を見る。
 *
 * - 体の持ち主の心：いつでもよい（戻ったことは描かれていなくても出さない）
 * - 記録の範囲の中の宿る心：よい（同居の行き来も含めて出さない）
 * - それ以外（範囲の外の宿る心・組に無い第三の心）：**本文の遷移**が前の場面から
 *   この場面までのあいだにあればよく、そのあと同じ心が続くあいだもよい。無ければ候補
 *
 * 記録から組んだ遷移（`fromDwelling`）は本文の描写として数えない——範囲の頭の憑依
 * 1つが、範囲の外の場面まで許してしまう。身分（偽名・変装）はここでは見ない
 * （母艦の判断⑤）。
 */
export function findDwellingDrift(
  scenes: readonly SceneIdentity[],
  transitions: readonly IdentityTransition[],
  dwellings: readonly DwellingSpan[],
  names: ReadonlyMap<string, string> = new Map()
): ContradictionCandidate[] {
  const textTransitions = transitions.filter((transition) => !transition.fromDwelling);
  const nameOf = (id: string) => names.get(id) ?? id;
  const groups = new Map<string, SceneIdentity[]>();
  for (const scene of orderScenes(scenes)) {
    const bucket = groups.get(scene.triple.bodyId);
    if (bucket) bucket.push(scene);
    else groups.set(scene.triple.bodyId, [scene]);
  }

  const candidates: ContradictionCandidate[] = [];
  for (const body of [...groups.keys()].sort()) {
    const list = groups.get(body) ?? [];
    /** 本文の遷移で入った心。範囲の外でも、別の心に替わるまでは続いているとみなす */
    let carried: string | null = null;
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i];
      const previous = i > 0 ? list[i - 1] : undefined;
      const mind = current.triple.personaId;
      const at = scenePosition(current);
      if (mind === body) {
        carried = null;
        continue;
      }
      const spans = dwellings.filter((span) => span.bodyId === body && span.mindId === mind);
      if (spans.some((span) => spanCovers(span, current.chapter))) continue;
      // 前の場面（無ければこの話の頭）からこの場面までのあいだの、本文の遷移
      const from: FactPosition = previous
        ? scenePosition(previous)
        : { storyTime: null, chapter: current.chapter, line: 0 };
      const described = textTransitions.some(
        (transition) =>
          coversBody(transition, body) &&
          within(transition.at, from, at) &&
          transitionToPersona(transition) === mind
      );
      if (described) {
        carried = mind;
        continue;
      }
      if (carried === mind) continue;

      const range = spans.map(describeSpan).join("、");
      const reason =
        spans.length > 0
          ? `${formatPosition(at)}、${nameOf(body)}の体に〈${nameOf(mind)}〉の心がいる。` +
            `心と体の記録の範囲（${range}）の外で、本文に心が入る描写も無い`
          : `${formatPosition(at)}、${nameOf(body)}の体に〈${nameOf(mind)}〉の心がいる。` +
            `心と体の記録に無い組で、本文に心が入る描写も無い`;
      const recorded = dwellings
        .filter((span) => span.bodyId === body)
        .map((span) => `${nameOf(span.mindId)}（${describeSpan(span)}）`);
      const basis =
        spans.length > 0
          ? `心と体の記録（作者が人物の編集で付けたもの）では、${nameOf(mind)}の心が${nameOf(body)}の体にいるのは${range}`
          : recorded.length > 0
            ? `心と体の記録（作者が人物の編集で付けたもの）では、${nameOf(body)}の体に宿る心は${recorded.join("・")}だけ`
            : `心と体の記録（作者が人物の編集で付けたもの）には、${nameOf(body)}の体に宿る心が無い`;
      candidates.push(
        buildCandidate({
          type: "状態",
          subject: body,
          predicate: PERSONA,
          values: [previous?.triple.personaId ?? body, mind],
          left: previous?.source ?? current.source,
          right: current.source,
          // 場面の組は地の文から読むもの（誰かの台詞ではない）ので narration 相当
          confidence: confidenceFromModality("narration"),
          unknownOrder: previous
            ? isFactOrderUnknown(scenePosition(previous), at)
            : false,
          reason,
          basis,
          origin: "identity",
        })
      );
    }
  }
  return candidates;
}

/** 記録の範囲がその話を含むか。話数が分からなければ、範囲に縛りが無いときだけ含むとみなす */
function spanCovers(span: DwellingSpan, chapter: number | null): boolean {
  if (span.fromChapter === undefined && span.untilChapter === undefined) return true;
  if (chapter === null) return false;
  if (span.fromChapter !== undefined && chapter < span.fromChapter) return false;
  if (span.untilChapter !== undefined && chapter > span.untilChapter) return false;
  return true;
}

/** 記録の範囲を作者が読む形にする（「第2話から第4話」） */
function describeSpan(span: DwellingSpan): string {
  if (span.fromChapter !== undefined && span.untilChapter !== undefined) {
    return `第${span.fromChapter}話から第${span.untilChapter}話`;
  }
  if (span.fromChapter !== undefined) return `第${span.fromChapter}話から`;
  if (span.untilChapter !== undefined) return `第${span.untilChapter}話まで`;
  return "話数の決まり無し";
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
  basis?: string;
  origin?: "travel" | "identity";
  pendingDistance?: true;
}

function buildCandidate(draft: CandidateDraft): ContradictionCandidate {
  return {
    ...(draft.basis ? { basis: draft.basis } : {}),
    ...(draft.origin ? { origin: draft.origin } : {}),
    ...(draft.pendingDistance ? { pendingDistance: true as const } : {}),
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

/**
 * その時点で、この区間は成り立っているか。
 *
 * **両端を含める。** 出来事はそこで区間を閉じるので、閉じた区間の `end` は
 * 出来事とちょうど同じ位置になる——ここを開区間にすると、
 * 「切られた直前の状態」が1つも取れなくなる。
 */
function covers(interval: AttributeInterval, at: FactPosition): boolean {
  if (compareFactPosition(interval.start, at) > 0) return false;
  return interval.end === null || compareFactPosition(at, interval.end) <= 0;
}

/**
 * 2つの値は同じことを指していそうか。
 *
 * **一方が他方を含んでいたら、食い違いとしない。**「右足のギプス」と
 * 「右足のギプスの中にある足首」のような書き分けを食い違いとして出すと、
 * 作者は言い回しを直しに行くことになる。**迷ったら出さない。**
 *
 * **区間どうしの照合（`findIntervalConflicts`）と、出来事から導いた状態の
 * 照合（`findEventImpliedConflicts`）の両方がここを通る。** 同じ判断を
 * 2か所に書くと、片方だけ緩んで「どちらの経路で出たか」で結果が変わる。
 */
function overlapsInMeaning(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
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
