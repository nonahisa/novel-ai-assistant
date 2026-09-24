import fs from "node:fs";
import nodePath from "node:path";
import {
  WORKS_SNAPSHOT_PATH,
  parseWorksSnapshot,
  type WorksSnapshot,
} from "../../core/worksSnapshot";
import { mcpGlobalStorageRoot } from "../globalStorage";
import { mcpMachineName } from "./windows";

/**
 * 作品の登録簿の写しを読む（MCP の道具 `works.list`。作者の承認、2026-09-24）。
 *
 * **読むだけ。** 登録簿そのもの（VS Code の `globalState`）は外から読めないので、
 * 拡張機能が保管庫へ書いた写し（`core/worksSnapshot.ts`）を返す。
 * **登録簿を書き換える道は無い**——登録・解除は作者が拡張機能の画面でする。
 *
 * **作品の中身は1文字も読まない。** 写しにあるのは作品ID・作品名・場所・
 * 登録日と、場所から割り出した書庫だけ。作品フォルダーを1つも開かないので、
 * 許可（6.87.10）の対象外で、原稿の出方は `none`。
 *
 * **写しの古さを返す。** 写しは起動時と登録簿が変わったときにしか書かれない。
 * 別の窓で登録を変えたのに、その窓が写しを書く前だった、ということがあるので、
 * `writtenAt` と経過分を必ず添える。
 */

export interface WorksListResult {
  /** このサーバーが走っている機械の名前（写しは機械ごとの保管庫にある） */
  machineName: string | null;
  /** 写しを探した場所 */
  storage: string | null;
  /** 写し。無い・読めないときは `null`（理由は `note`） */
  snapshot: WorksSnapshot | null;
  /** 写しを書いてからの経過（分、切り捨て）。読めない時刻は `null` */
  minutesSinceWritten: number | null;
  note: string;
}

const NOTE =
  "登録簿（VS Code の中にある作品の一覧）の写しです。書くのは拡張機能で、起動したときと登録が変わったときだけ書き直します。" +
  "writtenAt が古ければ、そのあとに別の窓で登録が変わっているかもしれません（窓を開き直すと書き直されます）。" +
  "inLibrary は、同じ親フォルダーに登録済みの作品が2つ以上あるときに true（1作品だけの書庫は見分けられません）。" +
  "duplicates が空でなければ、同じ場所が2度登録されています。";

export function worksList(now: Date = new Date()): WorksListResult {
  const root = mcpGlobalStorageRoot();
  const machineName = mcpMachineName();
  if (!root) {
    return {
      machineName,
      storage: null,
      snapshot: null,
      minutesSinceWritten: null,
      note:
        "保管庫の場所が分かりませんでした（束の居場所が読めず、" +
        "NOVELAI_GLOBAL_STORAGE も指定されていません）。" +
        NOTE,
    };
  }

  const file = nodePath.join(root, ...WORKS_SNAPSHOT_PATH);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {
      machineName,
      storage: file,
      snapshot: null,
      minutesSinceWritten: null,
      note:
        "写しがありません（この機械で拡張機能がまだ起動していないか、" +
        "写しを書かない古い版が動いています）。" +
        NOTE,
    };
  }

  const snapshot = parseWorksSnapshot(text);
  if (!snapshot) {
    return {
      machineName,
      storage: file,
      snapshot: null,
      minutesSinceWritten: null,
      note: "写しの形になっていません（直さずに止めました。窓を開き直すと書き直されます）。" + NOTE,
    };
  }

  const at = Date.parse(snapshot.writtenAt);
  return {
    machineName,
    storage: file,
    snapshot,
    // 先の時刻（機械の時計のずれ）は「いま書いた」とみなす（窓の札と同じ）
    minutesSinceWritten: Number.isNaN(at)
      ? null
      : Math.floor(Math.max(0, now.getTime() - at) / 60_000),
    note: NOTE,
  };
}
