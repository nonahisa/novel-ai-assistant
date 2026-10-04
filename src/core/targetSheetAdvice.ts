import {
  READER_AXIS_ORDER,
  readerGaps,
  type ReaderAxis,
  type ReaderChatSource,
  type ReaderGap,
  type ReaderTypeId,
} from "./readerTarget";
import { READER_TYPE_IDS } from "./readerTypeNeighbors";
import { isPlaceholderText } from "./placeholderText";
import { sha1Text } from "./hash";
import {
  targetSheetFor,
  type TargetSheetAim,
  type TargetSheetDirection,
} from "./targetSheet";
import { readAim } from "./targetSheetDoc";
import {
  hasReaderProfile,
  type ReaderEvidence,
  type ReaderProfile,
  type ReaderScores,
} from "../models/readerProfile";

/**
 * ターゲットシートの「助言」（設計書6.108.4 の第3段、P-46）。
 *
 * 狙い（作者の欄の層と理由）と、書き方の判断・本文の実像の点数から機械が
 * 出した「一致とずれ」「向かう先」を材料に、**どの軸をどちらへ寄せると
 * 狙いに近づくか**を AI に短く書かせる。
 *
 * ## AI に決めさせないもの（実装ルール3）
 *
 * - **数字**：一致度・点数はシートの欄が持つ。AI の文に、材料に無い数字が
 *   あれば、その項目ごと捨てる（作り話の数字を紙に載せない）
 * - **向き**：軸をどちらへ動かせば狙いに寄るかは、点数と中心から機械が
 *   決まる。AI が逆を言ったら捨てる。**動かしてよい軸と向きは
 *   `allowed` だけ**（狙いとのずれから導く）
 * - **引用**：「」で括った文（`QUOTE_CHECK_MIN` 字以上）が材料に無ければ
 *   捨てる。本文の書き換え案（「こう書き直す」の文例）を出させないための
 *   歯止めでもある
 *
 * ## 無理に助言を作らない（プロンプト設計書1.9）
 *
 * 寄せ方（`advice`）が0件でも、合っている所（`keep`）か総評があれば
 * 正常な答えとして扱う。0件を失敗と数えると、件数を埋めるための助言を
 * 誘うことになる。
 *
 * VS Code API にも AI にも依存しない。
 */

/** 記録の置き場（`設定/ターゲットシート/` の下）。適合度の記録と同じ段 */
export const TARGET_SHEET_ADVICE_FILE = "助言.json";
export const TARGET_SHEET_ADVICE_SCHEMA_VERSION = "1";

/** 総評の字数の上限（紙の1行に収まる長さ） */
export const ADVICE_OVERALL_MAX = 80;
/** 合っている所・寄せ方の1件の字数の上限 */
export const ADVICE_ITEM_MAX = 100;
/** 相談・材料へ渡す理由の字数の上限（作者の1行。長すぎる手書きを丸ごと送らない） */
export const AIM_REASON_MAX = 120;

export type AdviceDirection = "up" | "down";

/** 寄せ方1件 */
export interface TargetSheetAdviceItem {
  readonly axis: ReaderAxis;
  readonly direction: AdviceDirection;
  readonly text: string;
}

/**
 * 助言の材料。**シートに既にある欄だけから組む**（新しい判断を足さない）。
 */
export interface TargetSheetAdviceMaterial {
  /** 狙いの層ごとの一致度とずれ（`targetSheetFor` の結果そのまま） */
  readonly aims: readonly TargetSheetAim[];
  /** 作者の理由（1行。無ければ空文字） */
  readonly reason: string;
  /** シートの「実態」に使った点数とその出どころ（実像を先に採る） */
  readonly scores: ReaderScores;
  readonly source: ReaderChatSource;
  /** いちばん高い層 */
  readonly top: ReaderTypeId;
  /** 書き方の判断と本文の実像のずれ（両方あるときだけ） */
  readonly judgementGaps: readonly ReaderGap[];
  /** 本文の実像の根拠（検算済みの引用） */
  readonly evidence: readonly ReaderEvidence[];
  /**
   * 本文から読み取れなかった軸（実像で、根拠が無く3に置かれた軸）。
   * **寄せてよい軸に入れない**
   */
  readonly unmeasured: readonly ReaderAxis[];
  readonly expand?: TargetSheetDirection;
  readonly converge?: TargetSheetDirection;
  /**
   * 動かしてよい軸と向き。狙いとのずれ（中心へ寄せる向き）から導く
   * （収束はこの中に入る。拡大は狙いと逆の向きになりうるので入れない）。
   * **AI の答えはこの組み合わせの中でしか採らない**
   */
  readonly allowed: Readonly<Partial<Record<ReaderAxis, readonly AdviceDirection[]>>>;
  /**
   * 材料の指紋。狙い・理由・点数・出どころ・根拠が変われば変わる。
   * **同じ指紋・同じ版・同じAIなら作り直さない**（推移の控えと同じ考え方）
   */
  readonly mark: string;
}

/** 材料が組めない理由。**推測で埋めずに、何を済ませればよいかを言う** */
export type TargetSheetAdviceMissing = "aim" | "scores";

/**
 * シートの「実態」に使う点数を選ぶ。**実像（書けているもの）を先に採る。**
 *
 * 相談へ渡す読者像（`chatReaderBasis`）は宣言を先に採るが、あちらは
 * 「作者が向かおうとしている先へ助言を添える」ための選び方である。
 * シートが見たいのは書けているものなので、逆の順になる。
 */
export function targetSheetBasis(
  profile: ReaderProfile | undefined
): { scores: ReaderScores; source: ReaderChatSource } | undefined {
  if (!profile || !hasReaderProfile(profile)) return undefined;
  if (profile.actual) return { scores: profile.actual.scores, source: "actual" };
  if (profile.declared) {
    return { scores: profile.declared.scores, source: "declared" };
  }
  return undefined;
}

/**
 * 助言の材料を組む。狙いが無い・点数が無いときは組まずに理由を返す
 * （6.107「実行したふり」：空の材料で AI を呼ばない）。
 */
export function buildTargetSheetAdviceMaterial(input: {
  readonly authorBlock: string | undefined;
  readonly profile: ReaderProfile | undefined;
}):
  | { readonly material: TargetSheetAdviceMaterial }
  | { readonly missing: TargetSheetAdviceMissing } {
  const aim = readAim(input.authorBlock);
  if (!aim) return { missing: "aim" };
  const basis = targetSheetBasis(input.profile);
  if (!basis) return { missing: "scores" };

  const sheet = targetSheetFor({ aim: aim.types, scores: basis.scores });
  // 点数があれば実態は必ず出る（targetSheetFor の約束）。型のための確かめ
  if (!sheet.actual) return { missing: "scores" };

  const reason = clipReason(aim.reason);
  const declared = input.profile?.declared?.scores;
  const actual = input.profile?.actual;
  const judgementGaps = declared && actual ? readerGaps(declared, actual.scores) : [];
  const evidence = actual?.evidence ?? [];

  const allowed: Partial<Record<ReaderAxis, AdviceDirection[]>> = {};
  const allow = (axis: ReaderAxis, direction: AdviceDirection): void => {
    const list = allowed[axis] ?? [];
    if (!list.includes(direction)) list.push(direction);
    allowed[axis] = list;
  };
  /*
    **狙いへ寄せる向きだけ**を許す。収束（`converge`）は狙いへのずれの1本なので
    ここに含まれる。拡大（`expand`）は「いまの読者を保ったまま隣の層も取る」
    向きで、狙いとは逆の向きになる軸がある（例：読み慣れを狙いの考察層へは
    上げ、隣の層へは下げる）。助言は狙いへの寄せ方なので、拡大の向きは許さない
  */
  /*
    **本文から読み取れなかった軸は動かさない。** 実像の検算は、根拠の無い軸を
    「どちらとも言えない」の3に置く（6.91.6）。その3を狙いの中心と比べて
    「下げましょう」と言うと、測っていない点を根拠に助言することになる
  */
  const unmeasured = unmeasuredAxesOf(basis.source, actual);
  for (const entry of sheet.aims) {
    // 中心より上にいれば下げる、下にいれば上げる（`axisMove` と同じ向き）
    for (const gap of entry.gaps) {
      if (unmeasured.includes(gap.axis)) continue;
      allow(gap.axis, gap.diff > 0 ? "down" : "up");
    }
  }

  const mark = sha1Text(
    JSON.stringify({
      aims: aim.types,
      reason,
      source: basis.source,
      scores: READER_AXIS_ORDER.map((axis) => basis.scores[axis]),
      declared: declared ? READER_AXIS_ORDER.map((axis) => declared[axis]) : null,
      evidence: evidence.map((item) => [item.axis, item.quote]),
    })
  ).slice(0, 12);

  return {
    material: {
      aims: sheet.aims,
      reason,
      scores: basis.scores,
      source: basis.source,
      top: sheet.actual.top,
      judgementGaps,
      evidence,
      unmeasured,
      ...(sheet.expand ? { expand: sheet.expand } : {}),
      ...(sheet.converge ? { converge: sheet.converge } : {}),
      allowed,
      mark,
    },
  };
}

/** 実像の検算が「どちらとも言えない」に置く点（6.91.6） */
const UNMEASURED_SCORE = 3;

/**
 * 本文から読み取れなかった軸。**点の出どころが実像のときだけ**見る
 * ——宣言（9問）は作者の答えなので、根拠の引用を持たないのが普通である。
 * 根拠が無く3に置かれた軸を「読み取れなかった」とする（P-38 の指示も
 * 「判断の材料が足りない軸は、点数3にして根拠を空に」）。
 */
export function unmeasuredAxesOf(
  source: ReaderChatSource,
  actual: ReaderProfile["actual"]
): ReaderAxis[] {
  if (source !== "actual" || !actual) return [];
  return READER_AXIS_ORDER.filter(
    (axis) =>
      actual.scores[axis] === UNMEASURED_SCORE &&
      !actual.evidence.some((item) => item.axis === axis)
  );
}

/** 理由を1行・上限の字数に収める */
export function clipReason(reason: string): string {
  const line = reason.replace(/\s*\r?\n\s*/g, " ").trim();
  const chars = [...line];
  return chars.length > AIM_REASON_MAX
    ? `${chars.slice(0, AIM_REASON_MAX).join("")}…`
    : line;
}

/* ───────────────────────────────────────────────────────────────
   AI の答えを確かめる
   ─────────────────────────────────────────────────────────────── */

export interface TargetSheetAdviceParse {
  /** 総評（1文）。読めなければ空文字 */
  readonly overall: string;
  /** 狙いに合っている所。**件数で切らない**（1.9の2） */
  readonly keep: readonly string[];
  /** 寄せ方。1つの軸につき1件まで */
  readonly advice: readonly TargetSheetAdviceItem[];
  /** 捨てた項目の数（紙に断り書きを出す） */
  readonly dropped: number;
  /** 捨てた理由（操作ログへ。作者の画面には出さない） */
  readonly notes: readonly string[];
  /** 紙に載せられる中身が1つでもあるか */
  readonly usable: boolean;
}

/**
 * プロンプトに書いた言葉が、そのまま中身として返ってくる形
 * （CLAUDE.md「繰り返し起きた失敗」3番）。欄の見出しや指示の言葉を
 * 答えとして採らない。
 */
const ECHO_TEXTS = [
  "助言",
  "総評",
  "合っている所",
  "合っているところ",
  "寄せ方",
  "なし",
  "特になし",
  "該当なし",
  "ありません",
  "特にありません",
  "理由",
  "一般論",
  "控えめに",
  "空の配列",
  "空文字",
  "overall",
  "keep",
  "advice",
  "text",
];

function normalizeEcho(text: string): string {
  return text.replace(/[「」『』（）()［］\[\]\s。、．.・:：]/g, "");
}

function isEcho(text: string, instructions: readonly string[]): boolean {
  const body = normalizeEcho(text);
  if (!body) return true;
  if (ECHO_TEXTS.some((echo) => body === normalizeEcho(echo))) return true;
  if (/^\d+字以内$/.test(body)) return true;
  // 指示の1行をそのまま写した答え（短い言い換えは拾わない。写しだけを見る）
  return instructions.some((line) => {
    const rule = normalizeEcho(line);
    return rule.length >= 8 && (body === rule || (body.length >= 12 && rule.includes(body)));
  });
}

/**
 * 「」の中身を材料と照らす長さの下限。これより短いものは強調の言い回しとして
 * 通す。書き換えの文例や作った引用は、ふつう一文の長さになる
 */
export const QUOTE_CHECK_MIN = 10;

/**
 * 「」の中身の末尾で、材料との違いを許す字数（活用の揺れ）。2026-10-04 に
 * e4b が層の説明「伏線を拾い、読み返し、辻褄を見ています」を「…辻褄を見る」と
 * 写し、寄せ方が全部落ちた
 */
export const QUOTE_TAIL_SLACK = 3;

/** 欄の名前と値。**作者に見せる文に出てはいけない英語** */
const FIELD_VALUE_LEAK =
  /\b(?:up|down|familiarity|posture|craving|axis|direction|overall|keep|advice)\b/i;

/** 半角に揃えた数字の並び（「３」と「3」を同じに見る） */
function numbersIn(text: string): string[] {
  const half = text.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  return half.match(/\d+/g) ?? [];
}

function halfDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * 1件の文を確かめる。捨てるなら理由、採るなら切り詰めた文。
 *
 * - 空・埋め草・指示語の返り → 捨てる
 * - 材料に無い数字 → 捨てる（**数字は紙の欄から写すもので、AI に作らせない**）
 * - 材料に無い「」の引用 → 捨てる（作った引用・書き換えの文例を載せない）
 * - 長すぎる → 上限で切って「…」
 */
function checkText(
  raw: unknown,
  max: number,
  sent: { readonly digits: string; readonly flat: string },
  instructions: readonly string[]
): { text: string } | { reason: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || isPlaceholderText(text, true) || isEcho(text, instructions)) {
    return { reason: "空か、指示の言葉の返りでした" };
  }
  // 欄の値（up・down・軸の英語名）が文に混ざる（2026-10-04、e4b が
  // 「「読み慣れ」を「down」に寄せる」と書いた）。作者には読めない言葉になる
  const leaked = text.match(FIELD_VALUE_LEAK);
  if (leaked) {
    return { reason: `欄の値がそのまま文に入っていました（${leaked[0]}）` };
  }
  for (const number of numbersIn(text)) {
    if (!sent.digits.includes(number)) {
      return { reason: `材料に無い数字がありました（${number}）` };
    }
  }
  for (const match of text.matchAll(/「([^」]+)」/g)) {
    const quoted = squash(halfDigits(match[1]));
    // 短いカギ括弧は強調の言い回し（「気軽さ」）で、引用でも文例でもない。
    // 2026-10-04 に 26b の総評が2回とも短い強調だけで落ちた
    if ([...quoted].length < QUOTE_CHECK_MIN) continue;
    // 末尾の活用の揺れ（「見ています」→「見る」）は写しとして通す。
    // 文例は材料に無い言葉を何字も足すので、末尾数字の差では通らない
    const stem = [...quoted].slice(0, -QUOTE_TAIL_SLACK).join("");
    if (!sent.flat.includes(quoted) && !sent.flat.includes(stem)) {
      return { reason: `材料に無い引用がありました（「${match[1]}」）` };
    }
  }
  const chars = [...text];
  return {
    text: chars.length > max ? `${chars.slice(0, max).join("")}…` : text,
  };
}

/**
 * AI の答えを確かめる。**形が合わなければ何も採らない**（投げない）。
 *
 * @param sentText  AI へ送った材料の文（数字と引用の照合に使う）
 * @param instructions  プロンプトの指示の行（そのまま返ってきた答えを捨てる）
 */
export function parseTargetSheetAdvice(
  value: unknown,
  material: TargetSheetAdviceMaterial,
  sentText: string,
  instructions: readonly string[] = []
): TargetSheetAdviceParse {
  const notes: string[] = [];
  const empty = (note: string): TargetSheetAdviceParse => ({
    overall: "",
    keep: [],
    advice: [],
    dropped: 0,
    notes: [note],
    usable: false,
  });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return empty("答えがJSONの形ではありませんでした");
  }
  const raw = value as Record<string, unknown>;
  const sent = { digits: halfDigits(sentText), flat: squash(halfDigits(sentText)) };
  let dropped = 0;

  let overall = "";
  // 空の総評は「書かなかった」であって、捨てた数には入れない
  if (typeof raw.overall === "string" ? raw.overall.trim() !== "" : raw.overall !== undefined) {
    const checked = checkText(raw.overall, ADVICE_OVERALL_MAX, sent, instructions);
    if ("text" in checked) overall = checked.text;
    else {
      dropped += 1;
      notes.push(`総評を捨てました：${checked.reason}`);
    }
  }

  const keep: string[] = [];
  const seenKeep = new Set<string>();
  for (const entry of Array.isArray(raw.keep) ? raw.keep : []) {
    // 小さいモデルは {"text": "…"} で返すことがある。どちらも受ける
    const text =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>).text
        : entry;
    const checked = checkText(text, ADVICE_ITEM_MAX, sent, instructions);
    if (!("text" in checked)) {
      dropped += 1;
      notes.push(`合っている所を1件捨てました：${checked.reason}`);
      continue;
    }
    if (seenKeep.has(checked.text)) continue;
    seenKeep.add(checked.text);
    keep.push(checked.text);
  }

  const advice: TargetSheetAdviceItem[] = [];
  for (const entry of Array.isArray(raw.advice) ? raw.advice : []) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      notes.push("寄せ方を1件捨てました：形が合いませんでした");
      continue;
    }
    const item = entry as Record<string, unknown>;
    const axis = READER_AXIS_ORDER.find((name) => name === item.axis);
    const direction =
      item.direction === "up" || item.direction === "down" ? item.direction : undefined;
    if (!axis || !direction) {
      dropped += 1;
      notes.push("寄せ方を1件捨てました：軸か向きが読めませんでした");
      continue;
    }
    // **向きは機械が決まる**。材料に無い軸・逆の向きは、文がどれだけ
    // もっともらしくても採らない
    if (!material.allowed[axis]?.includes(direction)) {
      dropped += 1;
      notes.push(`寄せ方を1件捨てました：${axis} を ${direction} は材料の向きと合いません`);
      continue;
    }
    // 1つの軸につき1件まで（6.108.3：軸を1本ずつ動かす提案に限る）
    if (advice.some((existing) => existing.axis === axis)) {
      dropped += 1;
      notes.push(`寄せ方を1件捨てました：${axis} への2件目でした`);
      continue;
    }
    const checked = checkText(item.text, ADVICE_ITEM_MAX, sent, instructions);
    if (!("text" in checked)) {
      dropped += 1;
      notes.push(`寄せ方を1件捨てました：${checked.reason}`);
      continue;
    }
    advice.push({ axis, direction, text: checked.text });
  }

  return {
    overall,
    keep,
    advice,
    dropped,
    notes,
    usable: Boolean(overall) || keep.length > 0 || advice.length > 0,
  };
}

/* ───────────────────────────────────────────────────────────────
   記録（`設定/ターゲットシート/助言.json`）
   ─────────────────────────────────────────────────────────────── */

export interface TargetSheetAdviceRecord {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly providerId: string;
  readonly model: string;
  readonly promptVersion: string;
  /** 作ったときの材料の指紋。紙で「材料が変わった」を言うのに使う */
  readonly materialMark: string;
  /** 作ったときの狙い（紙に添える） */
  readonly aims: readonly ReaderTypeId[];
  /** 作ったときに理由が書かれていたか */
  readonly reasonGiven: boolean;
  readonly source: ReaderChatSource;
  readonly overall: string;
  readonly keep: readonly string[];
  readonly advice: readonly TargetSheetAdviceItem[];
  /** 検算で捨てた項目の数 */
  readonly dropped: number;
}

/**
 * 前回と同じ材料・同じ頼み方・同じAIか。**同じなら AI を呼ばない**
 * （キャッシュの鍵と同じ4つ：内容・プロバイダ・モデル・版。実装ルール4）。
 */
export function isSameAdviceInput(
  record: TargetSheetAdviceRecord | undefined,
  current: {
    readonly materialMark: string;
    readonly providerId: string;
    readonly model: string;
    readonly promptVersion: string;
  }
): boolean {
  return (
    record !== undefined &&
    record.materialMark === current.materialMark &&
    record.providerId === current.providerId &&
    record.model === current.model &&
    record.promptVersion === current.promptVersion
  );
}

/**
 * 記録を読む。**形の合わないものは `undefined`**（直さない。
 * 作者が手で開くことも、別の端末から同期で降ってくることもある）。
 */
export function parseTargetSheetAdviceRecord(
  value: unknown
): TargetSheetAdviceRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof raw[key] === "string" ? (raw[key] as string) : undefined;

  const generatedAt = text("generatedAt");
  const materialMark = text("materialMark");
  if (!generatedAt || !materialMark) return undefined;
  const source = raw.source === "actual" || raw.source === "declared" ? raw.source : undefined;
  if (!source) return undefined;
  if (!Array.isArray(raw.aims) || !Array.isArray(raw.keep) || !Array.isArray(raw.advice)) {
    return undefined;
  }
  const aims: ReaderTypeId[] = [];
  for (const aim of raw.aims) {
    const type = READER_TYPE_IDS.find((id) => id === aim);
    if (!type) return undefined;
    aims.push(type);
  }
  if (!raw.keep.every((entry) => typeof entry === "string")) return undefined;
  const advice: TargetSheetAdviceItem[] = [];
  for (const entry of raw.advice) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const item = entry as Record<string, unknown>;
    const axis = READER_AXIS_ORDER.find((name) => name === item.axis);
    if (!axis) return undefined;
    if (item.direction !== "up" && item.direction !== "down") return undefined;
    if (typeof item.text !== "string") return undefined;
    advice.push({ axis, direction: item.direction, text: item.text });
  }

  return {
    schemaVersion: text("schemaVersion") ?? TARGET_SHEET_ADVICE_SCHEMA_VERSION,
    generatedAt,
    providerId: text("providerId") ?? "",
    model: text("model") ?? "",
    promptVersion: text("promptVersion") ?? "",
    materialMark,
    aims,
    reasonGiven: raw.reasonGiven === true,
    source,
    overall: text("overall") ?? "",
    keep: raw.keep as string[],
    advice,
    dropped:
      typeof raw.dropped === "number" && Number.isFinite(raw.dropped) ? raw.dropped : 0,
  };
}
