/**
 * 表記ゆれ検知で作者が選んだ「揃える先」（設計書6.8.9）。
 *
 * **作者の書き癖を IME へ渡すために覚えておく。** 表記ゆれ検知で揃えても、原稿が
 * 書き換わるだけでは決めごとがどこにも残らない。Rittoku IME が第一候補を外した語の
 * 多くは「わかる／分かる」のような書き方の違いで、作者の決めた書き方を作品辞書へ
 * 足せば、IME は次からその書き方で出せる（設計書6.13.7）。
 *
 * 置き場所は `設定/notation_choices.json`（作者の決定 2026-11-21「作品の設定にファイル1つ」）。
 * `keep_words.json` と同じく設定資料の側に置き、GitHub の同期で両方の機械へ届く。
 * 作者が読んで手で直せる。
 */

export const NOTATION_CHOICE_SCHEMA_VERSION = 1;

export interface NotationChoice {
  /** 揃える先の表記（本文に書く形） */
  surface: string;
  /** 読み（ひらがな）。IME の作品辞書の読みの列になる。1つの読みに1件 */
  reading: string;
  /** いつ決めたか（作者の時計の日付） */
  decidedAt: string;
}

export interface NotationChoiceSet {
  schemaVersion: number;
  choices: NotationChoice[];
  /**
   * 読み飛ばした件（形の合わない件・同じ読みの2件目）をそのまま持つ。
   * **書き戻すときに消さない**——作者が手で書いたもので、捨てると次の保存で黙って消える
   * （実装ルール2。2026-11-27 のレビューで見つけた）
   */
  skipped?: unknown[];
}

/** ファイルへ書く中身。使う決めごとのあとに、読み飛ばした件を元の形のまま並べる */
export function notationChoiceFileBody(set: NotationChoiceSet): {
  schemaVersion: number;
  choices: unknown[];
} {
  return {
    schemaVersion: NOTATION_CHOICE_SCHEMA_VERSION,
    choices: [...set.choices, ...(set.skipped ?? [])],
  };
}

export function emptyNotationChoiceSet(): NotationChoiceSet {
  return { schemaVersion: NOTATION_CHOICE_SCHEMA_VERSION, choices: [] };
}

/** 読みとして受け付ける形（ひらがなと長音だけ） */
const READING = /^[ぁ-ゖー]+$/u;

/**
 * 作者が手で書いた JSON を読む。
 *
 * **壊れていたら例外を投げる。** 空として扱って書き足すと、作者が決めた表記が
 * まるごと消える（実装ルール2）。表記か読みの欠けた1件は読み飛ばす（ほかの件は使える）。
 * 同じ読みが2件あれば先のほうを使う。
 */
export function parseNotationChoiceSet(raw: unknown): NotationChoiceSet {
  if (!isRecord(raw)) {
    throw new Error("JSONの形が違います（オブジェクトではありません）。");
  }
  if (!Array.isArray(raw.choices)) {
    throw new Error("choices が配列ではありません。");
  }
  const choices: NotationChoice[] = [];
  const skipped: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of raw.choices) {
    if (!isRecord(entry)) {
      skipped.push(entry);
      continue;
    }
    const surface = asString(entry, "surface");
    const reading = asString(entry, "reading");
    if (!surface || !READING.test(reading) || seen.has(reading)) {
      skipped.push(entry);
      continue;
    }
    seen.add(reading);
    choices.push({ surface, reading, decidedAt: asString(entry, "decidedAt") });
  }
  return {
    schemaVersion:
      typeof raw.schemaVersion === "number"
        ? raw.schemaVersion
        : NOTATION_CHOICE_SCHEMA_VERSION,
    choices,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/**
 * 決めた表記を1件入れる。**同じ読みの前の決めごとは、新しい選択で置き換える**
 * （作者が窓で選び直したので、新しいほうが作者の今の書き方）。
 *
 * @returns 中身が変わったなら新しい一覧、同じなら undefined（書かない）
 */
export function withNotationChoice(
  set: NotationChoiceSet,
  choice: NotationChoice
): NotationChoiceSet | undefined {
  const index = set.choices.findIndex((entry) => entry.reading === choice.reading);
  if (index >= 0 && set.choices[index].surface === choice.surface) return undefined;
  const choices = [...set.choices];
  if (index >= 0) choices[index] = choice;
  else choices.push(choice);
  return { ...set, choices };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
