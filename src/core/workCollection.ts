import * as path from "./paths";
import * as vscode from "vscode";
import { isDirectory, listDirectory, pathExists } from "./fileSystem";
import { parseEpisodeFileName } from "./episodeParser";
import {
  AIWRITER_DIR,
  CONFIG_FILE,
  DEFAULT_MANUSCRIPT_DIR,
  DEFAULT_SETTINGS_DIR,
  type EpisodeKind,
} from "../models/types";

/**
 * 作品集（設計書5.7）。
 *
 * **1つのフォルダーの下に、作品フォルダーを並べた形。** その全体が1つの
 * Gitリポジトリになる。作者はこの形で運用していたが、拡張機能は
 * 「1フォルダー＝1作品」としか見ておらず、取り寄せたリポジトリ全体を
 * 1作品として登録していた（2026-08-21、作者の指摘）。
 *
 * ```
 * HisasNovels/          ← 作品集。ここが1リポジトリ
 * ├─ .git/
 * ├─ いじめられっ子/      ← 作品
 * │  ├─ .aiwriter/config.json
 * │  ├─ 本文/
 * │  └─ 設定/
 * └─ 教科書チート/        ← 作品
 * ```
 *
 * **1リポジトリなので、取り寄せも同期も1回で全作品に効く。** これが
 * 作品ごとにリポジトリを分ける形に対する利点である。
 *
 * 代わりに、**編集部を作品集へ招くことはできない。** GitHubの権限は
 * リポジトリ単位でしかかけられず、招いた時点で全作品が読めてしまう。
 * 編集部へ渡すときは、その作品だけを入れたリポジトリを別に切り出す（5.7.5）。
 */

/** 作品集の中で見つかった、作品らしいフォルダー */
export interface WorkCandidate {
  /** フォルダーの絶対パス */
  folderPath: string;
  /** 既定の作品名（フォルダー名） */
  title: string;
  /**
   * 設定ファイル（`.aiwriter/config.json`）があるか。
   * あれば、この拡張機能で作られた作品だと確実に言える。
   */
  hasConfig: boolean;
  /** すでに登録済みか。登録済みのものは二重に足さない */
  alreadyRegistered: boolean;
}

/** 走査の結果。作品が見つからなかった理由を、呼び出し側が説明できるようにする */
export type CollectionScan =
  | { kind: "collection"; works: WorkCandidate[] }
  /** 指定されたフォルダー自体が作品だった（作品集ではない） */
  | { kind: "single_work" }
  /**
   * 自分も作品に見えるが、**中にも作品が並んでいる。**
   *
   * **機械には決められない。** 作品集の直下に `.aiwriter/config.json` が
   * 残っていることがある（作品集の仕組みができる前に、その全体を1作品として
   * 登録した名残）。実際、作者の `HisasNovels` がこの形だった（2026-08-22）。
   *
   * 以前は「自分が作品なら中を見ない」としていたため、**作品集なのに
   * 1作品と判定され、中の作品を登録する道に入れなかった。**
   */
  | { kind: "work_with_children"; works: WorkCandidate[] }
  /** 中に作品らしいフォルダーが1つも無かった */
  | { kind: "no_works" }
  | { kind: "unreadable"; detail: string };

/**
 * 走査から外すフォルダー。
 *
 * `.git` の中まで潜ると、作品名に見えるフォルダーを拾いかねない。
 * `node_modules` は作品フォルダーにまず現れないが、作者が別の用途で
 * 使っているフォルダーを作品集にしている場合に備える。
 */
const SKIPPED_DIRS = new Set([
  ".git",
  AIWRITER_DIR,
  ".novelai-recovery",
  "node_modules",
  "exports",
]);

/**
 * そのフォルダーが作品かどうか。
 *
 * **設定ファイルがあれば確実。** 無い場合は、本文か設定のフォルダーがあるかで
 * 見当を付ける。作者が手で並べたフォルダーには設定ファイルが無いためである。
 *
 * **本文のフォルダー名は作品ごとに変えられる**（`config.json` の
 * `manuscriptDir`）が、設定ファイルが無いなら既定の名前しかありえない。
 */
export async function looksLikeWork(
  folderPath: string
): Promise<{ isWork: boolean; hasConfig: boolean }> {
  const hasConfig = await pathExists(
    path.join(folderPath, AIWRITER_DIR, CONFIG_FILE)
  );
  if (hasConfig) return { isWork: true, hasConfig: true };

  const hasManuscript = await isDirectory(
    path.join(folderPath, DEFAULT_MANUSCRIPT_DIR)
  );
  const hasSettings = await isDirectory(
    path.join(folderPath, DEFAULT_SETTINGS_DIR)
  );
  if (hasManuscript || hasSettings) return { isWork: true, hasConfig: false };

  // **話数ファイルが直下に並んでいる形もある**（2026-08-22、作者の環境で判明）。
  //
  // 「本文」フォルダを作らず、作品フォルダーへ直に `001.txt` を置く運用である。
  // ここを見ていなかったため、**作品集の中の作品が1つも作品と認識されず**、
  // 作品集まるごとが1作品として登録された（328ファイル・996,040字という、
  // 複数作品の話が混ざった一覧になった）。
  return { isWork: await hasEpisodeFiles(folderPath), hasConfig: false };
}

/**
 * 直下に話数として読めるファイルがあるか。
 *
 * **作品集そのものを作品と誤認しない。** 作品集の直下にも `README.md` や
 * `characters.json` は置かれるが、それらは話数として読めない。
 */
async function hasEpisodeFiles(folderPath: string): Promise<boolean> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(path.toUri(folderPath));
  } catch {
    return false;
  }

  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.File) continue;
    const extension = path.extname(name).toLowerCase();
    if (extension !== ".txt" && extension !== ".md") continue;
    const parsed = parseEpisodeFileName(name);

    // 話数が読めれば本文
    if (parsed.chapterStart !== null) return true;
    // 話数は無くても、種別が読めれば本文（`プロローグ.txt` など）
    //
    // **「本編以外」で通してはいけない。** 読み取れなかったものは `不明` に
    // なるので、`README.md` や `プロンプト雛形.txt` まで本文として数えて
    // しまい、**作品集そのものを作品と誤認する**（テストが捕まえた）
    if (NAMED_KINDS.has(parsed.kind)) return true;
  }
  return false;
}

/** 話数が無くても本文と分かる種別。`不明` と `本編` は含めない */
const NAMED_KINDS = new Set<EpisodeKind>(["プロローグ", "エピローグ", "幕間"]);

/**
 * 作品集の中の作品を探す。
 *
 * **子フォルダーの1階層だけを見る。** 深く潜ると、設定フォルダーの中や
 * 本文の下の章フォルダーまで作品として拾ってしまう。作品集は
 * 「作品を並べただけ」の浅い形にする、という決めごとでもある。
 *
 * @param isRegistered すでに登録済みかを判定する（呼び出し側の登録簿を使う）
 */
export async function scanCollection(
  root: string,
  isRegistered: (folderPath: string) => boolean
): Promise<CollectionScan> {
  // **自分が作品に見えても、中を見る。**
  // 以前はここで打ち切っていたが、作品集の直下に設定ファイルが残っている
  // ことがあり（過去に全体を1作品として登録した名残）、そのせいで
  // 中の作品を登録する道に入れなかった（2026-08-22、作者の環境で判明）
  const self = await looksLikeWork(root);

  let entries: string[];
  try {
    entries = await listDirectory(root);
  } catch (error) {
    // 自分が作品なら、中を読めなくても1作品として扱える
    if (self.isWork) return { kind: "single_work" };
    return {
      kind: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const works: WorkCandidate[] = [];
  for (const name of entries) {
    if (SKIPPED_DIRS.has(name) || name.startsWith(".")) continue;
    const folderPath = path.join(root, name);
    if (!(await isDirectory(folderPath))) continue;

    const judged = await looksLikeWork(folderPath);
    if (!judged.isWork) continue;

    works.push({
      folderPath: path.normalize(folderPath),
      title: name,
      hasConfig: judged.hasConfig,
      alreadyRegistered: isRegistered(path.normalize(folderPath)),
    });
  }

  if (works.length === 0) {
    // 中に作品が無いなら、これまでどおり
    return self.isWork ? { kind: "single_work" } : { kind: "no_works" };
  }

  // 作品名の順に並べる。登録簿の並びと揃えて、見つけやすくする
  works.sort((a, b) => a.title.localeCompare(b.title, "ja"));

  // **どちらとも取れるときは、作者に決めてもらう。**
  // 「機械が判断できることを人に聞かない」が方針だが、ここは
  // 機械には判断できない（両方の性質を持っている）
  return self.isWork
    ? { kind: "work_with_children", works }
    : { kind: "collection", works };
}

/**
 * 走査の結果を、作者に読める言葉にする。
 *
 * **「見つかりませんでした」だけでは次の手が分からない。** どういう形を
 * 探しているのかを添える。
 */
export function describeScan(scan: CollectionScan, root: string): string {
  const name = path.basename(root);
  switch (scan.kind) {
    case "single_work":
      return (
        `「${name}」は作品そのもののようです（本文か設定のフォルダーが直下にあります）。` +
        "作品集として登録するのではなく、「作品を追加」から1作品として登録してください。"
      );
    case "no_works":
      return (
        `「${name}」の中に作品が見つかりませんでした。` +
        "作品集は、作品のフォルダーを並べた形を想定しています" +
        `（それぞれの中に「${DEFAULT_MANUSCRIPT_DIR}」か「${DEFAULT_SETTINGS_DIR}」のフォルダーがある形）。`
      );
    case "unreadable":
      return `「${name}」を読めませんでした: ${scan.detail}`;
    case "collection":
      return `${scan.works.length}件の作品が見つかりました。`;
    case "work_with_children":
      return (
        `「${name}」は作品にも作品集にも見えます` +
        `（設定ファイルがあり、中にも${scan.works.length}件の作品が並んでいます）。`
      );
  }
}
