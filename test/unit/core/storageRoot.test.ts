import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { storageRootFrom, toUri } from "../../src/core/paths";

/**
 * 拡張機能の保管庫（`globalStorageUri`）を、持ち回る文字列にする（設計書5.8）。
 *
 * **同じ `vscode-userdata:` でも、手元とブラウザで扱いが逆になる。**
 *
 * - 手元（拡張機能開発ホスト）：実体は手元のディスクにある。OS のパスへ
 *   倒さないと `mkdir "C:\vscode-userdata:"` で落ち、生成文書がすべて
 *   無題文書になった（2026-09-05）
 * - ブラウザ版：実体は無い。倒すと `\User\globalStorage\…` という無い道に
 *   なり、`No file system handle registered (\User)` で落ちた（2026-09-23）。
 *   URI の文字列のまま持ち回れば動く（`pathUserData.test.ts`）
 *
 * 判定が `scheme` だけを見ていたので、手元の直しがブラウザで逆に効いていた。
 * **テストは Node で動く（`canRunProcesses()` が常に true）** ので、
 * 手元かブラウザかは第2引数で渡して確かめる。
 */

const USER_DATA_PATH = "/User/globalStorage/nonahisa.novel-ai-assistant";

function userData(): vscode.Uri {
  return vscode.Uri.from({ scheme: "vscode-userdata", path: USER_DATA_PATH });
}

describe("保管庫の置き場（storageRootFrom）", () => {
  test("手元の `vscode-userdata:` は OS のパスへ倒す", () => {
    expect(storageRootFrom(userData(), true)).toBe(userData().fsPath);
  });

  test("**ブラウザの `vscode-userdata:` は URI の文字列のまま**", () => {
    expect(storageRootFrom(userData(), false)).toBe(
      `vscode-userdata:${USER_DATA_PATH}`
    );
  });

  test("`file:` はどちらでも OS のパス", () => {
    const uri = vscode.Uri.file("C:\\Users\\nonah\\globalStorage");
    expect(storageRootFrom(uri, true)).toBe(uri.fsPath);
    expect(storageRootFrom(uri, false)).toBe(uri.fsPath);
  });

  test("`vscode-vfs:` はどちらでも URI の文字列", () => {
    const text = "vscode-vfs://github/nonahisa/mynovel";
    const uri = vscode.Uri.parse(text);
    expect(storageRootFrom(uri, true)).toBe(text);
    expect(storageRootFrom(uri, false)).toBe(text);
  });

  test("ブラウザで得た文字列は、`toUri` で元の `vscode-userdata:` に戻る", () => {
    const back = toUri(storageRootFrom(userData(), false));
    expect(back.scheme).toBe("vscode-userdata");
    expect(back.toString()).toBe(userData().toString());
  });

  test("引数を省くと、いま動いている場所で決まる（Node では手元扱い）", () => {
    expect(storageRootFrom(userData())).toBe(userData().fsPath);
  });
});

/**
 * **写しを戻さない。** 同じ判定が4か所（生成文書・ログ・AIチューニングの
 * 台帳・保管庫の文字列）に写してあり、どれも「ブラウザ版は `vscode-vfs:`
 * などで来る」と思い込んだまま同じ穴を抱えていた。1か所直しても、
 * 残りが別の場所を指す。判定は `core/paths.ts` の `storageRootFrom` だけに置く。
 */
describe("`vscode-userdata` の判定は core/paths.ts だけ", () => {
  test("ほかのソースに `scheme === \"vscode-userdata\"` が無い", () => {
    const srcRoot = nodePath.resolve(__dirname, "../../src");
    const allowed = nodePath.join(srcRoot, "core", "paths.ts");
    const pattern = /scheme\s*===\s*["']vscode-userdata["']/;
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (full === allowed) continue;
        if (pattern.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(nodePath.relative(srcRoot, full).split(nodePath.sep).join("/"));
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});
