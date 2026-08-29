import * as vscode from "vscode";
import { atomicWriteFile } from "./atomicWrite";
import * as path from "./paths";
import {
  TIMESTAMPED_NAME_TRIES,
  timestampedFileNameCandidates,
} from "./timestampedFileName";

/**
 * その場で組み立てる読み物を、実ファイルとして置く（設計書6.17.7）。
 *
 * 執筆再開の1枚・使い方・冒頭診断・伏線の一覧・反映待ちの更新などは、
 * もともと**名前だけの無題文書**に中身を入れて見せていた。だが無題文書は
 * 未保存の変更を抱えたまま残るので、VS Code を閉じるときに
 * 「見た覚えのない文書を保存しますか」と聞かれ、開くたびに
 * 「〇〇-2.md」「〇〇-3.md」と名前がずれていった。
 *
 * 実ファイルにすれば、その3つの副作用が丸ごと消える。代わりに
 * **置きっぱなしのファイルが溜まる**ので、書くたびに古いものを消す。
 *
 * ## 消してよいものだけを消す
 *
 * ここが消すのは、**同じ置き場の・同じ種類の・この仕組みが作った名前**の
 * ファイルだけである。生成文書はいつでも作り直せるし Git にも無いので、
 * 消えても失うものが無い。逆に、作者が手で置いたファイルや `exports/`
 * （PDFの印刷用HTML・設定資料の書き出し）は**作者の成果物**なので、
 * この仕組みは一切触らない。
 *
 * 消す条件の判断は `selectFilesToPrune`（純粋関数）に切り出してある。
 * ファイルを消す処理は、間違えたときに取り返しがつかない。
 * **VS Code を動かさずに全ての枝を試せる形にしておく。**
 */

/** 生成文書の置き場の名前。作品の中でも拡張機能の保管庫でも同じ名前を使う */
export const GENERATED_DIR = "generated";

/**
 * 種類・日付・時刻をつなぐ字。
 *
 * **空白ではなく `_`。** 掃除のときに「この種類のもの」を前置き
 * （`<種類>_`）で拾うので、切れ目がはっきりしている必要がある。
 */
const GENERATED_SEPARATOR = "_";

/** 名前が空になったときの代わり。無題文書のときと同じ言葉を使う */
export const FALLBACK_NAME = "無題";

/**
 * 名前に使えない文字。URIの区切りと混ざる。
 *
 * **無題文書の名前（`views/openDocument.ts` の `untitledMarkdownUri`）と
 * 同じ規則を使う。** 生成文書は実ファイルになったが、書けなかったときは
 * 無題文書へ落ちる。2つの規則が別々にあると、片方だけ通る名前が生まれて
 * 「開けるときと開けないときがある」という追いにくい形になる。
 */
const UNUSABLE_IN_NAME = /[\\/:?#]/g;

/** 表示名からファイル名に使える部分だけを取り出す */
export function sanitizeNamePart(displayName: string): string {
  return displayName.replace(UNUSABLE_IN_NAME, "").trim() || FALLBACK_NAME;
}

/**
 * 掃除の加減。**設定にはしない。**
 *
 * 作者が決めることではない（決められても嬉しくない）し、項目が増えるほど
 * 「どれを触ったのか分からない」画面になる。作り直せる読み物なので、
 * 迷ったら消す側へ倒してよい。
 */
export interface GeneratedPrunePolicy {
  /** 新しいものから、これだけは残す */
  keep: number;
  /** これより古いものは、件数に関わらず消す（日数） */
  maxAgeDays: number;
}

export const GENERATED_PRUNE_POLICY: GeneratedPrunePolicy = {
  keep: 20,
  maxAgeDays: 30,
};

/** 掃除の判断に要る、ファイル1つ分の情報 */
export interface GeneratedFileEntry {
  name: string;
  /** 最終更新（エポックからのミリ秒）。`vscode.FileStat.mtime` と同じ形 */
  mtime: number;
}

/** その種類の生成文書だけが持つ前置き */
export function generatedNamePrefix(kind: string): string {
  return `${sanitizeNamePart(kind)}${GENERATED_SEPARATOR}`;
}

/**
 * 前置きのうしろに続く、時刻の形（`2026-08-29_1430(05)(-2).md`）。
 *
 * **前置きだけでは足りない。** `冒頭診断_メモ.md` のように、作者が同じ
 * 言葉で始まる名前を手で置くことがある。前置きと `.md` しか見ていないと、
 * それを掃除が消してしまう（消したら戻せない）。
 *
 * 種類の名前は作者の言葉から作るので、正規表現へ混ぜない——`.` や `(` が
 * 入っていたときに意味が変わる。**うしろの部分だけを見る。**
 * 形は `timestampedFileName.ts` が作るものと揃える。
 */
const GENERATED_STAMP = /^\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2})?(?:-\d+)?\.md$/;

/** この仕組みが作った名前か（同じ種類のものだけを渡す） */
function isGeneratedName(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  return GENERATED_STAMP.test(name.slice(prefix.length));
}

/**
 * 試す順に名前を並べる。
 *
 * 同じ分・同じ秒に2回書き出したときの避け方（分 → 秒 → 連番）は
 * `timestampedFileName.ts` が持っている。**ここへ写さない。**
 */
export function generatedFileNameCandidates(
  kind: string,
  at: Date,
  tries: number = TIMESTAMPED_NAME_TRIES
): string[] {
  return timestampedFileNameCandidates(
    sanitizeNamePart(kind),
    at,
    ".md",
    tries,
    GENERATED_SEPARATOR
  );
}

/** いちばん先に試す名前（`<種類>_<日付>_<時刻>.md`） */
export function generatedFileName(kind: string, at: Date): string {
  return generatedFileNameCandidates(kind, at)[0];
}

/**
 * 生成した読み物を書き出し、その置き場所を返す。
 *
 * **`mode: "create"`（新規作成）だけを使う。** 既存ファイルの上書きは
 * この作品では禁じられている（`atomicWrite.ts`）。名前に時刻が入るので
 * ぶつかること自体まれだが、ぶつかったら次の候補へ譲る。
 *
 * @param directory 置き場（`paths.ts` の場所の文字列。ブラウザ上の作品では
 *   `vscode-vfs://...` になる）
 * @param kind 種類。ファイル名の前置きになる（「執筆再開」「使い方」）
 */
export async function writeGeneratedFile(
  directory: string,
  kind: string,
  content: string,
  at: Date = new Date()
): Promise<string> {
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  for (const name of generatedFileNameCandidates(kind, at)) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      await atomicWriteFile(target, new TextEncoder().encode(content), {
        mode: "create",
      });
      return target;
    }
  }
  throw new Error("生成した文書の保存先の名前を決められませんでした。");
}

/**
 * 消してよいものの名前を、消す順に並べる。
 *
 * **VS Code を動かさずに確かめられる形にしてある。**
 * 「消す」は取り返しがつかないので、判断だけを取り出して全ての枝を試す。
 *
 * @param entries 置き場にあるファイル（種類で絞る前のもの）
 * @param kind 対象の種類。**これ以外の名前には一切触れない**
 * @param now 「古い」を測る基準の時刻
 */
export function selectFilesToPrune(
  entries: readonly GeneratedFileEntry[],
  kind: string,
  policy: GeneratedPrunePolicy,
  now: Date
): string[] {
  const prefix = generatedNamePrefix(kind);
  const mine = entries.filter((entry) => isGeneratedName(entry.name, prefix));

  // 同じ時刻のものが並んだときは、名前の新しい順（名前に時刻が入っている）。
  // **順序が決まらないと、残る20件が実行のたびに入れ替わる**
  const newestFirst = [...mine].sort(
    (left, right) =>
      right.mtime - left.mtime || right.name.localeCompare(left.name)
  );

  const oldestAllowed =
    now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000;

  return newestFirst
    .filter((entry, index) => index >= policy.keep || entry.mtime < oldestAllowed)
    .map((entry) => entry.name);
}

/**
 * 同じ置き場の、同じ種類の古い生成文書を消す。消した件数を返す。
 *
 * **失敗しても投げない。** ここは「読み物を開く」ついでの掃除であり、
 * 片付けに失敗したせいで作者が文書を読めなくなるのは本末転倒である。
 */
export async function pruneGeneratedFiles(
  directory: string,
  kind: string,
  policy: GeneratedPrunePolicy = GENERATED_PRUNE_POLICY,
  now: Date = new Date()
): Promise<number> {
  let listed: [string, vscode.FileType][];
  try {
    listed = await vscode.workspace.fs.readDirectory(path.toUri(directory));
  } catch {
    // 置き場がまだ無い（＝消すものも無い）
    return 0;
  }

  // 種類で先に絞る。**判断そのものは `selectFilesToPrune` が持つ**ので、
  // ここは無駄な `stat` を減らすためだけの下ごしらえである
  const prefix = generatedNamePrefix(kind);
  const entries: GeneratedFileEntry[] = [];
  for (const [name, type] of listed) {
    if (type !== vscode.FileType.File) continue;
    if (!isGeneratedName(name, prefix)) continue;
    try {
      const stat = await vscode.workspace.fs.stat(
        path.toUri(path.join(directory, name))
      );
      entries.push({ name, mtime: stat.mtime });
    } catch {
      // 見られないファイルは、消す判断もできない。触らずに残す
    }
  }

  let removed = 0;
  for (const name of selectFilesToPrune(entries, kind, policy, now)) {
    try {
      await vscode.workspace.fs.delete(path.toUri(path.join(directory, name)));
      removed += 1;
    } catch {
      // 消せなくても困らない。次に書いたときにまた候補へ挙がる
    }
  }
  return removed;
}
