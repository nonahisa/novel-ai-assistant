/**
 * 語り手の名前が地の文の主語に立つ形（「名前＋は／が／も」）。
 *
 * 人称のよじれを数える `narratorNameSlip.ts` と、推敲の視点の札で
 * 「代名詞の無い場面が三人称の語りか」を見る `proofreadValidation.ts` の
 * 両方が使う。**形を2か所に書かない**——片方だけ直すと、よじれとして拾う
 * 名前と、三人称の語りと見なす名前が黙って食い違う。
 * `narratorNameSlip.ts` は `proofreadValidation.ts` を読み込んでいるので、
 * 逆向きに読み込まずに済むよう、ここ（どこにも依存しない葉）へ置いた。
 *
 * - **前に漢字・片仮名・英数字が付いていれば別の語**（「小相沢は」「千春人が」）
 * - ルビ（「|相沢《あいざわ》は」）はまたいで見る
 * - 「が」の後ろに丘・岡・谷などが続くのは地名（「相沢が丘」）
 * - 「、と」が続くのは、括弧を付けずに言葉を引いた形（「相沢は、と言いかけた」）
 *
 * 1つ目の組が名前の形、3つ目の組が助詞。
 */
export function narratorNameSubjectPattern(forms: readonly string[]): RegExp {
  const names = forms.map(escapeRegExp).join("|");
  return new RegExp(
    "(?<![\\p{Script=Han}\\p{Script=Katakana}ーA-Za-zＡ-Ｚａ-ｚ0-9０-９])" +
      `[|｜]?(${names})(《[^》\\n]*》)?` +
      "(は|が(?![丘岡谷崎浜原森関島池])|も)" +
      "(?![、，]と)",
    "gu"
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
