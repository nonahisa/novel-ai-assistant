import { isMemoLine } from "./sceneMemo";
import { voiceDialogueSpans, type ReadingSentence } from "./readAloud";
import {
  isVoiceEmotion,
  isVoiceIntensity,
  pickStyleForEmotion,
  VOICE_EMOTIONS,
  type VoiceEmotion,
  type VoiceIntensity,
  type VoiceSpeaker,
} from "./voiceEngine";

/**
 * 人物の声で朗読する——台詞ごとの話者と感情、声の割り当て（設計書6.42.3）。
 *
 * ここは純粋な計算だけを持つ（読み書きは `voiceCastStore.ts`、AIを呼ぶのは
 * `features/voiceReading.ts`）。
 *
 * ## 台詞は「本文の字」と「同じ字の何番目か」で持つ
 *
 * 推定の結果は**位置では持たない**（読みの辞書と同じ考え方。6.42.1）。本文を
 * 直すと位置はずれるが、台詞の字はたいてい残る。同じ字の台詞（「はい」）が
 * 何度も出るので、話の頭から数えて何番目の同じ字か（`nth`）を添える。
 */

/** 推定に使う、その話の台詞1つ */
export interface CastDialogue {
  /** 話の中の台詞の番号（0始まり。`voiceDialogueSpans` の添字＝計画の `dialogue`） */
  index: number;
  start: number;
  end: number;
  /** 台詞の字（括弧を含む） */
  quote: string;
  /** 同じ字の台詞のうち何番目か（0始まり） */
  nth: number;
}

/** その話の台詞を並べる（計画の `dialogue` と同じ番号になる） */
export function castDialogues(text: string): CastDialogue[] {
  const seen = new Map<string, number>();
  return voiceDialogueSpans(text).map((span, index) => {
    const quote = text.slice(span.start, span.end);
    const nth = seen.get(quote) ?? 0;
    seen.set(quote, nth + 1);
    return { index, start: span.start, end: span.end, quote, nth };
  });
}

/** AIへ送る1区切り */
export interface CastChunk {
  /** 送る本文（台詞の頭に〔番号〕を差し込み、シーンメモの行を除いたもの） */
  text: string;
  /** この区切りの台詞（区切りの中の番号は1から。`dialogues[n-1]`） */
  dialogues: CastDialogue[];
}

/**
 * 本文を行の切れ目で区切り、台詞の頭に〔番号〕を差し込む。
 *
 * **番号は区切りの中だけで振る**（1から）。話の通し番号を送ると、前に台詞を
 * 1つ足しただけで後ろの区切りの字がぜんぶ変わり、控え（チャンクキャッシュ）が
 * 当たらなくなる。台詞の頭がその区切りにあるものだけを数える。
 * 台詞の無い区切りは送らない（話者を訊くものが無い）。
 */
export function castChunksOf(text: string, maxChars: number): CastChunk[] {
  const dialogues = castDialogues(text);
  const chunks: CastChunk[] = [];
  const lines = text.split("\n");
  let lineStart = 0;
  let buffer: string[] = [];
  let bufferChars = 0;
  let bufferDialogues: CastDialogue[] = [];
  let cursor = 0;

  const flush = (): void => {
    if (bufferDialogues.length > 0) {
      chunks.push({ text: buffer.join("\n"), dialogues: bufferDialogues });
    }
    buffer = [];
    bufferChars = 0;
    bufferDialogues = [];
  };

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    if (!isMemoLine(line)) {
      if (bufferChars > 0 && bufferChars + line.length > maxChars) flush();
      // この行に頭がある台詞へ、区切りの中の番号を差し込む（後ろから）
      const here: CastDialogue[] = [];
      while (cursor < dialogues.length && dialogues[cursor].start < lineEnd + 1) {
        if (dialogues[cursor].start >= lineStart) here.push(dialogues[cursor]);
        cursor++;
      }
      let rendered = line;
      const numbers = here.map((_, i) => bufferDialogues.length + i + 1);
      for (let i = here.length - 1; i >= 0; i--) {
        const at = here[i].start - lineStart;
        rendered = `${rendered.slice(0, at)}〔${numbers[i]}〕${rendered.slice(at)}`;
      }
      buffer.push(rendered);
      bufferChars += rendered.length + 1;
      bufferDialogues.push(...here);
    } else {
      while (cursor < dialogues.length && dialogues[cursor].start < lineEnd + 1) cursor++;
    }
    lineStart = lineEnd + 1;
  }
  flush();
  return chunks;
}

/** AIへ渡す人物1人 */
export interface CastPerson {
  id: string;
  name: string;
  aliases: string[];
  speechStyle: string | null;
}

/** 推定1つ（検算を通ったもの） */
export interface CastGuess {
  /** 資料の人物の id。不明なら null */
  speakerId: string | null;
  emotion: VoiceEmotion;
  intensity: VoiceIntensity;
}

/** 話者が分からないときの答え（指示の中でも、この字で答えさせる） */
export const CAST_UNKNOWN_SPEAKER = "不明";

/**
 * 話者の欄に、指示の言葉がそのまま返ってきたもの（CLAUDE.md 失敗3番）。
 * 資料に無い名前として捨てるのは同じだが、**理由を分けて数える**——
 * 指示の書き方を直す手がかりになる。
 */
const SPEAKER_ECHOES = new Set([
  "話者",
  "人物",
  "人物名",
  "名前",
  "資料の人物名",
  "話し手",
  "語り手",
  // 版1.1：「一覧にいない人物は不明」と頼んだ指示の言葉が、答えとして返るもの
  "役名",
  "兵士",
  "一覧にいない人物",
  "一覧の人物",
  "会話の相手",
  "直前の話者",
  "speaker",
  "name",
  "",
]);

/** 検算で捨てた答え */
export interface CastDrop {
  reason: string;
  item: unknown;
}

/**
 * AIの答えを検算する（CLAUDE.md 実装ルール3）。
 *
 * - 番号が、その区切りに実在する（1〜count の整数）。同じ番号の2つ目は捨てる
 * - 話者が資料の人物の名前か別名に**完全に一致**する（別名は人物へ寄せる）。
 *   「不明」は話者なしとして受ける
 * - 感情・強さが列挙の内
 *
 * 通らないものは捨てる（呼ぶ側が「不明・平静」に倒す）。
 */
export function validateCastItems(
  items: readonly unknown[],
  count: number,
  people: readonly CastPerson[]
): { guesses: Map<number, CastGuess>; dropped: CastDrop[] } {
  const byName = new Map<string, string>();
  for (const person of people) {
    for (const name of [person.name, ...person.aliases]) {
      const key = name.trim();
      // 2人が同じ別名を持っていたら、どちらとも決めない（引けないものとして扱う）
      if (byName.has(key) && byName.get(key) !== person.id) byName.set(key, "");
      else if (key !== "") byName.set(key, person.id);
    }
  }
  const guesses = new Map<number, CastGuess>();
  const dropped: CastDrop[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      dropped.push({ reason: "形が違う", item });
      continue;
    }
    const record = item as Record<string, unknown>;
    const number = record.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > count) {
      dropped.push({ reason: "番号が区切りに無い", item });
      continue;
    }
    if (guesses.has(number)) {
      dropped.push({ reason: "同じ番号の答えが2つ目", item });
      continue;
    }
    const speaker = typeof record.speaker === "string" ? record.speaker.trim() : undefined;
    if (speaker === undefined) {
      dropped.push({ reason: "形が違う", item });
      continue;
    }
    let speakerId: string | null = null;
    if (speaker !== CAST_UNKNOWN_SPEAKER) {
      const id = byName.get(speaker);
      if (id === undefined || id === "") {
        dropped.push({
          reason: SPEAKER_ECHOES.has(speaker)
            ? "話者が指示の言葉のまま"
            : id === ""
              ? "話者の名前が2人に当たる"
              : "話者が資料の人物に無い",
          item,
        });
        continue;
      }
      speakerId = id;
    }
    if (!isVoiceEmotion(record.emotion)) {
      dropped.push({ reason: "感情が列挙の外", item });
      continue;
    }
    if (!isVoiceIntensity(record.intensity)) {
      dropped.push({ reason: "強さが列挙の外", item });
      continue;
    }
    guesses.set(number, {
      speakerId,
      emotion: record.emotion,
      intensity: record.intensity,
    });
  }
  return { guesses, dropped };
}

/** 捨てた理由ごとの件数（ログの1行にする） */
export function countDropReasons(dropped: readonly CastDrop[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const drop of dropped) counts[drop.reason] = (counts[drop.reason] ?? 0) + 1;
  return counts;
}

/** AIの答えの本文から、項目の並びを取り出す。読めなければ undefined */
export function parseCastResult(text: string): unknown[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const lines = (json as Record<string, unknown>).lines;
  return Array.isArray(lines) ? lines : undefined;
}

/*
  ── 推定の結果のファイル（`.aiwriter/voiceCast/<話>.json`） ──
*/

export interface CastEntry {
  quote: string;
  nth: number;
  speakerId: string | null;
  /** 表示用。人物の名前が変わっても id で引く */
  speakerName: string | null;
  emotion: VoiceEmotion;
  intensity: VoiceIntensity;
  /** 作者が直した行は `author`。**再推定で上書きしない**（実装ルール2の考え方） */
  source: "ai" | "author";
}

export interface CastFile {
  version: 1;
  episode: string;
  entries: CastEntry[];
  lastRun?: {
    providerId: string;
    model: string;
    promptVersion: string;
    at: string;
    dropped: number;
  };
}

/** 読む。**壊れていたら投げる**（直さない。実装ルール2） */
export function parseCastFile(text: string): CastFile {
  const json: unknown = JSON.parse(text);
  if (typeof json !== "object" || json === null) throw new Error("形が違います");
  const record = json as Record<string, unknown>;
  if (record.version !== 1) throw new Error("版が違います");
  if (typeof record.episode !== "string") throw new Error("episode がありません");
  if (!Array.isArray(record.entries)) throw new Error("entries がありません");
  const entries: CastEntry[] = record.entries.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`entries[${i}] の形が違います`);
    const e = raw as Record<string, unknown>;
    if (typeof e.quote !== "string") throw new Error(`entries[${i}].quote が文字列ではありません`);
    if (typeof e.nth !== "number" || !Number.isInteger(e.nth) || e.nth < 0) {
      throw new Error(`entries[${i}].nth が0以上の整数ではありません`);
    }
    if (e.speakerId !== null && typeof e.speakerId !== "string") {
      throw new Error(`entries[${i}].speakerId の形が違います`);
    }
    if (e.speakerName !== null && typeof e.speakerName !== "string") {
      throw new Error(`entries[${i}].speakerName の形が違います`);
    }
    if (!isVoiceEmotion(e.emotion)) throw new Error(`entries[${i}].emotion が列挙の外です`);
    if (!isVoiceIntensity(e.intensity)) throw new Error(`entries[${i}].intensity が列挙の外です`);
    if (e.source !== "ai" && e.source !== "author") {
      throw new Error(`entries[${i}].source が ai／author ではありません`);
    }
    return {
      quote: e.quote,
      nth: e.nth,
      speakerId: e.speakerId,
      speakerName: e.speakerName,
      emotion: e.emotion,
      intensity: e.intensity,
      source: e.source,
    };
  });
  return {
    version: 1,
    episode: record.episode,
    entries,
    ...(typeof record.lastRun === "object" && record.lastRun !== null
      ? { lastRun: record.lastRun as CastFile["lastRun"] }
      : {}),
  };
}

export function castEntryKey(entry: { quote: string; nth: number }): string {
  return JSON.stringify([entry.quote, entry.nth]);
}

/**
 * 推定し直した答えを混ぜる。**作者が直した行は残し、AIの行だけを入れ替える**
 * （作者の行と同じ台詞の答えは入れない）。
 */
export function mergeCastEntries(
  existing: readonly CastEntry[],
  fresh: readonly CastEntry[]
): CastEntry[] {
  const author = existing.filter((entry) => entry.source === "author");
  const held = new Set(author.map(castEntryKey));
  return [...author, ...fresh.filter((entry) => !held.has(castEntryKey(entry)))];
}

/**
 * いまの本文の台詞ごとに、推定を引く。**同じ字・同じ番目**で当てる。
 * 同じ字の台詞の推定が1つしか無ければ、番目がずれていてもそれを使う
 * （前に同じ台詞を書き足しても、1つしか無い推定を捨てない）。
 */
export function castLookup(
  entries: readonly CastEntry[],
  dialogues: readonly CastDialogue[]
): Map<number, CastEntry> {
  const exact = new Map<string, CastEntry>();
  const byQuote = new Map<string, CastEntry[]>();
  for (const entry of entries) {
    exact.set(castEntryKey(entry), entry);
    const list = byQuote.get(entry.quote) ?? [];
    list.push(entry);
    byQuote.set(entry.quote, list);
  }
  const out = new Map<number, CastEntry>();
  for (const dialogue of dialogues) {
    const hit = exact.get(castEntryKey(dialogue));
    if (hit) {
      out.set(dialogue.index, hit);
      continue;
    }
    const same = byQuote.get(dialogue.quote);
    if (same && same.length === 1) out.set(dialogue.index, same[0]);
  }
  return out;
}

/** 作者が1行を直す（無ければ足す）。直した行は `author` になる */
export function editCastEntry(
  entries: readonly CastEntry[],
  dialogue: { quote: string; nth: number },
  patch: Pick<CastEntry, "speakerId" | "speakerName" | "emotion" | "intensity">
): CastEntry[] {
  const key = castEntryKey(dialogue);
  const next: CastEntry = {
    quote: dialogue.quote,
    nth: dialogue.nth,
    ...patch,
    source: "author",
  };
  let replaced = false;
  const out = entries.map((entry) => {
    if (castEntryKey(entry) !== key) return entry;
    replaced = true;
    return next;
  });
  if (!replaced) out.push(next);
  return out;
}

/*
  ── 声の割り当て（`.aiwriter/voices.json`。作品ごと） ──
*/

/**
 * エンジンの声1つ。**スタイルIDだけで持たない**——AivisSpeech はモデルを
 * 入れ直すと ID が変わることがあるので、話者の uuid とスタイルの名前で引き直し、
 * 引けなければ ID を見る。
 */
export interface VoiceRef {
  speakerUuid: string;
  speakerName: string;
  styleName: string;
  styleId: number;
}

export interface VoiceAssignmentFile {
  version: 1;
  /** 地の文（語り手） */
  narrator?: VoiceRef;
  /** 台詞の既定（話者が分からない・人物に声を決めていない台詞） */
  dialogueDefault?: VoiceRef;
  /** 人物ごと（鍵は人物の id） */
  characters: Record<string, VoiceRef & { characterName: string }>;
  /**
   * 感情→スタイルの名前の候補の上書き（作者が手で書く。話者に合わせて、
   * 例えば `"喜び": ["あまあま"]`）。表（`EMOTION_STYLE_CANDIDATES`）より先に見る
   */
  emotionStyles?: Partial<Record<VoiceEmotion, string[]>>;
}

export function emptyVoiceAssignment(): VoiceAssignmentFile {
  return { version: 1, characters: {} };
}

function parseVoiceRef(raw: unknown, where: string): VoiceRef {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} の形が違います`);
  const r = raw as Record<string, unknown>;
  if (
    typeof r.speakerUuid !== "string" ||
    typeof r.speakerName !== "string" ||
    typeof r.styleName !== "string" ||
    typeof r.styleId !== "number" ||
    !Number.isInteger(r.styleId)
  ) {
    throw new Error(`${where} の欄が足りないか、形が違います`);
  }
  return {
    speakerUuid: r.speakerUuid,
    speakerName: r.speakerName,
    styleName: r.styleName,
    styleId: r.styleId,
  };
}

/** 読む。**壊れていたら投げる**（直さない） */
export function parseVoiceAssignment(text: string): VoiceAssignmentFile {
  const json: unknown = JSON.parse(text);
  if (typeof json !== "object" || json === null) throw new Error("形が違います");
  const record = json as Record<string, unknown>;
  if (record.version !== 1) throw new Error("版が違います");
  const out: VoiceAssignmentFile = { version: 1, characters: {} };
  if (record.narrator !== undefined) out.narrator = parseVoiceRef(record.narrator, "narrator");
  if (record.dialogueDefault !== undefined) {
    out.dialogueDefault = parseVoiceRef(record.dialogueDefault, "dialogueDefault");
  }
  if (record.characters !== undefined) {
    if (typeof record.characters !== "object" || record.characters === null) {
      throw new Error("characters の形が違います");
    }
    for (const [id, raw] of Object.entries(record.characters)) {
      const ref = parseVoiceRef(raw, `characters.${id}`);
      const name = (raw as Record<string, unknown>).characterName;
      if (typeof name !== "string") throw new Error(`characters.${id}.characterName がありません`);
      out.characters[id] = { ...ref, characterName: name };
    }
  }
  if (record.emotionStyles !== undefined) {
    if (typeof record.emotionStyles !== "object" || record.emotionStyles === null) {
      throw new Error("emotionStyles の形が違います");
    }
    const styles: Partial<Record<VoiceEmotion, string[]>> = {};
    for (const [emotion, names] of Object.entries(record.emotionStyles)) {
      if (!isVoiceEmotion(emotion)) {
        throw new Error(`emotionStyles の「${emotion}」は感情の列挙（${VOICE_EMOTIONS.join("・")}）にありません`);
      }
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
        throw new Error(`emotionStyles.${emotion} は文字列の並びにしてください`);
      }
      styles[emotion] = names as string[];
    }
    out.emotionStyles = styles;
  }
  return out;
}

/** いまのエンジンの一覧で、声を引き直す（uuid＋スタイルの名前 → スタイルID） */
export function resolveVoiceRef(
  ref: VoiceRef | undefined,
  speakers: readonly VoiceSpeaker[]
): number | undefined {
  if (!ref) return undefined;
  const speaker = speakers.find((s) => s.uuid === ref.speakerUuid);
  const byName = speaker?.styles.find((style) => style.name === ref.styleName);
  if (byName) return byName.id;
  for (const s of speakers) {
    if (s.styles.some((style) => style.id === ref.styleId)) return ref.styleId;
  }
  return undefined;
}

/*
  ── 文ごとの声 ─────────────────────────
*/

/**
 * 文と文の間（ミリ秒）。画面が次の文を鳴らす前に空ける。
 *
 * - 語り↔台詞・別の台詞へ移る … 少し長く（声が変わるので、間がないと詰まって聞こえる）
 * - 同じ種類の次の文 … 句点の息継ぎぶん
 * - 長い台詞を読点で割った続き … ほとんど空けない
 */
export const VOICE_GAP_SWITCH_MS = 280;
export const VOICE_GAP_SENTENCE_MS = 90;
export const VOICE_GAP_CONTINUE_MS = 30;

/** 文1つを、どの声・どの感情で読むか */
export interface VoicePlanUnit {
  speech: string;
  styleId: number;
  emotion: VoiceEmotion;
  intensity: VoiceIntensity;
  /** 感情に近いスタイルへ切り替えたか（調子の寄せを半分にする） */
  styled: boolean;
  /** この文の前に空ける間（ミリ秒） */
  gapMs: number;
  /** 画面に出す短い名札（「語り」「灯」「台詞」） */
  who: string;
}

/**
 * 計画の文ごとに声を決める。
 *
 * 声の順：人物の声 → 台詞の既定の声 → 語り手の声 → エンジンの最初の声。
 * 推定が無い台詞は「台詞の既定の声・平静」で読む（推定しなくても朗読はできる）。
 * 一覧が空なら undefined（読めない）。
 */
export function voicePlanUnits(input: {
  sentences: readonly ReadingSentence[];
  dialogues: readonly CastDialogue[];
  cast: readonly CastEntry[];
  assignment: VoiceAssignmentFile;
  speakers: readonly VoiceSpeaker[];
  /** 人物の id → 名前（名札に使う。推定の名前より新しい） */
  names?: ReadonlyMap<string, string>;
}): VoicePlanUnit[] | undefined {
  const first = input.speakers[0]?.styles[0]?.id;
  if (first === undefined) return undefined;
  const narrator = resolveVoiceRef(input.assignment.narrator, input.speakers) ?? first;
  const dialogueDefault =
    resolveVoiceRef(input.assignment.dialogueDefault, input.speakers) ?? narrator;
  const lookup = castLookup(input.cast, input.dialogues);

  const units: VoicePlanUnit[] = [];
  let previous: ReadingSentence | undefined;
  for (const sentence of input.sentences) {
    let styleId = narrator;
    let emotion: VoiceEmotion = "平静";
    let intensity: VoiceIntensity = "中";
    let who = "語り";
    if (sentence.kind === "dialogue") {
      styleId = dialogueDefault;
      who = "台詞";
      const entry = sentence.dialogue === undefined ? undefined : lookup.get(sentence.dialogue);
      if (entry) {
        emotion = entry.emotion;
        intensity = entry.intensity;
        if (entry.speakerId) {
          const own = resolveVoiceRef(input.assignment.characters[entry.speakerId], input.speakers);
          if (own !== undefined) styleId = own;
          who = input.names?.get(entry.speakerId) ?? entry.speakerName ?? "台詞";
        }
      }
    }
    const picked = pickStyleForEmotion(
      input.speakers,
      styleId,
      emotion,
      input.assignment.emotionStyles
    );
    units.push({
      speech: sentence.speech,
      styleId: picked.styleId,
      emotion,
      intensity,
      styled: picked.styled,
      gapMs: gapBefore(previous, sentence),
      who,
    });
    previous = sentence;
  }
  return units;
}

function gapBefore(previous: ReadingSentence | undefined, sentence: ReadingSentence): number {
  if (!previous) return 0;
  if (previous.kind !== sentence.kind) return VOICE_GAP_SWITCH_MS;
  if (sentence.kind === "dialogue") {
    return previous.dialogue === sentence.dialogue ? VOICE_GAP_CONTINUE_MS : VOICE_GAP_SWITCH_MS;
  }
  // 同じ行の続き（長い文を読点で割った後ろ）は詰める
  return previous.line === sentence.line && /[、,]$/.test(previous.speech)
    ? VOICE_GAP_CONTINUE_MS
    : VOICE_GAP_SENTENCE_MS;
}
