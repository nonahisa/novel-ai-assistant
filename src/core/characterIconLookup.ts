import {
  IMAGE_EXTENSIONS,
  MATERIALS_DIR,
  isImageFileName,
  normalizeImagePath,
} from "./epubImagePick";
import { characterIconPath } from "./epubCharacterPage";

/**
 * 人物イラストを素材置き場から名前で引く（作者の指定、2026-09-13
 * 「というか、素材置き場から読んでください」）。
 *
 * ## なぜ要るか
 *
 * 人物イラストは台帳の `icon` 欄だけを見ていたが、**その欄を埋める画面が
 * どこにも無い**——設定資料パネルに項目が無く、抽出も埋めない。改名や
 * 統合では律儀に運ばれるのに、最初に入れる口が無い。そのため実機では
 * 人物紹介の面に載る全員が「イラストが見つからない」になっていた。
 *
 * そこで `素材/` の中から、**ファイル名が人物の名前か別名と一致する画像**
 * を引く。**台帳へは1文字も書き込まない**——引き当ては本を組むたびに
 * 行うので、絵を置いたり名前を変えたりすればそのまま追従する。
 *
 * ## 探す範囲を素材置き場に絞る理由
 *
 * 作品フォルダ全体を見ると、原稿に添えた図・焼いた表紙・取り込んだ資料
 * まで「顔」として拾ってしまう。`素材/` は作者が絵を置くと決めた場所
 * （`epubImagePick.ts` の `MATERIALS_DIR`）なので、そこだけを見る。
 *
 * ここは vscode に触らない（単体テストできる）。素材の一覧を集めるのは
 * `features/materialImages.ts` で、集めた相対パスをここの索引に渡す。
 */

/** 引き当てに使う、人物の呼び名。台帳の型を丸ごと持ち込まない */
export interface CharacterIconNames {
  name: string;
  aliases: readonly string[];
}

/**
 * 名前どうしを突き合わせるときの形。
 *
 * **大文字小文字は区別しない**（`Tina.png` と `tina.png` は同じ絵として
 * 扱う。Windowsのファイル名も同じ扱いである）。
 *
 * **空白は前後だけ落とす。** 名前の中の空白は意味があるので潰さない
 * ——「月島 灯」と「月島灯」を同じ人と決めつけると、別人の絵が付く。
 */
export function iconNameKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 1人ぶんの呼び名を、引き当てに使う順に並べる。
 *
 * **名前が先、別名はその並びのまま。** 名前で見つかる絵があるのに別名の
 * 絵が優先されると、作者から見て理由が分からない。
 */
export function characterIconKeys(character: CharacterIconNames): string[] {
  const keys: string[] = [];
  for (const raw of [character.name, ...character.aliases]) {
    const key = iconNameKey(raw ?? "");
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 素材置き場の画像の一覧から、名前で引ける索引を作る。
 *
 * キーは**拡張子を除いたファイル名**（`iconNameKey` で揃えたもの）で、
 * 値は作品フォルダからの相対パス。同じキーの絵が複数あるときは
 * `compareIconPaths` がいちばん先に来るものを選ぶ。
 *
 * **素材置き場の外は入れない。** 一覧の集め方を変えても、ここが最後の
 * 関所になる。
 */
export function buildCharacterIconIndex(
  relativePaths: readonly string[]
): Map<string, string> {
  const index = new Map<string, string>();

  for (const raw of relativePaths) {
    const relativePath = normalizeImagePath(raw);
    if (!isInsideMaterials(relativePath)) continue;
    if (!isImageFileName(relativePath)) continue;

    const key = iconNameKey(stemOf(relativePath));
    if (!key) continue;

    const current = index.get(key);
    if (current === undefined || compareIconPaths(relativePath, current) < 0) {
      index.set(key, relativePath);
    }
  }

  return index;
}

/**
 * 人物1人の絵を決める。
 *
 * **`icon` 欄が読める場所を指していれば、そちらが勝つ**（手で指した人を
 * 上書きしない）。欄が空、あるいは作品フォルダの外を指していて使えない
 * ときだけ、素材置き場から引く——使えない値のために名前だけにするより、
 * 実際にある絵を出すほうがよい。
 *
 * 見つからなければ null。その人物は名前だけになる（本と同じ振る舞い）。
 */
export function resolveCharacterIconPath(
  character: CharacterIconNames & { icon: string | null },
  index: ReadonlyMap<string, string>
): string | null {
  const declared = characterIconPath(character.icon);
  if (declared) return declared;

  for (const key of characterIconKeys(character)) {
    const found = index.get(key);
    if (found) return found;
  }
  return null;
}

/**
 * 同じ名前の絵が複数あるときの順番。**実行のたびに変わらないこと。**
 *
 * 1. 浅い階層を先に（`素材/月島.png` が `素材/人物/月島.png` より先）
 * 2. `IMAGE_EXTENSIONS` の並び順（拡張子違いは、いつも同じものを選ぶ）
 * 3. 相対パスの順（ここまで来れば必ず1つに決まる）
 *
 * 並べ替えの結果が実行のたびに変わると、**本を作り直すたびに違う絵が
 * 入る**。作者から見れば原因の分からない揺れなので、決め方を残しておく。
 */
export function compareIconPaths(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  if (depth !== 0) return depth;

  const extension = extensionRank(a) - extensionRank(b);
  if (extension !== 0) return extension;

  const byName = a.localeCompare(b, "ja");
  if (byName !== 0) return byName;
  // 並べ方の違いで「同じ」と言われた綴りも、1つに決める
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 通知に名前を並べる上限。全部並べると読めない長さになる */
export const LISTED_MISSING_NAMES = 3;

/**
 * 人物紹介の欄に出す、イラストの状況（作者の指定、2026-09-13）。
 *
 * 前は「うち19人はイラストが見つからないので、名前だけになります。」
 * とだけ出ていた。**どうすれば見つかるのかが書いていない**ので、作者は
 * 何をすればよいか分からない（実際、`icon` 欄を埋める画面が無いため
 * 手の打ちようが無かった）。付いた人数・付かなかった人の名前・置き場を
 * この1文で伝える。
 *
 * **Markdownの記号は混ぜない**（`test/unit/core/plainTextUi.test.ts`）。
 */
export function characterIconNotice(
  total: number,
  missingNames: readonly string[]
): string {
  if (missingNames.length === 0) return "全員にイラストが付きます。";

  const listed = missingNames.slice(0, LISTED_MISSING_NAMES).join("・");
  const rest = missingNames.length - LISTED_MISSING_NAMES;
  const names = rest > 0 ? `${listed}ほか${rest}人` : listed;

  const found = total - missingNames.length;
  const head =
    found > 0
      ? `イラストが付くのは${found}人です。${names}には付かないので、名前だけになります。`
      : `イラストはまだ1人も見つかりません（${names}）。`;

  return `${head}${MATERIALS_DIR}フォルダーに、人物の名前か別名と同じファイル名で画像を置くと付きます。`;
}

/** 素材置き場の中の、まっとうな相対パスか */
function isInsideMaterials(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.length < 2 || segments[0] !== MATERIALS_DIR) return false;
  // 空・`.`・`..` が混ざった綴りは、指し先が読めないので受け取らない
  return !segments.some(
    (segment) => segment === "" || segment === "." || segment === ".."
  );
}

/** 拡張子を除いたファイル名。`.gitkeep` のような点で始まる名前は丸ごと */
function stemOf(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extensionRank(relativePath: string): number {
  const dot = relativePath.lastIndexOf(".");
  const extension = dot >= 0 ? relativePath.slice(dot).toLowerCase() : "";
  const index = (IMAGE_EXTENSIONS as readonly string[]).indexOf(extension);
  // 一覧に無い種類は最後へ（`isImageFileName` で落ちるので通常は来ない）
  return index < 0 ? IMAGE_EXTENSIONS.length : index;
}
