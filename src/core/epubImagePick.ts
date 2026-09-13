import * as path from "./pathText";
import { timestampedFileNameCandidates } from "./timestampedFileName";
import {
  BOOK_BLOCK_LABELS,
  isBookImageBlock,
  resolveBookBlocks,
  type BookConfig,
} from "../models/book";

/**
 * 画像の投入口と選択画面の、決めごとの部分（設計書6.65.15）。
 *
 * **作者は相対パスを手で打っていた**（「素材/口絵.png」）。表紙・裏表紙・
 * 口絵・扉絵のどれも同じで、打ち間違えると「画像が見つかりません」としか
 * 出ない。そこで2つの入口を足す——ファイルを選んで取り込む道と、作品
 * フォルダに既にある画像から選ぶ道である。
 *
 * ここには **VS Code に触らない部分だけ**を置く（ファイルを開く・写す・
 * 一覧を出すのは `features/epubEditorPanel.ts`）。名前の決まり方と
 * 「中か外か」の判定は、実際にファイルを触らずに確かめたいところである。
 */

/** 受け取る画像の種類。EPUBのリーダーが確実に読める形に絞る */
export const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
] as const;

/**
 * ファイルを選ぶ画面の絞り込み。
 *
 * **`IMAGE_EXTENSIONS` から作る。** 2か所に書くと、片方だけ増やしたときに
 * 「選べるのに受け取らない」種類ができる。
 */
export const IMAGE_DIALOG_FILTERS: Record<string, string[]> = {
  画像: IMAGE_EXTENSIONS.map((ext) => ext.slice(1)),
};

/**
 * 外から取り込んだ画像を写す先。
 *
 * 作者が既に使っている言い方に合わせる（手で打つときの例も
 * 「素材/口絵.png」だった）。
 */
export const MATERIALS_DIR = "素材";

export function isImageFileName(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 選ばれたファイルが作品フォルダの中なら、相対パスにする。外なら null。
 *
 * **区切りは `/` へ揃える。** 設計図（book.json）の側も `/` で持っており
 * （`models/book.ts` の `relativeInsideWork`）、Windowsの `\` のまま
 * 書き込むと、読み込みのたびに書き換わったように見える。
 */
export function workRelativePath(
  workFolder: string,
  picked: string
): string | null {
  const relative = path.relative(workFolder, picked);
  // 空は「作品フォルダそのもの」。ファイルとしては選べないので外扱いでよい
  if (!relative) return null;
  if (path.goesOutside(workFolder, relative)) return null;
  return relative.split("\\").join("/");
}

/**
 * 写し先の名前を決める。**既にある名前は絶対に返さない。**
 *
 * 上書きできない世界なので（CLAUDE.md 実装ルール2）、ぶつかったら
 * `timestampedFileName.ts` の規則で別名にする。時刻を名前に入れるのは、
 * 「口絵(2).png」より**いつ取り込んだかが読める**ためである。
 *
 * @param taken その場所に既にあるファイル名。**大文字小文字を区別せずに**
 *   見る——Windowsでは `口絵.PNG` と `口絵.png` が同じファイルになる
 * @returns 使える名前。候補を使い切ったら null（実際には起きない）
 */
export function pickImportName(
  originalName: string,
  taken: ReadonlySet<string>,
  at: Date
): string | null {
  const lowered = new Set([...taken].map((name) => name.toLowerCase()));
  for (const candidate of importNameCandidates(originalName, at)) {
    if (!lowered.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

/** 試す順に名前を並べる。**先頭は元の名前**（ぶつからなければそのまま） */
export function importNameCandidates(
  originalName: string,
  at: Date
): string[] {
  const name = path.basename(originalName.split("\\").join("/"));
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  // 名前が点だけ・空のときも、拡張子を落とした形で組み立てられるようにする
  const prefix = stem || "画像";
  return [name, ...timestampedFileNameCandidates(prefix, at, extension)];
}

/** 一覧に出す画像1件 */
export interface ImageChoice {
  /** 作品フォルダからの相対パス（`/` 区切り） */
  relativePath: string;
  /** いまどの面で使っているか。使っていなければ空 */
  usedBy: readonly string[];
}

/**
 * 設計図の中で、どの画像がどの面で使われているか。
 *
 * **選ぶ前に分かるようにする。** 同じ絵が表紙と口絵に入っていることは
 * あるし、いま使っている絵をもう一度選んでしまうこともある。
 * 画面へ「いま○○で使っています」と出せば、どちらも気づける。
 */
export function imageUsageLabels(config: BookConfig): Map<string, string[]> {
  const usage = new Map<string, string[]>();

  const add = (raw: string | null | undefined, label: string): void => {
    const key = normalizeImagePath(raw);
    if (!key) return;
    const list = usage.get(key);
    if (!list) {
      usage.set(key, [label]);
      return;
    }
    // 同じ面の名前は重ねない（扉絵が3枚あっても「扉絵」は1つでよい）
    if (!list.includes(label)) list.push(label);
  };

  add(config.coverImagePath, BOOK_BLOCK_LABELS.cover);
  add(config.backCoverImagePath, BOOK_BLOCK_LABELS.backCover);
  // **並びに置いていない面も数える。** 並びから外しただけの口絵にも
  // 絵は付いており、「使っていない」と言うと消してよいものに見える
  for (const block of resolveBookBlocks(config)) {
    if (isBookImageBlock(block)) add(block.imagePath, BOOK_BLOCK_LABELS[block.type]);
  }
  for (const illustration of config.illustrations) {
    add(illustration.imagePath, "挿絵");
  }

  return usage;
}

/** 設計図と一覧で同じ形にして比べる。`\` で書かれた場所も拾えるように */
export function normalizeImagePath(raw: string | null | undefined): string {
  return (raw ?? "").trim().split("\\").join("/");
}

/**
 * 選択画面の1行。
 *
 * **3つを分ける。** 名前だけでは同じ名前の絵を見分けられず、相対パスだけ
 * では長くて読めない。使い道は3段目に置き、無ければ空にする
 * （「使っていません」と書くと、置いただけの絵を叱っているように見える）。
 */
export function imageChoiceItem(choice: ImageChoice): {
  label: string;
  description: string;
  detail: string;
} {
  return {
    label: path.basename(choice.relativePath),
    description: choice.relativePath,
    detail:
      choice.usedBy.length > 0
        ? `いま${choice.usedBy.join("・")}で使っています`
        : "",
  };
}

/**
 * 一覧の並び順。**使っている絵を先に、あとは場所の順に並べる。**
 *
 * 差し替えるときに探すのは「いま使っている絵の隣」であることが多い。
 * 同じ使い道どうしは相対パスで並べ、開くたびに順番が変わらないようにする。
 */
export function sortImageChoices(
  choices: readonly ImageChoice[]
): ImageChoice[] {
  return [...choices].sort((a, b) => {
    const usedA = a.usedBy.length > 0 ? 0 : 1;
    const usedB = b.usedBy.length > 0 ? 0 : 1;
    if (usedA !== usedB) return usedA - usedB;
    return a.relativePath.localeCompare(b.relativePath, "ja");
  });
}
