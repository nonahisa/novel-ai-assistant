import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { canRunProcesses } from "../core/runtime";
import { logStep, useLogFile } from "../core/logger";

/**
 * 作者の GitHub のユーザー名を引く（設計書5.7.5.9。0.138.0）。
 *
 * 作者が編集者の提案を決めたとき、採否の行（decision）に `decidedByLogin` として書き足す。
 * 編集者の側の「作者の採否」の一覧は、決めた作者の名前をこれで出す。`decidedBy` は作者の
 * パソコンの git の名前なので画面に出さない（作者の答え 2026-11-07「git の名前を出すより、出さない」）。
 *
 * - **窓を新しく出さない。** VS Code の GitHub のサインインがあればその鍵（`silent`）、
 *   無ければ手元の VS Code だけ `gh` の鍵を借りる（`acquireGithubToken(false)`。git を使う束なので
 *   動的 import。実装ルール7）。鍵で `GET /user` を引き、`login` を取る
 * - **取れなければ `undefined`。** 採否の書き込みは止めず、名前を書かないだけにする
 * - **通ったときだけ覚える**（この窓の間。失敗は覚えない。実装ルール5）。
 *   別のアカウントへ替えたときに古い名前を書かないよう、鍵ごとに覚える
 *
 * `GET /user` は `core/githubCollaboration.ts` の `fetchAuthenticatedLogin` と同じ問い合わせだが、
 * あちらは `core/gitSetup.ts`（Node の束）を静的に読むので、ブラウザ版の束へ届くここからは使えない
 * （`browserReach.test.ts`）。問い合わせだけをここに持つ。
 */

/** 鍵（`repo` の権限）。`core/gitSetup.ts` の `GITHUB_OAUTH_SCOPES` と同じもの（あちらは Node の束） */
const SCOPES = ["repo"];

/** 引く時間の上限。採否の書き込みを待たせすぎない */
const LOOKUP_TIMEOUT_MS = 5_000;

const API_USER = "https://api.github.com/user";
// GitHub の API は User-Agent の無い問い合わせを断る（`core/gitSetup.ts` の値と同じ）
const USER_AGENT = "novel-ai-assistant-vscode-extension";

type LoginResult = { ok: true; login: string } | { ok: false; detail: string };

let remembered: { token: string; login: string } | undefined;

/**
 * 引けなかったあと、引き直さない短い間（ミリ秒）。
 *
 * **失敗は覚えない**（長くは持たない）が、［まとめて適用］で十数件を続けて決めると、鍵の無い
 * 環境では1件ごとに最大5秒ずつ待つことになる。続けて決める間だけ引き直さない
 */
const RETRY_AFTER_FAILURE_MS = 60_000;
let failedAt: number | undefined;

/**
 * 試験では鍵の出どころを差し替える（`test/unit/support/setup.ts` が毎回「鍵なし」にする）。
 * 差し替えないと、試験の中で採否を決めたときに本物の gh の鍵と GitHub へ出ていく
 */
let tokenSourceForTests: (() => Promise<string | undefined>) | undefined;

export function setAuthorTokenSourceForTests(
  source: (() => Promise<string | undefined>) | undefined
): void {
  tokenSourceForTests = source;
  remembered = undefined;
  failedAt = undefined;
}

export interface AuthorLoginDeps {
  /** 今の時刻（テストで差し替える） */
  now?: () => number;
  /** 窓を出さずに取れる鍵 */
  token?: () => Promise<string | undefined>;
  fetchLogin?: (token: string) => Promise<LoginResult>;
}

export async function authorGithubLogin(
  work: WorkEntry,
  deps: AuthorLoginDeps = {}
): Promise<string | undefined> {
  const now = (deps.now ?? Date.now)();
  if (failedAt !== undefined && now - failedAt < RETRY_AFTER_FAILURE_MS) return undefined;
  const failed = (): undefined => {
    failedAt = now;
    return undefined;
  };
  try {
    const token = await withTimeout((deps.token ?? tokenSourceForTests ?? silentToken)());
    if (!token) return failed();
    if (remembered && remembered.token === token) return remembered.login;
    const result = await withTimeout((deps.fetchLogin ?? fetchLogin)(token));
    if (!result) {
      note(work, "時間内に返事がありませんでした");
      return failed();
    }
    if (!result.ok) {
      note(work, result.detail);
      return failed();
    }
    failedAt = undefined;
    remembered = { token, login: result.login };
    return result.login;
  } catch (error) {
    note(work, error instanceof Error ? error.message : String(error));
    return failed();
  }
}

/** 引けなかった理由をログへ（画面には出さない。採否は名前なしで書く） */
function note(work: WorkEntry, detail: string): void {
  useLogFile(work.folderPath);
  logStep(`作者の GitHub 名を引けなかった（採否に名前を書かない）: ${detail}`);
}

async function silentToken(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession("github", SCOPES, { silent: true });
    if (session?.accessToken) return session.accessToken;
  } catch {
    // サインインが確かめられないだけ。gh の道へ
  }
  if (!canRunProcesses()) return undefined;
  const { acquireGithubToken } = await import("./shareWithEditor.js");
  // サインインは上で無いと分かっているので、gh の鍵だけを借りる（どちらも窓を出さない）
  return acquireGithubToken(false, { hasSession: async () => false });
}

async function fetchLogin(token: string): Promise<LoginResult> {
  const response = await fetch(API_USER, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) return { ok: false, detail: `GitHub の返事 ${response.status}` };
  const body: unknown = await response.json();
  const login =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).login : undefined;
  return typeof login === "string" && login.length > 0
    ? { ok: true, login }
    : { ok: false, detail: "GitHub の返事にアカウント名がありませんでした" };
}

function withTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
