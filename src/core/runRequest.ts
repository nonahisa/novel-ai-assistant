import { EXTENSION_URI_AUTHORITY } from "./setupRequest";
import { clientKeyOf } from "./externalAccessPermission";
import type { PdfExportPlanLines } from "./pdfExportConfig";

/**
 * VS Code の中のAI設定で走らせてもらう道（設計書6.87.22）。
 *
 * クラウドAIの鍵は VS Code の SecretStorage にあり、MCP サーバー（別プロセス）へは
 * 出さない。そこで**鍵を外へ出さずに、拡張機能の中で走らせてもらう**。
 *
 * 1. MCP の道具 `run.request` が、依頼の札（`<依頼番号>.request.json`）を保管庫へ
 *    置き、`vscode://nonahisa.novel-ai-assistant/run?id=…&token=…` を OS に開かせる
 * 2. 拡張機能の受け口が札を読み、**合言葉を突き合わせ**、作者に毎回確かめてから、
 *    作者の設定したAIで製品の機能を検算まで通して走らせる
 * 3. 結果を保管庫（`<依頼番号>.state.json`）へ書き、MCP の道具 `run.result` が読む
 *
 * **ここは両側が同じ判定を使うための部品。** 開く側（MCP）と受ける側（拡張機能）
 * で判定を別々に書くと、片方だけ通る依頼が生まれる（`setupRequest.ts` と同じ理由）。
 *
 * VS Code API にも Node にも依存しない（MCP の束から使うため。
 * `test/unit/cross/mcpReach.test.ts`）。
 */

/** 受け口のパス（読者の反応・公募・セットアップと同じ受け口に足す） */
export const RUN_URI_PATH = "/run";

/** 保管庫（`globalStorageUri`）の下のフォルダー。**作品フォルダーには置かない** */
export const RUN_REQUEST_DIRECTORY = "run-requests";

/** 道具の名前。**許可の鍵もこれ1つ**（`run.result` も同じ鍵で確かめる） */
export const RUN_REQUEST_TOOL = "run.request";
export const RUN_RESULT_TOOL = "run.result";

/**
 * 依頼から URI が届くまでの猶予。
 *
 * **ふつうは1秒もかからない**（MCP が開いた直後に VS Code が受ける）。VS Code が
 * 閉じていて起動を待つ分を見込んで10分。これを過ぎて届いた URI は、誰かが
 * 控えておいて後から開かせたものかもしれないので、確認も出さずに断る。
 */
export const RUN_ARRIVAL_MS = 10 * 60_000;

/**
 * 依頼から、作者が「走らせる」を押すまでの期限。
 *
 * **確認が出たまま席を外していると、モーダルは何時間でも残る。** 戻ってきた
 * 作者が押したとき、頼んだ側はとうに諦めているかもしれず、作品もその間に
 * 書き進んでいる。30分を過ぎた「走らせる」は走らせず、期限切れとして返す
 * ——頼み直せばよいだけで、黙って古い依頼が走るより害が小さい。
 */
export const RUN_CONFIRM_MS = 30 * 60_000;

/** 札と結果を片付けるまでの日数（結果には原稿の抜粋が入るので、溜めない） */
export const RUN_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * 1回の依頼で送ってよい本文の字数。
 *
 * **連打や作品まるごとの取り違えで料金がかさむのを防ぐ。** 手元の実データ
 * （19話・約41,000字）はまるごとでも入る。これを超える作品は話を指定して頼む。
 */
export const RUN_MAX_BODY_CHARS = 150_000;

/** 1時間に走らせてよい回数（作者が「走らせる」を押した回を数える） */
export const RUN_MAX_PER_HOUR = 6;
export const RUN_RATE_WINDOW_MS = 60 * 60_000;

/**
 * 作者の返事を待っている依頼を、いくつまで重ねてよいか。
 *
 * **確認のモーダルを積み上げさせない。** 返事の無いまま次々に頼むと、
 * 作者が戻ったときに確認が何枚も重なって出る。
 */
export const RUN_MAX_OPEN_REQUESTS = 2;

/**
 * 走らせてよい機能（**白名簿**）。
 *
 * **読み取りと生成だけ。** 本文への適用・設定資料の抽出の保存・承認待ちの反映は
 * 入れない——結果は保管庫へ書くだけで、原稿にも台帳にも提案パネルにも触れない。
 * ここに無い機能は、確認も出さずに断る。
 *
 * **設定資料の抽出（`settings`）も「取り出して検算する」までで、資料へは保存しない**
 * （2026-10-16 の棚卸しの5件目）。検算を通った答えは MCP の `novel.validate`
 * （`stash: true`）と同じ貯め場所（`.aiwriter/cache/external-extract.json`。
 * Git に載らない控え）へ貯め、資料への保存は頼んだ側が `novel.extract.commit` で行う
 * ——保存の線（新しい記録だけ保存・既存への変更は承認待ち）を1か所に保つため。
 *
 * `assigned` は機能別AI割当（設計書6.28.9）の鍵。**作者が機能ごとに選んだAIで
 * 走る**ので、確認に出すAIもここから引く。
 */
export type RunFeature =
  | "typo"
  | "proofread"
  | "contradiction"
  | "foreshadow"
  | "deviation"
  | "synopsis"
  /** 検索用の索引づくり（0.99.19）。AIの割当ではなく手元の Ollama の埋め込みで走る */
  | "vectorIndex"
  /** 表紙を焼く（字の向きの確かめ。2026-10-15）。AIを呼ばず、EPUBエディターの canvas で焼く */
  | "coverBake"
  /** 冒頭診断（2026-10-16）。第1話の冒頭だけを送る */
  | "opening"
  /** 矛盾検知（事実の照合。2026-10-16）。取り出しと判定で2つのAIを使う */
  | "factContradiction"
  /** 設定資料の抽出（2026-10-16）。貯めるだけで、保存は `novel.extract.commit` */
  | "settings"
  /** AI接続確認（2026-10-16）。本文を送らず、短い文を1回だけ生成させる */
  | "testAI"
  /** PDF出力（印刷用。2026-10-16）。AIを呼ばず、`.aiwriter/exports/` に新しいファイルを作るだけ */
  | "exportPdf"
  /** EPUB出力（2026-10-16）。同上。表紙は焼いてあればそれを使う */
  | "exportEpub";

export type RunAssignedFeature =
  | "typo"
  | "proofread"
  | "contradiction"
  | "foreshadow"
  | "deviation"
  | "generate"
  | "factExtract"
  | "extract";

export interface RunFeatureDef {
  feature: RunFeature;
  /** 画面に出す名前 */
  label: string;
  assigned: RunAssignedFeature;
  /**
   * 判定に別の割当のAIを使う機能（事実の照合：取り出しは `factExtract`、判定は
   * `contradiction`）。**確認と結果に両方を出す**——片方だけ見せると、有料のAIへ
   * 本文の抜粋が出ることを作者が知らないまま押すことになる
   */
  verifyAssigned?: RunAssignedFeature;
  /**
   * 話（`file`）を指せるか。既定は指せる。**冒頭診断は第1話の冒頭しか見ない**ので、
   * 話を渡されても黙って無視せずに断る（何を診断したかが食い違う）
   */
  takesFile?: boolean;
  /**
   * 処理済みの部分を送らない（チャンクの控えを使う）機能か。既定は使う。
   * 使わない機能の確認に「処理済みの部分は送りません」と書くと嘘になる
   */
  skipsProcessed?: boolean;
  /** 確認に足す行（書き先など）。プレーンテキスト */
  confirmNotes?: readonly string[];
}

export const RUN_FEATURES: readonly RunFeatureDef[] = [
  { feature: "typo", label: "誤字脱字の検知", assigned: "typo" },
  { feature: "proofread", label: "推敲", assigned: "proofread" },
  { feature: "contradiction", label: "矛盾検知", assigned: "contradiction" },
  { feature: "foreshadow", label: "伏線の検知", assigned: "foreshadow" },
  { feature: "deviation", label: "プロット逸脱の検知", assigned: "deviation" },
  { feature: "synopsis", label: "各話あらすじの生成", assigned: "generate" },
  {
    feature: "opening",
    label: "冒頭診断",
    assigned: "generate",
    takesFile: false,
    // 冒頭診断は1回きりの呼び出しで、チャンクの控えを持たない
    skipsProcessed: false,
    confirmNotes: ["送るのは第1話の冒頭だけです（上の字数）。診断の文書は作者の画面に開きません。"],
  },
  {
    feature: "factContradiction",
    label: "矛盾検知（事実の照合）",
    assigned: "factExtract",
    verifyAssigned: "contradiction",
    confirmNotes: [
      "本文から事実を取り出すAIと、見つかった候補を1件ずつ確かめるAI（矛盾検知の割当）の2つを使います。",
    ],
  },
  {
    feature: "settings",
    label: "設定資料の抽出",
    assigned: "extract",
    /*
      外から頼む抽出は、チャンクの切り方が製品の［設定資料を抽出］と違う
      （まとめ送信をしない。`novel.extract.commit` が同じチャンクを切り直せる形）。
      製品のチャンクの控えとは鍵が噛み合わないので使わず、毎回送る
    */
    skipsProcessed: false,
    confirmNotes: [
      "検算を通った答えを、作品の .aiwriter/cache/external-extract.json（Git に載らない控え）に貯めます。",
      "設定資料への保存はしません。保存は頼んだ側が novel.extract.commit で行います" +
        "（新しい記録は保存、既にある記録への変更は承認待ち）。",
    ],
  },
];

export function findRunFeature(name: unknown): RunFeatureDef | undefined {
  return typeof name === "string"
    ? RUN_FEATURES.find((def) => def.feature === name)
    : undefined;
}

/**
 * 検索用の索引づくり（設計書6.19.11・6.87.23。0.99.19）。
 *
 * **`RUN_FEATURES` に入れない。** あちらは機能別AI割当（`assigned`）で選んだAIへ
 * 本文を送る機能の白名簿で、送る量の上限（`RUN_MAX_BODY_CHARS`）も効く。
 * 索引づくりは**埋め込みが手元の Ollama だけ**（6.19.5）で、送る先も料金も違う。
 * 受け口は合言葉・1回限り・許可・回数の上限までを共通で通し、そこから分かれる。
 *
 * **原稿は書き換えない。** 書くのは作品の `.aiwriter/cache/vector/`（Git 除外の
 * 作り直せる控え）だけで、作者が「検索索引作成／更新」を押したのと同じ。
 */
export const RUN_INDEX_FEATURE = "vectorIndex" as const;
export const RUN_INDEX_LABEL = "検索用の索引づくり（意味検索）";

export function isRunIndexFeature(name: unknown): name is typeof RUN_INDEX_FEATURE {
  return name === RUN_INDEX_FEATURE;
}

/**
 * 表紙を焼く（設計書6.65.9・6.87.22。作者の指示 2026-10-15「MCPでもできるようにしてください」）。
 *
 * **焼けるのは EPUBエディターの canvas だけ**（WebView の中。Node の MCP サーバーでは
 * 描けない）。そこで作者の VS Code に、［表紙を焼く］と同じ関数で焼いてもらう。
 * 確かめたいのは「作者の VS Code（その版の Chromium）で、縦書きの本の表紙の題名が
 * 立って焼けるか」（実機確認リスト 5488）なので、**画面に出ている canvas で焼く**
 * ——画面の外の canvas は親の書字方向を受け継がず、直す前の不具合も起きないため、
 * 何も確かめたことにならない。
 *
 * **`RUN_FEATURES` に入れない**（索引づくりと同じ理由）。AIを呼ばず、本文も送らない。
 * **原稿と設計図（book.json）は書き換えない。** 書くのは［表紙を焼く］と同じ
 * `設定/書籍/表紙_合成済み.png`（裏表紙なら `裏表紙_合成済み.png`）だけで、
 * 作者が焼いてあった画像は置き換わる（確認のモーダルでそう言う）。
 */
export const RUN_COVER_FEATURE = "coverBake" as const;
export const RUN_COVER_LABEL = "表紙を焼く（題名の字の向きの確かめ）";

export function isRunCoverFeature(name: unknown): name is typeof RUN_COVER_FEATURE {
  return name === RUN_COVER_FEATURE;
}

/** 焼く面 */
export type RunCoverSide = "front" | "back";
/** 題名の大きさ（EPUBエディターの「大・中・小」） */
export type RunCoverSize = "large" | "medium" | "small";

export const RUN_COVER_SIDES: readonly RunCoverSide[] = ["front", "back"];
export const RUN_COVER_SIZES: readonly RunCoverSize[] = ["large", "medium", "small"];

/**
 * 焼くときの体裁。**題名だけに当てる。** 焼けたら同じ体裁を画面の欄にも当てる（作者の裁定、
 * 2026-10-17「焼いた体裁を欄にも反映する」。欄と違うままだと、焼いた直後に「まだ焼いていません」
 * が出る）。**book.json には書かない**——画面は「未保存の変更あり」になり、設計図に残るのは作者が
 * ［保存］を押したときだけ。保存せずに閉じれば下書きの控えが残り、次に開いたとき「戻しますか」が出る。
 *
 * 題名は必ず出す（`visible`）。置き場所・色・ほかの文字（作者名など）は設計図のまま。
 */
export interface RunCoverSpec {
  side: RunCoverSide;
  /** 題名を縦に並べるか */
  vertical: boolean;
  size: RunCoverSize;
}

const COVER_SIDE_LABELS: Record<RunCoverSide, string> = { front: "表紙", back: "裏表紙" };
const COVER_SIZE_LABELS: Record<RunCoverSize, string> = { large: "大", medium: "中", small: "小" };

export function runCoverSideLabel(side: RunCoverSide): string {
  return COVER_SIDE_LABELS[side];
}

/** 「題名：縦・大」の形（確認と結果に出す） */
export function describeRunCoverSpec(spec: RunCoverSpec): string {
  return `題名：${spec.vertical ? "縦" : "横"}・${COVER_SIZE_LABELS[spec.size]}`;
}

/**
 * 体裁の指定を確かめる。**見覚えのない形は理由つきで断る**（札でも MCP の入力でも
 * 同じ判定を使う。片方だけ通る依頼を作らない）。
 */
export function checkRunCover(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "cover（side・vertical・size）を渡してください。";
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !["side", "vertical", "size"].includes(key));
  if (extra.length > 0) {
    return `cover に知らない項目があります（${extra.join("・").slice(0, 60)}）。`;
  }
  if (!RUN_COVER_SIDES.includes(record.side as RunCoverSide)) {
    return "cover.side は front（表紙）か back（裏表紙）です。";
  }
  if (typeof record.vertical !== "boolean") {
    return "cover.vertical は true（縦）か false（横）です。";
  }
  if (!RUN_COVER_SIZES.includes(record.size as RunCoverSize)) {
    return "cover.size は large（大）・medium（中）・small（小）のどれかです。";
  }
  return undefined;
}

/**
 * AI接続確認（設計書6.87.22。2026-10-16 の棚卸しの6件目）。
 *
 * **作者のAIがいま動くかを、外から確かめる。** ほかの依頼の前に使える。
 * 中身は［AI接続確認］コマンドと同じ2段（接続 → 短い文を1回だけ生成）で、
 * 確かめるのは「AI設定で選んだAI」（機能ごとの割当ではない。コマンドと同じ）。
 *
 * **`RUN_FEATURES` に入れない**（索引づくりと同じ理由）。本文を送らないので、
 * 送る量の見積もり（`measure`）を通すと、本文の無い作品で断られてしまう。
 * **繋がらなかったのは「確かめた答え」なので失敗にしない**——`done` の
 * `result.findings` に `ok: false` と理由・次の操作を入れる。
 */
export const RUN_TEST_AI_FEATURE = "testAI" as const;
export const RUN_TEST_AI_LABEL = "AI接続確認";

export function isRunTestAiFeature(name: unknown): name is typeof RUN_TEST_AI_FEATURE {
  return name === RUN_TEST_AI_FEATURE;
}

/** AI接続確認の結果（`result.findings` の1行）。**本文は入らない** */
export interface RunTestAiRow {
  ok: boolean;
  /** どこまで通ったか（`connect`＝接続で止まった・`generate`＝生成で止まった・`done`＝両方通った） */
  stage: "connect" | "generate" | "done";
  /** 作者の画面に出すのと同じ文言 */
  message: string;
  /** 失敗の種別（`AIError.kind`）。分からなければ省く */
  errorKind?: string;
  /** 次に取る操作。**1つだけ**（規則5） */
  nextAction?: string;
  /** モデルの情報（引けたときだけ。表示名・大きさ・文脈の広さ） */
  modelInfo?: string;
}

export interface RunTestAiConfirmInput {
  ticket: RunTicket;
  workTitle: string;
  providerName: string;
  model: string;
  paid: boolean;
}

/**
 * AI接続確認の確認のモーダル。**何を送るかと料金を並べる**（短い文を1回。
 * 有料のAIならごく少額でも料金がかかる）。
 */
export function describeTestAiConfirm(input: RunTestAiConfirmInput): {
  message: string;
  detail: string;
} {
  const who = clientKeyOf(input.ticket.client);
  const deadline = new Date(Date.parse(input.ticket.createdAt) + RUN_CONFIRM_MS);
  const lines = [
    `どこから：外部AI（名乗り：${who}。名乗りは自己申告です）`,
    `作品：${input.workTitle}（許可を確かめるための作品で、本文は送りません）`,
    `機能：${RUN_TEST_AI_LABEL}`,
    `確かめるAI：${input.providerName}（${input.model}）※AI設定で選んだAI（機能ごとの割当ではありません）`,
    "接続を確かめたあと、「はい」とだけ答える短い文を1回送って、生成できるかを試します。",
    input.paid
      ? "料金：有料のAIです。短い文1回ぶんの、ごく少額の料金がかかります。"
      : "料金：無料・手元で実行（API課金なし）",
    "",
    "結果（繋がったか・繋がらなければ理由と次の操作）は拡張機能の保管庫に置き、頼んだ側が読みます。" +
      "原稿・設定資料・提案パネルは変わりません。",
    `期限：${formatClock(deadline)} を過ぎて押しても試しません。`,
    "覚えのない依頼なら「走らせる」を押さずに閉じてください。",
  ];
  return {
    message: `外部AI（${who}）からの依頼です。「${RUN_TEST_AI_LABEL}」を走らせますか？`,
    detail: lines.join("\n"),
  };
}

/**
 * 書き出し（設計書6.33・6.65.4・6.87.22。2026-10-16 の棚卸しの10件目）。
 *
 * **新しいファイルを作るだけで、原稿を変えない**（作者の裁定 2026-10-16 の3
 * 「新しいファイルを作るだけの操作は、run.request で毎回作者の確認つきで頼める」）。
 * 書くのは製品の［PDF出力］［EPUB出力］と同じ `.aiwriter/exports/`（Git 除外・
 * 作り直せる控え）だけで、既にある名前とぶつかったら別名にする（上書きしない）。
 *
 * **`RUN_FEATURES` に入れない**（AI接続確認と同じ理由）。AIを呼ばず、本文はこの機械から
 * 出ない。送る量の見積もり（`measure`）は「AIへ送る量」の確認のためのもので、通すと
 * 嘘の確認になる。
 *
 * - PDF は**作品の前回の［PDF出力］の設定**（紙・向き・範囲。`config.json` の `pdfExport`）で
 *   組み、記録が無ければ文庫サイズ・縦書き・全話（作者の裁定 2026-10-16 夜の3）。上下の余白は
 *   その紙の既定。確認の窓に、使う紙・向き・範囲を並べる。ブラウザは開かない
 *   ——印刷して PDF にするのは作者である
 * - EPUB は訊く段が無い。表紙は製品と同じ拾い方（焼いた画像 → 元の絵 → 無し）で、
 *   ［表紙を焼く］（`coverBake`）で焼いてあればそれが入る
 */
export const RUN_EXPORT_FEATURES = ["exportPdf", "exportEpub"] as const;
export type RunExportFeature = (typeof RUN_EXPORT_FEATURES)[number];

const EXPORT_LABELS: Record<RunExportFeature, string> = {
  exportPdf: "PDF出力（印刷用のファイルを作る）",
  exportEpub: "EPUB出力",
};

export function isRunExportFeature(name: unknown): name is RunExportFeature {
  return (RUN_EXPORT_FEATURES as readonly unknown[]).includes(name);
}

/** 書き出しの置き場（作品フォルダーからの相対。製品の書き出しと同じ） */
export const RUN_EXPORT_DIRECTORY = ".aiwriter/exports/";

/** 書き出しの結果（`result.findings` の1行）。**場所と数字だけ**——本文は入らない */
export interface RunExportRow {
  format: "pdf" | "epub";
  /** 作ったファイル（作品フォルダーからの相対パス） */
  filePath: string;
  bytes: number;
  /** 本に入った話の数（合本は話ごとに数える） */
  chapters: number;
  /** 未解決の競合で外した話（ファイル名） */
  conflicted: string[];
  /** 作者の画面なら完了の知らせに出る断り（挿絵のずれ・読めなかった画像・既定で埋めた設定など） */
  notices: string[];
  /** 表紙に何を使ったか（EPUB だけ。焼いた画像・元の絵・無し） */
  cover?: string;
}

export interface RunExportConfirmInput {
  ticket: RunTicket;
  workTitle: string;
  /** 本文のファイルの数（作者が規模を見て判断できるように） */
  episodeCount: number;
  /**
   * PDF で使う紙・向き・範囲（`core/pdfExportConfig.ts` の `describePdfExportPlan`）。
   * **実際に組むものと同じ計画から作る**——確認の窓と作るものが食い違わないように
   */
  pdfPlan?: PdfExportPlanLines;
}

/**
 * 書き出しの確認のモーダル。**何が起きて何が変わらないかを並べる**
 * （新しいファイルを作るだけ・置き場・AIを呼ばない・料金なし）。
 */
export function describeExportConfirm(input: RunExportConfirmInput): {
  message: string;
  detail: string;
} {
  const who = clientKeyOf(input.ticket.client);
  const deadline = new Date(Date.parse(input.ticket.createdAt) + RUN_CONFIRM_MS);
  const pdf = input.ticket.feature === "exportPdf";
  const label = runFeatureLabel(input.ticket.feature) ?? String(input.ticket.feature);
  const lines = [
    `どこから：外部AI（名乗り：${who}。名乗りは自己申告です）`,
    `作品：${input.workTitle}（本文のファイル ${input.episodeCount}話ぶん）`,
    `機能：${label}`,
    ...(pdf
      ? input.pdfPlan
        ? [
            `紙：${input.pdfPlan.paper}`,
            `向き：${input.pdfPlan.direction}`,
            `範囲：${input.pdfPlan.range}`,
            `（${input.pdfPlan.source}。上下の余白はその紙の既定。紙や話を変えたいときは、ご自分で［PDF出力］を使ってください。次からはそこで選んだ設定を使います）`,
          ]
        : [
            "組み方：前回の［PDF出力］で選んだ紙・向き・範囲（記録が無ければ文庫サイズ・縦書き・全話）。" +
              "上下の余白はその紙の既定。",
          ]
      : [
          "組み方：本の設計図（設定/書籍/book.json。無ければ作品名から既定で組む）のとおり。" +
            "表紙・裏表紙は焼いた画像があればそれを、無ければ元の絵を使います。",
        ]),
    `作るもの：作品の ${RUN_EXPORT_DIRECTORY} に新しいファイルを1つ作ります（同じ名前があれば別名にし、上書きしません）。`,
    pdf
      ? "ブラウザは開きません。印刷してPDFにするのは、あなたがファイルを開いてから行います。"
      : "書き出しの知らせ（フォルダーを開く）は出しません。",
    "AIは呼びません。本文はどこへも送りません。料金はかかりません。",
    "原稿・設定資料・本の設計図（book.json）は変わりません。",
    "",
    `期限：${formatClock(deadline)} を過ぎて押しても作りません。`,
    "覚えのない依頼なら「作る」を押さずに閉じてください。",
  ];
  return {
    message: `外部AI（${who}）からの依頼です。「${input.workTitle}」の${pdf ? "印刷用のファイル（PDF出力）" : "EPUB"}を作りますか？`,
    detail: lines.join("\n"),
  };
}

/** 外から頼める機能の名前（白名簿＋索引づくり＋表紙を焼く＋AI接続確認＋書き出し）。MCP の入力の形に使う */
export const RUN_REQUESTABLE_FEATURES: readonly RunFeature[] = [
  ...RUN_FEATURES.map((def) => def.feature),
  RUN_INDEX_FEATURE,
  RUN_COVER_FEATURE,
  RUN_TEST_AI_FEATURE,
  ...RUN_EXPORT_FEATURES,
];

/** 画面と返事に出す名前 */
export function runFeatureLabel(name: unknown): string | undefined {
  if (isRunIndexFeature(name)) return RUN_INDEX_LABEL;
  if (isRunCoverFeature(name)) return RUN_COVER_LABEL;
  if (isRunTestAiFeature(name)) return RUN_TEST_AI_LABEL;
  if (isRunExportFeature(name)) return EXPORT_LABELS[name];
  return findRunFeature(name)?.label;
}

/**
 * 話（`file`）を指せる機能か。**札を読む側と MCP の入力が同じ判定を使う**
 * （片方だけ通る依頼を作らない）。索引づくり・表紙を焼くは、それぞれの断り方
 * （作品ごと・面ごと）があるのでここでは見ない。
 */
export function runFeatureTakesFile(name: unknown): boolean {
  // 書き出しは作品まるごと（PDF の話を選ぶ段は、外からは既定の「全話」で埋める）
  if (isRunTestAiFeature(name) || isRunExportFeature(name)) return false;
  return findRunFeature(name)?.takesFile !== false;
}

/** 索引づくりの範囲。`all` は登録済みの全作品（許可のある作品だけ回す） */
export type RunScope = "all";

// ── 札（MCP が書き、拡張機能が読む）────────────────────────

/**
 * 依頼の札。**依頼の中身の出どころはここだけ**——URI には依頼番号と合言葉しか
 * 載せない。URI の引数で機能や作品を渡すと、URI を書き換えれば別の依頼に
 * なってしまい、札と突き合わせる手間が増える（突き合わせ漏れが穴になる）。
 * 作品の場所を URL に載せないで済む利点もある。
 */
export interface RunTicket {
  version: 1;
  /** 依頼番号（16桁の16進） */
  id: string;
  /**
   * 合言葉の SHA-256。**合言葉そのものは置かない**——保管庫は機械の中だが、
   * 置かないで済むものは置かない
   */
  tokenHash: string;
  feature: RunFeature;
  /** 作品フォルダー（絶対パス） */
  folder: string;
  /** 対象の話（作品フォルダーからの相対パス。`novel.scan` の値）。無ければ作品全体 */
  file?: string;
  /**
   * 索引づくり（`vectorIndex`）だけ：`all` なら登録済みの全作品を順に回す。
   * 無ければ `folder` の作品だけ。`folder` は**全作品のときも要る**——依頼の
   * 持ち主（許可を確かめ、`run.result` で突き合わせる作品）になる
   */
  scope?: RunScope;
  /** 表紙を焼く（`coverBake`）だけ：どの面を、どの体裁で。**この機能では必須** */
  cover?: RunCoverSpec;
  /** 頼んだ接続元の名乗り（自己申告） */
  client: string;
  /** 依頼の時刻（ISO） */
  createdAt: string;
}

const ID_PATTERN = /^[0-9a-f]{16}$/u;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
/** 制御文字（`\u0000`〜`\u001f` と `\u007f`）。生のまま書かない（sourceHygiene） */
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_FILE_LENGTH = 512;

export function isRunRequestId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function runTicketFileName(id: string): string {
  return `${id}.request.json`;
}

export function runStateFileName(id: string): string {
  return `${id}.state.json`;
}

/** ファイル名から依頼番号を取り出す（札でも結果でもないものは undefined） */
export function runIdOfFileName(
  name: string
): { id: string; kind: "request" | "state" } | undefined {
  const match = /^([0-9a-f]{16})\.(request|state)\.json$/u.exec(name);
  if (!match) return undefined;
  return { id: match[1], kind: match[2] as "request" | "state" };
}

/**
 * 対象の話の指定を確かめる。**作品フォルダーの外を指させない**
 * （`..`・絶対パス・制御文字）。
 */
export function checkRunFile(file: string): string | undefined {
  if (!file.trim()) return "file が空です。省略すると作品全体です。";
  if (CONTROL.test(file)) return "file に制御文字が入っています。";
  if (file.length > MAX_FILE_LENGTH) return `file が長すぎます（${MAX_FILE_LENGTH}字まで）。`;
  if (/^[A-Za-z]:/u.test(file) || file.startsWith("/") || file.startsWith("\\")) {
    return "file は作品フォルダーからの相対パスで渡してください（novel.scan の filePath）。";
  }
  if (file.split(/[\\/]/u).some((part) => part === "..")) {
    return "file に `..` は使えません（作品フォルダーの外は指せません）。";
  }
  return undefined;
}

export function formatRunTicket(ticket: RunTicket): string {
  return `${JSON.stringify(ticket, null, 2)}\n`;
}

/**
 * 札を読む。**見覚えのない形は undefined**（＝出どころの分からない依頼として断る）。
 */
export function parseRunTicket(text: string): RunTicket | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (!isRunRequestId(record.id)) return undefined;
  if (typeof record.tokenHash !== "string" || !TOKEN_PATTERN.test(record.tokenHash)) {
    return undefined;
  }
  const def = findRunFeature(record.feature);
  // **白名簿の外の札は読めないものとして扱わない**——受け口が「白名簿の外」と
  // 理由を言って断れるよう、機能名は文字列のまま通す（下で確かめる）
  if (typeof record.feature !== "string") return undefined;
  if (typeof record.folder !== "string" || !record.folder.trim()) return undefined;
  if (record.file !== undefined) {
    if (typeof record.file !== "string" || checkRunFile(record.file)) return undefined;
  }
  if (typeof record.client !== "string") return undefined;
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    return undefined;
  }
  // 話を指せない機能（冒頭診断・AI接続確認）に付いた話は、見覚えのない札として読まない
  if (record.file !== undefined && !runFeatureTakesFile(record.feature)) return undefined;
  // 範囲は `all` だけ。**索引づくり以外に付いた範囲は、見覚えのない札として読まない**
  if (record.scope !== undefined) {
    if (record.scope !== "all" || !isRunIndexFeature(record.feature)) return undefined;
  }
  // 体裁は表紙を焼くときだけ、しかも必須。**ほかの機能に付いた体裁は見覚えのない札**
  if (isRunCoverFeature(record.feature)) {
    if (checkRunCover(record.cover) || record.file !== undefined) return undefined;
  } else if (record.cover !== undefined) {
    return undefined;
  }
  return {
    version: 1,
    id: record.id,
    tokenHash: record.tokenHash,
    feature: (def?.feature ?? record.feature) as RunFeature,
    folder: record.folder,
    ...(record.file !== undefined ? { file: record.file as string } : {}),
    ...(record.scope === "all" ? { scope: "all" as const } : {}),
    ...(isRunCoverFeature(record.feature) ? { cover: coverOf(record.cover) } : {}),
    client: record.client,
    createdAt: record.createdAt,
  };
}

/** 確かめ済みの体裁から、余計なものを持たない形を作る */
function coverOf(value: unknown): RunCoverSpec {
  const record = value as Record<string, unknown>;
  return {
    side: record.side as RunCoverSide,
    vertical: record.vertical as boolean,
    size: record.size as RunCoverSize,
  };
}

// ── URI（MCP が組み、拡張機能が読む）────────────────────────

export function buildRunUri(id: string, token: string, scheme = "vscode"): string {
  const params = new URLSearchParams();
  params.set("id", id);
  params.set("token", token);
  return `${scheme}://${EXTENSION_URI_AUTHORITY}${RUN_URI_PATH}?${params.toString()}`;
}

export type RunQueryResult =
  | { ok: true; id: string; token: string }
  | { ok: false; reason: string };

/**
 * URI のクエリを読む。**載せてよいのは `id` と `token` だけ**で、ほかの鍵・同じ鍵の
 * 2つ目・形の合わない値は断る（URI はウェブページのリンク1つでも開かせられる）。
 */
export function parseRunQuery(query: string): RunQueryResult {
  const params = new URLSearchParams(query.replace(/^\?/u, ""));
  const seen = new Map<string, string>();
  for (const [key, value] of params) {
    if (key !== "id" && key !== "token") {
      return { ok: false, reason: "知らない引数が付いています。" };
    }
    if (seen.has(key)) return { ok: false, reason: `同じ引数（${key}）が2つあります。` };
    seen.set(key, value);
  }
  const id = seen.get("id");
  const token = seen.get("token");
  if (!id || !isRunRequestId(id)) return { ok: false, reason: "依頼番号の形が合いません。" };
  if (!token || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: "合言葉がありません（形が合いません）。" };
  }
  return { ok: true, id, token };
}

export type RunTokenCheck =
  | { ok: true }
  | { ok: false; kind: "mismatch" | "late"; reason: string };

/**
 * 合言葉と、届いた時刻を確かめる。
 *
 * - **合言葉が札と合わない** → 出どころの分からない依頼（ウェブのリンクなど）。
 *   確認も出さずに断る。札の状態も書き換えない——依頼番号だけを当てた誰かに、
 *   正しい依頼を潰させないため
 * - **依頼から時間が経ちすぎて届いた** → 控えておいた URI を後から開かせた
 *   かもしれない。これも確認を出さずに断る
 *
 * @param hash 合言葉のハッシュを取る関数（`core/hash.ts` の `sha256Text`）
 */
export function checkRunToken(
  ticket: RunTicket,
  token: string,
  now: number,
  hash: (text: string) => string
): RunTokenCheck {
  if (!sameText(hash(token), ticket.tokenHash)) {
    return {
      ok: false,
      kind: "mismatch",
      reason: "合言葉が依頼の札と合いません（出どころの分からない依頼です）。",
    };
  }
  const created = Date.parse(ticket.createdAt);
  if (!Number.isFinite(created) || now - created > RUN_ARRIVAL_MS || created - now > RUN_ARRIVAL_MS) {
    return {
      ok: false,
      kind: "late",
      reason: `依頼から${Math.round(RUN_ARRIVAL_MS / 60_000)}分を過ぎて届いたため、受けませんでした。`,
    };
  }
  return { ok: true };
}

/** 比べるときに途中で抜けない（長さも中身も最後まで見る） */
function sameText(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/** 作者の「走らせる」が期限を過ぎているか（依頼の時刻から数える） */
export function isConfirmTooLate(ticket: RunTicket, now: number): boolean {
  const created = Date.parse(ticket.createdAt);
  return !Number.isFinite(created) || now - created > RUN_CONFIRM_MS;
}

// ── 状態と結果（拡張機能が書き、MCP が読む）───────────────────

/**
 * 拡張機能が書く状態。
 *
 * - `confirming`：作者の確認待ち（**この状態で最初に作れた窓だけが依頼を受ける**。合言葉は1回限り）
 * - `running`：走っている
 * - `done`：走り終えた（`result` がある）
 * - `failed`：走らせたが失敗した（`reason` と `nextAction`）
 * - `declined`：作者が断った・途中で止めた
 * - `refused`：受け口が断った（許可が無い・白名簿の外・上限など）
 * - `expired`：期限を過ぎた
 */
export type RunStateKind =
  | "confirming"
  | "running"
  | "done"
  | "failed"
  | "declined"
  | "refused"
  | "expired";

const RUN_STATE_KINDS: readonly RunStateKind[] = [
  "confirming",
  "running",
  "done",
  "failed",
  "declined",
  "refused",
  "expired",
];

/** 検算で落としたもの。**件数と理由だけ**（落とした中身まで返すと、検算の意味が薄れる） */
export interface RunDropped {
  count: number;
  notes: string[];
}

/** 送れなかった・読めなかったもの */
export interface RunFailures {
  count: number;
  notes: string[];
}

/**
 * 結果の中身（検算済み）。**測る道としての約束**（設計書6.87.22）——使った
 * プロバイダ・モデル・プロンプトの版・検算で落としたものを必ず入れる。
 * **鍵・APIキーは入れない。**
 */
export interface RunResultBody {
  feature: RunFeature;
  featureLabel: string;
  workTitle: string;
  /** 対象の話（相対パス）。作品全体なら null */
  target: string | null;
  provider: { id: string; name: string; paid: boolean };
  model: string;
  /** 判定に別のAIを使った機能（事実の照合）だけ。判定のAI */
  verifyProvider?: { id: string; name: string; paid: boolean };
  verifyModel?: string;
  promptVersion: string;
  /** 検算を通った指摘・生成物。ファイルは作品フォルダーからの相対パス */
  findings: unknown[];
  dropped: RunDropped;
  failures: RunFailures;
  /** 送った本文の字数（処理済みで送らなかった分を含む見込み） */
  bodyChars: number;
  startedAt: string;
  finishedAt: string;
}

export interface RunStateRecord {
  version: 1;
  id: string;
  state: RunStateKind;
  /** この状態になった時刻（ISO） */
  at: string;
  /** 作者が「走らせる」を押した時刻。**続けて頼める回数を数える** */
  startedAt?: string;
  /** 断った・失敗した理由 */
  reason?: string;
  /** 作者（または頼んだ側）が次に取る操作。**1つだけ**（規則5） */
  nextAction?: string;
  /** 失敗の種別（`AIError.kind`）。分からなければ省く */
  errorKind?: string;
  result?: RunResultBody;
  /**
   * 依頼を受けた VS Code（`vscode.version` と `vscode.env.appRoot`）。
   *
   * 作者の機械で、試験用に取り寄せた VS Code（`.vscode-test` の下）が `vscode://` の
   * 受け手に居座り、依頼が作者の知らない窓へ届いて確認が見えなかった（2026-10-17）。
   * 頼んだ側が run.result で気づけるように残す。前の版が書いた記録には無い
   */
  handledBy?: RunHandledBy;
}

/** 依頼を受けた VS Code。**作品の場所・本文は入れない** */
export interface RunHandledBy {
  version: string;
  appRoot: string;
}

/** 記録から読んだ値が `RunHandledBy` の形か（記録は手で書き換えられうる） */
export function isRunHandledBy(value: unknown): value is RunHandledBy {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === "string" && typeof record.appRoot === "string";
}

/**
 * 試験用の VS Code（`@vscode/test-electron` が `.vscode-test/` へ取り寄せたもの）か。
 * フォルダー名を区切りつきで見る（`my.vscode-tests` のような名前を拾わない）
 */
export function isTestVsCodeAppRoot(appRoot: string): boolean {
  return /(^|[\\/])\.vscode-test([\\/]|$)/u.test(appRoot);
}

/** run.result に添える一言（試験用の VS Code で受けたとき） */
export const RUN_TEST_HOST_NOTE =
  "試験用の VS Code で受けました（開発の試験が取り寄せた .vscode-test の下の VS Code）。" +
  "作者がふだん使う VS Code ではないので、確認の窓が作者に見えていないかもしれません。" +
  "作者に、試験用の VS Code の窓が開いていないか見てもらってください（handledBy に受けた版と場所があります）。";

export function formatRunState(state: RunStateRecord): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseRunState(text: string): RunStateRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isRunRequestId(record.id)) return undefined;
  if (!RUN_STATE_KINDS.includes(record.state as RunStateKind)) return undefined;
  if (typeof record.at !== "string") return undefined;
  return record as unknown as RunStateRecord;
}

/**
 * 直近の窓の中で、作者が「走らせる」を押した回数（続けて頼める回数の上限に使う）。
 */
export function countRecentRuns(
  states: readonly RunStateRecord[],
  now: number,
  windowMs = RUN_RATE_WINDOW_MS
): number {
  return states.filter((state) => {
    if (!state.startedAt) return false;
    const started = Date.parse(state.startedAt);
    return Number.isFinite(started) && now - started >= 0 && now - started < windowMs;
  }).length;
}

/** 返事がまだ出ていない依頼か（札はあるが、終わりの状態が無く、期限内） */
export function isRunOpen(
  ticket: RunTicket,
  state: RunStateRecord | undefined,
  now: number
): boolean {
  const status = runStatusOf(ticket, state, now).status;
  return status === "waiting" || status === "confirming" || status === "running";
}

/** 片付けてよい古さか */
export function isRunStale(createdAt: string, now: number): boolean {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || now - created > RUN_KEEP_MS;
}

// ── run.result が返すもの ─────────────────────────────

export type RunStatus =
  | "waiting"
  | "confirming"
  | "running"
  | "done"
  | "failed"
  | "declined"
  | "refused"
  | "expired";

export interface RunStatusView {
  status: RunStatus;
  /** 頼んだ側が読む一言。**次に何をすればよいか**まで書く */
  message: string;
}

/**
 * 札と状態から、いまどうなっているかを決める。
 *
 * **拡張機能がまだ何も書いていない（`waiting`）ときも、期限で区切る。** VS Code が
 * 閉じていた・URI が届かなかったとき、いつまでも「待っています」と返すと、
 * 頼んだ側は永遠に待つ。
 */
export function runStatusOf(
  ticket: RunTicket,
  state: RunStateRecord | undefined,
  now: number
): RunStatusView {
  const created = Date.parse(ticket.createdAt);
  const age = Number.isFinite(created) ? now - created : Number.POSITIVE_INFINITY;

  if (!state) {
    if (age > RUN_ARRIVAL_MS) {
      return {
        status: "expired",
        message:
          "拡張機能が依頼を受け取らないまま期限が過ぎました（VS Code が閉じていた・URI が開けなかった、など）。" +
          "作者に VS Code を開いてもらってから、もう一度 run.request で頼んでください。",
      };
    }
    return {
      status: "waiting",
      message:
        "拡張機能がまだ依頼を受け取っていません。少し待ってから、もう一度 run.result で確かめてください。",
    };
  }

  switch (state.state) {
    case "confirming":
      if (age > RUN_CONFIRM_MS) {
        return {
          status: "expired",
          message:
            "作者の確認が出たまま期限（依頼から30分）が過ぎました。この依頼は走りません。" +
            "作者の手が空いてから、もう一度 run.request で頼んでください。",
        };
      }
      return {
        status: "confirming",
        message:
          "作者の VS Code に確認が出ています。作者が「走らせる」を押すまで走りません。" +
          "間を置いてから、もう一度 run.result で確かめてください（急かさないでください）。",
      };
    case "running":
      return {
        status: "running",
        message: "作者のAIで走っています。終わると結果が読めます。間を置いて確かめてください。",
      };
    case "done":
      if (isRunIndexFeature(ticket.feature)) {
        return {
          status: "done",
          message:
            "検索用の索引づくりを終えました。作品ごとの件数・かかった時間・失敗や飛ばした理由は result.findings にあります" +
            "（status が cancelled の作品は途中まで保存済み）。原稿・設定資料・提案パネルは変わっていません。" +
            "索引は novel.search で引けます。",
        };
      }
      if (isRunCoverFeature(ticket.feature)) {
        return {
          status: "done",
          message:
            "作者の VS Code の EPUBエディターで焼きました（［表紙を焼く］と同じ関数・画面に出ている canvas）。" +
            "焼いた画像の場所・体裁・題名を描いた範囲（titleBlock）は result.findings にあります。" +
            "字が立っているかは cover.ink で測れます（region に titleBlock を渡す）。原稿と book.json は変わっていません。" +
            "EPUBエディターの欄にも同じ体裁を当てました（未保存のまま。book.json へ書くのは作者が［保存］を押したときだけです）。",
        };
      }
      if (ticket.feature === "settings") {
        return {
          status: "done",
          message:
            "設定資料の抽出を、検算まで通しました（製品と同じ検算）。答えは作品の .aiwriter/cache/external-extract.json に貯めてあり、" +
            "設定資料にはまだ保存していません。保存するなら novel.extract.commit を、まず dryRun: true で呼んで" +
            "保存されるもの（新規・承認待ち・断るもの）を確かめてから呼んでください。" +
            "チャンクごとの受け入れた人物と落とした件数は result.findings にあります。",
        };
      }
      if (isRunExportFeature(ticket.feature)) {
        return {
          status: "done",
          message:
            `書き出しました。作ったファイルの場所（作品フォルダーからの相対。${RUN_EXPORT_DIRECTORY} の下）・大きさ・話の数・` +
            "外した話や断りは result.findings にあります。原稿・設定資料・book.json は変わっていません。" +
            (ticket.feature === "exportPdf"
              ? "印刷用のファイル（.html）は、作者がブラウザで開いて印刷（PDFに保存）するとPDFになります。"
              : ""),
        };
      }
      if (isRunTestAiFeature(ticket.feature)) {
        return {
          status: "done",
          message:
            "AI接続確認を終えました。繋がったかは result.findings[0] の ok にあります" +
            "（false なら stage〔connect＝接続・generate＝生成〕で止まった所と、理由・次の操作）。" +
            "原稿・設定資料・提案パネルは変わっていません。",
        };
      }
      return {
        status: "done",
        message:
          "検算まで通した結果です（製品と同じ検算）。原稿・設定資料・提案パネルは変わっていません。",
      };
    case "failed":
      return {
        status: "failed",
        message: joinReason("走らせましたが失敗しました。", state),
      };
    case "declined":
      return {
        status: "declined",
        message: joinReason(
          "作者が断りました。理由を尋ねずに、別のやり方を作者と相談してください。",
          state
        ),
      };
    case "refused":
      return { status: "refused", message: joinReason("拡張機能が断りました。", state) };
    case "expired":
      return { status: "expired", message: joinReason("期限を過ぎたため走らせていません。", state) };
  }
}

function joinReason(head: string, state: RunStateRecord): string {
  return [head, state.reason, state.nextAction ? `次の操作：${state.nextAction}` : ""]
    .filter(Boolean)
    .join("");
}

// ── 確認のモーダル（拡張機能が出す）───────────────────────

export interface RunConfirmInput {
  ticket: RunTicket;
  featureLabel: string;
  workTitle: string;
  /** 対象の話の表示（「第3話.txt」「作品全体（19話）」） */
  targetLabel: string;
  providerName: string;
  model: string;
  paid: boolean;
  bodyChars: number;
  episodeCount: number;
  /** 有料のAIのときの断り（`core/paidUsageNotice.ts` の行） */
  paidLines: readonly string[];
  /** 機能の定義（処理済みを飛ばすか・足す行）。無ければ従来どおり */
  def?: RunFeatureDef;
  /** 判定に使う2つ目のAI（事実の照合） */
  verifier?: { providerName: string; model: string; paid: boolean };
}

/**
 * 確認のモーダルの中身。**依頼の中身を全部並べる**（どこから・作品・話・機能・
 * 使うAI・送る量・料金）。見せずに走らせると、作者は何を許したのか分からない。
 *
 * **名乗りは自己申告と書く**（6.87.14「名乗りは目印であって、鍵ではない」）。
 */
export function describeRunConfirm(input: RunConfirmInput): {
  message: string;
  detail: string;
} {
  const who = clientKeyOf(input.ticket.client);
  const deadline = new Date(Date.parse(input.ticket.createdAt) + RUN_CONFIRM_MS);
  const lines = [
    `どこから：外部AI（名乗り：${who}。名乗りは自己申告です）`,
    `作品：${input.workTitle}`,
    `対象：${input.targetLabel}`,
    `機能：${input.featureLabel}`,
    input.verifier
      ? `使うAI：取り出し ${input.providerName}（${input.model}）・判定 ` +
        `${input.verifier.providerName}（${input.verifier.model}）※機能別AI割当のとおり`
      : `使うAI：${input.providerName}（${input.model}）※機能別AI割当のとおり`,
    `送る量：本文 約${input.bodyChars.toLocaleString("ja-JP")}字（${input.episodeCount}話）。` +
      (input.def?.skipsProcessed === false ? "" : "処理済みの部分は送りません。") +
      "指示と設定資料のぶんが加わります。" +
      "保存していない変更は含まれません（保存済みの本文を読みます）。",
    ...(input.def?.confirmNotes ?? []),
    // **どちらかが有料なら料金の断りを出す**（有料のほうの行は呼ぶ側が組んで渡す）
    ...(input.paid || input.verifier?.paid
      ? input.paidLines
      : ["料金：無料・手元で実行（API課金なし）"]),
    "",
    "結果は拡張機能の保管庫（この機械の中）に置き、頼んだ側が読みます。" +
      "原稿・設定資料・提案パネルは変わりません。",
    `期限：${formatClock(deadline)} を過ぎて押しても走りません。`,
    "覚えのない依頼なら「走らせる」を押さずに閉じてください。",
  ];
  return {
    message: `外部AI（${who}）からの依頼です。あなたのAIで「${input.featureLabel}」を走らせますか？`,
    detail: lines.join("\n"),
  };
}

// ── 索引づくり（vectorIndex）─────────────────────────────

/**
 * 索引づくりの1作品ぶんの結果（`result.findings` の1行）。**件数・時間・理由だけ**
 * ——本文は1文字も入れない。
 *
 * - `done`：作り終えた（変わっていない場面は作り直さない）
 * - `failed`：作れなかった（`reason`）。**ほかの作品は続けた**
 * - `cancelled`：作者が止めた（そこまでは保存済み。次は続きから）
 * - `skipped`：許可が無いなどで回さなかった（`reason`）
 */
export interface RunIndexRow {
  workTitle: string;
  folder: string;
  status: "done" | "failed" | "cancelled" | "skipped";
  /** 新しく埋め込んだ場面 */
  built?: number;
  /** そのまま使えた場面 */
  reused?: number;
  /** 本文から消えたので索引から外した場面 */
  removed?: number;
  /** いまの場面の数（本文・設定資料・あらすじ） */
  total?: number;
  /** 埋め込めずに飛ばした場面（次の作り直しで続きから） */
  failedScenes?: number;
  /** 索引の大きさ（バイト） */
  bytes?: number;
  seconds: number;
  reason?: string;
}

export interface RunIndexConfirmInput {
  ticket: RunTicket;
  /** 回す作品（許可のあるもの） */
  works: readonly { title: string }[];
  /** 回さない作品と理由 */
  skipped: readonly { title: string; reason: string }[];
  model: string;
}

/**
 * 索引づくりの確認のモーダル。**作品を全部並べる**（どこから・どの作品・使うAI・
 * 料金・止め方）。1行目は作品（1作品なら題、全作品なら数）。
 */
export function describeIndexConfirm(input: RunIndexConfirmInput): {
  message: string;
  detail: string;
} {
  const who = clientKeyOf(input.ticket.client);
  const deadline = new Date(Date.parse(input.ticket.createdAt) + RUN_CONFIRM_MS);
  const all = input.ticket.scope === "all";
  const titles = input.works.map((work) => work.title).join("・");
  const lines = [
    all
      ? `作品：登録済みの全作品から ${input.works.length}作品（${titles}）`
      : `作品：${titles}`,
    `どこから：外部AI（名乗り：${who}。名乗りは自己申告です）`,
    `機能：${RUN_INDEX_LABEL}`,
    `使うAI：手元の Ollama（${input.model}）。料金：無料・手元で実行（本文はこの機械から出ません）`,
    "変わっていない場面は作り直しません。1作品ずつ順に回し、1作品で失敗しても次へ進みます。",
    "右下の「中止」で止められます（そこまでは保存します）。",
    ...(input.skipped.length > 0
      ? [
          `回さない作品：${input.skipped
            .map((entry) => `${entry.title}（${entry.reason}）`)
            .join("・")}`,
        ]
      : []),
    "",
    "書くのは各作品の .aiwriter/cache/vector/（Git に載らない、作り直せる控え）だけです。" +
      "原稿・設定資料・提案パネルは変わりません。",
    `期限：${formatClock(deadline)} を過ぎて押しても走りません。`,
    "覚えのない依頼なら「走らせる」を押さずに閉じてください。",
  ];
  return {
    message: all
      ? `外部AI（${who}）からの依頼です。${input.works.length}作品の検索用の索引を作りますか？`
      : `外部AI（${who}）からの依頼です。「${titles}」の検索用の索引を作りますか？`,
    detail: lines.join("\n"),
  };
}

// ── 表紙を焼く（coverBake）─────────────────────────────

export interface RunCoverConfirmInput {
  ticket: RunTicket;
  cover: RunCoverSpec;
  workTitle: string;
  /** 本の組み方が縦書きか（book.json の writingMode） */
  bookVertical: boolean;
  /** いま焼いた画像があるか（置き換わることを言う） */
  bakedExists: boolean;
  /** 焼いた画像の置き場（作品フォルダーからの相対パス） */
  bakedRelative: string;
}

/**
 * 表紙を焼く確認のモーダル。**何が変わるかを全部並べる**——とくに、作者が焼いて
 * あった画像が置き換わることと、EPUBエディターが開くこと（焦点は移さない）。
 */
export function describeCoverConfirm(input: RunCoverConfirmInput): {
  message: string;
  detail: string;
} {
  const who = clientKeyOf(input.ticket.client);
  const deadline = new Date(Date.parse(input.ticket.createdAt) + RUN_CONFIRM_MS);
  const side = runCoverSideLabel(input.cover.side);
  const lines = [
    `作品：${input.workTitle}（本の組み方：${input.bookVertical ? "縦書き" : "横書き"}）`,
    `どこから：外部AI（名乗り：${who}。名乗りは自己申告です）`,
    `機能：${RUN_COVER_LABEL}`,
    `面と体裁：${side}・${describeRunCoverSpec(input.cover)}` +
      "（題名だけに当てます。置き場所・色・ほかの文字は本の設計図のまま）",
    "AIは呼びません。本文はどこへも送りません。料金はかかりません。",
    "EPUBエディターの画面が開きます（開いていればそれを使います。焦点は移しません）。",
    input.bakedExists
      ? `いまの焼いた画像（${input.bakedRelative}）は、この体裁で焼いた画像に置き換わります。` +
        "設定/ は Git 管理下なので、前の画像は復元できます。"
      : `焼いた画像を ${input.bakedRelative} へ保存します（次の書き出しから${side}に入ります）。`,
    "焼いたあと、EPUBエディターの欄にも同じ体裁が入ります（未保存のまま。本の設計図（book.json）に残るのは［保存］を押したときだけです）。",
    "原稿と本の設計図（book.json）は変わりません。",
    "",
    `期限：${formatClock(deadline)} を過ぎて押しても焼きません。`,
    "覚えのない依頼なら「焼く」を押さずに閉じてください。",
  ];
  return {
    message: `外部AI（${who}）からの依頼です。「${input.workTitle}」の${side}を焼きますか？`,
    detail: lines.join("\n"),
  };
}

/**
 * 題名を描いた範囲（canvas の画素）。EPUBエディターの描画の関数（`drawTexts`）が
 * 置いた値をそのまま返す——測る側（`cover.ink`）が、作者名などを拾わずに
 * 題名の墨だけを測れるように。
 */
export interface RunCoverTitleBlock {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  /** 何行（縦なら何列）に割ったか */
  lines: number;
  vertical: boolean;
}

/** 表紙を焼いた結果（`result.findings` の1行）。**数字と場所だけ**——本文は入らない */
export interface RunCoverRow {
  side: RunCoverSide;
  /** 焼いた画像（作品フォルダーからの相対パス） */
  filePath: string;
  bytes: number;
  /** 当てた体裁 */
  cover: RunCoverSpec;
  /** 本の組み方（`vertical`＝縦書きの本。5488 で確かめたいのはこちら） */
  bookWritingMode: "vertical" | "horizontal";
  /** 題名の文字（作品名か本の題。字ごとの向きを測る側が字と組にする） */
  title: string;
  /** 題名の色（#で始まる6桁の16進） */
  titleColor: string;
  /** 焼いた画像の寸法 */
  canvasWidth: number;
  canvasHeight: number;
  titleBlock?: RunCoverTitleBlock;
  /** 焼いた VS Code の版（作者の VS Code で焼けたかの裏付け） */
  vscodeVersion: string;
}

/** 時:分 だけ（日付は同じ日のことがほとんど。機械の時刻で出す） */
function formatClock(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "（不明）";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 記録（ログ）に残す形。**機能と依頼番号だけ**——作品の場所・話のパスは残さない
 * （ログは作品へ流れることがある）。
 */
export function runRequestForLog(ticket: Pick<RunTicket, "id" | "feature">): string {
  return `${String(ticket.feature).slice(0, 40)}（依頼番号 ${ticket.id}）`;
}
