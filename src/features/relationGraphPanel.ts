import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { CharacterStore } from "../core/characterStore";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import { revealFolder } from "../views/openDocument";
import { logFailure, logStep } from "../core/logger";
import { buildRelationGraphPanelHtml } from "../views/relationGraphPanelHtml";
import {
  buildRelationGraph,
  countUnresolved,
  egoGraph,
  filterRelationGraph,
  isUnresolvedId,
  restrictUnresolved,
  NO_AFFILIATION_KEY,
  type RelationGraph,
  type RelationGraphFilter,
  type RelationLabelKind,
  type RelationNode,
} from "../core/relationGraph";
import {
  layoutCircle,
  layoutEgo,
  type GraphLayout,
} from "../core/relationGraphLayout";

/**
 * 人物相関図（設計書6.38）。
 *
 * 全体図と個人中心図の2種類を、同じ材料・同じ画面で見せ方だけ切り替える。
 * AIは使わない——材料は人物レコードの関係・呼称・所属である。
 *
 * この画面は何も書き換えない（設計書6.38.5）。押せるのは見せ方の切り替えと、
 * 「設定資料を開く」「SVGを書き出す」だけで、関係の編集は設定資料パネルで行う。
 *
 * 作品ごとに1枚だけ開く。既に開いていれば中心だけ切り替える。
 */

const openPanels = new Map<string, RelationGraphPanel>();

/** 全体図の画布。画面の広さに関わらず同じ座標で描き、SVG側で伸縮させる */
const ALL_CANVAS = { width: 980, height: 980 };
/** 個人中心図の画布。出る人数が少ないので、全体図より小さくてよい */
const EGO_CANVAS = { width: 840, height: 840 };

/** 書き出し先。PDF出力と同じ置き場（`.gitignore` で除外済み） */
const EXPORT_DIR = "exports";

export interface RelationGraphDeps {
  /**
   * 「設定資料を開く」。実体は `extension.ts` が繋ぐ。
   *
   * ここから設定資料パネルを直に読み込むと、設定資料パネル側の
   * 「相関図」ボタン（6.38.3）と互いに読み合う輪ができる。
   */
  openSettingsRecord: (work: WorkEntry, characterId: string) => Promise<void>;
}

export async function openRelationGraph(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  deps: RelationGraphDeps,
  options: { characterId?: string } = {}
): Promise<void> {
  const existing = openPanels.get(work.id);
  if (existing) {
    await existing.revealWith(options.characterId);
    return;
  }
  const panel = new RelationGraphPanel(context, work, deps, options.characterId);
  openPanels.set(work.id, panel);
  await panel.initialize();
}

/**
 * 開いている相関図を、資料から読み直す。
 *
 * 名前の付け替えを資料へ反映すると（設計書6.37.3）、開きっぱなしの図は
 * 旧名のままになる。**開いていなければ何もしない**——見ていない画面のために
 * 資料を読み直す必要はない。
 */
export async function refreshRelationGraph(workId: string): Promise<void> {
  await openPanels.get(workId)?.refresh();
}

/** 画面へ送る絞り込み。画面から返ってくる形でもある */
interface FilterView {
  minChapters: number;
  kinds: RelationLabelKind[];
  affiliations: string[];
  showIsolated: boolean;
}

class RelationGraphPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly store: CharacterStore;

  /** 絞り込む前の図。絞り込みのたびに読み直さないよう控える */
  private base: RelationGraph = { nodes: [], edges: [], unresolved: [] };
  /** 資料の読み込みで落ちたファイル。黙って0件の図を出さないために持つ */
  private loadErrors: Array<{ file: string; message: string }> = [];

  private mode: "all" | "ego" = "all";
  private centerId: string | null = null;
  /** 中心を切り替えた履歴（「戻る」で辿る） */
  private history: string[] = [];
  private showSecondRing = false;

  private minChapters = 0;
  private kinds: RelationLabelKind[] = ["relation", "address"];
  /** 選んでいる所属。null は「全部」（まだ触っていない） */
  private affiliations: string[] | null = null;
  /** 既に画面へ出したことのある所属。あとから増えた分を黙って隠さないため */
  private knownAffiliations = new Set<string>();
  private showIsolated = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly work: WorkEntry,
    private readonly deps: RelationGraphDeps,
    centerId?: string
  ) {
    this.store = new CharacterStore(work);
    if (centerId) {
      this.mode = "ego";
      this.centerId = centerId;
    }

    this.panel = vscode.window.createWebviewPanel(
      "novelai.relationGraph",
      `人物相関図: ${work.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => openPanels.delete(work.id));

    this.panel.webview.html = buildRelationGraphPanelHtml(
      createNonce(),
      this.panel.webview.cspSource
    );
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message as PanelMessage);
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  /** 資料が外で変わったときに読み直す。表示の状態（中心・絞り込み）は保つ */
  async refresh(): Promise<void> {
    await this.load();
  }

  /** 既に開いているパネルを、指定の人物を中心にして出し直す */
  async revealWith(characterId?: string): Promise<void> {
    this.panel.reveal();
    if (characterId) this.setCenter(characterId);
    // 開きっぱなしのパネルは、そのあと増えた資料を知らない。
    // 読み直しの最後に画面へ送るので、ここで送り直さなくてよい
    await this.load();
  }

  private async load(): Promise<void> {
    const loaded = await this.store.loadAll();
    this.loadErrors = loaded.errors;
    this.base = buildRelationGraph(loaded.characters);

    // あとから増えた所属は、選んだことにして出す。黙って隠すと、
    // 抽出したばかりの人物が図に現れない理由が誰にも分からない
    const keys = this.affiliationOptions().map((entry) => entry.key);
    if (this.affiliations !== null) {
      const added = keys.filter((key) => !this.knownAffiliations.has(key));
      if (added.length > 0) this.affiliations = [...this.affiliations, ...added];
    }
    this.knownAffiliations = new Set(keys);

    const max = this.maxChapters();
    if (this.minChapters > max) this.minChapters = max;
    this.post();
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.post();
          return;
        case "filter":
          this.minChapters = Math.max(0, Math.round(message.filter.minChapters));
          this.kinds = message.filter.kinds;
          this.affiliations = message.filter.affiliations;
          this.showIsolated = message.filter.showIsolated;
          this.post();
          return;
        case "center":
          this.setCenter(message.id);
          this.post();
          return;
        case "back": {
          const previous = this.history.pop();
          if (previous === undefined) return;
          this.centerId = previous;
          this.mode = "ego";
          this.post();
          return;
        }
        case "all":
          this.mode = "all";
          this.post();
          return;
        case "toggleSecondRing":
          this.showSecondRing = !this.showSecondRing;
          this.post();
          return;
        case "openRecord":
          await this.openRecord();
          return;
        case "export":
          await this.exportSvg(message.svg);
          return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logFailure("人物相関図", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(`人物相関図でエラーが起きました。${detail}`);
    }
  }

  private setCenter(id: string): void {
    if (this.centerId && this.centerId !== id) this.history.push(this.centerId);
    this.centerId = id;
    this.mode = "ego";
  }

  private async openRecord(): Promise<void> {
    if (!this.centerId || isUnresolvedId(this.centerId)) return;
    await this.deps.openSettingsRecord(this.work, this.centerId);
  }

  /**
   * いま見えている図を書き出す（設計書6.38.4）。
   *
   * 既存ファイルへは書かない（`atomicWrite.ts` の設計では、そもそも置換は
   * 必ず失敗する）。名前がぶつかったら秒・連番で別名にする。
   */
  private async exportSvg(svg: string): Promise<void> {
    const config = await readWorkConfig(this.work);
    const directory = path.join(workPaths(this.work, config).aiwriter, EXPORT_DIR);
    await vscode.workspace.fs.createDirectory(path.toUri(directory));

    const target = await freshExportPath(directory, new Date());
    await atomicWriteFile(target, new TextEncoder().encode(svg), {
      mode: "create",
    });
    logStep(`人物相関図：${target} へ書き出しました`);

    const action = await vscode.window.showInformationMessage(
      `相関図を書き出しました（${path.basename(target)}）。`,
      "フォルダーを開く"
    );
    if (action === "フォルダーを開く") await revealFolder(target);
  }

  /** 所属の選択肢。絞り込む前の図から作る（外した所属も選び直せるように） */
  private affiliationOptions(): Array<{
    key: string;
    label: string;
    count: number;
  }> {
    const counts = new Map<string, number>();
    for (const node of this.base.nodes) {
      if (node.provisional) continue;
      const key = node.affiliation ?? NO_AFFILIATION_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => {
        // 所属なしは最後。図の弧の並びと揃える
        if (left[0] === NO_AFFILIATION_KEY) return 1;
        if (right[0] === NO_AFFILIATION_KEY) return -1;
        return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
      })
      .map(([key, count]) => ({
        key,
        label: key === NO_AFFILIATION_KEY ? "所属なし" : key,
        count,
      }));
  }

  private maxChapters(): number {
    return this.base.nodes.reduce(
      (max, node) => Math.max(max, node.chapterCount),
      0
    );
  }

  private post(): void {
    void this.panel.webview.postMessage({ type: "graph", data: this.build() });
  }

  private build(): GraphView {
    const options = this.affiliationOptions();
    const filter: RelationGraphFilter = {
      minChapters: this.minChapters,
      kinds: this.kinds,
      affiliations: this.affiliations ?? undefined,
      showIsolated: this.showIsolated,
    };
    const filtered = filterRelationGraph(this.base, filter);

    let graph: RelationGraph = filtered.graph;
    let layout: GraphLayout;
    let centerName: string | null = null;
    let canOpenRecord = false;

    if (this.mode === "ego" && this.centerId) {
      const ego = egoGraph(
        filtered.graph,
        this.centerId,
        this.showSecondRing ? 2 : 1
      );
      const visible = new Set(ego.nodes.map((node) => node.id));
      graph = {
        nodes: ego.nodes,
        edges: ego.edges,
        // 絞り込みと同じ絞り方（両端が図に残っているか）を通す。呼んだ側
        // だけで絞ると、点線を出していない相手が一覧に残り、注記の内訳が
        // 全体を超える
        unresolved: restrictUnresolved(filtered.graph, visible),
      };
      layout = layoutEgo(ego, EGO_CANVAS);
      const center = ego.nodes.find((node) => node.id === this.centerId);
      centerName = center ? center.name : null;
      canOpenRecord = Boolean(center && !center.provisional);
    } else {
      layout = layoutCircle(filtered.graph, {
        ...ALL_CANVAS,
        groupBy: "affiliation",
      });
    }

    return {
      mode: this.mode,
      title: this.title(centerName),
      graph,
      layout,
      centerId: this.mode === "ego" ? this.centerId : null,
      centerName,
      canGoBack: this.history.length > 0,
      canOpenRecord,
      showSecondRing: this.showSecondRing,
      filter: {
        minChapters: this.minChapters,
        kinds: this.kinds,
        affiliations: this.affiliations ?? options.map((entry) => entry.key),
        showIsolated: this.showIsolated,
      },
      affiliations: options,
      maxChapters: this.maxChapters(),
      hiddenIsolated: {
        count: filtered.hiddenIsolated.length,
        names: filtered.hiddenIsolated.map((node: RelationNode) => node.name),
      },
      // 全体と内訳は必ず同じ集合から数える（`countUnresolved`）。
      // ここで別々に数えると、全体図と個人中心図で絞り込みの効き方が違い、
      // 内訳が全体を超えた注記が出る
      ...countUnresolved(graph),
      emptyMessage: this.emptyMessage(),
      warning: this.warning(),
    };
  }

  private title(centerName: string | null): string {
    if (this.mode === "ego" && centerName) {
      return `${centerName} の相関図（${this.work.title}）`;
    }
    if (this.mode === "ego" && this.centerId) {
      return `この図に居ない人物です（${this.work.title}）`;
    }
    return `${this.work.title} の人物相関図`;
  }

  /**
   * 何も出ないときの案内。
   *
   * 材料が無いのか、絞り込みで消えたのかで、次にすることが違う。
   * 同じ文言にすると、条件を戻せばよいだけの人に抽出をやり直させる。
   */
  private emptyMessage(): string {
    if (this.base.nodes.length === 0) {
      return (
        "まだ関係が抽出されていません。" +
        "資料管理 → 資料抽出 → まとめて抽出 を実行してください。"
      );
    }
    if (this.base.edges.length === 0) {
      return (
        "人物は見つかりましたが、関係も呼称も資料にありません。" +
        "資料管理 → 資料抽出 → まとめて抽出 を実行するか、" +
        "設定資料パネルで関係を書き足してください。"
      );
    }
    if (this.mode === "ego" && this.centerId) {
      return (
        "この人物は、いまの絞り込みでは図に居ません。" +
        "登場話数の下限を下げるか、所属の選び直しをしてください。"
      );
    }
    return "絞り込みに合う人物が居ません。条件をゆるめてください。";
  }

  /** 資料の読み込みで落ちたファイルがあれば、そのことを画面の隅に出す */
  private warning(): string {
    if (this.loadErrors.length === 0) return "";
    return (
      `読み込めなかった資料が${this.loadErrors.length}件あります` +
      `（${this.loadErrors.map((entry) => entry.file).join("、")}）。` +
      "その人物は図に出ていません。"
    );
  }
}

interface GraphView {
  mode: "all" | "ego";
  title: string;
  graph: RelationGraph;
  layout: GraphLayout;
  centerId: string | null;
  centerName: string | null;
  canGoBack: boolean;
  canOpenRecord: boolean;
  showSecondRing: boolean;
  filter: FilterView;
  affiliations: Array<{ key: string; label: string; count: number }>;
  maxChapters: number;
  hiddenIsolated: { count: number; names: string[] };
  unresolvedCount: number;
  ambiguousCount: number;
  emptyMessage: string;
  warning: string;
}

type PanelMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterView }
  | { type: "center"; id: string }
  | { type: "back" }
  | { type: "all" }
  | { type: "toggleSecondRing" }
  | { type: "openRecord" }
  | { type: "export"; svg: string };

/**
 * まだ使われていない書き出し先を決める。
 *
 * 名前の作り方は `timestampedFileName.ts`（相談メモ・印刷用と同じ規則）。
 * 区切りは `_`——書き出したファイルを種類ごとに拾えるようにするため。
 */
async function freshExportPath(directory: string, at: Date): Promise<string> {
  for (const name of timestampedFileNameCandidates(
    "相関図",
    at,
    ".svg",
    undefined,
    "_"
  )) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
