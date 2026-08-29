import * as vscode from "vscode";
import {
  describeCurrentFont,
  listChoices,
} from "../core/manuscriptFonts";
import { cancelItem, isCancelItem } from "../views/dialogs";
import * as paths from "../core/paths";
import { fromUri } from "../core/paths";
import { scanWork } from "../core/scanner";
import { pathExists } from "../core/fileSystem";
import { formatChapterNumber } from "../core/episodeParser";
import {
  isBlankEpisode,
  isBlankText,
  planLatestEpisode,
} from "../core/latestEpisode";
import { buildManuscriptEditorHtml } from "../views/manuscriptEditorHtml";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../core/manuscriptViewTypes";
import {
  collectTermSpans,
  notationModeFor,
  renderTermMarks,
} from "../core/manuscriptRender";
import { TERM_COLORS } from "../core/termColors";
import {
  computeDocumentEdit,
  fromLfOffset,
  toLf,
  toLfOffset,
} from "../core/eolSpace";
import { createEditQueue } from "../core/editQueue";
import { countChars } from "../core/charCount";
import {
  currentCountMode,
  excludeRubyFromCount,
  pickCount,
} from "../core/countSettings";
import {
  hasEmphasis,
  toSiteNotation,
  validateEmphasis,
  validateRuby,
  type EmphasisSite,
} from "../core/ruby";
import { pickEmphasisSite, pickStyle } from "./ruby";
import { askText } from "../views/dialogs";
import { logLine } from "../core/logger";
import type { TermHighlighter } from "../views/termHighlight";
import type { TermKind } from "../core/termIndex";
import type { WorkEntry, WorkStats } from "../models/types";
import {
  describeMarkdownSuggestion,
  shouldSuggestMarkdown,
} from "../core/markdownConversion";
import { countSiteNotation } from "../core/ruby";

/**
 * 原稿エディタ（設計書6.25）。
 *
 * 作者の指摘（2026-08-23）：VS Code 1.131 で入った Markdown の編集画面
 * （hybrid Markdown editor）では、用語ハイライト・右クリックの設定資料・
 * ルビの表示が**どれも効かない**。あちらは拡張機能から手を出せる作りに
 * なっていないので、**縦書きと投稿サイト対応まで含めて自前で持つ**。
 *
 * ## 原稿は VS Code に保存させる
 *
 * `CustomTextEditorProvider` を使う。**自前で書き込まない。**
 *
 * この拡張機能でいちばん重い決まりは「作者の原稿を壊さない」である。
 * 自分でファイルへ書くと、文字コード・改行・外で編集されたときの扱いを
 * すべて自分で正しくやることになる（`atomicWrite.ts` の上書き禁止も
 * 含めて）。`CustomTextEditorProvider` は**普通のテキストエディタと同じ
 * 文書（`TextDocument`）の上で動く**ので、
 *
 * - 保存・元に戻す（Ctrl+Z）・変更の印は VS Code のものがそのまま効く
 * - 外部ツールで書き換えられたときの読み直しも VS Code がやる
 * - 文字コードと改行の扱いは、普通に開いたときと1文字も変わらない
 *
 * **書き換えは `WorkspaceEdit` で、変わった1か所だけ**を当てる
 * （`textEdit.ts`）。全文を差し替えると、1文字打つたびに「全文を
 * 書き換えた」1手になり、Ctrl+Z が使い物にならなくなる。
 *
 * ## 既定のエディタにはしない
 *
 * `priority` は `option`。**`.md` を開いたら勝手にこれになる、という
 * ことにはしない。** 作者は普通のエディタも使う。開き方は
 * 「縦書きで開く」か、VS Code の「エディターを再度開く」から選ぶ。
 */

/*
  入口のIDは `core/manuscriptViewTypes.ts` にある。**作品一覧も同じIDを使う**
  （本文は横書きの原稿エディタで開く）ので、views から features を引かずに
  済むよう外へ出した。ここからは、これまでどおりの名前で再輸出する。
*/
export {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
};

/**
 * 台帳の鍵（作者の報告、2026-08-29「誤字脱字パネルから本文に飛びません」）。
 *
 * **登録・削除・照会を、この1本に通す。** 以前は登録側が
 * `document.uri.toString()`、照会側が `paths.toUri(filePath).toString()` で
 * 別々に組み立てていた。同じファイルでも、Windowsのドライブ文字の大小
 * （`c:` と `C:`）や、日本語を含む道の百分率符号化の仕方が経路によって
 * 違えば、文字列は一致しない。**開いているのに「開いていない」と判定され、
 * 押しても何も起きない**という終わり方になる。
 *
 * 比べ方は、この作品がほかの場所で使っているもの（`samePath`）と揃える。
 */
export function manuscriptLedgerKey(
  location: string | vscode.Uri
): string {
  const filePath =
    typeof location === "string" ? location : fromUri(location);
  return paths.normalizeForComparison(filePath);
}

/**
 * いま開いている原稿エディタ（原稿の場所 → その画面）。
 *
 * **入口ごとの provider ではなく、ここ1つに集める。** 縦書きと横書きで
 * `ManuscriptEditorProvider` の実体は2つあり、片方だけが台帳を持つと
 * 「横書きで開いていた原稿へは飛べない」という取りこぼしが出る。
 */
const openManuscripts = new Map<
  string,
  {
    panel: vscode.WebviewPanel;
    /**
     * その行を示す。
     *
     * **画面が動き出す前に頼まれることがある**（開いた直後に飛んでくる）。
     * まだ `ready` が来ていなければ覚えておき、来たときに出す。
     * 送っても捨てられるだけなので、待つほかにやりようがない。
     */
    revealLine(line: number): void;
    /**
     * 下段の字数を測り直す（作者の指示、2026-08-29）。
     *
     * **保存のあと、執筆量を記録し終えてから呼ぶ**（`extension.ts`）。
     * 保存の知らせを自分で拾うと、記録より先に読むことがあり、
     * 「今日 +◯字」が1回分ずつ古くなる。
     */
    refreshCounts(): void;
  }
>();

/**
 * その原稿を開いている画面の、下段の字数を測り直す。
 *
 * 開いていなければ何もしない。呼ぶのは保存を記録し終えたところ1か所だけ。
 */
export function refreshManuscriptCounts(filePath: string): void {
  openManuscripts.get(manuscriptLedgerKey(filePath))?.refreshCounts();
}

/** 台帳に載るのを待つ上限。これを過ぎたら「開けなかった」とみなす */
const LEDGER_WAIT_MS = 1500;
/** 見に行く間隔 */
const LEDGER_POLL_MS = 50;

/**
 * 取れるようになるまで待つ。上限まで取れなければ undefined。
 *
 * **`vscode.openWith` の完了は、台帳に載ったことを意味しない。**
 * 台帳へ載せるのは `resolveCustomTextEditor` で、そちらは非同期に走る。
 * 待たずに引くと「開いていない」と読めてしまい、呼び出し側が同じ原稿を
 * 素のエディタでも開く（1つの原稿が2つの面で開く）。
 *
 * **台帳を直接見ずに、取り方（`get`）を受け取る。** そうしておけば、
 * VS Codeの画面を作らずに待ち方だけを確かめられる。
 */
export async function waitFor<T>(
  get: () => T | undefined,
  budgetMs: number = LEDGER_WAIT_MS,
  pollMs: number = LEDGER_POLL_MS
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * MD化の案内をもう出したファイル（この起動中だけ覚える）。
 *
 * 断られたぶんは端末に残す（`deps.markdownDeclined`）。こちらは
 * 「開くたびに同じ案内が出る」のを止めるためだけのもので、
 * VS Code を開き直せば1度は出る——**断りではなく、後回しだから**である。
 */
const markdownAsked = new Set<string>();

/**
 * 画面へ出す字数。**数え方は他の画面と揃える**（純／総の設定、ルビを数えるか）。
 * ここだけ違う数字が出ると、どちらが本当か分からなくなる。
 */
function countFor(text: string): number {
  return pickCount(
    countChars(text, excludeRubyFromCount()),
    currentCountMode()
  );
}

/**
 * 同じファイルを指しているか。
 *
 * **文字列の一致では足りない。** Windowsではドライブ文字の大小や
 * 区切りの表れ方が経路によって違う（`paths.normalizeForComparison`）。
 * 取り違えると「いま開いている話」が見つからず、前後の話へ移れない。
 */
function samePath(left: string, right: string): boolean {
  return (
    paths.normalizeForComparison(left) === paths.normalizeForComparison(right)
  );
}

/**
 * 話を新しく作るときの名前の決まり。**`novelai.addEpisode` と揃える**
 * （揃えないと、同じ作品の中でファイル名の形が2種類できる）。
 */
function episodeNaming(): { digits: number; extension: string } {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    digits: config.get<number>("episodeNumberDigits", 3),
    extension: config.get<string>("episodeFileExtension", ".txt"),
  };
}

/**
 * いまアクティブなタブが原稿エディタなら、その入口のID。
 *
 * **開いていない原稿へ飛ぶときに、どちらの向きで開くかを決める。**
 * 縦書きで書いている人の画面に横書きが出ると、書いていた向きが変わる。
 */
function activeManuscriptViewType(): string | undefined {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input: unknown = tab?.input;
    if (!(input instanceof vscode.TabInputCustom)) return undefined;
    if (
      input.viewType === MANUSCRIPT_EDITOR_VIEW_TYPE ||
      input.viewType === MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    ) {
      return input.viewType;
    }
    return undefined;
  } catch {
    // タブの種類を読めない環境（古いVS Code・試験の代役）では、
    // 「原稿エディタではない」として素のエディタへ譲る
    return undefined;
  }
}

/** その入口が、はじめにどちらの向きで開くか */
export type ManuscriptOrientation =
  /** 設定（`manuscriptEditor.vertical`）に従う */
  | "setting"
  /** 必ず横書き */
  | "horizontal";

/** 画面から届く用件 */
type Incoming =
  | { type: "ready" }
  | { type: "edit"; text: string }
  | { type: "count"; text: string }
  | { type: "ruby"; text: string; start: number; end: number }
  | { type: "emphasis"; text: string; start: number; end: number }
  | { type: "copyForPosting" }
  | { type: "openTerm"; id: string; kind: TermKind }
  /**
   * 右クリックの時点で、**開いている**資料パネルへ該当項目を出す
   * （作者の指示、2026-08-28）。開いていなければ何もしない——
   * 開くのは品書きの「設定資料を見る」（openTerm）だけ。
   */
  | { type: "previewTerm"; id: string; kind: TermKind }
  | { type: "chat"; start: number; end: number }
  /**
   * 書体を選ぶ。
   *
   * `installed` は**画面が測った**「この端末に入っている書体」。
   * 測れなかったときは省く（全部並べる。測れないことを「入っていない」と
   * 読み替えると、選べるものが消える）
   */
  | { type: "pickFont"; installed?: string[] }
  /** 最新話を書く（設計書6.25.5） */
  | { type: "openLatest" }
  /**
   * 前の話・次の話（作者の指示、2026-08-29）。
   *
   * **どの話かを決めるのはこちら。** 画面はファイルの並びを知らない
   * （走査の結果を持っているのは拡張機能側である）。
   */
  | { type: "openNeighbor"; direction: "prev" | "next" }
  /**
   * 画面側で起きたことを記録する（設計書6.34）。
   *
   * 組んで書く面の安全弁（記法→DOM→記法 の往復が一致しないとき）は、
   * **黙って開かないだけ**では何が起きたか誰にも分からない。通知は出さず、
   * ログには必ず残す。
   */
  | { type: "log"; text: string };

export interface ManuscriptEditorDeps {
  highlighter: TermHighlighter;
  /** 用語から設定資料を開く。extension.ts の登録と同じ道を通す */
  openSettings(work: WorkEntry, kind: TermKind, id: string): Promise<void>;
  /**
   * **開いている**資料パネルへ該当項目を出す（無ければ何もしない）。
   * 右クリックのたびに新しいパネルを開いては、作者の画面を奪ってしまう。
   */
  previewTerm(work: WorkEntry, kind: TermKind, id: string): Promise<void>;
  /**
   * 選んだところをAIに相談する。
   *
   * **相談パネルは「いま開いている本文」を普通のエディタから受け取る。**
   * 原稿エディタには `TextEditor` が無いので、同じ文書を横に開いてから
   * 渡す。開かずに相談を始めると、**前に開いていた別の作品について
   * 答えることになる**。
   */
  openChat(
    document: vscode.TextDocument,
    range: vscode.Range | undefined
  ): Promise<void>;
  /**
   * 作品ぜんたいの字数（下段に出す。作者の指示、2026-08-29）。
   *
   * **走査は作品一覧の結果を借りる。** 開いたときと保存したときにしか
   * 呼ばないが、それでも4万字の作品を独立に読み直す理由は無い。
   */
  workStats(work: WorkEntry): Promise<WorkStats>;
  /**
   * この原稿で今日書いた純文字数（設計書6.3）。
   * 記録を止めている作者には `undefined` が返る（0と書かない）。
   */
  todayFileCount(work: WorkEntry, filePath: string): Promise<number | undefined>;
  /**
   * 執筆量の基準を置き直す（設計書6.3.2）。
   *
   * **拡張機能が本文ファイルを作った直後に呼ぶ。** 記録は「ファイル数が
   * 変わった回は数えない」（投稿サイトからの取り込みを執筆に数えないため）
   * という決まりで動いている。「次の話 →」や「最新話を書く」で空の話を
   * 作ったあと、作者がそこへ書いて保存すると**その回がこの決まりに当たり、
   * 「今日 +0字」になって以後も数えられない。**
   *
   * ここで空のファイルごと基準に入れておけば、次の保存は差分として数えられる。
   */
  rebaseline(work: WorkEntry): Promise<void>;
  /**
   * 読み仮名の入った `.txt` を `.md` にする（作者の指示、2026-08-29）。
   *
   * **既存の変換と同じ経路を通す**（`features/markdownConvert.ts` の
   * `convertOne`）。ここで名前を変える手順を書き起こすと、
   * 「中のルビも直す」（設計書6.12.4）が抜けた別物ができる。
   * 変換後のパスを返す。断られた・失敗したときは undefined。
   */
  convertToMarkdown(filePath: string): Promise<string | undefined>;
  /** MD化の案内を「今はしない」と断られたファイル（端末に残す） */
  markdownDeclined(): readonly string[];
  /** 断られたことを覚える */
  declineMarkdown(filePath: string): Promise<void>;
}

export class ManuscriptEditorProvider
  implements vscode.CustomTextEditorProvider
{
  constructor(
    private readonly deps: ManuscriptEditorDeps,
    /**
     * この入口の向き。
     *
     * **縦書きの入口は設定に従う。** `manuscriptEditor.vertical` は
     * 0.19.0からある設定で、既定は縦。**必ず縦に決め打つと、その設定が
     * 黙って無視される**（横で書く人が設定していたら、その指定が消える）。
     */
    private readonly orientation: ManuscriptOrientation = "setting",
    /** 開き直すときに使う入口のID（「最新話を書く」で同じ向きを保つ） */
    private readonly viewType: string = MANUSCRIPT_EDITOR_VIEW_TYPE
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = buildManuscriptEditorHtml(
      createNonce(),
      panel.webview.cspSource
    );

    /**
     * この原稿の記法（設計書6.12）。
     *
     * `.txt` は投稿サイトの形をそのまま保つ決まりなので、ルビも傍点も
     * `｜漢字《かんじ》` `《《強調》》` で書かれている。**記法のまま
     * 見せるのではなく、こちらで組んで見せる**（作者の依頼、2026-08-29
     * 「テキストファイルもルビなどを再現して、同様に表示できるように」）。
     *
     * ファイルの名前で決まるので、開いている間は変わらない。
     */
    const notation = notationModeFor(fromUri(document.uri));

    const send = async (): Promise<void> => {
      // **画面へはLF区切りで渡す**（core/eolSpace.ts）。textareaは値を
      // LFへ正規化するので、CRLFのまま渡すと本文・用語の位置・組んで書く面の
      // 安全弁がすべて1行ごとに1文字ずつずれる（実際にずれていた）
      const text = toLf(document.getText());
      const found = await this.deps.highlighter.indexFor(
        fromUri(document.uri)
      );
      const index = found?.index;
      await panel.webview.postMessage({
        type: "update",
        text,
        // **組んで書く面も、この記法で組む**（画面側に写しを持たせない）
        notation,
        /*
          **組み上がりのHTMLはもう送らない**（0.25.2）。
          送り先だった「読む」面・「並べる」面は、0.24.14で切り替えの
          ボタンが無くなった時点から**開く道が無く**、画面側は届いたHTMLを
          溜めるだけになっていた。4万字の本文では段落が千を超えるので、
          打つたびにそれを組んでいたことになる。
        */
        // **打つ面に重ねる用語の色**（設計書6.25.6）。
        // 打つ面は textarea なので、中の一部だけを飾れない。
        // 同じ本文を重ねて、用語のところだけ色を付ける（それ以外は透明）
        marks: renderTermMarks(text, index),
        // 右クリックで「どの用語の上か」を知るために使う。
        // textarea の中に要素は無いので、当たり判定を要素で取れない
        terms: collectTermSpans(text, index),
        hasTerms: (index?.size ?? 0) > 0,
        // **色分けの凡例は送らない**（作者の指示、2026-08-28
        // 「文字の色分け説明は不要です」）。色の意味は設定資料パネルの
        // タブが同じ色で示す
        colors: colorsFor(),
        ...readAppearance(this.orientation),
      });
      await this.sendCount(panel, text);
    };

    /**
     * 台帳へ載せる（誤字脱字の提案から、この画面へ飛べるようにする）。
     *
     * **`ready` を待ってから行を示す。** 開いた直後の画面へ送っても、
     * まだスクリプトが走っていないので捨てられる（設定資料パネルの
     * `whenReady` と同じ事情）。
     */
    let webviewReady = false;
    let pendingReveal: number | undefined;
    const revealLineNow = (line: number): void => {
      void panel.webview.postMessage({ type: "revealLine", line });
    };
    const key = manuscriptLedgerKey(document.uri);
    const entry = {
      panel,
      revealLine: (line: number): void => {
        if (!webviewReady) {
          pendingReveal = line;
          return;
        }
        revealLineNow(line);
      },
      refreshCounts: (): void => {
        void this.sendFootCounts(panel, document);
      },
    };
    openManuscripts.set(key, entry);
    panel.onDidDispose(() => {
      // 同じ文書が開き直されていたら、そちらの札を消さない
      if (openManuscripts.get(key) === entry) openManuscripts.delete(key);
    });

    const subscriptions: vscode.Disposable[] = [];

    /**
     * 文書が変わるたびに送り直すが、**まとめてから送る**。
     *
     * 打った本文はこちらへ即座に届き、文書が変わり、その文書をまた
     * 画面へ送り返す。4万字の本文を1語ごとに組み立て直すと、
     * 打っている手が止まる（作者が実機で当たった「変換が途中で止まる」）。
     *
     * **打っている面は画面側が持っている**ので、少し遅れて届いても困らない。
     */
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSend = (): void => {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        sendTimer = undefined;
        void send();
      }, 120);
    };

    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        scheduleSend();
      }),
      new vscode.Disposable(() => {
        if (sendTimer) clearTimeout(sendTimer);
      })
    );

    // 色はテーマで変わる（明るい配色と暗い配色で読める色が違う）。
    // 切り替わったら送り直す
    subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        void send();
      })
    );

    // **見た目の設定を変えたら、その場で効かせる**（設計書6.25.3）。
    // 0.19.0の書体の設定は、変えても**開き直すまで効かなかった**。
    // 設定を直したのに何も起きなければ、作者は壊れていると受け取る
    subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("novelai.manuscriptEditor")) return;
        void send();
      })
    );

    panel.onDidDispose(() => {
      for (const item of subscriptions) item.dispose();
    });

    /**
     * 画面から届いた本文を、**1つずつ順に**文書へ当てる。
     *
     * ここを通していなかったために、作者が実機で当たった
     * 「改行すると空行が入る」が起きていた（2026-08-24、設計書6.25.2）。
     * 理由は `core/editQueue.ts` に書いてある。
     */
    const queueEdit = createEditQueue((text) => this.applyEdit(document, text));

    panel.webview.onDidReceiveMessage(async (message: Incoming) => {
      switch (message.type) {
        case "ready":
          await send();
          webviewReady = true;
          // 開くのを待ってもらっていた「この行を示す」を、ここで出す
          if (pendingReveal !== undefined) {
            const line = pendingReveal;
            pendingReveal = undefined;
            revealLineNow(line);
          }
          // 下段の字数は**本文より後**でよい（作品ぜんたいの走査が要る）。
          // 待たせると、開いた直後の本文の表示まで遅れる
          void this.sendFootCounts(panel, document);
          // 読み仮名の入った .txt なら、MD化を勧める（作者の指示、2026-08-29）
          void this.suggestMarkdown(document);
          break;

        case "edit":
          await queueEdit(message.text);
          break;

        case "count":
          await this.sendCount(panel, message.text);
          break;

        case "ruby":
          await this.insertRuby(document, panel, message, "ruby");
          break;

        case "emphasis":
          await this.insertRuby(document, panel, message, "emphasis");
          break;

        case "copyForPosting":
          await this.copyForPosting(document);
          break;

        case "openTerm": {
          const found = await this.deps.highlighter.indexFor(
            fromUri(document.uri)
          );
          if (!found) {
            // **黙って戻らない**（作者の報告、2026-08-28「用語上で右クリック
            // したとき、パネルの説明は切り替わりません」）。ここで落ちると
            // 押しても何も起きないので、どこで止まったかを残す
            logLine(
              "原稿エディタ：右クリックの設定資料——この原稿が属する作品を" +
                "見つけられませんでした"
            );
            return;
          }
          await this.deps.openSettings(found.work, message.kind, message.id);
          break;
        }

        case "previewTerm": {
          // 右クリックの時点の追従。作品が分からなければ黙って何もしない
          // （品書き自体は出ており、openTerm 側にログがある）
          const found = await this.deps.highlighter.indexFor(
            fromUri(document.uri)
          );
          if (!found) return;
          await this.deps.previewTerm(found.work, message.kind, message.id);
          break;
        }

        case "openLatest":
          await this.openLatestEpisode(document);
          break;

        case "openNeighbor":
          await this.openNeighborEpisode(document, message.direction);
          break;

        case "pickFont":
          await pickFont(message.installed);
          break;

        case "log":
          logLine(`原稿エディタ：${message.text}`);
          break;

        case "chat": {
          // 画面の位置はLF空間。文書の位置へ直してから範囲にする
          const source = document.getText();
          await this.deps.openChat(
            document,
            message.start >= 0 && message.end > message.start
              ? new vscode.Range(
                  document.positionAt(fromLfOffset(source, message.start)),
                  document.positionAt(fromLfOffset(source, message.end))
                )
              : undefined
          );
          break;
        }
      }
    });
  }

  /**
   * その原稿を原稿エディタで開いて、行を示す（作者の依頼、2026-08-28）。
   *
   * 「誤字脱字から開く場合は、現在メインで開いているエディターと同じ
   * エディターで開いたうえで場所を示してください」。提案パネルの「飛ぶ」は
   * 素のテキストエディタしか開かず、**縦書きで書いていた面から追い出されて
   * いた**。
   *
   * 引き受けられたときだけ true を返す。false のときは、呼んだ側が
   * これまでどおり素のエディタで開く——**押しても何も起きない、を作らない。**
   *
   * 引き受けるのは次の3つである。
   *
   * 1. その原稿を原稿エディタで開いている（前に出して、行を示す）
   * 2. 開いてはいないが、**いま見ているタブが原稿エディタ**（＝作者は
   *    この画面で書いている）。同じ向きの入口で開いてから示す
   * 3. どちらでもないが、**その原稿が登録された作品の話**である
   *    （作者の指示、2026-08-29「本文ファイルは原稿エディター横書きで開く」）。
   *    作品一覧から開いたときと同じ既定にそろえる
   *
   * 話でないファイル（プロット・設定資料）は、これまでどおり素のエディタへ譲る。
   *
   * **どの枝で降りたかを必ず残す。** 「押しても何も起きない」が実機で
   * 起きたとき（2026-08-29）、どこで止まったのかを示すものが1つも無かった。
   */
  async revealLine(filePath: string, line: number): Promise<boolean> {
    const uri = paths.toUri(filePath);
    const key = manuscriptLedgerKey(filePath);

    const open = openManuscripts.get(key);
    if (open) {
      open.panel.reveal();
      open.revealLine(line);
      return true;
    }
    logLine(
      `原稿エディタ：${filePath} は台帳にありません（鍵: ${key}）。開き直します。`
    );

    const viewType =
      activeManuscriptViewType() ??
      ((await this.isRegisteredEpisode(filePath))
        ? MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
        : undefined);
    if (!viewType) {
      logLine(
        `原稿エディタ：${filePath} は作品の話ではないため、素のエディタへ譲ります。`
      );
      return false;
    }

    await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
    /*
      **台帳に載るまで待つ。**

      台帳へ載せるのは `resolveCustomTextEditor` で、そちらは非同期に走る。
      `openWith` が戻った時点で載っている保証は無く、載っていないと false を
      返して、呼び出し側が**同じファイルを素のエディタでも開く**（1つの原稿が
      2つの面で開く）。開いた直後に取りに行くのが早すぎるだけなので、
      少しだけ待てばよい。
    */
    const opened = await waitFor(() => openManuscripts.get(key));
    // **開けなかったときは引き受けない。** ここで true を返すと、
    // 押しても何も起きないまま終わる（素のエディタへも行かない）
    if (!opened) {
      logLine(
        `原稿エディタ：${filePath} を開けなかったため、行を示せませんでした（鍵: ${key}）。`
      );
      return false;
    }
    opened.revealLine(line);
    return true;
  }

  /**
   * その原稿が、登録された作品の「話」か。
   *
   * **開く画面を決めるのは中身であって、拡張機能の都合ではない。**
   * 本文（話）なら横書きの原稿エディタ、それ以外（プロット・設定資料）は
   * 素のエディタ、という切り分けを、作品一覧と同じ基準で行う。
   *
   * 走査は、その原稿を原稿エディタで開いていないときにしか通らない
   * （開いていれば台帳で当たる）ので、飛ぶたびに走ることはない。
   */
  private async isRegisteredEpisode(filePath: string): Promise<boolean> {
    try {
      const found = await this.deps.highlighter.indexFor(filePath);
      if (!found) return false;
      const { episodes } = await scanWork(found.work);
      return episodes.some((episode) =>
        samePath(episode.filePath, filePath)
      );
    } catch (error) {
      // **走査に失敗しても、飛べなくならない。** 素のエディタへ譲る
      logLine(
        `原稿エディタ：${filePath} が作品の話かを確かめられませんでした（${
          error instanceof Error ? error.message : String(error)
        }）。`
      );
      return false;
    }
  }

  /**
   * 画面の本文を文書へ返す。**変わった1か所だけ**を当てる。
   */
  private async applyEdit(
    document: vscode.TextDocument,
    next: string
  ): Promise<void> {
    // **差分はLF空間で取り、位置だけを文書の空間へ戻す**（core/eolSpace.ts）。
    // 文書ぜんたいをCRLFへ揃えてから差分を取ると、LFだけの行が混ざった
    // ファイルでは、その行から打った位置までが丸ごと差分になり、
    // **触っていない行の改行まで書き換わる**
    const edit = computeDocumentEdit(
      document.getText(),
      next,
      document.eol === vscode.EndOfLine.CRLF
    );
    if (!edit) return;

    const change = new vscode.WorkspaceEdit();
    change.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(edit.start),
        document.positionAt(edit.end)
      ),
      edit.insert
    );
    const applied = await vscode.workspace.applyEdit(change);
    if (!applied) {
      // **黙って捨てない。** 当たらなかった場合、このあと文書の側の本文が
      // 画面へ送り返され、打った内容が消えたように見える。理由が残っていないと
      // 「勝手に消えた」としか分からない
      logLine(
        `原稿エディタ：打った内容を文書へ当てられませんでした（${edit.start}〜${edit.end}）。`
      );
    }
  }

  private async sendCount(
    panel: vscode.WebviewPanel,
    text: string
  ): Promise<void> {
    const value = countFor(text);
    await panel.webview.postMessage({
      type: "count",
      // **下段の「このファイル」はこの数字を使う**（作者の指示、2026-08-29）。
      // 画面側で数え直すと、純／総の設定やルビの扱いが食い違う。
      // 上の帯にも同じ字数を出していたが、重複なので消した（同日の指示）
      value,
    });
  }

  /**
   * 下段の「作品 ◯◯字 ／ 今日 +◯◯字」を送る（作者の指示、2026-08-29）。
   *
   * **打鍵ごとには送らない。** 開いたときと、保存を記録し終えたとき
   * （`refreshManuscriptCounts`）の2回だけ。作品の合計は全話の走査が要り、
   * 1打鍵ごとに数え直すと打つ手が止まる。その間の増減は、画面側が
   * 「このファイルの字数の差」を足して見せる。
   *
   * `fileAtBase` を一緒に送るのは、その差を取るための基準である
   * （測った瞬間のこのファイルの字数）。
   */
  private async sendFootCounts(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument
  ): Promise<void> {
    const filePath = fromUri(document.uri);
    const found = await this.deps.highlighter.indexFor(filePath);
    // 作品に属さない原稿では、このファイルの字数だけを出す（作品も今日も無い）
    if (!found) return;

    try {
      const stats = await this.deps.workStats(found.work);
      const today = await this.deps.todayFileCount(found.work, filePath);
      await panel.webview.postMessage({
        type: "counts",
        workTotal: pickCount(stats.totals, currentCountMode()),
        fileAtBase: countFor(toLf(document.getText())),
        today,
      });
    } catch (error) {
      // **字数が出ないだけで、書くほうは止めない。** 黙って諦めずに残す
      logLine(
        `原稿エディタ：下段の字数を出せませんでした（${
          error instanceof Error ? error.message : String(error)
        }）。`
      );
    }
  }

  /**
   * 読み仮名の入った `.txt` を開いたら、MD化を勧める（作者の指示、2026-08-29）。
   *
   * **控えめに1度だけ。** 断られたらそのファイルでは二度と出さないし、
   * 断られていなくても、同じ画面で開き直すたびには出さない
   * （`markdownAsked`）。毎回促すと、案内そのものが邪魔になる。
   */
  private async suggestMarkdown(document: vscode.TextDocument): Promise<void> {
    const filePath = fromUri(document.uri);
    if (markdownAsked.has(paths.normalizeForComparison(filePath))) return;

    const counts = countSiteNotation(document.getText());
    if (
      !shouldSuggestMarkdown(filePath, counts, this.deps.markdownDeclined())
    ) {
      return;
    }
    markdownAsked.add(paths.normalizeForComparison(filePath));

    const convert = ".mdにする";
    const later = "今はしない";
    const picked = await vscode.window.showInformationMessage(
      describeMarkdownSuggestion(counts),
      convert,
      later
    );
    if (picked === later) {
      await this.deps.declineMarkdown(filePath);
      return;
    }
    if (picked !== convert) return;

    /*
      **先に保存する。** 変換はディスク上のファイルの名前を変えるので、
      打ちかけを抱えたまま変えると、その中身は行き場を失う（開いていた面が
      無くなったファイルを指したままになる）。操作メニューからのMD化も
      同じ手順を踏んでいる（`saveDirtyDocumentsBeforeExtraction`）。
    */
    if (document.isDirty && !(await document.save())) {
      void vscode.window.showWarningMessage(
        "保存できなかったため、.md にしませんでした。" +
          "保存してから、詳細メニューの「本文を .md にする」でお試しください。"
      );
      return;
    }

    const converted = await this.deps.convertToMarkdown(filePath);
    if (!converted) return;

    /*
      **変換に成功したときだけ、元の .txt の面を閉じる。**

      閉じずに残すと、作者がそのタブへ戻って打ち、保存した瞬間に
      **消えたはずの .txt が復活する**（VS Code は無くなったファイルへも
      保存できる）。同じ話が .txt と .md の2つになり、走査は両方を話として
      数え、以後どちらが本物か分からなくなる。

      閉じるのは新しい .md を開く**前**にする。あとにすると、開いた面が
      すぐ後ろの `dispose` に巻き込まれて見えることがある。
    */
    const stale = openManuscripts.get(manuscriptLedgerKey(filePath));
    if (stale) {
      logLine(`原稿エディタ：.md 化にともない ${filePath} の面を閉じます。`);
      stale.panel.dispose();
    }

    // 変換すると元のファイルは消える（名前が変わる）。同じ入口で開き直す
    await this.openAsManuscript(converted);
  }

  /**
   * 選んだところにルビ・傍点を入れる。
   *
   * **「読む」面から押されたときは、位置が分からない。**
   * 組み立てたHTMLの選択範囲を本文の位置へ戻すのは当てにならない
   * （ルビの読み仮名や色分けの印が混ざる）ので、そのときは
   * 「書く面で選んでください」と断る。黙って別のところへ入れない。
   */
  private async insertRuby(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    message: { text: string; start: number; end: number },
    kind: "ruby" | "emphasis"
  ): Promise<void> {
    const label = kind === "ruby" ? "ルビ" : "傍点";

    // **`.txt` へは入れない**（設計書6.12）。投稿サイトから持ってきた形を
    // そのまま保つため、txtはルビ・傍点の対象外と決めてある。この画面は
    // txtも開けるので、ここで断る
    if (!fromUri(document.uri).toLowerCase().endsWith(".md")) {
      void vscode.window.showWarningMessage(
        `${label}はMarkdown（.md）のファイルで使えます。`,
        {
          modal: true,
          detail:
            "テキスト（.txt）は投稿サイトから持ってきた形をそのまま保つため、" +
            "対象外にしています。\n\n" +
            "詳細メニューの「執筆AI支援 → その他支援 → 本文を .md にする」で" +
            "変えられます（中身は1文字も変わりません）。",
        }
      );
      return;
    }

    if (message.start < 0) {
      void vscode.window.showInformationMessage(
        `${label}は「書く」面で入れてください。` +
          "読む面の選択は、組み立てた表示の上のものなので、" +
          "本文のどこを指しているかを確かめられません。"
      );
      return;
    }

    // 画面の位置はLF空間なので、文書の位置へ直してから使う。
    // 直さないと、CRLFの原稿では1行につき1文字ずつ後ろを指し、
    // 下の「今もその文字か」の確認が必ず落ちてルビが振れなかった
    const original = document.getText();
    let start = fromLfOffset(original, message.start);
    let end = fromLfOffset(original, message.end);
    let base = message.text;

    if (start === end) {
      if (kind === "emphasis") {
        void vscode.window.showInformationMessage(
          "傍点を付ける文字を選んでから実行してください。"
        );
        return;
      }
      // ルビは、直前の漢字のまとまりを拾う（普通のエディタと同じ扱い）
      const before = original.slice(0, start);
      const match = before.match(/[一-鿿々々ヶ]+$/u);
      if (!match) {
        void vscode.window.showInformationMessage(
          "ルビを振る文字を選んでから実行してください。" +
            "（漢字の直後なら、選ばなくても拾います）"
        );
        return;
      }
      start -= match[0].length;
      base = match[0];
    }

    let inserted: string;
    if (kind === "ruby") {
      const reading = await askText({
        title: `「${base}」の読み`,
        prompt: "ひらがな・カタカナで入力してください",
        placeHolder: "よみがな",
        validateInput: (value) => validateRuby(base, value) ?? undefined,
      });
      if (!reading) return;
      inserted = `{${base}|${reading.trim()}}`;
    } else {
      const problem = validateEmphasis(base);
      if (problem) {
        void vscode.window.showWarningMessage(problem);
        return;
      }
      inserted = `{{${base}}}`;
    }

    // **入れる直前に、選んだところが今もその文字かを確かめる。**
    // 読みを打っている間に、別の経路で本文が変わっていることがある
    const now = document.getText().slice(start, end);
    if (now !== base) {
      void vscode.window.showWarningMessage(
        `${label}を入れませんでした。` +
          "読みを入力している間に本文が変わったため、" +
          "選んだところが同じ文字ではなくなっています。"
      );
      return;
    }

    const change = new vscode.WorkspaceEdit();
    change.replace(
      document.uri,
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      inserted
    );
    await vscode.workspace.applyEdit(change);

    // 入れたところを選び直す。続けて直したくなることが多い。
    // **画面へ返す位置はLF空間へ戻す**（入れた記法に改行は無いので、
    // 長さはどちらの空間でも同じ）
    const lfStart = toLfOffset(document.getText(), start);
    await panel.webview.postMessage({
      type: "select",
      start: lfStart,
      end: lfStart + inserted.length,
    });
  }

  /**
   * 投稿サイトの記法に直してコピーする。
   *
   * **原稿には触らない。** 貼り付ける先はサイトの投稿欄である。
   * 選択は使わず本文全体を出す——画面の選択範囲は「読む」面と
   * 「書く」面で意味が違い、どちらの意味で出したのかが作者に伝わらない。
   */
  /**
   * 最新話を開く。白紙でなければ、次の話を作って開く（設計書6.25.5）。
   *
   * **同じ向きの入口で開き直す。** 縦書きで書いていた人が、次の話だけ
   * 横書きで開かれると困る。
   */
  private async openLatestEpisode(
    document: vscode.TextDocument
  ): Promise<void> {
    const found = await this.deps.highlighter.indexFor(fromUri(document.uri));
    if (!found) {
      void vscode.window.showWarningMessage(
        "この原稿の作品が分かりませんでした。作品として登録されているかご確認ください。"
      );
      return;
    }

    const { episodes, manuscriptDir } = await scanWork(found.work);

    // **白紙かどうかは、いま開いている本文で判断できることがある。**
    // 同じファイルなら読み直さない（保存前の状態が正しい）
    const current = fromUri(document.uri);
    const plan = planLatestEpisode(
      episodes,
      (episode) =>
        // いま開いている話は、**保存前の中身**で見る（打ちかけを白紙にしない）。
        // ほかは走査が数えた文字数で見る（読み直さない）
        samePath(episode.filePath, current)
          ? isBlankText(document.getText())
          : isBlankEpisode(episode),
      episodeNaming(),
      (chapter, rule) =>
        `${formatChapterNumber(chapter, rule.digits)}${rule.extension}`
    );

    if (plan.kind === "open") {
      if (samePath(plan.episode.filePath, current)) {
        void vscode.window.showInformationMessage(
          "いま開いているのが最新話です。このまま書けます。"
        );
        return;
      }
      await this.openAsManuscript(plan.episode.filePath);
      return;
    }

    await this.createAndOpen(found.work, manuscriptDir, plan.fileName);
  }

  /**
   * 前の話・次の話を開く（作者の指示、2026-08-29）。
   *
   * **並びは走査の結果そのまま**（`scanWork` の episodes）。話数で並べ直す
   * のは走査の仕事で、ここでやると2か所に並べ方が生まれる。
   *
   * 次の話の決め方は3通りある。
   *
   * | いまの話 | どうするか |
   * |---|---|
   * | 後ろに話がある | それを開く |
   * | 最終話で、**白紙** | 「最新話です。」と伝えるだけ（作らない） |
   * | 最終話で、本文がある | 次の話数を作って開く |
   *
   * 白紙のときに作らないのは「最新話を書く」と同じ考え方である
   * （押すたびに空のファイルが増えるのを避ける。設計書6.25.5）。
   */
  private async openNeighborEpisode(
    document: vscode.TextDocument,
    direction: "prev" | "next"
  ): Promise<void> {
    const current = fromUri(document.uri);
    const found = await this.deps.highlighter.indexFor(current);
    if (!found) {
      void vscode.window.showInformationMessage(
        "この原稿は作品の話として認識できません。"
      );
      return;
    }

    const { episodes, manuscriptDir } = await scanWork(found.work);
    const at = episodes.findIndex((episode) =>
      samePath(episode.filePath, current)
    );
    if (at < 0) {
      // 作品には属しているが、本文フォルダーの外にある（プロットなど）
      void vscode.window.showInformationMessage(
        "この原稿は作品の話として認識できません。"
      );
      return;
    }

    if (direction === "prev") {
      if (at === 0) {
        void vscode.window.showInformationMessage("最初の話です。");
        return;
      }
      await this.openAsManuscript(episodes[at - 1].filePath);
      return;
    }

    if (at < episodes.length - 1) {
      await this.openAsManuscript(episodes[at + 1].filePath);
      return;
    }

    // ここから先は最終話。**保存前の中身で白紙かを見る**（打ちかけを白紙にしない）
    if (isBlankText(document.getText())) {
      void vscode.window.showInformationMessage("最新話です。");
      return;
    }

    /*
      次の話数の決め方は「最新話を書く」と同じものを使う（`planLatestEpisode`）。
      **ここは「最終話に本文がある」と分かっている場面**なので、白紙の判定は
      常に false を返す＝必ず「次を作る」枝へ入る。
    */
    const plan = planLatestEpisode(
      episodes,
      () => false,
      episodeNaming(),
      (chapter, rule) =>
        `${formatChapterNumber(chapter, rule.digits)}${rule.extension}`
    );
    if (plan.kind !== "create") return;
    await this.createAndOpen(found.work, manuscriptDir, plan.fileName);
  }

  /**
   * 白紙の話を作って開く。**既にあるなら作らない**（上書き禁止）。
   *
   * 「最新話を書く」と「次の話」で分け合う。作り方が2つあると、
   * 片方だけがファイル名の決まりから外れる日が来る。
   */
  private async createAndOpen(
    work: WorkEntry,
    manuscriptDir: string,
    fileName: string
  ): Promise<void> {
    const filePath = paths.join(manuscriptDir, fileName);
    if (await pathExists(filePath)) {
      // 走査の取りこぼしなど。**上書きしない**
      await this.openAsManuscript(filePath);
      return;
    }
    await vscode.workspace.fs.writeFile(
      paths.toUri(filePath),
      new TextEncoder().encode("")
    );
    logLine(`原稿エディタ：${fileName} を作成`);
    // **執筆量の基準を置き直す**（設計書6.3.2）。ここで入れておかないと、
    // このあと作者が書いて保存した回が「ファイル数が変わった」に当たり、
    // その分が「今日 +0字」になって消える
    await this.deps.rebaseline(work);
    void vscode.window.showInformationMessage(`${fileName} を作りました。`);
    await this.openAsManuscript(filePath);
  }

  /** 同じ向きの原稿エディタで開く */
  private async openAsManuscript(filePath: string): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.openWith",
      paths.toUri(filePath),
      this.viewType
    );
  }

  private async copyForPosting(document: vscode.TextDocument): Promise<void> {
    // **訊き方は普通のエディタと同じものを使う**（`features/ruby.ts`）。
    // 画面ごとに選択肢の言葉が違うと、同じ操作に見えなくなる
    const style = await pickStyle();
    if (!style) return;

    const source = document.getText();

    // **傍点が入っているときだけ、貼り付け先を訊く**（設計書6.12.4）。
    // ルビはどのサイトでも同じ書き方で通る
    let site: EmphasisSite = "kakuyomu";
    if (style.id === "site" && hasEmphasis(source)) {
      const picked = await pickEmphasisSite();
      if (!picked) return;
      site = picked;
    }

    await vscode.env.clipboard.writeText(
      toSiteNotation(source, style.id, site)
    );
    void vscode.window.showInformationMessage(
      `本文全体を${style.label}に変換して、クリップボードへ入れました。` +
        "原稿はそのままです。"
    );
  }
}

/**
 * 見た目の設定を読む。
 *
 * **縦書きかどうかは「はじめの向き」だけ**を決める。画面で切り替えた
 * 状態はその原稿ごとに覚える（`vscode.setState`）ので、設定を書き換えても
 * すでに開いている原稿の向きは変わらない。
 */
/**
 * 書体を選んでもらい、設定へ書き戻す（設計書6.25.3）。
 *
 * **設定を1つの出どころにする。** 原稿ごとに覚える形にすると、
 * 新しい話を開くたびに書体が戻る。作者が選ぶのは「この作品の書体」ではなく
 * 「自分の読み書きする書体」である。
 *
 * **入っていない書体も並べて、入っていないと書く。** 消すと
 * 「あるはずのものが無い」に見え、なぜ選べないのかが分からない
 * （`processAvailability.ts` と同じ考え方）。
 */
async function pickFont(installed?: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration("novelai");
  const current = config.get<string>("manuscriptEditor.fontFamily", "").trim();
  const available = installed ? new Set(installed) : undefined;

  const choices = listChoices(current, available).map((font) => ({
    label: (font.selected ? "$(check) " : "") + font.label,
    description: font.kind,
    detail: font.installed
      ? undefined
      : "この端末には入っていません（選ぶと、近い書体で表示されます）",
    value: font.value,
  }));

  const picked = await vscode.window.showQuickPick(
    [...choices, cancelItem()],
    {
      title: `原稿の書体（いま: ${describeCurrentFont(current)}）`,
      placeHolder: "本文に使う書体を選んでください",
      matchOnDescription: true,
    }
  );
  if (!picked || isCancelItem(picked)) return;

  const value = "value" in picked ? picked.value : undefined;
  if (value === undefined || value === current) return;

  // **全体の設定へ書く。** 作品ごとではなく、作者ごとの好みである
  await config.update(
    "manuscriptEditor.fontFamily",
    value,
    vscode.ConfigurationTarget.Global
  );
}

function readAppearance(orientation: ManuscriptOrientation): {
  verticalDefault: boolean;
  /**
   * 向きを決め打つか。
   *
   * **「原稿（横書）」で開いたなら、その原稿が縦を覚えていても横で開く。**
   * 選んで開いたのに前の向きが勝つと、選んだ意味が無い。
   * 開いたあとに切り替えれば、そちらを覚える（これまでどおり）。
   */
  forceVertical?: boolean;
  fontFamily: string;
} {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    verticalDefault:
      orientation === "horizontal"
        ? false
        : config.get<boolean>("manuscriptEditor.vertical", true),
    ...(orientation === "horizontal" ? { forceVertical: false } : {}),
    fontFamily: config.get<string>("manuscriptEditor.fontFamily", "").trim(),
  };
}

/** いまのテーマに合う色を選ぶ */
function colorsFor(): Record<string, string> {
  const dark =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
  const colors: Record<string, string> = {};
  for (const [kind, pair] of Object.entries(TERM_COLORS)) {
    colors[kind] = dark ? pair.dark : pair.light;
  }
  return colors;
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
