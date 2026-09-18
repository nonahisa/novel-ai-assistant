import {
  countGramHits,
  evidenceGrams,
  MIN_EVIDENCE_HITS,
} from "./guideSelect";

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
 * **まず5本だけ**にしてある。作者が実際に通る道
 * （`STEP_MENU` の 1→2、1→3、4、4、5）から選んだ。増やすときは、
 * 本当に繰り返し通る仕事かどうかを確かめること——使われない手順書きも、
 * 選ばれなければ0字だが、選ばれてしまえば毎回払う。
 */
export const PROCEDURES: readonly Procedure[] = [
  {
    key: "newWork",
    title: "新しい作品を始める",
    // ステップ1（作品登録）→ 2（新作構想）→ 3（執筆の場）の道
    whenToRead:
      "新規作品の登録から、プロットの作成・形式とジャンルの決定・" +
      "登場人物の名前の重なりの点検まで、新作の構想を立てて書き始めるとき",
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
        why: "空いている項目をAIが1つずつ尋ねる。筋書きを作らせるのではない",
        check: "plot.md の項目が埋まる。決まっていない項目は飛ばしてよい",
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
    whenToRead:
      "すでに原稿のあるフォルダーを作品として登録し、本文から設定資料を抽出して、" +
      "人物の重複を整えるとき",
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
 * 質問に合う手順書きを選ぶ。
 *
 * ## 多くても1本
 *
 * 2本渡すと長くなるうえ、どちらに従えばよいか分からなくなる。点が同じなら
 * 一覧の並び（`PROCEDURES` の順）が先のものを採る。
 *
 * ## 合うものが無ければ渡さない
 *
 * 当たりが `MIN_EVIDENCE_HITS` に満たなければ `undefined` を返す。
 * 関係の薄い手順書きを毎回付けるくらいなら、これまでどおり説明だけで
 * 答えさせるほうがよい。
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
}): Procedure | undefined {
  const procedures = input.procedures ?? PROCEDURES;
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
    if (score < MIN_EVIDENCE_HITS) continue;
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
