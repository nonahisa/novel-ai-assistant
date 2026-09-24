/**
 * 外部AIが作品を触った記録（設計書6.87.9）。
 *
 * **MCPサーバー（6.87）を入れた時点で、作者の知らないところで原稿が
 * 読まれうるようになった。** 外から呼ぶ口は、どれも「読む・測る・提案する」
 * までで原稿を書き換えないが、**読まれたこと自体が作者に見えないのは別の問題**
 * である——とくに、本文がこの機械の外へ出たかどうかは、作者が後から
 * 確かめられなければならない。
 *
 * **置き場所は同期される側**（`.aiwriter/history/external.jsonl`）。
 * `.aiwriter/` のうち除外されているのは `cache/` と `logs/` だけなので、
 * ここは GitHub 経由でほかの端末へも届く。`logs/` へ置くと、別の機械で
 * 走らせた外部AIの操作は**作者に永久に届かない**（`editHistory.ts` が
 * 同じ理由でこちらを選んでいる）。
 *
 * **編集履歴（5.6）とは別のファイルにする。** あちらは「本文や資料が
 * 変わった」記録である。混ぜると、作者は**外部AIが原稿を直した**と
 * 読み違える。外部AIは書き換えない。
 *
 * **1行1件の追記だけ。書き換えない・消さない。** 複数の機械・複数の
 * クライアントが同時に書いても、追記どうしなら混ざるだけで、両方残れば
 * 正しい履歴になる（編集履歴と同じ守り方）。
 *
 * **本文そのものは残さない。** 記録が原稿の写しになると、同期先に
 * 原稿が二重に載る。残すのは「どのファイルの・どこを・どう扱ったか」だけ。
 *
 * VS Code APIに依存しない——**MCPサーバーの束（6.87.8）から書き、
 * 拡張機能から読む**ので、両方が使える場所に置く必要がある。
 */

/** 同期される場所（`cache/` と `logs/` だけが除外されている） */
export const EXTERNAL_ACCESS_DIRECTORY = "history";
export const EXTERNAL_ACCESS_FILE = "external.jsonl";

/**
 * 原稿がどこまで外へ出たか。**この記録のいちばんの用件**。
 *
 * 「外部AIが触った」だけでは、作者は危ないのかどうか判断できない。
 * 手元のOllamaで閉じたのか、本文がクラウドへ渡ったのかで、意味がまるで違う。
 */
export type ExternalExposure =
  /** 原稿に触れていない（版の確認など） */
  | "none"
  /** 手元で閉じた。この機械から出ていない（runner が ollama） */
  | "local"
  /** 抜粋・名前・件数が呼び出し元へ渡った（走査・検算・表記ゆれの検出） */
  | "excerpt"
  /** 本文がまとまって呼び出し元へ渡った（プロンプトを組んだ・返した） */
  | "body";

export const EXTERNAL_EXPOSURE_LABELS: Record<ExternalExposure, string> = {
  none: "原稿に触れていない",
  local: "手元で完結（外へ出ていない）",
  excerpt: "抜粋が外へ出た",
  body: "本文が外へ出た",
};

/**
 * 印。**色が分からなくても区別できるように**（`actor.ts` と同じ考え）。
 * 危ないものほど目立つ形にする。
 */
export const EXTERNAL_EXPOSURE_MARKS: Record<ExternalExposure, string> = {
  none: "・",
  local: "◇",
  excerpt: "◆",
  body: "★",
};

export interface ExternalAccessEntry {
  /** ISO 8601。**並べ替えは読むときに行う**ので、書く側は素直に今の時刻 */
  time: string;
  /** 道具の名前（`novel.run` など）。**転送層が入れる**ので取り違えない */
  tool: string;
  /**
   * 許可の鍵（`typo`・`novel.scan` など。0.66.7）。
   *
   * **道具の名前とは別に持つ。** 道具が `novel.run` の1本に束ねられたので、
   * 名前だけでは**作者が何を許可すればよいか決められない**（`novel.run` を
   * 許すと16の機能が全部通ってしまう）。
   *
   * **古い行には無い。** 読む側は `tool` へ落とす——古い名前は
   * `LEGACY_TOOL_KEYS` が読み替えるので、そのまま許可の鍵として使える。
   */
  key?: string;
  /** 呼んだ相手。MCPの `initialize` が名乗った名前。分からなければ空 */
  client: string;
  /** どのファイルか。作品フォルダーからの相対パス。無ければ空 */
  file: string;
  /** 原稿がどこまで外へ出たか */
  exposure: ExternalExposure;
  /** 手元で通したときに使ったモデル。使っていなければ空 */
  model: string;
  /** 成功したか。失敗も残す——**失敗した試みも、試みには違いない** */
  ok: boolean;
  /**
   * 補足。件数や対象の指し方だけを、作者が読む言葉で入れる。
   * **本文・抜粋そのものは入れない**
   */
  detail: string;
}

/** 補足に入れてよい長さ。長い文字列は本文の写しになりかねない */
const DETAIL_LIMIT = 200;

export function formatExternalAccessLine(entry: ExternalAccessEntry): string {
  return JSON.stringify({
    ...entry,
    detail: entry.detail.slice(0, DETAIL_LIMIT),
  });
}

/**
 * 1行を読む。
 *
 * **読めない行は捨てて、ほかを読む。** 別の機械の書き込みと混ざって
 * 壊れた行が1つあっても、履歴全体が見えなくなるほうが困る。
 */
export function parseExternalAccessLine(
  line: string
): ExternalAccessEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  // **競合マーカーの行も落とす。** 解決前でも、残りは読めたほうがよい
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
  const time = typeof raw.time === "string" ? raw.time : "";
  const tool = typeof raw.tool === "string" ? raw.tool : "";
  // **時刻と道具が無い行は、履歴として意味を成さない**ので捨てる
  if (!time || !tool) return undefined;

  return {
    time,
    tool,
    // **古い行には無い**（0.66.6 まで）。無ければ落とさずに undefined のまま
    ...(typeof raw.key === "string" && raw.key ? { key: raw.key } : {}),
    client: typeof raw.client === "string" ? raw.client : "",
    file: typeof raw.file === "string" ? raw.file : "",
    exposure: parseExposure(raw.exposure),
    model: typeof raw.model === "string" ? raw.model : "",
    // **読めない値を「成功」にしない。** 失敗を成功と見せるほうが害が大きい
    ok: raw.ok === true,
    detail: typeof raw.detail === "string" ? raw.detail : "",
  };
}

/**
 * 許可が無くて断った回の印（設計書6.87.10、6.87.14）。
 *
 * **ここが唯一の定義。** MCP 側が書き、拡張機能側が「ノックされた」と
 * 読み取る——**文字列を写すと、片方を直したときに検知が黙って止まる。**
 */
export const EXTERNAL_ACCESS_DENIED_DETAIL = "許可が無いので断りました";

/**
 * その行が「断ったノック」か。
 *
 * **作者に知らせるのはこれだけ。** 許可済みの呼び出しまでポップアップに
 * すると、作者は画面を閉じることを覚えてしまい、**本当に知らせたい回まで
 * 閉じられる。**
 */
export function isExternalAccessKnock(entry: ExternalAccessEntry): boolean {
  return !entry.ok && entry.detail === EXTERNAL_ACCESS_DENIED_DETAIL;
}

export interface ExternalAccessKnock {
  client: string;
  /** 作者に見せる呼び名（道具の名前） */
  tool: string;
  /**
   * 許可するときの鍵（0.66.7）。
   *
   * **古い記録には無いので、そのときは道具の名前を鍵にする**——
   * 0.66.6 までの名前（`typo.run`）は `LEGACY_TOOL_KEYS` が読み替えるので、
   * そのまま許可として効く。
   */
  key: string;
  at: string;
}

/**
 * まだ知らせていないノックを、新しい順に選ぶ（設計書6.87.14）。
 *
 * **接続元と道具の組ごとに1つへ畳む。** 外部AIは同じ道具を続けて呼ぶ
 * （チャンクごとに1回）ので、畳まないと**数十回のポップアップ**になる。
 * 同じ組なら作者の判断も同じなので、まとめて1回尋ねれば足りる。
 *
 * **そのノックより新しい「通った」回がある組は出さない**（許可が出たあと）。
 *
 * @param since この時刻より後のものだけ。空なら全部（初めて見るとき）
 */
export function pendingExternalAccessKnocks(
  entries: readonly ExternalAccessEntry[],
  since: string
): ExternalAccessKnock[] {
  const knocks: ExternalAccessKnock[] = [];
  const seen = new Set<string>();
  /*
    **あとで通った組は、もう答えが出ている**（2026-09-24、窓Bが処理済みの
    ノックを出し直した件）。記録は新しい順に来るので、先に「通った」を
    見た組の、それより古いノックは出さない——作者はそのあと許可しており、
    「断りました」と出すと事実と違う。**別の機械で許可して通った回**も、
    記録は同期で届くのでここで畳める（許可の印は同期しないので、印だけでは
    分からない）。
  */
  const answered = new Set<string>();
  for (const entry of entries) {
    if (!isExternalAccessKnock(entry)) {
      // 道具の中で失敗した回（ok:false・別の理由）も、許可の関所は越えている
      answered.add(JSON.stringify([entry.client, entry.key || entry.tool]));
      continue;
    }
    if (since && entry.time <= since) continue;
    /*
      **畳む単位は許可の鍵**（0.66.7）。道具の名前で畳むと、`novel.run` の
      feature 違いが1件にまとまり、**作者は最初の1つしか許可できない。**

      鍵の作り方は `JSON.stringify`。区切り文字を挟むと、名前にその文字が
      入っている組と衝突する。
    */
    const key = entry.key || entry.tool;
    const pair = JSON.stringify([entry.client, key]);
    if (answered.has(pair)) continue;
    if (seen.has(pair)) continue;
    seen.add(pair);
    knocks.push({ client: entry.client, tool: entry.tool, key, at: entry.time });
  }
  return knocks;
}

/** 読めない値は「本文が外へ出た」に倒す。**軽いほうへ倒すと見落とす** */
function parseExposure(value: unknown): ExternalExposure {
  return value === "none" ||
    value === "local" ||
    value === "excerpt" ||
    value === "body"
    ? value
    : "body";
}

/** ファイル全体を読む。新しいものが先。**壊れた行は黙って飛ばす** */
export function parseExternalAccessLog(text: string): ExternalAccessEntry[] {
  const entries: ExternalAccessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseExternalAccessLine(line);
    if (entry) entries.push(entry);
  }
  // 別々の機械の追記が時刻順に並んでいるとは限らない
  return dedupeExternalAccess(
    entries.sort((a, b) => b.time.localeCompare(a.time))
  );
}

/**
 * 同じ操作が二重に入っていないか。
 *
 * **競合を「両方残す」で解決すると、同じ行が2つになる**（編集履歴と同じ）。
 * 時刻・道具・ファイルが全部同じなら、同じ1回とみなす。
 */
export function dedupeExternalAccess(
  entries: readonly ExternalAccessEntry[]
): ExternalAccessEntry[] {
  const seen = new Set<string>();
  const kept: ExternalAccessEntry[] = [];
  for (const entry of entries) {
    /*
      **区切り文字に頼らない。** 珍しい文字で区切ると、値に混ざらない
      保証を文字の珍しさで作ることになる（生の NUL をソースへ書いて
      git がバイナリ扱いした。0.64.3）。
    */
    const key = JSON.stringify([
      entry.time,
      entry.tool,
      entry.file,
      entry.client,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** 画面に出す一文。**作者が読む言葉で**組み立てる */
export function describeExternalAccess(entry: ExternalAccessEntry): string {
  const parts = [
    `${EXTERNAL_EXPOSURE_MARKS[entry.exposure]} ${entry.tool}`,
    entry.file || null,
    EXTERNAL_EXPOSURE_LABELS[entry.exposure],
    entry.model ? `モデル ${entry.model}` : null,
    entry.ok ? null : "失敗",
    entry.detail || null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" / ");
}
