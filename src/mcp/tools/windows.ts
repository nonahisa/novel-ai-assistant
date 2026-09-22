import fs from "node:fs";
import nodePath from "node:path";
import {
  WINDOW_CARD_DIRECTORY,
  WINDOW_CARD_STALE_AFTER_MS,
  describeWindowCards,
  parseWindowCard,
  type WindowCard,
  type WindowCardView,
} from "../../core/windowCard";
import { mcpGlobalStorageRoot } from "../globalStorage";

/**
 * いまどの窓がどの版で動いているかを返す（MCP の道具 `windows.list`。
 * 作者の依頼、2026-09-22）。
 *
 * **読むだけ。** 拡張機能が保管庫へ書いた「窓の札」（`core/windowCard.ts`）を
 * 並べて返す。札を消すのも直すのも拡張機能の側で、ここは1バイトも書かない
 * ——古い札を片づけたくなっても、**それが本当に閉じた窓の札かは、
 * こちらからは決められない**（眠っていた窓は起きれば打ち直す）。
 *
 * **作品の中身は1文字も読まない。** 札にあるのは版・窓の名前・開いている
 * フォルダーの場所だけなので、作品フォルダーの許可（6.87.10）の対象外で、
 * `mcp.version` と同じ扱いにしてある（`folder` を取らない）。
 *
 * **1枚壊れていても一覧は止めない。** 読めなかった札はファイル名と理由を
 * `unreadable` に添えて返す——黙って落とすと、「窓が1つ足りない」理由が
 * 呼んだ側に分からない。
 */

export interface WindowsListResult {
  /** 札を探した場所。**見つからないときに、どこを見たかを伝えるため** */
  storage: string | null;
  windows: WindowCardView[];
  unreadable: { file: string; reason: string }[];
  note: string;
}

export function windowsList(now: Date = new Date()): WindowsListResult {
  const root = mcpGlobalStorageRoot();
  const staleMinutes = Math.round(WINDOW_CARD_STALE_AFTER_MS / 60_000);
  const note =
    `probablyClosed は、札が ${staleMinutes} 分より長く打ち直されていない窓です` +
    "（閉じたときに札を消し損ねたもの。眠っていた窓は起きれば戻ります）。" +
    "札はこの機械の保管庫にあるので、別の機械の窓は出ません。";

  if (!root) {
    return {
      storage: null,
      windows: [],
      unreadable: [],
      note:
        "保管庫の場所が分かりませんでした（束の居場所が読めず、" +
        "NOVELAI_GLOBAL_STORAGE も指定されていません）。" +
        note,
    };
  }

  const directory = nodePath.join(root, ...WINDOW_CARD_DIRECTORY);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    // まだ1つも札が無い（拡張機能を起動していない・古い版）。失敗にしない
    return {
      storage: directory,
      windows: [],
      unreadable: [],
      note:
        "札が1枚もありません（この機械で拡張機能がまだ起動していないか、" +
        "札を書かない古い版が動いています）。" +
        note,
    };
  }

  const cards: WindowCard[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  for (const name of names.sort()) {
    // 書きかけの一時ファイル（`atomicWriteFile` の `.tmp`）は札ではない
    if (!name.endsWith(".json")) continue;
    let text: string;
    try {
      text = fs.readFileSync(nodePath.join(directory, name), "utf8");
    } catch (error) {
      unreadable.push({
        file: name,
        reason: `読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const card = parseWindowCard(text);
    if (!card) {
      unreadable.push({ file: name, reason: "札の形になっていません" });
      continue;
    }
    cards.push(card);
  }

  return {
    storage: directory,
    windows: describeWindowCards(cards, now),
    unreadable,
    note,
  };
}
