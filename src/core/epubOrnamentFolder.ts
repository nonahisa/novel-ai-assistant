import * as vscode from "vscode";
import * as path from "./paths";
import { listDirectory } from "./fileSystem";
import { readTextFile } from "./textFile";
import { logStep } from "./logger";
import {
  BUILTIN_ORNAMENTS,
  mergeOrnaments,
  sanitizeOrnamentSvg,
  type OrnamentDef,
  type OrnamentSource,
} from "./epubOrnaments";
import { BOOK_DIR } from "../models/book";

/**
 * 外から足す飾りを読む口（設計書6.65.17）。
 *
 * **作品ごと**は `設定/書籍/飾り/*.svg`。`設定/` はGitで同期・復元できる
 * ので、別の端末で開いても同じ本が組める。**全作品共通**は設定
 * `novelai.epub.ornamentFolder` が指すフォルダーで、こちらは端末の中の
 * 置き場所なので `machine` スコープにしてある（宛先や実行ファイルの設定と
 * 同じ理由。6.78）——同期すると、別の端末に無い場所を指したままになる。
 *
 * ## 読めなくても本は組める
 *
 * ブラウザ版では手元のフォルダーを読めないことがある（設計書5.8）。
 * その場合は**組み込みの飾りだけ**になる——飾りが1つ減るより、本が
 * 出ないほうが困る（挿絵・書体と同じ流儀）。
 *
 * ## 1枚の失敗で、ほかの飾りを巻き添えにしない
 *
 * 検査に落ちた飾りは図録へ入れず、**理由を残す**。黙って落とすと、
 * 置いたのに選べない理由が作者に分からない。
 */

/** `設定/書籍/` の下のフォルダー名 */
export const ORNAMENT_DIR = "飾り";

/** 共通の置き場所を指す設定の鍵（`novelai.` から後ろ） */
export const ORNAMENT_FOLDER_SETTING = "epub.ornamentFolder";

/** 取り込めなかった飾り。**理由は画面の注記とログの両方に出す** */
export interface RejectedOrnament {
  /** ファイル名（拡張子なし）。図録に入っていれば id になっていたもの */
  id: string;
  reason: string;
}

export interface OrnamentFolderResult {
  ornaments: OrnamentDef[];
  rejected: RejectedOrnament[];
}

export interface OrnamentCatalogue {
  catalogue: OrnamentDef[];
  rejected: RejectedOrnament[];
  /** 先にある飾りと id がぶつかって、使われなかったもの */
  shadowed: string[];
}

/**
 * 1つのフォルダーから飾りを読む。
 *
 * **フォルダーが無くても叱らない。** 飾りを足していない作品のほうが
 * 多いので、無いことは正常である。
 */
export async function readOrnamentFolder(
  folderPath: string,
  source: OrnamentSource
): Promise<OrnamentFolderResult> {
  let names: string[];
  try {
    names = await listDirectory(folderPath);
  } catch {
    // 無い・読めない（ブラウザ版で手元のフォルダーを指している等）。
    // どちらも「飾りを足していない」と同じに扱う
    return { ornaments: [], rejected: [] };
  }

  const ornaments: OrnamentDef[] = [];
  const rejected: RejectedOrnament[] = [];

  // **並びを端末まかせにしない。** フォルダーの読み取り順は環境で変わり、
  // 選択欄の並びが端末ごとに違うと、作者が飾りを探せない
  for (const name of [...names].sort((a, b) => a.localeCompare(b, "ja"))) {
    if (path.extname(name).toLowerCase() !== ".svg") continue;
    const id = path.basename(name, path.extname(name));

    let text: string;
    try {
      text = (await readTextFile(path.join(folderPath, name))).text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejected.push({ id, reason: `読めませんでした。${message}` });
      continue;
    }

    const checked = sanitizeOrnamentSvg(text);
    if (!checked.ok) {
      rejected.push({ id, reason: checked.reason });
      continue;
    }
    // 呼び名はファイル名そのもの。**画面で「（作品の飾り）」を添える**のは
    // 出どころが分かるようにするためで、id には混ぜない
    ornaments.push({ id, label: id, svg: checked.svg, source });
  }

  return { ornaments, rejected };
}

/**
 * 本1冊ぶんの図録を組む（設計書6.65.17）。
 *
 * 並びは「組み込み → 作品の飾り → 共通フォルダー」で、**id がぶつかったら
 * 先勝ち**（`mergeOrnaments` の説明を参照）。
 *
 * **書き出しとプレビューが同じ関数を通る。** 別々に組むと、画面で選べた
 * 飾りが本に入らない（あるいはその逆）ということが起きる。
 */
export async function collectOrnamentCatalogue(
  settingsDir: string
): Promise<OrnamentCatalogue> {
  const work = await readOrnamentFolder(
    path.join(settingsDir, BOOK_DIR, ORNAMENT_DIR),
    "work"
  );

  const sharedFolder = sharedOrnamentFolder();
  const shared = sharedFolder
    ? await readOrnamentFolder(sharedFolder, "shared")
    : { ornaments: [], rejected: [] };

  const merged = mergeOrnaments(
    BUILTIN_ORNAMENTS,
    work.ornaments,
    shared.ornaments
  );
  const rejected = [...work.rejected, ...shared.rejected];

  for (const item of rejected) {
    logStep(`飾り「${item.id}.svg」は本に入れられません：${item.reason}`);
  }
  for (const id of merged.shadowed) {
    logStep(
      `飾り「${id}.svg」は、同じ名前の飾りが先にあるため使いません` +
        "（組み込みの飾りは上書きできません）。"
    );
  }

  return { catalogue: merged.catalogue, rejected, shadowed: merged.shadowed };
}

/**
 * 全作品共通の置き場所。**空なら指していない。**
 *
 * 相対パスは受け取らない——基点が何なのか（作品か、ワークスペースか）が
 * 決められないので、決められないものを黙って解釈しない。
 */
function sharedOrnamentFolder(): string | null {
  const value = vscode.workspace
    .getConfiguration("novelai")
    .get<string>(ORNAMENT_FOLDER_SETTING, "")
    .trim();
  if (!value) return null;
  if (!path.isAbsolute(value) && !path.isUriString(value)) {
    logStep(
      `設定「novelai.${ORNAMENT_FOLDER_SETTING}」は絶対パスで書いてください（いまは「${value}」）。`
    );
    return null;
  }
  return value;
}
