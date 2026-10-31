import * as pathText from "./pathText";
import { parseEpisodeFileName } from "./episodeParser";
import { isNestedLocation } from "./locationCompare";

/**
 * 編集用リポジトリ（設計書5.7.5）。
 *
 * **書庫へ編集部を招くことはできない。** GitHubの権限はリポジトリ単位で
 * しかかけられないので、招いた時点で全作品が読めてしまう。そこで、渡す作品
 * だけを入れたリポジトリを別に切り出す。
 *
 * ## 一方通行を2本にする
 *
 * - **作者 → 編集部**：本文と設定資料を送り出す（編集部は読むだけ）
 * - **編集部 → 作者**：提案を返す（追記だけ）
 *
 * 書き込む場所が重ならないので、**gitの競合が構造として起きない。**
 *
 * ## 本文と設定はまるごと置き換える
 *
 * 編集部はそこへ書かないので、消えて困るものが無い。差分を考えないぶん、
 * 取り違えも起きない。
 *
 * ## 提案だけは、両方向で混ぜる
 *
 * 提案は編集部が書くが、**承認・却下は作者が書く**（5.6）。見送ったことが
 * 編集部へ伝わらないと、同じ提案が何度も上がってくる。どちらの向きでも
 * 「相手にしか無い行を足す」だけにする。**行は消さない。**
 */

/** 提案ファイルの1行を突き合わせるための鍵 */
function lineKey(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return raw;
    // **鍵の順は書き出す側でばらつく。** 並べ直してから比べないと、
    // 同じ内容の行が別物に見えて二重に積み上がる
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return JSON.stringify(keys.map((key) => [key, record[key]]));
  } catch {
    // 読めない行は、文字列そのものを鍵にする（消さずに残すため）
    return raw;
  }
}

/**
 * 混ぜる前に落とす行か。競合マーカーと空行だけを落とす。
 * `|||||||` は、gitの設定（`merge.conflictStyle=diff3`）で共通の祖先を
 * 並べるときに出る印である。作者の端末の設定次第で出るので、これも落とす
 */
function isDroppable(line: string): boolean {
  return line === "" || /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/.test(line);
}

export interface MergeResult {
  /** 混ぜたあとの本文。末尾は必ず改行で終える */
  text: string;
  /** 足した行数。0なら書き戻す必要が無い */
  added: number;
}

/**
 * 提案ファイル（JSONL）を混ぜる。
 *
 * **`target` の行はそのままの順で残し、`source` にしか無い行を後ろへ足す。**
 * 追記だけなので、どちらを先に混ぜても中身は同じになる。
 *
 * 競合マーカーの行は落とす。gitが解決しきれなかった痕跡を持ち込むと、
 * 読み込み側（`parseProposalLines`）で毎回捨てることになる。
 * **印の行だけを落とし、印に挟まれた両側の行は残す**ので、印つきのまま
 * 記録されてしまった追記型の記録を `mergeProposalJsonl(text, "")` で
 * 片づけることもできる（`features/resolveDivergence.ts`）。
 */
export function mergeProposalJsonl(
  target: string,
  source: string
): MergeResult {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const raw of target.split(/\r?\n/)) {
    const line = raw.trim();
    if (isDroppable(line)) continue;
    const key = lineKey(line);
    // 同じ行が既に二重になっていることがある。ここで1つに畳む
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }

  let added = 0;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (isDroppable(line)) continue;
    const key = lineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
    added++;
  }

  return {
    text: kept.length > 0 ? `${kept.join("\n")}\n` : "",
    added,
  };
}

/**
 * 編集用フォルダーの既定の名前。
 *
 * **作品フォルダーの隣に置く前提。** 書庫の中に置くと入れ子のリポジトリに
 * なり、書庫の側へ巻き込まれる。
 */
export function editingFolderName(workTitle: string): string {
  const trimmed = workTitle.trim();
  const safe = trimmed.replace(/[/\\:*?"<>|]/g, "_");
  return `${safe || "作品"}-編集用`;
}

/**
 * 編集用リポジトリへ持っていくもの。
 *
 * **キャッシュとログは持っていかない。** 作り直せるうえに大きく、
 * 端末ごとの事情（モデル名など）が混じる。回復用の退避も同じ。
 *
 * 返すのは作品フォルダーからの相対パス。ファイルはまるごと写す。
 * 提案と鍵の台帳（`.aiwriter/proposals/`・`.aiwriter/locks/`）は写さず、
 * 両側の行を混ぜる（`shareWithEditor.ts` の `copyForEditor`）。
 */
export const SHARED_FILES = [".aiwriter/config.json", ".gitignore"] as const;

/**
 * 直下へ写した原稿の控え（`.aiwriter/` の下の名前）。**編集用フォルダーにだけ置く。**
 *
 * `copyForEditor` が送るたびに必ず書き、`.gitignore` の外なので編集部の取り寄せた
 * 写しにも届く。作者の作品には書かない。そのため MCP サーバーは、これを
 * 「この作品は編集用の写し（編集部の側）である」印として読む（設計書5.6.5・6.87.25）。
 * 2026-10-01 より前に渡した編集用リポジトリには無く、次に送り直したときに置かれる。
 */
export const EDITOR_SHARE_MANIFEST_FILE = "editor-share-manifest.json";

/**
 * 編集部の送り先と相手（`.aiwriter/` の下の名前）。**作者の作品にだけ置く**
 * （`SHARED_FILES` に入れていないので編集用へは写らない）。
 * 上の印と両方あるのはありえない組なので、MCP は「確かめられない」扱いにする。
 */
export const EDITING_SITE_FILE = "editing.json";

/**
 * 送り出すたびに、まるごと置き換えるフォルダー。
 *
 * **編集部はここへ書かない**ので、消して作り直しても失うものが無い。
 * 本文と設定のフォルダー名は作品ごとに変えられるため、名前は呼び出し側が渡す。
 */
export function replacedDirectories(
  manuscriptDir: string,
  settingsDir: string
): string[] {
  // 同じ名前を2回消しにいかない（`manuscriptDir` と `settingsDir` を
  // 同じにしている作品がありうる）
  return [...new Set([manuscriptDir, settingsDir])];
}

/** 編集部用の置き場にまとめるフォルダー名（既定の置き場の下に作る） */
export const EDITING_HOME_FOLDER = "編集部";

/**
 * 編集用フォルダーの置き場を、作者に訊かずに決める（作者の裁定、2026-10-28）。
 *
 * **`<既定の置き場>/編集部/<編集用フォルダー名>`。** 作品フォルダーの隣ではなく
 * 「編集部」の下にまとめるのは、書庫と並べたときに編集用が作品に見えないようにするため。
 *
 * @param suffix 同じ名前が既にあったときの番号（`2` なら `…-編集用-2`）
 */
export function autoEditingDestination(
  homeParent: string,
  workTitle: string,
  suffix?: number
): string {
  const name = editingFolderName(workTitle);
  return pathText.join(
    homeParent,
    EDITING_HOME_FOLDER,
    suffix && suffix > 1 ? `${name}-${suffix}` : name
  );
}

/**
 * 編集部として参加するときの置き場（`<既定の置き場>/編集部/<リポジトリ名>`）。
 * 同じ名前があれば呼ぶ側が止めて理由を出す（上書きしない）。
 */
export function joinEditorDestination(
  homeParent: string,
  repositoryName: string
): string {
  return pathText.join(homeParent, EDITING_HOME_FOLDER, repositoryName);
}

/**
 * 編集用フォルダーごとの順番待ちの鍵。手動の「渡す」・自動の送り返し・取り込み・
 * 連携の解除を**すべて同じ鎖に通す**（同じフォルダーで git と写しが重ならないように）。
 */
export function editingQueueKey(folder: string): string {
  return `editing:${pathText.normalizeForComparison(folder)}`;
}

/**
 * 両方向で混ぜる台帳（作品フォルダーからの相対）。提案・校閲の鍵・編集履歴。
 * 追記だけの JSONL なので、どちらの側の行も消さずに混ぜられる。
 */
export const LEDGER_FILES = [
  ".aiwriter/proposals/proposals.jsonl",
  ".aiwriter/locks/locks.jsonl",
  ".aiwriter/history/edits.jsonl",
] as const;

/**
 * 編集用フォルダーの置き場として使えない場所か。
 *
 * - `insideWork` … どれかの作品の**中**（リポジトリが入れ子になり、書庫の側へ巻き込まれる）
 * - `containsWork` … どれかの作品を**含む**（書庫そのものや、その上の階層。ここを編集用リポジトリに
 *   すると、合わせ直し（`reset --hard`）が書庫に走りうる）
 *
 * 大文字小文字・区切りの違いは `isNestedLocation` が吸収する。
 */
export function editingPlaceProblem(
  destination: string,
  workFolders: readonly string[]
): "insideWork" | "containsWork" | undefined {
  for (const folder of workFolders) {
    if (isNestedLocation(destination, folder)) return "insideWork";
  }
  for (const folder of workFolders) {
    if (isNestedLocation(folder, destination)) return "containsWork";
  }
  return undefined;
}

/** 相対パスの区切りを `/` に揃える（Windows と他の機械で同じ形にする。控え・鍵の突き合わせの鍵） */
export function normalizeRelativeKey(relative: string): string {
  return relative.replace(/\\/g, "/");
}

/**
 * 校閲中の範囲を人の言葉で言う（「第3話〜第5話」）。
 *
 * ファイル名から話数が読めるものはその最小〜最大で言い、読めないものが
 * 混ざるときはファイル名を挙げる（話数を当て推量で言わない）。
 */
export function describeLockRange(files: readonly string[]): string {
  if (files.length === 0) return "（範囲なし）";
  const numbers: number[] = [];
  let allParsed = true;
  for (const file of files) {
    const parsed = parseEpisodeFileName(pathText.basename(normalizeRelativeKey(file)));
    const start = parsed.chapterStart;
    const end = parsed.chapterEnd ?? start;
    if (start === null || end === null) {
      allParsed = false;
      break;
    }
    numbers.push(start, end);
  }
  if (allParsed) {
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    return low === high ? `第${low}話` : `第${low}話〜第${high}話`;
  }
  const names = files.map((file) => pathText.basename(normalizeRelativeKey(file)));
  return names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} ほか`;
}

/**
 * 「渡す」の送り先をどう用意するか。
 *
 * - `reuse`  … この機械に編集用フォルダーがある（pointer の場所）。そこを使う
 * - `clone`  … この機械には無いが、**送り先の URL が同期される場所に覚えてある**
 *              （別の機械で渡した）。2つ目のリポジトリを作らず、そのリポジトリを取り寄せる
 * - `create` … どちらも無い。新しく作る
 */
export function planShareSource(input: {
  pointerFolderExists: boolean;
  rememberedRemoteUrl: string | undefined;
}): "reuse" | "clone" | "create" {
  if (input.pointerFolderExists) return "reuse";
  return input.rememberedRemoteUrl ? "clone" : "create";
}

/** 編集部が書いてよい台帳の置き場（作品フォルダーからの相対） */
export const LEDGER_DIRECTORY = ".aiwriter";

/**
 * 変わったファイルのうち、台帳（`.aiwriter`）の外にあるもの。
 *
 * 「校閲を終えて返す」は台帳だけを送る。**本文に未記録の変更があれば送らずに止める**
 * ために、その有無をここで見る。道は `/` と `\` のどちらで来ても同じに扱う。
 */
export function changesOutsideLedger(changed: readonly string[]): string[] {
  return changed.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    // `.gitignore` は拡張機能が整える作業用の設定で、本文ではない。見逃し、記録にも入れない
    // （編集部の側は本文を書かないので、これで「返す」が止まり続けることになっていた）
    return !(
      normalized === ".gitignore" ||
      normalized === LEDGER_DIRECTORY ||
      normalized.startsWith(`${LEDGER_DIRECTORY}/`)
    );
  });
}

/**
 * 採否を決め終えたとき、編集部へ自動で送り返すか（作者の裁定、2026-10-28）。
 *
 * - その作品に編集用フォルダーの記録（pointer）があること
 * - 未決の提案が 0 件であること（1件でも残っていれば、まだ決め終えていない）
 * - 編集者モードでは何もしない（採否を決めるのは作者である）
 */
export function shouldReturnDecisions(input: {
  hasPointer: boolean;
  pendingCount: number;
  editorMode: boolean;
}): boolean {
  return !input.editorMode && input.hasPointer && input.pendingCount === 0;
}
