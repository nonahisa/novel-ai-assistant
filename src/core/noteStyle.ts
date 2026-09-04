import { parseEpisodeFileName } from "./episodeParser";
import type { WorkFormatKey } from "./workFormat";

/**
 * その原稿を note風に見せるか（設計書6.69）。
 *
 * 作者の依頼（2026-09-04）：「SNSタイプの記事のMDは、noteに対応し、
 * 表示が近くなるエディタにしてください」。
 *
 * ## 判定を1か所に置く
 *
 * 見分けが要るのは**組版（編集面）・プレビュー面・切り替えボタンの出し入れ**の
 * 3か所で、どれも同じ「この原稿はSNS記事か」を訊いている。写しを作ると、
 * ボタンは出るのに組版が変わらない、といった食い違いが起きる。
 *
 * ## `.md` だけを対象にする
 *
 * `.txt` は**投稿サイトから持ってきた形をそのまま保つ**決まりで
 * （設計書6.12）、noteへ貼る形でもない。記法の判定
 * （`manuscriptRender.ts` の `notationModeFor`）と足並みを揃えておく
 * ——組む面と記法の解釈がずれると、記法が生のまま出る原稿が生まれる。
 *
 * ## 形式が分からないときは、日付名を印にする
 *
 * 形式の在り処はプロットの `## 形式` ひとつ（`workFormatStore.ts`）で、
 * プロットを書いていない作品では `undefined` が返る。そこで諦めると、
 * **プロットを書かない作者には何も起きない**。SNS記事は投稿日で名付ける
 * （設計書6.4.6）ので、日付名という形そのものを印として使う。
 *
 * **形式が分かっているときは、形式だけで決める。** 小説の作品に
 * 日付名の `.md` が紛れていても、そちらの表示は変えない。
 *
 * VS Code APIに依存しない。
 */
export function isNoteStyleTarget(
  fileName: string,
  format?: WorkFormatKey
): boolean {
  if (!fileName.toLowerCase().endsWith(".md")) return false;
  if (format !== undefined) return format === "sns";
  // 実在しない日付は日付として扱わない（判定は episodeParser が持つ）
  return parseEpisodeFileName(fileName).date !== null;
}
