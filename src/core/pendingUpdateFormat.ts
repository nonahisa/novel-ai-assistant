/**
 * 承認待ちの更新案（`.aiwriter/pending-characters/`）の**形だけ**（設計書6.4.9）。
 *
 * `pendingUpdates.ts` から純粋な部分を切り出したもので、**`vscode` にも
 * `models/` にも依存しない**。切り出したのは、外から呼ぶ束（MCPサーバー。
 * 設計書6.87.8）が `settings.propose`（6.87.16）で同じ形のファイルを
 * 置くためである。あちらは `vscode` に届いてはいけない
 * （`test/unit/mcpReach.test.ts` が見張る）。
 *
 * **写しを作らない。** 出どころの読み方・ファイル名の付け方が2つに分かれると、
 * 片方だけ直った状態が生まれて、作者の承認待ちが黙って消える。
 * `pendingUpdates.ts` はここを import して再輸出するので、
 * **使う側の既定は今までどおり `pendingUpdates`** でよい
 * （`textDecode`・`settingsExtractionCollect` と同じ考え）。
 */

/** 承認待ちの置き場（`.aiwriter/` の下） */
export const PENDING_DIR = "pending-characters";

/**
 * 新規案の仮のID。
 *
 * `parseCharacter` がIDの形（`char_数字`）を確かめるので空にはできないが、
 * **この番号のまま台帳へ入れてはいけない**——`applyPendingUpdates` が
 * 承認のときに採り直す。積んだ時点で採ると、承認までのあいだに
 * 別の作品操作が同じ番号を先に使う。
 *
 * **置き場所をここへ移した**（0.66.3）。元は `plotCharacterSync.ts` に
 * あったが、あちらは `characterMerge` 経由で重い系を引き込むので、
 * MCPの束から指すには重すぎる。あちらは再輸出で受ける。
 */
export const PENDING_CREATION_ID = "char_000";

/**
 * その更新案がどこから来たか（設計書6.4.9）。
 *
 * 省略（`undefined`）は**AIの抽出**である。出どころを持たせる前に積まれた
 * ファイルがそう読まれるので、既定を変えてはいけない。
 *
 * plot: 作者が plot.md の「主要登場人物」へ書いたもの。AIの読みではなく
 *   作者の文なので、承認するときの見方が変わる
 * chat: 相談の中で作者が決めたこと（設計書6.72）。AIが拾い出してはいるが、
 *   出どころは**作者自身の発言**である（根拠の引用を会話と照合している）
 * external: 外部AIが MCP の `settings.propose` で置いたもの（設計書6.87.16）。
 *   **製品の外から来た案**なので、承認するときにいちばん疑ってよい
 */
export type PendingUpdateSource = "plot" | "chat" | "external";

/** 出どころの短い呼び名。画面に出す文言はここだけが持つ */
export function pendingSourceLabel(
  source: PendingUpdateSource | undefined
): string {
  if (source === "plot") return "プロットから";
  if (source === "chat") return "相談から";
  if (source === "external") return "外部AIから";
  return "";
}

/**
 * 何の案か（設計書6.4.9）。
 *
 * 省略（`undefined`）は**既存レコードの更新**である。これまで積まれた
 * ものはすべてそれなので、既定を変えてはいけない。
 *
 * creation: まだ台帳に無い人物を作る案。**IDは仮**（`PENDING_CREATION_ID`）で、
 *   本当の採番は承認したときに行う
 */
export type PendingUpdateKind = "creation";

/** 保留ファイルの中身。人物のJSONそのもの（古い形）か、包んだ形 */
export interface PendingPayload<T> {
  kind?: PendingUpdateKind;
  source?: PendingUpdateSource;
  /** なぜそう提案するか。作者が判断する材料（設計書6.87.16） */
  reason?: string;
  character: T;
}

/**
 * 保留ファイルへ書く中身を組む。
 *
 * **何も伝えることが無ければ、これまでどおり人物のJSONそのもの**を返す。
 * 包みを増やすのは、出どころ・種別・理由のどれかがあるときだけでよい
 * （古い形のファイルを読める作りを保つため）。
 */
export function buildPendingPayload<T>(
  character: T,
  options: {
    kind?: PendingUpdateKind;
    source?: PendingUpdateSource;
    reason?: string;
  } = {}
): T | PendingPayload<T> {
  const reason = options.reason?.trim();
  if (!options.kind && !options.source && !reason) return character;
  return {
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(reason ? { reason } : {}),
    character,
  };
}

/**
 * 保留ファイルの中身から人物を取り出す。
 *
 * **2つの形がある。** 出どころを持たせる前（設計書6.4.9より前）に
 * 積まれたものは人物のJSONそのもので、作者の環境にはそれが残っている。
 * 読めなくすると、確認を待っている提案が黙って消える。
 */
export function unwrapPendingCharacter(parsed: unknown): unknown {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "character" in parsed
  ) {
    return (parsed as { character: unknown }).character;
  }
  return parsed;
}

export function readSource(parsed: unknown): PendingUpdateSource | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const source = (parsed as { source?: unknown }).source;
  // 知らない値は「出どころ無し」として読む。**捨てずに残す**のではなく
  // 落とすのは、画面に出す文言を持たないものを表示できないため
  return source === "plot" || source === "chat" || source === "external"
    ? source
    : undefined;
}

export function readKind(parsed: unknown): PendingUpdateKind | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const kind = (parsed as { kind?: unknown }).kind;
  return kind === "creation" ? "creation" : undefined;
}

/** 理由（設計書6.87.16）。無い・空・文字列でないものは「無し」として読む */
export function readReason(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const reason = (parsed as { reason?: unknown }).reason;
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 保留ファイルの名前。
 *
 * 更新案はこれまでどおりレコードのID。新規案は**名前**で付ける
 * （IDが仮であるため。同じ名前を積み直したときだけ同じ名前になる）。
 */
export function pendingFileName(
  character: { id: string; name: string },
  kind: PendingUpdateKind | undefined
): string {
  if (kind !== "creation") return `${character.id}.json`;
  const safeName = character.name
    .replace(/[/\\:*?"<>|\s]/g, "")
    .slice(0, 30);
  return `new_${safeName || character.id}.json`;
}
