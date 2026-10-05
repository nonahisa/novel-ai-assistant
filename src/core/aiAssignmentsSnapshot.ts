import { AIWRITER_DIR } from "../models/types";

/**
 * 機能ごとのAIの割り当ての写し（MCP の道具 `ai.settings`。作者の裁定、2026-10-01）。
 *
 * **なぜ要るか。** 割り当て（`novelai.ai.featureAssignments`）といま既定の AI
 * （`novelai.ai.provider`・`novelai.ai.model`）は、VS Code の設定ではなく
 * `globalState` にある（`ai/registry.ts`。設定同期で Ollama の無い端末へ
 * 割り当てが流れ込まないように、という理由）。どちらも VS Code の外からは
 * 読めないので、実機確認で「いま誤字脱字はどのモデルで動いているか」を
 * 確かめる手立てが無かった。そこで**拡張機能が写しを保管庫へ書き、MCP が
 * それを読む**（登録簿の写し `core/worksSnapshot.ts` と同じ形）。
 * **MCP から割り当てを書き換える道は作らない。**
 *
 * **鍵は写さない——伏せるのではなく、そもそも載せない。** 鍵は
 * OS の資格情報ストア（`SecretStorage`）にあり、割り当てには入っていない。
 * それでも「割り当てをそのまま写す」と、将来だれかが割り当てに欄を足した日に
 * その欄まで外へ出る。だから**プロバイダIDとモデル名の2つだけを名指しで拾う**
 * （読む側も同じ。手で触られた写しに余分な欄があっても返さない）。
 *
 * ここは**形と判定だけ**。書く側（`features/aiAssignmentsSnapshot.ts`）と
 * 読む側（`mcp/tools/aiSettings.ts`）が同じものを見る。
 */

/** 写しの置き場（保管庫からの相対） */
export const AI_ASSIGNMENTS_SNAPSHOT_PATH = [AIWRITER_DIR, "ai-assignments.json"] as const;

/** 写しの形の版。読めない版は「壊れた写し」として扱う */
export const AI_ASSIGNMENTS_SNAPSHOT_SCHEMA = 1;

/** プロバイダとモデル。**この2つ以外は持たない** */
export interface AiChoice {
  provider: string;
  model: string;
}

export interface AiAssignmentRow {
  /** 機能の鍵（`extract`・`typo` など。`ai/registry.ts` の `AssignableFeature`） */
  feature: string;
  /** 画面に出る機能の名前 */
  label: string;
  /** 作者がこの機能に割り当てたAI。**無ければ `null`**（既定のAIで動く） */
  assigned: AiChoice | null;
  /**
   * 実際に動くAI（割り当てがあればそれ、無ければ既定）。既定も無ければ `null`。
   *
   * **割り当て先が使えないときに既定へ落ちる分岐**（`AIRegistry.resolve`）は
   * ここに映らない。落ちるのはブラウザ版で手元のAIを割り当てたときだけで、
   * この写しはブラウザ版では書かない（読む MCP が走らない）ので、食い違わない。
   */
  effective: AiChoice | null;
}

export interface AiAssignmentsSnapshot {
  schema: number;
  /** 写しを書いた時刻（ISO）。**古い写しと分かるように必ず返す** */
  writtenAt: string;
  /** 書いた窓（`worksSnapshot` と同じ。最後に書いた窓から見た割り当てになる） */
  writtenBy: {
    pid: number | null;
    extensionVersion: string;
    machineName: string | null;
  };
  /** いま既定の AI。未設定なら `null` */
  defaultAi: AiChoice | null;
  /** 機能ごと（選択画面と同じ順） */
  features: AiAssignmentRow[];
  /**
   * 意味検索（ベクトル検索）の設定（0.99.19）。MCP の `novel.search` が、
   * **索引のモデルが今の設定と同じか**を確かめ、検索語を埋め込む Ollama の
   * 場所を知るために読む。**古い写しには無い**（そのときは照合を飛ばす）
   */
  vectorSearch?: VectorSearchSetting;
}

export interface VectorSearchSetting {
  enabled: boolean;
  /** 埋め込みのモデル（`novelai.vectorSearch.model`） */
  model: string;
  /** Ollama の場所（`novelai.ollama.endpoint`） */
  endpoint: string;
}

export interface AiAssignmentsWriter {
  pid: number | null;
  extensionVersion: string;
  machineName: string | null;
}

/**
 * 写しの材料。**型を緩く受ける**——`globalState` の中身は手で触られうるので、
 * 形を確かめるのはこちらの仕事にする。
 */
export interface AiAssignmentsSource {
  defaultProvider: unknown;
  defaultModel: unknown;
  /** `AIRegistry.assignments()` の戻り（機能の鍵 → `{ provider, model }`） */
  assignments: unknown;
  /** 並べる機能と、その表示名（`ASSIGNABLE_FEATURES` と `ASSIGNABLE_FEATURE_LABELS`） */
  features: readonly { key: string; label: string }[];
  /** 意味検索の設定。形が合わなければ写さない */
  vectorSearch?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * プロバイダとモデルの**2つだけ**を拾う。どちらかが欠けていれば `null`。
 * 余分な欄は見もしない（鍵らしきものが紛れていても写らない）。
 */
function choiceOf(provider: unknown, model: unknown): AiChoice | null {
  if (!nonEmpty(provider) || !nonEmpty(model)) return null;
  return { provider, model };
}

function choiceFromRecord(value: unknown): AiChoice | null {
  if (!isObject(value)) return null;
  return choiceOf(value.provider, value.model);
}

/**
 * 写しを組み立てる。**時刻は引数で受ける**（テストで固定できるように）。
 *
 * **並べるのは渡された機能の一覧だけ。** 割り当てに一覧に無い鍵が残って
 * いても（機能を畳んだ古い版の名残）写さない——製品はその割り当てを
 * 引かないので、写すと「効いていない割り当て」を効いているように見せる。
 */
export function buildAiAssignmentsSnapshot(
  source: AiAssignmentsSource,
  writer: AiAssignmentsWriter,
  now: Date
): AiAssignmentsSnapshot {
  const defaultAi = choiceOf(source.defaultProvider, source.defaultModel);
  const table = isObject(source.assignments) ? source.assignments : {};
  const features = source.features.map((feature): AiAssignmentRow => {
    const assigned = choiceFromRecord(table[feature.key]);
    return {
      feature: feature.key,
      label: feature.label,
      assigned,
      effective: assigned ?? defaultAi,
    };
  });
  return {
    schema: AI_ASSIGNMENTS_SNAPSHOT_SCHEMA,
    writtenAt: now.toISOString(),
    writtenBy: {
      pid: writer.pid,
      extensionVersion: writer.extensionVersion,
      machineName: writer.machineName,
    },
    defaultAi,
    features,
    ...withVectorSearch(source.vectorSearch),
  };
}

/** 意味検索の設定を名指しで拾う。どれかが欠けていれば undefined（写さない） */
function vectorSearchOf(value: unknown): VectorSearchSetting | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.enabled !== "boolean" || !nonEmpty(value.model) || !nonEmpty(value.endpoint)) {
    return undefined;
  }
  return { enabled: value.enabled, model: value.model, endpoint: value.endpoint };
}

function withVectorSearch(value: unknown): { vectorSearch?: VectorSearchSetting } {
  const setting = vectorSearchOf(value);
  return setting ? { vectorSearch: setting } : {};
}

export function serializeAiAssignmentsSnapshot(snapshot: AiAssignmentsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** `null` か、2つの名前がそろった選択か。**それ以外は壊れている**（`undefined`） */
function parseChoice(value: unknown): AiChoice | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  if (typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
  return { provider: value.provider, model: value.model };
}

/**
 * 写しを読む。**形が合わなければ `undefined`**（直しにいかない）。
 *
 * 登録簿の写しと同じく、1行でも読めなければ写しごと「壊れている」と返す
 * ——1機能だけ抜けた写しを返すと、その機能が既定で動いているように読める。
 * **読むときも名指しで拾い直す**ので、余分な欄は返らない。
 */
export function parseAiAssignmentsSnapshot(text: string): AiAssignmentsSnapshot | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  if (raw.schema !== AI_ASSIGNMENTS_SNAPSHOT_SCHEMA) return undefined;
  if (typeof raw.writtenAt !== "string") return undefined;
  const writer = raw.writtenBy;
  if (
    !isObject(writer) ||
    (writer.pid !== null && typeof writer.pid !== "number") ||
    typeof writer.extensionVersion !== "string" ||
    (writer.machineName !== null && typeof writer.machineName !== "string")
  ) {
    return undefined;
  }
  const defaultAi = parseChoice(raw.defaultAi);
  if (defaultAi === undefined) return undefined;
  if (!Array.isArray(raw.features)) return undefined;
  const features: AiAssignmentRow[] = [];
  for (const item of raw.features) {
    if (!isObject(item) || typeof item.feature !== "string" || typeof item.label !== "string") {
      return undefined;
    }
    const assigned = parseChoice(item.assigned);
    const effective = parseChoice(item.effective);
    if (assigned === undefined || effective === undefined) return undefined;
    features.push({ feature: item.feature, label: item.label, assigned, effective });
  }
  return {
    schema: AI_ASSIGNMENTS_SNAPSHOT_SCHEMA,
    writtenAt: raw.writtenAt,
    writtenBy: {
      pid: writer.pid as number | null,
      extensionVersion: writer.extensionVersion,
      machineName: writer.machineName as string | null,
    },
    defaultAi,
    features,
    // **任意の欄。** 形が合わないときは写しごと捨てず、この欄だけ無いものとして読む
    // （古い版の拡張機能が書いた写しと同じ扱い）
    ...withVectorSearch(raw.vectorSearch),
  };
}
