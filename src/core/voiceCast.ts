import { isMemoLine } from "./sceneMemo";
import { voiceDialogueSpans, type ReadingSentence } from "./readAloud";
import {
  findStyle,
  isNormalStyleName,
  isVoiceEmotion,
  isVoiceEngineId,
  isVoiceIntensity,
  pickNormalStyle,
  pickStyleForEmotion,
  parseVoiceAdjust,
  styleEmotionOf,
  VOICE_EMOTIONS,
  VOICE_ENGINE_LABEL,
  type VoiceAdjust,
  type VoiceEmotion,
  type VoiceEngineId,
  type VoiceIntensity,
  type VoiceSpeaker,
} from "./voiceEngine";
import { isVoiceGroup, type VoiceGroup } from "./voiceGroups";

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
  /**
   * 本文に話者が書いてあり、コードで決めた台詞（区切りの中の番号 → 人物の id）。
   * AIには話者を考えさせず、感情と強さだけを訊く（案 A。`castSpeakersFromText`）
   */
  decided: Map<number, string>;
  /**
   * 区切りの前・後ろの本文（〔番号〕を付けない元の字。シーンメモの行は除く）。
   * 2段に分けた1段目（話者だけ）に参考として添える（案 B。版1.3）——区切りの頭の台詞は、
   * 前の区切りに書いてある場面の顔ぶれが分からないと話者を決められないため。
   * `castChunksOf` に `context` を渡さなければ空
   */
  before: string;
  after: string;
}

/** 区切りの前後に添える本文の字数（`castChunksOf` の `context`） */
export interface CastChunkContext {
  before: number;
  after: number;
}

/**
 * 本文を行の切れ目で区切り、台詞の頭に〔番号〕を差し込む。
 *
 * **番号は区切りの中だけで振る**（1から）。話の通し番号を送ると、前に台詞を
 * 1つ足しただけで後ろの区切りの字がぜんぶ変わり、控え（チャンクキャッシュ）が
 * 当たらなくなる。台詞の頭がその区切りにあるものだけを数える。
 * 台詞の無い区切りは送らない（話者を訊くものが無い）。
 *
 * `decided`（話の台詞の番号 → 人物の id。`castSpeakersFromText` の答え）を渡すと、
 * 区切りの中の番号に引き直して `CastChunk.decided` に持たせる。本文の〔番号〕は
 * 変えない——感情は、話者の決まった台詞もAIに訊くので。
 *
 * `context` を渡すと、区切りの前後の本文（台詞の無い区切りの地の文も含む）を
 * `before`・`after` に持たせる（案 B の1段目の参考。版1.3）。
 */
export function castChunksOf(
  text: string,
  maxChars: number,
  decided?: ReadonlyMap<number, string>,
  context?: CastChunkContext
): CastChunk[] {
  const dialogues = castDialogues(text);
  const chunks: CastChunk[] = [];
  const lines = text.split("\n");
  let lineStart = 0;
  let buffer: string[] = [];
  let bufferChars = 0;
  let bufferDialogues: CastDialogue[] = [];
  let cursor = 0;
  // 前後の本文を後から切り出すため、送る行（シーンメモを除く）の元の字を並べておく
  const plainLines: string[] = [];
  let bufferFirstLine = 0;
  const ranges: Array<{ from: number; to: number }> = [];

  const flush = (): void => {
    if (bufferDialogues.length > 0) {
      const local = new Map<number, string>();
      bufferDialogues.forEach((dialogue, i) => {
        const id = decided?.get(dialogue.index);
        if (id !== undefined) local.set(i + 1, id);
      });
      chunks.push({ text: buffer.join("\n"), dialogues: bufferDialogues, decided: local, before: "", after: "" });
      ranges.push({ from: bufferFirstLine, to: plainLines.length });
    }
    buffer = [];
    bufferChars = 0;
    bufferDialogues = [];
    bufferFirstLine = plainLines.length;
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
      plainLines.push(line);
      bufferChars += rendered.length + 1;
      bufferDialogues.push(...here);
    } else {
      while (cursor < dialogues.length && dialogues[cursor].start < lineEnd + 1) cursor++;
    }
    lineStart = lineEnd + 1;
  }
  flush();
  if (context && (context.before > 0 || context.after > 0)) {
    chunks.forEach((chunk, i) => {
      const { from, to } = ranges[i];
      // 空の行で始まる・終わる字は、参考として意味が無いので詰める
      const before = plainLines.slice(0, from).join("\n").replace(/\s+$/u, "");
      const after = plainLines.slice(to).join("\n").replace(/^\s+/u, "");
      chunk.before = context.before > 0 ? before.slice(Math.max(0, before.length - context.before)) : "";
      chunk.after = context.after > 0 ? after.slice(0, context.after) : "";
    });
  }
  return chunks;
}

/** AIへ渡す人物1人 */
export interface CastPerson {
  id: string;
  name: string;
  aliases: string[];
  speechStyle: string | null;
}

/*
  ── 案 A：話者が本文に書いてある台詞は、コードで決める（版1.2。2026-11-07） ──

  小さいモデル（gemma4:e4b）は、地の文に「と灯は言った」と書いてある台詞まで
  「不明」に倒していた（2026-11-05 の測定で見逃し 3・18）。書いてある所はAIに
  訊かずに当てる。**取り違えを増やさないことを、見逃しを減らすことより先にする**
  （指示）ので、窓は狭く、迷ったら当てずにAIへ回す。

  見る窓は3つだけ：
    (a) 同じ行の、台詞より前の部分（その行に前の台詞が無いとき）
    (b) 同じ行の、閉じ括弧の直後（次の台詞か行末まで）
    (c) 直前の空でない行（(a) が空で、その行に台詞が1つも無いとき。シーンメモは飛ばす）
*/

/**
 * 「〈名前〉は／が〈これ〉」で話し手と読む動詞（窓 (a)・(c) の文の終わり）。
 * **「聞いた」は入れない**——訊いたのか聞こえたのか分からない。
 * 受け身（言われた）は、字が違うので当たらない。
 * **話す以外の意味で文が終わりやすい動詞も入れない**——続けた（歩き続けた）・返した（本を返した）・
 * 応えた（期待に応えた）・切り出した（木を切り出した）は、前の修飾と組んで話していない文に当たる。
 */
export const CAST_SPEECH_VERBS = [
  "言い放った",
  "言い返した",
  "問いかけた",
  "口を開いた",
  "つぶやいた",
  "ささやいた",
  "微笑んだ",
  "苦笑した",
  "苦笑する",
  "つぶやく",
  "ささやく",
  "答えた",
  "答える",
  "叫んだ",
  "怒鳴った",
  "怒鳴る",
  "笑った",
  "微笑む",
  "呟いた",
  "囁いた",
  "尋ねた",
  "尋ねる",
  "訊いた",
  "訊ねた",
  "問うた",
  "告げた",
  "告げる",
  "言った",
  "言う",
  "叫ぶ",
  "笑う",
  "呟く",
  "囁く",
  "訊く",
] as const;

/** 窓 (a)・(c)：文の頭の「〈名前〉は／が」のあと、短い修飾を挟んで発話の動詞で文が終わる */
const SPEECH_TAIL = new RegExp(
  `^、?[^。！？!?「」『』、\\n]{0,12}?(?:${[...CAST_SPEECH_VERBS]
    .sort((a, b) => b.length - a.length)
    .join("|")})[。！？!?…―─]*$`,
  "u"
);

/** 窓 (b)：「と〈名前〉は…」が言った人でない形（受け身・聞いた側） */
const NOT_SPEAKER_AFTER =
  /[ぁ-ん]れ(?:た|て|る|ま)|聞いた|聞いて|聞こえ|耳に|教えられ|知らされ|聞かされ/u;

/** 人物の名前と別名の表。**2人が分け合う名前は id を空にする**（どちらとも決めない）。長い名前を先に */
function castNameTable(people: readonly CastPerson[]): Array<{ name: string; id: string }> {
  const byName = new Map<string, string>();
  for (const person of people) {
    for (const raw of [person.name, ...person.aliases]) {
      const name = raw.trim();
      if (name === "") continue;
      if (byName.has(name) && byName.get(name) !== person.id) byName.set(name, "");
      else byName.set(name, person.id);
    }
  }
  return [...byName]
    .map(([name, id]) => ({ name, id }))
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * 窓に出る人物。**長い名前を先に当て、当たった字は短い名前に使わない**
 * （一覧に「灯」と「灯里」がいるとき、「灯里」の中の「灯」を数えない）。
 * 分け合う名前は空の id として入る（呼ぶ側は2人と同じに扱う）。
 */
function personsIn(window: string, table: ReadonlyArray<{ name: string; id: string }>): Set<string> {
  const covered = new Array<boolean>(window.length).fill(false);
  const found = new Set<string>();
  for (const { name, id } of table) {
    for (let at = window.indexOf(name); at >= 0; at = window.indexOf(name, at + 1)) {
      let free = true;
      for (let k = at; k < at + name.length; k++) if (covered[k]) free = false;
      if (!free) continue;
      for (let k = at; k < at + name.length; k++) covered[k] = true;
      found.add(id);
    }
  }
  return found;
}

/** 窓の at から始まる名前（いちばん長いもの） */
function nameAt(
  window: string,
  at: number,
  table: ReadonlyArray<{ name: string; id: string }>
): { name: string; id: string } | undefined {
  return table.find(({ name }) => window.startsWith(name, at));
}

/**
 * 名前のすぐあとに付く敬称（「グレイさんが」「プリム様は」）。名前そのものは一覧に
 * そのまま当たるものだけで、敬称は**同じ人物を呼ぶ形**なので読み飛ばす
 */
const HONORIFICS = ["先生", "先輩", "さん", "さま", "くん", "ちゃん", "どの", "様", "殿", "君", "氏"];

/** 窓の at から「〈名前〉〈敬称〉?〈助詞〉」が始まれば、その人物と、助詞のあとの位置 */
function subjectAt(
  window: string,
  at: number,
  table: ReadonlyArray<{ name: string; id: string }>,
  particles: readonly string[]
): { id: string; end: number } | undefined {
  const hit = nameAt(window, at, table);
  if (!hit) return undefined;
  let cursor = at + hit.name.length;
  const honorific = HONORIFICS.find((h) => window.startsWith(h, cursor));
  if (honorific) cursor += honorific.length;
  if (!particles.includes(window.charAt(cursor))) return undefined;
  return { id: hit.id, end: cursor + 1 };
}

/** 窓の答え：当てる人物（`person`）か、ほかの窓の答えも止める（`block`） */
interface WindowVerdict {
  person?: string;
  block?: boolean;
}

/** 窓 (a)・(c)：最後の文が「〈名前〉は／が…言った。」か、窓がまるごと名前（台本の `灯「…」`） */
function verdictBefore(
  window: string,
  table: ReadonlyArray<{ name: string; id: string }>,
  allowScriptName: boolean
): WindowVerdict {
  const body = window.replace(/[ \t　]+$/u, "");
  if (body.trim() === "") return {};
  if (allowScriptName) {
    const head = body.trim().replace(/[：:]$/u, "");
    const hit = table.find(({ name }) => name === head);
    if (hit) return hit.id === "" ? { block: true } : { person: hit.id };
  }
  // 最後の文（文の終わりの記号が並んだ末尾は、その文に含める）
  const core = body.replace(/[。！？!?…―─]+$/u, "");
  const lastEnd = Math.max(
    ...["。", "！", "？", "!", "?"].map((mark) => core.lastIndexOf(mark))
  );
  const sentence = body.slice(lastEnd + 1).replace(/^[ \t　]+/u, "");
  // 主語は文の頭か、文の最後の読点のすぐあと（「…一瞥して、プリム様は言った。」）
  const comma = sentence.lastIndexOf("、");
  const subject = [0, ...(comma >= 0 ? [comma + 1] : [])]
    .map((at) => subjectAt(sentence, at, table, ["は", "が"]))
    .find((hit) => hit !== undefined && SPEECH_TAIL.test(sentence.slice(hit.end)));
  if (!subject) return {};
  // 話す形の文なのに、別の人物の名前も入っている／名前を2人が分け合う → 迷うので全部止める
  const persons = personsIn(sentence, table);
  if (subject.id === "" || persons.size !== 1) return { block: true };
  return { person: subject.id };
}

/** 窓 (b)：閉じ括弧の直後が「と〈名前〉は／が／も…」 */
function verdictAfter(
  window: string,
  table: ReadonlyArray<{ name: string; id: string }>
): WindowVerdict & { quoting: boolean; persons: Set<string> } {
  const m = /^[ \t　]*、?と、?/u.exec(window);
  if (!m) return { quoting: false, persons: new Set() };
  const persons = personsIn(window, table);
  const subject = subjectAt(window, m[0].length, table, ["は", "が", "も"]);
  if (!subject) return { quoting: true, persons };
  const firstSentence = window.slice(m[0].length).split(/[。！？!?]/u)[0];
  if (NOT_SPEAKER_AFTER.test(firstSentence)) return { quoting: true, persons, block: true };
  if (subject.id === "" || persons.size !== 1) return { quoting: true, persons, block: true };
  return { quoting: true, persons, person: subject.id };
}

/**
 * 本文に話者がはっきり書いてある台詞の、話者を決める（話の台詞の番号 → 人物の id）。
 * **決まらない台詞は載せない**（AIへ回す）。
 *
 * 名前は、渡した人物の一覧の名前と別名に**そのまま当たるもの**だけ。役名（兵士・師匠）は
 * 一覧にいなければ当てない。次のときは当てない：
 * - 同じ窓（文）に一覧の名前が2人以上ある
 * - 前の窓と後ろの窓で別の人物になる、後ろの「と…」が別の人物に触れている
 * - 後ろの「と〈名前〉は…」が受け身・聞いた側の形
 */
export function castSpeakersFromText(
  text: string,
  people: readonly CastPerson[]
): Map<number, string> {
  const table = castNameTable(people);
  const out = new Map<number, string>();
  if (table.length === 0) return out;
  const dialogues = castDialogues(text);
  const lineStartOf = (at: number): number => text.lastIndexOf("\n", at - 1) + 1;
  const lineEndOf = (at: number): number => {
    const end = text.indexOf("\n", at);
    return end < 0 ? text.length : end;
  };

  dialogues.forEach((dialogue, i) => {
    const previous = i > 0 ? dialogues[i - 1] : undefined;
    const next = i + 1 < dialogues.length ? dialogues[i + 1] : undefined;
    const lineStart = lineStartOf(dialogue.start);
    let before: WindowVerdict = {};
    const sameLineHead = text.slice(lineStart, dialogue.start);
    const previousOnLine = previous !== undefined && previous.end > lineStart;
    if (!previousOnLine) {
      if (sameLineHead.trim() !== "") {
        // (a) 同じ行の台詞の前。台本の書き方（`灯「…」`）もここで拾う
        before = verdictBefore(sameLineHead, table, true);
      } else {
        // (c) 直前の空でない行（シーンメモは飛ばす）。その行に台詞があれば見ない
        let cursor = lineStart - 1;
        while (cursor > 0) {
          const start = lineStartOf(cursor);
          const line = text.slice(start, cursor);
          if (line.trim() === "" || isMemoLine(line)) {
            cursor = start - 1;
            continue;
          }
          const hasDialogue = previous !== undefined && previous.end > start;
          if (!hasDialogue) before = verdictBefore(line, table, false);
          break;
        }
      }
    }
    // (b) 閉じ括弧の直後から、次の台詞か行末まで
    const afterEnd = Math.min(lineEndOf(dialogue.end), next ? next.start : text.length);
    const after = verdictAfter(text.slice(dialogue.end, afterEnd), table);

    if (before.block || after.block) return;
    if (before.person && after.person && before.person !== after.person) return;
    if (before.person && after.quoting && [...after.persons].some((id) => id !== before.person)) {
      return;
    }
    const person = after.person ?? before.person;
    if (person !== undefined) out.set(dialogue.index, person);
  });
  return out;
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
  // 版1.4：前の区切りの話者の流れを添えた指示の言葉
  "流れ",
  "話者の流れ",
  "前の話者",
  "前の区切りの話者",
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
  people: readonly CastPerson[],
  decided?: ReadonlyMap<number, string>
): { guesses: Map<number, CastGuess>; dropped: CastDrop[]; disagreed: number } {
  // 2人が同じ別名を持っていたら、どちらとも決めない（引けないものとして扱う）
  const byName = speakerIdsByName(people);
  const guesses = new Map<number, CastGuess>();
  const dropped: CastDrop[] = [];
  let disagreed = 0;
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
    const fixed = decided?.get(number);
    if (speaker === undefined && fixed === undefined) {
      dropped.push({ reason: "形が違う", item });
      continue;
    }
    let speakerId: string | null = null;
    if (fixed !== undefined) {
      // 本文に話者が書いてある台詞（案 A）。**AIの話者の欄は見ない**——頼み方で
      // 「決まっている」と伝えてあり、ここで捨てると感情まで失う。食い違いは数えるだけ
      if (speaker === undefined || byName.get(speaker) !== fixed) disagreed++;
      speakerId = fixed;
    } else if (speaker !== undefined && speaker !== CAST_UNKNOWN_SPEAKER) {
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
  return { guesses, dropped, disagreed };
}

/*
  ── 案 B：訊き方を2段に分ける（版1.3。2026-11-07） ──

  1段目は話者だけ、2段目は感情と強さだけを訊く。検算も段ごとに分け、捨てた答えを
  段ごとに数える（どちらの段の頼み方を直せばよいかが分かるように）。
*/

/** 名前・別名 → 人物の id。2人が同じ名前を持っていたら空の id（どちらとも決めない） */
function speakerIdsByName(people: readonly CastPerson[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const person of people) {
    for (const name of [person.name, ...person.aliases]) {
      const key = name.trim();
      if (byName.has(key) && byName.get(key) !== person.id) byName.set(key, "");
      else if (key !== "") byName.set(key, person.id);
    }
  }
  return byName;
}

/**
 * 番号の検算（段に共通）。通らなければ捨てる理由を返す。
 * 「2つ目」は、**受け入れた答え**（`accepted`）と同じ番号のときだけ（1回訊きの検算と同じ）
 */
function numberProblem(
  record: Record<string, unknown>,
  count: number,
  accepted: { has(number: number): boolean }
): string | undefined {
  const number = record.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > count) {
    return "番号が区切りに無い";
  }
  if (accepted.has(number)) return "同じ番号の答えが2つ目";
  return undefined;
}

/**
 * 1段目（話者だけ）の答えを検算する。番号 → 人物の id（「不明」は null）。
 *
 * **本文に話者が書いてあった番号（`decided`）への答えは捨てて数える**——頼み方で
 * 「答えません」と伝えてあるので、返ってきたら指示を読んでいない印になる。
 * コードの話者は混ぜる側（`castGuessesForStages`）が先に立てる。
 */
export function validateCastSpeakers(
  items: readonly unknown[],
  count: number,
  people: readonly CastPerson[],
  decided?: ReadonlyMap<number, string>
): { speakers: Map<number, string | null>; dropped: CastDrop[] } {
  const byName = speakerIdsByName(people);
  const speakers = new Map<number, string | null>();
  const dropped: CastDrop[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      dropped.push({ reason: "形が違う", item });
      continue;
    }
    const record = item as Record<string, unknown>;
    const problem = numberProblem(record, count, speakers);
    if (problem) {
      dropped.push({ reason: problem, item });
      continue;
    }
    const number = record.number as number;
    if (decided?.has(number)) {
      dropped.push({ reason: "話者を訊いていない番号", item });
      continue;
    }
    if (typeof record.speaker !== "string") {
      dropped.push({ reason: "形が違う", item });
      continue;
    }
    const speaker = record.speaker.trim();
    if (speaker === CAST_UNKNOWN_SPEAKER) {
      speakers.set(number, null);
      continue;
    }
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
    speakers.set(number, id);
  }
  return { speakers, dropped };
}

/** 2段目（感情と強さだけ）の答えを検算する。話者の欄が付いて返っても見ない */
export function validateCastEmotions(
  items: readonly unknown[],
  count: number
): { emotions: Map<number, { emotion: VoiceEmotion; intensity: VoiceIntensity }>; dropped: CastDrop[] } {
  const emotions = new Map<number, { emotion: VoiceEmotion; intensity: VoiceIntensity }>();
  const dropped: CastDrop[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      dropped.push({ reason: "形が違う", item });
      continue;
    }
    const record = item as Record<string, unknown>;
    const problem = numberProblem(record, count, emotions);
    if (problem) {
      dropped.push({ reason: problem, item });
      continue;
    }
    const number = record.number as number;
    if (!isVoiceEmotion(record.emotion)) {
      dropped.push({ reason: "感情が列挙の外", item });
      continue;
    }
    if (!isVoiceIntensity(record.intensity)) {
      dropped.push({ reason: "強さが列挙の外", item });
      continue;
    }
    emotions.set(number, { emotion: record.emotion, intensity: record.intensity });
  }
  return { emotions, dropped };
}

/** 2段で訊いた1区切りの答えをまとめた結果 */
export interface CastStageGuesses {
  /** 区切りの中の番号 → 推定 */
  guesses: Map<number, CastGuess>;
  /** 1段目（話者）の検算で捨てた答え */
  droppedSpeaker: CastDrop[];
  /** 2段目（感情と強さ）の検算で捨てた答え */
  droppedEmotion: CastDrop[];
  /** 本文に書いてあり、コードで決めた台詞の数 */
  decidedByText: number;
  /** 話者は分かったが感情が無い・捨てたため「平静・中」にした数 */
  calmFilled: number;
}

/**
 * 2段の答えを検算して混ぜる（製品も測る台本もここを通る）。
 *
 * - 話者：コードで決めた話者 → 1段目の答え の順。1段目を呼ばなかった区切り
 *   （全部コードで決まった）は `speakerItems` を渡さない
 * - 感情・強さ：2段目の答え
 * - 感情が無い（答えが無い・捨てた）台詞は、話者が人物に決まっていれば「平静・中」で残す
 *   （案 A と同じ扱い。推定の無い台詞も読むときは平静・中なので、感情の扱いは変わらない）。
 *   話者も分からなければ推定なし
 * - 話者が「不明」・答えが無い台詞も、感情があれば残す（話者が不明でも感情は声に効く）
 */
export function castGuessesForStages(
  answers: { speakerItems?: readonly unknown[]; emotionItems: readonly unknown[] },
  chunk: Pick<CastChunk, "dialogues" | "decided">,
  people: readonly CastPerson[]
): CastStageGuesses {
  const count = chunk.dialogues.length;
  const speakerCheck = answers.speakerItems
    ? validateCastSpeakers(answers.speakerItems, count, people, chunk.decided)
    : { speakers: new Map<number, string | null>(), dropped: [] };
  const emotionCheck = validateCastEmotions(answers.emotionItems, count);
  const guesses = new Map<number, CastGuess>();
  let calmFilled = 0;
  for (let number = 1; number <= count; number++) {
    const speakerId = chunk.decided.get(number) ?? speakerCheck.speakers.get(number) ?? null;
    const feeling = emotionCheck.emotions.get(number);
    if (feeling) {
      guesses.set(number, { speakerId, ...feeling });
    } else if (speakerId !== null) {
      guesses.set(number, { speakerId, emotion: "平静", intensity: "中" });
      calmFilled++;
    }
  }
  return {
    guesses,
    droppedSpeaker: speakerCheck.dropped,
    droppedEmotion: emotionCheck.dropped,
    decidedByText: chunk.decided.size,
    calmFilled,
  };
}

/*
  ── 案 C：掛け合いの流れを渡す（版1.4。2026-11-07） ──

  1段目で区切りを訊くとき、すぐ前の区切りまでに決まった話者の名前を、直前の数件だけ
  添える。区切りの頭の台詞は、前の区切りで誰と誰が話していたかが分からないと決めにくい。
  流れを組むのはここ（コード）で、頼み方（prompts/voiceCast.ts）は名前の列を受け取るだけ。
*/

/**
 * 1区切りの台詞の話者を、台詞の順に並べる（流れへ足す分）。
 *
 * 決め方の順：作者が［台詞の一覧］で直した行（`author`。話の通し番号で引く）→
 * 本文に書いてあった話者（`chunk.decided`）→ 1段目の検算を通った答え（`aiSpeakers`）。
 * どれも無ければ null（不明）。作者の行は確かな答えなので、AIの答えより先に立てる。
 */
export function castChunkSpeakerSequence(
  chunk: Pick<CastChunk, "dialogues" | "decided">,
  aiSpeakers: ReadonlyMap<number, string | null> | undefined,
  author?: ReadonlyMap<number, string | null>
): Array<string | null> {
  return chunk.dialogues.map((dialogue, i) => {
    if (author?.has(dialogue.index)) return author.get(dialogue.index) ?? null;
    return chunk.decided.get(i + 1) ?? aiSpeakers?.get(i + 1) ?? null;
  });
}

/**
 * 流れに添える名前の列（古い順。末尾が、次の区切りの〔1〕の直前の台詞）。
 *
 * - 直前の `max` 件だけ。古い所まで渡すと、場面が変わったのに前の顔ぶれを引きずる
 * - 決まらなかった台詞は**抜かずに「不明」と書く**。抜くと「灯 → 蓮 → 灯」のように
 *   実際より交互に話しているように見え、流れに合わせた当てはめを誘う
 * - 資料に無い id（消した人物）も「不明」
 * - 範囲が全部「不明」なら空を返す（手がかりにならず、添えると控えの鍵だけが変わる）
 */
export function castFlowNames(
  history: ReadonlyArray<string | null>,
  nameOf: ReadonlyMap<string, string>,
  max: number
): string[] {
  const names = history
    .slice(Math.max(0, history.length - max))
    .map((id) => (id === null ? undefined : nameOf.get(id)) ?? CAST_UNKNOWN_SPEAKER);
  return names.some((name) => name !== CAST_UNKNOWN_SPEAKER) ? names : [];
}

/** 1区切りの答えをまとめた結果 */
export interface CastChunkGuesses {
  /** 区切りの中の番号 → 推定 */
  guesses: Map<number, CastGuess>;
  dropped: CastDrop[];
  /** 本文に話者が書いてあり、コードで決めた台詞の数 */
  decidedByText: number;
  /** そのうち、AIの話者の欄がコードと違った数（測るときの手がかり。結果には使わない） */
  disagreed: number;
  /** コードで決めた台詞で、AIの感情が無い・捨てたため「平静・中」にした数 */
  calmFilled: number;
}

/**
 * 1区切りのAIの答えを検算し、コードで決めた話者と混ぜる（AIとコードの両方の道は
 * ここだけを通る。測る台本も同じ関数を呼ぶ）。
 *
 * コードで決めた台詞にAIの感情が無いとき（答えが無い・感情が列挙の外）は、
 * **話者だけ決めて「平静・中」で保存する**。感情はコードで決めないが、推定の無い
 * 台詞も読むときは「平静・中」になるので、感情の扱いは今までと変わらない。
 * 話者が分かっているのに「不明」で読むより良い。
 */
export function castGuessesForChunk(
  items: readonly unknown[],
  chunk: Pick<CastChunk, "dialogues" | "decided">,
  people: readonly CastPerson[]
): CastChunkGuesses {
  const checked = validateCastItems(items, chunk.dialogues.length, people, chunk.decided);
  let calmFilled = 0;
  for (const [number, speakerId] of chunk.decided) {
    if (checked.guesses.has(number)) continue;
    checked.guesses.set(number, { speakerId, emotion: "平静", intensity: "中" });
    calmFilled++;
  }
  return {
    guesses: checked.guesses,
    dropped: checked.dropped,
    decidedByText: chunk.decided.size,
    disagreed: checked.disagreed,
    calmFilled,
  };
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
    /** 検算で捨てた答えの合計（2段で訊いたときは両段の和） */
    dropped: number;
    /** 2段で訊いたときの段ごとの内訳（版1.3から。前の版のファイルには無い） */
    droppedSpeaker?: number;
    droppedEmotion?: number;
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
 *
 * **エンジンの印（`engine`）を持つ**（0.146.0）。スタイルの番号はエンジンごとに振られるので、
 * AivisSpeech の声として選んだ番号が、VOICEVOX では別人の声の番号になりうる。印の違う声は
 * 番号で探さない（`resolveVoiceRef`）。人物ごとに印を持つので、のちに人物ごとにエンジンを
 * 混ぜる形（2段目）も、このファイルの形のまま書ける。
 *
 * 印の無い声は、前の版（0.145 まで）で選んだ声。どちらのエンジンの声か分からないので、
 * uuid とスタイルの名前で引けたときだけ使う。
 */
export interface VoiceRef {
  speakerUuid: string;
  speakerName: string;
  styleName: string;
  styleId: number;
  /** 選んだときのエンジン。前の版の声には無い */
  engine?: VoiceEngineId;
  /** 声の調整（高さ・速さ・抑揚。作者の頼み 2026-11-13）。無ければ標準 */
  adjust?: VoiceAdjust;
}

/**
 * 声の割り当て（`.aiwriter/voices.json`）。
 *
 * **版は 1 のまま**、声に任意の欄 `engine` を足した（0.146.0）。前の版の拡張機能は知らない欄を
 * 落として読むので、別の端末の古い版でも止まらずに読める。版を 2 に上げると、同期した先の
 * 古い版が「版が違います」で止まる。古い版が書き戻すと印は落ちるが、印の無い声は番号で
 * 探さないので、別の声で読むことにはならない（語りの声で読み、選び直しを促す）。
 */
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
  /**
   * 声を選ぶ窓の区切りの直し（作者が手で書く。話者の uuid → 区切り。作者の頼み 2026-11-13）。
   * 同梱の表と説明の推し量りより先に見る。知らない区切りの値は読むときに捨てる
   */
  speakerGroups?: Record<string, VoiceGroup>;
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
  // 知らない印は直さずに止める（実装ルール2。勝手に AivisSpeech と読まない）
  if (r.engine !== undefined && !isVoiceEngineId(r.engine)) {
    throw new Error(`${where}.engine は "aivisspeech" か "voicevox" にしてください`);
  }
  // 調整は壊れた値を捨てて読む（止めない。調整が無くても声は読める）
  const adjust = parseVoiceAdjust(r.adjust);
  return {
    speakerUuid: r.speakerUuid,
    speakerName: r.speakerName,
    styleName: r.styleName,
    styleId: r.styleId,
    ...(isVoiceEngineId(r.engine) ? { engine: r.engine } : {}),
    ...(adjust ? { adjust } : {}),
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
  // 区切りの直しは窓の並べ方にしか使わないので、壊れた値は捨てて読む（止めない）
  if (typeof record.speakerGroups === "object" && record.speakerGroups !== null && !Array.isArray(record.speakerGroups)) {
    const groups: Record<string, VoiceGroup> = {};
    for (const [uuid, group] of Object.entries(record.speakerGroups)) {
      if (isVoiceGroup(group)) groups[uuid] = group;
    }
    if (Object.keys(groups).length > 0) out.speakerGroups = groups;
  }
  return out;
}

/**
 * いまのエンジンの一覧で、声を引き直す（uuid＋スタイルの名前 → スタイルID）。
 *
 * - 印（`ref.engine`）が `engine` と違う … 引かない（番号が同じでも別のエンジンの別人の声）
 * - 印が同じ … uuid＋スタイルの名前、引けなければ番号（AivisSpeech はモデルを入れ直すと
 *   番号が変わることがあり、名前が変わることもあるので、同じエンジンの中だけ番号でも探す）
 * - 印が無い（前の版の声）… uuid＋スタイルの名前で引けたときだけ。**番号で探し直さない**
 *   （0.145 までは番号でも探したので、エンジンを替えると番号だけ同じ別の声で黙って読んだ）
 */
export function resolveVoiceRef(
  ref: VoiceRef | undefined,
  speakers: readonly VoiceSpeaker[],
  engine: VoiceEngineId
): number | undefined {
  if (!ref) return undefined;
  if (ref.engine !== undefined && ref.engine !== engine) return undefined;
  const speaker = speakers.find((s) => s.uuid === ref.speakerUuid);
  const byName = speaker?.styles.find((style) => style.name === ref.styleName);
  if (byName) return byName.id;
  if (ref.engine === undefined) return undefined;
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
  /**
   * どのエンジンで作る音か。**音を作る口はこの印で選ぶ**（0.146.0）。人物ごとにエンジンを
   * 混ぜる形（2段目。0.151.0）では、文ごとにその文の声のエンジンになる
   */
  engine: VoiceEngineId;
  styleId: number;
  emotion: VoiceEmotion;
  intensity: VoiceIntensity;
  /** 感情に近いスタイルへ切り替えたか（調子の寄せを半分にする） */
  styled: boolean;
  /** この文の前に空ける間（ミリ秒） */
  gapMs: number;
  /** 画面に出す短い名札（「語り」「灯」「台詞」） */
  who: string;
  /**
   * その声の枠の調整（人物ごと。作者の頼み 2026-11-13）。朗読も書き出しもこの値を `voiceParamsFor` へ渡す。
   * 画面からは受け取らない（計画は拡張機能が持つ）
   */
  adjust?: VoiceAdjust;
}

/** エンジンごとの、引けなかった枠（「語り手」「台詞の既定」・人物の名前） */
export interface VoicePlanSlots {
  engine: VoiceEngineId;
  slots: string[];
}

/**
 * 計画の文ごとに声を決める。
 *
 * 声の順：人物の声 → 台詞の既定の声 → 語り手の声 → ［声］のエンジンの最初の声。
 * 推定が無い台詞は「台詞の既定の声・平静」で読む（推定しなくても朗読はできる）。
 * 一覧が空なら undefined（読めない）。
 *
 * **割り当てた声は、どの枠でもその声の印のエンジンで読む**（2段目。0.151.0。作者の決定 2026-11-08
 * 「人物ごとにエンジンを混ぜられる」）。`voices.json` は作者が選んだ声なので、［声］で選んだエンジンに
 * 合わせて黙って差し替えない。［声］のエンジン（`engine`）が決めるのは、印の無い声（0.145 までに選んだ声）と、
 * 何も割り当てていないときの最後の声。
 *
 * 引けなかった声は上の順で次の声へ落とし、その枠を返す：
 * - `missing`：エンジンには届いたが、一覧にその声が無い（入れ直して消えた・前の版の声）
 * - `down`：そのエンジンに届かない（`downEngines`）。届かないエンジンの声だけを代わりの声で読み、止めない
 *
 * 人物はこの話で台詞を言う人だけ数える。**知らせは呼ぶ側が1回の読み上げで1回出す**（文ごとに出さない）
 */
export interface VoicePlan {
  units: VoicePlanUnit[];
  /** `missing` の枠の名前を並べたもの（0.146.0 からの形。エンジンを問わない） */
  unresolved: string[];
  missing: VoicePlanSlots[];
  down: VoicePlanSlots[];
}

export function voicePlanUnits(input: {
  sentences: readonly ReadingSentence[];
  dialogues: readonly CastDialogue[];
  cast: readonly CastEntry[];
  assignment: VoiceAssignmentFile;
  /** ［声］のエンジン（`engine`）の話者の一覧 */
  speakers: readonly VoiceSpeaker[];
  /** ［声］で選んだエンジン。印の無い声と、最後の声のエンジン */
  engine: VoiceEngineId;
  /**
   * ほかのエンジンの話者の一覧（2段目）。割り当てに印のある声のエンジンだけ渡す。
   * 渡さないエンジンの印の声は、0.146.0 と同じく「見つからない」として代わりの声で読む
   */
  others?: ReadonlyMap<VoiceEngineId, readonly VoiceSpeaker[]>;
  /** 届かなかったエンジン。その印の声は代わりの声で読み、`down` に返す */
  downEngines?: ReadonlySet<VoiceEngineId>;
  /** 人物の id → 名前（名札に使う。推定の名前より新しい） */
  names?: ReadonlyMap<string, string>;
}): VoicePlan | undefined {
  const firstId = input.speakers[0]?.styles[0]?.id;
  if (firstId === undefined) return undefined;
  const listOf = (engine: VoiceEngineId): readonly VoiceSpeaker[] | undefined =>
    engine === input.engine ? input.speakers : input.others?.get(engine);
  const missing: VoicePlanSlots[] = [];
  const down: VoicePlanSlots[] = [];
  const note = (into: VoicePlanSlots[], engine: VoiceEngineId, slot: string): void => {
    const entry = into.find((e) => e.engine === engine) ?? { engine, slots: [] };
    if (!into.includes(entry)) into.push(entry);
    if (!entry.slots.includes(slot)) entry.slots.push(slot);
  };
  /** 声は「エンジンとスタイルの番号」の組で持つ（番号はエンジンごとに振られるため） */
  // 調整（`adjust`）は引けた声の枠のもの。代わりの声に落ちたら、落ちた先の枠の調整になる
  // （ほかの声へ、その人物のための高さや速さを当てない）
  type Voice = { engine: VoiceEngineId; styleId: number; adjust?: VoiceAdjust };
  /** 割り当てがあるのに引けなかった枠を覚える（割り当てていない枠は数えない） */
  const resolve = (ref: VoiceRef | undefined, slot: string): Voice | undefined => {
    if (!ref) return undefined;
    const engine = ref.engine ?? input.engine;
    if (engine !== input.engine && input.downEngines?.has(engine)) {
      note(down, engine, slot);
      return undefined;
    }
    const list = listOf(engine);
    const id = list ? resolveVoiceRef(ref, list, engine) : undefined;
    if (id === undefined) {
      // 一覧を渡されていないエンジンの声は、0.146.0 と同じく［声］のエンジンに見つからない声として返す
      note(missing, list ? engine : input.engine, slot);
      return undefined;
    }
    return { engine, styleId: id, ...(ref.adjust ? { adjust: ref.adjust } : {}) };
  };
  const narrator = resolve(input.assignment.narrator, "語り手") ?? { engine: input.engine, styleId: firstId };
  const lookup = castLookup(input.cast, input.dialogues);
  // 台詞の既定は、台詞が1つも無い話では使わない（使わない声の知らせを出さない）
  const hasDialogue = input.sentences.some((sentence) => sentence.kind === "dialogue");
  const dialogueDefault =
    (hasDialogue ? resolve(input.assignment.dialogueDefault, "台詞の既定") : undefined) ?? narrator;

  const units: VoicePlanUnit[] = [];
  let previous: ReadingSentence | undefined;
  for (const sentence of input.sentences) {
    let voice = narrator;
    let emotion: VoiceEmotion = "平静";
    let intensity: VoiceIntensity = "中";
    let who = "語り";
    if (sentence.kind === "dialogue") {
      voice = dialogueDefault;
      who = "台詞";
      const entry = sentence.dialogue === undefined ? undefined : lookup.get(sentence.dialogue);
      if (entry) {
        emotion = entry.emotion;
        intensity = entry.intensity;
        if (entry.speakerId) {
          who = input.names?.get(entry.speakerId) ?? entry.speakerName ?? "台詞";
          const ref = input.assignment.characters[entry.speakerId];
          const own = resolve(ref, input.names?.get(entry.speakerId) ?? ref?.characterName ?? who);
          if (own !== undefined) voice = own;
        }
      }
    }
    // 感情のスタイルは、その声のエンジンの一覧から選ぶ（同じ番号が別のエンジンでは別人）
    const list = listOf(voice.engine) ?? [];
    // 平静の文は、同じ話者のふだんの声で読む（台詞は 0.151.1、語りは 0.152.0。作者の答え 2026-11-13）。語りも、
    // 前の版で「上機嫌」など感情のスタイルを選んでいた語り手は、窓の表示（話者だけ）と合うようノーマルで読む。
    // ただし選んだのが「声の形」（しっとり・人間ver. など感情に結びつかない名前）なら選んだまま——
    // 作者が選ぶのは話者と声の形で、感情のスタイルだけを自動で替える（作者の答え 2026-11-13）
    const baseName = findStyle(list, voice.styleId)?.style.name;
    const keepShape =
      baseName !== undefined &&
      !isNormalStyleName(baseName) &&
      styleEmotionOf(baseName, input.assignment.emotionStyles) === undefined;
    const picked =
      emotion === "平静"
        ? { styleId: keepShape ? voice.styleId : pickNormalStyle(list, voice.styleId), styled: false }
        : pickStyleForEmotion(list, voice.styleId, emotion, input.assignment.emotionStyles);
    units.push({
      speech: sentence.speech,
      engine: voice.engine,
      styleId: picked.styleId,
      emotion,
      intensity,
      styled: picked.styled,
      gapMs: gapBefore(previous, sentence),
      who,
      ...(voice.adjust ? { adjust: voice.adjust } : {}),
    });
    previous = sentence;
  }
  return { units, unresolved: missing.flatMap((entry) => entry.slots), missing, down };
}

/**
 * 割り当てに印のある、［声］とは別のエンジン（2段目。0.151.0）。**この話者の一覧だけを引く**——
 * 割り当てに無いエンジンへは問い合わせない（前もって問い合わせない決まり。作者の答え 2026-11-08）
 */
export function assignedOtherEngines(
  assignment: VoiceAssignmentFile,
  engine: VoiceEngineId
): VoiceEngineId[] {
  const refs = [assignment.narrator, assignment.dialogueDefault, ...Object.values(assignment.characters)];
  const out: VoiceEngineId[] = [];
  for (const ref of refs) {
    if (ref?.engine !== undefined && ref.engine !== engine && !out.includes(ref.engine)) out.push(ref.engine);
  }
  return out;
}

/**
 * 引けなかった声の一言（0.146.0。1回の読み上げ・書き出しで1回出す）。
 * 何の声で読むかと、直す場所（［声の割り当て］）を書く
 */
export function unresolvedVoiceNotice(unresolved: readonly string[], engineLabel: string): string | undefined {
  if (unresolved.length === 0) return undefined;
  return (
    `割り当てた声のうち ${unresolved.join("・")} の声が ${engineLabel} に見つからないので、代わりの声（台詞の既定か語りの声）で読みます` +
    `（入れ直して消えた声か、前の版で選んだ声です）。［声の割り当て］で ${engineLabel} の声を選び直してください。`
  );
}

/**
 * 届かなかったエンジンの種類（一言の書き分けに使う）。届かない（unreachable）とそれ以外
 * （時間切れ・受け付けなかった・答えが読めない）で、作者にする話が違う
 */
export type VoicePlanDownKind = "unreachable" | "timeout" | "http" | "badResponse" | "aborted";

/**
 * 計画の一言（0.151.0）。見つからない声（`missing`）と届かないエンジン（`down`）を、エンジンの名前で
 * 分けて書く。**届かないことを先に書く**（作者が最初の1文で、何が足りないかを読めるように）
 */
export function voicePlanNotice(
  plan: Pick<VoicePlan, "missing" | "down">,
  downKinds: ReadonlyMap<VoiceEngineId, VoicePlanDownKind> = new Map()
): string | undefined {
  const parts: string[] = [];
  for (const { engine, slots } of plan.down) {
    const name = VOICE_ENGINE_LABEL[engine];
    // 原因は決め打ちしない（実装ルール5）。届かないときだけ「起動して」と言う
    const unreachable = (downKinds.get(engine) ?? "unreachable") === "unreachable";
    parts.push(
      (unreachable ? `${name} に繋がらないので` : `${name} から話者の一覧を受け取れなかったので`) +
        `、${slots.join("・")} の声は代わりの声（台詞の既定か語りの声）で読みます。` +
        (unreachable
          ? `${name} を起動してからもう一度押すと、割り当てた声で読みます。`
          : `${name} が動いているかを確かめてからもう一度押すと、割り当てた声で読みます（詳しくはログにあります）。`)
    );
  }
  for (const { engine, slots } of plan.missing) {
    const text = unresolvedVoiceNotice(slots, VOICE_ENGINE_LABEL[engine]);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
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
