import * as vscode from "vscode";
import * as paths from "../core/paths";
import {
  HOLIDAYS_LABEL,
  HOLIDAYS_URL,
  mergeHolidaySets,
  parseHolidayApi,
  parseStoredHolidaySet,
  type HolidaySet,
} from "../core/holidays";
import { BUNDLED_HOLIDAYS } from "../core/holidaysJpData";
import { atomicWriteFile } from "../core/atomicWrite";
import { isWebRuntime } from "../core/runtime";
import { logFailure, logLine, useLogFile } from "../core/logger";
import { withCancellableProgress } from "../views/progress";
import { confirmRun } from "../views/notify";
import { globalStorageRoot } from "./globalStoragePath";

/**
 * 祝日の一覧（設計書6.111.12）。
 *
 * 作者の裁定（2026-09-23）：「押すこともできるけど、基本は VSIX に同梱してアップデート」。
 *
 * - **ふだんは同梱の一覧**（`core/holidaysJpData.ts`。配布のたびに取り直す）
 * - 「祝日を取り込む」を**押したときだけ**取りに行く。押す前に、どこへつなぐかを出す
 *   （公募の RSS と同じ。`contestRss.ts`）
 * - 取れた分は**拡張機能の保管庫**に控える（作品の中には置かない——作品ではなく暦の話なので、
 *   作品の git に載せない）。同梱と控えは、取得日の新しいほうを正にして合わせる
 *
 * ## ブラウザ版でも動く形
 *
 * `fetch` は手元の VS Code では VS Code が差し替えたもの、ブラウザ版ではブラウザのもの。
 * 保管庫の読み書きは `vscode.workspace.fs` を通す（Node 専用の部品を読み込まない。規則7）。
 */

export const HOLIDAYS_STORE_FILE = "holidays-jp.json";

/** 待つ上限。一覧は数KB。これで返らなければ、待っても変わらない */
const FETCH_TIMEOUT_MS = 30_000;
/** 受け取る大きさの上限（壊れて巨大な文が返ったときに抱え込まない） */
const MAX_BODY_CHARS = 1_000_000;

export type HolidayFetcher = (url: string, init: RequestInit) => Promise<Response>;

function storePath(context: vscode.ExtensionContext): string {
  return paths.join(globalStorageRoot(context), HOLIDAYS_STORE_FILE);
}

/** 同梱と保管庫の控えを合わせた一覧。控えが読めなければ同梱だけ（止めない） */
export async function loadHolidays(context: vscode.ExtensionContext): Promise<HolidaySet> {
  let stored: HolidaySet | null = null;
  try {
    const bytes = await vscode.workspace.fs.readFile(paths.toUri(storePath(context)));
    stored = parseStoredHolidaySet(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    // 控えが無い（まだ押していない）のがふつう
  }
  return mergeHolidaySets(BUNDLED_HOLIDAYS, stored);
}

/**
 * 祝日の一覧を取りに行き、保管庫に控える。
 *
 * @returns 取り込めたか（画面を描き直すかの判断に使う）
 */
export async function importHolidays(
  context: vscode.ExtensionContext,
  fetcher: HolidayFetcher = (url, init) => globalThis.fetch(url, init)
): Promise<boolean> {
  const current = await loadHolidays(context);
  const years = [...new Set(Object.keys(current.dates).map((date) => date.slice(0, 4)))].sort();
  if (
    !(await confirmRun(
      `${HOLIDAYS_LABEL}から、祝日の一覧を取り込みますか？`,
      "取りに行く",
      {
        detail:
          `つなぐ先：${HOLIDAYS_URL}\n` +
          "読むだけで、こちらから送るものはありません（作品の中身も送りません）。\n" +
          "押したときだけ取りに行きます。ふだんは拡張機能に入っている一覧を使います" +
          `（いまの一覧：${years.length ? `${years[0]}〜${years[years.length - 1]}年` : "なし"}、` +
          `取得 ${current.fetchedAt || "不明"}）。`,
      }
    ))
  ) {
    return false;
  }

  useLogFile(undefined);
  logLine(`祝日の一覧を取りに行きます：${HOLIDAYS_URL}`);
  let body: string | undefined;
  let status: number | undefined;
  let failure: unknown;
  let cancelled = false;
  await withCancellableProgress("祝日の一覧を取りに行っています", async (_progress, token) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    token.onCancellationRequested(() => {
      cancelled = true;
      controller.abort();
    });
    try {
      const response = await fetcher(HOLIDAYS_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      status = response.status;
      const text = await response.text();
      if (!response.ok) {
        // **本文を捨てない**（ログへ。画面には番号だけ）
        logFailure("祝日の一覧を取りに行けませんでした", { 状態: response.status, 応答: text.slice(0, 300) });
        return;
      }
      body = text;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
  });

  if (cancelled) return false;
  const keepBundled = "いまは拡張機能に入っている一覧を使います。";
  if (failure !== undefined) {
    const timedOut = failure instanceof Error && failure.name === "AbortError";
    logFailure("祝日の一覧につなげませんでした", { 理由: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure) });
    void vscode.window.showWarningMessage(
      (timedOut
        ? `祝日の一覧が${FETCH_TIMEOUT_MS / 1000}秒たっても返ってきませんでした。`
        : "祝日の一覧につなげませんでした。インターネットにつながっているか確かめて、時間をおいてもう一度お試しください。") +
        (isWebRuntime() ? "ブラウザ版では、サイトの側の設定によって読めないことがあります。" : "") +
        keepBundled
    );
    return false;
  }
  if (body === undefined) {
    void vscode.window.showWarningMessage(
      `祝日の一覧を取りに行けませんでした（HTTP ${status ?? "不明"}）。時間をおいてもう一度お試しください。${keepBundled}`
    );
    return false;
  }
  if (body.length > MAX_BODY_CHARS) {
    logFailure("祝日の一覧が大きすぎるため読みませんでした", { 字数: body.length });
    void vscode.window.showWarningMessage(`祝日の一覧が思ったより大きかったため、読みませんでした。${keepBundled}`);
    return false;
  }

  let dates: Record<string, string>;
  try {
    dates = parseHolidayApi(JSON.parse(body));
  } catch (error) {
    logFailure("祝日の一覧を読めませんでした", {
      理由: error instanceof Error ? error.message : String(error),
      応答: body.slice(0, 300),
    });
    void vscode.window.showWarningMessage(`祝日の一覧の形が思っていたものと違ったため、使いませんでした。${keepBundled}`);
    return false;
  }

  const now = new Date();
  const fetched: HolidaySet = {
    source: HOLIDAYS_URL,
    fetchedAt: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    dates,
  };
  const target = storePath(context);
  await vscode.workspace.fs.createDirectory(paths.toUri(paths.dirname(target)));
  // 保管庫の控えは作者のデータではない（取り直せる）。上書きの経路で書く（`windowCard.ts` と同じ）
  await atomicWriteFile(target, new TextEncoder().encode(JSON.stringify(fetched, null, 2)));
  const keys = Object.keys(dates);
  void vscode.window.showInformationMessage(
    `祝日の一覧を取り込みました（${keys.length}件、${keys[0].slice(0, 4)}〜${keys[keys.length - 1].slice(0, 4)}年）。スケジュールの逆算に使います。`
  );
  return true;
}
