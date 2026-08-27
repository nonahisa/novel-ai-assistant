import { normalizeName } from "./characterMerge";
import { isPlaceholderText } from "./placeholderText";

/**
 * 相談パネルからの「AIで再読込」の提案（P-21の `reloadRecord`、設計書6.31.3）。
 *
 * 作者が「アジャーノに殿下の情報が混ざっている」と相談したとき、AIは
 * **その記録を読み直すボタン**を返せる。押すと設定資料パネルが開き、
 * 留意点を引き継いで再読込（6.31.1）が走る。
 *
 * **AIが書いた名前を、そのまま操作の対象にしない。** `run`（chatEdit.ts）と
 * 同じ原則である。実在するレコードと照合し、一致したものだけをボタンにする。
 * 一致しなければボタンを出さない——実在しない相手を読み直すボタンは、
 * 押しても必ず失敗するうえ、作者には「その名前で資料がある」と読める。
 *
 * VS Code APIに依存しない。
 */

/**
 * 読み直せる種別。
 *
 * **世界観（world）は入れない**（設計書6.31.3の指定）。この機能が要るのは
 * 「別の誰かの記述が混ざった」形の誤りで、それは名前を持つ相手どうしで起きる。
 */
export type ChatReloadKind =
  | "character"
  | "ability"
  | "organization"
  | "location";

/**
 * 種別の見出し。`settingsSummary.ts` の `KIND_LABELS` と同じ言葉を使う。
 *
 * 写しているのは、この解釈を VS Code から切り離しておくためである
 * （`KIND_LABELS` は設定資料の読み書きを抱えた側にある）。
 * **言葉が食い違わないことは `chatReload.test.ts` が見張る。**
 */
export const RELOAD_KIND_LABELS: Record<ChatReloadKind, string> = {
  character: "登場人物",
  ability: "能力",
  organization: "組織",
  location: "場所",
};

const RELOAD_KINDS = new Set<string>(Object.keys(RELOAD_KIND_LABELS));

/**
 * 留意点の上限。
 *
 * 再読込のプロンプトへそのまま入るので、長すぎると本文の抜粋を押しのける。
 */
const MAX_NOTES_CHARS = 400;

/** 名前の上限。これを超えるものは名前ではなく文章である */
const MAX_NAME_CHARS = 60;

export interface ChatReloadRequest {
  kind: ChatReloadKind;
  /** AIが書いた名前。**実在の照合はまだ済んでいない** */
  name: string;
  /** 作者の訴えを短くまとめたもの。無ければ従来の「項目の充実」と同じ動きになる */
  notes?: string;
}

/**
 * AIが返した `reloadRecord` を解釈する。
 *
 * **形が合わないものは黙って捨てる。** 相談の返事そのものは役に立つことが
 * 多いので、提案が読めないだけで会話を止めない。
 */
export function parseChatReload(raw: unknown): ChatReloadRequest | undefined {
  if (!isRecord(raw)) return undefined;

  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (!isReloadKind(kind)) return undefined;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS) return undefined;

  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  // **指示の言葉が中身として返ってくる**（「特になし」「null」）。
  // そのまま渡すと、再読込のプロンプトで留意点として読まれてしまう
  const usable = notes && !isPlaceholderText(notes) ? notes : "";

  return {
    kind,
    name,
    notes: usable ? usable.slice(0, MAX_NOTES_CHARS) : undefined,
  };
}

/** 照合の相手。ストアから読んだレコードを、この形にして渡す */
export interface ReloadCandidate {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * AIの書いた名前を、実在するレコードへ突き合わせる。
 *
 * **名前を先に、別名を後に見る。** 「殿下」が誰かの別名でもあり、別の記録の
 * 名前でもあるとき、名前のほうを採らないと読み直す相手が入れ替わる。
 *
 * 表記ゆれと敬称は `normalizeName` が吸収する（「アジャーノ様」で通る）。
 */
export function matchReloadTarget(
  candidates: readonly ReloadCandidate[],
  name: string
): ReloadCandidate | undefined {
  const key = normalizeName(name);
  if (!key) return undefined;

  const byName = candidates.find(
    (candidate) => normalizeName(candidate.name) === key
  );
  if (byName) return byName;

  return candidates.find((candidate) =>
    candidate.aliases.some((alias) => normalizeName(alias) === key)
  );
}

/**
 * ボタンに出す言葉。
 *
 * **渡すのは照合が通ったレコードの名前**であって、AIが書いた文字列ではない。
 * AIの書き方（「アジャーノ様」）のまま出すと、実際に開く記録の名前と
 * ボタンの文言が食い違う。
 */
export function describeChatReload(name: string): string {
  return `「${name}」をAIで再読込`;
}

function isReloadKind(value: string): value is ChatReloadKind {
  return RELOAD_KINDS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
