import type { ChatContextKind } from "../core/chatContext";
import { runnableFeatureList } from "../core/chatEdit";

/**
 * P-21 いま開いている画面について相談する（相談パネル）
 *
 * 設定資料パネルの相談（P-18）は「1つのレコードについて」聞くものだったが、
 * こちらは**作品のどこを見ていても聞ける**。プロット・本文・設定資料・
 * あらすじのどれを開いていても、その文脈を材料に相談できる。
 *
 * **選択肢を返させるのが要点である。** 作者の要望は
 * 「出力が気に入らないときに再考や他の選択肢の検討ができること」だった。
 * 自由入力だけだと、作者が毎回どう言い直すかを考える必要がある。
 * AIに次の一手を3つほど並べさせれば、押すだけで話が進む。
 *
 * プロンプトを変更したら version を上げること。
 */
export const WORK_CHAT_VERSION = "3.0";

/**
 * 起動できる機能の一覧。**実装（chatEdit.ts）から作る。**
 * ここに手で書くと、機能を足したときにプロンプトだけ古くなり、
 * AIが起動できない操作を勧める（実機で起きた）。
 */
const RUNNABLE_LIST = runnableFeatureList();

export const WORK_CHAT_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。
作者が今開いている画面（本文・プロット・設定資料など）について相談を受けます。

【絶対に守る原則】
1. 本文に書かれていることと、そこからのあなたの推測を、必ず区別して書くこと。
   推測は「〜と読める」「〜の可能性がある」のように、推測だと分かる書き方をすること。
2. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを勧めない。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
4. **出来事・数値・固有名詞のような「本文を見れば決まること」**は、渡された材料に
   無ければ「渡された範囲では見当たりません」と答えること。当てずっぽうは邪魔になります。
5. **テーマ・人物の捉え方・足りない設定のような「考えるための問い」は、
   分からないと突き放さないこと。** 原則1のとおり推測だと分かるように書いたうえで、
   読み取れることを述べてください。作者が求めているのは正解ではなく、
   考える手掛かりです。「分かりません」の一言は、いちばん役に立ちません。
6. 作者はプロの書き手です。基礎的な説明を長々と述べないこと。

【答え方】
- reply は日本語で、300字程度までにまとめること。長い説明より、次に何ができるかを示すこと。
- options には「作者が次に選べる一手」を2〜4個入れること。
  押すだけで話が進むよう、**そのまま次の依頼文になる短い文**にすること
  （例:「もっと短くしてほしい」「別の切り口で3案出してほしい」「今の案の理由を説明してほしい」）。
  **見出しや題名を入れないこと。** 「【次のアクションを提案する】」のような
  項目名は、押しても何を頼んだことになるのか分からず、会話が進みません。
  必ず**作者が言いそうな一文**（「〜してほしい」「〜を見せて」）にすること。
- 会話を終えてよい場面では options を空配列にしてよい。
- **options に入れた文を reply の中で繰り返さないこと。** 画面では reply の下に
  options がボタンとして並ぶため、両方に書くと**同じ文が二度表示される**。
  reply には「なぜその選択肢なのか」「どこが分からないか」だけを書き、
  選択肢そのものは options にだけ入れること。
- 「A案・B案・C案」のように案を並べたくなったときも、**案の見出しは reply に
  書かず options に入れる**こと。reply は案を選ぶための前置きだけにする。

【材料が足りないとき】
渡された範囲に答えが無く、**作品の別のファイルを見れば分かる**場合は、
needFiles にそのパスを入れてください（作品フォルダからの相対パス、最大3件）。
その場合 reply には「何を確かめたいか」を短く書いてください。
中身が渡されたうえで、改めて答えることになります。
- 例: ["設定/plot.md", "episode_0003.txt"]
- 見なくても答えられるときは needFiles を空配列にしてください。無駄に読みません。

【書き込みを提案するとき】
作者が「直してほしい」「書いておいて」と求めた場合、edit に書き込む内容を入れてください。
**あなたが書き込むのではなく、作者がボタンを押したときだけ反映されます。**
- target は次のいずれか
  - "plot.logline" "plot.theme" "plot.motif" "plot.worldview" "plot.setting"
    "plot.narrativePerson" "plot.protagonistMotive" "plot.outline" "plot.mainCharacters" "plot.title"
  - "blurb"（作品紹介文） / "catchphrase"（キャッチコピー）
  - "episode.7" のように話数を添えた各話あらすじ
- content はその項目に入る**完成した内容**にすること（差分や指示ではなく、そのまま置き換わる文章）。
- **小説の本文（原稿）は書き換えられません。** 本文の直しを求められたら、
  edit を使わず reply で「本文は誤字脱字の指摘から直してください」と伝えてください。
- 書き込みの提案が無いときは edit を省いてください。

【作業を頼まれたとき】
「抽出して」「あらすじを作って」のように**作業を頼まれたら、必ず run に機能名を
入れてください。** run を入れないと、作者の画面には**押せるボタンが出ません。**
文章で「まず資料抽出をしましょう」と書くだけでは何も起きず、
作者は「やると言ったのに動かない」と感じます。

起動できるのは次のものだけです（作者がボタンを押したときだけ動きます）。

${RUNNABLE_LIST}

**答えることと、ボタンを出すことは両立します。**
その場で分かる範囲を短く答えたうえで、run も付けてください。
ただし**会話の中で作業そのものを終わらせようとしないこと。**
渡された抜粋は作品の一部にすぎず、会話で作った一覧は**漏れがあり、
資料として保存もされません。** 専用の機能は対象を漏れなく処理し、
結果を確認して保存できる画面に出します。

- 一覧に無い操作は run に入れないこと。入れても無視されます
- 手順が複数あるとき（例：抽出してから資料集を出力）は、**最初の1つだけ**を run に入れ、
  続きは終わってから改めて勧めること
- とくに誤字脱字は、会話で「ここが誤字では」と言っても網羅性も適用の導線もありません
- 頼まれていないのに run を付けないこと

【この拡張機能の使い方を聞かれたとき】
末尾に機能の一覧を渡してあります。「どうやるの」「そんな機能ある？」と聞かれたら、
**そこに書いてあることだけを使って**答えてください。
- どの画面のどこを押すか、順に書くこと（例:「操作メニューの『執筆AI支援』→『校正・校閲』→『誤字脱字を検知』」）
- **一覧に無い機能を作り出さないこと。** 無ければ「その機能はありません」と答えるほうが役に立ちます
- AIを使う操作は、料金がかかることを添えること
- 作品の内容について聞かれているときは、この一覧に触れないこと

【本文の場所を指すとき】
「ここが気になる」「この場面が」のように**特定の箇所を指して話すときは、locate を付けてください。**
作者はボタンを押すだけで、その箇所を開いて光らせることができます。
- text には、**本文にそのまま出てくる文字列**を写してください（言い換えない）。
  写し間違えると見つからず、光らせられません。長すぎない一文が適切です。
- 別のファイルの箇所を指すときだけ path を入れてください（作品フォルダーからの相対パス）。
  いま開いているファイルの中なら path は不要です。
- ファイルを開くだけでよいときは text を省いてください。
- 場所を指していないときは locate を付けないこと。

【出力形式】JSONのみ。前置き・後書き・コードフェンスを含めないこと。
{"reply": "...", "options": ["...", "..."], "needFiles": [], "edit": {"target": "...", "content": "...", "label": "..."}, "run": "...", "locate": {"path": "...", "text": "...", "label": "..."}}`;

export interface WorkChatTurn {
  role: "author" | "assistant";
  text: string;
}

export interface WorkChatInput {
  workTitle: string;
  /** いま開いている画面の種類 */
  contextKind: ChatContextKind;
  /** 画面の説明（「第7話の本文」など） */
  contextLabel: string;
  /** 開いているファイルの中身（抜粋） */
  excerpt: string;
  /** 抜粋が途中で切れているか。切れていることをAIに伝える */
  excerptTruncated: boolean;
  /** 作者が範囲を選んで聞いているか */
  fromSelection: boolean;
  /** 作品の材料（登場人物名など）。文脈に応じて呼び出し側が詰める */
  reference: string[];
  /**
   * 前の応答で AI が求めたファイルの中身。
   *
   * これがあるということは「材料が足りない」と言った直後なので、
   * もう一度 needFiles を返させない（同じ問答を繰り返してしまう）。
   */
  requestedFiles?: Array<{ path: string; content: string }>;
  /**
   * いま対話で埋めようとしているプロットの項目（設計書6.4.7）。
   *
   * **これが無いと、書き込み先をAIが当てずっぽうで決める。** 対話で
   * プロットを作るときは、作者の答えがどの項目のものかが決まっている。
   * 決まっていることを推測させない。
   */
  plotFocus?: { heading: string; target: string; purpose: string };
  /** これまでのやり取り。古いものから順に */
  history: WorkChatTurn[];
  question: string;
  /**
   * この拡張機能でできることの一覧（`features/featureGuide.ts`）。
   *
   * **毎回渡す。** 「使い方の質問かどうか」を先に判定して出し分ける手も
   * あるが、判定を外したときに「その機能はありません」と嘘を答えることに
   * なる。答えられないほうが、少し長い入力より害が大きい。
   * 代わりに、作品の相談では触れないようプロンプトで釘を刺している。
   */
  featureGuide?: string;
}

export function buildWorkChatPrompt(input: WorkChatInput): string {
  const blocks: string[] = [`【作品】\n${input.workTitle}`];

  blocks.push(`【いま開いている画面】\n${input.contextLabel}`);

  // **対話でプロットを埋めているときは、書き込み先が決まっている**（6.4.7）。
  // 決まっていることをAIに推測させない
  if (input.plotFocus) {
    blocks.push(
      [
        "【いま埋めている項目】",
        `${input.plotFocus.heading}（${input.plotFocus.purpose}）`,
        "",
        "作者の返事は、この項目についての答えです。",
        `書き込みを提案するときは target を "${input.plotFocus.target}" にしてください。`,
        "**作者が言っていないことを足さないこと。** 言葉を整えるのはよいが、",
        "設定や筋書きをこちらで作らないこと。足りないと感じたら、reply で聞き返してください。",
        "答えがまだ出せない様子なら、無理に書き込みを提案せず、聞き方を変えてください。",
      ].join("\n")
    );
  }

  if (input.excerpt.trim()) {
    const note = input.fromSelection
      ? "作者が選んだ範囲です。ここについての相談だと考えてください。"
      : input.excerptTruncated
        ? "長いため一部だけを抜き出しています。"
        : "";
    blocks.push(
      `【画面の内容】${note ? `\n（${note}）` : ""}\n${input.excerpt.trim()}`
    );
  }

  if (input.reference.length > 0) {
    blocks.push(`【この作品の材料】\n${input.reference.join("\n")}`);
  }

  if (input.requestedFiles && input.requestedFiles.length > 0) {
    const files = input.requestedFiles
      .map((file) => `--- ${file.path} ---\n${file.content}`)
      .join("\n\n");
    blocks.push(
      `【あなたが求めたファイル】\n${files}\n\n` +
        "（これで材料は揃っています。needFiles は空にして、答えを書いてください）"
    );
  }

  if (input.history.length > 0) {
    const history = input.history
      .map((turn) => `${turn.role === "author" ? "作者" : "あなた"}: ${turn.text}`)
      .join("\n");
    blocks.push(`【これまでのやり取り】\n${history}`);
  }

  blocks.push(`【作者からの相談】\n${input.question.trim()}`);

  // 機能の一覧は最後に置く。相談の本題より前に長い一覧があると、
  // 作品の話をしているのに機能の説明を始めることがある
  if (input.featureGuide?.trim()) {
    blocks.push(
      "【この拡張機能でできること（使い方を聞かれたときだけ使う参考資料）】\n" +
        input.featureGuide.trim()
    );
  }

  return blocks.join("\n\n");
}

/**
 * 構造化出力に渡すJSONスキーマ。
 *
 * **全項目を必須にし、nullを許す。** 省略可能にすると、小さいモデルは
 * 面倒な項目を黙って落とす（P-20で分かっていたことで、プロット逆算では
 * これを忘れて実機で項目が空になった、2026-08-15）。
 *
 * とくに `options` が落とされると、**選択肢で会話を進める仕組みそのものが
 * 消える**。「無い」ことを空配列やnullで明示させるほうが確実である。
 */
export const WORK_CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    options: { type: ["array", "null"], items: { type: "string" } },
    needFiles: { type: ["array", "null"], items: { type: "string" } },
    edit: {
      type: ["object", "null"],
      properties: {
        target: { type: "string" },
        content: { type: "string" },
        label: { type: ["string", "null"] },
      },
      required: ["target", "content"],
    },
    run: { type: ["string", "null"] },
    locate: {
      type: ["object", "null"],
      properties: {
        path: { type: ["string", "null"] },
        text: { type: ["string", "null"] },
        label: { type: ["string", "null"] },
      },
    },
  },
  required: ["reply", "options", "needFiles", "edit", "run", "locate"],
} as const;

export interface WorkChatAnswer {
  reply: string;
  options: string[];
  /** AIが読みたがったファイル。呼び出し側で安全なものへ絞る */
  needFiles: unknown;
  /** 書き込みの提案。呼び出し側で解釈し、作者が押したときだけ適用する */
  edit: unknown;
  /** 標準機能の起動の提案。許可した一覧と突き合わせてから使う */
  run: unknown;
  /** 本文の該当箇所を指す提案。呼び出し側で実在を照合する */
  locate: unknown;
}

/**
 * 応答を読み取る。
 *
 * **JSONとして読めなくても捨てない。** 相談は会話なので、形式が崩れても
 * 本文が読めるなら見せたほうがよい。読めなければ全文を返事として扱う。
 */
export function parseWorkChatAnswer(text: string): WorkChatAnswer {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { reply?: unknown }).reply === "string"
      ) {
        const record = parsed as {
          reply: string;
          options?: unknown;
          needFiles?: unknown;
          edit?: unknown;
          run?: unknown;
          locate?: unknown;
        };
        return {
          reply: record.reply.trim(),
          options: Array.isArray(record.options)
            ? record.options
                .filter((item): item is string => typeof item === "string")
                .map(cleanOption)
                .filter(Boolean)
                .slice(0, 4)
            : [],
          needFiles: record.needFiles,
          edit: record.edit,
          run: record.run,
          locate: record.locate,
        };
      }
    } catch {
      // 次の候補を試す
    }
  }

  return {
    reply: text.trim(),
    options: [],
    needFiles: undefined,
    edit: undefined,
    run: undefined,
    locate: undefined,
  };
}

/**
 * 選択肢を、押せる形に整える。
 *
 * **見出しの括弧を外す。** 実機で「【この拡張機能でできること】」
 * 「【次のアクションを提案する】」という項目名が返ってきた（2026-08-15）。
 * ボタンを押すとその文字列がそのまま次の質問として送られるので、
 * 括弧付きの題名のままだと何を頼んだのか分からない会話になる。
 *
 * 中身まで書き換えることはしない。**言い回しはAIの領分**で、
 * こちらが直すと作者の意図と食い違う。括弧を外して読める形にするだけ。
 */
export function cleanOption(text: string): string {
  let value = text.trim();
  // 【…】 や [〜] で囲まれた題名は、囲みだけ外す
  const wrapped = value.match(/^[【\[［]\s*(.+?)\s*[】\]］]$/);
  if (wrapped) value = wrapped[1].trim();
  // 箇条書きの記号や番号が付いてくることがある
  value = value.replace(/^[-*・]\s*/, "").replace(/^\d+[.)．）]\s*/, "");
  return value.trim();
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
