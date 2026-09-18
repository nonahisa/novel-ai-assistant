import type { StoryFact } from "../models/storyFact";
import {
  locateChunkLine,
  segmentAtLine,
  type Chunk,
} from "./chunker";
import {
  validateStoryFactResult,
  type RejectedStoryFact,
} from "./storyFactValidation";
import {
  buildFactVerifyIssue,
  type KnownCharacterTable,
} from "./factContradiction";
import type { ContradictionCandidate } from "./contradictionMatch";

/**
 * 矛盾検知（事実の照合。設計書6.88）の**道筋そのもの**のうち、
 * AIもファイルも触らない部分。
 *
 * 元は `features/checkFactContradictions.ts` の中に閉じていた
 * （0.46.0〜0.46.3）。**外から一度も測れなかった**ので、0.67.2 で
 * ここへ出した——MCP の口（`mcp/tools/factContradiction.ts`）と
 * 拡張機能の画面が、**同じ判定を通る**ようにするためである。
 * 写しを作ると、製品と測定がずれて「製品に無い不具合を見つけた」ことになる。
 *
 * VS Code APIに依存しない。
 */

/**
 * 次のチャンクへ引き継ぐ topic の上限。
 *
 * **際限なく足すと、チャンクが進むほど指示だけが太る。** topic は
 * 「同じ事柄に同じ語を付けさせる」ための助けなので、直近のものが効けばよい。
 */
export const TOPIC_CARRY_LIMIT = 60;

/** 検証へ渡す前後の行数（設計書6.88の第4段。作者への指示どおり±5行） */
export const VERIFY_CONTEXT_LINES = 5;

/**
 * 提案パネルへ渡す1件。
 *
 * **既存の矛盾の項目と同じ並びにしてある。** パネル側は
 * `ContradictionViewItem` へ写すだけで、描画も操作も使い回せる。
 */
export interface FactContradictionIssue {
  filePath: string;
  /** 元のファイルでの行（1始まり）。まとめたチャンクは戻してある */
  line: number;
  chunkHash: string;
  excerpt: string;
  /** 候補の型（設定・時系列・状態・知識・視点・規則） */
  category: string;
  settingSays: string;
  textSays: string;
  note: string;
  confidence: "high" | "medium" | "low";
}

/** 事実が本文のどこに書かれていたか */
export interface FactPlace {
  filePath: string;
  line: number;
}

export interface FactCollectInput {
  /** AIの応答をJSONとして読んだもの */
  raw: unknown;
  chunk: Chunk;
  table: KnownCharacterTable;
  /**
   * チャンクの内訳から話数が引けなかったときの落とし先。
   *
   * **無ければ null のまま置く**（推測で埋めない）。
   */
  chapterOfFile?: (filePath: string) => number | null;
}

export interface FactCollectResult {
  /** 受理して、行を元のファイルへ戻した事実 */
  accepted: StoryFact[];
  /** 事実の id → 本文の場所 */
  places: Map<string, FactPlace>;
  rejected: RejectedStoryFact[];
  /** このチャンクで出てきた topic（重複なし）。**呼ぶ側が既知の一覧へ足す** */
  topics: string[];
  /**
   * 元のファイルへ戻せなかった行番号。
   *
   * **黙って落とさない**（設計書6.8）。捨てた件数を返して、
   * 呼ぶ側がログへ残せるようにする。
   */
  unlocatableLines: number[];
}

/**
 * 1チャンクぶんの応答を検算して、本文の場所まで確定させる。
 *
 * **`StoryFact` に file を足さない**（設計書6.88.3の形を保つ）。照合器は
 * 本文の場所を知らなくてよく、知らせると「どのファイルか」で条件分岐したく
 * なる。行も別に持つのは、**まとめたチャンクでは `withLineNumbers` の
 * 番号が元ファイルの行ではない**ため——`locateChunkLine` を通して戻した
 * 値を、判定と提案パネルの両方が使う。
 */
export function collectFactsFromChunk(
  input: FactCollectInput
): FactCollectResult {
  const { chunk, table } = input;
  const lineCount = chunk.text.split("\n").length;
  const validated = validateStoryFactResult(input.raw, {
    chunkLineStart: chunk.startLine + 1,
    chunkLineEnd: chunk.startLine + lineCount,
    chapter: chunk.chapterStart,
    knownCharacterIds: table.ids,
    knownNames: table.names,
  });

  const accepted: StoryFact[] = [];
  const places = new Map<string, FactPlace>();
  const topics: string[] = [];
  const unlocatableLines: number[] = [];

  for (const fact of validated.accepted) {
    // **まとめたチャンクの行番号は、元のファイルへ戻す。**
    // 戻さずに使うと、2話目以降の事実が1話目の行を指す
    const at = locateChunkLine(chunk, fact.lineRange[0]);
    if (!at) {
      // 戻せない行は捨てる。どこの話か決められない
      unlocatableLines.push(fact.lineRange[0]);
      continue;
    }
    const end = locateChunkLine(chunk, fact.lineRange[1]);
    // **話数はチャンクの内訳から引く。** ファイル単位で引くと、
    // 合本（全話が1ファイル）では走査が返す先頭の話数になり、
    // どの話の事実も全部「第1話」になる。内訳が無いときだけ
    // ファイルへ退く。読めなければ null のまま——推測で埋めない
    const chapter =
      segmentAtLine(chunk, fact.lineRange[0])?.chapterStart ??
      input.chapterOfFile?.(at.filePath) ??
      null;
    accepted.push({
      ...fact,
      chapter,
      lineRange: [at.line, end?.line ?? at.line],
    });
    places.set(fact.id, { filePath: at.filePath, line: at.line });
    if (fact.topic && !topics.includes(fact.topic)) topics.push(fact.topic);
  }

  return {
    accepted,
    places,
    rejected: validated.rejected,
    topics,
    unlocatableLines,
  };
}

/** 候補の両側と、本文のどこを指すか */
export interface CandidateSides {
  left: StoryFact;
  right: StoryFact;
  /** 作者が飛ぶ先。**後ろ側の事実のもの**（無ければ前側へ落とす） */
  place: FactPlace;
  /**
   * 後ろ側の事実が本文から抜けたものか。
   *
   * **前側の行を「後ろ側の引用」にしない。** 後ろ側が資料由来のときは
   * `place` が前側の場所になっているので、行の本文を引用に使ってはいけない。
   */
  rightInBody: boolean;
}

/**
 * 候補から、判定と提案パネルが要るものを一度に引く。
 *
 * **判定とパネルで別々に引かない。** 別々に組むと、AIへ見せた引用と
 * 作者の画面に出る引用が食い違い、「AIは何を見て採用したのか」が
 * 追えなくなる。
 *
 * 両側とも設定資料由来なら `undefined`——**本文の飛び先が無い**ので、
 * いまは出せない（資料どうしの食い違いは `conflicts` が既に作者へ回している）。
 */
export function candidateSidesOf(input: {
  candidate: ContradictionCandidate;
  factById: ReadonlyMap<string, StoryFact>;
  places: ReadonlyMap<string, FactPlace>;
}): CandidateSides | undefined {
  const left = input.factById.get(input.candidate.left);
  const right = input.factById.get(input.candidate.right);
  if (!left || !right) return undefined;

  const rightPlace = input.places.get(right.id);
  const place = rightPlace ?? input.places.get(left.id);
  if (!place) return undefined;

  return { left, right, place, rightInBody: rightPlace !== undefined };
}

/**
 * 候補を提案パネルの1件に写す。
 *
 * `chunkHash` には**容認リストの鍵（6.88.8）**を入れておく——本文の
 * チャンクを跨いで組んだ候補なので、チャンクの指紋は持てない。第5段で
 * 「これは意図的」を登録するときに、この値がそのまま鍵になる。
 */
export function buildFactContradictionIssue(input: {
  candidate: ContradictionCandidate;
  sides: CandidateSides;
  /** 後ろ側の事実が書かれている本文の行。資料由来・読めなければ省略 */
  rightLineText?: string;
  /** 判定（P-12b）で分かったこと。判定していなければ省略 */
  explanation?: string;
}): FactContradictionIssue {
  const issue = buildFactVerifyIssue({
    candidate: input.candidate,
    left: input.sides.left,
    right: input.sides.right,
    rightLineText: input.rightLineText,
  });
  return {
    filePath: input.sides.place.filePath,
    line: input.sides.place.line,
    chunkHash: input.candidate.fingerprint,
    excerpt: issue.excerpt,
    category: issue.category,
    settingSays: issue.settingSays,
    textSays: issue.textSays,
    note: appendNote(issue.note, input.explanation ?? ""),
    confidence: input.candidate.confidence,
  };
}

/** その行の本文。範囲の外なら undefined */
export function lineTextOf(
  text: string | undefined,
  line: number
): string | undefined {
  if (text === undefined) return undefined;
  return text.split("\n")[line - 1];
}

/** 判定で分かったことを、もとの補足へ足す */
export function appendNote(note: string, explanation: string): string {
  const extra = explanation.trim();
  if (!extra) return note;
  return note.trim() ? `${note.trim()}（判定: ${extra}）` : `判定: ${extra}`;
}

/**
 * 応答からJSONの本体を取り出す。読めなければ undefined。
 *
 * 前後に説明やコードフェンスを付けるモデルがあるので、いちばん外側の
 * `{`〜`}` だけを見る（ほかの検算器と同じ切り方）。
 */
export function parseFactJsonObject(
  text: string
): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
