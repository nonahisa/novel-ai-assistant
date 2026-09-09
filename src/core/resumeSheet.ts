/**
 * 執筆再開の1枚（設計書6.36.1）と、単話プロットの雛形（6.36.2）。
 *
 * **AIを呼ばない。** 押した瞬間に出ることに意味がある機能なので、材料は
 * その場で読めるものだけにしてある（最新話の末尾・各話あらすじ・未回収の
 * 伏線・単話プロット）。待たされるなら、作者は原稿を開いたほうが早い。
 *
 * VS Code APIに依らない純粋関数として置く（`foreshadowMarkdown.ts` と
 * 同じ置き方）。材料を集めるのは `features/resumeWriting.ts` の仕事で、
 * ここは**渡されたものを並べるだけ**である。
 *
 * 単話プロットの雛形もここに置く。**Markdownの記法を書く場所を1か所に
 * まとめる**ためで（`plainTextUi.test.ts` の一覧に載る）、画面の文言を
 * 持つ feature 側へ記法を混ぜない。
 */

/** 最新話の見出しに出すもの。数え方は呼び出し側の設定に従う */
export interface ResumeLatestEpisode {
  /** 「第19話」など。話数が読めないファイルではファイル名を入れる */
  label: string;
  /** 題。無ければ null */
  title: string | null;
  /** 文字数 */
  chars: number;
  /** 数え方の印（総文字数のときだけ「総」。`countModeLabel` の値） */
  countLabel: string;
  /** 末尾の数段落。白紙なら空 */
  tail: string;
}

/** 前話までのあらすじ1件 */
export interface ResumeSynopsis {
  /** 「第18話」など。話数が読めなければ空 */
  label: string;
  title: string | null;
  synopsis: string;
}

/** 未回収の伏線1件 */
export interface ResumeForeshadow {
  label: string;
  /** 張った話数。読み取れなければ null（**推測で埋めない**） */
  plantedChapter: number | null;
  /** 張った箇所の逐語引用。無ければ空 */
  quote: string;
  /** 何を示唆しているか。無ければ空 */
  note: string;
}

/**
 * この話の単話プロット。
 *
 * **「無い」と「置き場が決まらない」を分ける。** 話数が読み取れない話
 * （「プロローグ.txt」など）では `設定/episode-plots/第N話.md` という
 * 名前を作れない。同じ「まだありません」で括ると、押しても作れない案内を
 * 出すことになる。
 */
export type ResumeEpisodePlot =
  /** 中身がある。`body` はファイルの中身そのまま */
  | { kind: "found"; path: string; body: string }
  /** まだ無い。`path` は作られる場所（作者に見せる） */
  | { kind: "missing"; path: string }
  /** 話数が読み取れないので、置き場を決められない */
  | { kind: "unnumbered" };

/**
 * 本文に残っているシーンメモ1件（設計書6.40.5）。
 *
 * **書き始めに前回の付箋が目に入る**ようにするための節である。
 * どの話のどこかが分かればよいので、飛び先ではなく読み物として並べる。
 */
export interface ResumeMemo {
  /** 「第19話」など。話数が読めなければファイル名 */
  label: string;
  /** 1始まりの行番号 */
  line: number;
  tag: string;
  text: string;
}

/** 今日の執筆量と目標。目標が未設定のときは呼び出し側で null にする */
export interface ResumeTodayGoal {
  written: number;
  goal: number;
  remaining: number;
}

export interface ResumeSheetInput {
  workTitle: string;
  /** 最新話。本文が1つも無ければ null */
  latest: ResumeLatestEpisode | null;
  /** 前話までのあらすじ（話数の早い順） */
  synopses: readonly ResumeSynopsis[];
  /** 未回収の伏線。0件なら節ごと出さない */
  openForeshadows: readonly ResumeForeshadow[];
  /**
   * 本文に残っているシーンメモ（設計書6.40.5）。
   *
   * **0件なら節ごと出さない。** 省略できる形にしてあるのは、
   * この1枚を組み立てる試験の材料を全部書き直さずに済ませるためである。
   */
  openMemos?: readonly ResumeMemo[];
  episodePlot: ResumeEpisodePlot;
  /** 今日の目標。取れないときは null（**無理に0を出さない**） */
  todayGoal: ResumeTodayGoal | null;
  /** 読めなかった材料の断り書き。**黙って落とさない** */
  notices?: readonly string[];
}

/** 何話ぶんのあらすじを載せるか。多いと1枚に収まらない */
export const RESUME_SYNOPSIS_COUNT = 3;

/** 末尾から切り出す文字数の目安 */
export const RESUME_TAIL_LIMIT = 400;

/** 単話プロットの置き場（設定フォルダーの下） */
export const EPISODE_PLOTS_DIR = "episode-plots";

/** タブに出す名前。空の案内と揃える（同じ画面として読めるように） */
/**
 * 生成文書の種類（ファイル名の前置き。設計書6.17.7）。
 *
 * **表示用の題（`resumeSheetTitle`）とは分ける。** 置き場が作品ごとに
 * 分かれているのでファイル名に作品名は要らないし、混ぜると古いものを
 * 片付けるときの前置きが作品ごとに変わってしまう。
 */
export const RESUME_SHEET_KIND = "執筆再開";

export function resumeSheetTitle(workTitle: string): string {
  return `${RESUME_SHEET_KIND}：${workTitle}`;
}

/**
 * 再開の1枚を組み立てる。
 *
 * 並びは「いま何字書いたか → 前回どこまで → 前話までのあらすじ →
 * 未回収の伏線 → この話の単話プロット → 次にすること」。
 * **前回の続きを最初に見せる**のが目的なので、要約より先に本文を置く。
 */
export function buildResumeSheet(input: ResumeSheetInput): string {
  const lines: string[] = [`# ${resumeSheetTitle(input.workTitle)}`, ""];

  // 読めなかったものは、先に断る。あとに回すと「まだありません」を
  // 本当だと読んでしまう
  for (const notice of input.notices ?? []) {
    lines.push(`> ${notice}`, "");
  }

  if (input.todayGoal) {
    lines.push(goalLine(input.todayGoal), "");
  }

  lines.push(...latestSection(input.latest));
  lines.push(...synopsisSection(input.synopses));
  lines.push(...foreshadowSection(input.openForeshadows));
  lines.push(...memoSection(input.openMemos ?? []));
  lines.push(...episodePlotSection(input.episodePlot));
  lines.push(...nextStepsSection());

  return lines.join("\n");
}

/**
 * 今日の1行。
 *
 * **この作品で書いた分であることを添える。** 目標（1日）は全作品で
 * 共有する値なので、断らないと「目標に届いていない」と読み違える。
 */
function goalLine(goal: ResumeTodayGoal): string {
  const written = goal.written.toLocaleString("ja-JP");
  const target = goal.goal.toLocaleString("ja-JP");
  const rest =
    goal.remaining > 0
      ? `あと${goal.remaining.toLocaleString("ja-JP")}字`
      : "達成";
  return `今日：${written}/${target}字（${rest}。この作品で書いた分）`;
}

function latestSection(latest: ResumeLatestEpisode | null): string[] {
  const lines = ["## 前回どこまで", ""];
  if (!latest) {
    lines.push(
      "まだ本文がありません。「本文から開始」で第1話を作れます。",
      ""
    );
    return lines;
  }

  const title = latest.title ? `「${latest.title}」` : "";
  const chars = latest.chars.toLocaleString("ja-JP");
  lines.push(`${latest.label}${title}／${latest.countLabel}${chars}字`, "");

  if (!latest.tail.trim()) {
    lines.push("まだ1文字も書かれていません（白紙の話です）。", "");
    return lines;
  }

  // **引用として出す。** 本文には「-」で始まる行も入りうるので、
  // そのまま置くとこの1枚の箇条書きと見分けが付かなくなる。
  // 引用にしておけば、どこからどこまでが原稿かが目で分かる
  for (const line of latest.tail.split("\n")) {
    lines.push(line.length > 0 ? `> ${line}` : ">");
  }
  lines.push("");
  return lines;
}

function synopsisSection(synopses: readonly ResumeSynopsis[]): string[] {
  const lines = ["## 前話までのあらすじ", ""];
  if (synopses.length === 0) {
    // **メニューにある名前で案内する。** 言い換えると、探しても見つからない
    lines.push(
      "まだありません（「各話あらすじを生成」で作れます）。",
      ""
    );
    return lines;
  }

  for (const entry of synopses) {
    const head = [entry.label, entry.title ? `「${entry.title}」` : ""]
      .join("")
      .trim();
    lines.push(head ? `- ${head}：${entry.synopsis}` : `- ${entry.synopsis}`);
  }
  lines.push("");
  return lines;
}

/**
 * 未回収の伏線。
 *
 * **0件なら節ごと出さない。** 一覧（`foreshadowMarkdown.ts`）は
 * 「未回収0件」と書くことに意味があるが、こちらは書き始める前に
 * 見る1枚なので、無いものの見出しで場所を取らない。
 */
function foreshadowSection(records: readonly ResumeForeshadow[]): string[] {
  if (records.length === 0) return [];

  const lines = [`## 未回収の伏線（${records.length}件）`, ""];
  for (const record of records) {
    const planted =
      record.plantedChapter === null
        ? "話数不明で張った"
        : `第${record.plantedChapter}話で張った`;
    lines.push(`- ${record.label}（${planted}）`);
    if (record.note.trim()) lines.push(`  - ${record.note.trim()}`);
    if (record.quote.trim()) {
      lines.push(`  - 引用：「${record.quote.trim()}」`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * 本文に残っているシーンメモ（設計書6.40.5）。
 *
 * **0件なら節ごと出さない**（伏線の節と同じ理由。書き始める前に見る1枚で、
 * 無いものの見出しに場所を取らせない）。
 *
 * **TODO と要確認を上に置く。** 並べ替えるのは呼び出し側ではなくここである
 * ——「上に出す種類」は1枚の見せ方の決めごとで、材料の集め方ではない。
 */
const MEMO_PRIORITY_TAGS = ["TODO", "要確認"];

function memoSection(memos: readonly ResumeMemo[]): string[] {
  if (memos.length === 0) return [];

  const priority = memos.filter((memo) =>
    MEMO_PRIORITY_TAGS.includes(memo.tag)
  );
  const rest = memos.filter(
    (memo) => !MEMO_PRIORITY_TAGS.includes(memo.tag)
  );

  const lines = [`## 残っているメモ（${memos.length}件）`, ""];
  for (const memo of [...priority, ...rest]) {
    const where = `${memo.label} ${memo.line}行目`;
    const body = memo.text.trim() || "（中身がありません）";
    lines.push(`- **${memo.tag}** ${body}（${where}）`);
  }
  lines.push("");
  return lines;
}

function episodePlotSection(plot: ResumeEpisodePlot): string[] {
  const lines = ["## この話の単話プロット", ""];

  if (plot.kind === "unnumbered") {
    lines.push(
      "この話は話数が読み取れないため、単話プロットの置き場を決められません" +
        "（ファイル名に話数を入れると作れます）。",
      ""
    );
    return lines;
  }

  if (plot.kind === "missing") {
    lines.push(
      `まだありません。「単話プロットを作る」で ${plot.path} に雛形を作れます。`,
      ""
    );
    return lines;
  }

  lines.push(`（${plot.path}）`, "", plot.body.trimEnd(), "");
  return lines;
}

/**
 * 末尾の導線。
 *
 * **コマンドへのリンクは置かない。** この1枚は保存していないMarkdownとして
 * 開くので、作者の割り当てしだいで素のテキストとして出る。そこでは
 * `command:` のリンクは文字列のままで、押しても何も起きない
 * （Markdownのプレビューでも、コマンドのURIは既定で止められる）。
 * **押せないリンクを置くより、メニューにある名前をそのまま書く。**
 */
function nextStepsSection(): string[] {
  return [
    "## 次にすること",
    "",
    "- 続きを書く：本文を開いてから「縦書きで開く」。画面の下段に「最新話を書く」があります。",
    "- 単話プロットを作る／開く：操作メニューの「単話プロットを作る」。",
    "",
  ];
}

/**
 * 本文の末尾を、段落の切れ目で切り出す（設計書6.36.1）。
 *
 * **段落の途中では切らない。** 途中から始まる文章は読み直すのに向かず、
 * 「筆の温度を思い出す」という目的に届かない。上限に収まる範囲で、
 * 後ろから段落を足していく。
 *
 * 1段落だけで上限を超えるとき（改行を入れずに書く作者・1行の詩など）は、
 * 文の切れ目で頭を落として「…」を付ける。**切ったことを隠さない。**
 */
export function tailParagraphs(text: string, limit = RESUME_TAIL_LIMIT): string {
  // 改行コードは揃えてから見る（`readTextFile` はLFで返すが、
  // 画面から渡されることもある）。末尾の空行は切り出しの対象にしない
  const body = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!body) return "";

  const lines = body.split("\n");
  const picked: string[] = [];
  let total = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (picked.length === 0 && line.length > limit) {
      return cutInsideParagraph(line, limit);
    }
    // 段落をつなぐ改行も1字として数える。数えないと、返す文字列は
    // 上限をわずかに超える（段落の数だけ超える）
    const cost = line.length + (picked.length > 0 ? 1 : 0);
    if (picked.length > 0 && total + cost > limit) break;
    picked.unshift(line);
    total += cost;
  }

  // 先頭に残った空行は落とす（段落の切れ目そのものは残す）
  return picked.join("\n").replace(/^\n+/, "");
}

/** 1段落が長すぎるときだけ通る道。文の切れ目を探して頭を落とす */
function cutInsideParagraph(paragraph: string, limit: number): string {
  const slice = paragraph.slice(-limit);
  const at = slice.search(/[。！？」]/);
  // 切れ目で落とすと短くなりすぎるなら、そのまま出す
  const body =
    at >= 0 && slice.length - at - 1 >= limit / 2 ? slice.slice(at + 1) : slice;
  return `…${body.replace(/^\s+/, "")}`;
}

/** 単話プロットのファイル名。話数の表記は見出し（`第N話`）と揃える */
export function episodePlotFileName(chapter: number): string {
  return `第${chapter}話.md`;
}

/**
 * ファイル名から話数を読み取る（`episodePlotFileName` の逆）。
 *
 * **作る側の隣に置く。** 名前の決め方を変えたときに、読む側だけが
 * 古いまま残ると「開いているのに、どの話か分からない」が起きる
 * （単話プロットを開いたままAI判定を掛ける道で使う。設計書6.36.3）。
 * 読めなければ null——**推測で埋めない。**
 */
export function episodePlotChapterFromFileName(
  fileName: string
): number | null {
  const matched = /^第(\d+)話\.md$/.exec(fileName);
  if (!matched) return null;
  const chapter = Number(matched[1]);
  return Number.isSafeInteger(chapter) && chapter >= 0 ? chapter : null;
}

/**
 * 単話プロットの雛形（設計書6.36.2）。
 *
 * **AIに筋書きを作らせない。** 3つの問いを置くだけにして、答えるのは
 * 作者にする（6.21.2「作者のものではない話」の教訓）。空欄の書き方を
 * 括弧の問いかけにしてあるのは、消して上書きすれば済むようにするためで、
 * 見出しだけ並べると何を書く欄なのかが分からない。
 */
export function buildEpisodePlotTemplate(chapter: number): string {
  return [
    `# 第${chapter}話の単話プロット`,
    "",
    "## 視点",
    "（この話は誰の視点で語りますか）",
    "",
    "## この話の目標",
    "（この話で何が変わりますか。読者に何を渡しますか）",
    "",
    "## 展開（箇条書き）",
    "- ",
    "- ",
    "- ",
    "",
  ].join("\n");
}
