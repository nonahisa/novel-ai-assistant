import type { AiNote } from "../models/aiNote";
import type {
  ExportDocument,
  ExportField,
  ExportRecord,
  ExportSection,
} from "./settingsExportProfiles";

/**
 * 提供先別の設定資料を、1枚の HTML にする（F6、設計書6.75.1）。
 *
 * **中身は Markdown 版と同じ `ExportDocument` から描く。** 出す・出さないの
 * 判断はここには無い（`settingsExportProfiles.ts` の `buildExportDocument`
 * だけが持つ）。形式ごとに判断を書くと、Markdown では伏せた名前が HTML から
 * 漏れる、という穴が開くためである。
 *
 * ## 外から何も読まない
 *
 * スタイルは `<style>` に持ち、フォント・画像・スクリプトを読み込まない。
 * 渡した先がメールの添付で開いても、ネットに繋がっていない機械で開いても
 * 同じ見た目になるようにするため。
 *
 * ## PDF もこの1枚から作る
 *
 * 本文のPDF出力（`exportPdf.ts`）と同じく、PDFは直接作らずブラウザの印刷に
 * 任せる。印刷したときの改ページ（種別ごとに新しい紙）は `@media print` に
 * 書いてあるので、HTML 版とPDF用で中身を分けずに済む。
 *
 * VS Code API に依存しない（単体テストできる）。
 */

/** 本文に入る文字を無害にする。**作者の値は必ずここを通す** */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 改行を残す。紹介文や掘り下げは複数行で書かれていることがある */
function multiline(text: string): string {
  return escapeHtmlText(text).replace(/\r?\n/g, "<br>");
}

export function buildExportHtml(document: ExportDocument): string {
  const header = document.header;
  /*
    目次から飛ぶための id は**連番**にする。名前から作ると、同じ名前の
    人物が2人いる作品（実際にある）で飛び先がぶつかる。
  */
  let recordCount = 0;
  const toc: string[] = [];
  const body: string[] = [];

  document.sections.forEach((section, index) => {
    const sectionId = `s${index + 1}`;
    const entries: string[] = [];
    const rendered = renderSection(section, sectionId, (record) => {
      recordCount += 1;
      const id = `r${recordCount}`;
      entries.push(
        `<li><a href="#${id}">${escapeHtmlText(record.name)}</a></li>`
      );
      return id;
    });
    toc.push(
      `<li><a href="#${sectionId}">${escapeHtmlText(section.title)}</a>` +
        (entries.length > 0 ? `<ol>${entries.join("")}</ol>` : "") +
        "</li>"
    );
    body.push(rendered);
  });

  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtmlText(header.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<header>",
    `<h1>${escapeHtmlText(header.title)}</h1>`,
    fieldTable(header.meta, "meta"),
    "</header>",
    '<nav class="toc">',
    "<h2>目次</h2>",
    `<ol>${toc.join("")}</ol>`,
    "</nav>",
    '<section class="about">',
    "<h2>この資料に含めた項目</h2>",
    header.included.length > 0
      ? fieldTable(header.included, "fields")
      : "<p>（何も含めていません）</p>",
    "<h2>この資料に含めなかった項目</h2>",
    header.excluded.length > 0
      ? fieldTable(header.excluded, "fields")
      : "<p>（落とした項目はありません）</p>",
    ...header.notes.map((note) => `<p class="note">${multiline(note)}</p>`),
    "</section>",
    ...body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderSection(
  section: ExportSection,
  sectionId: string,
  assignId: (record: ExportRecord) => string
): string {
  const parts: string[] = [
    `<section class="kind" id="${sectionId}">`,
    `<h2>${escapeHtmlText(section.title)}</h2>`,
  ];
  const empty =
    section.groups.every((group) => group.records.length === 0) &&
    section.mobs.length === 0;
  if (empty) {
    parts.push(`<p>${escapeHtmlText(section.emptyText)}</p>`, "</section>");
    return parts.join("\n");
  }

  for (const group of section.groups) {
    if (group.title !== null) {
      parts.push(`<h3>${escapeHtmlText(group.title)}</h3>`);
    }
    const level = group.title !== null ? 4 : 3;
    for (const record of group.records) {
      parts.push(renderRecord(record, assignId(record), level));
    }
  }

  if (section.mobs.length > 0) {
    parts.push("<h3>モブ・集団</h3>", "<ul>");
    for (const mob of section.mobs) {
      const suffix = mob.chapters ? `（${escapeHtmlText(mob.chapters)}）` : "";
      parts.push(`<li>${escapeHtmlText(mob.name)}${suffix}</li>`);
    }
    parts.push("</ul>");
  }
  parts.push("</section>");
  return parts.join("\n");
}

function renderRecord(record: ExportRecord, id: string, level: number): string {
  const reading = record.reading
    ? `<span class="reading">（${escapeHtmlText(record.reading)}）</span>`
    : "";
  const parts = [
    `<article id="${id}">`,
    `<h${level}>${escapeHtmlText(record.name)}${reading}</h${level}>`,
  ];
  if (record.lead) parts.push(`<p class="lead">${multiline(record.lead)}</p>`);
  if (record.fields.length > 0) parts.push(fieldTable(record.fields, "fields"));
  if (record.aiNotes.length > 0) parts.push(renderAiNotes(record.aiNotes));
  parts.push("</article>");
  return parts.join("\n");
}

/**
 * 項目の表。左に項目名、右に値。
 *
 * 箇条書きのままでも読めるが、人物が何十人もいると項目名の位置が揃わず
 * 目で追いにくい。表にすると左の列を縦に流し読みできる。
 */
function fieldTable(fields: readonly ExportField[], className: string): string {
  const rows = fields.map(
    (field) =>
      `<tr><th scope="row">${escapeHtmlText(field.label)}</th><td>${multiline(
        field.value
      )}</td></tr>`
  );
  return `<table class="${className}"><tbody>${rows.join("")}</tbody></table>`;
}

/**
 * 掘り下げは引用の体裁にする（Markdown 版の `aiNoteLines` と同じ考え）。
 * 本文から取り出した事実と、AIの解釈を見た目で分けるため。
 */
function renderAiNotes(notes: readonly AiNote[]): string {
  const parts = [
    '<div class="ai-notes">',
    "<p><strong>AIによる掘り下げ</strong>（作者が承認したもの。本文からの解釈を含みます）</p>",
  ];
  for (const note of notes) {
    const label = [note.topic || "全体", note.model].filter((p) => p).join(" / ");
    parts.push(
      "<blockquote>",
      `<p class="ai-label"><em>${escapeHtmlText(label)}</em></p>`,
      `<p>${multiline(note.text)}</p>`,
      "</blockquote>"
    );
  }
  parts.push("</div>");
  return parts.join("\n");
}

/**
 * 見た目。**明るい紙の色に固定する。** 渡した先で印刷されることが多く、
 * 暗い画面の設定に合わせて黒地にすると、そのまま刷ったときにインクを使い切る。
 */
const STYLE = `
:root { color-scheme: light; }
body { margin: 0 auto; max-width: 52em; padding: 24px 16px 64px; background: #ffffff; color: #1f2328;
  font-family: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", serif; line-height: 1.8; }
h1 { font-size: 1.6em; border-bottom: 2px solid #1f2328; padding-bottom: 0.2em; }
h2 { font-size: 1.3em; border-bottom: 1px solid #8c959f; margin-top: 2em; }
h3 { font-size: 1.1em; margin-top: 1.6em; color: #3d444d; }
h4 { font-size: 1.05em; margin: 1.2em 0 0.4em; }
article h3 { color: #1f2328; }
.reading { font-weight: normal; font-size: 0.85em; color: #59636e; margin-left: 0.2em; }
table { border-collapse: collapse; width: 100%; margin: 0.4em 0 0.8em; }
th, td { border: 1px solid #d1d9e0; padding: 0.3em 0.6em; vertical-align: top; text-align: left; }
th { width: 9em; background: #f6f8fa; font-weight: normal; white-space: nowrap; }
table.meta th { width: 7em; }
.lead { margin: 0.2em 0 0.6em; }
.note { color: #3d444d; font-size: 0.95em; }
.ai-notes { margin: 0.6em 0; }
blockquote { margin: 0.4em 0; padding: 0.2em 1em; border-left: 4px solid #d1d9e0; color: #3d444d; }
.ai-label { margin: 0; }
nav.toc ol { padding-left: 1.4em; }
nav.toc ol ol { columns: 2; }
a { color: #0550ae; }
@page { size: A4; margin: 18mm 16mm; }
@media print {
  body { max-width: none; padding: 0; }
  a { color: inherit; text-decoration: none; }
  nav.toc { break-after: page; }
  section.kind { break-before: page; }
  article, tr { break-inside: avoid; }
}
`;
