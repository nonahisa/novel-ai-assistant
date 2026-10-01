// 測定台が回す本文のファイルを並べる（`scripts/measure.mjs` から切り出した）。
//
// **本文の場所の決め方は写さない。** 拡張機能・MCP と同じ
// `core/manuscriptFolderRule.ts` を、外から呼ぶ束（`dist/core-bundle.mjs`。
// `npm run bundle:core` が出す）から借りる。以前はここに「本文フォルダーが
// あればそこ」の古い判定を持っていて、0.94.1 で決め方を1か所へ寄せたあとも
// 取り残された——**空の `本文/` があって原稿が直下にある作品**で、測定台
// だけが0件を返していた（git は空のフォルダーを運ばないので、機械ごとに
// `本文/` の有無が違う）。
//
// 借りる関数は**渡してもらう形**にしてある（`measureNumCtx.mjs` と同じ）。
// 単体テストは本物の `src/core/manuscriptFolderRule.ts` を渡して、MCP の
// 本文一覧と同じ答えになることを突き合わせる。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./mcpClient.mjs";
import { CORE_BUNDLE_PATH } from "./measureNumCtx.mjs";

/** 本文として読むもの（`models/types.ts` の `SUPPORTED_EXTENSIONS`） */
const BODY_EXTENSIONS = [".txt", ".md"];
/** 本文の置き場所（`models/types.ts` の `DEFAULT_MANUSCRIPT_DIR`） */
const MANUSCRIPT_DIR = "本文";
/** 設定の置き場所（`models/types.ts` の `DEFAULT_SETTINGS_DIR`） */
const SETTINGS_DIR = "設定";

/** 借りる関数の源。束が古くなっていないかを見るために要る */
const RULE_SOURCE = path.join(REPO_ROOT, "src", "core", "manuscriptFolderRule.ts");

/**
 * 束から本文の場所の決め方を借りる。
 *
 * **束が無ければ止める。** 古い判定へ黙って戻ると、測ったつもりで
 * 別の話の並びを回すことになる。
 */
export async function loadResolveManuscriptDir() {
  if (!fs.existsSync(CORE_BUNDLE_PATH)) {
    throw new Error(
      `${path.relative(REPO_ROOT, CORE_BUNDLE_PATH)} がありません。` +
        "先に npm run bundle:core を実行してください" +
        "（本文の場所の決め方を、製品の関数から借りています）。"
    );
  }
  const bundledAt = fs.statSync(CORE_BUNDLE_PATH).mtimeMs;
  const sourceAt = fs.statSync(RULE_SOURCE).mtimeMs;
  const loaded = await import(pathToFileURL(CORE_BUNDLE_PATH).href);
  // 束ねる側（`scripts/bundleCore.mjs`）が付ける名前
  const borrowed = loaded.core$manuscriptFolderRule?.resolveManuscriptDirSync;
  if (typeof borrowed !== "function") {
    throw new Error(
      "束に resolveManuscriptDirSync がありません（npm run bundle:core で束ね直してください）。"
    );
  }
  return { resolveManuscriptDirSync: borrowed, stale: sourceAt > bundledAt };
}

/**
 * Node の同期の `fs` で読む手段（`mcp/tools/shared.ts` の `bodyDirOf` と同じ扱い）。
 *
 * 見つからないときだけ「無い」。それ以外の失敗は投げる——読めない事情を
 * 握りつぶして直下へ切り替えない。
 */
const nodeSyncIo = {
  kind(location) {
    try {
      const info = fs.statSync(location);
      return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    } catch (error) {
      if (error && error.code === "ENOENT") return "missing";
      throw error;
    }
  },
  list(location) {
    try {
      return fs
        .readdirSync(location, { withFileTypes: true })
        .map((entry) => [
          entry.name,
          entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        ]);
    } catch {
      return undefined;
    }
  },
};

/**
 * 本文のファイルを並べる（`mcp/tools/shared.ts` の `listBodyFiles` と同じ切り方）。
 *
 * **束へは訊かない。** 訊くには `work.scan` の許可が要り、測る道具以外を
 * 許すことになる——写しを自分で数えれば、許可は測る道具だけで済む。
 *
 * @param resolveManuscriptDirSync 本文の場所の決め方（`loadResolveManuscriptDir` で借りたもの）
 */
export function listBodyFiles(work, resolveManuscriptDirSync) {
  const base = path.resolve(work);
  const dir = resolveManuscriptDirSync(
    {
      root: base,
      manuscript: path.join(base, MANUSCRIPT_DIR),
      settings: path.join(base, SETTINGS_DIR),
    },
    nodeSyncIo
  );
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      BODY_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
    )
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((name) => path.relative(base, path.join(dir, name)));
}
