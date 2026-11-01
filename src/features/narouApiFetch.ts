import type { WorkEntry } from "../models/types";
import { isKnownPostingSite, siteProfile, type PostingLedger } from "../models/posting";
import { narouNcode } from "../core/postingSiteRecords";
import {
  NAROU_API_ATTRIBUTION,
  NAROU_GUIDELINE_URL,
  NarouApiError,
  applyNarouApiResult,
  describeNarouApiFailure,
  narouNovelApiUrl,
  narouRankinApiUrl,
  parseNarouNovelApi,
  parseNarouRankinApi,
  type NarouNovelInfo,
  type NarouRankinEntry,
} from "../core/narouApi";
import {
  NAROU_API_ATTEMPTS_KEY,
  NAROU_API_CONSENT_KEY,
  NAROU_API_DAILY_LIMIT,
  NAROU_API_INTERVAL_MINUTES,
  judgeNarouApiAttempt,
  readNarouApiAttempts,
  readNarouApiConsent,
  withAgreement,
  withGuidelineOpened,
  withNarouApiAttempt,
} from "../core/narouApiGate";
import { logFailure, logStep, useLogFile } from "../core/logger";

/**
 * 執筆統計の「なろうの反応」の［なろうAPIによる作品情報取得］（作者の指示 2026-11-02）。
 *
 * 押したときだけ、その作品の Nコード1つで、なろう小説API（作品の数）となろう殿堂入りAPI
 * （その作品の順位の履歴）を続けて呼ぶ。決まりごとは `core/narouApi.ts` と
 * `core/narouApiGate.ts` の頭に書いた（作者が運営へ約束した使い方）。
 *
 * **VS Code API に直接は触らない**（通信・保管庫・台帳・開く口は差し込む）。試験で本物の
 * API を呼ばずに、同意・上限・失敗の種類ごとの文を確かめるため。
 */

/** 保管庫（`verifiedState(globalState)` を渡す） */
export interface NarouApiMemento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** 台帳の読み書き（`PostingStore`） */
export interface NarouApiLedgerStore {
  load(): Promise<PostingLedger>;
  save(ledger: PostingLedger): Promise<void>;
}

/** 返事のうち使う所だけ（`fetch` の `Response` の一部） */
export interface NarouApiResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface NarouApiDeps {
  memento: NarouApiMemento;
  store: NarouApiLedgerStore;
  /** 本物は `globalThis.fetch`。試験では差し替える */
  fetch: (url: string) => Promise<NarouApiResponse>;
  /** ブラウザ版の VS Code か（真ならボタンを出さず、届いても断る） */
  isWeb: boolean;
  now?: () => Date;
}

/** 画面へ渡す「なろうAPI」の欄の状態 */
export interface NarouApiPanelState {
  /**
   * - `web`：ブラウザ版なので使えない（1行の案内だけ）
   * - `no-ncode`：Nコードが登録されていない（案内だけ）
   * - `ready`：同意とボタンを出す
   */
  status: "web" | "no-ncode" | "ready";
  ncode: string | null;
  guidelineUrl: string;
  /** ガイドラインを開いたか（開くまでチェックを押せない） */
  opened: boolean;
  /** 同意しているか（同意しているときだけボタンを押せる） */
  agreed: boolean;
  agreedAt: string | null;
  attribution: string;
  /** 上限（画面の説明に出す。数はここ1か所が持つ） */
  intervalMinutes: number;
  dailyLimit: number;
}

/** 押した結果（画面へ返す） */
export type NarouApiOutcome =
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "refused"; message: string };

/**
 * 「なろうの反応」に出す欄の状態。**なろうに載っていると分かっている作品だけ**
 * （そうでなければ null。タブ自体が出ない）。
 */
export function narouApiPanelState(
  memento: NarouApiMemento,
  ledger: PostingLedger | null,
  isWeb: boolean
): NarouApiPanelState | null {
  if (!ledger || !isKnownPostingSite(ledger, "narou")) return null;
  const profile = siteProfile(ledger, "narou");
  const ncode = narouNcode(profile?.workId, profile?.workUrl) ?? null;
  const consent = readNarouApiConsent(memento.get<unknown>(NAROU_API_CONSENT_KEY, undefined));
  return {
    status: isWeb ? "web" : ncode ? "ready" : "no-ncode",
    ncode,
    guidelineUrl: NAROU_GUIDELINE_URL,
    opened: consent.opened,
    agreed: consent.agreed,
    agreedAt: consent.agreedAt,
    attribution: NAROU_API_ATTRIBUTION,
    intervalMinutes: NAROU_API_INTERVAL_MINUTES,
    dailyLimit: NAROU_API_DAILY_LIMIT,
  };
}

/**
 * ガイドラインを開く。**開けたときだけ**「開いた」と覚える（作者の指示 2026-11-02）。
 *
 * @param openExternal 本物は `vscode.env.openExternal`（開けたかを真偽で返す）
 * @returns 開けたか
 */
export async function openNarouGuideline(
  memento: NarouApiMemento,
  openExternal: (url: string) => Promise<boolean> | Thenable<boolean>,
  now: () => Date = () => new Date()
): Promise<boolean> {
  const opened = await openExternal(NAROU_GUIDELINE_URL);
  if (!opened) return false;
  await memento.update(
    NAROU_API_CONSENT_KEY,
    withGuidelineOpened(memento.get<unknown>(NAROU_API_CONSENT_KEY, undefined), now().toISOString())
  );
  return true;
}

/**
 * チェックを入れた・外した。**開いていなければ入れない**（画面で押せないが、ほかの道から
 * 届いても入れない）。
 *
 * @returns いまの同意（入れた結果・外した結果）
 */
export async function setNarouApiAgreement(
  memento: NarouApiMemento,
  agreed: boolean,
  now: () => Date = () => new Date()
): Promise<boolean> {
  const current = memento.get<unknown>(NAROU_API_CONSENT_KEY, undefined);
  const next = withAgreement(current, agreed, now().toISOString());
  if (next.changed) await memento.update(NAROU_API_CONSENT_KEY, next.record);
  return readNarouApiConsent(next.changed ? next.record : current).agreed;
}

/** 1つの API を呼んで本文を返す。**失敗は種類を分けて投げる**（本文は持たせてログへ） */
async function callApi(
  deps: NarouApiDeps,
  url: string,
  api: string,
  ncode: string
): Promise<string> {
  let response: NarouApiResponse;
  try {
    response = await deps.fetch(url);
  } catch (error) {
    throw new NarouApiError(
      "network",
      describeNarouApiFailure("network", api, { ncode }),
      error instanceof Error ? error.message : String(error)
    );
  }
  let body = "";
  try {
    body = await response.text();
  } catch (error) {
    throw new NarouApiError(
      "network",
      describeNarouApiFailure("network", api, { ncode }),
      error instanceof Error ? error.message : String(error),
      response.status
    );
  }
  if (!response.ok) {
    throw new NarouApiError(
      "http",
      describeNarouApiFailure("http", api, { ncode, status: response.status }),
      body,
      response.status
    );
  }
  return body;
}

/** 読み取りの失敗を、作者に見せる文へ置き直す（本文はそのまま持つ） */
function asReadFailure(error: unknown, api: string, ncode: string): NarouApiError {
  if (error instanceof NarouApiError) {
    return new NarouApiError(
      error.kind,
      describeNarouApiFailure(error.kind, api, { ncode, status: error.status }),
      error.body,
      error.status
    );
  }
  return new NarouApiError(
    "shape",
    describeNarouApiFailure("shape", api, { ncode }),
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * **返事の本文をログへ残す**（実装ルール5。通知には出さない）。なろうの API は鍵を使わない
 * ので伏せる文字列は無い。長すぎる本文は頭だけ（作品の数の返事は数百字に収まる）
 */
function logApiFailure(work: WorkEntry, api: string, url: string, error: NarouApiError): void {
  useLogFile(work.folderPath);
  logFailure(`${api}の取得`, {
    作品: work.title,
    URL: url,
    種類: error.kind,
    状態: error.status,
    返事の本文: (error.body ?? "").slice(0, 4000),
  });
}

/**
 * ［なろうAPIによる作品情報取得］を押したとき。
 *
 * 順番：ブラウザ版でない → 台帳を読む → なろうに載っていて Nコードがある → 同意している →
 * 上限の内側 → **取りにいった時刻を先に覚える**（失敗しても1回に数える）→ 作品の数 →
 * 順位 → 台帳へ書く。順位だけ取れなかったときは、取れた作品の数は書いて、順位の失敗を言う。
 */
export async function fetchNarouApi(work: WorkEntry, deps: NarouApiDeps): Promise<NarouApiOutcome> {
  if (deps.isWeb) {
    return {
      kind: "refused",
      message: "なろうAPIによる作品情報取得は、パソコンの VS Code で使えます（ブラウザ版では使えません）。",
    };
  }
  const now = deps.now ?? (() => new Date());
  const ledger = await deps.store.load();
  if (!isKnownPostingSite(ledger, "narou")) {
    return {
      kind: "refused",
      message: "この作品は小説家になろうに載っていることが分かっていません。「投稿サイト設定」で登録してください。",
    };
  }
  const profile = siteProfile(ledger, "narou");
  const ncode = narouNcode(profile?.workId, profile?.workUrl);
  if (!ncode) {
    return { kind: "refused", message: "投稿サイト設定で Nコードを登録すると使えます。" };
  }
  const consent = readNarouApiConsent(deps.memento.get<unknown>(NAROU_API_CONSENT_KEY, undefined));
  if (!consent.agreed) {
    return {
      kind: "refused",
      message: "なろうデベロッパー利用ガイドラインを開いて読み、同意のチェックを入れると押せます。",
    };
  }
  const at = now();
  const attempts = readNarouApiAttempts(deps.memento.get<unknown>(NAROU_API_ATTEMPTS_KEY, {}), ncode);
  const verdict = judgeNarouApiAttempt(attempts, at);
  if (!verdict.allowed) return { kind: "refused", message: verdict.message };

  await deps.memento.update(
    NAROU_API_ATTEMPTS_KEY,
    withNarouApiAttempt(deps.memento.get<unknown>(NAROU_API_ATTEMPTS_KEY, {}), ncode, at.toISOString())
  );

  const novelApi = "なろう小説API";
  const novelUrl = narouNovelApiUrl(ncode);
  let novel: NarouNovelInfo;
  try {
    novel = parseNarouNovelApi(await callApi(deps, novelUrl, novelApi, ncode), ncode);
  } catch (error) {
    const failure = asReadFailure(error, novelApi, ncode);
    logApiFailure(work, novelApi, novelUrl, failure);
    return { kind: "failed", message: failure.message };
  }

  const rankApi = "なろう殿堂入りAPI";
  const rankUrl = narouRankinApiUrl(ncode);
  let ranks: NarouRankinEntry[] = [];
  let rankFailure: string | undefined;
  try {
    ranks = parseNarouRankinApi(await callApi(deps, rankUrl, rankApi, ncode));
  } catch (error) {
    const failure = asReadFailure(error, rankApi, ncode);
    logApiFailure(work, rankApi, rankUrl, failure);
    rankFailure = failure.message;
  }

  /*
    **台帳は押した直後に読み直す。** 通信の数秒の間に、ほかの所（ヘルパーの取り込み）が
    台帳を書いていることがある。古い手持ちへ積んで保存すると、`PostingStore` の照合で
    止まる（止まるのは正しいが、作者には無駄な失敗に見える）
  */
  const fresh = await deps.store.load();
  const applied = applyNarouApiResult(fresh, { readAt: at.toISOString(), novel, ranks });
  if (applied.statsAdded || applied.ranksAdded > 0 || applied.factsChanged || applied.ledger !== fresh) {
    await deps.store.save(applied.ledger);
  }
  logStep(
    `なろうAPI: ${work.title}（${ncode}）数${applied.statsAdded ? "を記録" : "は前と同じ"}・` +
      `順位 新${applied.ranksAdded}件／既${applied.ranksRepeated}件`
  );

  const parts = [
    applied.statsAdded
      ? "作品の数を記録しました"
      : "作品の数は、今日いちど取った数と同じだったので積みませんでした",
  ];
  if (rankFailure === undefined) {
    parts.push(
      applied.ranksAdded > 0
        ? `順位を${applied.ranksAdded}件新しく記録しました`
        : ranks.length > 0
          ? "順位は新しいものがありませんでした"
          : "ランキングに入った記録はまだありません"
    );
  }
  const message = `${parts.join("。")}。（${NAROU_API_ATTRIBUTION}）`;
  if (rankFailure !== undefined) {
    return { kind: "failed", message: `${message}\n順位は取れませんでした：${rankFailure}` };
  }
  return { kind: "done", message };
}
