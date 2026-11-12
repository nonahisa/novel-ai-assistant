import type { VoiceEngineId } from "./voiceEngine";

/**
 * ［声の割り当て］の声を選ぶ窓の区切り（作者の頼み 2026-11-13「選択肢が長すぎるので、分類してわかりやすく」。
 * 設計書6.42.3）。純粋な計算だけを持つ（窓を開くのは `features/voiceReading.ts`）。
 *
 * どちらのエンジンも声の分類の欄を持たない（AivisSpeech の `/aivm_models` の manifest は名前・説明・
 * 作者・ライセンス・話者だけ、VOICEVOX の `/speaker_info` は規約・絵・スタイルだけ）。そこで
 * AivisSpeech は説明の語から推し量り、VOICEVOX は話者の uuid → 区切りの表を同梱する。
 * 作者は `voices.json` の `speakerGroups` で直せる（表と推し量りより先に見る）。
 */

/** 声の印象の区切り（窓に出す順。字は窓の見出しと同じ） */
export const VOICE_GROUPS = [
  "女性",
  "男性",
  "子ども",
  "中性的",
  "高齢",
  "人でない（ロボット・動物など）",
  "その他",
] as const;
export type VoiceGroup = (typeof VOICE_GROUPS)[number];

export function isVoiceGroup(value: unknown): value is VoiceGroup {
  return typeof value === "string" && (VOICE_GROUPS as readonly string[]).includes(value);
}

/** 上の2つの見出し（声の印象の区切りより先に出す） */
export const USED_IN_WORK_HEADING = "この作品で使っている声";
export const FREQUENT_HEADING = "よく使う声";
/** よく使う声に出す話者の数 */
export const FREQUENT_LIMIT = 5;

/**
 * VOICEVOX の話者の uuid → 区切り（作者の VOICEVOX 0.26.1 の44話者。2026-11-13）。
 *
 * **測らないと分からない値の初期値として同梱する**（エンジンが分類を教えないため。実装ルール6の例外と
 * 同じ考え）。名前ではなく uuid で引く（名前は版で表記が変わることがある）。**公式のキャラクター紹介とは
 * 照らしていない、確かめていない初期値**で（2026-11-13、実装担当の見当）、振り分けに迷った話者は「その他」に
 * 残した（推測で振ると、作者が探す区切りに出てこない）。作者の `speakerGroups` が常に勝つ。
 * 「人でない」は声の印象でなくキャラクターの設定（妖精・ロボット・うさぎ）で振った——声の印象で分けるなら
 * 女性・子どもになる話者がいる（ずんだもん・あんこもん・中国うさぎ）。
 */
export const VOICEVOX_SPEAKER_GROUPS: Readonly<Record<string, VoiceGroup>> = {
  "7ffcb7ce-00ec-4bdc-82cd-45a8889e43ff": "女性", // 四国めたん
  "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9": "人でない（ロボット・動物など）", // ずんだもん（ずんだ餅の妖精）
  "35b2c544-660e-401e-b503-0e14c635303a": "女性", // 春日部つむぎ
  "3474ee95-c274-47f9-aa1a-8322163d96f1": "女性", // 雨晴はう
  "b1a81618-b27b-40d2-b0ea-27a9ad408c4b": "女性", // 波音リツ
  "c30dc15a-0992-4f8d-8bb8-ad3b314e6a6f": "男性", // 玄野武宏
  "e5020595-5c5d-4e87-b849-270a518d0dcf": "男性", // 白上虎太郎
  "4f51116a-d9ee-4516-925d-21f183e2afad": "男性", // 青山龍星
  "8eaad775-3119-417e-8cf4-2a10bfd592c8": "女性", // 冥鳴ひまり
  "481fb609-6446-4870-9f46-90c4dd623403": "女性", // 九州そら
  "9f3ee141-26ad-437e-97bd-d22298d02ad2": "女性", // もち子さん
  "1a17ca16-7ee5-4ea5-b191-2f02ace24d21": "男性", // 剣崎雌雄
  "67d5d8da-acd7-4207-bb10-b5542d3a663b": "女性", // WhiteCUL
  "0f56c2f2-644c-49c9-8989-94e11f7129d0": "女性", // 後鬼
  "044830d2-f23b-44d6-ac0d-b5d733caa900": "女性", // No.7
  "468b8e94-9da4-4f7a-8715-a22a48844f9e": "高齢", // ちび式じい
  "0693554c-338e-4790-8982-b9c6d476dc69": "女性", // 櫻歌ミコ
  "a8cc6d22-aad0-4ab8-bf1e-2f843924164a": "女性", // 小夜/SAYO
  "882a636f-3bac-431a-966d-c5e6bba9f949": "人でない（ロボット・動物など）", // ナースロボ＿タイプＴ
  "471e39d2-fb11-4c8c-8d89-4b322d2498e0": "男性", // †聖騎士 紅桜†
  "0acebdee-a4a5-4e12-a695-e19609728e30": "男性", // 雀松朱司
  "7d1e7ba7-f957-40e5-a3fc-da49f769ab65": "男性", // 麒ヶ島宗麟
  "ba5d2428-f7e0-4c20-ac41-9dd56e9178b4": "女性", // 春歌ナナ
  "00a5c10c-d3bd-459f-83fd-43180b521a44": "その他", // 猫使アル（確かめきれない）
  "c20a2254-0349-4470-9fc8-e5c0f8cf3404": "その他", // 猫使ビィ（確かめきれない）
  "1f18ffc3-47ea-4ce0-9829-0576d03a7ec8": "人でない（ロボット・動物など）", // 中国うさぎ
  "04dbd989-32d0-40b4-9e71-17c920f2a8a9": "男性", // 栗田まろん
  "dda44ade-5f9c-4a3a-9d2c-2a976c7476d9": "その他", // あいえるたん（確かめきれない）
  "287aa49f-e56b-4530-a469-855776c84a8d": "女性", // 満別花丸
  "97a4af4b-086e-4efd-b125-7ae2da85e697": "女性", // 琴詠ニア
  "0ebe2c7d-96f3-4f0e-a2e3-ae13fe27c403": "人でない（ロボット・動物など）", // Voidoll
  "0156da66-4300-474a-a398-49eb2e8dd853": "女性", // ぞん子
  "4614a7de-9829-465d-9791-97eb8a5f9b86": "女性", // 中部つるぎ
  "3b91e034-e028-4acb-a08d-fbdcd207ea63": "その他", // 離途（確かめきれない）
  "0b466290-f9b6-4718-8d37-6c0c81e824ac": "その他", // 黒沢冴白（確かめきれない）
  "462cd6b4-c088-42b0-b357-3816e24f112e": "女性", // ユーレイちゃん
  "80802b2d-8c75-4429-978b-515105017010": "女性", // 東北ずん子
  "1bd6b32b-d650-4072-bbe5-1d0ef4aaa28b": "子ども", // 東北きりたん
  "ab4c31a3-8769-422a-b412-708f5ae637e8": "女性", // 東北イタコ
  "3be49e15-34bb-48a0-9e2f-9b80c96e9905": "人でない（ロボット・動物など）", // あんこもん
  "d3be2066-205b-47f6-8818-1d93a9ca9cef": "その他", // 夜語トバリ（確かめきれない）
  "aca7de06-9ff9-49a3-9f08-9d3bc19689e5": "その他", // 暁記ミタマ（確かめきれない）
  "cc7baa71-6c74-4399-803b-b60576176a08": "その他", // 里石ユカ（確かめきれない）
  "0d1745d9-ba28-4bf1-b792-3e670ee980ee": "その他", // ブイブイ・コバコ（確かめきれない）
};

/**
 * 説明の語 → 区切り（AivisSpeech のモデルの説明・話者の名前から推し量る）。**上の区切りから順に見る**——
 * 「おじいさん」は男性の語（「おじ」）より先に高齢で当てたいので、高齢を先に置く。
 * 語を広げすぎない（当たらなければ「その他」。作者は `speakerGroups` で直せる）
 */
const DESCRIPTION_WORDS: ReadonlyArray<{ group: VoiceGroup; words: readonly string[] }> = [
  { group: "高齢", words: ["おじいさん", "おじいちゃん", "おばあさん", "おばあちゃん", "長老", "老人", "老婆", "老翁", "お年寄り", "高齢"] },
  { group: "子ども", words: ["少女", "少年", "子ども", "子供", "こども", "幼女", "幼児", "男の子", "女の子", "小学生"] },
  { group: "人でない（ロボット・動物など）", words: ["ロボット", "アンドロイド", "機械音声", "動物", "猫の", "犬の", "人外", "妖精"] },
  { group: "中性的", words: ["中性的", "中性"] },
  { group: "女性", words: ["女性", "お姉さん", "お姉ちゃん", "おねえさん", "お嬢様", "お母さん"] },
  { group: "男性", words: ["男性", "おじさん", "お兄さん", "お兄ちゃん", "おにいさん", "青年", "お父さん", "バリトン"] },
];

/**
 * 説明から区切りを推し量る。当たらなければ `undefined`（呼ぶ側で「その他」）。
 *
 * **たとえの句（「子猫のような」「〜みたいな」）は先に除く**——作者の AivisSpeech のコハクの説明は
 * 「子猫のような甘い声」で、除かずに当てると人でないに入る。
 */
export function groupFromDescription(text: string): VoiceGroup | undefined {
  const plain = text.replace(/[^\s、。,.!！?？「」（）()]*?(のような|のように|みたいな|みたいに)/g, "");
  for (const { group, words } of DESCRIPTION_WORDS) {
    if (words.some((word) => plain.includes(word))) return group;
  }
  return undefined;
}

/** `/aivm_models` から拾う、話者の uuid → 推し量りに使う字（モデルの名前・説明・話者の名前） */
export function aivisDescriptionsOf(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof json !== "object" || json === null || Array.isArray(json)) return out;
  for (const value of Object.values(json as Record<string, unknown>)) {
    const manifest = (value as Record<string, unknown> | null)?.manifest;
    if (typeof manifest !== "object" || manifest === null) continue;
    const m = manifest as Record<string, unknown>;
    const text = [m.name, m.description].filter((t): t is string => typeof t === "string").join("\n");
    if (!Array.isArray(m.speakers)) continue;
    for (const speaker of m.speakers) {
      const s = speaker as Record<string, unknown> | null;
      if (typeof s?.uuid !== "string") continue;
      const name = typeof s.name === "string" ? s.name : "";
      out.set(s.uuid, [text, name].filter((t) => t !== "").join("\n"));
    }
  }
  return out;
}

/**
 * 話者の区切り。順は 作者の `speakerGroups` → VOICEVOX の表（VOICEVOX の声だけ）→ 説明の推し量り
 * （AivisSpeech の説明。話者の名前の「（長老ボイス）」のような括弧も見る）→「その他」
 */
export function voiceGroupOf(
  engine: VoiceEngineId,
  speakerUuid: string,
  speakerName: string,
  options: {
    overrides?: Readonly<Record<string, VoiceGroup>>;
    descriptions?: ReadonlyMap<string, string>;
  } = {}
): VoiceGroup {
  const own = options.overrides?.[speakerUuid];
  if (own) return own;
  if (engine === "voicevox") {
    const listed = VOICEVOX_SPEAKER_GROUPS[speakerUuid];
    if (listed) return listed;
  }
  const text = [options.descriptions?.get(speakerUuid) ?? "", speakerName].join("\n");
  return groupFromDescription(text) ?? "その他";
}

/** 作品をまたいで声を選んだ回数（globalState。鍵は「エンジン|話者の uuid」） */
export type VoicePickCounts = Record<string, number>;

/** globalState の鍵（この端末だけ。設定同期に乗せない——選んだ回数は作者のデータでなく窓の並べ方の手がかり） */
export const VOICE_PICK_COUNTS_KEY = "novelai.voiceAssign.pickCounts";

export function voicePickKey(engine: VoiceEngineId, speakerUuid: string): string {
  return `${engine}|${speakerUuid}`;
}

/** 1回選んだぶんを数える（壊れた控えは捨てて数え直す。数は窓の並べ方にしか使わない） */
export function countVoicePick(
  counts: unknown,
  engine: VoiceEngineId,
  speakerUuid: string
): VoicePickCounts {
  const out: VoicePickCounts = {};
  if (typeof counts === "object" && counts !== null && !Array.isArray(counts)) {
    for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) out[key] = value;
    }
  }
  const key = voicePickKey(engine, speakerUuid);
  out[key] = (out[key] ?? 0) + 1;
  return out;
}

/** よく使う話者（回数の多い順。同じ回数は鍵の順で決める——並びが開くたびに入れ替わらないように） */
export function frequentVoiceKeys(counts: unknown, limit = FREQUENT_LIMIT): string[] {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return [];
  return Object.entries(counts as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([key]) => key);
}

/** 区切りで並べる声の行（窓に出す1行。中身は呼ぶ側が持つ） */
export interface GroupableVoiceRow {
  engine: VoiceEngineId;
  speakerUuid: string;
  speakerName: string;
  /** 窓の行の名前（`話者名` か `話者名／声の形`） */
  label: string;
}

/**
 * 区切りごとに並べる。上から「この作品で使っている声」→「よく使う声」→ 声の印象の区切り（`VOICE_GROUPS` の順）。
 * 空の区切りは出さない。**上の区切りに出た声も、下の区切りにもう一度出す**（打って絞ったときに、
 * どの区切りからでも見つかるように）。区切りの中は渡された順（［声］のエンジンが先）
 *
 * @param used この作品で使っている声（`エンジン|uuid|行の名前`。`usedVoiceKey`）
 * @param frequent よく使う話者（`エンジン|uuid`。多い順）
 */
export function arrangeVoiceRows<T extends GroupableVoiceRow>(
  rows: readonly T[],
  options: {
    used: ReadonlySet<string>;
    frequent: readonly string[];
    groupOf: (row: T) => VoiceGroup;
  }
): Array<{ heading: string; rows: T[] }> {
  const sections: Array<{ heading: string; rows: T[] }> = [];
  const usedRows = rows.filter((row) => options.used.has(usedVoiceKey(row.engine, row.speakerUuid, row.label)));
  if (usedRows.length > 0) sections.push({ heading: USED_IN_WORK_HEADING, rows: usedRows });
  const frequentRows = options.frequent.flatMap((key) =>
    rows.filter((row) => voicePickKey(row.engine, row.speakerUuid) === key)
  );
  if (frequentRows.length > 0) sections.push({ heading: FREQUENT_HEADING, rows: frequentRows });
  for (const group of VOICE_GROUPS) {
    const inGroup = rows.filter((row) => options.groupOf(row) === group);
    if (inGroup.length > 0) sections.push({ heading: group, rows: inGroup });
  }
  return sections;
}

/** この作品で使っている声の鍵（エンジン・話者・窓の行の名前で引く。同じ話者の別の声の形と分ける） */
export function usedVoiceKey(engine: VoiceEngineId, speakerUuid: string, label: string): string {
  return `${engine}|${speakerUuid}|${label}`;
}
