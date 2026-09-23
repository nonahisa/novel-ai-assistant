import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { CONTEST_RSS_LABEL, CONTEST_RSS_URL, contestsFromRss } from "../core/contestRss";
import { parseRssFeed } from "../core/rssFeed";
import { localIsoString } from "../core/contestInbox";
import { isWebRuntime } from "../core/runtime";
import { logFailure, logLine, useLogFile } from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import { acceptContests, type ContestImportDeps } from "./contestImport";

/**
 * 公募を RSS から取り込む（設計書6.3.6.2）。
 *
 * ツクリテミライが作者の頼みで作ってくれたフィード（`CONTEST_RSS_URL`）を読む。
 *
 * ## 押したときだけ取りに行く（作者の裁定、2026-09-23）
 *
 * - **自動では取りに行かない。** 起動のたびや定期に読みに行くと、作者の知らない
 *   ところでサイトへ通信が出る
 * - **押す前に、どこへつなぐかを出す。** 送るものは無い（読むだけ）ことも言う
 *
 * ## ブラウザ版でも動く形
 *
 * `fetch` は手元の VS Code では VS Code が差し替えたもの（プロキシ・社内証明書の
 * 対応つき）、ブラウザ版ではブラウザのものである。どちらも同じ呼び方で動く
 * （Node 専用の部品を読み込まない。CLAUDE.md 規則7）。ブラウザ版では、サイトの
 * 側の設定によって読めないことがある——そのときも理由を決めつけず、貼り付けの道を言う。
 *
 * 読んだあとは、ヘルパー・貼り付けと同じ `acceptContests` を通す
 * （締切・字数の読み替え、置き場、取り込み直したときの違いの知らせ）。
 */

/** 待つ上限。フィードは 50件で数十KB。これで返らなければ、待っても変わらない */
const FETCH_TIMEOUT_MS = 30_000;
/** 受け取る大きさの上限（フィードが壊れて巨大な文が返ったときに抱え込まない） */
const MAX_FEED_CHARS = 5_000_000;

/** ほかの道（取りに行けなかったとき） */
const OTHER_WAY =
  "ほかの道として、公募の一覧のページで文章を全部選んでコピー（Ctrl+A → Ctrl+C）し、" +
  "「作品目標設定」→「公募の一覧を貼り付けて取り込む」からも入れられます。";

/** 取りに行く口（テストで差し替える） */
export type FeedFetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function importContestsFromRss(
  deps: ContestImportDeps,
  work?: WorkEntry,
  fetcher: FeedFetcher = (url, init) => globalThis.fetch(url, init)
): Promise<void> {
  const go = "取りに行く";
  const answer = await vscode.window.showInformationMessage(
    `${CONTEST_RSS_LABEL}から、公募を取り込みますか？`,
    {
      modal: true,
      detail:
        `つなぐ先：${CONTEST_RSS_URL}\n` +
        "読むだけで、こちらから送るものはありません（作品の中身も送りません）。\n" +
        "押したときだけ取りに行きます。自動では取りに行きません。",
    },
    go
  );
  if (answer !== go) return;

  useLogFile(undefined);
  logLine(`公募の RSS を取りに行きます：${CONTEST_RSS_URL}`);

  let body: string | undefined;
  let status: number | undefined;
  let failure: unknown;
  let cancelled = false;
  await withCancellableProgress("公募の RSS を取りに行っています", async (_progress, token) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    token.onCancellationRequested(() => {
      cancelled = true;
      controller.abort();
    });
    try {
      const response = await fetcher(CONTEST_RSS_URL, {
        method: "GET",
        headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.1" },
        signal: controller.signal,
      });
      status = response.status;
      const text = await response.text();
      if (!response.ok) {
        // **本文を捨てない**（ログへ。画面には番号だけ）
        logFailure("公募の RSS を取りに行けませんでした", {
          状態: response.status,
          応答: text.slice(0, 300),
        });
        return;
      }
      body = text;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
  });

  if (cancelled) return;
  if (failure !== undefined) {
    const detail = describeError(failure);
    logFailure("公募の RSS につなげませんでした", { 理由: detail });
    const timedOut = failure instanceof Error && failure.name === "AbortError";
    void vscode.window.showWarningMessage(
      (timedOut
        ? `公募の RSS が${FETCH_TIMEOUT_MS / 1000}秒たっても返ってきませんでした。`
        : "公募の RSS につなげませんでした。インターネットにつながっているか確かめて、時間をおいてもう一度お試しください。") +
        (isWebRuntime()
          ? "ブラウザ版では、サイトの側の設定によって読めないことがあります。"
          : "") +
        OTHER_WAY
    );
    return;
  }
  if (body === undefined) {
    void vscode.window.showWarningMessage(
      `公募の RSS を取りに行けませんでした（HTTP ${status ?? "不明"}）。時間をおいてもう一度お試しください。` +
        OTHER_WAY
    );
    return;
  }
  if (body.length > MAX_FEED_CHARS) {
    logFailure("公募の RSS が大きすぎるため読みませんでした", { 字数: body.length });
    void vscode.window.showWarningMessage(
      "公募の RSS が思ったより大きかったため、読みませんでした。" + OTHER_WAY
    );
    return;
  }

  const feed = parseRssFeed(body);
  if (!feed.ok) {
    logFailure("公募の RSS を読めませんでした", { 理由: feed.reason, 応答: body.slice(0, 300) });
    void vscode.window.showWarningMessage(feed.reason + OTHER_WAY);
    return;
  }

  const read = contestsFromRss(feed);
  await acceptContests(
    deps,
    {
      from: "rss",
      listings: read.listings,
      skipped: read.skipped,
      // 公募の置き場の「読んだ一覧のページ」は、フィードではなく一覧のページ
      // （フィードの XML を開いても作者には読めない）
      pageUrl: feed.channelLink,
      readAt: localIsoString(new Date()),
    },
    "rss",
    work
  );
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const parts = [`${error.name}: ${error.message}`];
  if (cause && typeof cause.code === "string") parts.push(cause.code);
  if (cause && typeof cause.message === "string") parts.push(cause.message);
  return parts.join(" / ");
}
