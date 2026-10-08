import { strToU8, zipSync, type Zippable } from "fflate";
import type { AiNote } from "../models/aiNote";
import type {
  ExportDocument,
  ExportField,
  ExportRecord,
  ExportSection,
} from "./settingsExportProfiles";

/**
 * 提供先別の設定資料を、Word（.docx）にする（F6、設計書6.75.1）。
 *
 * **新しい依存は足さない。** .docx は「決まった名前の XML を ZIP に詰めた
 * もの」なので、EPUB と同じ fflate（`epubPackage.ts`）で組める。入れる部品は
 * 最小の5つ——`[Content_Types].xml`・`_rels/.rels`・`word/document.xml`・
 * `word/styles.xml`・`word/_rels/document.xml.rels`。
 *
 * **中身は Markdown 版と同じ `ExportDocument` から描く**（判断はここに無い）。
 *
 * ## 見出しは Word の「見出し1〜4」にする
 *
 * 書式名を `heading 1` のように付けておくと、Word のナビゲーション
 * ウィンドウに目次が出て、「目次の挿入」もそのまま使える。読み戻し
 * （`docxToMarkdown.ts`）もこの名前で見出しを見分ける。
 *
 * ## 項目は表にしない
 *
 * HTML 版は表にしたが、Word では「**項目名**：値」の段落にした。受け取った
 * 側が Word で手を入れる（赤字を入れる・書き足す）とき、表の枠は邪魔に
 * なりやすい。
 *
 * VS Code API に依存しない（単体テストできる）。
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * XML 1.0 に入れられない制御文字。タブ・改行以外の C0 制御文字は、
 * 1字でも混ざると Word が「ファイルが壊れています」と言って開かない。
 * **生の制御文字はソースに置かない**（エスケープで書く）。
 */
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(text: string): string {
  return text
    .replace(XML_FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
}

/** 文字の塊。**改行は `<w:br/>` にする**（`w:t` の中の改行は空白に潰れる） */
function run(text: string, style: RunStyle = {}): string {
  const props =
    style.bold || style.italic
      ? `<w:rPr>${style.bold ? "<w:b/>" : ""}${style.italic ? "<w:i/>" : ""}</w:rPr>`
      : "";
  const pieces = text
    .replace(/\r/g, "")
    .split("\n")
    .map((piece) => `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`)
    .join("<w:br/>");
  return `<w:r>${props}${pieces}</w:r>`;
}

function paragraph(
  runs: readonly string[],
  options: { style?: string; pageBreakBefore?: boolean } = {}
): string {
  const props =
    options.style || options.pageBreakBefore
      ? `<w:pPr>${options.style ? `<w:pStyle w:val="${options.style}"/>` : ""}${
          options.pageBreakBefore ? "<w:pageBreakBefore/>" : ""
        }</w:pPr>`
      : "";
  return `<w:p>${props}${runs.join("")}</w:p>`;
}

function headingParagraph(
  level: number,
  text: string,
  pageBreakBefore = false
): string {
  return paragraph([run(text)], { style: `Heading${level}`, pageBreakBefore });
}

function fieldParagraph(field: ExportField): string {
  return paragraph([run(`${field.label}：`, { bold: true }), run(field.value)]);
}

export function buildExportDocx(document: ExportDocument): Uint8Array {
  const files: Zippable = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(documentXml(document)),
    "word/styles.xml": strToU8(STYLES),
    "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS),
  };
  return zipSync(files);
}

/** 本文の XML。試験で中身を見るために外へ出してある */
export function documentXml(document: ExportDocument): string {
  const header = document.header;
  const body: string[] = [
    headingParagraph(1, header.title),
    ...header.meta.map(fieldParagraph),
    headingParagraph(2, "この資料に含めた項目"),
    ...(header.included.length > 0
      ? header.included.map(fieldParagraph)
      : [paragraph([run("（何も含めていません）")])]),
    headingParagraph(2, "この資料に含めなかった項目"),
    ...(header.excluded.length > 0
      ? header.excluded.map(fieldParagraph)
      : [paragraph([run("（落とした項目はありません）")])]),
    ...header.notes.map((note) => paragraph([run(note)])),
  ];
  for (const section of document.sections) body.push(...sectionXml(section));

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    body.join("") +
    // A4縦・余白 2cm。日本の受け取り手が刷るときの既定に合わせる
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>' +
    "</w:sectPr></w:body></w:document>"
  );
}

function sectionXml(section: ExportSection): string[] {
  // 種別ごとに紙を改める。印刷して人物の束・場所の束に分けて渡せるように
  const parts = [headingParagraph(2, section.title, true)];
  const empty =
    section.groups.every((group) => group.records.length === 0) &&
    section.mobs.length === 0;
  if (empty) {
    parts.push(paragraph([run(section.emptyText)]));
    return parts;
  }
  for (const group of section.groups) {
    if (group.title !== null) parts.push(headingParagraph(3, group.title));
    const level = group.title !== null ? 4 : 3;
    for (const record of group.records) parts.push(...recordXml(record, level));
  }
  if (section.mobs.length > 0) {
    parts.push(headingParagraph(3, "モブ・集団"));
    for (const mob of section.mobs) {
      parts.push(
        paragraph([run(`・${mob.name}${mob.chapters ? `（${mob.chapters}）` : ""}`)])
      );
    }
  }
  return parts;
}

function recordXml(record: ExportRecord, level: number): string[] {
  const parts = [
    headingParagraph(
      level,
      `${record.name}${record.reading ? `（${record.reading}）` : ""}`
    ),
  ];
  if (record.lead) parts.push(paragraph([run(record.lead)]));
  parts.push(...record.fields.map(fieldParagraph));
  if (record.aiNotes.length > 0) parts.push(...aiNotesXml(record.aiNotes));
  return parts;
}

/** 掘り下げは引用の書式（字下げ・灰色）にして、本文から取った事実と分ける */
function aiNotesXml(notes: readonly AiNote[]): string[] {
  const parts = [
    paragraph([
      run("AIによる掘り下げ", { bold: true }),
      run("（作者が承認したもの。本文からの解釈を含みます）"),
    ]),
  ];
  for (const note of notes) {
    const label = [note.topic || "全体", note.model].filter((p) => p).join(" / ");
    parts.push(
      paragraph([run(label, { italic: true })], { style: "Quote" }),
      paragraph([run(note.text)], { style: "Quote" })
    );
  }
  return parts;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  "</Types>";

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const DOCUMENT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

/** 見出し1つ分の書式。大きさは半ポイント単位（32＝16pt） */
function headingStyle(level: number, size: number): string {
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>` +
    '<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:spacing w:before="${level <= 2 ? 360 : 240}" w:after="120"/>` +
    `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="游ゴシック" w:eastAsia="游ゴシック" w:hAnsi="游ゴシック"/><w:b/><w:sz w:val="${size}"/></w:rPr>` +
    "</w:style>"
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:styles xmlns:w="${W_NS}">` +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="游明朝" w:eastAsia="游明朝" w:hAnsi="游明朝"/>' +
  '<w:sz w:val="21"/><w:lang w:val="ja-JP" w:eastAsia="ja-JP"/>' +
  "</w:rPr></w:rPrDefault>" +
  '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  "</w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  headingStyle(1, 36) +
  headingStyle(2, 30) +
  headingStyle(3, 26) +
  headingStyle(4, 22) +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:color w:val="555555"/></w:rPr></w:style>' +
  "</w:styles>";
