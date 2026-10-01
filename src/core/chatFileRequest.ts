import { findExtensionVariant, pickFileHints, type FileHint } from "./chatEdit";
import { evidenceGrams } from "./guideSelect";
import { EPISODE_SECTION_HEADING, SYNOPSIS_FILE } from "./synopsisDoc";

/**
 * 相談（P-21）で、AIが求めたファイル（`needFiles`）を読んで聞き直すための部品
 * （設計書6.19・6.87.8）。
 *
 * **製品の相談パネル（`features/workChatPanel.ts`）と、MCP の相談
 * （`mcp/tools/chat.ts`）が同じものを通る**（0.85.1）。以前はパネルの中に
 * しか無く、MCP は1往復で止まっていた——AIが `needFiles` を返すとそこで
 * 終わるので、製品で起きる「読めなかったときの聞き直し」（0.84.7）を
 * 外から測れなかった。写しを作ると、読み方・上限・候補の選び方が片方だけ
 * 直ってずれる。
 *
 * ファイルの読み方（`vscode.workspace.fs` か Node の `fs` か）だけは呼ぶ側が
 * 渡す（`RequestedFileAccess`）。**作品フォルダーの外を指していないかの確かめも
 * 読む側の仕事**——パスの形の関門（`sanitizeRequestedPaths`）は通したあとでも、
 * 解決したパスが本当に中かを、読む直前にもう一度見る。
 *
 * `vscode` に依存しない。
 */

/** AIの求めに応じて読むファイルの上限。読みすぎると入力が膨らむ */
export const MAX_REQUESTED_FILES = 3;
/** 1ファイルあたりに渡す上限 */
export const REQUESTED_FILE_CHARS = 6_000;
/**
 * 求められたファイルが見つからなかったとき、代わりに示す候補の数。
 * 目次を全部並べると、219話の作品で数千字になる。番号の近いものを
 * 先に選ぶ（`pickFileHints`）ので、この数で足りる
 */
export const MISSING_FILE_HINTS = 8;
/**
 * 全体像に並べる話数の上限。
 *
 * 219話の作品でそのまま並べると4,000字を超え、
 * 肝心の本文の抜粋が入らなくなる。
 */
export const OVERVIEW_EPISODE_LIMIT = 40;
/** 全体像に載せる紹介文・プロットの上限 */
export const OVERVIEW_FILE_CHARS = 2_000;

/**
 * 材料の見出し。**定数で持つ**——製品は送った量を見出しで分けて測る
 * （`workChatPanel.ts` の `referenceChars`）ので、組む側と測る側で同じ文字を使う。
 */
export const OVERVIEW_HEADING = "【作品の全体像】";
export const CHARACTER_NAMES_HEADING = "登場人物: ";

/**
 * 全体像に載せる設定の文書（`設定/` の下）。**並びもここで決める**。
 * 製品と MCP が同じファイルを同じ順で読むため。
 */
export const CHAT_OVERVIEW_DOCUMENTS: ReadonlyArray<{ label: string; file: string }> = [
  { label: "作品紹介文・各話あらすじ", file: SYNOPSIS_FILE },
  { label: "プロット", file: "plot.md" },
];

/** 求められたファイルを読む口。**作品フォルダーの外は読まない**（呼ぶ側が確かめる） */
export interface RequestedFileAccess {
  /** 作品フォルダーからの相対で1つ読む。外を指す・無い・読めないなら undefined */
  readText(relative: string): Promise<string | undefined>;
  /**
   * そのファイルと同じフォルダーにあるファイルの名前。
   * フォルダーごと無い・読めないなら undefined（拡張子違いを引き当てない）
   */
  siblingNames(relative: string): Promise<readonly string[] | undefined>;
}

/**
 * AIが求めたファイルを読む。
 *
 * **無いファイルは、拡張子だけ違う原稿が1つだけあればそれを読む**
 * （`findExtensionVariant`。2026-09-24、`.txt` を求められて実物は `.md`
 * だった）。それでも読めなかったものは `missing` に入れて返す——以前は
 * 黙って飛ばしており、1つも読めないと作者には何が起きたか分からなかった。
 *
 * @param wanted `sanitizeRequestedPaths` を通した相対パス
 */
export async function readRequestedFiles(
  wanted: readonly string[],
  access: RequestedFileAccess
): Promise<{
  files: Array<{ path: string; content: string }>;
  missing: string[];
}> {
  const files: Array<{ path: string; content: string }> = [];
  const missing: string[] = [];

  for (const relative of wanted) {
    let actual = relative;
    let text = await access.readText(relative);
    if (text === undefined) {
      const names = await access.siblingNames(relative);
      const variant = names ? findExtensionVariant(relative, names) : undefined;
      if (variant) {
        text = await access.readText(variant);
        if (text !== undefined) actual = variant;
      }
    }
    if (text === undefined) {
      missing.push(relative);
      continue;
    }
    // `a.txt` と `a.md` を両方求められ、どちらも `a.md` に行き着くことがある。
    // 同じ中身を2回渡すと入力が膨らむだけなので1回にする
    if (files.some((file) => file.path === actual)) continue;
    files.push({
      path: actual,
      content:
        text.length > REQUESTED_FILE_CHARS
          ? `${text.slice(0, REQUESTED_FILE_CHARS)}\n（以下省略）`
          : text,
    });
  }
  return { files, missing };
}

/**
 * 求められたファイルが見つからなかったとき、AIへ示す候補を組む。
 *
 * **目次（全体像の話の一覧）と同じ一覧から作る**のは呼ぶ側の約束。
 * 別の数え方をすると、全体像には載っているのに候補には無い、という
 * 食い違いが起きる。
 */
export function missingFileHintsFrom(
  missing: readonly string[],
  all: readonly FileHint[]
): { available: FileHint[]; availableTotal: number } {
  return {
    available: pickFileHints(missing, all, MISSING_FILE_HINTS),
    availableTotal: all.length,
  };
}

/**
 * 作品の全体像を、畳んだ形で組み立てる。
 *
 * **全文は渡せない**（78.5万字の作品がある）ので、作品紹介文・プロットの
 * 要点・話数の一覧という「目次」を渡す。どこに何があるかが分かれば、
 * AIは needFiles で必要な話を求められる。
 *
 * **題にファイルの場所を添える。** 題だけだと、AI は needFiles のパスを
 * 当て推量で書き、拡張子や表記を取り違える（2026-09-24、`episode_0001.txt`
 * を求めたが実物は `.md` だった）。
 *
 * @param episodes 話の一覧（作品フォルダーからの相対パスと表示名）。並びは呼ぶ側の走査のまま
 * @param documents `CHAT_OVERVIEW_DOCUMENTS` を読んだ中身。無い・空のものは渡さない
 */
export function formatChatOverview(input: {
  episodes: readonly FileHint[];
  documents: ReadonlyArray<{ label: string; file: string; text: string }>;
  /**
   * 今回の問い（と直前の作者の発言）。**長い各話あらすじから載せる話を選ぶ**
   * ときと、話の一覧の中略から訊かれた話数の辺りを出すときに使う。
   * 渡さなければ、あらすじは作品全体から間を空けて選ぶ。
   */
  focus?: readonly string[];
}): string | undefined {
  const lines: string[] = [];
  const focus = input.focus ?? [];
  const askedNumbers = chapterNumbersIn(focus);

  const total = input.episodes.length;
  if (total > 0) {
    lines.push(`全${total}話。`);
    const labels = input.episodes.map((episode) => `${episode.label}（${episode.path}）`);
    // 多いときは先頭と末尾だけ見せる。**間を省いたことを明記する**
    // （省略に気づかないと「これで全部」と誤解する）
    if (labels.length <= OVERVIEW_EPISODE_LIMIT) {
      lines.push(`話の一覧: ${labels.join(" / ")}`);
    } else {
      const half = OVERVIEW_EPISODE_LIMIT / 2;
      const head = labels.slice(0, half).join(" / ");
      const tail = labels.slice(-half).join(" / ");
      /*
        **訊かれた話数が中略に入るなら、その前後だけ間に出す**（2026-10-01）。

        「第120話で何が起きた？」に答えるには、その話のファイルの場所が要る
        （needFiles で求めるため）。以前は先頭20話と末尾20話しか無く、AIは
        場所を当て推量で書くしかなかった。足すのは前後2話ずつで、量はほぼ変わらない。
      */
      const middle = middleIndexesFor(input.episodes, askedNumbers, half, labels.length - half);
      const around = middle.length > 0
        ? ` …（中略）… ${middle.map((index) => labels[index]).join(" / ")}`
        : "";
      lines.push(`話の一覧（多いため中間を省略）: ${head}${around} …（中略）… ${tail}`);
    }
  }

  for (const document of input.documents) {
    const text = document.text.trim();
    if (!text) continue;
    const picked =
      text.length > OVERVIEW_FILE_CHARS && document.file === SYNOPSIS_FILE
        ? pickSynopsisForFocus(text, focus, askedNumbers)
        : undefined;
    lines.push(
      `【${document.label}（${document.file}）】\n` +
        (picked ??
          (text.length > OVERVIEW_FILE_CHARS
            ? `${text.slice(0, OVERVIEW_FILE_CHARS)}\n（以下省略。全文が要るなら needFiles で求めてください）`
            : text))
    );
  }

  if (lines.length === 0) return undefined;
  return `${OVERVIEW_HEADING}\n${lines.join("\n")}`;
}

/** 問いの中の話数（「第200話」「200話」）。多すぎる指定は先頭の数個だけ見る */
function chapterNumbersIn(sources: readonly string[]): number[] {
  const found: number[] = [];
  for (const source of sources) {
    for (const matched of source.normalize("NFKC").matchAll(/第?\s*(\d{1,5})\s*話/g)) {
      const value = Number(matched[1]);
      if (value > 0 && !found.includes(value)) found.push(value);
    }
  }
  return found.slice(0, 3);
}

/** 訊かれた話の前後に出す話の数（片側） */
const ASKED_NEIGHBORS = 2;

/**
 * 話の一覧の中略（`from`〜`to` の手前）から、訊かれた話数の前後を拾う。
 *
 * 話数は表示名の「第N話」で引き当てる。表示名に話数が無い作品では、
 * 並びの順番（N番目）で代える——走査は話の順に並んでいる。
 */
function middleIndexesFor(
  episodes: readonly FileHint[],
  asked: readonly number[],
  from: number,
  to: number
): number[] {
  const picked = new Set<number>();
  for (const value of asked) {
    let at = episodes.findIndex((episode) => chapterNumberOfLabel(episode.label) === value);
    if (at < 0) at = value - 1;
    for (let index = at - ASKED_NEIGHBORS; index <= at + ASKED_NEIGHBORS; index++) {
      if (index >= from && index < to) picked.add(index);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

function chapterNumberOfLabel(label: string): number | undefined {
  const matched = /第\s*(\d+)\s*話/.exec(label.normalize("NFKC"));
  return matched ? Number(matched[1]) : undefined;
}

/**
 * 長い各話あらすじに載せる作品紹介文の上限。残りを各話あらすじに回す。
 * 紹介文は300〜400字が普通（P-07）なので、この幅で切れることはまず無い。
 */
const OVERVIEW_PREAMBLE_CHARS = 600;

interface SynopsisEntry {
  /** 何番目に出てきたか（並べ直しに使う） */
  order: number;
  chapter: number;
  /** 1行に畳んだ「第N話 題：あらすじ」 */
  line: string;
}

/**
 * 長い各話あらすじ（`synopsis.md`）から、**問いに合わせて話を選ぶ**（2026-10-01）。
 *
 * ## なぜ選ぶか
 *
 * 以前は先頭から2,000字で切っていた。219話の作品では第16話で途切れ、
 * 「塩不足は何話から何話までで解決されますか」にも後半の話を訊く問いにも
 * 答える材料が無かった（Sonnet が内部AIの代わりに撃った測定、
 * docs/measurements/2026-10-01-sonnet-as-internal-ai.md の不具合12）。
 *
 * ## なぜ量を増やさないか
 *
 * 全体像を大きくすると、小さいモデルで読者の宣言（システムプロンプトの末尾）が
 * 押し出される（M7 の測定、2026-10-01-reader-glossary-m7.md）。だから
 * **字数の上限（`OVERVIEW_FILE_CHARS`）は今のまま**にし、選び方だけを変える。
 *
 * ## 選び方（AIは呼ばない）
 *
 * 1. 問いに出てくる話数の前後2話（「第200話あたりで」）
 * 2. 問いの語を含む話（漢字2文字の組み・カタカナの語）。**多くの話に出る語ほど
 *    軽く数える**——主人公の名前はほとんどの話に出るので、それだけでは決め手にならない
 * 3. 余った幅は、作品全体から間を空けて選ぶ（先頭・末尾・真ん中…の順）。
 *    先頭から詰めると、手がかりの無い問いでまた第16話で途切れる
 *
 * 選んだ話は話数の順に並べ直し、**抜き出したことを書く**（全部だと誤解させない）。
 * 各話あらすじの見出しが見つからない文書（作者が手で書いたもの）は
 * undefined を返し、呼ぶ側が今までどおり先頭から切る。
 */
function pickSynopsisForFocus(
  text: string,
  focus: readonly string[],
  askedNumbers: readonly number[]
): string | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sectionAt = lines.findIndex((line) => line.trim() === EPISODE_SECTION_HEADING);
  if (sectionAt < 0) return undefined;

  const entries = parseSynopsisEntries(lines.slice(sectionAt + 1));
  if (entries.length === 0) return undefined;

  let preamble = lines.slice(0, sectionAt).join("\n").trim();
  if (preamble.length > OVERVIEW_PREAMBLE_CHARS) {
    preamble = `${preamble.slice(0, OVERVIEW_PREAMBLE_CHARS)}（紹介文の続きは省略）`;
  }

  const scores = scoreEntries(entries, focus, askedNumbers);
  const ranked = entries
    .filter((entry) => (scores.get(entry.order) ?? 0) > 0)
    .sort((a, b) => (scores.get(b.order) ?? 0) - (scores.get(a.order) ?? 0) || a.order - b.order);
  const focused = ranked.length > 0;

  // 見出しの行の字数を先に見積もって引く。数の桁で数字ぶん揺れるだけ
  const headerOf = (count: number) =>
    `全${entries.length}話のあらすじから${count}話を抜き出しています（` +
    (focused
      ? "問いに近い話を先に選び、残りは作品全体から間を空けて選びました"
      : "作品全体から間を空けて選びました") +
    "。載っていない話の中身が要るなら、needFiles でその話のファイルを求めてください）";
  let budget =
    OVERVIEW_FILE_CHARS - (preamble ? preamble.length + 1 : 0) - headerOf(entries.length).length - 1;

  const chosen = new Set<number>();
  const tryAdd = (entry: SynopsisEntry) => {
    if (chosen.has(entry.order)) return;
    const cost = entry.line.length + 1;
    if (cost > budget) return;
    chosen.add(entry.order);
    budget -= cost;
  };
  for (const entry of ranked) tryAdd(entry);
  for (const index of spreadOrder(entries.length)) tryAdd(entries[index]);

  const body = entries.filter((entry) => chosen.has(entry.order)).map((entry) => entry.line);
  return [...(preamble ? [preamble] : []), headerOf(body.length), ...body].join("\n");
}

/**
 * `## 各話あらすじ` より下を話ごとに分ける。見出しに「第N話」がある行で話が
 * 始まる。章の見出し（話数の無い見出し）と、件数の行は読み飛ばす。
 */
function parseSynopsisEntries(lines: readonly string[]): SynopsisEntry[] {
  const entries: SynopsisEntry[] = [];
  let current: { chapter: number; title: string; body: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const body = current.body.join(" ").trim();
    entries.push({
      order: entries.length,
      chapter: current.chapter,
      line: body ? `${current.title}：${body}` : current.title,
    });
    current = undefined;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const chapter = chapterNumberOfLabel(heading[1]);
      if (chapter !== undefined) current = { chapter, title: heading[1].trim(), body: [] };
      continue;
    }
    if (current && line) current.body.push(line);
  }
  flush();
  return entries;
}

/** 問いに近い話ほど大きい点。0 の話は問いと関係が見えない */
function scoreEntries(
  entries: readonly SynopsisEntry[],
  focus: readonly string[],
  askedNumbers: readonly number[]
): Map<number, number> {
  const scores = new Map<number, number>();
  // 話数の指定は、語の当たりより必ず強くする（訊かれた話そのものだから）
  const NUMBER_WEIGHT = 1000;
  for (const entry of entries) {
    let score = 0;
    for (const value of askedNumbers) {
      const distance = Math.abs(entry.chapter - value);
      if (distance <= ASKED_NEIGHBORS) score = Math.max(score, NUMBER_WEIGHT - distance * 10);
    }
    scores.set(entry.order, score);
  }

  const terms = new Set([...evidenceGrams(focus), ...katakanaWordsIn(focus)]);
  for (const term of terms) {
    const holders = entries.filter((entry) => entry.line.includes(term));
    // **半分を超える話に出る語は数えない。** 主人公の名前や「主人公」の語に
    // 点を付けると、ほぼ全話が同点で並び、先頭から詰めるのと変わらなくなる
    // （説明の束の選び方 `guideSelect.ts` の `withoutCommonGrams` と同じ線）
    if (holders.length === 0 || holders.length * 2 > entries.length) continue;
    // 多くの話に出る語ほど軽い（どの話を指しているかの手がかりにならない）
    const weight = Math.log((entries.length + 1) / holders.length);
    for (const entry of holders) {
      scores.set(entry.order, (scores.get(entry.order) ?? 0) + weight);
    }
  }
  return scores;
}

/** カタカナの語（2文字以上）。人物名・地名は多くがカタカナで、漢字の組みでは拾えない */
function katakanaWordsIn(sources: readonly string[]): string[] {
  const words = new Set<string>();
  for (const source of sources) {
    for (const matched of source.matchAll(/[\p{Script=Katakana}ー]{2,}/gu)) {
      words.add(matched[0]);
    }
  }
  return [...words];
}

/**
 * 作品全体から間を空けて選ぶ順番（先頭・末尾・真ん中・4分の1・4分の3…）。
 * どこで打ち切っても、選んだ話が作品全体に散らばる。
 */
function spreadOrder(count: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  const push = (index: number) => {
    if (index < 0 || index >= count || seen.has(index)) return;
    seen.add(index);
    order.push(index);
  };
  push(0);
  push(count - 1);
  for (let denominator = 2; order.length < count && denominator <= count * 2; denominator *= 2) {
    for (let numerator = 1; numerator < denominator; numerator += 2) {
      push(Math.round((numerator / denominator) * (count - 1)));
    }
  }
  for (let index = 0; index < count; index++) push(index);
  return order;
}
