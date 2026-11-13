import { hashText } from "./hash";

/**
 * 手元の音声合成エンジン（AivisSpeech / VOICEVOX）との口（設計書6.42.3）。
 *
 * どちらも同じ HTTP の口（VOICEVOX 互換API）を持つ：
 *
 * - `GET /speakers` … 話者とスタイルの一覧
 * - `POST /audio_query?text=&speaker=<スタイルID>` … 読み方と調子の下ごしらえ（JSON）
 * - `POST /synthesis?speaker=<スタイルID>` … 下ごしらえの JSON を送ると WAV が返る
 *
 * ## ここは vscode に触らない
 *
 * 一覧の読み取り・調子の足し引き・控えの鍵は、どれも純粋な計算である。
 * HTTP も `fetch` を外から渡せる形にして、テストの中で立てる偽のエンジンへ
 * 向けられるようにする（本物のエンジンはテストでは動かさない）。
 *
 * ## 叩くのは拡張機能の側
 *
 * 原稿エディタの画面（WebView）から `http://127.0.0.1` を叩くと、エンジンが
 * 画面の出どころを許していないので CORS で弾かれる。拡張機能の側で叩き、
 * できた WAV を画面へ渡す。
 */

/** AivisSpeech の既定の口（古い設定 `voiceEngineUrl` の既定でもある）。VOICEVOX は `http://127.0.0.1:50021` */
export const DEFAULT_VOICE_ENGINE_URL = "http://127.0.0.1:10101";

/*
  ── どのエンジンか（0.146.0。設計書6.42.3） ──

  作者の決定（2026-11-08）：［声］で AivisSpeech と VOICEVOX を選べるようにし、のちに
  人物ごとにエンジンを混ぜられるようにする（2段目）。そのため、接続先・話者の一覧の控え・
  合成の控え・声の割り当て・書き出しのクレジットは、どれも**エンジンを鍵に**持つ。
*/

/** 音声合成のエンジン。声の割り当て（voices.json）の印にもこの文字列を書く */
export type VoiceEngineId = "aivisspeech" | "voicevox";

export const VOICE_ENGINE_IDS: readonly VoiceEngineId[] = ["aivisspeech", "voicevox"];

export function isVoiceEngineId(value: unknown): value is VoiceEngineId {
  return value === "aivisspeech" || value === "voicevox";
}

/** 画面と知らせに出す名前 */
export const VOICE_ENGINE_LABEL: Record<VoiceEngineId, string> = {
  aivisspeech: "AivisSpeech",
  voicevox: "VOICEVOX",
};

/** エンジンごとの既定の接続先（どちらも配布元の既定の口） */
export const DEFAULT_ENGINE_URLS: Record<VoiceEngineId, string> = {
  aivisspeech: DEFAULT_VOICE_ENGINE_URL,
  voicevox: "http://127.0.0.1:50021",
};

/** 設定の鍵（`novelai.` を除いた形）。エンジンごとの接続先 */
export const ENGINE_URL_SETTING: Record<VoiceEngineId, string> = {
  aivisspeech: "readAloud.aivisSpeechUrl",
  voicevox: "readAloud.voicevoxUrl",
};

/** 古い設定（0.145 まで。エンジン1つ分の接続先）。消さずに読む */
export const LEGACY_ENGINE_URL_SETTING = "readAloud.voiceEngineUrl";

/**
 * 古い設定の接続先が、どちらのエンジンを指しているか。
 *
 * **口の番号で見る**：50021 なら VOICEVOX、ほかは AivisSpeech。エンジンの名乗り（brand_name）で
 * 見分けたいところだが、作者の答え（2026-11-08）は「動いているかを前もって問い合わせない」で、
 * ［声］の欄の選択（前の版の「人物の声」をどちらにするか）は画面を開いたときに決める必要がある。
 * 番号で当てても、外れたときは新しい設定（`aivisSpeechUrl`・`voicevoxUrl`）を書けば直せる。
 * 書き出しはこれまでどおり名乗りでエンジンを確かめ、選んだ側と違えば止める（`voiceExport.ts`）。
 */
export function legacyEngineOf(url: string): VoiceEngineId {
  try {
    return new URL(url).port === "50021" ? "voicevox" : "aivisspeech";
  } catch {
    return "aivisspeech";
  }
}

/** 設定に**作者が書いた**値（書いていなければ undefined。既定の値はここへ入れない） */
export interface EngineUrlSettings {
  aivisSpeechUrl?: string;
  voicevoxUrl?: string;
  /** 古い設定 `voiceEngineUrl` */
  legacyUrl?: string;
}

/**
 * エンジンごとの接続先を決める（純粋な計算。設定を読むのは features の側）。
 *
 * 1. 新しい設定を書いてあれば、それ（読めない形なら undefined。理由は呼ぶ側が出す）
 * 2. 古い設定を既定と違う値に書き換えてあり、それがこのエンジンを指していれば（`legacyEngineOf`）、古い設定
 * 3. どちらでもなければ、このエンジンの既定
 *
 * `fromLegacy` は、古い設定から読んだか（知らせに出す設定の名前を選ぶため）。
 */
export function resolveEngineUrl(
  engine: VoiceEngineId,
  settings: EngineUrlSettings
): { url: string | undefined; fromLegacy: boolean } {
  const own = engine === "aivisspeech" ? settings.aivisSpeechUrl : settings.voicevoxUrl;
  if (own !== undefined) return { url: normalizeEngineUrl(own), fromLegacy: false };
  const legacy = legacyCustomUrl(settings.legacyUrl);
  if (legacy !== undefined && legacyEngineOf(legacy) === engine) return { url: legacy, fromLegacy: true };
  return { url: DEFAULT_ENGINE_URLS[engine], fromLegacy: false };
}

/** 古い設定が既定と違う値に書き換えてあれば、その値（整えた形） */
function legacyCustomUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const url = normalizeEngineUrl(raw);
  if (url === undefined || url === DEFAULT_VOICE_ENGINE_URL) return undefined;
  return url;
}

/**
 * 前の版で「人物の声」を選んでいた人が、どちらのエンジンで読むか（作者の決定 2026-11-08：
 * 接続先の設定が指している側）。古い設定が既定のままなら AivisSpeech
 */
export function legacyVoiceEngine(settings: EngineUrlSettings): VoiceEngineId {
  const legacy = legacyCustomUrl(settings.legacyUrl);
  return legacy === undefined ? "aivisspeech" : legacyEngineOf(legacy);
}

/** 話者のスタイル1つ（「ノーマル」「上機嫌」など） */
export interface VoiceStyle {
  name: string;
  id: number;
}

/** 話者1人 */
export interface VoiceSpeaker {
  name: string;
  uuid: string;
  styles: VoiceStyle[];
}

/** エンジンとのやり取りの失敗。**原因は決め打ちしない**（実装ルール5） */
export class VoiceEngineError extends Error {
  constructor(
    /**
     * - `unreachable` … 応答が無い（エンジンが動いていない・口が違う・遮られた。どれかは分からない）
     * - `http` … 応答はあったが成功ではない（本文は `detail` に。ログへ残す）
     * - `badResponse` … 成功の応答だが、形が読めない
     * - `aborted` … 中止した
     * - `timeout` … こちらが決めた待てる時間のうちに答えが来なかった（0.147.1）。**エンジンに
     *   届かないのとは分ける**——遅い PC では、エンジンは動いていても声づくりに時間がかかる
     *   （ノートPCの実機確認：8.5秒の音に13.6〜23.3秒）。見分けは文面でなく、自分で切ったかで行う
     */
    readonly kind: "unreachable" | "http" | "badResponse" | "aborted" | "timeout",
    message: string,
    /** ログへ残す詳しいこと（エンジンの返した本文など） */
    readonly detail?: string,
    /** どのエンジンへの頼みだったか（知らせにエンジンの名前を出す。分からなければ無し） */
    readonly engine?: VoiceEngineId
  ) {
    super(message);
  }
}

/**
 * 設定に書かれた口を整える。**http と https 以外は受けない**（`file:` などへ
 * 本文を送らない）。末尾の `/` は落とす。読めなければ undefined
 */
export function normalizeEngineUrl(raw: string | undefined): string | undefined {
  const text = (raw ?? "").trim();
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * 宛先がこの PC の外なら、そのホスト（ポート付き）を返す。この PC なら undefined。
 *
 * **この PC と見なすのは 127.0.0.1・localhost・::1 だけ。** 設定に別のホストを書くと
 * 本文がそこへ送られるので、送る前の確認（`VoiceReadingService`）の分かれ目になる。
 * `localhost.example.com` のような「それらしい名前」は外として扱う（完全一致で見る）。
 */
export function engineHostOutsideThisPc(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // 読めない宛先は送れない（呼び出し側が先に normalizeEngineUrl で落とす）。念のため外扱い
    return baseUrl;
  }
  const name = url.hostname.toLowerCase();
  if (name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1") {
    return undefined;
  }
  return url.host;
}

/**
 * `/speakers` の答えを読む。**形の崩れた話者・スタイルは落とし、残りで続ける**
 * （1人の崩れで一覧ぜんぶを使えなくしない）。
 *
 * スタイルに `type` があり `talk` 以外（歌声の `sing`・`frame_decode` など）は
 * 読み上げに使えないので落とす。`type` が無い古い形は話し声として扱う。
 * 一覧そのものが配列でなければ投げる。
 */
/** 話す声のスタイルの型（これ以外の型〔歌など〕は朗読に使わない） */
const TALK_STYLE_TYPES = new Set(["talk", "streaming_talk"]);

export function parseSpeakers(json: unknown): VoiceSpeaker[] {
  if (!Array.isArray(json)) {
    throw new VoiceEngineError(
      "badResponse",
      "話者の一覧の形が読めません",
      JSON.stringify(json)?.slice(0, 300)
    );
  }
  const speakers: VoiceSpeaker[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !Array.isArray(record.styles)) continue;
    const styles: VoiceStyle[] = [];
    for (const style of record.styles) {
      if (typeof style !== "object" || style === null) continue;
      const s = style as Record<string, unknown>;
      if (typeof s.name !== "string" || typeof s.id !== "number") continue;
      if (!Number.isInteger(s.id)) continue;
      // 話す声だけを使う。**VOICEVOX 0.26 は話す声を "streaming_talk" で返す**（2026-11-08 作者の実機。
      // "talk" だけを受けていたので44人とも外れ、「話者が1人も見つかりませんでした」と出た）。
      // 型が無いもの（古い版・AivisSpeech）は話す声として扱い、歌の声（sing など）は外す
      if (typeof s.type === "string" && !TALK_STYLE_TYPES.has(s.type)) continue;
      styles.push({ name: s.name, id: s.id });
    }
    if (styles.length === 0) continue;
    speakers.push({
      name: record.name,
      uuid: typeof record.speaker_uuid === "string" ? record.speaker_uuid : record.name,
      styles,
    });
  }
  return speakers;
}

/** スタイルIDから話者とスタイルを引く */
export function findStyle(
  speakers: readonly VoiceSpeaker[],
  styleId: number
): { speaker: VoiceSpeaker; style: VoiceStyle } | undefined {
  for (const speaker of speakers) {
    const style = speaker.styles.find((s) => s.id === styleId);
    if (style) return { speaker, style };
  }
  return undefined;
}

/*
  ── 感情 ─────────────────────────────
*/

/**
 * 台詞の感情（設計書6.42.3）。**少数の固定の列挙**にする——AIに自由に書かせると
 * 「切ない」「やや怒り気味」が返り、声の調子へ落とせない。
 */
export const VOICE_EMOTIONS = [
  "平静",
  "喜び",
  "怒り",
  "悲しみ",
  "驚き",
  "恐れ",
  "照れ",
  "ささやき",
  "叫び",
] as const;
export type VoiceEmotion = (typeof VOICE_EMOTIONS)[number];

export const VOICE_INTENSITIES = ["弱", "中", "強"] as const;
export type VoiceIntensity = (typeof VOICE_INTENSITIES)[number];

export function isVoiceEmotion(value: unknown): value is VoiceEmotion {
  return typeof value === "string" && (VOICE_EMOTIONS as readonly string[]).includes(value);
}

export function isVoiceIntensity(value: unknown): value is VoiceIntensity {
  return (
    typeof value === "string" && (VOICE_INTENSITIES as readonly string[]).includes(value)
  );
}

/**
 * 感情に近いスタイルの名前の候補（前から順に探す。名前に**含まれていれば**当たり）。
 *
 * AivisSpeech の話者はスタイルの名前が話者ごとに違う（「上機嫌」「怒り・悲しみ」
 * 「テンション高め」「落ち着き」…）。VOICEVOX も「あまあま」「ツンツン」
 * 「ささやき」「ヒソヒソ」など。ここは**よくある名前の当てずっぽうの表**で、
 * 作者は声の割り当てのファイル（`emotionStyles`）で話者に合わせて上書きできる。
 * 平静は候補を持たない（選んだスタイルのまま）。
 *
 * **英語の名前も候補に入れる**（作者の答え 2026-11-07）。AivisSpeech には「Shout」「Surprise」の
 * ように英語の名前のスタイルを持つ話者がいる。英語は大文字と小文字を区別せずに当てる
 * （`pickStyleForEmotion`）。日本語の候補を先に並べ、英語はそのあとに見る。
 *
 * 悲しみの「せつな」「切な」（0.141.1。作者の答え「足す」）は、AivisSpeech の まお・コハク の
 * 「せつなめ」に当てるため。日本語の候補の最後に置く——「悲しみ」の名のスタイルを持つ話者では、
 * 今までどおりそちらが選ばれる。
 */
/*
 * 0.151.1（作者の答え 2026-11-13「スタイル名を足す」）：作者の VOICEVOX 0.26.1 と AivisSpeech 1.1.0-dev の
 * スタイル名73を感情ごとに振り分け、当たらなかった名前を各感情の日本語の候補の最後に足した
 * （作者の実機で、青山龍星の「かなしみ」に悲しみの台詞が当たらず「喜び」の声のまま読んでいた）。
 * 足した名前：喜び＝わーい・たのしい・うきうき・楽々・明るい・元気・甘々／怒り＝おこ・ツンギレ／
 * 悲しみ＝かなしみ・なみだめ・びえーん・絶望／驚き＝おどろき／恐れ＝びくびく・こわがり・おどおど／
 * 照れ＝人見知り／叫び＝熱血。
 * どの感情にも振らずに残した名前と理由（設計書6.42.3）：
 *   - 声の形・役柄で、感情ではない：人間ver.・ぬいぐるみver.・鬼ver.・クイーン・第二形態・ロリ・ボーイ・
 *     ツクモちゃん・つぼみ・ぶりっ子・セクシー・セクシー／あん子
 *   - 話し方の型：アナウンス・読み聞かせ・実況風
 *   - 落ち着き・だるさの調子（平静に近いが、ノーマルの代わりにはしない）：しっとり・おちつき・のんびり・
 *     シリアス・けだるげ・低血圧・ねむたい・ヘロヘロ・へろへろ
 *   - 感情の種類（9つ）に当てはまるものが無い：つよつよ・覚醒・よわよわ・からかい・呆れ
 *   - 声の距離・重さ（阿井田 茂）：Calm・Far・Heavy・Mid
 *   - ふだんの声（平静の台詞で使う。`NORMAL_STYLE_NAMES`）：ノーマル・ふつう・ふつー
 */
export const EMOTION_STYLE_CANDIDATES: Record<VoiceEmotion, readonly string[]> = {
  平静: [],
  喜び: [
    "上機嫌", "喜び", "楽しい", "嬉しい", "あまあま", "テンション高め",
    "わーい", "たのしい", "うきうき", "楽々", "明るい", "元気", "甘々",
    "Happy", "Joy", "Fun", "Cheerful",
  ],
  怒り: ["怒り", "ツンツン", "不機嫌", "怒", "おこ", "ツンギレ", "Angry", "Anger", "Mad"],
  悲しみ: [
    "悲しみ", "哀しみ", "かなしい", "泣き", "落ち込み", "せつな", "切な",
    "かなしみ", "なみだめ", "びえーん", "絶望",
    "Sad", "Sorrow", "Cry",
  ],
  驚き: ["驚き", "びっくり", "テンション高め", "おどろき", "Surprise", "Surprised", "Amazed"],
  恐れ: ["怯え", "恐怖", "不安", "おびえ", "ヒソヒソ", "びくびく", "こわがり", "おどおど", "Fear", "Scared", "Afraid"],
  照れ: ["照れ", "恥ずかしい", "あまあま", "人見知り", "Shy", "Embarrassed"],
  ささやき: ["ささやき", "囁き", "ヒソヒソ", "内緒話", "Whisper", "Murmur"],
  叫び: ["叫び", "絶叫", "テンション高め", "怒り", "熱血", "Shout", "Scream", "Yell"],
};

/**
 * ふだんの声のスタイルの名前（0.151.1。作者の答え 2026-11-13「平静の台詞は同じ話者の『ノーマル』で読む」）。
 * 作者が台詞の声に「喜び」など感情のあるスタイルを選んでいても、平静の台詞はこの名前のスタイルで読む。
 * **名前は全体で一致したものだけ**（含むで当てると「ノーマル（低め）」のような別の声を拾う）。英語は大文字と小文字を区別しない
 */
export const NORMAL_STYLE_NAMES: readonly string[] = ["ノーマル", "ふつう", "ふつー", "Normal"];

/**
 * 平静の台詞の声を選ぶ。選んだスタイル（`baseStyleId`）の話者に、ふだんの声（`NORMAL_STYLE_NAMES`）が
 * あればその番号、**無ければ選んだスタイルのまま**（話者ごとに声の形が違う後鬼の「人間ver.」のように、
 * ノーマルを持たない話者がいる）。語りの声には使わない（作者が選んだ語りの声を替えない）
 */
export function pickNormalStyle(speakers: readonly VoiceSpeaker[], baseStyleId: number): number {
  const found = findStyle(speakers, baseStyleId);
  if (!found) return baseStyleId;
  const normal = found.speaker.styles.find((s) => isNormalStyleName(s.name));
  return normal ? normal.id : baseStyleId;
}

/** ふだんの声の名前か（`NORMAL_STYLE_NAMES` と全体で一致。前後の空白と英語の大文字小文字は問わない） */
export function isNormalStyleName(name: string): boolean {
  const own = name.trim().toLowerCase();
  return NORMAL_STYLE_NAMES.some((normal) => normal.toLowerCase() === own);
}

/**
 * 感情を表す漢字1字（作者の答え 2026-11-13「スタイルは自動で割り振ってください」）。
 * `EMOTION_STYLE_CANDIDATES` に無い名前でも、名前にこの字があればその感情のスタイルと見る
 * （「涙声」「憤慨」のように、表を作ったあとに出てくる名前を拾うため）。表の名前の**あと**に見る。
 * 名前の推し量りはコードだけで行い、AI には振らせない（結果を確かめる手間に見合わない）
 */
export const EMOTION_STYLE_KANJI: Record<VoiceEmotion, readonly string[]> = {
  平静: [],
  喜び: ["喜", "嬉", "楽", "笑"],
  怒り: ["怒", "憤"],
  悲しみ: ["悲", "哀", "泣", "涙"],
  驚き: ["驚"],
  恐れ: ["怖", "恐", "怯"],
  照れ: ["照", "恥"],
  ささやき: ["囁"],
  叫び: ["叫", "絶叫"],
};

/** 名前に候補のどれかが含まれるか（英語は大文字と小文字を区別しない） */
function nameHasAny(name: string, candidates: readonly string[]): boolean {
  const own = name.toLowerCase();
  return candidates.some((candidate) => candidate !== "" && own.includes(candidate.toLowerCase()));
}

/**
 * スタイルの名前が結びつく感情（作者の答え 2026-11-13）。当てる順は、作者の上書き→表の名前→漢字1字。
 * 感情ごとに `VOICE_EMOTIONS` の順に見るので、「怒り・悲しみ」は怒り、「テンション高め」は喜びになる。
 * **当たらない名前（人間ver.・しっとり・アナウンス など）は `undefined`**＝感情でなく「声の形」として扱い、
 * 平静の台詞でもノーマルへ替えない。ふだんの声（ノーマル）も `undefined`
 */
export function styleEmotionOf(
  name: string,
  overrides: Partial<Record<VoiceEmotion, readonly string[]>> = {}
): VoiceEmotion | undefined {
  if (isNormalStyleName(name)) return undefined;
  const feeling = VOICE_EMOTIONS.filter((emotion) => emotion !== "平静");
  for (const pool of [
    (emotion: VoiceEmotion) => overrides[emotion] ?? [],
    (emotion: VoiceEmotion) => EMOTION_STYLE_CANDIDATES[emotion],
    (emotion: VoiceEmotion) => EMOTION_STYLE_KANJI[emotion],
  ]) {
    const hit = feeling.find((emotion) => nameHasAny(name, pool(emotion)));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * ［声の割り当て］で選ぶ声の名前（作者の答え 2026-11-13）。作者が選ぶのは話者（と声の形）だけで、
 * 感情のスタイルは台詞ごとに自動で選ぶ。なので感情のスタイル・ノーマルは話者名だけ、声の形は
 * 「話者名／スタイル名」。前の版で選んだ「青山龍星／喜び」も話者名だけで出す（ファイルは書き換えない）
 */
export function voiceChoiceName(
  speakerName: string,
  styleName: string,
  overrides: Partial<Record<VoiceEmotion, readonly string[]>> = {}
): string {
  return isNormalStyleName(styleName) || styleEmotionOf(styleName, overrides) !== undefined
    ? speakerName
    : `${speakerName}／${styleName}`;
}

/**
 * ［声の割り当て］の声の行（作者の答え 2026-11-13）。「話者 × 声の形」だけを並べ、感情のスタイルの行は出さない。
 * ノーマルがあれば話者名だけの行（ノーマルのスタイル）、声の形は「話者名／スタイル名」の行。
 * ノーマルも声の形も無い話者（感情のスタイルだけ）は、最初のスタイルを基にした話者名だけの1行
 */
export function voiceChoiceRows(
  speakers: readonly VoiceSpeaker[],
  overrides: Partial<Record<VoiceEmotion, readonly string[]>> = {}
): Array<{ speaker: VoiceSpeaker; style: VoiceStyle; label: string }> {
  return speakers.flatMap((speaker) => {
    const normal = speaker.styles.find((s) => isNormalStyleName(s.name));
    const shapes = speaker.styles.filter(
      (s) => !isNormalStyleName(s.name) && styleEmotionOf(s.name, overrides) === undefined
    );
    const base = normal ?? (shapes.length === 0 ? speaker.styles[0] : undefined);
    return [
      ...(base ? [{ speaker, style: base, label: speaker.name }] : []),
      ...shapes.map((style) => ({ speaker, style, label: `${speaker.name}／${style.name}` })),
    ];
  });
}

/** 声の調子（audio_query の6つの欄へ当てる値） */
export interface VoiceParams {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  /**
   * 緩急（AivisSpeech だけの欄。0〜2・既定1・大きいほど早口で生っぽい抑揚）。**寄せるときだけ持つ**——
   * 持たないときは audio_query の答えの値（エンジンの既定）をそのまま送る。VOICEVOX には送らない（無い欄）
   */
  tempoDynamicsScale?: number;
}

/**
 * 感情ごとの調子の寄せ方（「中」の強さのとき）。
 *
 * - `speed`・`intonation`・`volume` は**倍率の差**（0.1 なら 1.1 倍）
 * - `pitch` は**足す値**（VOICEVOX の pitchScale は 0 が標準で、±0.15 ほどが聞ける幅）
 * - `post` は文の後ろの無音（秒）に足す値
 *
 * 値は耳で決めるもので、作者の Windows で AivisSpeech を鳴らして詰める
 * （実機確認リスト）。ここに置いたのは最初の見当である。
 */
const EMOTION_SHIFT: Record<
  VoiceEmotion,
  { speed: number; pitch: number; intonation: number; volume: number; post: number }
> = {
  平静: { speed: 0, pitch: 0, intonation: 0, volume: 0, post: 0 },
  喜び: { speed: 0.04, pitch: 0.03, intonation: 0.15, volume: 0.03, post: 0 },
  怒り: { speed: 0.06, pitch: -0.01, intonation: 0.25, volume: 0.1, post: 0 },
  悲しみ: { speed: -0.1, pitch: -0.04, intonation: -0.15, volume: -0.08, post: 0.15 },
  驚き: { speed: 0.05, pitch: 0.06, intonation: 0.3, volume: 0.05, post: 0 },
  恐れ: { speed: 0.06, pitch: 0.02, intonation: -0.1, volume: -0.1, post: 0.05 },
  照れ: { speed: -0.05, pitch: 0.03, intonation: 0.05, volume: -0.1, post: 0.05 },
  ささやき: { speed: -0.06, pitch: 0, intonation: -0.2, volume: -0.35, post: 0.05 },
  叫び: { speed: 0.05, pitch: 0.04, intonation: 0.35, volume: 0.25, post: 0 },
};

const INTENSITY_FACTOR: Record<VoiceIntensity, number> = { 弱: 0.5, 中: 1, 強: 1.5 };

/**
 * AivisSpeech で、話者に感情の専用スタイルが無いときの寄せ方（「中」の強さのとき。作者の決定 2026-11-13）。
 *
 * AivisSpeech の intonationScale は「スタイルの感情の強さ」で、**ノーマルのスタイルでは無視される**
 * （エンジンの /openapi.json の説明）。pitchScale は0から動かすと音質が落ち、音量は割れるので上限1。
 * 抑揚・高さ・音量で寄せても怒りや叫びに聞こえなかったため、速さと緩急で寄せる。
 *
 * - `speed` は**倍率の差**で、`EMOTION_SHIFT` の速さの**代わりに**使う（足さない）
 * - `tempo` は緩急の倍率。強さは `1 + (tempo − 1) × INTENSITY_FACTOR` で掛ける
 *
 * 値は最初の見当で、作者の実機で耳で詰める。
 */
const AIVIS_UNSTYLED_SHIFT: Record<VoiceEmotion, { speed: number; tempo: number }> = {
  平静: { speed: 0, tempo: 1 },
  喜び: { speed: 0.06, tempo: 1.2 },
  怒り: { speed: 0.12, tempo: 1.35 },
  悲しみ: { speed: -0.12, tempo: 0.7 },
  驚き: { speed: 0.1, tempo: 1.3 },
  恐れ: { speed: 0.08, tempo: 1.2 },
  照れ: { speed: -0.05, tempo: 0.9 },
  ささやき: { speed: -0.08, tempo: 0.8 },
  叫び: { speed: 0.12, tempo: 1.45 },
};

/**
 * 文の前後の無音（秒）。エンジンの既定（0.1 前後）より短くする——文と文の
 * 間は画面の側で決めて鳴らす（`VOICE_GAP_*`）ので、ここで足すと二重に空く。
 */
export const VOICE_PRE_PHONEME = 0.05;
export const VOICE_POST_PHONEME = 0.05;

/*
  ── 人物ごとの声の調整（作者の頼み 2026-11-13） ─────────────────────────────
*/

/**
 * 人物ごと（語り手・台詞の既定も）の声の調整。`voices.json` の声に任意の欄 `adjust` として残す。
 * 欄の無い声（前の版）は 高さ0・速さ1・抑揚1 と読む。どの欄も任意で、無い欄は標準
 */
export interface VoiceAdjust {
  /** 高さ（pitchScale に足す） */
  pitch?: number;
  /** 速さ（speedScale に掛ける） */
  speed?: number;
  /** 抑揚（intonationScale に掛ける） */
  intonation?: number;
}

/**
 * 選べる段（打ち込まずに選ぶ）。幅は「声の感じを少し変える」ところまで——広げると、
 * 感情の寄せと重なったときに聞き取れない声になる。**読むときもこの幅の外は捨てる**（手で書いた値も）
 */
export const VOICE_ADJUST_STEPS = {
  pitch: [-0.06, -0.03, 0, 0.03, 0.06],
  speed: [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15],
  intonation: [0.8, 0.9, 1, 1.1, 1.2],
} as const satisfies Record<keyof VoiceAdjust, readonly number[]>;

/** 欄ごとの受ける幅（段の両端） */
export const VOICE_ADJUST_RANGE: Record<keyof VoiceAdjust, { min: number; max: number }> = {
  pitch: { min: -0.06, max: 0.06 },
  speed: { min: 0.85, max: 1.15 },
  intonation: { min: 0.8, max: 1.2 },
};

/** 見本の組み合わせ（1回で選べる形）。値は耳で決めるもので、作者の実機で詰める最初の見当 */
export const VOICE_ADJUST_PRESETS: ReadonlyArray<{ name: string; adjust: Required<VoiceAdjust> }> = [
  { name: "老けた声", adjust: { pitch: -0.06, speed: 0.85, intonation: 0.8 } },
];

/**
 * 調整の欄を読む。**壊れた値（数でない・幅の外）はその欄だけ捨てる**（止めない——調整が無くても
 * 声は読める。止めると声の割り当て全体が使えなくなる）。標準の値（0・1）の欄は持たない。
 * 何も残らなければ `undefined`
 */
export function parseVoiceAdjust(raw: unknown): VoiceAdjust | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: VoiceAdjust = {};
  for (const field of ["pitch", "speed", "intonation"] as const) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = VOICE_ADJUST_RANGE[field];
    // 段の値（0.03 など）は小数の誤差を持つので、端だけわずかに緩める
    if (value < min - 1e-9 || value > max + 1e-9) continue;
    if (value === (field === "pitch" ? 0 : 1)) continue;
    out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 調整を欄のそろった形にする（無い欄は標準）。壊れた値は標準として扱う */
export function normalizeVoiceAdjust(adjust: VoiceAdjust | undefined): Required<VoiceAdjust> {
  const valid = parseVoiceAdjust(adjust) ?? {};
  return { pitch: valid.pitch ?? 0, speed: valid.speed ?? 1, intonation: valid.intonation ?? 1 };
}

/** 段の数字の書き方（高さは符号つき。「−0.06」「+0.03」「0」） */
export function formatAdjustValue(field: keyof VoiceAdjust, value: number): string {
  const text = String(round(value));
  if (field !== "pitch" || value === 0) return text;
  return value > 0 ? `+${text}` : `−${String(round(-value))}`;
}

/** 一覧の枠に添える調整の説明（「高さ −0.06・速さ 0.85・抑揚 0.8」）。調整が無ければ空 */
export function describeVoiceAdjust(adjust: VoiceAdjust | undefined): string {
  const valid = parseVoiceAdjust(adjust);
  if (!valid) return "";
  const parts: string[] = [];
  if (valid.pitch !== undefined) parts.push(`高さ ${formatAdjustValue("pitch", valid.pitch)}`);
  if (valid.speed !== undefined) parts.push(`速さ ${formatAdjustValue("speed", valid.speed)}`);
  if (valid.intonation !== undefined) parts.push(`抑揚 ${formatAdjustValue("intonation", valid.intonation)}`);
  return parts.join("・");
}

/**
 * 感情と強さから調子を作る。
 *
 * @param styled 感情に近いスタイルが見つかって、それで読むか。**スタイルが
 *   感情を持っているので、調子の寄せは半分にする**（両方で寄せると大げさになる）
 * @param rate 列の速さ（`readAloudRate`。0.5〜2）。speedScale に掛ける
 * @param adjust 人物ごとの声の調整（作者の頼み 2026-11-13）。高さは足し、速さと抑揚は掛ける。
 *   合わせたあとも同じ幅（speed 0.5〜2・pitch ±0.15・intonation 0〜2）に収める。
 *   **朗読と書き出しの両方がここを通る**ので、どちらの道でも同じ値になり、控えの鍵も揃う
 * @param engine その文を読むエンジン。AivisSpeech で専用のスタイルが無い感情（`styled` が false・平静でない）は、
 *   速さと緩急で寄せる（`AIVIS_UNSTYLED_SHIFT`。作者の決定 2026-11-13）。省けば今までどおり
 */
export function voiceParamsFor(
  emotion: VoiceEmotion,
  intensity: VoiceIntensity,
  styled: boolean,
  rate: number,
  adjust?: VoiceAdjust,
  engine?: VoiceEngineId
): VoiceParams {
  const shift = EMOTION_SHIFT[emotion];
  const k = INTENSITY_FACTOR[intensity] * (styled ? 0.5 : 1);
  const safeRate = Number.isFinite(rate) ? clamp(rate, 0.5, 2) : 1;
  const own = normalizeVoiceAdjust(adjust);
  const aivisUnstyled = engine === "aivisspeech" && !styled && emotion !== "平静";
  const speedShift = aivisUnstyled ? AIVIS_UNSTYLED_SHIFT[emotion].speed : shift.speed;
  return {
    speedScale: round(clamp((1 + speedShift * k) * safeRate * own.speed, 0.5, 2)),
    pitchScale: round(clamp(shift.pitch * k + own.pitch, -0.15, 0.15)),
    intonationScale: round(clamp((1 + shift.intonation * k) * own.intonation, 0, 2)),
    /*
      **音量は上げない。上限は1**（2026-11-07 作者の答え A。実機確認リスト 19行）。エンジン（AivisSpeech）は
      音の山を上限いっぱい（32767）で返すので、上げると波形が振り切れて割れる（測定：1.15倍で65点・
      1.375倍で294点が振り切れ、0.9倍で0点）。強さは抑揚と速さで出す。下げる（ささやき等）は今のまま
    */
    volumeScale: round(clamp(1 + shift.volume * k, 0, 1)),
    prePhonemeLength: VOICE_PRE_PHONEME,
    postPhonemeLength: round(clamp(VOICE_POST_PHONEME + shift.post * k, 0, 1.5)),
    // 寄せないときは欄ごと持たない（undefined を入れると audio_query の答えの既定値を消して送る）
    ...(aivisUnstyled
      ? { tempoDynamicsScale: round(clamp(1 + (AIVIS_UNSTYLED_SHIFT[emotion].tempo - 1) * k, 0, 2)) }
      : {}),
  };
}

/**
 * 選んだ声の話者に専用のスタイルが無い感情（平静は数えない。作者の決定 2026-11-13）。
 * 判定は朗読と同じ `pickStyleForEmotion`（作者の上書き `emotionStyles` も含む）——写しを作ると、
 * 知らせと実際に読む声が食い違う
 */
export function missingEmotionStyles(
  speakers: readonly VoiceSpeaker[],
  baseStyleId: number,
  overrides: Partial<Record<VoiceEmotion, readonly string[]>> = {}
): VoiceEmotion[] {
  return VOICE_EMOTIONS.filter(
    (emotion) => emotion !== "平静" && !pickStyleForEmotion(speakers, baseStyleId, emotion, overrides).styled
  );
}

/**
 * 声を選んだときの知らせ（無い感情が無ければ `undefined`＝何も出さない）。
 * **AivisSpeech は速さと緩急で寄せる**（`AIVIS_UNSTYLED_SHIFT`）ので、「平静に近く聞こえます」と言い切らない
 * ——言い切ると、寄せた音を聞いた作者に「知らせと違う」と映る（担当の報告で気づいた、2026-11-13）
 */
export function missingEmotionStyleNotice(
  speakerName: string,
  missing: readonly VoiceEmotion[],
  engine?: VoiceEngineId
): string | undefined {
  if (missing.length === 0) return undefined;
  const head = `この声（${speakerName}）には${missing.join("・")}の声（スタイル）がありません。`;
  return engine === "aivisspeech"
    ? `${head}その感情は声を替えず、速さと緩急だけで寄せるので、平静に近く聞こえることがあります。`
    : `${head}その感情は平静に近く聞こえます。`;
}

/**
 * 感情に合うスタイルを選ぶ。
 *
 * 選んだスタイル（`baseStyleId`）の話者の中から、感情の候補の名前を含む
 * スタイルを探す。作者の上書き（`overrides`）があれば先にそれを見る。
 * 見つからなければ選んだスタイルのまま（調子だけで寄せる）。
 */
export function pickStyleForEmotion(
  speakers: readonly VoiceSpeaker[],
  baseStyleId: number,
  emotion: VoiceEmotion,
  overrides: Partial<Record<VoiceEmotion, readonly string[]>> = {}
): { styleId: number; styled: boolean } {
  if (emotion === "平静") return { styleId: baseStyleId, styled: false };
  const found = findStyle(speakers, baseStyleId);
  if (!found) return { styleId: baseStyleId, styled: false };
  // 漢字1字の当ては候補の最後（表の名前を持つ話者では、今までどおりそちらが選ばれる）
  const candidates = [
    ...(overrides[emotion] ?? []),
    ...EMOTION_STYLE_CANDIDATES[emotion],
    ...EMOTION_STYLE_KANJI[emotion],
  ];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    // 英語の名前は大文字と小文字を区別しない（「Shout」「SHOUT」「shout」を同じに見る）
    const wanted = candidate.toLowerCase();
    const style = found.speaker.styles.find(
      (s) => s.id !== baseStyleId && s.name.toLowerCase().includes(wanted)
    );
    if (style) return { styleId: style.id, styled: true };
  }
  return { styleId: baseStyleId, styled: false };
}

/**
 * audio_query の答えへ調子を当てる。**知らない欄はそのまま残す**（エンジンの
 * 版で欄が増えても壊さない）。元の値は捨てる——こちらの調子は「標準から
 * どれだけ寄せるか」で作ってあるので、エンジンの既定に掛け合わせない
 */
export function applyVoiceParams(
  query: Record<string, unknown>,
  params: VoiceParams
): Record<string, unknown> {
  return { ...query, ...params };
}

/**
 * 合成の控えの鍵。文字列・スタイルID・調子・エンジンの口のどれかが違えば別の音
 */
export function synthesisKey(
  engineUrl: string,
  styleId: number,
  text: string,
  params: VoiceParams
): string {
  return hashText(
    JSON.stringify([
      engineUrl,
      styleId,
      text,
      params.speedScale,
      params.pitchScale,
      params.intonationScale,
      params.volumeScale,
      params.prePhonemeLength,
      params.postPhonemeLength,
      // 緩急も音を変える（入れないと、寄せ方を変えても前の音が返る）
      params.tempoDynamicsScale ?? null,
    ])
  );
}

/**
 * 合成した音の控え（メモリの中だけ。**上限つき**）。
 *
 * 一時停止して続ける・同じ文から読み直す・先読みした文を鳴らす、のどれも
 * 同じ文をもう一度作らずに済む。上限を超えたら古く使ったものから捨てる
 * （1文の WAV は数十〜数百KB。1話ぶん読むと数十MBになりうる）。
 */
export class SynthesisCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 300,
    private readonly maxBytes = 64 * 1024 * 1024
  ) {}

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    // 使ったものを後ろへ（古く使ったものから捨てるため）
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Uint8Array): void {
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.byteLength;
      this.entries.delete(key);
    }
    // 1つで上限を超えるものはしまわない（ほかを全部追い出すことになる）
    if (value.byteLength > this.maxBytes) return;
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const dropped = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (dropped) this.bytes -= dropped.byteLength;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/*
  ── HTTP ─────────────────────────────
*/

/** 差し替えられる fetch（テストでは偽のエンジンへ向ける） */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 短い問い合わせ（話者の一覧・下ごしらえ・名乗りなど）を待つ長さ */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 声づくり（synthesis）を待つ長さ＝基本の長さ＋文の1字あたりの長さ（0.147.1）。
 *
 * ノートPCの実機確認（i5-1335U・GPU なし・AivisSpeech を CPU で）では、8.5秒の音（60字ほど）を
 * 作るのに 13.6〜23.3秒かかった（1字あたり 0.4秒ほど）。長い文ほど長くかかるので、一律の30秒では
 * 長い文が必ず時間切れになる。1字あたり1秒は、その2倍あまりの余裕。ここで待つのは
 * 「エンジンが止まったまま」を見分けるためだけで、待つ長さが長くても、作者の中止はすぐ効く
 */
const SYNTHESIS_BASE_TIMEOUT_MS = 30_000;
const SYNTHESIS_PER_CHAR_TIMEOUT_MS = 1_000;

/**
 * **エンジンの中で順番を待っている時間は数えない**（0.147.1）。
 *
 * エンジンは頼みを1つずつ作る。朗読は先読みで2つ並べて頼み、書き出しも2つずつ頼むので、
 * 後ろの頼みは前の声ができるまでエンジンの中で待つ。頼んでから時計を回すと、その待ちのぶんで
 * 時間切れになる（ノートPCで「繋がりませんでした」と出て止まった原因）。そこで、同じ接続先への
 * 頼みを頼んだ順に並べ、**前の頼みがすべて終わって自分が先頭になってから**時計を回す。
 * 前の頼みが止まったままなら、その頼みが先に時間切れになって列を抜けるので、いつまでも待つことはない。
 *
 * 接続先ごとに1本の列（拡張機能の中で1つ。口〔VoiceEngineClient〕は頼むたびに作られるため、
 * 口の中には持てない）。**エンジンが本当は並べて作れる場合**は、時計が遅れて回り始めるだけで、
 * 待つ長さが延びる側にしか外れない
 */
const engineTurns = new Map<string, Array<() => void>>();

/** 列に並ぶ。先頭なら `begin` をすぐ呼ぶ。返す関数で列を抜ける（次の先頭の `begin` を呼ぶ） */
function enterEngineTurn(baseUrl: string, begin: () => void): () => void {
  const queue = engineTurns.get(baseUrl) ?? [];
  engineTurns.set(baseUrl, queue);
  queue.push(begin);
  if (queue.length === 1) begin();
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const index = queue.indexOf(begin);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      if (engineTurns.get(baseUrl) === queue) engineTurns.delete(baseUrl);
      return;
    }
    if (index === 0) queue[0]();
  };
}

/**
 * VOICEVOX 互換のエンジンへの口。**接続先・fetch は外から渡す。**
 */
export class VoiceEngineClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    /** どのエンジンとして叩くか（失敗の知らせにエンジンの名前を出すため） */
    readonly engine?: VoiceEngineId
  ) {}

  async speakers(signal?: AbortSignal): Promise<VoiceSpeaker[]> {
    const response = await this.request("/speakers", { method: "GET" }, signal);
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new VoiceEngineError(
        "badResponse",
        "話者の一覧を読めません",
        error instanceof Error ? error.message : String(error)
      );
    }
    return parseSpeakers(json);
  }

  async audioQuery(
    text: string,
    styleId: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ text, speaker: String(styleId) });
    const response = await this.request(
      `/audio_query?${query.toString()}`,
      { method: "POST" },
      signal
    );
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new VoiceEngineError(
        "badResponse",
        "読み方の下ごしらえ（audio_query）を読めません",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new VoiceEngineError(
        "badResponse",
        "読み方の下ごしらえ（audio_query）の形が読めません",
        JSON.stringify(json)?.slice(0, 300)
      );
    }
    return json as Record<string, unknown>;
  }

  async synthesis(
    query: Record<string, unknown>,
    styleId: number,
    signal?: AbortSignal,
    /** 文の字数（待てる長さを文の長さで延ばす。分からなければ基本の長さだけ） */
    textLength = 0
  ): Promise<Uint8Array> {
    const response = await this.request(
      `/synthesis?speaker=${encodeURIComponent(String(styleId))}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/wav" },
        body: JSON.stringify(query),
      },
      signal,
      SYNTHESIS_BASE_TIMEOUT_MS + SYNTHESIS_PER_CHAR_TIMEOUT_MS * Math.max(0, textLength)
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    // WAV の頭（RIFF）でなければ音ではない。画面で decode に失敗するより先に止める
    if (
      bytes.length < 12 ||
      bytes[0] !== 0x52 ||
      bytes[1] !== 0x49 ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x46
    ) {
      throw new VoiceEngineError("badResponse", "合成の答えが WAV ではありません");
    }
    return bytes;
  }

  /**
   * エンジンの名乗り（`GET /engine_manifest`）。どのエンジンか（AivisSpeech・VOICEVOX）を
   * `brand_name` で見分けるのに使う（設計書6.42.4。口の番号では当てない）。本文は運ばない
   */
  engineManifest(signal?: AbortSignal): Promise<unknown> {
    return this.getJson("/engine_manifest", "エンジンの名乗り（engine_manifest）", signal);
  }

  /** AivisSpeech の音声合成モデルの一覧（`GET /aivm_models`。ライセンスの全文を含む）。本文は運ばない */
  aivmModels(signal?: AbortSignal): Promise<unknown> {
    return this.getJson("/aivm_models", "音声合成モデルの一覧（aivm_models）", signal);
  }

  /** 話者の情報（`GET /speaker_info`。`policy` が話者・キャラクターの規約）。本文は運ばない */
  speakerInfo(speakerUuid: string, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ speaker_uuid: speakerUuid });
    return this.getJson(`/speaker_info?${query.toString()}`, "話者の情報（speaker_info）", signal);
  }

  private async getJson(pathAndQuery: string, what: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(pathAndQuery, { method: "GET" }, signal);
    try {
      return await response.json();
    } catch (error) {
      throw new VoiceEngineError(
        "badResponse",
        `${what}を読めません`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /** 文字列・スタイル・調子から WAV を作る（下ごしらえ→調子を当てる→合成） */
  async speak(
    text: string,
    styleId: number,
    params: VoiceParams,
    signal?: AbortSignal,
    /**
     * 音の標本化の速さをエンジンに揃えさせる（Hz。0.151.0）。2つのエンジンの音を1つの MP3 に
     * つなぐときだけ渡す——既定の速さはエンジンごとに違い（AivisSpeech 44100・VOICEVOX 24000）、
     * つなぐ側は合わせ直す計算を持たない。省けばエンジンの既定のまま
     */
    outputSamplingRate?: number
  ): Promise<Uint8Array> {
    const query = await this.audioQuery(text, styleId, signal);
    const applied = applyVoiceParams(query, params);
    return this.synthesis(
      outputSamplingRate === undefined ? applied : { ...applied, outputSamplingRate },
      styleId,
      signal,
      text.length
    );
  }

  private async request(
    pathAndQuery: string,
    init: RequestInit,
    signal?: AbortSignal,
    /** 自分の番が来てから待てる長さ（ミリ秒） */
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    const controller = new AbortController();
    /*
      **自分で切ったかを旗で持つ**（0.147.1）。時間切れ・作者の中止・届かないを、エラーの文面で
      見分けない（実装ルール5。fetch の実装によって文面も例外の型も違う）
    */
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const leaveTurn = enterEngineTurn(this.baseUrl, () => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    });
    // 作者の中止は列の順番を待たずにすぐ効く（時計とは別に、外の合図をそのまま通す）
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) controller.abort();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      // 作者の中止をいちばん先に見る（中止と時間切れが重なったら、作者が止めたほうを返す）
      if (signal?.aborted) throw new VoiceEngineError("aborted", "中止しました", undefined, this.engine);
      if (timedOut) {
        throw new VoiceEngineError(
          "timeout",
          `音声合成のエンジン（${this.baseUrl}）の答えが、${Math.round(timeoutMs / 1000)}秒待っても届きませんでした`,
          error instanceof Error ? error.message : String(error),
          this.engine
        );
      }
      throw new VoiceEngineError(
        "unreachable",
        `音声合成のエンジン（${this.baseUrl}）から応答がありません`,
        error instanceof Error ? error.message : String(error),
        this.engine
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      leaveTurn();
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      let body = "";
      try {
        body = (await response.text()).slice(0, 500);
      } catch {
        body = "";
      }
      throw new VoiceEngineError(
        "http",
        `音声合成のエンジンが HTTP ${response.status} を返しました`,
        body,
        this.engine
      );
    }
    return response;
  }
}

/**
 * 失敗したときに作者がする次の操作（1つ）。**原因を決め打ちしない**——
 * 応答が無いのは、エンジンが動いていない・口の設定が違う・別のものが
 * 口を使っている、のどれか分からない。
 */
export function voiceEngineNextStep(
  error: VoiceEngineError,
  /** どの道で失敗したか（時間切れの次の操作は道ごとに違う。届かないときの文は今までどおり） */
  route: VoiceEngineDownRoute = "read"
): string {
  if (error.kind === "timeout") {
    const prompt = voiceEngineSlowPrompt(route, error.engine);
    return `${prompt.message}${prompt.detail}`;
  }
  if (error.kind === "unreachable") {
    // どちらのエンジンか分かれば名指しする（0.146.0。［声］で選んだ側を起こせばよいと分かるように）
    const which = error.engine ? `音声合成のエンジン（${VOICE_ENGINE_LABEL[error.engine]}）` : "音声合成のエンジン";
    return (
      `${which}に繋がりませんでした。${engineToStart(error.engine)}を起動してから、もう一度押してください。` +
      "［声］で OS の声を選べば、エンジンなしでも読めます。"
    );
  }
  if (error.kind === "aborted") return "中止しました。";
  return (
    `音声合成のエンジンが受け付けませんでした（${error.message}）。` +
    "［声の割り当て］で声を選び直してから、もう一度押してください。詳しくはログにあります。"
  );
}

/**
 * エンジンに届かなかったときに、画面の真ん中に出す窓（2026-11-07 作者の実機確認）。
 *
 * **右下の知らせや読み上げの列の小さな文では、作者がしばらく気づかなかった**ので、
 * 届かなかったときだけ窓にする。ボタンは次の操作の1つ（OSの声で読む）で、閉じるは
 * VS Code が添える。エンジンが受け付けなかった（http・badResponse）は、読み始めて
 * すぐ列に理由が出て、選び直す先も列の中にあるので、窓にしない。
 *
 * **［声の割り当て］と［音声に書き出す］でも同じ窓にする**（2026-11-08 作者の実機確認：
 * 右下の知らせでは「ポップアップさせてください」）。見出しは揃え、詳しい文はその道の
 * ボタンの名前にする。［OSの声で読む］は読む道でだけ意味があるので、ほかの道には
 * 付けない（押せないボタンの名前も文に書かない）
 */
export type VoiceEngineDownRoute = "read" | "assign" | "export";

/**
 * 窓の見出し。**どちらのエンジンかを入れる**（0.146.0。作者の決定 2026-11-08：［声］で選べるように
 * なったので、どちらを起こせばよいかを窓で分かるようにする）。分からないときは今までの文
 */
function engineDownMessage(engine: VoiceEngineId | undefined): string {
  return engine
    ? `音声合成のエンジン（${VOICE_ENGINE_LABEL[engine]}）に繋がりませんでした。`
    : "音声合成のエンジンに繋がりませんでした。";
}

/**
 * 「〇〇を起動してから」の〇〇。名指しするときは後ろに空白を付ける（「AivisSpeech を」。
 * 英字の名前に助詞が詰まると読みにくい）。分からないときは今までの文（括弧で終わるので空けない）
 */
function engineToStart(engine: VoiceEngineId | undefined): string {
  return engine ? `${VOICE_ENGINE_LABEL[engine]} ` : "AivisSpeech（または VOICEVOX）";
}

/** 届かなかったとき、代わりに動いていたもう片方のエンジン（`otherEngineRunning` の答え） */
export interface RunningOtherEngine {
  engine: VoiceEngineId;
  /** 宛先（`127.0.0.1:10101` の形） */
  host: string;
}

export function voiceEngineDownPrompt(
  route?: "read",
  engine?: VoiceEngineId,
  running?: RunningOtherEngine
): {
  message: string;
  detail: string;
  useOsVoice: string;
  /** もう片方が動いていたときだけ付くボタン（「AivisSpeech で読む」） */
  useOtherEngine?: string;
};
export function voiceEngineDownPrompt(
  route: "assign" | "export",
  engine?: VoiceEngineId
): {
  message: string;
  detail: string;
};
export function voiceEngineDownPrompt(
  route: VoiceEngineDownRoute = "read",
  engine?: VoiceEngineId,
  running?: RunningOtherEngine
): {
  message: string;
  detail: string;
  useOsVoice?: string;
  useOtherEngine?: string;
} {
  const message = engineDownMessage(engine);
  const start = engineToStart(engine);
  if (route === "assign") {
    return {
      message,
      detail:
        `${start}を起動してから、もう一度［声の割り当て］を押してください。\n\n` +
        "割り当てる声はエンジンの話者から選ぶので、エンジンが動いていないと選べません。" +
        "エンジンなしで読むなら、［声］で OS の声を選んでください。",
    };
  }
  if (route === "export") {
    return {
      message,
      detail:
        `${start}を起動してから、もう一度［音声に書き出す］を押してください。\n\n` +
        "音声の書き出しはエンジンの声で作るので、エンジンなしでは書き出せません。ファイルは作っていません。",
    };
  }
  /*
    もう片方のエンジンが動いていた（0.146.0。ノートPCの実機確認）。動いている側を先に書き、
    一押しでそちらへ切り替えて読めるボタンを足す。ほかのボタンは今までどおり
  */
  if (running && running.engine !== engine) {
    const other = VOICE_ENGINE_LABEL[running.engine];
    return {
      message,
      detail:
        `${other}（${running.host}）が動いています。こちらで読みますか。\n\n` +
        `［${other} で読む］を押すと、［声］を ${other} に切り替えて、いまの場所から読みます。` +
        `割り当てた声のうち ${other} に無い声は、代わりの声で読みます。` +
        `${start}で読むなら、${start}を起動してから、もう一度［▶ 読む］を押してください。`,
      useOtherEngine: `${other} で読む`,
      useOsVoice: "OSの声で読む",
    };
  }
  return {
    message,
    detail:
      `${start}を起動してから、もう一度［▶ 読む］を押してください。\n\n` +
      "エンジンなしで読むなら、［OSの声で読む］を押すと、いまの場所から OS の声で読みます。",
    useOsVoice: "OSの声で読む",
  };
}

/**
 * 待てる時間のうちに答えが来なかったとき（`timeout`）の窓（0.147.1。ノートPCの実機確認）。
 *
 * **届かないときの窓（`voiceEngineDownPrompt`）とは別の文にする。** 遅い PC では、エンジンは
 * 動いていても声づくりに時間がかかり、「繋がりませんでした・起動して」は事実と違う案内になる。
 * ただし「動いています」とは書かない——答えが来なかった理由は、こちらからは分からない
 * （実装ルール5）。次の操作は道ごとに1つ。読む道は［音声に書き出す］で先に作っておく
 * （書き出しは待つ前提の道で、できた音は間をあけずに聞ける）。もう片方のエンジン・OS の声は
 * 勧めない（届かないときだけの道）
 */
export function voiceEngineSlowPrompt(
  route: VoiceEngineDownRoute = "read",
  engine?: VoiceEngineId
): { message: string; detail: string } {
  const which = engine ? `音声合成のエンジン（${VOICE_ENGINE_LABEL[engine]}）` : "音声合成のエンジン";
  const message = `${which}の答えが、待てる時間のうちに届きませんでした。`;
  if (route === "assign") {
    return { message, detail: "少し待ってから、もう一度［声の割り当て］を押してください。" };
  }
  if (route === "export") {
    const name = engine ? VOICE_ENGINE_LABEL[engine] : "AivisSpeech（または VOICEVOX）";
    return {
      message,
      detail: `${name}${engine ? " " : ""}が動いているかを確かめてから、もう一度［音声に書き出す］を押してください。`,
    };
  }
  return {
    message,
    detail: "声を作るのに時間がかかっているときは、［音声に書き出す］で先に作っておくと、待たずに聞けます。",
  };
}

/**
 * 音を画面へ渡すための base64。**`Buffer` を使わない**（ブラウザ版の束にも
 * 入るファイルなので、Node だけのものに頼らない。設計書5.8）。
 * 大きな配列を1度に `String.fromCharCode` へ渡すと引数の上限で落ちるので、刻む
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 浮動小数の端数を揃える（控えの鍵が 1.0000000002 で割れないように） */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
