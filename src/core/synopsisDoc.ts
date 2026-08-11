/**
 * `設定/synopsis.md`（作品紹介文とキャッチコピー）の組み立てと読み取り。
 *
 * **このファイルは作者が手で直す前提の文書である。** 設定資料集（`characters.md` 等）は
 * 生成のたびに全体を書き直すが、こちらは違う。作者が推敲した紹介文が
 * そのまま投稿サイトへ貼られる。
 *
 * だから生成物は自動で書き込まない。案として見せ、作者が「採用」を選んだ
 * ときだけ書き換える。**紹介文だけを作り直しても、採用済みのキャッチコピーは残す**
 * （その逆も同じ）。片方を作り直すたびにもう片方が消えるのでは使えない。
 */

export interface SynopsisDoc {
  /** 採用済みのキャッチコピー。無ければ null */
  catchphrase: string | null;
  /** 作品紹介文。無ければ空 */
  blurb: string;
}

/** キャッチコピーは引用行に置く。見出しの直後で目に入る */
const CATCHPHRASE_LINE = /^>\s*(.+?)\s*$/;

export function buildSynopsisMarkdown(
  workTitle: string,
  doc: SynopsisDoc
): string {
  const lines = [`# ${workTitle}`, ""];
  if (doc.catchphrase) {
    lines.push(`> ${doc.catchphrase}`, "");
  }
  lines.push(doc.blurb.trim(), "");
  return lines.join("\n");
}

/**
 * 既存の `synopsis.md` から中身を読み取る。
 *
 * **書式が想定と違っても失敗させない。** 作者が自由に書き足した文書なので、
 * 読み取れない部分は「紹介文の一部」として残す。読み取りに失敗して
 * 空を返すと、上書き時に作者の文章が消える。
 */
export function parseSynopsisMarkdown(text: string): SynopsisDoc {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let catchphrase: string | null = null;
  const body: string[] = [];

  for (const line of lines) {
    // 先頭の見出しは作品名なので落とす（組み立て直すときに付け直す）
    if (body.length === 0 && catchphrase === null && /^#\s/.test(line)) {
      continue;
    }
    const quoted = CATCHPHRASE_LINE.exec(line);
    if (quoted && catchphrase === null && body.join("").trim() === "") {
      catchphrase = quoted[1];
      continue;
    }
    body.push(line);
  }

  return { catchphrase, blurb: body.join("\n").trim() };
}
