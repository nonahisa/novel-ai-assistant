/**
 * 外部AIからの「画面のこの項目を光らせて」という依頼（設計書6.104。0.75.6）。
 *
 * **作者が承認した例外**（2026-09-22）。外から呼ぶ口は読む・測る・提案する
 * までで原稿を書き換えない（6.87.7）が、**画面の項目を光らせることだけ**は
 * 例外として許された。**命令は実行しない**——光るだけなので、押すかどうかは
 * 作者が決める。原稿も台帳も1文字も変わらない。
 *
 * ## なぜファイル越しなのか
 *
 * **MCPサーバーは別プロセスで、拡張機能へ直接は届かない**（6.87.8）。
 * 既にある道（`external.jsonl` を書いて `ExternalAccessWatcher` が見張る。
 * 6.87.14）と**同じ形**にする——新しい繋ぎ方を1つ増やすより、
 * すでに実機で通っている形をもう一度使うほうが確かである。
 *
 * ## 置き場所は `history/` だが、同期はしない
 *
 * `.aiwriter/history/spotlight.jsonl`。隣の `external.jsonl` は
 * **同期される**（原稿がどこまで外へ出たかは、どの機械から見ても同じ話だから）
 * のに対し、こちらは**同期から外す**（`IGNORED_PATHS`）。
 * 「いまこの機械の画面で光らせてほしい」という、**その場限りの頼み**なので、
 * 別の機械へ持って行くと、何日も前の依頼で急に画面が光ることになる。
 *
 * **1行1件の追記だけ。書き換えない・消さない**（`externalAccessLog.ts` と同じ）。
 *
 * VS Code APIに依存しない——**MCPサーバーの束から書き、拡張機能から読む**。
 */

/** `external.jsonl` と同じ場所（`.aiwriter/history/`） */
export const SPOTLIGHT_REQUEST_DIRECTORY = "history";
export const SPOTLIGHT_REQUEST_FILE = "spotlight.jsonl";

export interface SpotlightRequestEntry {
  /** ISO 8601。**どこまで捌いたか**の目印にもなる */
  at: string;
  /** 呼んだ相手の名乗り（MCP の `initialize`）。分からなければ空 */
  client: string;
  /**
   * 光らせるコマンドID。`label` で頼まれたときは空。
   *
   * **どちらか一方でよい**（両方空の行は依頼として意味を成さないので捨てる）。
   */
  command: string;
  /**
   * 光らせる項目の表示名。`command` で頼まれたときは空。
   *
   * **ラベルからコマンドIDを引くのは、読む側（拡張機能）である。**
   * 対応表を持っているのは `views/actionList.ts` の `ACTION_TREE` だけで、
   * あれは `vscode` を引き込むので MCP の束からは読めない。**写しを
   * 作らずに済ませる**ために、名前のまま渡して向こうで解く。
   */
  label: string;
}

/** 名前に入れてよい長さ。長い文字列は本文の写しになりかねない */
const FIELD_LIMIT = 200;

export function formatSpotlightRequestLine(
  entry: SpotlightRequestEntry
): string {
  return JSON.stringify({
    at: entry.at,
    client: entry.client.slice(0, FIELD_LIMIT),
    command: entry.command.slice(0, FIELD_LIMIT),
    label: entry.label.slice(0, FIELD_LIMIT),
  });
}

/**
 * 1行を読む。**読めない行は捨てて、ほかを読む**
 * （`externalAccessLog.ts` と同じ守り方）。
 */
export function parseSpotlightRequestLine(
  line: string
): SpotlightRequestEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  // 競合マーカーの行も落とす（解決前でも、残りは読めたほうがよい）
  if (/^(<<<<<<<|=======|>>>>>>>)/.test(trimmed)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const at = typeof raw.at === "string" ? raw.at : "";
  const command = typeof raw.command === "string" ? raw.command : "";
  const label = typeof raw.label === "string" ? raw.label : "";
  // **時刻が無い行は、いつの依頼か決められない**（捌いた印と比べられない）。
  // 指し先も無い行は、そもそも何を光らせればよいのか分からない
  if (!at || (!command && !label)) return undefined;

  return {
    at,
    client: typeof raw.client === "string" ? raw.client : "",
    command,
    label,
  };
}

/** ファイル全体を読む。**新しいものが先。壊れた行は黙って飛ばす** */
export function parseSpotlightRequestLog(
  text: string
): SpotlightRequestEntry[] {
  const entries: SpotlightRequestEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseSpotlightRequestLine(line);
    if (entry) entries.push(entry);
  }
  // 別々の機械・別々のクライアントの追記が時刻順に並んでいるとは限らない
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * まだ捌いていない依頼のうち、いちばん新しいもの。
 *
 * **溜まっていても1件しか光らせない。** 光るのは画面の1か所なので、
 * 5件まとめて捌いても最後の1つしか見えない——それなら、いちばん新しい
 * 依頼を素直に指すほうが、呼んだ側の意図に合う。
 *
 * @param since この時刻より後のものだけ。空なら全部（初めて見るとき）
 */
export function latestSpotlightRequest(
  entries: readonly SpotlightRequestEntry[],
  since: string
): SpotlightRequestEntry | undefined {
  return entries.find((entry) => !since || entry.at > since);
}
