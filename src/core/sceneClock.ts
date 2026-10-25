import { readStoryDates } from "./storyCalendar";

/**
 * 本文の行ごとに「作中のいつか」を、AIを使わずに読む（設計書6.88。移動の照合の時計）。
 *
 * ## なぜ要るのか
 *
 * 移動の照合（`findTravelImpossibilities`）は「所要3日の道のりを1日で移った」を
 * 見るので、2つの所在のあいだに**どれだけ時が経ったか**が要る。事実の抽出（P-37）は
 * 時期（`storyTime`）を返すことになっているが、測った台では全件 `null` だった。
 * 作者の裁定（2026-10-25 夜）は**「まず語と日付、足りなければAI」**——ここは
 * その「語と日付」の段である。
 *
 * ## 読むもの（小さな語彙だけ）
 *
 * - **話をまたぐ経過**は `storyCalendar.readStoryDates`（6.10.9）の日付。月日が
 *   そろって書かれた話だけ
 * - **話の中**は、**段落の頭**の決まった語だけ：「その頃」「同じ頃」は経過0、
 *   「翌朝」「翌日」「N日後」は経過あり、「数日後」「しばらくして」は**鎖を切る**
 * - **区切りの行（＊・◇など）のあとに印の無い段落が来たら、鎖を切る**
 *   （印の無い時間の飛び。何日飛んだか分からない）
 *
 * **年表（`設定/timeline.json`）は使わない**（6.88.4）。**`StoryFact.storyTime` には
 * 書き込まない**——書くと `orderFacts` を通じてほかの照合器の並びまで変わる。
 *
 * ## 目盛りは「日」、幅で持つ
 *
 * 時刻は読まない（本文からは安定して読めない）。代わりに、各区切り（場面）を
 * 「早くて何日目・遅くて何日目」の幅で持ち、照合は**経過の上限**で比べる。
 * 日付だけが分かる話は、その日のうちのいつか分からないので幅を1日とる。
 *
 * **空行は場面の区切りにしない。** 作者の作品では行の4割以上が空行で、
 * 段落ごとに空けている（第0段の測定、2026-10-25）。空行で切ると、鎖が
 * 段落ごとに切れて何も比べられなくなる。
 *
 * VS Code にも `node:` にも依存しない（拡張機能と MCP が同じ時計を使う。6.88.10）。
 */

/** 時計に渡す本文1つ。**事実の置き場所（`FactPlace`）と同じ `filePath` で渡す** */
export interface SceneClockEpisode {
  filePath: string;
  /** 話数。分からなければ null（日付も、前の話からの続きも使わない） */
  chapter: number | null;
  text: string;
}

/** 1行の「いつか」 */
export interface SceneClockReading {
  /**
   * 時の鎖。**同じ鎖のあいだでしか経過を比べない**——鎖が切れたところは、
   * 何日経ったのか分からない。日付で読んだ話どうしは同じ鎖（`暦`）に載る
   */
  chain: string;
  /** 場面（区切り）。**同じ場面の中では経過を読まない**（後述の注） */
  segment: string;
  /** 鎖の起点から数えて、早くて何日目か */
  dayLow: number;
  /** 遅くて何日目か（`dayLow` と同じか大きい） */
  dayHigh: number;
}

export interface SceneClockStats {
  episodes: number;
  /** 日付が読めた話 */
  datedEpisodes: number;
  /** 段落の頭で読んだ印の数（種類ごと） */
  markers: { simultaneous: number; advance: number; sameDay: number; cut: number };
  /** 区切りのあとに印が無く、鎖を切った数 */
  unmarkedBreaks: number;
  /** 時計の付いた行の数 */
  clockedLines: number;
}

export interface SceneClock {
  /** その行の「いつか」。読めなければ null */
  readingAt(filePath: string, line: number): SceneClockReading | null;
  stats: SceneClockStats;
}

/** 日付で読んだ話が載る鎖の名前 */
export const CALENDAR_CHAIN = "暦";

/** 段落の頭の印 */
type HeadMarker =
  | { kind: "simultaneous" }
  | { kind: "sameDay" }
  | { kind: "advance"; days: number }
  | { kind: "cut" };

/**
 * 「同じ時」を言う語。**前の場面と同じ時の幅**に置く。
 *
 * 視点を替えて「その頃、Bは〜」と書く形。ここで同じ人が別の場所にいれば、
 * それこそが仕込みの「同じ人が同じ時刻に2か所」である。
 */
const SIMULTANEOUS = /^(?:ちょうど)?(?:その頃|そのころ|同じ頃|同じころ|同じ時刻)/u;

/** 同じ日のうちを言う語。日の目盛りでは経過0（時刻は読まない） */
const SAME_DAY =
  /^(?:その夜|その晩|その日|その朝|その夕方|その昼|夕方|夕刻|昼過ぎ|夜になって|日が暮れて)/u;

/** 次の日へ進む語。日数が決まっているものだけ */
const NEXT_DAY: ReadonlyArray<{ pattern: RegExp; days: number }> = [
  { pattern: /^(?:翌々日|翌々朝)/u, days: 2 },
  {
    pattern: /^(?:翌朝|翌日|翌晩|翌夕|翌夜|翌昼|次の日|次の朝|明くる日|明くる朝|あくる日|あくる朝)/u,
    days: 1,
  },
];

/** 「三日後」「3日経って」。**数がはっきり書かれたものだけ** */
const DAYS_LATER =
  /^([0-9０-９一二三四五六七八九十]{1,3})日(?:後|が経って|が経ち|がたって|経って)/u;

/**
 * 経過が読めない語。**鎖を切る**。
 *
 * 「数日後」は3日かもしれず10日かもしれない。ここで日数を推し量ると、
 * 作者は本文ではなくこちらの推測を直しに行くことになる。週・月・年の
 * 単位で飛ぶものも切る（移動の照合で比べたいのは数日の幅である）。
 */
const CUT =
  /^(?:数日|何日か|幾日か|しばらく|やがて|後日|数週間|数か月|数ヶ月|数カ月|数年|[0-9０-９一二三四五六七八九十百]+(?:週間|か月|ヶ月|カ月|年))/u;

/**
 * 場面の途中で時が進んだと読める語（段落の頭ではない所）。
 *
 * これが地の文に出た場面は**終わりが読めない**ので、次の場面が「翌朝」で
 * 始まっても、どの日から数えた翌朝か決められない——鎖を切る。
 * 「馬で三日の道のり」のような**距離の言い方は拾わない**（経過ではない）。
 * 週・月・年は「後」「経った」など経過を言い切る形だけ——「三年目の春」
 * 「三年間門番を務めた」は身の上の説明で、場面の中で時が進んだのではない
 * （旅の台で「騎士団に入って三年目」が鎖を切っていた）。
 */
const ELAPSED_IN_TEXT =
  /[0-9０-９一二三四五六七八九十百数何幾]+(?:日|晩)(?:後|間|が過ぎ|が経|がたっ|経っ|かけ|ぶり|目)|[0-9０-９一二三四五六七八九十百数何幾]+(?:週間|か月|ヶ月|カ月|年)(?:後|が過ぎ|が経|がたっ|経っ|かけ|ぶり)|夜が明け|翌朝|翌日|数日|何日も|幾日も/u;

/**
 * 場面の区切りの行（＊・◇◆・※・―など、記号だけの行）。
 *
 * 「※一日三食で…」のような**注の行**は文字を含むので区切りにしない。
 */
const SEPARATOR_LINE = /^[\s　]*(?:[＊*◇◆□■☆★※―─－・…]+[\s　]*)+$/u;

/**
 * 話の見出しの行（合本で1ファイルに何話も入っているとき）。
 *
 * **見出しを区切りとして扱う**——次の話が印なしで始まれば鎖を切る。
 * 合本の中の2話目以降の日付は読まない（`readStoryDates` は1ファイル＝1話で読む）。
 */
const EPISODE_HEADING =
  /^[\s　]*(?:#+[\s　]*)?第[0-9０-９一二三四五六七八九十百千]+[話章幕節](?:[\s　]|$)/u;

const KANJI_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「三」「十二」「3」「１２」を数にする。読めなければ null */
function parseSmallNumber(text: string): number | null {
  const half = text.replace(/[０-９]/gu, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  if (/^[0-9]+$/u.test(half)) return Number(half);
  const ten = half.indexOf("十");
  if (ten < 0) return half.length === 1 ? (KANJI_DIGITS[half] ?? null) : null;
  const head = half.slice(0, ten);
  const tail = half.slice(ten + 1);
  const tens = head === "" ? 1 : (KANJI_DIGITS[head] ?? null);
  const ones = tail === "" ? 0 : (KANJI_DIGITS[tail] ?? null);
  if (tens === null || ones === null || head.length > 1 || tail.length > 1) {
    return null;
  }
  return tens * 10 + ones;
}

/** 段落の頭の印を読む。印が無ければ null */
export function readHeadMarker(paragraph: string): HeadMarker | null {
  const text = paragraph.replace(/^[\s　]+/u, "");
  if (SIMULTANEOUS.test(text)) return { kind: "simultaneous" };
  for (const rule of NEXT_DAY) {
    if (rule.pattern.test(text)) return { kind: "advance", days: rule.days };
  }
  const later = text.match(DAYS_LATER);
  if (later) {
    const days = parseSmallNumber(later[1]);
    // 読めない数（「二三日後」など）は推し量らず切る
    return days === null ? { kind: "cut" } : { kind: "advance", days };
  }
  if (CUT.test(text)) return { kind: "cut" };
  if (SAME_DAY.test(text)) return { kind: "sameDay" };
  return null;
}

/**
 * 段落の頭で時計が読んだ語と、その読み方を、判定（P-12b）へ渡す1句にする
 * （「「その頃」（前の場面と同じ時と読みました）」）。印が無ければ空文字。
 *
 * 移動の照合の判定（travel 1.0、2026-10-25）は、「その頃」を同じ時と読まずに
 * 「8行目で港町にいるのは移動として成立する」と取り下げた（26b）。時計がその語を
 * どう読んだかを、本文の語のまま見せる。**読みの語は時計の決まり（下の正規表現）と
 * 同じものを使う**——別に書くと、時計と判定の説明がずれる
 */
export function describeTimeCue(paragraph: string): string {
  const text = paragraph.replace(/^[\s　]+/u, "");
  if (isQuotedParagraph(text)) return "";
  const marker = readHeadMarker(text);
  if (!marker) return "";
  // `readHeadMarker` と同じ順に試す（「その日」より先に「その頃」など、読みの順を揃える）
  const word =
    [SIMULTANEOUS, ...NEXT_DAY.map((rule) => rule.pattern), DAYS_LATER, CUT, SAME_DAY]
      .map((pattern) => text.match(pattern)?.[0])
      .find((matched): matched is string => matched !== undefined) ?? "";
  if (!word) return "";
  const meaning =
    marker.kind === "simultaneous"
      ? "前の場面と同じ時"
      : marker.kind === "sameDay"
        ? "前の場面と同じ日"
        : marker.kind === "advance"
          ? `前の場面の${marker.days}日後`
          : "何日経ったか分からない";
  return `「${word}」（${meaning}と読みました）`;
}

/** 頭の印を除いた残り（場面の途中の経過を探すのに使う） */
function restAfterMarker(paragraph: string): string {
  const text = paragraph.replace(/^[\s　]+/u, "");
  for (const pattern of [SIMULTANEOUS, SAME_DAY, DAYS_LATER, CUT]) {
    const matched = text.match(pattern);
    if (matched) return text.slice(matched[0].length);
  }
  for (const rule of NEXT_DAY) {
    const matched = text.match(rule.pattern);
    if (matched) return text.slice(matched[0].length);
  }
  return text;
}

/** 台詞・手紙の引用で始まる段落か。**ここに出る経過の語は地の文の時ではない** */
function isQuotedParagraph(text: string): boolean {
  return /^[「『（(〈《―]/u.test(text);
}

interface OpenSegment {
  chain: string;
  segment: string;
  dayLow: number;
  dayHigh: number;
  /** 場面の途中で時が進んだ。**終わりが読めない**ので、次の場面を続けて数えない */
  endUnknown: boolean;
}

/**
 * 本文の束から時計を組む。
 *
 * **話の順に読む。** 話数の無い本文は最後に回し、前の話からの続きも日付も使わない。
 */
export function buildSceneClock(
  episodes: readonly SceneClockEpisode[]
): SceneClock {
  const readings = new Map<string, Array<SceneClockReading | null>>();
  const stats: SceneClockStats = {
    episodes: episodes.length,
    datedEpisodes: 0,
    markers: { simultaneous: 0, advance: 0, sameDay: 0, cut: 0 },
    unmarkedBreaks: 0,
    clockedLines: 0,
  };

  const ordered = episodes
    .map((episode, index) => ({ episode, index }))
    .sort((a, b) => {
      const chapterA = a.episode.chapter ?? Number.MAX_SAFE_INTEGER;
      const chapterB = b.episode.chapter ?? Number.MAX_SAFE_INTEGER;
      if (chapterA !== chapterB) return chapterA - chapterB;
      return a.index - b.index;
    })
    .map((entry) => entry.episode);

  // **日付は本文だけから読む**（あらすじは渡していない。小さく始める）
  const dated = new Map<number, number>();
  for (const date of readStoryDates(
    ordered
      .filter((episode) => episode.chapter !== null)
      .map((episode) => ({
        chapter: episode.chapter as number,
        text: episode.text,
      }))
  )) {
    dated.set(date.chapter, date.dayNumber);
  }

  let previous: { chapter: number | null; last: OpenSegment | null } | null =
    null;
  let segmentCount = 0;

  for (const episode of ordered) {
    const lines = episode.text.split("\n").map((line) => line.replace(/\r$/u, ""));
    const lineReadings: Array<SceneClockReading | null> = new Array(
      lines.length + 1
    ).fill(null);
    readings.set(episode.filePath, lineReadings);

    const newSegment = (
      base: { chain: string; dayLow: number; dayHigh: number } | null
    ): OpenSegment => {
      segmentCount += 1;
      const segment = `${episode.filePath}#${segmentCount}`;
      return base
        ? { ...base, segment, endUnknown: false }
        : { chain: segment, segment, dayLow: 0, dayHigh: 0, endUnknown: false };
    };

    // 話の頭：日付が読めた話は暦の鎖に載せる（その日のいつかは分からないので幅1日）
    const date =
      episode.chapter !== null ? dated.get(episode.chapter) : undefined;
    let current: OpenSegment | null = null;
    if (date !== undefined) {
      stats.datedEpisodes += 1;
      current = newSegment({
        chain: CALENDAR_CHAIN,
        dayLow: date,
        dayHigh: date + 1,
      });
    }
    /**
     * 前の話の続きとして数えてよい場面。**話数がちょうど1つ前のときだけ**——
     * 間の話が渡っていない（話を絞った実行）のに「翌朝」を前の話から数えると、
     * 抜けた話の日数を落とす
     */
    const carried =
      current === null &&
      previous !== null &&
      previous.chapter !== null &&
      episode.chapter !== null &&
      episode.chapter === previous.chapter + 1
        ? previous.last
        : null;
    // 話の頭は区切りと同じ扱い（印が無ければ新しい鎖）
    let breakPending = current === null;
    /** 区切りの行を見たあとか（話の頭の「新しい鎖」は飛びとして数えない） */
    let separatorSeen = false;
    let base: OpenSegment | null = current ?? carried;

    lines.forEach((raw, index) => {
      const lineNumber = index + 1;
      const text = raw.replace(/^[\s　]+/u, "");
      if (!text) return;
      if (SEPARATOR_LINE.test(raw) || EPISODE_HEADING.test(raw)) {
        breakPending = true;
        separatorSeen = true;
        base = current;
        return;
      }

      const quoted = isQuotedParagraph(text);
      const marker = quoted ? null : readHeadMarker(text);
      if (marker) {
        const anchor = current ?? base;
        if (marker.kind === "cut" || !anchor || anchor.endUnknown) {
          if (marker.kind === "cut") stats.markers.cut += 1;
          else stats.markers[marker.kind] += 1;
          current = newSegment(null);
        } else if (marker.kind === "advance") {
          stats.markers.advance += 1;
          current = newSegment({
            chain: anchor.chain,
            dayLow: anchor.dayLow + marker.days,
            dayHigh: anchor.dayHigh + marker.days,
          });
        } else {
          // 同じ時・同じ日は、前の場面と同じ幅
          stats.markers[marker.kind] += 1;
          current = newSegment({
            chain: anchor.chain,
            dayLow: anchor.dayLow,
            dayHigh: anchor.dayHigh,
          });
        }
      } else if (breakPending || current === null) {
        // **印の無い時間の飛び**。何日飛んだか分からないので鎖を切る
        if (separatorSeen) stats.unmarkedBreaks += 1;
        current = newSegment(null);
      }
      breakPending = false;
      separatorSeen = false;
      base = current;

      const segment = current as OpenSegment;
      if (!quoted && ELAPSED_IN_TEXT.test(restAfterMarker(text))) {
        segment.endUnknown = true;
      }
      lineReadings[lineNumber] = {
        chain: segment.chain,
        segment: segment.segment,
        dayLow: segment.dayLow,
        dayHigh: segment.dayHigh,
      };
      stats.clockedLines += 1;
    });

    previous = { chapter: episode.chapter, last: current };
  }

  return {
    readingAt(filePath, line) {
      return readings.get(filePath)?.[line] ?? null;
    },
    stats,
  };
}
