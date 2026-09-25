import { EXTENSION_URI_AUTHORITY } from "./setupRequest";
import { clientKeyOf } from "./externalAccessPermission";

/**
 * VS Code の中のAI設定で走らせてもらう道（設計書6.87.22）。
 *
 * クラウドAIの鍵は VS Code の SecretStorage にあり、MCP サーバー（別プロセス）へは
 * 出さない。そこで**鍵を外へ出さずに、拡張機能の中で走らせてもらう**。
 *
 * 1. MCP の道具 `run.request` が、依頼の札（`<依頼番号>.request.json`）を保管庫へ
 *    置き、`vscode://nonahisa.novel-ai-assistant/run?id=…&token=…` を OS に開かせる
 * 2. 拡張機能の受け口が札を読み、**合言葉を突き合わせ**、作者に毎回確かめてから、
 *    作者の設定したAIで製品の機能を検算まで通して走らせる
 * 3. 結果を保管庫（`<依頼番号>.state.json`）へ書き、MCP の道具 `run.result` が読む
 *
 * **ここは両側が同じ判定を使うための部品。** 開く側（MCP）と受ける側（拡張機能）
 * で判定を別々に書くと、片方だけ通る依頼が生まれる（`setupRequest.ts` と同じ理由）。
 *
 * VS Code API にも Node にも依存しない（MCP の束から使うため。
 * `test/unit/cross/mcpReach.test.ts`）。
 */

/** 受け口のパス（読者の反応・公募・セットアップと同じ受け口に足す） */
export const RUN_URI_PATH = "/run";

/** 保管庫（`globalStorageUri`）の下のフォルダー。**作品フォルダーには置かない** */
export const RUN_REQUEST_DIRECTORY = "run-requests";

/** 道具の名前。**許可の鍵もこれ1つ**（`run.result` も同じ鍵で確かめる） */
export const RUN_REQUEST_TOOL = "run.request";
export const RUN_RESULT_TOOL = "run.result";

/**
 * 依頼から URI が届くまでの猶予。
 *
 * **ふつうは1秒もかからない**（MCP が開いた直後に VS Code が受ける）。VS Code が
 * 閉じていて起動を待つ分を見込んで10分。これを過ぎて届いた URI は、誰かが
 * 控えておいて後から開かせたものかもしれないので、確認も出さずに断る。
 */
export const RUN_ARRIVAL_MS = 10 * 60_000;

/**
 * 依頼から、作者が「走らせる」を押すまでの期限。
 *
 * **確認が出たまま席を外していると、モーダルは何時間でも残る。** 戻ってきた
 * 作者が押したとき、頼んだ側はとうに諦めているかもしれず、作品もその間に
 * 書き進んでいる。30分を過ぎた「走らせる」は走らせず、期限切れとして返す
 * ——頼み直せばよいだけで、黙って古い依頼が走るより害が小さい。
 */
export const RUN_CONFIRM_MS = 30 * 60_000;

/** 札と結果を片付けるまでの日数（結果には原稿の抜粋が入るので、溜めない） */
export const RUN_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * 1回の依頼で送ってよい本文の字数。
 *
 * **連打や作品まるごとの取り違えで料金がかさむのを防ぐ。** 手元の実データ
 * （19話・約41,000字）はまるごとでも入る。これを超える作品は話を指定して頼む。
 */
export const RUN_MAX_BODY_CHARS = 150_000;

/** 1時間に走らせてよい回数（作者が「走らせる」を押した回を数える） */
export const RUN_MAX_PER_HOUR = 6;
export const RUN_RATE_WINDOW_MS = 60 * 60_000;

/**
 * 作者の返事を待っている依頼を、いくつまで重ねてよいか。
 *
 * **確認のモーダルを積み上げさせない。** 返事の無いまま次々に頼むと、
 * 作者が戻ったときに確認が何枚も重なって出る。
 */
export const RUN_MAX_OPEN_REQUESTS = 2;

/**
 * 走らせてよい機能（**白名簿**）。
 *
 * **読み取りと生成だけ。** 本文への適用・設定資料の抽出の保存・承認待ちの反映は
 * 入れない——結果は保管庫へ書くだけで、原稿にも台帳にも提案パネルにも触れない。
 * ここに無い機能は、確認も出さずに断る。
 *
 * `assigned` は機能別AI割当（設計書6.28.9）の鍵。**作者が機能ごとに選んだAIで
 * 走る**ので、確認に出すAIもここから引く。
 */
export type RunFeature =
  | "typo"
  | "proofread"
  | "contradiction"
  | "foreshadow"
  | "deviation"
  | "synopsis";

export type RunAssignedFeature =
  | "typo"
  | "proofread"
  | "contradiction"
  | "foreshadow"
  | "deviation"
  | "generate";

export interface RunFeatureDef {
  feature: RunFeature;
  /** 画面に出す名前 */
  label: string;
  assigned: RunAssignedFeature;
}

export const RUN_FEATURES: readonly RunFeatureDef[] = [
  { feature: "typo", label: "誤字脱字の検知", assigned: "typo" },
  { feature: "proofread", label: "推敲", assigned: "proofread" },
  { feature: "contradiction", label: "矛盾検知", assigned: "contradiction" },
  { feature: "foreshadow", label: "伏線の検知", assigned: "foreshadow" },
  { feature: "deviation", label: "プロット逸脱の検知", assigned: "deviation" },
  { feature: "synopsis", label: "各話あらすじの生成", assigned: "generate" },
];

export function findRunFeature(name: unknown): RunFeatureDef | undefined {
  return typeof name === "string"
    ? RUN_FEATURES.find((def) => def.feature === name)
    : undefined;
}

// ── 札（MCP が書き、拡張機能が読む）────────────────────────

/**
 * 依頼の札。**依頼の中身の出どころはここだけ**——URI には依頼番号と合言葉しか
 * 載せない。URI の引数で機能や作品を渡すと、URI を書き換えれば別の依頼に
 * なってしまい、札と突き合わせる手間が増える（突き合わせ漏れが穴になる）。
 * 作品の場所を URL に載せないで済む利点もある。
 */
export interface RunTicket {
  version: 1;
  /** 依頼番号（16桁の16進） */
  id: string;
  /**
   * 合言葉の SHA-256。**合言葉そのものは置かない**——保管庫は機械の中だが、
   * 置かないで済むものは置かない
   */
  tokenHash: string;
  feature: RunFeature;
  /** 作品フォルダー（絶対パス） */
  folder: string;
  /** 対象の話（作品フォルダーからの相対パス。`novel.scan` の値）。無ければ作品全体 */
  file?: string;
  /** 頼んだ接続元の名乗り（自己申告） */
  client: string;
  /** 依頼の時刻（ISO） */
  createdAt: string;
}

const ID_PATTERN = /^[0-9a-f]{16}$/u;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
/** 制御文字（`\u0000`〜`\u001f` と `\u007f`）。生のまま書かない（sourceHygiene） */
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_FILE_LENGTH = 512;

export function isRunRequestId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function runTicketFileName(id: string): string {
  return `${id}.request.json`;
}

export function runStateFileName(id: string): string {
  return `${id}.state.json`;
}

/** ファイル名から依頼番号を取り出す（札でも結果でもないものは undefined） */
export function runIdOfFileName(
  name: string
): { id: string; kind: "request" | "state" } | undefined {
  const match = /^([0-9a-f]{16})\.(request|state)\.json$/u.exec(name);
  if (!match) return undefined;
  return { id: match[1], kind: match[2] as "request" | "state" };
}

/**
 * 対象の話の指定を確かめる。**作品フォルダーの外を指させない**
 * （`..`・絶対パス・制御文字）。
 */
export function checkRunFile(file: string): string | undefined {
  if (!file.trim()) return "file が空です。省略すると作品全体です。";
  if (CONTROL.test(file)) return "file に制御文字が入っています。";
  if (file.length > MAX_FILE_LENGTH) return `file が長すぎます（${MAX_FILE_LENGTH}字まで）。`;
  if (/^[A-Za-z]:/u.test(file) || file.startsWith("/") || file.startsWith("\\")) {
    return "file は作品フォルダーからの相対パスで渡してください（novel.scan の filePath）。";
  }
  if (file.split(/[\\/]/u).some((part) => part === "..")) {
    return "file に `..` は使えません（作品フォルダーの外は指せません）。";
  }
  return undefined;
}

export function formatRunTicket(ticket: RunTicket): string {
  return `${JSON.stringify(ticket, null, 2)}\n`;
}

/**
 * 札を読む。**見覚えのない形は undefined**（＝出どころの分からない依頼として断る）。
 */
export function parseRunTicket(text: string): RunTicket | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (!isRunRequestId(record.id)) return undefined;
  if (typeof record.tokenHash !== "string" || !TOKEN_PATTERN.test(record.tokenHash)) {
    return undefined;
  }
  const def = findRunFeature(record.feature);
  // **白名簿の外の札は読めないものとして扱わない**——受け口が「白名簿の外」と
  // 理由を言って断れるよう、機能名は文字列のまま通す（下で確かめる）
  if (typeof record.feature !== "string") return undefined;
  if (typeof record.folder !== "string" || !record.folder.trim()) return undefined;
  if (record.file !== undefined) {
    if (typeof record.file !== "string" || checkRunFile(record.file)) return undefined;
  }
  if (typeof record.client !== "string") return undefined;
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    return undefined;
  }
  return {
    version: 1,
    id: record.id,
    tokenHash: record.tokenHash,
    feature: (def?.feature ?? record.feature) as RunFeature,
    folder: record.folder,
    ...(record.file !== undefined ? { file: record.file as string } : {}),
    client: record.client,
    createdAt: record.createdAt,
  };
}

// ── URI（MCP が組み、拡張機能が読む）────────────────────────

export function buildRunUri(id: string, token: string, scheme = "vscode"): string {
  const params = new URLSearchParams();
  params.set("id", id);
  params.set("token", token);
  return `${scheme}://${EXTENSION_URI_AUTHORITY}${RUN_URI_PATH}?${params.toString()}`;
}

export type RunQueryResult =
  | { ok: true; id: string; token: string }
  | { ok: false; reason: string };

/**
 * URI のクエリを読む。**載せてよいのは `id` と `token` だけ**で、ほかの鍵・同じ鍵の
 * 2つ目・形の合わない値は断る（URI はウェブページのリンク1つでも開かせられる）。
 */
export function parseRunQuery(query: string): RunQueryResult {
  const params = new URLSearchParams(query.replace(/^\?/u, ""));
  const seen = new Map<string, string>();
  for (const [key, value] of params) {
    if (key !== "id" && key !== "token") {
      return { ok: false, reason: "知らない引数が付いています。" };
    }
    if (seen.has(key)) return { ok: false, reason: `同じ引数（${key}）が2つあります。` };
    seen.set(key, value);
  }
  const id = seen.get("id");
  const token = seen.get("token");
  if (!id || !isRunRequestId(id)) return { ok: false, reason: "依頼番号の形が合いません。" };
  if (!token || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: "合言葉がありません（形が合いません）。" };
  }
  return { ok: true, id, token };
}

export type RunTokenCheck =
  | { ok: true }
  | { ok: false; kind: "mismatch" | "late"; reason: string };

/**
 * 合言葉と、届いた時刻を確かめる。
 *
 * - **合言葉が札と合わない** → 出どころの分からない依頼（ウェブのリンクなど）。
 *   確認も出さずに断る。札の状態も書き換えない——依頼番号だけを当てた誰かに、
 *   正しい依頼を潰させないため
 * - **依頼から時間が経ちすぎて届いた** → 控えておいた URI を後から開かせた
 *   かもしれない。これも確認を出さずに断る
 *
 * @param hash 合言葉のハッシュを取る関数（`core/hash.ts` の `sha256Text`）
 */
export function checkRunToken(
  ticket: RunTicket,
  token: string,
  now: number,
  hash: (text: string) => string
): RunTokenCheck {
  if (!sameText(hash(token), ticket.tokenHash)) {
    return {
      ok: false,
      kind: "mismatch",
      reason: "合言葉が依頼の札と合いません（出どころの分からない依頼です）。",
    };
  }
  const created = Date.parse(ticket.createdAt);
  if (!Number.isFinite(created) || now - created > RUN_ARRIVAL_MS || created - now > RUN_ARRIVAL_MS) {
    return {
      ok: false,
      kind: "late",
      reason: `依頼から${Math.round(RUN_ARRIVAL_MS / 60_000)}分を過ぎて届いたため、受けませんでした。`,
    };
  }
  return { ok: true };
}

/** 比べるときに途中で抜けない（長さも中身も最後まで見る） */
function sameText(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/** 作者の「走らせる」が期限を過ぎているか（依頼の時刻から数える） */
export function isConfirmTooLate(ticket: RunTicket, now: number): boolean {
  const created = Date.parse(ticket.createdAt);
  return !Number.isFinite(created) || now - created > RUN_CONFIRM_MS;
}

// ── 状態と結果（拡張機能が書き、MCP が読む）───────────────────

/**
 * 拡張機能が書く状態。
 *
 * - `confirming`：作者の確認待ち（**この状態で最初に作れた窓だけが依頼を受ける**。合言葉は1回限り）
 * - `running`：走っている
 * - `done`：走り終えた（`result` がある）
 * - `failed`：走らせたが失敗した（`reason` と `nextAction`）
 * - `declined`：作者が断った・途中で止めた
 * - `refused`：受け口が断った（許可が無い・白名簿の外・上限など）
 * - `expired`：期限を過ぎた
 */
export type RunStateKind =
  | "confirming"
  | "running"
  | "done"
  | "failed"
  | "declined"
  | "refused"
  | "expired";

const RUN_STATE_KINDS: readonly RunStateKind[] = [
  "confirming",
  "running",
  "done",
  "failed",
  "declined",
  "refused",
  "expired",
];

/** 検算で落としたもの。**件数と理由だけ**（落とした中身まで返すと、検算の意味が薄れる） */
export interface RunDropped {
  count: number;
  notes: string[];
}

/** 送れなかった・読めなかったもの */
export interface RunFailures {
  count: number;
  notes: string[];
}

/**
 * 結果の中身（検算済み）。**測る道としての約束**（設計書6.87.22）——使った
 * プロバイダ・モデル・プロンプトの版・検算で落としたものを必ず入れる。
 * **鍵・APIキーは入れない。**
 */
export interface RunResultBody {
  feature: RunFeature;
  featureLabel: string;
  workTitle: string;
  /** 対象の話（相対パス）。作品全体なら null */
  target: string | null;
  provider: { id: string; name: string; paid: boolean };
  model: string;
  promptVersion: string;
  /** 検算を通った指摘・生成物。ファイルは作品フォルダーからの相対パス */
  findings: unknown[];
  dropped: RunDropped;
  failures: RunFailures;
  /** 送った本文の字数（処理済みで送らなかった分を含む見込み） */
  bodyChars: number;
  startedAt: string;
  finishedAt: string;
}

export interface RunStateRecord {
  version: 1;
  id: string;
  state: RunStateKind;
  /** この状態になった時刻（ISO） */
  at: string;
  /** 作者が「走らせる」を押した時刻。**続けて頼める回数を数える** */
  startedAt?: string;
  /** 断った・失敗した理由 */
  reason?: string;
  /** 作者（または頼んだ側）が次に取る操作。**1つだけ**（規則5） */
  nextAction?: string;
  /** 失敗の種別（`AIError.kind`）。分からなければ省く */
  errorKind?: string;
  result?: RunResultBody;
}

export function formatRunState(state: RunStateRecord): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseRunState(text: string): RunStateRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isRunRequestId(record.id)) return undefined;
  if (!RUN_STATE_KINDS.includes(record.state as RunStateKind)) return undefined;
  if (typeof record.at !== "string") return undefined;
  return record as unknown as RunStateRecord;
}

/**
 * 直近の窓の中で、作者が「走らせる」を押した回数（続けて頼める回数の上限に使う）。
 */
export function countRecentRuns(
  states: readonly RunStateRecord[],
  now: number,
  windowMs = RUN_RATE_WINDOW_MS
): number {
  return states.filter((state) => {
    if (!state.startedAt) return false;
    const started = Date.parse(state.startedAt);
    return Number.isFinite(started) && now - started >= 0 && now - started < windowMs;
  }).length;
}

/** 返事がまだ出ていない依頼か（札はあるが、終わりの状態が無く、期限内） */
export function isRunOpen(
  ticket: RunTicket,
  state: RunStateRecord | undefined,
  now: number
): boolean {
  const status = runStatusOf(ticket, state, now).status;
  return status === "waiting" || status === "confirming" || status === "running";
}

/** 片付けてよい古さか */
export function isRunStale(createdAt: string, now: number): boolean {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || now - created > RUN_KEEP_MS;
}

// ── run.result が返すもの ─────────────────────────────

export type RunStatus =
  | "waiting"
  | "confirming"
  | "running"
  | "done"
  | "failed"
  | "declined"
  | "refused"
  | "expired";

export interface RunStatusView {
  status: RunStatus;
  /** 頼んだ側が読む一言。**次に何をすればよいか**まで書く */
  message: string;
}

/**
 * 札と状態から、いまどうなっているかを決める。
 *
 * **拡張機能がまだ何も書いていない（`waiting`）ときも、期限で区切る。** VS Code が
 * 閉じていた・URI が届かなかったとき、いつまでも「待っています」と返すと、
 * 頼んだ側は永遠に待つ。
 */
export function runStatusOf(
  ticket: RunTicket,
  state: RunStateRecord | undefined,
  now: number
): RunStatusView {
  const created = Date.parse(ticket.createdAt);
  const age = Number.isFinite(created) ? now - created : Number.POSITIVE_INFINITY;

  if (!state) {
    if (age > RUN_ARRIVAL_MS) {
      return {
        status: "expired",
        message:
          "拡張機能が依頼を受け取らないまま期限が過ぎました（VS Code が閉じていた・URI が開けなかった、など）。" +
          "作者に VS Code を開いてもらってから、もう一度 run.request で頼んでください。",
      };
    }
    return {
      status: "waiting",
      message:
        "拡張機能がまだ依頼を受け取っていません。少し待ってから、もう一度 run.result で確かめてください。",
    };
  }

  switch (state.state) {
    case "confirming":
      if (age > RUN_CONFIRM_MS) {
        return {
          status: "expired",
          message:
            "作者の確認が出たまま期限（依頼から30分）が過ぎました。この依頼は走りません。" +
            "作者の手が空いてから、もう一度 run.request で頼んでください。",
        };
      }
      return {
        status: "confirming",
        message:
          "作者の VS Code に確認が出ています。作者が「走らせる」を押すまで走りません。" +
          "間を置いてから、もう一度 run.result で確かめてください（急かさないでください）。",
      };
    case "running":
      return {
        status: "running",
        message: "作者のAIで走っています。終わると結果が読めます。間を置いて確かめてください。",
      };
    case "done":
      return {
        status: "done",
        message:
          "検算まで通した結果です（製品と同じ検算）。原稿・設定資料・提案パネルは変わっていません。",
      };
    case "failed":
      return {
        status: "failed",
        message: joinReason("走らせましたが失敗しました。", state),
      };
    case "declined":
      return {
        status: "declined",
        message: joinReason(
          "作者が断りました。理由を尋ねずに、別のやり方を作者と相談してください。",
          state
        ),
      };
    case "refused":
      return { status: "refused", message: joinReason("拡張機能が断りました。", state) };
    case "expired":
      return { status: "expired", message: joinReason("期限を過ぎたため走らせていません。", state) };
  }
}

function joinReason(head: string, state: RunStateRecord): string {
  return [head, state.reason, state.nextAction ? `次の操作：${state.nextAction}` : ""]
    .filter(Boolean)
    .join("");
}

// ── 確認のモーダル（拡張機能が出す）───────────────────────

export interface RunConfirmInput {
  ticket: RunTicket;
  featureLabel: string;
  workTitle: string;
  /** 対象の話の表示（「第3話.txt」「作品全体（19話）」） */
  targetLabel: string;
  providerName: string;
  model: string;
  paid: boolean;
  bodyChars: number;
  episodeCount: number;
  /** 有料のAIのときの断り（`core/paidUsageNotice.ts` の行） */
  paidLines: readonly string[];
}

/**
 * 確認のモーダルの中身。**依頼の中身を全部並べる**（どこから・作品・話・機能・
 * 使うAI・送る量・料金）。見せずに走らせると、作者は何を許したのか分からない。
 *
 * **名乗りは自己申告と書く**（6.87.14「名乗りは目印であって、鍵ではない」）。
 */
export function describeRunConfirm(input: RunConfirmInput): {
  message: string;
  detail: string;
} {
  const who = clientKeyOf(input.ticket.client);
  const deadline = new Date(Date.parse(input.ticket.createdAt) + RUN_CONFIRM_MS);
  const lines = [
    `どこから：外部AI（名乗り：${who}。名乗りは自己申告です）`,
    `作品：${input.workTitle}`,
    `対象：${input.targetLabel}`,
    `機能：${input.featureLabel}`,
    `使うAI：${input.providerName}（${input.model}）※機能別AI割当のとおり`,
    `送る量：本文 約${input.bodyChars.toLocaleString("ja-JP")}字（${input.episodeCount}話）。` +
      "処理済みの部分は送りません。指示と設定資料のぶんが加わります。" +
      "保存していない変更は含まれません（保存済みの本文を読みます）。",
    ...(input.paid ? input.paidLines : ["料金：無料・手元で実行（API課金なし）"]),
    "",
    "結果は拡張機能の保管庫（この機械の中）に置き、頼んだ側が読みます。" +
      "原稿・設定資料・提案パネルは変わりません。",
    `期限：${formatClock(deadline)} を過ぎて押しても走りません。`,
    "覚えのない依頼なら「走らせる」を押さずに閉じてください。",
  ];
  return {
    message: `外部AI（${who}）からの依頼です。あなたのAIで「${input.featureLabel}」を走らせますか？`,
    detail: lines.join("\n"),
  };
}

/** 時:分 だけ（日付は同じ日のことがほとんど。機械の時刻で出す） */
function formatClock(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "（不明）";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 記録（ログ）に残す形。**機能と依頼番号だけ**——作品の場所・話のパスは残さない
 * （ログは作品へ流れることがある）。
 */
export function runRequestForLog(ticket: Pick<RunTicket, "id" | "feature">): string {
  return `${String(ticket.feature).slice(0, 40)}（依頼番号 ${ticket.id}）`;
}
