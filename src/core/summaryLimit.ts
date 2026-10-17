/**
 * 一覧に出す短い紹介の長さを、コード側で確かめる。
 *
 * プロンプトで字数を指示しても、モデルは平気で超えてくる。
 * 文字数の制限は必ずコード側で再検証する、というのがこの作品の約束。
 *
 * 超えていたら捨てずに切り詰める。せっかく書かれた紹介を丸ごと落とすより、
 * 途中まででも一覧に出したほうが作者の役に立つ。
 */

/**
 * 一覧に出す紹介の上限。
 *
 * 50字で始めたが、実データで「主人公。転生した超絶美少女で、霊的なものが
 * 見えるようになった。」のような、あと一息で言い切れる紹介が切れていたため
 * 60字にした。
 *
 * 2026-08-26に80字へ広げた（作者の指示）。60字では「何者か」を書くだけで
 * 尽きてしまい、**作中での変化**（第7話から課長、など）を書く余地が無かった。
 * どの変化を紹介へ書くかは `changeSignificance.ts` が関与度で決める。
 *
 * 上限を変えるときは、プロンプト側の指示も必ず合わせること。
 * **プロンプトへ埋め込んでいるので、変えたら `_VERSION` も上げる**
 * （上げないと、古い字数で書かれた応答がキャッシュから返る）。
 */
export const SUMMARY_MAX_CHARS = 80;

export function clampSummary(
  value: string | null | undefined,
  maxChars = SUMMARY_MAX_CHARS
): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const characters = [...text];
  if (characters.length <= maxChars) return text;

  // 途中でぶつ切りにすると読みにくいので、句読点の切れ目まで戻す。
  // 戻しすぎると情報が減るため、上限の6割より前には戻さない
  const head = characters.slice(0, maxChars).join("");
  const floor = Math.floor(maxChars * 0.6);
  for (const mark of ["。", "、", "．", "，"]) {
    const at = head.lastIndexOf(mark);
    if (at >= floor) return head.slice(0, at + 1);
  }
  return head;
}

/**
 * AIへ送るスキーマに書く長さの上限。**字数の上限そのものより広くする**
 * （作者の裁定 2026-10-17。再読込 P-20 2.4、抽出 P-04a 5.11）。
 *
 * Ollama はスキーマの maxLength に届いたところで書くのを止める。上限ちょうどに
 * すると語の途中で切れ（「…語尾が幼」）、文の切れ目まで戻すコードの切り詰め
 * （`clampAtSentenceEnd`）が働く余地が無い。頼みの「◯字以内」は字数の上限のまま
 * 残し、超えた分はコードが切る（CLAUDE.md 規則3：字数はコード側で検証する）。
 */
export function schemaMaxLength(maxChars: number): number {
  return Math.ceil(maxChars * 1.5);
}

/**
 * 上限を超えたら、**文の切れ目（句点・感嘆符・疑問符）**まで戻して切る
 * （作者の裁定 2026-10-17。AIで再読込の口調の案）。
 *
 * `clampSummary` は上限の6割より前の句点を使わず、読点まで戻す。紹介なら
 * 「途中までの情報」に値打ちがあるが、口調の案は「語尾は…と、」で切れると
 * 読めない文が資料に載る（実測：e4b の案「…語尾が幼」）。句点が
 * 1つも無いときだけ、`clampSummary` と同じく読点まで戻す。
 */
export function clampAtSentenceEnd(
  value: string | null | undefined,
  maxChars: number
): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const characters = [...text];
  if (characters.length <= maxChars) return text;

  // **括弧の中の句点・感嘆符は文の切れ目にしない。** 口調の案は台詞を
  // 引く（「おっけー。任せといて！」）ので、そこで切ると括弧が閉じない
  let depth = 0;
  let end = -1;
  let comma = -1;
  // 上限の位置でまだ閉じていない括弧のうち、いちばん外側の開き括弧の位置
  let outerOpen = -1;
  characters.slice(0, maxChars).forEach((char, index) => {
    if (OPENING.has(char)) {
      if (depth === 0) outerOpen = index;
      depth += 1;
    } else if (CLOSING.has(char)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && SENTENCE_ENDS.has(char)) {
      end = index;
    } else if (depth === 0 && COMMAS.has(char)) {
      comma = index;
    }
  });
  if (end > 0) return characters.slice(0, end + 1).join("");
  // 句点が無ければ、括弧の外の読点まで戻し、**その読点を句点に替えて文を閉じる**。
  // 「…など、」で終わると、資料の上で続きが消えたように読める（実測：e4b、台詞を引いた案）
  if (comma > 0) return `${characters.slice(0, comma).join("")}。`;
  // 読点も無く、上限が括弧の中にかかるなら、閉じていない括弧の手前で切る
  // （実測：26b の案が「…台詞は『主よ。」で終わった）
  if (depth > 0 && outerOpen > 0) {
    return `${characters.slice(0, outerOpen).join("").replace(/[、，,\s]+$/u, "")}。`;
  }
  return clampSummary(text, maxChars);
}

const COMMAS = new Set([..."、，,"]);

const OPENING = new Set([..."「『（(【"]);
const CLOSING = new Set([..."」』）)】"]);
const SENTENCE_ENDS = new Set([..."。！？!?"]);
