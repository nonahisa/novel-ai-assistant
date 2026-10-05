import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { EXTENSION_URI_AUTHORITY } from "../core/setupRequest";

/**
 * 拡張機能の保管庫（`globalStorageUri`）の場所を、MCP サーバー側から知る。
 *
 * **道は1つだけ。** 助言方針の控え（`adviceProfileMirror.ts`）で選んだ道を
 * ここへ出した——窓の札（`tools/windows.ts`）も同じ保管庫を読むので、
 * 2か所で別々に決めると、片方だけが別の場所を指す日が来る
 * （拡張機能側で `features/globalStoragePath.ts` へ寄せたのと同じ理由）。
 *
 * **どうやって知るか。** このプロセスは VS Code の外に居るので
 * `context.globalStorageUri` を持たない。探す順は次のとおり（`resolveStorageRoot`）。
 *
 * 1. **環境変数**（`NOVELAI_GLOBAL_STORAGE`）。明示があれば必ずこちら
 * 2. **束の居場所が保管庫そのもの**のとき（親フォルダーの名前が拡張機能ID）。
 *    拡張機能は版に依らない場所（`globalStorage/<拡張機能ID>/`）へ束を写して
 *    から登録する（設計書6.87.15）ので、ふつうはここで決まる。**既定の場所より
 *    先に見る**——Insiders など別の VS Code で入れていて、通常版の保管庫も
 *    残っている機械で、別の VS Code の保管庫を取り違えないため
 * 3. **VS Code の既定の保管庫**（Windows は `%APPDATA%\Code\User\globalStorage\<ID>`、
 *    macOS・Linux もそれぞれの既定）。**束を `dist/` から走らせている**とき、
 *    以前は 4 へ落ちて `dist/.aiwriter` を読み、`works.list`・`ai.settings` が
 *    空になった（2026-10-05、別の機械）
 * 4. 見つからなければ、今までどおり**束の親フォルダー**。このときは返事の
 *    `note` に「保管庫は〈場所〉」を添える（どこを読んだかを呼び手に見せる）
 *
 * **読むだけ。** 探すために作品フォルダーの外を書き換えない。
 *
 * `node:path` を静的に import しているのは、**この束が Node 専用**だから
 * である。`core/` へは持ち込まない。
 */

/** 保管庫を明示する環境変数。**指定があればこちらが勝つ** */
export const GLOBAL_STORAGE_ENV = "NOVELAI_GLOBAL_STORAGE";

/**
 * 保管庫のフォルダー名。VS Code は拡張機能ID（発行者.名前）を**小文字で**
 * 使う。URI の宛先（`EXTENSION_URI_AUTHORITY`）と同じ文字列である。
 */
export const EXTENSION_STORAGE_ID = EXTENSION_URI_AUTHORITY.toLowerCase();

/**
 * どこから決めたか。
 *
 * - `env`：環境変数
 * - `bundle`：束の居場所が保管庫そのもの
 * - `default`：VS Code の既定の保管庫
 * - `bundleFallback`：どれも無く、束の親フォルダーへ落ちた（**断りを添える**）
 */
export type StorageSource = "env" | "bundle" | "default" | "bundleFallback";

export interface StorageResolution {
  root: string;
  source: StorageSource;
}

export interface StorageProbe {
  env: string | undefined;
  /** 走っている束（`process.argv[1]`） */
  bundlePath: string | undefined;
  platform: NodeJS.Platform;
  home: string;
  /** Windows の `%APPDATA%` */
  appData: string | undefined;
  /** Linux の `$XDG_CONFIG_HOME` */
  xdgConfigHome: string | undefined;
  /** そのフォルダーがあるか（**読むだけ**） */
  exists(dir: string): boolean;
}

/** VS Code の既定の保管庫の候補（**見る順**。通常版 → Insiders） */
export function defaultStorageCandidates(probe: Omit<StorageProbe, "exists" | "env" | "bundlePath">): string[] {
  const p = probe.platform === "win32" ? nodePath.win32 : nodePath.posix;
  let base: string | undefined;
  if (probe.platform === "win32") {
    base = probe.appData?.trim() || p.join(probe.home, "AppData", "Roaming");
  } else if (probe.platform === "darwin") {
    base = p.join(probe.home, "Library", "Application Support");
  } else {
    base = probe.xdgConfigHome?.trim() || p.join(probe.home, ".config");
  }
  return ["Code", "Code - Insiders"].map((product) =>
    p.join(base as string, product, "User", "globalStorage", EXTENSION_STORAGE_ID)
  );
}

/** 束の名前（`mcp-server.mjs`）。試験の道具が走っているときと見分ける */
function isMcpBundle(bundlePath: string): boolean {
  return /^mcp-server[^\\/]*\.m?js$/u.test(nodePath.basename(bundlePath));
}

/**
 * 保管庫の場所を決める（**判断だけ**。ファイルは `exists` で見るだけ）。
 *
 * **束が MCP の束でないとき（単体テストの道具など）は、既定の場所を探さない。**
 * 探すと、試験が作者の本物の保管庫を読んでしまう。以前どおり束の親を返す。
 */
export function resolveStorageRoot(probe: StorageProbe): StorageResolution | undefined {
  const explicit = probe.env?.trim();
  if (explicit) return { root: nodePath.resolve(explicit), source: "env" };

  const bundle = probe.bundlePath;
  if (!bundle) return undefined;
  const bundleDir = nodePath.dirname(nodePath.resolve(bundle));
  if (!isMcpBundle(bundle)) return { root: bundleDir, source: "bundle" };

  if (nodePath.basename(bundleDir).toLowerCase() === EXTENSION_STORAGE_ID) {
    return { root: bundleDir, source: "bundle" };
  }
  for (const candidate of defaultStorageCandidates(probe)) {
    if (probe.exists(candidate)) return { root: candidate, source: "default" };
  }
  return { root: bundleDir, source: "bundleFallback" };
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * いまの保管庫の場所と、どこから決めたか。
 *
 * **毎回調べ直す。** 走っている間に変わるものではないが、値を抱え込むと
 * 試験が環境変数を差し替えられない（`staleness.ts` が `process.argv` を
 * 引数で受けているのと同じ理由）。
 */
export function mcpGlobalStorage(): StorageResolution | undefined {
  return resolveStorageRoot({
    env: process.env[GLOBAL_STORAGE_ENV],
    bundlePath: process.argv[1],
    platform: process.platform,
    home: os.homedir(),
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    exists: isDirectory,
  });
}

/** 保管庫の場所。分からなければ `undefined` */
export function mcpGlobalStorageRoot(): string | undefined {
  return mcpGlobalStorage()?.root;
}

/** 束の親へ落ちたときに返事へ添える1行。落ちていなければ空 */
export function storageFallbackLine(resolution: StorageResolution | undefined): string {
  if (!resolution || resolution.source !== "bundleFallback") return "";
  return (
    `保管庫は ${resolution.root} です（VS Code の既定の保管庫が見つからず、走っている束の場所を使いました）。` +
    `作品の登録簿やAI設定が空なら、環境変数 ${GLOBAL_STORAGE_ENV} に拡張機能の保管庫を渡してください。`
  );
}

/**
 * 返事の `note` の頭へ、保管庫の断りを足す（`staleness.ts` の `withStaleNote` と同じ形）。
 * **既存の `note` は消さない。**
 */
export function withStorageNote(value: unknown, resolution: StorageResolution | undefined): unknown {
  const line = storageFallbackLine(resolution);
  if (!line) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const existing = typeof record.note === "string" ? record.note : "";
  return { ...record, note: [line, existing].filter(Boolean).join("\n") };
}
