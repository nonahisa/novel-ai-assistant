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

/**
 * 各話あらすじを載せる見出し。
 *
 * **この行から下は生成物である。** 作品紹介文と各話あらすじを1つの文書に
 * まとめたのは作者の要望（2026-08-14）。ただし真実の在り処は別で、
 * 紹介文はこのファイル自身、各話あらすじは `chapter_synopses.json` にある。
 * 読み取りではこの見出し以降を捨て、書き込みでは毎回JSONから組み立て直す。
 */
export const EPISODE_SECTION_HEADING = "## 各話あらすじ";

export function buildSynopsisMarkdown(
  workTitle: string,
  doc: SynopsisDoc,
  /** 各話あらすじの本文（`synopsisMarkdown.ts` で組み立てたもの）。無ければ載せない */
  episodeSection?: string
): string {
  const lines = [`# ${workTitle}`, ""];
  if (doc.catchphrase) {
    lines.push(`> ${doc.catchphrase}`, "");
  }
  lines.push(doc.blurb.trim(), "");

  if (episodeSection && episodeSection.trim()) {
    lines.push(EPISODE_SECTION_HEADING, "", episodeSection.trim(), "");
  }
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
    // 各話あらすじの見出しから下は生成物なので、紹介文には取り込まない。
    // 取り込むと、書き戻すたびにあらすじが紹介文の中へ二重に積もる
    if (line.trim() === EPISODE_SECTION_HEADING) break;

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
