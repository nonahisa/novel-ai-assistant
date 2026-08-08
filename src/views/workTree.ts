import * as vscode from "vscode";
import { EpisodeFile, WorkEntry, WorkStats } from "../models/types";
import { formatCount, toManuscriptPages } from "../core/charCount";
import { scanWork } from "../core/scanner";
import { WorkRegistry } from "../core/workRegistry";

export type TreeNode = WorkNode | EpisodeNode | MessageNode;

export class WorkNode {
  readonly type = "work" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly stats: WorkStats
  ) {}
}

export class EpisodeNode {
  readonly type = "episode" as const;
  constructor(
    public readonly work: WorkEntry,
    public readonly episode: EpisodeFile
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

  constructor(private readonly registry: WorkRegistry) {
    registry.onDidChange(() => this.refresh());
  }

  refresh(workId?: string): void {
    if (workId) {
      this.cache.delete(workId);
    } else {
      this.cache.clear();
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === "message") {
      const item = new vscode.TreeItem(node.text);
      item.contextValue = "message";
      return item;
    }

    if (node.type === "work") {
      const { work, stats } = node;
      const item = new vscode.TreeItem(
        work.title,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = "work";
      item.iconPath = new vscode.ThemeIcon("book");
      // 未解決の競合は最優先で気づかせる。放置するとAI処理で原稿が壊れる
      const conflictNote =
        stats.conflictedCount > 0
          ? ` / ⚠競合 ${stats.conflictedCount}件`
          : "";
      item.description = `${stats.fileCount}ファイル / ${formatCount(
        stats.totals.net
      )}字${conflictNote}`;
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

    // episode
    const ep = node.episode;
    const item = new vscode.TreeItem(
      ep.fileName,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = "episode";
    item.resourceUri = vscode.Uri.file(ep.filePath);
    item.command = {
      command: "vscode.open",
      title: "開く",
      arguments: [vscode.Uri.file(ep.filePath)],
    };

    const chapterLabel = formatChapterLabel(ep);

    // 話数を先頭に出す。タイトルが長くても話数と文字数が隠れないようにするため。
    // label（太字側）は短く保ち、可変長のタイトルは description に置く。
    if (ep.metaTitle || ep.subtitle) {
      item.label = chapterLabel || ep.fileName;
      item.description = `${ep.metaTitle ?? ep.subtitle}　${formatCount(
        ep.counts.net
      )}字`;
    } else {
      item.label = chapterLabel || ep.fileName;
      item.description = chapterLabel
        ? `${ep.fileName}　${formatCount(ep.counts.net)}字`
        : `${formatCount(ep.counts.net)}字`;
    }

    if (ep.hasConflictMarkers) {
      // 競合を含むファイルは、話数や文字数より先にそれを伝える
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground")
      );
      item.description = "⚠ 未解決の競合（文字数は未集計）";
    } else if (ep.isInitialName && !ep.metaTitle) {
      item.iconPath = new vscode.ThemeIcon("circle-outline");
    } else if (ep.kind === "不明") {
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

    item.tooltip = new vscode.MarkdownString(
      [
        `**${ep.metaTitle ?? ep.fileName}**`,
        "",
        ep.metaTitle ? `- ファイル: ${ep.fileName}` : null,
        `- 種別: ${ep.kind}`,
        `- 話数: ${chapterLabel || "判定不能"}`,
        `- 純文字数: ${formatCount(ep.counts.net)} 字`,
        `- 総文字数: ${formatCount(ep.counts.gross)} 字`,
        `- 段落数: ${ep.counts.paragraphs}`,
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
        const result = await this.load(w);
        nodes.push(new WorkNode(w, result.stats));
      }
      return nodes;
    }

    if (node.type === "work") {
      const result = await this.load(node.work);
      if (result.episodes.length === 0) {
        return [
          new MessageNode("本文ファイルがありません（txt / md）"),
        ];
      }
      return result.episodes.map((e) => new EpisodeNode(node.work, e));
    }

    return [];
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
}

function formatChapterLabel(ep: EpisodeFile): string {
  if (ep.kind !== "本編" && ep.kind !== "不明") {
    // プロローグ・幕間などは種別を見出しにする
    return ep.chapterStart !== null
      ? `${ep.kind}${ep.chapterStart}`
      : ep.kind;
  }
  if (ep.chapterStart === null) return "";
  if (ep.chapterEnd !== null && ep.chapterEnd !== ep.chapterStart) {
    return `第${ep.chapterStart}〜${ep.chapterEnd}話`;
  }
  return `第${ep.chapterStart}話`;
}
