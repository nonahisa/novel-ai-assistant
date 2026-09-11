import type { Character } from "../models/character";
import type { FactModality, StoryFact } from "../models/storyFact";
import type {
  CandidateConfidence,
  CandidateType,
  ContradictionCandidate,
} from "./contradictionMatch";
import { formatRelativeTime } from "./relativeTime";
import {
  STORY_FACT_EXTRACT_VERSION,
  type KnownCharacterEntry,
} from "../prompts/storyFactExtract";

/**
 * 矛盾検知の新しい道（設計書6.88）の第4段——**機械が挙げた候補を、
 * 既存の1件ずつの検証（6.10.5）へ渡せる形に写す**ところ。
 *
 * ここに置いてあるのは、AIもファイルも触らない純粋な部分だけである。
 * 写し方と報告の文は**実データで何度も直すことになる**（P-12 の実測が
 * そうだった）ので、features の中に閉じ込めると外から一度も測れない。
 *
 * VS Code APIに依存しない。
 */

/**
 * 提案パネルに出すときの分類名（タブ）。
 *
 * **P-12 の「矛盾」とは別のタブに出す。** 作者の裁定で両方を
 * しばらく並行させる（6.88.9）ので、同じタブへ混ぜると
 * どちらの道が何を見つけたのかを見比べられない。
 */
export const FACT_CONTRADICTION_CATEGORY = "矛盾（事実の照合）";

/**
 * 事実の抽出（P-37）のキャッシュの鍵。
 *
 * **既知の topic の一覧は入れない。** topic はチャンクを処理するたびに
 * 増えるので、鍵へ混ぜると2回目以降は毎回ぜんぶ再送になり、
 * キャッシュがまったく効かなくなる。topic は「同じ事柄に同じ語を
 * 付けさせる」ための助けであって、答えの正しさを決めるものではない。
 */
export function factExtractCacheKey(input: {
  providerId: string;
  model: string;
}): {
  feature: string;
  promptVersion: string;
  providerId: string;
  model: string;
} {
  return {
    feature: "story_fact_extract",
    promptVersion: STORY_FACT_EXTRACT_VERSION,
    providerId: input.providerId,
    model: input.model,
  };
}

/**
 * 設定資料から組んだ事実か（`core/factsFromRecords.ts` が作るもの）。
 *
 * id の形が `fact:<人物id>:<項目>:<連番>` なので、本文から抜いた
 * `fact:<話数>:<行>:<連番>` とは先頭で見分けられる。**本文の行が無い**
 * （`lineRange` が `[0, 0]`）ので、引用も前後の文脈も出せない。
 */
export function isRecordFact(fact: StoryFact): boolean {
  return /^fact:char_/u.test(fact.id);
}

/** どう書かれていたか。台詞と地の文を同じ強さで見せない（6.88.3） */
const MODALITY_LABELS: Record<FactModality, string> = {
  narration: "地の文",
  dialogue: "台詞",
  thought: "心の声",
  rumor: "伝聞",
  lie_suspect: "嘘の疑い",
};

/** 確信度を、作者が読む言葉にする */
const CONFIDENCE_LABELS: Record<CandidateConfidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** 値の無い事実（死亡イベントなど）は、項目名だけで示す */
function valueLabel(fact: StoryFact): string {
  return fact.value.trim().length === 0
    ? fact.predicate
    : `${fact.predicate}＝${fact.value}`;
}

/**
 * 候補の片側を、作者が読む1行にする。
 *
 * **設定資料から組んだ側は、本文の場所を名乗らせない。** 資料の事実は
 * 話の先頭（0行目）に置いてあるだけで、そこに本文があるわけではない。
 * 「第3話 0行目」と書くと、作者はありもしない行を見に行く。
 */
export function describeFactSide(fact: StoryFact): string {
  if (isRecordFact(fact)) return `設定資料では『${valueLabel(fact)}』`;
  const place =
    fact.chapter !== null
      ? `第${fact.chapter}話 ${fact.lineRange[0]}行目`
      : `${fact.lineRange[0]}行目`;
  const time = fact.storyTime ? `・${formatRelativeTime(fact.storyTime)}` : "";
  return `${place}・${MODALITY_LABELS[fact.modality]}${time}：${valueLabel(fact)}`;
}

/** 検証（P-12b）へ渡す「指摘」の形。既存の `AcceptedContradiction` と同じ並び */
export interface FactVerifyIssue {
  /** 観点。**候補の型をそのまま渡す**（6.88.2の型で数えたいため） */
  category: string;
  excerpt: string;
  settingSays: string;
  textSays: string;
  note: string;
}

/**
 * 機械が挙げた候補を、1件ずつの検証（6.10.5）が読める形へ写す。
 *
 * **前側を `settingSays`、後側を `textSays` に置く。** 検証のプロンプトは
 * 「設定では／本文では」と書かれているが、判断そのものは
 * 「この2つが同時に成り立つか」だけを見ている。前後を入れ替えると、
 * 「まだ明かされていない」の判定（前側が後の話なら怪しむ）が逆になる。
 */
export function buildFactVerifyIssue(input: {
  candidate: ContradictionCandidate;
  left: StoryFact;
  right: StoryFact;
  /**
   * 後側の事実が書かれている本文の行。
   *
   * **引用は本文の行そのものを渡す。** 検証は「引用が本文と違う」を
   * 却下の理由に持っているので、こちらで言い換えた文を渡すと
   * 本物の候補まで落ちる。読めなかった・資料由来のときは省略する。
   */
  rightLineText?: string;
}): FactVerifyIssue {
  const { candidate, left, right } = input;
  const quoted = input.rightLineText?.trim() ?? "";
  return {
    category: candidate.type,
    // 資料由来の側には本文が無いので、資料の書き方をそのまま引用に置く
    excerpt:
      !isRecordFact(right) && quoted.length > 0
        ? quoted
        : describeFactSide(right),
    settingSays: describeFactSide(left),
    textSays: describeFactSide(right),
    note: `${candidate.reason}（確信度: ${CONFIDENCE_LABELS[candidate.confidence]}）`,
  };
}

/**
 * 該当行の前後を、行番号付きで切り出す。
 *
 * @param firstLineNumber その本文の1行目に振る番号。ファイル全体なら1、
 *   チャンクなら `chunk.startLine + 1`（`withLineNumbers` と揃える）
 */
export function linesAround(
  text: string,
  line: number,
  around: number,
  firstLineNumber = 1
): string {
  const lines = text.split("\n");
  const target = line - firstLineNumber;
  const from = Math.max(0, target - around);
  const to = Math.min(lines.length, target + around + 1);
  return lines
    .slice(from, to)
    .map((body, index) => `${firstLineNumber + from + index}: ${body}`)
    .join("\n");
}

/**
 * 候補を型ごとに数えて1行にする。
 *
 * **型ごとに検出率と誤検知率を測る**（6.88.7）ので、総数だけでは足りない。
 * 0件なら空文字（うまくいった回のログを汚さない）。
 */
export function describeCandidateTypes(
  candidates: ReadonlyArray<{ type: CandidateType }>
): string {
  if (candidates.length === 0) return "";
  const counts = new Map<CandidateType, number>();
  for (const candidate of candidates) {
    counts.set(candidate.type, (counts.get(candidate.type) ?? 0) + 1);
  }
  // 多い順。同数なら型の名前で並べて、実行ごとに順が揺れないようにする
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type} ${count}件`)
    .join("、");
}

export interface FactRunSummary {
  /** AIへ実際に送ったチャンク数と、その分母 */
  chunksDone: number;
  chunksTotal: number;
  /** 処理済みで飛ばした数 */
  skippedChunks: number;
  /** 応答を読み取れなかったチャンク数 */
  failedChunks: number;
  /** 受理した事実（本文から抜いたぶん） */
  acceptedFacts: number;
  /** 設定資料から組んだ事実 */
  recordFacts: number;
  /** 検算で弾いた件数と、その内訳（`describeStoryFactRejections`） */
  rejectedFacts: number;
  rejectionNote: string;
  /** 機械が挙げた候補の件数と、型ごとの内訳 */
  candidates: number;
  candidateNote: string;
  /** 検証を通った件数と、取り下げの内訳（`describeVerifyResults`） */
  kept: number;
  verifyNote: string;
  cancelled: boolean;
}

/**
 * 完了報告の1行（設計書6.10.5・6.88）。
 *
 * **黙って消さない。** 事実を何件弾いたか、候補を何件挙げたか、
 * 検証で何件取り下げたかが見えないと、指摘が少ないのが
 * 「本当に無い」のか「どこかで消しすぎている」のか切り分けられない。
 * この道は工程が4つ（抽出→検算→機械照合→判定）あり、
 * **どの工程で減ったのかが分からないと、次に直す場所が決まらない。**
 */
export function describeFactRun(summary: FactRunSummary): string {
  const parts = [
    `事実 ${summary.acceptedFacts}件`,
    summary.recordFacts > 0 ? `設定資料から ${summary.recordFacts}件` : "",
    summary.rejectedFacts > 0
      ? `弾いた ${summary.rejectedFacts}件（${summary.rejectionNote}）`
      : "",
    summary.candidates > 0
      ? `候補 ${summary.candidates}件（${summary.candidateNote}）`
      : "候補 0件",
    // **候補が0件なら判定は走っていない。** 「採用0件」と書くと、
    // AIが見たうえで全部落としたように読める
    summary.candidates > 0 ? `採用 ${summary.kept}件` : "",
    summary.verifyNote,
    summary.failedChunks > 0 ? `読み取れなかった ${summary.failedChunks}件` : "",
    summary.skippedChunks > 0
      ? `処理済み ${summary.skippedChunks}件はスキップ`
      : "",
    summary.cancelled ? "中止された" : "",
  ].filter(Boolean);

  return (
    `矛盾検知（事実の照合）を終了: ${summary.chunksDone}/${summary.chunksTotal}` +
    `（${parts.join(" / ")}）`
  );
}

export interface KnownCharacterTable {
  /** P-37 へ渡す対応表 */
  entries: KnownCharacterEntry[];
  /** 表記から id を引く表（`validateStoryFactResult` の `knownNames`） */
  names: Map<string, string>;
  /** 既知の id（`knownCharacterIds`） */
  ids: Set<string>;
}

/**
 * 人物レコードから、事実の抽出に渡す対応表を組む。
 *
 * **id で返させないと、同じ人物が場面ごとに別の主語になる**（「文佳」
 * 「密倉さん」「文佳ちゃん」）。機械照合は id で突き合わせるので、
 * ここで揃えておく。
 *
 * **2人以上が同じ表記を持つときは、その表記を表から落とす。** どちらの
 * 人物か決められないものを片方へ寄せると、別人の事実が1人に混ざって
 * 矛盾が生まれる。落とした表記は本文の表記のまま通る（検算の
 * `resolveActor` が、id の形でなければそのまま受ける）ので、
 * 事実そのものが消えるわけではない。
 */
export function buildKnownCharacterTable(
  characters: readonly Character[]
): KnownCharacterTable {
  const entries: KnownCharacterEntry[] = [];
  const ids = new Set<string>();
  /** 表記ごとに、名乗った人物の id。2人以上なら落とす */
  const claims = new Map<string, Set<string>>();

  for (const character of characters) {
    const name = character.name.trim();
    if (name.length === 0) continue;
    ids.add(character.id);
    const aliases = [
      ...new Set(
        character.aliases
          .map((alias) => alias.trim())
          .filter((alias) => alias.length > 0 && alias !== name)
      ),
    ];
    entries.push({ id: character.id, name, aliases });
    for (const label of [name, ...aliases]) {
      const bucket = claims.get(label);
      if (bucket) bucket.add(character.id);
      else claims.set(label, new Set([character.id]));
    }
  }

  const names = new Map<string, string>();
  for (const [label, owners] of claims) {
    if (owners.size !== 1) continue;
    names.set(label, [...owners][0]);
  }

  return { entries, names, ids };
}
