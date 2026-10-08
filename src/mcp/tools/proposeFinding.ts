import * as fs from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { AIWRITER_DIR } from "../../models/types";
import {
  FINDINGS_FILE_NAME,
  parseFindingLines,
  resolveFindings,
  type Finding,
  type FindingOrigin,
  type FindingProducer,
  type FindingStatus,
} from "../../models/finding";
import { locateChunkLine, type Chunk } from "../../core/chunker";
import {
  locateProofreadIssue,
  proposalDetail,
} from "../../core/proofreadValidation";
import {
  buildFinding,
  describeComparison,
  type FindingDraft,
} from "../../core/findingSource";
import { hashBytes } from "../../core/hash";
import { FEATURE_LABELS, type FeatureName } from "../../core/mcpFeatures";
import { typoValidate } from "./typo";
import { proofreadValidate } from "./proofread";
import { contradictionValidate } from "./contradiction";
import { getExternalClientName } from "./accessLog";
import {
  McpToolError,
  chunkFromId,
  readBody,
  resolveInsideFolder,
} from "./shared";

/**
 * 外部AIが出した指摘（誤字脱字・推敲・矛盾）を、提案パネルへ置く
 * （作者の裁定、2026-10-01。MCP `novel.propose` の `kind: "finding"`）。
 *
 * 背景：作者の作品を、外部AI（Claude Code の Sonnet など）が内部AIの代わりに
 * 一通り回す測定をしている。その結果を、作者がいつもの提案パネルで
 * 1件ずつ当てられるようにする。
 *
 * ## 渡された答えを信じない（実装ルール3）
 *
 * **検算をこちらでやり直す。** 呼んだ側が `novel.validate` を通したと言っても、
 * 信じない——`novel.validate` が呼ぶのと同じ関数（`typoValidate`・
 * `proofreadValidate`・`contradictionValidate`）へ `novel.prompt` の答えを
 * そのまま通し、**通ったものだけを置く**。落ちたものは検算の理由のまま返す。
 *
 * ## 置くのは提案の置き場だけ
 *
 * 置き場は**拡張機能が検知の結果を数日残している所**
 * （`.aiwriter/findings.jsonl`、設計書6.96）。提案パネルは開いたときに
 * ここを読んで戻す（`features/primeFindings.ts`）ので、**写しの形を作らない**。
 * 原稿にも設定資料にも1バイトも触らない。書き方は**追記だけ**
 * （`appendFileSync`）——置き場は同期されるので、前の行を書き換える形に
 * すると、そこが同期の衝突点になる（`FindingStore` と同じ決まり）。
 *
 * ## 古さ（設計書5.4.4）
 *
 * 置いたときの本文の指紋（ファイル全体とチャンクのハッシュ）を持たせる。
 * 当てるかどうかは、拡張機能の既存の扱いのまま——開くたびに原文で位置を
 * 探し直し（原文が消えていれば並べない）、当てる直前にもう一度原文を照らす。
 * 指紋が合わなければ、パネルの行に「置いたあとで原稿が変わっています」と添える。
 */

/**
 * 置ける機能。**提案パネルに戻し方の決まっている、位置を持つ指摘だけ。**
 *
 * 置けないものと、その理由（断り文句にも同じことを書く）。
 *
 * - 表記ゆれ（notation）：AIは揃え先を答えるだけで、どこを直すかは
 *   コードの検出が決める。答えから1件ずつの指摘は組めない
 * - 矛盾検知（事実の照合。factContradiction）：1チャンクの検算で出るのは
 *   事実であって矛盾ではない（照合は作品ぜんたいでしか決まらない）
 * - プロット逸脱（deviation）：まだ作っていない（話ごとの検算で、
 *   行の扱いが違う）
 */
export const FINDING_PROPOSE_FEATURES = [
  "typo",
  "proofread",
  "contradiction",
] as const satisfies readonly FeatureName[];

export type FindingProposeFeature = (typeof FINDING_PROPOSE_FEATURES)[number];

/** 提案パネルのタブの名前（`core/findingSource.ts` の表と同じ名前） */
const PANEL_CATEGORY: Record<FindingProposeFeature, string> = {
  typo: "誤字脱字",
  proofread: "推敲",
  contradiction: "矛盾",
};

const CATEGORY: Record<FindingProposeFeature, Finding["category"]> = {
  typo: "typo",
  proofread: "proofread",
  contradiction: "contradiction",
};

/**
 * `novel.propose` に足す引数（`kind: "finding"` のとき）。
 *
 * **説明は短くする。** 一覧は繋ぐたびに読まれる。`feature`・`chunkId`・
 * `response` の意味は `novel.validate` と同じなので、そちらを指す。
 */
export const FINDING_PROPOSE_INPUT = {
  kind: z
    .enum(["settings", "finding"])
    .optional()
    .describe(
      "settings（省略時）＝設定資料の更新案。finding＝指摘（typo・proofread・contradiction）を提案パネルへ置く。" +
        "finding では feature・chunkId・response（novel.validate と同じ）を渡し、name・changes・reason は要りません"
    ),
  feature: z
    .string()
    .optional()
    .describe("kind: finding のときの機能"),
  chunkId: z.string().optional().describe("kind: finding、または場所の relations のとき。novel.prompt が返した chunkId"),
  response: z
    .string()
    .optional()
    .describe("kind: finding のとき。AIの答え（novel.prompt の形そのまま）。こちらで検算し直し、通ったものだけを置きます"),
  model: z
    .string()
    .optional()
    .describe("kind: finding のとき。答えを出したモデルの名前（パネルの行に出ます）"),
};

export interface FindingProposeInput {
  folder: string;
  feature?: string;
  chunkId?: string;
  response?: string;
  model?: string;
}

/** 置かなかった1件と、その理由 */
export interface FindingNotPlaced {
  /** 検算で落ちたか（`validate`）、置く段で見送ったか（`place`） */
  stage: "validate" | "place";
  /** 理由の名前（検算の理由はそのまま） */
  reason: string;
  /** 作者にも読める言葉 */
  detail: string;
  /** どの指摘か（行と、直す語か引用）。分からなければ空 */
  line: number | null;
  quote: string;
}

export interface FindingProposeResult {
  kind: "finding";
  feature: FindingProposeFeature;
  /** 提案パネルのどのタブに出るか */
  category: string;
  /** 置いた先（作品フォルダーからの相対） */
  file: string;
  placedCount: number;
  notPlacedCount: number;
  /** 置いた指摘（番号・ファイル・行・直す語か引用） */
  placed: Array<{ id: string; file: string; line: number; quote: string }>;
  notPlaced: FindingNotPlaced[];
  /** 出どころとしてパネルに出る名乗りとモデル */
  origin: FindingOrigin;
  nextStep: string;
  note: string;
}

/** 検算を通った1件を、置く形の下書きにした途中の姿 */
interface Candidate {
  draft: FindingDraft;
  line: number;
  quote: string;
}

/**
 * 指摘を置く。**検算を通ったものだけ**を `.aiwriter/findings.jsonl` へ足す。
 *
 * 断る（何も置かない）のは、引数が足りないとき・置けない機能のとき・
 * 答えが検算の形に読めないとき（検算の関数がそのまま断る）。
 * **1件ずつの落とし方は断らずに返す**——通った分は置く。
 */
export function findingPropose(input: FindingProposeInput): FindingProposeResult {
  const feature = featureOf(input.feature);
  const chunkId = input.chunkId?.trim();
  if (!chunkId) {
    throw new McpToolError(
      `${labelOf(feature)} の指摘を置くには chunkId が要ります（novel.prompt が返したものをそのまま渡してください）。`
    );
  }
  if (typeof input.response !== "string" || !input.response.trim()) {
    throw new McpToolError(
      `${labelOf(feature)} の指摘を置くには response（AIの答え）が要ります。`
    );
  }
  /*
    **無い作品フォルダーには置かない**（人物の道と同じ）。`mkdirSync` は
    道を作ってしまうので、綴りを間違えたまま置くと、作者がどこを見ても
    見つからない指摘ができる。
  */
  if (!fs.existsSync(nodePath.resolve(input.folder))) {
    throw new McpToolError(
      `作品フォルダーが見つかりません: ${input.folder}（novel.scan が通る場所を指定してください）`
    );
  }

  // **製品と同じ検算**（`novel.validate` が呼ぶのと同じ関数）。形が読めなければここで断る
  const chunk = chunkFromId(input.folder, chunkId);
  const { candidates, notPlaced } = validateFor(feature, input.folder, chunkId, chunk, input.response);

  const origin: FindingOrigin = {
    kind: "external",
    client: getExternalClientName(),
    model: input.model?.trim() ?? "",
  };
  /*
    **採った率を数える鍵**（設計書6.49.7）。モデルの名前が分からないと
    「どのモデルの手柄か」を決められないので、名乗られたときだけ持たせる。
    プロバイダIDに接続元を入れるのは、中のAI（ollama など）と混ざらないため
  */
  const producer: FindingProducer | undefined = origin.model
    ? { providerId: `external:${origin.client || "unknown"}`, model: origin.model }
    : undefined;

  const target = nodePath.join(nodePath.resolve(input.folder), AIWRITER_DIR, FINDINGS_FILE_NAME);
  const existing = readExistingStatuses(target);
  const time = new Date().toISOString();
  const texts = new Map<string, { text: string; hash: string }>();
  const findings: Finding[] = [];
  const placedIds = new Set<string>();

  for (const candidate of candidates) {
    const relative = candidate.draft.filePath;
    if (!texts.has(relative)) texts.set(relative, readWithHash(input.folder, relative));
    const body = texts.get(relative)!;

    const finding = buildFinding(
      input.folder,
      {
        ...candidate.draft,
        producer,
        origin,
        fingerprint: { fileHash: body.hash, chunkHash: chunk.hash },
      },
      body.text,
      time
    );
    if (!finding) {
      // 検算は通ったのに、本文から原文を探し直せなかった（行の取り違えなど）
      notPlaced.push({
        stage: "place",
        reason: "not_located",
        detail: "原文を本文の中に見つけられませんでした（置いても提案パネルに並びません）",
        line: candidate.line,
        quote: candidate.quote,
      });
      continue;
    }

    /*
      **作者がもう判断した指摘は置き直さない。** 番号は中身から決まる
      （行を含まない）ので、退けたものを置き直しても画面には出ない——
      出ないのに「置いた」と返すと、呼んだ側は数を読み違える。
      **まだ判断していない同じ指摘も置かない**（中のAIが先に出したものなら、
      その出どころを上書きしない）。同じ答えに同じ指摘が2つあっても1件だけ置く
    */
    const status = existing.get(finding.id);
    if (status === "accepted" || status === "dismissed") {
      notPlaced.push({
        stage: "place",
        reason: status === "accepted" ? "already_accepted" : "already_dismissed",
        detail:
          status === "accepted"
            ? "作者がすでに採った指摘です"
            : "作者がすでに退けた指摘です",
        line: candidate.line,
        quote: candidate.quote,
      });
      continue;
    }
    if (status === "pending" || placedIds.has(finding.id)) {
      notPlaced.push({
        stage: "place",
        reason: "already_placed",
        detail: "同じ指摘が、もう提案の置き場にあります",
        line: candidate.line,
        quote: candidate.quote,
      });
      continue;
    }
    placedIds.add(finding.id);
    findings.push(finding);
  }

  appendFindings(target, findings);

  const category = PANEL_CATEGORY[feature];
  return {
    kind: "finding",
    feature,
    category,
    file: `${AIWRITER_DIR}/${FINDINGS_FILE_NAME}`,
    placedCount: findings.length,
    notPlacedCount: notPlaced.length,
    placed: findings.map((finding) => ({
      id: finding.id,
      file: finding.file,
      line: finding.hintLine,
      quote: finding.target || finding.original,
    })),
    notPlaced,
    origin,
    nextStep:
      findings.length > 0
        ? `VS Code で提案パネルを開くと（コマンド「提案パネルを開く」）、「${category}」のタブに出ます。当てるのは作者が1件ずつです。`
        : "置いた指摘はありません。",
    note:
      "原稿・設定資料は書き換えていません。検算はこちらでやり直し、通ったものだけを置きました（notPlaced に落とした理由）。",
  };
}

/** 機能の名前を確かめる。**置けない機能は、理由を挙げて断る** */
function featureOf(value: string | undefined): FindingProposeFeature {
  const name = value?.trim() ?? "";
  if ((FINDING_PROPOSE_FEATURES as readonly string[]).includes(name)) {
    return name as FindingProposeFeature;
  }
  const why: Record<string, string> = {
    notation: "表記ゆれは、AIが揃え先を答えるだけで、どこを直すかはコードの検出が決めるため",
    factContradiction: "事実の照合は、1チャンクの検算では事実しか出ず、矛盾は作品ぜんたいでしか決まらないため",
    deviation: "プロット逸脱は、まだこの道を作っていないため",
  };
  const reason = why[name];
  throw new McpToolError(
    (name ? `feature: ${name} の指摘は置けません` : "kind: finding には feature が要ります") +
      (reason ? `（${reason}）` : "") +
      `。置けるのは ${FINDING_PROPOSE_FEATURES.join("・")} です。`
  );
}

function labelOf(feature: FindingProposeFeature): string {
  return FEATURE_LABELS[feature];
}

/**
 * 機能ごとの検算と、置く形への写し。
 *
 * **写し方は提案パネルと揃える**（`showResults`・`showContradictions` →
 * `findingDraftOf`）。行は**チャンクの番号から本文の行へ戻す**
 * （`locateChunkLine`。製品の `checkTypos.ts` と同じ）。戻せない行は置かない。
 */
function validateFor(
  feature: FindingProposeFeature,
  folder: string,
  chunkId: string,
  chunk: Chunk,
  response: string
): { candidates: Candidate[]; notPlaced: FindingNotPlaced[] } {
  const candidates: Candidate[] = [];
  const notPlaced: FindingNotPlaced[] = [];
  const label = PANEL_CATEGORY[feature];
  const unlocatable = (line: number, quote: string): void => {
    notPlaced.push({
      stage: "place",
      reason: "line_unmappable",
      detail: `行番号 ${line} を本文の行へ戻せませんでした`,
      line,
      quote,
    });
  };

  if (feature === "typo") {
    const result = typoValidate({ folder, chunkId, response });
    for (const rejected of result.rejected) {
      notPlaced.push({
        stage: "validate",
        reason: rejected.reason,
        detail: "検算で落ちました（理由は reason。novel.validate と同じ）",
        line: rejected.line,
        quote: rejected.target ?? "",
      });
    }
    for (const issue of result.accepted) {
      const at = locateChunkLine(chunk, issue.line);
      if (!at) {
        unlocatable(issue.line, issue.target);
        continue;
      }
      candidates.push({
        line: at.line,
        quote: issue.target,
        draft: {
          filePath: at.filePath,
          line: at.line,
          original: issue.original,
          target: issue.target,
          suggestion: issue.suggestion,
          message: [issue.reason, proposalDetail(issue)].filter(Boolean).join("："),
          category: CATEGORY.typo,
          label,
        },
      });
    }
    return { candidates, notPlaced };
  }

  if (feature === "proofread") {
    const result = proofreadValidate({ folder, chunkId, response });
    for (const rejected of result.rejected) {
      notPlaced.push({
        stage: "validate",
        reason: rejected.reason,
        detail: "検算で落ちました（理由は reason。novel.validate と同じ）",
        line: lineOfRaw(rejected.raw),
        quote: "",
      });
    }
    for (const issue of result.accepted) {
      // 語尾単調の説明（行範囲入り）は、行が確定するここで組む（製品と同じ）
      const located = locateProofreadIssue(chunk, issue);
      if (!located) {
        unlocatable(issue.line, issue.target);
        continue;
      }
      candidates.push({
        line: located.line,
        quote: located.target,
        draft: {
          filePath: located.filePath,
          line: located.line,
          original: located.original,
          target: located.target,
          suggestion: located.suggestion,
          message: [located.reason, proposalDetail(located)].filter(Boolean).join("："),
          category: CATEGORY.proofread,
          label,
        },
      });
    }
    return { candidates, notPlaced };
  }

  const result = contradictionValidate({ folder, chunkId, response });
  for (const rejected of result.rejected) {
    notPlaced.push({
      stage: "validate",
      reason: rejected.reason,
      detail: "検算で落ちました（理由は reason。novel.validate と同じ）",
      line: lineOfRaw(rejected.raw),
      quote: "",
    });
  }
  for (const issue of result.accepted) {
    const at = locateChunkLine(chunk, issue.line);
    if (!at) {
      unlocatable(issue.line, issue.excerpt);
      continue;
    }
    // 見出しは提案パネルの矛盾と同じ（`showContradictions`）
    const compared = {
      leftLabel: "設定では",
      left: issue.settingSays,
      rightLabel: "本文では",
      right: issue.textSays,
      note: issue.note,
    };
    candidates.push({
      line: at.line,
      quote: issue.excerpt,
      draft: {
        filePath: at.filePath,
        line: at.line,
        original: issue.excerpt,
        // 矛盾は直し方を出さない。**空のまま残す**（無い値を作らない）
        target: "",
        suggestion: "",
        message: describeComparison(compared),
        category: CATEGORY.contradiction,
        label,
        compared,
      },
    });
  }
  return { candidates, notPlaced };
}

/** 検算で落ちた生の答えから、行番号だけを拾う（理由の手がかり） */
function lineOfRaw(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const line = (raw as Record<string, unknown>).line;
  return typeof line === "number" ? line : null;
}

/**
 * 本文とその指紋。指紋は**拡張機能の `readTextFile` と同じ作り方**
 * （バイト列そのものの `hashBytes`）——作り方がずれると、原稿が変わって
 * いなくても「変わった」と添えることになる。
 */
function readWithHash(folder: string, relative: string): { text: string; hash: string } {
  const bytes = fs.readFileSync(resolveInsideFolder(folder, relative));
  return { text: readBody(folder, relative), hash: hashBytes(bytes) };
}

/** いま置き場にある指摘の状態（番号 → いまの判断）。読めなければ空 */
function readExistingStatuses(target: string): Map<string, FindingStatus> {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return new Map();
  }
  const statuses = new Map<string, FindingStatus>();
  for (const view of resolveFindings(parseFindingLines(text))) {
    statuses.set(view.id, view.status);
  }
  return statuses;
}

/**
 * 置き場へ足す。**追記だけ**（`FindingStore` と同じ決まり。同期の衝突を避ける）。
 *
 * 前の中身が改行で終わっていなければ、先に改行を足す——足さないと、
 * 前の行と今回の1行目がつながって**両方が読めない行**になる。
 */
function appendFindings(target: string, findings: readonly Finding[]): void {
  if (findings.length === 0) return;
  const lines = findings
    .map((finding) => JSON.stringify({ kind: "finding", ...finding }))
    .join("\n");
  try {
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    const needsBreak = endsWithoutNewline(target);
    fs.appendFileSync(target, `${needsBreak ? "\n" : ""}${lines}\n`, "utf8");
  } catch (error) {
    throw new McpToolError(
      `提案の置き場へ書けませんでした: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function endsWithoutNewline(target: string): boolean {
  try {
    const bytes = fs.readFileSync(target);
    return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  } catch {
    return false;
  }
}
