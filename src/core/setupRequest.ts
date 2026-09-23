import type { WorkKindKey } from "../models/types";
import { selectableWorkFormats, type WorkFormatKey } from "./workFormat";
import { WORK_KINDS } from "./workKind";

/**
 * Claude Code からのセットアップの依頼（設計書6.87.18）。
 *
 * Claude Code は MCP の道具 `setup.request` で
 * `vscode://nonahisa.novel-ai-assistant/setup?step=…` を開き、拡張機能が
 * 受け口で受けて、その段の操作を**作者の確認を経てから**呼ぶ。
 *
 * **開く側（MCP）と受ける側（拡張機能）が、ここの同じ判定を使う。**
 * 片方だけ通る依頼を作れないようにするためである。
 *
 * **URI はウェブページのリンク1つでも開かせられる。** だから白名簿で
 * 確かめる——知らない段・その段が受けない鍵・長すぎる値・制御文字は断る。
 * 黙って落とさず、断った理由を返す（受けたふりをしない）。
 *
 * VS Code API にも Node にも依存しない（MCP の束から使うため。
 * `test/unit/cross/mcpReach.test.ts`）。
 */

/** 受け口のパス（読者の反応・公募と同じ受け口に足す。1つの拡張機能に1つしか持てない） */
export const SETUP_URI_PATH = "/setup";

/** URI の宛先（発行者.名前）。`package.json` の publisher と name */
export const EXTENSION_URI_AUTHORITY = "nonahisa.novel-ai-assistant";

export type SetupStep =
  | "ollama"
  | "lmstudio"
  | "ai"
  | "vector"
  | "create"
  | "register"
  | "diagnosis"
  | "external-access";

/** 依頼に載せてよい引数。**これ以外の鍵は断る** */
export type SetupArgKey = "title" | "kind" | "format" | "start" | "path";

export type SetupStartMode = "plot" | "manuscript";

export interface SetupRequest {
  step: SetupStep;
  /** 作品名（作成・登録） */
  title?: string;
  /** 種類（小説・台本など。設計書6.109） */
  kind?: WorkKindKey;
  /** 形式（短編・長編など）。`unset` は「いまは決めない」 */
  format?: WorkFormatKey | "unset";
  /** 始め方（プロットから・本文から） */
  start?: SetupStartMode;
  /** 作品フォルダーの絶対パス（登録・外部AIの許可） */
  path?: string;
}

export interface SetupStepDef {
  step: SetupStep;
  /** 画面に出す名前 */
  label: string;
  /** 呼ぶコマンド（作成だけは中の関数を呼ぶが、名前はこれで示す） */
  command: string;
  /** 受ける引数 */
  accepts: readonly SetupArgKey[];
  /** 無いと断る引数 */
  requires: readonly SetupArgKey[];
  /** 手順書（MCP の prompts）に載せる一言 */
  purpose: string;
}

/**
 * 段の表。**ここが唯一の定義**で、受け口も MCP の道具も手順書もここを読む。
 *
 * 受ける操作は最小限にしてある（作者の裁定）。どれも作者が画面で押せる
 * 既存の操作で、**確認を飛ばす段は1つも無い**。
 */
export const SETUP_STEPS: readonly SetupStepDef[] = [
  {
    step: "ollama",
    label: "Ollama導入",
    command: "novelai.setupOllama",
    accepts: [],
    requires: [],
    purpose: "手元で動くAI（Ollama）を入れる。入れる前に、何をどれだけ取得するかを拡張機能が確かめる",
  },
  {
    step: "lmstudio",
    label: "LM Studio導入",
    command: "novelai.setupLmStudio",
    accepts: [],
    requires: [],
    purpose: "手元で動くAI（LM Studio）を入れる。起動とモデルの読み込みは LM Studio の画面で行う",
  },
  {
    step: "ai",
    label: "AI設定",
    command: "novelai.setupAI",
    accepts: [],
    requires: [],
    purpose: "使うAIとモデルを選ぶ。選ぶのは作者（クラウドのAIは鍵の入力もここ）",
  },
  {
    step: "vector",
    label: "ベクトル検索準備",
    command: "novelai.setupVectorSearch",
    accepts: [],
    requires: [],
    purpose: "言い換えの質問にも当たる検索を使えるようにする（モデルの取得が要る）",
  },
  {
    step: "create",
    label: "新規作品を作成",
    command: "novelai.createWork",
    accepts: ["title", "kind", "format", "start"],
    requires: [],
    purpose: "新しい作品のフォルダーを作って登録する。置き場（書庫）は拡張機能が決め、要れば作者に訊く",
  },
  {
    step: "register",
    label: "フォルダー登録",
    command: "novelai.addWork",
    accepts: ["path", "title"],
    requires: ["path"],
    purpose: "既にある作品フォルダーを登録する（path は絶対パス）",
  },
  {
    step: "diagnosis",
    label: "作家タイプ診断",
    command: "novelai.runWriterDiagnosis",
    accepts: [],
    requires: [],
    purpose: "書き方に合わせて、はじめに案内する操作を決める（AIは使わない）",
  },
  {
    step: "external-access",
    label: "外部AI許可／取消",
    command: "novelai.toggleExternalAccess",
    accepts: ["path"],
    requires: ["path"],
    purpose:
      "外部AI（Claude Code）にこの作品を読ませるかを作者が決める画面を開く（path は登録済みの作品の場所）",
  },
];

const ARG_KEYS: readonly SetupArgKey[] = ["title", "kind", "format", "start", "path"];

/** 値の長さの上限。**長い文字列を流し込ませない**（パスは長くなりうるので別） */
const MAX_VALUE_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;

export function findSetupStep(step: string): SetupStepDef | undefined {
  return SETUP_STEPS.find((def) => def.step === step);
}

export type SetupParseResult =
  | { ok: true; request: SetupRequest }
  | { ok: false; reason: string };

function refuse(reason: string): SetupParseResult {
  return { ok: false, reason };
}

/**
 * URI のクエリ（`?` の後ろ）を読む。
 *
 * **同じ鍵が2つあれば断る。** どちらを採るかを決める理由が無く、
 * 片方だけ確認に出して別の方を使う、という食い違いの種になる。
 */
export function parseSetupQuery(query: string): SetupParseResult {
  const params = new URLSearchParams(query.replace(/^\?/u, ""));
  const input: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      return refuse(`同じ引数（${safeKey(key)}）が2つあります。`);
    }
    input[key] = value;
  }
  return validateSetupRequest(input);
}

/**
 * 依頼の中身を確かめる（MCP の道具は引数をそのまま、受け口はクエリを読んでここへ渡す）。
 */
export function validateSetupRequest(
  input: Readonly<Record<string, unknown>>
): SetupParseResult {
  const step = input.step;
  if (typeof step !== "string" || !step) {
    return refuse("どの段の依頼か（step）がありません。");
  }
  const def = findSetupStep(step);
  if (!def) return refuse(`知らない段（${safeKey(step)}）です。`);

  const request: SetupRequest = { step: def.step };
  for (const [key, value] of Object.entries(input)) {
    if (key === "step") continue;
    // 省略（undefined）は、渡されなかったのと同じに扱う（MCP の引数の形）
    if (value === undefined) continue;
    if (!isArgKey(key)) return refuse(`知らない引数（${safeKey(key)}）です。`);
    if (!def.accepts.includes(key)) {
      return refuse(`「${def.label}」は引数 ${key} を受けません。`);
    }
    if (typeof value !== "string") return refuse(`引数 ${key} は文字で渡してください。`);
    const problem = checkValue(key, value);
    if (problem) return refuse(problem);
    assign(request, key, value);
  }

  for (const key of def.requires) {
    if (request[key] === undefined) {
      return refuse(`「${def.label}」には引数 ${key} が要ります。`);
    }
  }
  return { ok: true, request };
}

function isArgKey(key: string): key is SetupArgKey {
  return (ARG_KEYS as readonly string[]).includes(key);
}

/** 制御文字（`\u0000`〜`\u001f` と `\u007f`）。生のまま書かない（sourceHygiene） */
const CONTROL = /[\u0000-\u001f\u007f]/u;

function checkValue(key: SetupArgKey, value: string): string | undefined {
  if (CONTROL.test(value)) return `引数 ${key} に制御文字が入っています。`;
  const limit = key === "path" ? MAX_PATH_LENGTH : MAX_VALUE_LENGTH;
  if (value.length > limit) return `引数 ${key} が長すぎます（${limit}字まで）。`;

  if (key === "title") return checkWorkTitle(value);
  if (key === "path") {
    // **前後の空白は落としてから見る**（2026-09-24）。エクスプローラーの
    // アドレス欄から貼ると紛れ込み、` C:\…` は絶対パスに見えない
    return isAbsolutePath(value.trim())
      ? undefined
      : "path は絶対パスで渡してください（例：C:\\Users\\…\\作品名）。";
  }
  if (key === "kind") {
    return WORK_KINDS.some((kind) => kind.key === value)
      ? undefined
      : `知らない種類（${safeKey(value)}）です。${WORK_KINDS.map((k) => k.key).join("・")} のどれかです。`;
  }
  if (key === "format") {
    const keys = [...selectableWorkFormats().map((format) => format.key), "unset"];
    return keys.includes(value)
      ? undefined
      : `知らない形式（${safeKey(value)}）です。${keys.join("・")} のどれかです。`;
  }
  // start
  return value === "plot" || value === "manuscript"
    ? undefined
    : "start は plot（プロットから）か manuscript（本文から）です。";
}

/**
 * 作品名の決まり。**新規作品の入力画面と同じ**（フォルダー名になるので、
 * 使えない文字を断る）。ここで通したものは、入力画面でも通る。
 */
export function checkWorkTitle(value: string): string | undefined {
  const title = value.trim();
  if (title.length === 0) return "作品名が空です。";
  if (/[/\\:*?"<>|]/u.test(title)) return "作品名にフォルダ名に使えない文字が含まれています。";
  return undefined;
}

/** Windows のドライブ（`C:\`・`C:/`）・UNC（`\\server`）・POSIX の `/` から始まるか */
function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]/u.test(value) || value.startsWith("/");
}

function assign(request: SetupRequest, key: SetupArgKey, value: string): void {
  if (key === "title") request.title = value.trim();
  else if (key === "path") request.path = value.trim();
  else if (key === "kind") request.kind = value as WorkKindKey;
  else if (key === "format") request.format = value as WorkFormatKey | "unset";
  else request.start = value as SetupStartMode;
}

/** 断り文へ入れる、誰が作ったか分からない文字列。短く切り、制御文字を落とす */
function safeKey(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, "");
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
}

/**
 * 依頼の URI を組む。引数の並びは表の順（同じ依頼なら同じ URI になる）。
 */
export function buildSetupUri(request: SetupRequest, scheme = "vscode"): string {
  const params = new URLSearchParams();
  params.set("step", request.step);
  for (const key of ARG_KEYS) {
    const value = request[key];
    if (value !== undefined) params.set(key, value);
  }
  return `${scheme}://${EXTENSION_URI_AUTHORITY}${SETUP_URI_PATH}?${params.toString()}`;
}

/**
 * 確認の画面に並べる行。**受けた答えを全部見せる**——見せずに使うと、
 * Claude Code が聞き違えた答えのまま作品が作られる。
 */
export function describeSetupRequest(request: SetupRequest): string[] {
  const def = findSetupStep(request.step);
  const lines = [`操作：${def?.label ?? request.step}`];
  if (request.title !== undefined) lines.push(`作品名：${request.title}`);
  if (request.kind !== undefined) {
    const kind = WORK_KINDS.find((entry) => entry.key === request.kind);
    lines.push(`種類：${kind?.label ?? request.kind}`);
  }
  if (request.format !== undefined) {
    const format = selectableWorkFormats().find((entry) => entry.key === request.format);
    lines.push(`形式：${request.format === "unset" ? "いまは決めない" : (format?.label ?? request.format)}`);
  }
  if (request.start !== undefined) {
    lines.push(`始め方：${request.start === "plot" ? "プロットから" : "本文から"}`);
  }
  if (request.path !== undefined) lines.push(`場所：${request.path}`);
  return lines;
}

/**
 * 「フォルダー登録」の段で、渡された場所が**もう登録済み**だったときの知らせ
 * （作者の報告、2026-09-24）。
 *
 * **失敗や警告で止めない。** 作者が既にあるフォルダーを挙げるのは自然なことで、
 * 登録済みならこの段は済んでいる。止めると、Claude Code は作者から
 * 「うまくいかなかった」と聞いて同じ依頼を繰り返しかねない。作品名は
 * 登録簿のもの（作者が一覧で見ている名前）を出す。
 */
export function alreadyRegisteredNotice(title: string): string {
  return `このフォルダーは「${title}」としてすでに登録されています。登録はしないで次へ進めます。`;
}

/**
 * 記録に残す形。**段の名前と、渡された鍵の名前だけ**。値（作品名・パス）は
 * 残さない——記録は同期されることがあり、未公開の作品名が載ると困る。
 */
export function setupRequestForLog(request: SetupRequest): string {
  const keys = ARG_KEYS.filter((key) => request[key] !== undefined);
  return keys.length > 0 ? `${request.step}（${keys.join("・")}）` : request.step;
}
