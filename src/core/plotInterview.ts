import {
  PLOT_SECTIONS,
  isBlankPlotSection,
  type PlotSectionKey,
  type PlotSections,
} from "./plotDoc";

/**
 * 対話式プロット作成（設計書6.4.7。0.86.2 で作り直した）。
 *
 * ## 何をするか
 *
 * 作者が着想を自由に書く。AIはその着想と、ここまでに決まったことを読み、
 * **いま決めると話が一番広がる1点**を選んで、問いを1つだけ出す。問いには
 * 着想から出した具体的な候補を3〜4つ添える。作者は選ぶか、組み合わせるか、
 * 自分で書く。答えを受けて、AIは決まったことを短く確かめ直し、次の1点を尋ねる。
 * **尋ねる順は決めていない**——着想の強いところから掘る。
 *
 * ## AIは候補を出す。決めるのは作者
 *
 * 0.86.1 までの原則は「AIに筋書きを作らせない」で、決まった9項目を順に
 * 尋ね、どの作品でも同じ選択肢（「主人公は決まっています」など）を出していた。
 * 選んでも書ける中身が無く、AIが聞き返し、次へ進むのは「AIが書き込みを
 * 返したとき」だけだったので、**選択肢の往復が延々と続いた**（作者の実機の
 * 報告、2026-09-24 夜「選択肢が延々と出てきてループします。本題が始まらない」
 * 「あまりにかけ離れている」）。
 *
 * いまの原則は**「AIは候補を出す。決めるのは作者」**である。候補を出すのは
 * よい。作者が選ばないまま筋を確定させない。決まったことの記録は**作者の答え
 * そのもの**で、コードが持つ（AIに要約させた内容を決まったこととして扱わない）。
 *
 * ## 書くのは押したときだけ。書かなくても次へ進む
 *
 * `plot.md` へ書くのは「ここまでをプロットに書く」を押したときだけ。
 * **書かないと次の問いが来ない形にしない**——それがループの元だった。
 * 作者が自分で書いた項目は上書きしない（実装ルール2）。
 *
 * ## 入り方は型で選ぶ（2026-09-25）
 *
 * この問答は「着想から掘る」型で、ほかに「場面から広げる」「結末から逆算する」
 * 「型に当てはめる」「項目を順に埋める」がある（`plotDialogueStyles.ts`）。
 * どの型でも上の決まりは変わらない。
 *
 * VS Code API に依存しない。
 */

/** 押すと問答をやめずに `plot.md` へ書く */
export const PLOT_WRITE_OPTION = "ここまでをプロットに書く";

/** いまの問いには答えず、別の1点を尋ねてもらう */
export const PLOT_SKIP_OPTION = "この問いは飛ばす";

/** AIの問いを受け取れなかったとき、もう一度頼む */
export const PLOT_RETRY_OPTION = "別の問いを出してほしい";

/** 問答をやめて、普通の相談へ戻る */
export const PLOT_END_OPTION = "問答を終える";

/** プロットに何か書いてある作品で、それを着想として始める */
export const PLOT_START_FROM_PLOT_OPTION = "プロットに書いてあることから始める";

/**
 * **同じ問いのまま**、もう見せた案と違う候補を出してもらう（何も記録しない）。
 * 作者とリーダーの問答（2026-09-25）で、作者は「もっとアイデアを」と求め、
 * 8案から2案を組み替えて選んだ。候補が3〜4つで尽きると、作者は自分で
 * 書くか飛ばすしかない
 */
export const PLOT_MORE_OPTION = "ほかの案もほしい";

/** 決まったことを、ログライン・人物・世界・構成へまとめてもらう（P-44） */
export const PLOT_SUMMARY_OPTION = "決まったことをまとめる";

/** まとめを見たあと、そのまとめで `plot.md` へ書く */
export const PLOT_WRITE_SUMMARY_OPTION = "このまとめでプロットに書く";

/** まとめを見たあと、書かずに問答へ戻る */
export const PLOT_CONTINUE_OPTION = "問答を続ける";

/**
 * まとめで**AIがつなぐために補った文**の頭に付ける印（P-44）。
 * 印の無い補いは、作者が決めたことと見分けがつかない。作者はこの印で
 * 見分けて、要らなければ消す
 */
export const PLOT_SUPPLEMENT_MARK = "〔補い〕";

/** 最初の返事（着想）を、決まったことの一覧に載せるときの名前 */
export const PLOT_IDEA_TOPIC = "着想";

/**
 * 問答で決めたことを書いてよい項目。
 *
 * **タイトル・形式・ジャンルは書かない。** タイトルは作品を作るときに決め、
 * 形式は作品のタイプ（メニューの並び）を決める値なので、問答の答えを
 * 流し込むと作品の扱いごと変わる（設計書6.4.5・6.70）。
 */
export type PlotDialogueSection = Exclude<PlotSectionKey, "title" | "format" | "genre">;

/** AIへ渡す項目の説明。**目標の文字数と大きな流れは「あらすじ」へ書く** */
export const PLOT_DIALOGUE_SECTIONS: ReadonlyArray<{
  key: PlotDialogueSection;
  note: string;
}> = [
  { key: "logline", note: "ログライン（話を一言で）" },
  { key: "theme", note: "テーマ（読み終えた人に残るもの）" },
  { key: "motif", note: "モチーフ（繰り返し出すもの）" },
  { key: "worldview", note: "世界観（現実と何が違うか・世界の仕組み）" },
  { key: "setting", note: "舞台（話が主に動く場所）" },
  // 「主人公は誰か」を人称へ書いた（手元の gemma4:e4b、2026-09-25）。
  // 人称は書き方の形だけ、誰の話かは主要登場人物、と言い分ける
  { key: "narrativePerson", note: "人称（一人称・三人称のどれで書くか。書き方の形だけ）" },
  { key: "protagonistMotive", note: "主人公の行動原理（なぜ動くか）" },
  {
    key: "outline",
    note: "あらすじ（事件の並び・山場・どんでん返し・目標の文字数・構成）",
  },
  { key: "mainCharacters", note: "主要登場人物（主人公は誰か・立場・外せない人・敵）" },
];

/** 着想を書くのは「あらすじ」の頭。一言の形になっていないことが多いので、ログラインには入れない */
export const PLOT_IDEA_SECTION: PlotDialogueSection = "outline";

export function isPlotDialogueSection(value: string): value is PlotDialogueSection {
  return PLOT_DIALOGUE_SECTIONS.some((section) => section.key === value);
}

/** 決まったこと1件。**answer は作者の答えそのもの**（AIの要約ではない） */
export interface PlotDecision {
  topic: string;
  answer: string;
  section: PlotDialogueSection;
}

/** 尋ねた1点。同じ問いを二度出さないために、すべて覚えておく */
export interface PlotAskedPoint {
  topic: string;
  question: string;
  /** 作者が「この問いは飛ばす」を押した */
  skipped: boolean;
}

/**
 * AIの問い1回分を、画面に出す文にする。
 *
 * 確かめ直し（1〜2行）→【決める1点】問い →（なぜ決めるか）→ 候補と
 * 「選ぶと話がどう変わるか」の順。**何を訊いていて、なぜ訊くのか**を
 * 毎回見せる——選択肢だけが続くと、何のための問答か分からなくなる
 * （0.86.1 の作者の報告）。
 *
 * **候補ごとの変わることは本文に並べる。** 札は候補の文だけ（押すと
 * その文がそのまま答えになる）なので、札に混ぜると答えに入ってしまう。
 *
 * @param first 最初の問いか。答え方の案内は最初の1回だけ添える
 * @param more 「ほかの案もほしい」への答えか。問いは同じなので、案だけ見せる
 * @param progress 型・項目を順に埋めるときの、いまどこか（「［起承転結 2/4］」）
 */
export function describePlotTurn(
  turn: {
    confirm: string;
    topic: string;
    question: string;
    why: string;
    candidates?: ReadonlyArray<{ text: string; effect: string }>;
  },
  first: boolean,
  more = false,
  progress?: string
): string {
  const lines: string[] = [];
  if (more) {
    lines.push(`【${turn.topic}】のほかの案です。`);
  } else {
    if (turn.confirm) lines.push(turn.confirm, "");
    if (progress) lines.push(progress);
    lines.push(`【${turn.topic}】${turn.question}`);
    if (turn.why) lines.push(`（${turn.why}）`);
  }
  const candidates = turn.candidates ?? [];
  if (candidates.some((candidate) => candidate.effect)) {
    lines.push(
      "",
      ...candidates.map((candidate) =>
        candidate.effect ? `・${candidate.text} → ${candidate.effect}` : `・${candidate.text}`
      )
    );
  }
  if (first) {
    lines.push(
      "",
      "下の候補から選ぶか、組み合わせたり自分の言葉で書いたりして送ってください。"
    );
  }
  return lines.join("\n");
}

/**
 * まとめ（P-44）を見せる文。**補いの印の意味と、戻したものを言う。**
 * 書くのは「このまとめでプロットに書く」を押したときだけ。
 *
 * @param restored まとめから抜けていたので、作者の言葉のまま戻した決まったこと
 * @param marked AIが印を付け忘れた補いに、コードが印を付けた行の数
 */
export function describePlotSummary(
  contents: ReadonlyMap<PlotDialogueSection, string>,
  restored: readonly PlotDecision[],
  marked = 0
): string {
  const lines = [
    `決まったことを、プロットの項目にまとめました。${PLOT_SUPPLEMENT_MARK}はAIがつなぐために補った所です（要らなければ消してください）。`,
  ];
  for (const section of PLOT_SECTIONS) {
    const content = contents.get(section.key as PlotDialogueSection);
    if (!content) continue;
    lines.push("", `【${section.heading}】`, content);
  }
  if (marked > 0) {
    lines.push(
      "",
      `（決まったことに無い中身が${marked}か所あったので、${PLOT_SUPPLEMENT_MARK}を付けました）`
    );
  }
  if (restored.length > 0) {
    lines.push(
      "",
      `（まとめから抜けていた決まったことを、あなたの言葉のまま戻しました：${restored
        .map((item) => item.topic)
        .join("・")}）`
    );
  }
  lines.push(
    "",
    `「${PLOT_WRITE_SUMMARY_OPTION}」を押すと書きます（あなたが書いた項目は上書きしません）。`
  );
  return lines.join("\n");
}

/**
 * 問答を終えたときの一言。**決まったことを一覧で残す。**
 * `plot.md` へ書いていないものも、会話に残っていれば写せる。
 */
export function describePlotDialogueEnd(decisions: readonly PlotDecision[]): string {
  if (decisions.length === 0) return "問答を終えました。";
  return [
    "問答を終えました。ここまでに決まったことです。",
    ...decisions.map((item) => `・${item.topic}：${item.answer}`),
    `（plot.md に書いたのは「${PLOT_WRITE_OPTION}」を押したぶんだけです）`,
  ].join("\n");
}

/** 前後の空白と鉤括弧を落とす。手で打たれた選択肢の文言を照合するため */
function unquote(text: string): string {
  return text.trim().replace(/^[「『]|[」』]$/gu, "").trim();
}

/**
 * 作者の返事が、その札の文言か。
 *
 * **ゆるく当てない。** 「飛ばす」を含むだけで拾うと、「この話は時間を
 * 飛ばす構成です」という答えが飛ばしになる。
 */
export function isOptionReply(text: string, option: string): boolean {
  return unquote(text) === option;
}

/**
 * 候補の文が、答えではなく**AIへの頼み**か。
 *
 * 相談（P-21）の決まりは、選択肢を「〜してほしい」という依頼文にさせている。
 * 小さいモデルはその癖を持ち込み、問答の候補にも依頼文を返す（手元の
 * gemma4:e4b で実際に「主人公の具体的な立場や動機を教えてほしい」が返った）。
 * 押されると作者の答えとして記録されるので、ここで落とす。
 *
 * **「〜たい」だけでは当てない。** 「妹を守りたい」は行動原理の答えとして
 * 正しい。頼みに決まって現れる言い回しだけを見る。
 */
export function isRequestLikeOption(text: string): boolean {
  const body = unquote(text).replace(/[。．.！!]+$/u, "");
  if (/[？?]$/u.test(body)) return true;
  if (/(ほしい|欲しい)/u.test(body)) return true;
  /*
    **候補そのものではなく、候補の出し方を言っている文**（手元の gemma4:e4b、
    2026-09-25）。「A案をベースに、より『サスペンス』を深める方向で候補を出す」
    が候補として返った。答えに「候補」や「A案」という言葉が入ることはまず無い
  */
  if (/候補/u.test(body)) return true;
  if (/(^|[^一-龠])[A-ZＡ-Ｚ0-9０-９一二三]案|案[A-ZＡ-Ｚ0-9０-９]/u.test(body)) return true;
  return /(ください|下さい|いただけますか|頂けますか|見せて|教えて|考えて|出して|書いて|直して|作って|挙げて|してみて|知りたい|考えたい|進めたい|決めたい|聞きたい|相談したい|深掘りしたい)$/u.test(
    body
  );
}

/**
 * 中身が、**置き場所の案内や伏せ字だけ**か。
 *
 * 手元の gemma4:e4b は「（ここに最終決定したログラインが入ります）」を
 * 書き込みとして返し、それがそのままプロットへ書かれた（0.86.1）。**指示の
 * 言葉は答えの中身として返ってくる**（CLAUDE.md の繰り返し起きた失敗3）。
 * 相談の書き込み（`chatEdit.ts`）もここを通す。
 */
export function isPlaceholderContent(text: string): boolean {
  const body = text.trim();
  if (!body) return true;
  // 全体が括弧でくるまれている（「（ここに〜）」「【未定】」）
  if (/^[（(【［\[〈<].*[）)】］\]〉>]$/su.test(body)) return true;
  if (/ここに.{0,40}(入ります|入る|入れ|書き|書く|記入)/su.test(body)) return true;
  // 伏せ字（「〇〇が××する話」）。型を返しただけで、中身が無い
  return /[〇○◯]{2}|[×✕]{2}|[＊*]{3}/u.test(body);
}

/**
 * 決まったことを、項目ごとの中身に組む。
 *
 * - 1項目に1件で、名前が項目の見出しと同じなら、答えだけを書く
 * - それ以外は「名前：答え」。**何についての答えかを残す**——「回線が
 *   魔力を運ぶ」だけでは、読み返したときに何の答えか分からない
 * - 2件以上、または箇条書きの項目（あらすじ・主要登場人物）は `- ` を付ける
 *
 * **同じ名前で2度答えたら、あとの答えを使う**（言い直しを重ねて書かない）。
 */
export function composeSectionContents(
  decisions: readonly PlotDecision[]
): Map<PlotDialogueSection, string> {
  const grouped = new Map<PlotDialogueSection, Map<string, string>>();
  for (const decision of decisions) {
    const answer = decision.answer.trim();
    if (!answer) continue;
    const bucket = grouped.get(decision.section) ?? new Map<string, string>();
    // 言い直しは前のものを消してから積む（並びは最後に答えた順）
    bucket.delete(decision.topic);
    bucket.set(decision.topic, answer);
    grouped.set(decision.section, bucket);
  }

  const contents = new Map<PlotDialogueSection, string>();
  for (const [section, bucket] of grouped) {
    const heading = PLOT_SECTIONS.find((item) => item.key === section)?.heading;
    const list = PLOT_SECTIONS.find((item) => item.key === section)?.list ?? false;
    const entries = [...bucket.entries()];
    if (entries.length === 1 && !list) {
      const [topic, answer] = entries[0];
      contents.set(section, topic === heading ? answer : `${topic}：${answer}`);
      continue;
    }
    contents.set(
      section,
      entries
        .map(([topic, answer]) =>
          topic === heading ? `- ${answer}` : `- ${topic}：${answer}`
        )
        .join("\n")
    );
  }
  return contents;
}

/** 書く計画。書かなかった項目も、中身ごと作者へ見せる（黙って捨てない） */
export interface PlotWritePlan {
  write: Array<{ section: PlotDialogueSection; content: string }>;
  /** 作者が自分で書いていたので書かなかった項目 */
  kept: Array<{ section: PlotDialogueSection; heading: string; content: string }>;
}

/**
 * どの項目を書くか決める（実装ルール2「作者が書いたデータを上書きしない」）。
 *
 * 書いてよいのは、**まだ空の項目**と、**この問答が前に書いたまま**の項目だけ。
 * 後者を許すのは、同じ問答で2度目に書いたとき、1度目に書いた中身を
 * 「作者の記述」と取り違えて先へ進めなくなるため。作者が手で直していれば、
 * 中身が前に書いたものと違うので書かない。
 *
 * @param written この問答が前に書いた中身（項目 → 書いた文）
 */
export function planPlotWrite(
  decisions: readonly PlotDecision[],
  current: PlotSections,
  written: ReadonlyMap<PlotSectionKey, string>
): PlotWritePlan {
  return planSectionWrite(composeSectionContents(decisions), current, written);
}

/**
 * 項目ごとの中身から、書く計画を立てる。決まったこと（`planPlotWrite`）と
 * まとめ（P-44）の**両方がここを通る**——上書きしない決まりを2か所に書かない。
 */
export function planSectionWrite(
  contents: ReadonlyMap<PlotDialogueSection, string>,
  current: PlotSections,
  written: ReadonlyMap<PlotSectionKey, string>
): PlotWritePlan {
  const plan: PlotWritePlan = { write: [], kept: [] };
  for (const [section, content] of contents) {
    const now = current[section] ?? "";
    // 同じ中身ならもう書いてある。書き直すと更新時刻だけ動く
    if (now.trim() === content.trim()) continue;
    const ours = written.get(section);
    if (isBlankPlotSection(now) || (ours !== undefined && ours.trim() === now.trim())) {
      plan.write.push({ section, content });
    } else {
      const heading =
        PLOT_SECTIONS.find((item) => item.key === section)?.heading ?? section;
      plan.kept.push({ section, heading, content });
    }
  }
  return plan;
}

/**
 * 書いてある項目だけを「【見出し】中身」で並べる（AIへ渡す材料）。
 *
 * **作者が自分で立てた見出し（`extra`）も渡す。** 「## 着想」のように、
 * 決まった項目の外に書いた着想こそ、問答の出発点になる。雛形の案内
 * （HTMLコメント）は落とす——AIが案内を作者の記述と読むと、決まって
 * いないことを決まったこととして話を進める。
 */
export function describeWrittenPlot(sections: PlotSections, extra = ""): string {
  const strip = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "").trim();
  const lines = PLOT_SECTIONS.filter(
    (section) => !isBlankPlotSection(sections[section.key] ?? "")
  ).map((section) => `【${section.heading}】${strip(sections[section.key])}`);
  const rest = strip(extra);
  if (rest) lines.push(rest);
  return lines.join("\n");
}
