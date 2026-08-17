/**
 * 作者が「直さない」と決めた語。
 *
 * **方言・口癖・独自の言い回しは、固有名詞の辞書では守れない。**
 * 作者の10作品で誤字脱字を測ったところ（2026-08-17）、設定資料を抽出して
 * 固有名詞113語を渡してもなお、こう指摘してきた。
 *
 * - 「はよ」→「早く」
 * - 「急いどるんやろ？」→「急いでるんやろ？」
 * - 「なんゆうてまんのや？」→「なん言うてまんのや？」
 * - 「あらへんで」→「あらへん」
 *
 * どれも関西弁の台詞で、直せば人物が変わる。**方言は固有名詞ではない**ので
 * 人物・場所・能力の名前をいくら集めても入ってこない。
 *
 * プロンプトには「方言・訛り・キャラクターの口癖を検出しない」と書いてあるが、
 * 守られない。**作者が名指しで守るしかない。**
 *
 * 置き場所は `設定/keep_words.json`。`.aiwriter/`（拡張機能の管理領域）では
 * なく設定資料の側に置くのは、**作者が中身を読んで手で直せるべき**であり、
 * 共同作業者にも渡したい情報だからである（`custom_fields.json` と同じ考え）。
 */

export const KEEP_WORD_SCHEMA_VERSION = 1;

/**
 * 短すぎる語を受け付けない。
 *
 * 1文字（「の」「た」）を登録すると、本文のほとんどが守られてしまい、
 * **本物の誤字まで出なくなる。** 作者は理由に気づけない。
 */
export const MIN_KEEP_WORD_LENGTH = 2;

export interface KeepWord {
  /** 守る語。本文に出てくる形で書く */
  word: string;
  /** なぜ直さないか。作者のためのメモで、AIには渡さない */
  note: string;
  /** いつ足したか（ISO 8601の日付）。作者が後から見直すときの手がかり */
  addedAt: string;
}

export interface KeepWordSet {
  schemaVersion: number;
  words: KeepWord[];
}

export function emptyKeepWordSet(): KeepWordSet {
  return { schemaVersion: KEEP_WORD_SCHEMA_VERSION, words: [] };
}

/** 登録できる語か。理由が分かる形で返す */
export function validateKeepWord(word: string): string | null {
  const body = word.trim();
  if (!body) return "語が空です。";
  if (body.length < MIN_KEEP_WORD_LENGTH) {
    return (
      `「${body}」は短すぎます（${MIN_KEEP_WORD_LENGTH}文字以上）。` +
      "1文字を登録すると本文のほとんどが守られてしまい、本物の誤字も出なくなります。"
    );
  }
  if (body.length > 60) return `「${body.slice(0, 20)}…」は長すぎます。`;
  if (/[\r\n]/u.test(body)) return "改行を含む語は登録できません。";
  return null;
}

/**
 * 作者が手で書いたJSONを読む。
 *
 * **壊れていたら例外を投げる。** 空として扱って上書きすると、
 * 作者が書き足した語がまるごと消える（この作品の決まり）。
 */
export function parseKeepWordSet(raw: unknown): KeepWordSet {
  if (!isRecord(raw)) {
    throw new Error("JSONの形が違います（オブジェクトではありません）。");
  }
  if (!Array.isArray(raw.words)) {
    throw new Error("words が配列ではありません。");
  }

  const words: KeepWord[] = [];
  const seen = new Set<string>();
  for (const entry of raw.words) {
    // **文字列だけの並びも受け付ける。** 作者が手で書くなら
    // ["はよ", "せやな"] と書くほうが自然である
    const word = typeof entry === "string" ? entry : asString(entry, "word");
    const body = word.trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    words.push({
      word: body,
      note: isRecord(entry) ? asString(entry, "note") : "",
      addedAt: isRecord(entry) ? asString(entry, "addedAt") : "",
    });
  }

  return {
    schemaVersion:
      typeof raw.schemaVersion === "number"
        ? raw.schemaVersion
        : KEEP_WORD_SCHEMA_VERSION,
    words,
  };
}

/**
 * その語は守られているか。
 *
 * **含まれていれば守る。** 方言は活用するので（「急いどる」「急いどるんやろ？」）、
 * 完全一致では取りこぼす。固有名詞の保護が完全一致なのとは違う理由である。
 */
export function isKeptWord(target: string, words: KeepWord[]): boolean {
  const body = target.trim();
  if (!body) return false;
  return words.some(
    (entry) =>
      entry.word.length >= MIN_KEEP_WORD_LENGTH && body.includes(entry.word)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
