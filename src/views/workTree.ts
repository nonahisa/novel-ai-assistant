import * as vscode from "vscode";
import { toUri } from "../core/paths";
import { EpisodeFile, WorkEntry, WorkStats } from "../models/types";
import { emptyCounts, formatCount, toManuscriptPages } from "../core/charCount";
import {
  episodeListLabel,
  episodeTitle,
  formatChapterLabel,
  isCollectedFile,
} from "../core/episodeLabel";
import { workTypeContextValue } from "../core/workTypeVisibility";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { scanWork } from "../core/scanner";
import type { Chapter } from "../models/chapter";
import { ChapterStore } from "../core/chapterStore";
import {
  chapterNodeId,
  formatChapterRange,
  groupEpisodesByChapter,
} from "../core/chapterGrouping";
import { manuscriptViewTypeFor } from "../core/manuscriptViewTypes";
import { listWorkMemos, type WorkMemo } from "../core/workMemos";
import { PostingStore } from "../core/postingStore";
import {
  emptyPostingLedger,
  postingSiteLabels,
  unpostedSites,
  type PostingLedger,
} from "../models/posting";
import { episodePathFor } from "../core/bookStore";
import { SynopsisStore } from "../core/synopsisStore";
import { synopsisKey } from "../models/synopsis";
import { WorkRegistry } from "../core/workRegistry";
import {
  currentCountMode,
  pickCount,
  countModeLabel,
} from "../core/countSettings";

export type TreeNode =
  | WorkNode
  | ChapterNode
  | EpisodeNode
  | MemoFolderNode
  | MemoFileNode
  | MessageNode;

export class WorkNode {
  readonly type = "work" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly stats: WorkStats,
    /**
     * 走査に失敗した理由。成功なら `undefined`。
     *
     * **登録されている以上、読めなくても一覧には出す。** 隠すと
     * 「登録したのに出てこない」という、原因の分からない終わり方になる。
     */
    public readonly loadError?: string,
    /**
     * 作品のタイプ（設計書6.70）。右クリックを絞る印
     * （`contextValue`）に織り込む。
     *
     * **描画（`getTreeItem`）は同期なので、ここで持たせておく**
     * （話・章のノードと同じ理由）。
     */
    public readonly format?: WorkFormatKey
  ) {}
}

/**
 * 章の折りたたみ（設計書6.66.3）。
 *
 * 章のある作品では、作品と話のあいだにこれが入る。**章の無い作品では
 * 作らない**——いままでどおり作品の直下に話が並ぶ。
 */
export class ChapterNode {
  readonly type = "chapter" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly chapter: Chapter,
    /** この章に入る話。開始の話が見つからない章では空 */
    public readonly episodes: EpisodeFile[],
    /** 開始の話が作品の中に見つからない（改題・削除が典型） */
    public readonly missingStart: boolean,
    /** 作品の形式。話数の言い方が変わる（EpisodeNode と同じ理由で持たせる） */
    public readonly format?: WorkFormatKey
  ) {}
}

export class EpisodeNode {
  readonly type = "episode" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly episode: EpisodeFile,
    /**
     * 作品の形式。SNS記事では「第3話」ではなく「投稿3」と出す。
     *
     * **描画（`getTreeItem`）は同期なので、ここで持たせておく。**
     * 描画のたびにプロットを読むと、1回の描画でファイルを何十回も読む
     */
    public readonly format?: WorkFormatKey
  ) {}
}

/**
 * 作品ごとのメモの折りたたみ（設計書6.71）。
 *
 * **メモが1つも無い作品では作らない。** 使わない作者の一覧に空の枝を
 * 並べないためで、章の枝（6.66.3）と同じ考え方である。話の並びの
 * **後ろ**に置く——メモは原稿ではないので、原稿より前に来てはいけない。
 */
export class MemoFolderNode {
  readonly type = "memoFolder" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly memos: WorkMemo[],
    /** 作品の形式。右クリックの絞り込みに要る（ほかのノードと同じ理由） */
    public readonly format?: WorkFormatKey
  ) {}
}

/** メモ1つ。クリックで開き、右クリックから削除できる */
export class MemoFileNode {
  readonly type = "memoFile" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly memo: WorkMemo,
    public readonly format?: WorkFormatKey
  ) {}
}

export class MessageNode {
  readonly type = "message" as const;
  constructor(public readonly text: string) {}
}

export class WorkTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** 走査結果のキャッシュ（作品ID -> 結果） */
  private cache = new Map<
    string,
    { episodes: EpisodeFile[]; stats: WorkStats }
  >();

  /**
   * 各話あらすじ（作品ID -> 話ごとの本文）。
   *
   * ホバーに出すために持つ。**あらすじはJSONにしか無く、
   * 読む場所が無かった。** 一覧の各話にカーソルを置いたときが、
   * いちばん自然に読める場所である。
   */
  private synopses = new Map<string, Map<string, string>>();

  /**
   * 章の台帳（作品ID -> 章の一覧、設計書6.66.3）。
   *
   * あらすじと同じく、**作品を開くたびに1回だけ読む**。章ノードは
   * 折りたたみのたびに描き直されるので、そこで読むとJSONを何度も開く。
   */
  private chapters = new Map<string, Chapter[]>();

  /**
   * 投稿状態（作品ID -> 台帳、設計書6.68.2）。
   *
   * あらすじ・章と同じく**作品を開くたびに1回だけ読む**。話の行は
   * 描き直しのたびに `getTreeItem` を通るので、そこで読むとJSONを
   * 何度も開くことになる。
   *
   * **読めなくても一覧は出す**（読めなければ印が出ないだけ）。
   */
  private posting = new Map<string, PostingLedger>();

  /**
   * 作品ごとのメモ（作品ID -> メモの一覧、設計書6.71）。
   *
   * 章・投稿と同じく**作品を開くたびに1回だけ読む**。フォルダの中を
   * 数えるだけとはいえ、描き直しのたびに読むとファイルを何度も開く。
   */
  private memos = new Map<string, WorkMemo[]>();

  /**
   * @param syncBadge GitHub同期に残っているものを短く表す文字列を返す。
   *   ツリーがGit連携そのものに依存しないよう、関数で受け取る。
   * @param syncTooltip その内訳（ホバーで読む）。
   *   **印は短くしか書けない。** 「記録待ち」と「送信待ち」が何を指すのかは
   *   言葉だけでは伝わりきらないので、ここで補う
   */
  constructor(
    private readonly registry: WorkRegistry,
    private readonly syncBadge?: (workId: string) => string | undefined,
    private readonly syncTooltip?: (workId: string) => string[]
  ) {
    registry.onDidChange(() => this.refresh());
  }

  refresh(workId?: string): void {
    if (workId) {
      this.cache.delete(workId);
      this.synopses.delete(workId);
      this.chapters.delete(workId);
      this.posting.delete(workId);
      this.memos.delete(workId);
    } else {
      this.cache.clear();
      this.synopses.clear();
      this.chapters.clear();
      this.posting.clear();
      this.memos.clear();
    }
    this._onDidChangeTreeData.fire();
  }

  /**
   * 走査結果はそのままに、表示だけ作り直す。
   *
   * 同期状態の表示のようにファイルの中身と無関係な変化で
   * `refresh()` を呼ぶと、作品ごとの全ファイル再走査が走ってしまう。
   */
  redraw(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === "message") {
      const item = new vscode.TreeItem(node.text);
      item.contextValue = "message";
      return item;
    }

    // **ステータスバーと同じ数え方にする。** 以前はここだけ純文字数で
    // 固定しており、総文字数を選んでいる作者には右下と一覧で違う数字が
    // 出続けていた（2026-08-21、作者の指摘）
    const mode = currentCountMode();
    const modeLabel = countModeLabel(mode);

    if (node.type === "work") {
      const { work, stats } = node;
      const item = new vscode.TreeItem(
        work.title,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      // タイプを織り込む（設計書6.70.1）。右クリックの `when` はこれを見る
      item.contextValue = workTypeContextValue("work", node.format);
      item.iconPath = new vscode.ThemeIcon("book");

      // 走査に失敗した作品は、字数の代わりに理由を出す。
      // 0字と表示すると「書いていない」と読めてしまう
      if (node.loadError) {
        item.iconPath = new vscode.ThemeIcon("warning");
        item.description = "⚠ 読み込めません";
        item.tooltip = new vscode.MarkdownString(
          [
            `**${work.title}**`,
            "",
            "フォルダーの中を読めませんでした。",
            "",
            `- 理由: ${node.loadError}`,
            "",
            `\`${work.folderPath}\``,
          ].join("\n")
        );
        return item;
      }
      // 未解決の競合は最優先で気づかせる。放置するとAI処理で原稿が壊れる
      const conflictNote =
        stats.conflictedCount > 0
          ? ` / ⚠競合 ${stats.conflictedCount}件`
          : "";
      // GitHubとの差は「記録待ち2・送信待ち6」の形で短く添える（設計書5.5.17）。
      // 別の環境へ移る前に気づけるかどうかが分かれ目になる（設計書5.5.1）。
      // **数はその作品のぶんだけ**——書庫では置き場ぜんぶの数が全部の行に並ぶ
      const badge = this.syncBadge?.(work.id);
      const syncNote = badge ? ` / ${badge}` : "";
      item.description = `${stats.fileCount}ファイル / ${modeLabel}${formatCount(
        pickCount(stats.totals, mode)
      )}字${conflictNote}${syncNote}`;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${work.title}**`,
          "",
          `- 純文字数: ${formatCount(stats.totals.net)} 字`,
          `- 総文字数: ${formatCount(stats.totals.gross)} 字`,
          `- 原稿用紙換算: 約 ${formatCount(
            toManuscriptPages(stats.totals.manuscriptLines)
          )} 枚`,
          `- ファイル数: ${stats.fileCount}`,
          ...(this.syncTooltip?.(work.id) ?? []),
          stats.conflictedCount > 0
            ? `\n**未解決の競合が ${stats.conflictedCount} 件あります。**\n` +
              "これらは文字数に含めていません。解決してから執筆・AI処理を行ってください。"
            : null,
          "",
          `\`${work.folderPath}\``,
        ]
          .filter((line) => line !== null)
          .join("\n")
      );
      return item;
    }

    if (node.type === "chapter") {
      // 開始の話が見つからない章も、黙って消さずに出す（設計書6.66.1）。
      // 名前のうしろに理由を書き、作者が直せるようにする
      const label = node.missingStart
        ? `${node.chapter.name}（開始の話が見つかりません）`
        : node.chapter.name;
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = workTypeContextValue("chapter", node.format);
      // **IDに名前を入れない。** 折りたたみの開閉はVS CodeがIDで
      // 覚えるので、名前から作ると改名のたびに開き直しになる（6.66.3）
      item.id = chapterNodeId(node.work.id, node.chapter.startEpisodePath);
      item.iconPath = new vscode.ThemeIcon(
        node.missingStart ? "warning" : "folder"
      );
      item.description = node.missingStart
        ? node.chapter.startEpisodePath
        : formatChapterRange(node.episodes, node.format);
      item.tooltip = new vscode.MarkdownString(
        [
          `**${node.chapter.name}**`,
          "",
          `- 開始の話: ${node.chapter.startEpisodePath}`,
          node.missingStart
            ? "\n開始の話が見つかりません。話の名前が変わったか、削除されています。" +
              "\n章を外すか、いまの話から章を始め直してください（話は消えません）。"
            : `- ${formatChapterRange(node.episodes, node.format)}`,
        ].join("\n")
      );
      return item;
    }

    if (node.type === "memoFolder") {
      // 件数は名前の中に出す。**行の右側（description）は空けておく**
      // ——話の行では文字数が出る場所で、そこに件数が並ぶと数字を読み違える
      const item = new vscode.TreeItem(
        `メモ（${node.memos.length}件）`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = workTypeContextValue("memoFolder", node.format);
      // 開閉はVS CodeがIDで覚える。作品ごとに1つしか無いので作品IDで足りる
      item.id = `${node.work.id}:memo`;
      item.iconPath = new vscode.ThemeIcon("note");
      item.tooltip = new vscode.MarkdownString(
        [
          "**メモ**",
          "",
          "この作品のためのメモです。",
          "話数・文字数・あらすじ・投稿・校正のどれにも入りません。",
          "",
          "右クリックの「メモを追加」から増やせます。",
        ].join("\n")
      );
      return item;
    }

    if (node.type === "memoFile") {
      const item = new vscode.TreeItem(
        node.memo.title,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = workTypeContextValue("memoFile", node.format);
      item.resourceUri = toUri(node.memo.filePath);
      item.iconPath = new vscode.ThemeIcon("note");
      /*
        **原稿エディタでは開かない**（設計書6.71）。

        話の行は原稿エディタ（6.25）へ渡しているが、メモは原稿ではない。
        用語の色分けもルビも要らない書き散らしの場なので、
        いつものMarkdownの画面で開く。
      */
      item.command = {
        command: "vscode.open",
        title: "メモを開く",
        arguments: [toUri(node.memo.filePath)],
      };
      item.tooltip = new vscode.MarkdownString(
        [`**${node.memo.title}**`, "", `\`${node.memo.filePath}\``].join("\n")
      );
      return item;
    }

    // episode
    const ep = node.episode;
    const item = new vscode.TreeItem(
      ep.fileName,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = workTypeContextValue("episode", node.format);
    item.resourceUri = toUri(ep.filePath);
    /*
      **本文は原稿エディタ（横書き）で開く**（作者の指示、2026-08-29）。

      これまでは `vscode.open` で素のエディタへ渡していたが、VS Code 1.131 の
      Markdown編集画面では用語の色分けもルビも右クリックの設定資料も効かない
      （設計書6.25）。書くための画面を持っているのに、一覧から開くと
      そちらへ行かないのでは、作者は毎回「エディターを再度開く」を通ることになる。

      **縦書きではなく横書きを既定にする。** 縦書きは画面の中のボタンと
      「エディターを再度開く」から選べる。ここで決め打つのは話（本文）だけで、
      プロット・あらすじ・設定資料は素のエディタのままである（この行は
      episode の枝にしかない）。

      **例外は脚本**（設計書6.70）。台本は縦書きで組むのが普通なので、
      向きの既定を `manuscriptViewTypeFor` に決めさせる（開く場所ごとに
      違う既定を持たない）。
    */
    item.command = {
      command: "vscode.openWith",
      title: "開く",
      arguments: [toUri(ep.filePath), manuscriptViewTypeFor(node.format)],
    };

    const chapterLabel = formatChapterLabel(ep, node.format);
    const title = episodeTitle(ep, chapterLabel);
    // まだ出していないサイト（設計書6.68.2）。対象サイトを1つも登録して
    // いない作品では空になる＝印も出ない
    const unposted = this.unpostedSitesFor(node.work, ep);

    // 話数を先頭に出す。タイトルが長くても話数と文字数が隠れないようにするため。
    // label（太字側）は短く保ち、可変長のタイトルは description に置く。
    //
    // **創作メモ集では、番号の無いファイルは題名がそのまま見出しになる**
    // （設計書6.70）。メモに番号は要らない
    item.label = episodeListLabel(ep, chapterLabel, node.format);
    // タイトルの無い話でファイル名を出さないのは、行ごとに形が変わって
    // 一覧が読みにくくなるためである。話数はlabelに出ており、
    // ファイル名はホバーで確かめられる
    item.description = [
      title,
      // 合本は1ファイルに全話が入っている。何話ぶんかが分からないと、
      // 巨大な1話に見えてしまう。
      //
      // **2話以上のときだけ出す。** 投稿サイトのダウンロードには、
      // 1話ずつ別ファイルなのに区切り行（「エピソードN開始」）が
      // 入っている形がある。そこに「1話ぶん」と出しても何も伝わらず、
      // **同じ一覧の中で行の形だけが変わって読みにくい**
      // （2026-08-21、作者が実機で気づいた）
      isCollectedFile(ep.collectedCount) ? `${ep.collectedCount}話ぶん` : null,
      `${modeLabel}${formatCount(pickCount(ep.counts, mode))}字`,
      // **残っているシーンメモ**（設計書6.40.5）。0件なら出さない
      // ——無いものの印で行の形が変わると、一覧が読みにくくなる
      ep.memoBadge ? ep.memoBadge : null,
      // **未投稿のサイト数**（設計書6.68.2）。0件なら出さない。
      // どのサイトが遅れているかはホバーで読む（印は短くしか書けない）
      unposted.length > 0 ? `未投稿${unposted.length}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join("　");

    if (ep.hasConflictMarkers) {
      // 競合を含むファイルは、話数や文字数より先にそれを伝える
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground")
      );
      item.description = "⚠ 未解決の競合（文字数は未集計）";
    } else if (ep.isInitialName && !ep.metaTitle) {
      item.iconPath = new vscode.ThemeIcon("circle-outline");
    } else if (ep.kind === "不明" && node.format !== "memo") {
      // **創作メモ集では「？」を出さない**（設計書6.70）。番号を持たない
      // ファイルが普通なので、印を付けると全部のメモが不備に見える
      item.iconPath = new vscode.ThemeIcon("question");
    } else {
      item.iconPath = new vscode.ThemeIcon("file-text");
    }

    // サイト記載の文字数と計測値がずれていれば警告を出す
    let mismatchNote: string | null = null;
    if (ep.declaredCharCount !== null) {
      const diffNet = ep.counts.net - ep.declaredCharCount;
      const diffGross = ep.counts.gross - ep.declaredCharCount;
      const closest = Math.abs(diffNet) <= Math.abs(diffGross) ? "純" : "総";
      const diff = Math.abs(diffNet) <= Math.abs(diffGross) ? diffNet : diffGross;
      if (diff !== 0) {
        mismatchNote = `記載 ${formatCount(
          ep.declaredCharCount
        )}字 との差: ${diff > 0 ? "+" : ""}${formatCount(diff)}（${closest}文字数比）`;
      } else {
        mismatchNote = `記載 ${formatCount(
          ep.declaredCharCount
        )}字 と一致（${closest}文字数）`;
      }
    }

    // あらすじはJSONにしか無く、読む場所が無かった。
    // その話にカーソルを置いたときが、いちばん自然に読める場所である
    const synopsis = this.synopsisFor(node.work, ep);

    item.tooltip = new vscode.MarkdownString(
      [
        `**${
          ep.metaTitle ??
          ([chapterLabel, title].filter((part) => part).join("　") ||
            ep.fileName)
        }**`,
        "",
        synopsis ? `${synopsis}\n` : null,
        // 一覧からファイル名を外したので、ホバーでは必ず出す
        `- ファイル: ${ep.fileName}`,
        `- 種別: ${ep.kind}`,
        // **創作メモ集で「判定不能」と書かない**（設計書6.70）。
        // 番号を振らないのが普通で、直すべき不備ではない
        chapterLabel
          ? `- 話数: ${chapterLabel}`
          : node.format === "memo"
            ? null
            : "- 話数: 判定不能",
        isCollectedFile(ep.collectedCount)
          ? `- 全話が1ファイルに入っています（${ep.collectedCount}話ぶん）。話ごとに分けて扱います`
          : null,
        `- 純文字数: ${formatCount(ep.counts.net)} 字`,
        `- 総文字数: ${formatCount(ep.counts.gross)} 字`,
        `- 段落数: ${ep.counts.paragraphs}`,
        // **どのサイトが遅れているかを、ここで読めるようにする**（6.68.2）
        unposted.length > 0
          ? `- まだ出していないサイト: ${postingSiteLabels(unposted)}`
          : null,
        ep.hasMetadata ? "- 投稿サイト形式のヘッダーを検出（本文のみ計測）" : null,
        mismatchNote ? `- ${mismatchNote}` : null,
        ep.metaUpdatedAt ? `- 更新日時: ${ep.metaUpdatedAt}` : null,
        ep.isInitialName && !ep.metaTitle
          ? "\n_ファイル名が初期状態です（サブタイトル未設定）_"
          : null,
      ]
        .filter((l) => l !== null)
        .join("\n")
    );

    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const works = this.registry.list();
      const nodes: TreeNode[] = [];
      for (const w of works) {
        // **1件の失敗で一覧全体を消さない。**
        //
        // 以前はここで `await` した走査が1つでも失敗すると、`getChildren`
        // ごと失敗し、**登録済みの作品が1件も出ない**（VS Codeは空の
        // ツリーと見なして「まだ作品が登録されていません」を出す）。
        // 登録は済んでいるのに何も出ない、という原因の分からない
        // 見え方になっていた（2026-08-22、作者のブラウザ版で発生）
        try {
          const result = await this.load(w);
          // タイプは右クリックの絞り込みに要る（設計書6.70.1）。
          // 読み取り自体は `workFormatStore` が作品ごとに覚えているので、
          // 一覧を描き直すたびにプロットを読み直すことにはならない
          nodes.push(
            new WorkNode(w, result.stats, undefined, await this.formatOf(w))
          );
        } catch (error) {
          nodes.push(
            new WorkNode(
              w,
              { fileCount: 0, totals: emptyCounts(), conflictedCount: 0 },
              error instanceof Error ? error.message : String(error)
            )
          );
        }
      }
      return nodes;
    }

    if (node.type === "work") {
      // 走査に失敗していれば、開いたときに理由を出す。
      // 「本文ファイルがありません」と出すと、原因を取り違える
      if (node.loadError) {
        return [new MessageNode(`⚠ 読み込めません: ${node.loadError}`)];
      }
      let result;
      try {
        result = await this.load(node.work);
      } catch (error) {
        return [
          new MessageNode(
            `⚠ 読み込めません: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
        ];
      }
      const format = await this.formatOf(node.work);
      // メモの枝は話の後ろに置く（設計書6.71）。**原稿より前に来ない**
      const memos = await this.memoNodes(node.work, format);

      if (result.episodes.length === 0) {
        // 本文はまだ無くても、メモだけ書き始めている作品はある
        return [
          new MessageNode("本文ファイルがありません（txt / md）"),
          ...memos,
        ];
      }
      await this.loadSynopses(node.work);
      await this.loadPosting(node.work);

      /*
        章の台帳を読む（設計書6.66.3）。

        **読めなくても話は出す。** 章はまとめ方であって、話そのものでは
        ない。台帳が壊れているからといって作品が空に見えるのでは、
        作者は何が起きたのか分からない。理由を1行足したうえで、
        いままでどおりの並び（章なし）を出す。
      */
      let chapters: Chapter[];
      try {
        chapters = await this.loadChapters(node.work);
      } catch (error) {
        return [
          new MessageNode(
            `⚠ 章立てを読めません: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
          ...result.episodes.map((e) => new EpisodeNode(node.work, e, format)),
          ...memos,
        ];
      }

      // 章が1つも無ければ、いままでどおり作品の直下に話を並べる
      if (chapters.length === 0) {
        return [
          ...result.episodes.map((e) => new EpisodeNode(node.work, e, format)),
          ...memos,
        ];
      }

      const grouped = groupEpisodesByChapter(
        result.episodes,
        chapters,
        node.work.folderPath
      );
      return [
        // 最初の章より前の話は、章ノードより前に並べる（6.66.1）
        ...grouped.ungrouped.map((e) => new EpisodeNode(node.work, e, format)),
        ...grouped.groups.map(
          (group) =>
            new ChapterNode(
              node.work,
              group.chapter,
              group.episodes,
              group.missingStart,
              format
            )
        ),
        ...memos,
      ];
    }

    if (node.type === "chapter") {
      return node.episodes.map(
        (e) => new EpisodeNode(node.work, e, node.format)
      );
    }

    if (node.type === "memoFolder") {
      return node.memos.map(
        (memo) => new MemoFileNode(node.work, memo, node.format)
      );
    }

    return [];
  }

  /**
   * メモの枝（0件なら空）。
   *
   * **読めなくても一覧は出す。** メモは原稿ではないので、置き場を読めない
   * ことで作品が空に見えてはいけない（枝が出ないだけで済ませる）。
   */
  private async memoNodes(
    work: WorkEntry,
    format?: WorkFormatKey
  ): Promise<MemoFolderNode[]> {
    let memos = this.memos.get(work.id);
    if (!memos) {
      try {
        memos = await listWorkMemos(work);
      } catch {
        memos = [];
      }
      this.memos.set(work.id, memos);
    }
    return memos.length > 0 ? [new MemoFolderNode(work, memos, format)] : [];
  }

  /**
   * 作品のタイプ（設計書6.70）。**読めなくても一覧は出す。**
   *
   * プロットが壊れている・まだ無い作品では「決めていない」扱いになり、
   * いままでどおり全部の操作が右クリックに出る（隠しすぎない）。
   */
  private async formatOf(work: WorkEntry): Promise<WorkFormatKey | undefined> {
    try {
      return await readWorkFormat(work);
    } catch {
      return undefined;
    }
  }

  /**
   * 章の台帳を読み込む（作品ごとに1回）。
   *
   * **描画のたびに読まない。** 章ノードは話の数だけ描き直されるので、
   * そのたびにJSONを読むと1回の描画で何度もファイルを開くことになる
   * （あらすじ・作品の形式と同じ扱い）。
   */
  private async loadChapters(work: WorkEntry): Promise<Chapter[]> {
    const cached = this.chapters.get(work.id);
    if (cached) return cached;
    // **失敗は覚えない。** 作者がJSONを直したら、開き直すだけで
    // 読めるようになってほしい（あらすじと違い、章は一覧の形を変える）
    const set = await new ChapterStore(work).load();
    this.chapters.set(work.id, set.chapters);
    return set.chapters;
  }

  /**
   * 投稿状態を読み込む（作品ごとに1回）。**読めなくても一覧は出す。**
   *
   * 章と違って一覧の形を変えるものではなく、行に印を足すだけなので、
   * 台帳が壊れていることは印が出ないことで足りる（理由はキットを
   * 実行したときに出る）。
   */
  private async loadPosting(work: WorkEntry): Promise<void> {
    if (this.posting.has(work.id)) return;
    let ledger = emptyPostingLedger();
    try {
      ledger = await new PostingStore(work).load();
    } catch {
      // 読めない台帳は「サイト未登録」と同じ扱い。印が出ないだけ
    }
    this.posting.set(work.id, ledger);
  }

  /**
   * その話で、まだ出していないサイト。
   *
   * **対象サイトを1つも登録していない作品では常に空**（＝印を出さない）。
   * 投稿キットを使わない作者の一覧に「未投稿」が全話ぶん並ばないようにする。
   */
  private unpostedSitesFor(work: WorkEntry, episode: EpisodeFile) {
    const ledger = this.posting.get(work.id);
    if (!ledger || ledger.sites.length === 0) return [];
    return unpostedSites(
      ledger,
      episodePathFor(work.folderPath, episode.filePath)
    );
  }

  /**
   * あらすじを読み込む。読めなくても一覧は出す。
   *
   * ホバーに添えるだけの情報なので、失敗しても作品一覧を止めない。
   */
  private async loadSynopses(work: WorkEntry): Promise<void> {
    if (this.synopses.has(work.id)) return;
    const byKey = new Map<string, string>();
    try {
      const set = await new SynopsisStore(work).load();
      for (const episode of set.episodes) {
        byKey.set(
          synopsisKey(episode.fileName, episode.chapter),
          episode.synopsis
        );
      }
    } catch {
      // 壊れていても一覧は出す。理由は生成時に知らせている
    }
    this.synopses.set(work.id, byKey);
  }

  /** その話のあらすじ。無ければ undefined */
  private synopsisFor(work: WorkEntry, episode: EpisodeFile): string | undefined {
    const byKey = this.synopses.get(work.id);
    if (!byKey) return undefined;
    // 合本は1ファイルに複数話が入るので、話数だけでは引けない
    return byKey.get(synopsisKey(episode.fileName, episode.chapterStart));
  }

  private async load(work: WorkEntry) {
    const cached = this.cache.get(work.id);
    if (cached) return cached;
    const result = await scanWork(work);
    const value = { episodes: result.episodes, stats: result.stats };
    this.cache.set(work.id, value);
    return value;
  }

  /** 走査済みの話数情報を返す（コマンド側から利用） */
  async getEpisodes(work: WorkEntry): Promise<EpisodeFile[]> {
    return (await this.load(work)).episodes;
  }

  /**
   * 走査済みの集計を返す（コマンド側から利用）。
   *
   * 執筆量の記録は保存のたびに作品全体の字数を測る。ここを通せば
   * ツリーの描き直しと走査結果を共有でき、1回の保存で2度走査しない。
   */
  async getStats(work: WorkEntry): Promise<WorkStats> {
    return (await this.load(work)).stats;
  }
}

// 話数の見出しとタイトルの作り方は core/episodeLabel.ts に置いた。
// 話ごとの文字数一覧でも同じ見出しを使うため、2か所に書かない
