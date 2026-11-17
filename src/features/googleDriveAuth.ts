// ログの書き先：ログインは機械ごとの話で、どの作品のログでもないので保管庫のログへ倒す
import * as vscode from "vscode";
import { createDriveClient, type DriveClient, type DriveFetch } from "../core/driveApi";
import {
  GOOGLE_DRIVE_CLIENT_KEY,
  parseGoogleClientJson,
  parseStoredGoogleClient,
  readGoogleClientInput,
  serializeGoogleClient,
  type GoogleClientConfig,
} from "../core/googleClientConfig";
import {
  createGoogleAccessTokens,
  googleLoginNextAction,
  logoutGoogle,
  runGoogleLogin,
  type GoogleAccessTokens,
  type GoogleTokenFetch,
  type LoopbackListener,
  type LoopbackRequest,
} from "../core/googleLogin";
import {
  GOOGLE_DRIVE_SECRET_KEY,
  hexToBytes,
  type GoogleCredentialVault,
  type StoredGoogleCredential,
} from "../core/googleOAuth";
import { sha256Bytes } from "../core/hash";
import { logLine } from "../core/logger";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import { askText, cancelItem } from "../views/dialogs";

/**
 * Google の提供者（設計書5.10.9。段階3）。手順は `core/googleLogin.ts`、ここは VS Code と
 * 手元の機械の口（SecretStorage・ブラウザを開く・`127.0.0.1` の待ち受け・`fetch`）だけ。
 *
 * **ブラウザ版では使わない**（設計書5.10.2。手元で待ち受けられない）。`node:http` は
 * 動的 import（実装ルール7）。命令はブラウザ版のメニューから隠す（`processAvailability.ts`）。
 *
 * 鍵（refresh token）とクライアント（ID・シークレット）は SecretStorage。**ログにも画面にも
 * 出さない**（ログに出すのは状態の番号と符号だけ。`googleLogin.ts`）。
 */

/** ログインを待つ上限（作者がブラウザで許可を押すまで） */
const LOGIN_WAIT_MS = 5 * 60 * 1000;

export interface GoogleDriveAuth {
  /** 接続の設定（クライアント）があり、ログインしているか */
  isLoggedIn(): Promise<boolean>;
  hasClient(): Promise<boolean>;
  /** Drive の口（アクセストークンは中で更新する） */
  driveClient(): DriveClient;
  /** ログインする（ブラウザが開く）。済めば true。失敗は知らせを出して false */
  login(): Promise<boolean>;
  logout(): Promise<void>;
  /** 接続の設定（クライアント ID を入れる・JSON を読む）→ ログイン */
  setup(): Promise<void>;
}

export function createGoogleDriveAuth(secrets: vscode.SecretStorage): GoogleDriveAuth {
  const vault: GoogleCredentialVault = {
    get: async () => {
      const text = await secrets.get(GOOGLE_DRIVE_SECRET_KEY);
      if (text === undefined) return undefined;
      try {
        const value = JSON.parse(text) as Partial<StoredGoogleCredential>;
        if (typeof value.refreshToken !== "string" || value.refreshToken === "") return undefined;
        return {
          refreshToken: value.refreshToken,
          scope: typeof value.scope === "string" ? value.scope : "",
          obtainedAt: typeof value.obtainedAt === "string" ? value.obtainedAt : "",
        };
      } catch {
        // 壊れた値は直さず、ログインしていないものとして扱う（ログインし直せば置き換わる）
        return undefined;
      }
    },
    store: async (credential) => {
      await secrets.store(GOOGLE_DRIVE_SECRET_KEY, JSON.stringify(credential));
    },
    delete: async () => {
      await secrets.delete(GOOGLE_DRIVE_SECRET_KEY);
    },
  };
  const readClient = async (): Promise<GoogleClientConfig | undefined> => {
    const read = parseStoredGoogleClient(await secrets.get(GOOGLE_DRIVE_CLIENT_KEY));
    return read.ok ? read.client : undefined;
  };
  const tokens: GoogleAccessTokens = createGoogleAccessTokens({
    client: readClient,
    vault,
    fetch: tokenFetch,
    nowMs: () => Date.now(),
    log: logLine,
  });

  const auth: GoogleDriveAuth = {
    async hasClient() {
      return (await readClient()) !== undefined;
    },
    async isLoggedIn() {
      return (await readClient()) !== undefined && (await vault.get()) !== undefined;
    },
    driveClient() {
      return createDriveClient({ fetch: driveFetch, accessToken: tokens.source, log: logLine });
    },
    async login() {
      const client = await readClient();
      if (!client) {
        void vscode.window.showWarningMessage(
          "Google ドライブの接続がまだ設定されていません。「Google ドライブの接続を設定」から設定してください。"
        );
        return false;
      }
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ブラウザで Google にログインしてください…",
          cancellable: true,
        },
        async (_progress, token) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = new Promise<"timeout" | "cancelled">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), LOGIN_WAIT_MS);
            token.onCancellationRequested(() => resolve("cancelled"));
          });
          try {
            return await runGoogleLogin({
              client,
              listen: listenLoopback,
              openBrowser: async (url) => vscode.env.openExternal(vscode.Uri.parse(url, true)),
              fetch: tokenFetch,
              randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
              sha256: (bytes) => hexToBytes(sha256Bytes(bytes)),
              nowMs: () => Date.now(),
              vault,
              stop,
              log: logLine,
            });
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      );
      if (!result.ok) {
        void vscode.window.showWarningMessage(
          `Google へのログインは済んでいません。${googleLoginNextAction(result.kind)}`
        );
        return false;
      }
      tokens.adopt(result.tokens);
      void vscode.window.showInformationMessage("Google へログインしました。");
      return true;
    },
    async logout() {
      await logoutGoogle({ vault, tokens });
      void vscode.window.showInformationMessage(
        "Google ドライブからログアウトしました（このパソコンに置いていた鍵を消しました）。"
      );
    },
    async setup() {
      const fromFile = { label: "$(file) JSON のファイルを読み込む", key: "file" as const };
      const byHand = { label: "$(edit) クライアント ID を入れる", key: "input" as const };
      const picked = await showQuickPickKeepingFocus([fromFile, byHand, cancelItem()], {
        title: "Google ドライブの接続を設定",
        placeHolder: "Google Cloud で作ったデスクトップ アプリのクライアント",
        ignoreFocusOut: true,
      });
      if (!picked || !("key" in picked)) return;
      const read = picked.key === "file" ? await clientFromFile() : await clientFromInput();
      if (read === undefined) return;
      if (!read.ok) {
        void vscode.window.showWarningMessage(`接続の設定を保存していません。${read.reason}。`);
        return;
      }
      await secrets.store(GOOGLE_DRIVE_CLIENT_KEY, serializeGoogleClient(read.client));
      tokens.reset();
      logLine("[google] 接続の設定を保存しました");
      await auth.login();
    },
  };
  return auth;
}

async function clientFromFile() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "読み込む",
    filters: { JSON: ["json"] },
  });
  if (!picked || picked.length === 0) return undefined;
  try {
    return parseGoogleClientJson(new TextDecoder().decode(await vscode.workspace.fs.readFile(picked[0])));
  } catch {
    return { ok: false as const, reason: "ファイルを読めません" };
  }
}

async function clientFromInput() {
  const clientId = await askText({
    title: "Google ドライブの接続を設定（1/2）",
    prompt: "クライアント ID",
    placeHolder: "…apps.googleusercontent.com",
    ignoreFocusOut: true,
  });
  if (clientId === undefined) return undefined;
  const clientSecret = await askText({
    title: "Google ドライブの接続を設定（2/2）",
    prompt: "クライアント シークレット（無ければ空のまま Enter）",
    password: true,
    ignoreFocusOut: true,
  });
  if (clientSecret === undefined) return undefined;
  return readGoogleClientInput({ clientId, clientSecret });
}

/** トークンの口への送信（手元の `fetch`） */
const tokenFetch: GoogleTokenFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

/** Drive の口への送信（手元の `fetch`） */
const driveFetch: DriveFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body as string | Uint8Array<ArrayBuffer> | undefined,
  });
  return {
    status: response.status,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
};

/**
 * `127.0.0.1` の空いている番号で待ち受ける（設計書5.10.5）。`node:http` は動的 import。
 * 届いた要求は並べておき、`next` で1つずつ返す
 */
async function listenLoopback(): Promise<LoopbackListener> {
  const http = await import("node:http");
  const queue: LoopbackRequest[] = [];
  const waiters: ((request: LoopbackRequest) => void)[] = [];
  const server = http.createServer((req, res) => {
    const request: LoopbackRequest = {
      path: req.url ?? "/",
      respond: (status, html) =>
        new Promise<void>((resolve) => {
          res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(html, () => resolve());
        }),
    };
    const waiter = waiters.shift();
    if (waiter) waiter(request);
    else queue.push(request);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("待ち受けの番号が分かりません");
  }
  return {
    port: address.port,
    next: () =>
      new Promise<LoopbackRequest>((resolve) => {
        const head = queue.shift();
        if (head) resolve(head);
        else waiters.push(resolve);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
