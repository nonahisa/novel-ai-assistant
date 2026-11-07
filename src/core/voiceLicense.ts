import { sanitizeFileName } from "./episodeParser";
import { formatDayTime } from "./timestampedFileName";

/**
 * 音声に書き出すときの、声のライセンス・規約（設計書6.42.4）。
 *
 * 作者の答え（2026-11-07 夜）：
 * - 書き出したフォルダーに「クレジットと利用条件.txt」（声ごとの要点）と
 *   「ライセンス/〈モデル名か話者名〉.txt」（全文）を置く
 * - **ライセンス・規約が取れない声、分からない声を使う話は、書き出さずに止める**
 * - ライセンスの判別は**全文の見出し**で行う。知っているもの（ACML 1.0・ACML-NC 1.0・
 *   CC BY 系）だけ。知らない文は「分からない」
 * - VOICEVOX は `policy` が取れればキャラクターの規約として扱い、クレジット
 *   「VOICEVOX:〈キャラ名〉」を必ず書く
 * - 非商用の声が混じるときは、書き出す前に確かめ、注意書きの先頭に書く
 *
 * ## ここは vscode に触らない
 *
 * エンジンの答えを読むことと、文を組むことだけ。問い合わせは `VoiceEngineClient`。
 *
 * ## 要点は推し量らない
 *
 * 要点はこの表に書いたもの（作者が読んで確かめた ACML 1.0 の要点など）だけを出す。
 * 表に無いライセンスの要点を AI やコードで作らない——外れていても作者には分からない。
 */

/** どのエンジンか（`/engine_manifest` の `brand_name` で決める。口の番号では当てない） */
export type EngineBrand = "aivis" | "voicevox";

export function engineBrandOf(manifest: unknown): { brand: EngineBrand; name: string } | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const brand = (manifest as Record<string, unknown>).brand_name;
  if (typeof brand !== "string") return undefined;
  const name = brand.trim();
  if (name === "AivisSpeech") return { brand: "aivis", name };
  if (name === "VOICEVOX") return { brand: "voicevox", name };
  return undefined;
}

/** 見分けられたライセンス */
export interface KnownLicense {
  id: string;
  /** 全文の見出しの名前 */
  name: string;
  /** 知らせに出す短い名前（「ACML 1.0」） */
  short: string;
  /** 営利の目的で使えるか */
  commercial: boolean;
  /** クレジットの扱い。`see-text` は表に書けるほど確かでない（全文を読む） */
  credit: "required" | "optional" | "see-text";
  /** 要点（作者向けの文） */
  points: readonly string[];
}

const ACML_1_0: Omit<KnownLicense, "name"> = {
  id: "ACML-1.0",
  short: "ACML 1.0",
  commercial: true,
  credit: "optional",
  // 2026-11-07 にリーダーが ACML 1.0 の全文を読んで作者へ示した要点
  points: [
    "営利・非営利とも使えます。",
    "クレジットは任意です。",
    "禁止：話者本人・公式と誤解させる利用、話者の尊厳を傷つける利用、誹謗中傷・虚偽・政治や宗教の運動・反社会的な利用。",
    "誤解されないよう、「※非公式です」の明記などの配慮を求めています。",
  ],
};

const ACML_NC_1_0: Omit<KnownLicense, "name"> = {
  id: "ACML-NC-1.0",
  short: "ACML-NC 1.0",
  commercial: false,
  credit: "see-text",
  points: [
    "非商用のみです（営利の目的では使えません）。",
    "クレジットの要否・禁止事項などは、全文を読んで確かめてください。",
  ],
};

/** 見出しの1行目（`#`・`*`・前後の空白を落とす）。空なら undefined */
function headingOf(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s#*>]+/, "").replace(/[\s*]+$/, "");
    if (line !== "") return line;
  }
  return undefined;
}

/**
 * 全文の見出しからライセンスを見分ける。**見出しで当たらなければ undefined**
 * （本文の途中に名前があっても当てない。「〜に準じます」の独自の規約を ACML と取り違えない）
 */
export function classifyLicense(text: string): KnownLicense | undefined {
  const heading = headingOf(text);
  if (!heading) return undefined;
  if (heading === "Aivis Common Model License (ACML) 1.0") return { ...ACML_1_0, name: heading };
  // 非商用の版は、見出しの名前の言い回しを決め打ちせず、略号と版で見る
  if (/^Aivis Common Model License\b.*\(ACML-NC\) 1\.0$/.test(heading)) {
    return { ...ACML_NC_1_0, name: heading };
  }
  return classifyCreativeCommons(heading);
}

/**
 * クリエイティブ・コモンズの表示（BY）系。全文（legalcode）の見出しは
 * 「Attribution-NonCommercial 4.0 International」の形、短く書けば「CC BY-NC 4.0」
 */
function classifyCreativeCommons(heading: string): KnownLicense | undefined {
  const long =
    /^(?:Creative Commons )?Attribution(-NonCommercial)?(-ShareAlike|-NoDerivatives|-NoDerivs)? (4\.0|3\.0) (?:International|Unported)(?: Public License)?$/i.exec(
      heading
    );
  const short = /^CC BY(-NC)?(-SA|-ND)? (4\.0|3\.0)$/i.exec(heading);
  const match = long ?? short;
  if (!match) return undefined;
  const nc = match[1] !== undefined;
  const variant = match[2]?.toUpperCase();
  const sa = variant === "-SHAREALIKE" || variant === "-SA";
  const nd = variant === "-NODERIVATIVES" || variant === "-NODERIVS" || variant === "-ND";
  const version = match[3];
  const code = `BY${nc ? "-NC" : ""}${sa ? "-SA" : ""}${nd ? "-ND" : ""}`;
  const points = [
    "クレジット（制作者の名前・ライセンスの名前・元の場所）の表示が必要です。",
    ...(nc ? ["非商用のみです（営利の目的では使えません）。"] : ["営利・非営利とも使えます。"]),
    ...(sa ? ["作ったものを配るときは、同じライセンスにする必要があります。"] : []),
    ...(nd ? ["改変したものは配れません。音声への書き出しが改変に当たるかは、全文で確かめてください。"] : []),
  ];
  return {
    id: `CC-${code}-${version}`,
    name: heading,
    short: `CC ${code.replace(/^BY/, "BY")} ${version}`,
    commercial: !nc,
    credit: "required",
    points,
  };
}

/** `/aivm_models` の1つ（使う欄だけ） */
export interface AivmModelInfo {
  name: string;
  creators: string[];
  /** ライセンスの全文。無い・空なら undefined */
  license: string | undefined;
  /** このモデルの話者の uuid（`/speakers` の `speaker_uuid` と同じもの） */
  speakerUuids: string[];
}

/**
 * `/aivm_models` の答え（モデルの uuid → モデルの情報）を読む。**形の崩れたモデルは落とす**。
 * 話者の uuid は `manifest.speakers[].uuid` と、あれば上の段の `speakers[].speaker.speaker_uuid` から集める
 * （2026-11-07 の調べで分かっている欄だけを見る。実物の答えの形で見直すこと）
 */
export function parseAivmModels(json: unknown): AivmModelInfo[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return [];
  const models: AivmModelInfo[] = [];
  for (const value of Object.values(json as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const manifest = record.manifest;
    if (typeof manifest !== "object" || manifest === null) continue;
    const m = manifest as Record<string, unknown>;
    if (typeof m.name !== "string" || m.name.trim() === "") continue;
    const uuids = new Set<string>();
    if (Array.isArray(m.speakers)) {
      for (const speaker of m.speakers) {
        const uuid = (speaker as Record<string, unknown> | null)?.uuid;
        if (typeof uuid === "string") uuids.add(uuid);
      }
    }
    if (Array.isArray(record.speakers)) {
      for (const entry of record.speakers) {
        const speaker = (entry as Record<string, unknown> | null)?.speaker;
        const uuid = (speaker as Record<string, unknown> | null | undefined)?.speaker_uuid;
        if (typeof uuid === "string") uuids.add(uuid);
      }
    }
    models.push({
      name: m.name.trim(),
      creators: Array.isArray(m.creators)
        ? m.creators.filter((c): c is string => typeof c === "string" && c.trim() !== "")
        : [],
      license: typeof m.license === "string" && m.license.trim() !== "" ? m.license : undefined,
      speakerUuids: [...uuids],
    });
  }
  return models;
}

/** `/speaker_info` の `policy`。空なら取れなかった扱い */
export function parsePolicy(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const policy = (json as Record<string, unknown>).policy;
  return typeof policy === "string" && policy.trim() !== "" ? policy : undefined;
}

/** 書き出しに使った声1人ぶんの条件 */
export type VoiceTerms =
  | {
      kind: "aivis";
      speakerUuid: string;
      speakerName: string;
      /** 使ったスタイルの名前 */
      styles: string[];
      modelName: string;
      creators: string[];
      license: KnownLicense;
      licenseText: string;
      /** 話者の規約（`/speaker_info`）。取れなければ無し（判別はモデルのライセンスで行う） */
      policy?: string;
    }
  | {
      kind: "voicevox";
      speakerUuid: string;
      speakerName: string;
      styles: string[];
      /** キャラクター（音声ライブラリ）の規約の全文 */
      policy: string;
    };

/** VOICEVOX の利用規約（ソフトウェアの側。全文はこの場所） */
export const VOICEVOX_TERMS_URL = "https://voicevox.hiroshiba.jp/term/";

/** 作者の答え（2026-11-07 夜）の一文。注意書きと知らせの両方に添える */
export const UNOFFICIAL_NOTE = "※非公式です。話者本人・制作者とは関係ありません。";

/** クレジットの書き方（VOICEVOX の決まり） */
export function voicevoxCredit(speakerName: string): string {
  return `VOICEVOX:${speakerName}`;
}

/** 非商用の声か（判別できた ACML-NC・CC BY-NC だけ。VOICEVOX の規約は読み分けない） */
export function isNonCommercial(terms: VoiceTerms): boolean {
  return terms.kind === "aivis" && !terms.license.commercial;
}

/** 声の短い説明（「花音（花音モデル・ACML-NC 1.0）」） */
export function describeVoice(terms: VoiceTerms): string {
  return terms.kind === "aivis"
    ? `${terms.speakerName}（${terms.modelName}・${terms.license.short}）`
    : `${terms.speakerName}（${voicevoxCredit(terms.speakerName)}）`;
}

/** 全文のファイルの名前（拡張子なし）。AivisSpeech はモデル名、VOICEVOX は話者名 */
export function licenseFileStem(terms: VoiceTerms): string {
  const name = terms.kind === "aivis" ? terms.modelName : terms.speakerName;
  const safe = sanitizeFileName(name);
  return safe === "" ? "名前なし" : safe;
}

/** 全文のファイルの中身。**全文はそのまま**（要約しない） */
export function licenseFileBody(terms: VoiceTerms): string {
  if (terms.kind === "aivis") {
    const parts = [
      `【モデルのライセンス】${terms.modelName}` +
        (terms.creators.length > 0 ? `（制作者：${terms.creators.join("、")}）` : ""),
      "",
      terms.licenseText.trim(),
      "",
    ];
    if (terms.policy) {
      parts.push("----", "", `【話者の規約】${terms.speakerName}`, "", terms.policy.trim(), "");
    }
    return parts.join("\n");
  }
  return [
    `【キャラクターの利用規約】${terms.speakerName}`,
    "",
    terms.policy.trim(),
    "",
    "----",
    "",
    `VOICEVOX の利用規約：${VOICEVOX_TERMS_URL}`,
    "",
  ].join("\n");
}

/** 注意書きの材料 */
export interface CreditNoticeInput {
  workTitle: string;
  episodeName: string;
  /** エンジンの名前（brand_name。「AivisSpeech」「VOICEVOX」） */
  engineName: string;
  at: Date;
  /** 声と、その全文のファイルの場所（注意書きからの相対の道。「ライセンス/まい.txt」） */
  voices: ReadonlyArray<{ terms: VoiceTerms; licenseFile: string }>;
}

/**
 * 「クレジットと利用条件.txt」の中身。
 *
 * **非商用の声が混じれば、いちばん上に書く**（作者の答え5。開いてすぐ目に入る場所）。
 * 要点のあとに「全文を読んでください」を置く——要点は抜き出しで、条件のすべてではない。
 */
export function buildCreditNotice(input: CreditNoticeInput): string {
  const lines: string[] = [];
  const nonCommercial = input.voices.filter(({ terms }) => isNonCommercial(terms));
  if (nonCommercial.length > 0) {
    lines.push("【注意】この音声には、非商用のみの声が含まれています。営利の目的では使えません。");
    for (const { terms } of nonCommercial) lines.push(`  ・${describeVoice(terms)}`);
    lines.push("");
  }
  lines.push(
    "クレジットと利用条件",
    "",
    `作品：${input.workTitle}`,
    `話：${input.episodeName}`,
    `作った日時：${formatDayTime(input.at)}`,
    `音声合成：${input.engineName}（統合小説執筆環境の「人物の声で音声に書き出す」で作りました）`,
    "",
    UNOFFICIAL_NOTE,
    "",
    "■ クレジット"
  );
  for (const { terms } of input.voices) {
    if (terms.kind === "voicevox") {
      lines.push(`  ${voicevoxCredit(terms.speakerName)}`);
      continue;
    }
    const who =
      `  ${terms.speakerName}（${terms.modelName}` +
      (terms.creators.length > 0 ? `／制作者：${terms.creators.join("、")}` : "") +
      "）";
    const note =
      terms.license.credit === "required"
        ? "　※表示が必要"
        : terms.license.credit === "optional"
          ? "　※表示は任意"
          : "　※要否は全文で確かめてください";
    lines.push(who + note);
  }
  lines.push("", "■ 使った声");
  for (const { terms, licenseFile } of input.voices) {
    lines.push("", `◆ ${terms.speakerName}`, `  スタイル：${terms.styles.join("・")}`);
    if (terms.kind === "aivis") {
      lines.push(
        `  モデル名：${terms.modelName}`,
        `  制作者：${terms.creators.length > 0 ? terms.creators.join("、") : "（モデルに書かれていません）"}`,
        `  ライセンス：${terms.license.name}`,
        "  要点：",
        ...terms.license.points.map((point) => `    ・${point}`)
      );
      if (terms.policy) lines.push("  話者の規約もあります（全文のファイルの後ろ）。");
    } else {
      lines.push(
        `  エンジン：VOICEVOX（利用規約 ${VOICEVOX_TERMS_URL}）`,
        "  ライセンス：キャラクター（音声ライブラリ）の利用規約",
        "  要点：",
        `    ・クレジット「${voicevoxCredit(terms.speakerName)}」の表示が必要です。`,
        "    ・VOICEVOX の利用規約では、商用・非商用とも使えます。",
        "    ・キャラクターごとの条件は、全文を読んで確かめてください。"
      );
    }
    lines.push(`  全文：${licenseFile}`);
  }
  lines.push(
    "",
    "■ ご注意",
    "上の要点は、エンジンが返したライセンス・規約から抜き出したものです。条件のすべてではありません。",
    "公開・配布の前に、必ず全文を読んでください。",
    ""
  );
  return lines.join("\n");
}

/** 書き出したときの知らせ（画面の右下）に出す要点。1〜2文 */
export function creditSummary(voices: readonly VoiceTerms[]): string {
  const credits = voices.filter((t) => t.kind === "voicevox").map((t) => voicevoxCredit(t.speakerName));
  const models = voices
    .filter((t): t is Extract<VoiceTerms, { kind: "aivis" }> => t.kind === "aivis")
    .map(
      (t) =>
        `${t.speakerName}（${t.license.short}・` +
        (t.license.credit === "required" ? "クレジット必要" : t.license.credit === "optional" ? "クレジット任意" : "条件は全文で") +
        (t.license.commercial ? "" : "・非商用のみ") +
        "）"
    );
  const parts: string[] = [];
  if (models.length > 0) parts.push(`使った声：${models.join("、")}。`);
  if (credits.length > 0) parts.push(`クレジット「${credits.join("」「")}」を必ず表示してください。`);
  return `${parts.join("")}${UNOFFICIAL_NOTE}`;
}
