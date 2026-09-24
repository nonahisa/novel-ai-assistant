// `MIN_EVIDENCE_HITS`（束選びのしきい値）はここでは使わない。手順書きは
// 1組みで通す（`PROCEDURE_MIN_HITS`）。理由はその定数の説明にある
import { countGramHits, evidenceGrams } from "./guideSelect";

/**
 * 手順書き——よくある仕事の「順番と判断」（作者の指示、2026-09-18）。
 *
 * ## なぜ要るのか
 *
 * 相談へ渡していたのは「何ができるか」の説明だけだった（`featureGuide.ts`
 * の目次と束）。だが作者はプログラマではないので、**操作の一覧を渡されても
 * 順路が分からない。** 「誤字脱字を検知」があることは分かっても、その前に
 * 何をしておくのか、掛けたあと何を見て次へ進むのかは、どこにも書いていない。
 *
 * そこで `.claude/skills/` と同じ考え方のものを持つ。1つの仕事について、
 * **どの操作を、どの順で押し、次へ進む前に何を見るか**を書いたものである。
 *
 * ## 新しく考え出さない
 *
 * 並べるのは、簡単ステップメニュー（`views/stepMenu.ts` の `STEP_MENU`）と
 * 詳細メニュー（`views/actionList.ts` の `ACTION_TREE`）に既にある道だけに
 * する。ここで新しい順路を考え出すと、画面のどこにも無い手順を案内すること
 * になり、作者は探しても見つけられない。
 *
 * ## 操作の名前は持たない。コマンドIDで指すだけにする
 *
 * 名前・補足・前提は、すべて `ACTION_TREE` にあるものを呼び出し側が引いて
 * 渡す（`ProcedureActionLookup`）。ここへ名前を書き写すと、操作を改名した
 * ときに手順書きだけが古くなり、しかも画面を見比べるまで気づけない
 * ——`stepMenu.ts` がコマンドIDの参照だけを持つのと同じ決まりである。
 *
 * ## ここに `vscode` を持ち込まない
 *
 * 名前を引くのは `views` の仕事なので、この層は関数で受け取る形にしてある。
 * `core` から `views` を指すと依存の向きが逆流し、外（MCP・テスト）から
 * この判断だけを測れなくなる。
 *
 * ## 毎回送るので、短くする
 *
 * 相談は1回ごとに全部送るので、足した分だけ毎回払う。目安は
 * **1本あたり600字**（`PROCEDURE_CHAR_LIMIT`）。収まらないときは
 * 上限を上げるのではなく、段を減らすか、理由と見どころを短くする
 * ——上限を上げ続けると「送る量が機能数に比例する」行き止まり
 * （設計書6.27）へ戻る。
 */

/** 手順書きの1段 */
export interface ProcedureStep {
  /** 押す操作のコマンドID。名前はここに書かない（`ACTION_TREE` から引く） */
  readonly command: string;
  /** なぜそれをするのか。作者に見せる一文（句点は付けない） */
  readonly why: string;
  /** 次へ進む前に何を見るか。作者に見せる一文（句点は付けない） */
  readonly check: string;
}

export interface Procedure {
  /** 記録に残すときの鍵 */
  readonly key: string;
  /** 題。何の仕事かを短く言い切る */
  readonly title: string;
  /**
   * どんなときに読むか。
   *
   * **話題との結びつけに使う文でもある**（`selectProcedure`）。質問に出て
   * きそうな漢字の言葉（誤字脱字・表記ゆれ・設定資料・投稿など）を入れて
   * おくこと——当たりの判定は漢字2文字の組みで行うので、言い換えた柔らかい
   * 表現しか書いていないと、どの質問にも当たらない。
   */
  readonly whenToRead: string;
  /** 順番のある段。並びがそのまま作業の順序である */
  readonly steps: readonly ProcedureStep[];
}

/** 1本あたりの字数の目安。組み上げたあとの字数で測る */
export const PROCEDURE_CHAR_LIMIT = 600;

/**
 * 手順書きの一覧。
 *
 * **まず5本だけ**にしてあった。作者が実際に通る道
 * （`STEP_MENU` の 1→2、1→3、4、4、5）から選んだ。増やすときは、
 * 本当に繰り返し通る仕事かどうかを確かめること——使われない手順書きも、
 * 選ばれなければ0字だが、選ばれてしまえば毎回払う。
 *
 * 6本目（`readerTarget`）は、**無かったために相談が壊れた**ので足した
 * （0.74.12）。読者の話に当たる手順が1本も無く、「画面で案内してもらう」の
 * ボタンが出ないまま、AIが実在する操作を「ありません」と答えた。
 */
export const PROCEDURES: readonly Procedure[] = [
  {
    key: "newWork",
    title: "新しい作品を始める",
    // ステップ1（作品登録）→ 2（新作構想）→ 3（執筆の場）の道
    // 「登場人物の名前の重なり」と書いていたが、**「人物」1組みで
    // 『この人物の動機がぼやけている』のような作品の相談を引き当てた**
    // （しきい値を1にしたときの唯一の誤検出。2026-09-21）。
    // 点検しているのは名前の響きなので、そちらへ寄せて意味は変えない
    whenToRead:
      "新規作品の登録から、プロットの作成・形式とジャンルの決定・" +
      "名前の響きの重なりの点検まで、新作の構想を立てて書き始めるとき",
    steps: [
      {
        command: "novelai.createWorkWithPlot",
        why: "作品フォルダーとプロットの雛形を一度に作れる",
        check: "設定/plot.md ができて、作品一覧に並ぶ",
      },
      {
        command: "novelai.setPlotBasics",
        why: "形式で使える操作が変わるので、先に決めておく",
        check: "メニューの並びがその作品に合う",
      },
      {
        command: "novelai.plotInterview",
        // 0.86.2 で問答に作り直した（設計書6.4.7）。AIは候補を出し、決めるのは作者
        why: "着想を書くと、AIが1点ずつ候補を添えて尋ねる。決めるのは作者",
        // 「」はメニュー名を引くときだけに使う（`sceneGuide.test.ts`）。問答の札は括弧で
        check: "問答の札（ここまでをプロットに書く）で plot.md に入る。問いは飛ばしてよい",
      },
      {
        command: "novelai.checkNames",
        why: "響きの重なりは、増えてから直すより付けるときのほうが安い",
        check: "似た名前の組が出る。直すかどうかは作者が決める",
      },
      {
        command: "novelai.createEpisodePlot",
        why: "1話ぶんの展開を決めてから書くと、途中で迷わない",
        check: "視点・目標・展開が書けたら、本文を書き始める",
      },
    ],
  },
  {
    key: "importWork",
    title: "書いてある作品を登録して整える",
    // ステップ1（作品登録）→ 3（資料生成）の道
    /*
      **「本文」と「人物」を、わざと書いていない**（2026-09-21）。

      - 「本文」：『設定と本文が食い違っていないか』が、ここと「矛盾を洗う」に
        同じ点で当たり、**並びが先のこちらが勝っていた**。抽出のもとは原稿
        なので、そう書けば意味を変えずに取り違えが消える
      - 「人物」：作品の相談（『この人物の動機が…』）を引き当てるので、
        「登場する相手」にした。**「重複」は残す**——ここを外すと
        『人物の重複を整えたい』が当たらなくなる
    */
    whenToRead:
      "すでに書いてある原稿のフォルダーを作品として登録し、そこから設定資料を" +
      "抽出して、登場する相手の重複を整えるとき",
    steps: [
      {
        command: "novelai.addWork",
        why: "すでにある原稿のフォルダーを、そのまま覚えさせる",
        check: "作品一覧に話数が並ぶ。並ばなければファイル名の形を見る",
      },
      {
        command: "novelai.extractSettings",
        why: "人物・場所・組織・世界観を、本文から一度に取り出せる",
        check: "承認待ちの件数が出る。この時点では資料はまだ変わらない",
      },
      {
        command: "novelai.unifyCharacters",
        why: "同じ人物が呼び方違いで二重に立つことがある",
        check: "重複の候補が0になる。別人なら、まとめずに残す",
      },
      {
        command: "novelai.applyPendingUpdates",
        why: "承認するまで資料は変わらない。ここで初めて入る",
        check: "未反映の件数が0になる",
      },
      {
        command: "novelai.openSettingsPanel",
        why: "AIの取り違えは、作者にしか見分けられない",
        check: "誤りがあればその場で直す。以降の検知の土台になる",
      },
    ],
  },
  {
    key: "polish",
    title: "推敲して仕上げる",
    // ステップ4（自己校正）の、文の直しの側
    whenToRead:
      "誤字脱字・表記ゆれ・推敲・冒頭の診断など、書いた本文を人に見せる前に" +
      "自分で直すとき",
    steps: [
      {
        command: "novelai.runProofreadingSuite",
        why: "誤字脱字・表記ゆれ・推敲を一度に掛けられる",
        check: "提案パネルに指摘が並ぶ。1件ずつ適用か無視を決める",
      },
      {
        command: "novelai.manageKeepWords",
        why: "方言や口癖が毎回指摘されるなら、直さない語として登録する",
        check: "次からその語は指摘されない",
      },
      {
        command: "novelai.checkOpening",
        why: "読者が離れるのは冒頭なので、最後にもう一度そこだけ見る",
        check: "診断の紙が開く。直すかどうかは作者が決める",
      },
    ],
  },
  {
    key: "consistency",
    title: "矛盾を洗う",
    // ステップ4（自己校正）の、話の整合の側
    whenToRead:
      "設定資料と本文の食い違いの検知、プロットからの逸脱、伏線の回収漏れを" +
      "確かめるとき",
    steps: [
      {
        command: "novelai.extractSettings",
        why: "照らし合わせる相手が無いと、AIは本文だけを見て矛盾を作り出す",
        check: "人物・場所・世界観が揃う。すでに揃っているなら飛ばす",
      },
      {
        command: "novelai.checkContradictions",
        why: "設定と本文のどちらが古いかは、作者にしか決められない",
        check: "設定ではこう／本文ではこうが並ぶ。直す側を選ぶ",
      },
      {
        command: "novelai.checkDeviations",
        why: "筋がプロットから離れていないかは、矛盾とは別の物差しで見る",
        check: "プロットに無い展開が出る。プロットのほうが古いこともある",
      },
      {
        command: "novelai.checkForeshadowResolution",
        why: "置いた伏線を回収し忘れていないかを、最後に確かめる",
        check: "未回収の伏線が出る。次の話で回収するなら、そのままでよい",
      },
    ],
  },
  {
    key: "posting",
    title: "投稿の準備をする",
    // ステップ5（投稿脱稿）の道
    whenToRead:
      "新話を投稿する前に、各話あらすじ・作品紹介文・キャッチコピーを整えて、" +
      "本文を投稿サイトの形に直すとき",
    steps: [
      {
        command: "novelai.generateSynopses",
        why: "あらすじは紹介文の材料にもなるので、先に作る",
        check: "話ごとのあらすじが並ぶ。本文を変えていない話は作り直さない",
      },
      {
        command: "novelai.generateWorkBlurb",
        why: "作品全体の紹介文は、あらすじが揃ってからのほうが正確になる",
        check: "字数は投稿サイトごとの上限に収まっているか",
      },
      {
        command: "novelai.generateCatchphrases",
        why: "紹介文の1行目に置く言葉を、別に選べる",
        check: "案から1つ選ぶ。作者が書き直してよい",
      },
      {
        command: "novelai.copyForPosting",
        why: "ルビと傍点を、投稿サイトが読める書き方へ直す",
        check: "貼り付け先で、ルビが崩れていないかを見る",
      },
      {
        command: "novelai.postNewEpisode",
        why: "変換・コピー・ページを開く・記録までをひと続きにできる",
        check: "送信のボタンは必ず作者が押す",
      },
    ],
  },
  {
    /*
      **1段しか無い手順書きである**（0.74.12。作者の実機報告、2026-09-21）。

      未診断の作品に渡している1行を見た作者が相談で「実行して」と頼み、
      AIは「実行します。完了したら…」と答え、次に「そんな機能は用意されて
      いません」と答えた。**操作は実在する。** 「画面で案内してもらう」の
      ボタンが出なかったのは、読者の話に当たる手順書きが1本も無かったため。

      段が1つでも、**押す場所と、何を見れば終わったと言えるか**は要る。
      それが無いと、AIは名前だけを伝えて終わってしまう。
    */
    key: "readerTarget",
    title: "ターゲット読者を決める",
    // **「読者」を持つのはこの1本だけ**にしてある。ほかの手順へ書くと、
    // 読者の相談がそちらへ吸われる（しきい値は1組み）
    /*
      **いまの入口の名前で書く**（2026-09-25 深夜の実接続の測定）。

      以前は旧名（「ターゲット読者診断」で〜）で始めていた。この文は題と一緒に
      AIへそのまま渡るので、**AIが旧名を写して案内した**（e4b が2回とも、
      26b が選択肢で）。旧名は詳細メニューから外してあり、作者は探せない。

      **「読者診断」の4字も続けて書かない。** 小分類の名前と入口の名前を
      並べて書いたら（「読者診断にある「ターゲット読者」」）、e4b は2つを
      つないで旧名を作った。旧名の入口は目次からも外してある（`supersededBy`）。

      それでも「診断」は残す。旧名で頼まれることが実際にあり（「ターゲット
      読者診断を実行して」）、この手順書きがいまの入口へ導く唯一の道になった。
      その問いの組みは「読者」「者診」「診断」「実行」で、ここは「読者」
      「診断」の2つに当たり、冒頭の診断を持つ `polish`（「診断」の1つ）に勝つ。
    */
    whenToRead:
      "読者層・読者型を診断して決めるとき、" +
      "この作品を誰に向けて書いているかを確かめるとき",
    /*
      **押す先は「ターゲット読者」**（設計書6.108.6。入口を1つにした）。
      旧「ターゲット読者診断」は詳細メニューから外したので、画面で指す
      案内（6.104）が指せない。
    */
    steps: [
      {
        command: "novelai.openTargetReader",
        why: "狙い・書き方の判断・本文の実像の3段で、この作品の読者が決まる",
        check: "1枚のシートが開き、11通りの区分との一致度が出る。作品ごとに覚える",
      },
    ],
  },
  {
    /*
      ターゲットシート（設計書6.108）。**読者の手順書きを2本に分けてある。**

      上の1本は「区分を1つ決める」ところまでで終わる。こちらは**決めた
      あと**——狙いと実態を突き合わせ、広げるか絞るかを決める仕事である。
      同じ1本にまとめると600字に収まらず、しかも**当たりの文が混ざって**
      どちらの話でも同じ紙が出る。

      **「診断」を書かない。** 上の1本が持つ言葉なので、ここへ書くと
      「ターゲット読者診断を実行して」がこちらへ吸われる（しきい値は1組み）。
    */
    key: "targetSheet",
    title: "狙いと実態のずれを見る",
    whenToRead:
      "ターゲットシートで、狙いと実態のずれや、各読者層との一致度を見るとき、" +
      "読者層を広げる・絞るの向かう先を決めるとき",
    // 押す先は「ターゲット読者」（6.108.6。旧「ターゲットシート」は
    // 詳細メニューから外し、押すと「ターゲット読者」を開く転送にした
    // ——2026-09-23。紙は同じものが開く）
    steps: [
      {
        command: "novelai.openTargetReader",
        why: "狙いと実態の一致度、広げる・絞るの向かう先が1枚に出る",
        check: "1段目で狙いを選び直すと、シートの推移に1行増える",
      },
    ],
  },
];

/** 手順書きが参照しているコマンドID（実在するかをテストで確かめる） */
export const PROCEDURE_REFERENCED_COMMANDS: readonly string[] =
  PROCEDURES.flatMap((procedure) =>
    procedure.steps.map((step) => step.command)
  );

/** 段が指す操作について、呼び出し側が渡すもの */
export interface ProcedureActionInfo {
  /** 画面に出る操作の名前（`ACTION_TREE` のもの。写しではない） */
  readonly label: string;
  /** 名前から外した括弧の補足。無ければ省く */
  readonly note?: string;
  /**
   * 前提の1行（`views/actionList.ts` の `prerequisiteNoteOf`）。
   *
   * 「先に『設定資料』が要ります。」の形。無ければ空文字。
   * **手順書きの側でも前提が分かるようにするため**に受け取る（設計書6.94）
   * ——順路を教える紙に「これが先に要る」が書いていなければ、
   * 順路として用を成さない。
   */
  readonly prerequisiteNote?: string;
}

/** コマンドIDから操作の実体を引く口。`views` を `core` へ持ち込まないための形 */
export type ProcedureActionLookup = (
  command: string
) => ProcedureActionInfo | undefined;

/**
 * 手順書きが当たったと見なすのに要る、2文字組みの数（設計書6.104）。
 *
 * ## なぜ束選び（`MIN_EVIDENCE_HITS` ＝ 2）と違うのか
 *
 * 日本語の自然な聞き方には、**漢字の熟語が1つしか入らないことが多い**。
 * 「矛盾を洗いたい」から証拠に数える組みは「矛盾」だけである（「を洗」は
 * かな混じりなので数えない。`guideSelect.ts` の `isEvidenceGram`）。
 * それなのに束選びと同じ「2組み以上」を課していたため、**題とほぼ同じ
 * 言い方でも選べなかった**——26件で測って当たり9・見逃し12・取り違え1・
 * **誤検出0**。誤検出が0ということは、**締めすぎ**である（2026-09-21）。
 *
 * 1へ下げると当たりが9→17へ増える。作者の裁定で**こちらを採った**
 * （題に当たったら通す案も測ったが、当たりが13までしか伸びず、
 * **1へ下げたときに通るものの部分集合**だったので落とした）。
 *
 * ## 束選びを一緒に緩めてはいけない
 *
 * `selectGuideBundles` は**束が何十もある**ので、1で採ると点が同じ束が
 * メニュー順に上限まで詰め込まれる（作品の相談に3,000字近い説明が付いた
 * 実績がある）。手順書きは5本しか無く、多くても1本しか渡さないので、
 * 事情が違う。**あちらの `MIN_EVIDENCE_HITS` は 2 のままである。**
 */
export const PROCEDURE_MIN_HITS = 1;

/**
 * 手順書きの通し方。
 *
 * **残してあるのは測り直しのため**（`test/unit/core/procedureSelect.test.ts` が
 * しきい値2へ戻した列を並べて、緩めたことで何件増えたかを毎回示す）。
 * 製品はどこからも渡さないが、**テストが両方の値を通るので腐らない**。
 */
export interface ProcedureSelectRules {
  /** 当たりに要る組みの数。既定は `PROCEDURE_MIN_HITS` */
  readonly minHits?: number;
}

/**
 * 質問に合う手順書きを選ぶ。
 *
 * ## 多くても1本
 *
 * 2本渡すと長くなるうえ、どちらに従えばよいか分からなくなる。点が同じなら
 * 一覧の並び（`PROCEDURES` の順）が先のものを採る。
 *
 * ## 合うものが無ければ渡さない
 *
 * 当たりが `PROCEDURE_MIN_HITS` に満たなければ `undefined` を返す。
 * 関係の薄い手順書きを毎回付けるくらいなら、これまでどおり説明だけで
 * 答えさせるほうがよい。
 *
 * ## 1組みで通すぶん、「どんなときに読むか」の文が効く
 *
 * しきい値が1なので、**そこへ書いた熟語が1つ当たるだけで手順書きが付く**。
 * どの手順にも入りそうな言葉（人物・本文）を書くと、作品の相談へ順路の紙が
 * 割り込む。文を書き足すときは `procedureSelect.test.ts` で誤検出を測り直す。
 *
 * ## AIに判定させない
 *
 * 束選び（`guideSelect.ts`）と同じ理由で、文字2つ組みの一致で決める。
 * AIへ聞くと相談1回につき呼び出しが1回増え、料金も待ち時間も倍に近づく。
 */
export function selectProcedure(input: {
  question: string;
  /** 直前の作者の発言。無ければ空 */
  recentAuthorTurns?: string[];
  /** 差し替え用。既定は `PROCEDURES` */
  procedures?: readonly Procedure[];
  /** 通し方。既定は `PROCEDURE_MIN_HITS`（測り直し用の口） */
  rules?: ProcedureSelectRules;
}): Procedure | undefined {
  const procedures = input.procedures ?? PROCEDURES;
  const minHits = input.rules?.minHits ?? PROCEDURE_MIN_HITS;
  const grams = evidenceGrams([
    input.question,
    ...(input.recentAuthorTurns ?? []),
  ]);

  let best: { procedure: Procedure; score: number } | undefined;
  for (const procedure of procedures) {
    // 題と「どんなときに読むか」だけを突き合わせる。段の理由まで混ぜると、
    // どの手順書きにも入っている言葉（本文・作者）で当たりが増えて、
    // 関係の薄いものが選ばれる
    const score = countGramHits(
      `${procedure.title}\n${procedure.whenToRead}`,
      grams
    );
    if (score < minHits) continue;
    // 同点は先に並んでいるほうを残す（`>` にしてあるのはそのため）
    if (!best || score > best.score) best = { procedure, score };
  }

  return best?.procedure;
}

/**
 * 手順書きをAIへ渡す形に組む。
 *
 * 名前を引けなかった段は**落として先へ進む**（`stepMenu.ts` の
 * `resolveSteps` と同じ考え方）。1段欠けるだけで済むところで投げると、
 * 手順書きがまるごと出なくなり、しかも原因が画面に出ない。
 * 参照が切れていることは `PROCEDURE_REFERENCED_COMMANDS` を見る
 * テストが開発時に止める。
 */
export function renderProcedure(
  procedure: Procedure,
  lookup: ProcedureActionLookup
): string {
  const lines: string[] = [`■ ${procedure.title}（${procedure.whenToRead}）`];

  let number = 0;
  for (const step of procedure.steps) {
    const action = lookup(step.command);
    if (!action) continue;
    number += 1;
    const note = action.note ? `（${action.note}）` : "";
    // 前提は段の末尾に足す。「先に何が要るか」は、その操作を押す直前に
    // 読めないと意味がない
    const needs = action.prerequisiteNote ? ` ${action.prerequisiteNote}` : "";
    lines.push(
      `${number}. ${action.label}${note}：${step.why} → ${step.check}${needs}`
    );
  }

  // 段が1つも解けなかったときは、題だけの紙を渡さない
  return number === 0 ? "" : lines.join("\n");
}
