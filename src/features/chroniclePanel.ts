import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import type { Foreshadow } from "../models/foreshadow";
import type { ChapterSynopsisSet } from "../models/synopsis";
import type { Timeline } from "../models/timeline";
import { CharacterStore } from "../core/characterStore";
import { createForeshadowStore } from "../core/foreshadowStore";
import { SynopsisStore } from "../core/synopsisStore";
import { TimelineStore } from "../core/timelineStore";
import { scanWork } from "../core/scanner";
import { readWorkFormat } from "../core/workFormatStore";
import { logFailure } from "../core/logger";
import {
  buildChronicle,
  chronicleCharacters,
  CHRONICLE_EVENT_KINDS,
  CHRONICLE_EVENT_LABELS,
  filterChronicle,
  groupByTimepoint,
  sortByTimeline,
  timepointLabel,
  type ChronicleEventKind,
  type ChronicleRow,
  type ChronicleSection,
} from "../core/chronicle";
import { chronicleToMarkdown, CHRONICLE_TITLE } from "../core/chronicleMarkdown";
import { buildChroniclePanelHtml } from "../views/chroniclePanelHtml";
import { openGeneratedMarkdown } from "../views/openDocument";
import { revealTextLocation, type RevealInManuscript } from "./revealLocation";

/**
 * 年表（設計書6.39）。
 *
 * 話数順と時系列順の2つの並びで、話ごとの出来事を1枚にまとめる。
 * **AIは使わない**——材料は走査した話・人物の変化・能力・呼称・
 * 各話あらすじ・伏線台帳・作中の時間で、どれも既にある記録である。
 *
 * **この画面は何も書き換えない**（6.39.5）。押せるのは並びと絞り込み、
 * 「設定資料を開く」「本文を開く」「Markdownで書き出す」、そして
 * 時期・系統を作る流れ（選択画面）の呼び出しだけである。
 *
 * 作品ごとに1枚だけ開く。同じ作品の年表を何枚も並べる意味がない。
 */

const openPanels = new Map<string, ChroniclePanel>();

export interface ChronicleDeps {
  /**
   * 「設定資料を開く」。実体は `extension.ts` が繋ぐ。
   *
   * ここから設定資料パネルを直に読み込むと、views→features の逆流と
   * 読み合いの輪ができる（人物相関図と同じ理由）。
   */
  openSettingsRecord: (work: WorkEntry, characterId: string) => Promise<void>;
  /**
   * 原稿エディタで本文を示す口。
   *
   * **飛び先の経路は `revealLocation.ts` の1本だけ**（6.37.4）。
   * 引き受けられなければ素のエディタで開く。
   */
  revealInManuscript?: RevealInManuscript;
  /** 時期・系統を作る流れ。`features/chronicleEdit.ts` を繋ぐ */
  editTimeline: (work: WorkEntry) => Promise<void>;
}

export async function openChronicle(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  deps: ChronicleDeps
): Promise<void> {
  const existing = openPanels.get(work.id);
  if (existing) {
    await existing.revealAndReload();
    return;
  }
  const panel = new ChroniclePanel(context, work, deps);
  openPanels.set(work.id, panel);
  await panel.initialize();
}

/**
 * 開いている年表を読み直す。
 *
 * 時期を作ったあと、開きっぱなしの年表は古いままになる。
 * **開いていなければ何もしない**——見ていない画面のために資料を読み直す
 * 必要はない。
 */
export async function refreshChronicle(workId: string): Promise<void> {
  await openPanels.get(workId)?.reload();
}

type ChronicleOrder = "chapter" | "timeline";

class ChroniclePanel {
  private readonly panel: vscode.WebviewPanel;

  private order: ChronicleOrder = "chapter";
  private characterId = "";
  /** 出す出来事の種類。既定は全部 */
  private kinds: ChronicleEventKind[] = [...CHRONICLE_EVENT_KINDS];

  private rows: ChronicleRow[] = [];
  private timeline: Timeline | null = null;
  /** `timeline.json` が読めなかったときの文言。**そのまま画面に出す** */
  private timelineError = "";
  /** 読み込めなかった資料。黙って落とさないために持つ */
  private loadWarnings: string[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly work: WorkEntry,
    private readonly deps: ChronicleDeps
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "novelai.chronicle",
      `年表: ${work.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => openPanels.delete(work.id));

    this.panel.webview.html = buildChroniclePanelHtml(
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

  async reload(): Promise<void> {
    await this.load();
  }

  async revealAndReload(): Promise<void> {
    this.panel.reveal();
    // 開きっぱなしのパネルは、そのあと増えた資料を知らない
    await this.load();
  }

  private async load(): Promise<void> {
    this.loadWarnings = [];
    this.timelineError = "";

    const scanned = await scanWork(this.work);
    const characters = await this.loadCharacters();
    const synopses = await this.loadSynopses();
    const foreshadows = await this.loadForeshadows();
    this.timeline = await this.loadTimeline();

    this.rows = buildChronicle(
      scanned.episodes,
      characters,
      synopses,
      foreshadows,
      this.timeline,
      {
        workRoot: this.work.folderPath,
        format: await readWorkFormat(this.work),
      }
    );

    // 時期を1つも作れていない作品では、時系列順を選べない。
    // 選ばせておいて空の画面を出すより、押せない理由を出すほうがよい
    if (this.order === "timeline" && !this.canTimeline()) {
      this.order = "chapter";
    }
    this.post();
  }

  private async loadCharacters(): Promise<Character[]> {
    try {
      const loaded = await new CharacterStore(this.work).loadAll();
      if (loaded.errors.length > 0) {
        this.loadWarnings.push(
          `読み込めなかった人物が${loaded.errors.length}件あります` +
            `（${loaded.errors.map((entry) => entry.file).join("、")}）。`
        );
      }
      return loaded.characters;
    } catch (error) {
      this.loadWarnings.push(`人物を読めませんでした：${messageOf(error)}`);
      return [];
    }
  }

  /**
   * あらすじ。**読めなくても年表は出す。**
   *
   * あらすじは行の1列にすぎない。ここで止めると、話数と登場人物だけでも
   * 役に立つ年表が、まるごと開けなくなる。
   */
  private async loadSynopses(): Promise<ChapterSynopsisSet | null> {
    try {
      return await new SynopsisStore(this.work).load();
    } catch (error) {
      this.loadWarnings.push(
        `各話あらすじを読めませんでした：${messageOf(error)}`
      );
      return null;
    }
  }

  private async loadForeshadows(): Promise<Foreshadow[]> {
    try {
      const loaded = await createForeshadowStore(this.work).loadAll();
      if (loaded.errors.length > 0) {
        this.loadWarnings.push(
          `読み込めなかった伏線が${loaded.errors.length}件あります。`
        );
      }
      return loaded.records;
    } catch (error) {
      this.loadWarnings.push(`伏線を読めませんでした：${messageOf(error)}`);
      return [];
    }
  }

  /**
   * 作中の時間。
   *
   * **`loadOrEmpty` を使わない**（`timelineStore.ts` の注意書き）。
   * 空として扱うとIF編の話が本編に混ざる。読めなければ例外の文言を
   * そのまま画面に出し、**話数順だけは出す**（6.39.2）。
   */
  private async loadTimeline(): Promise<Timeline | null> {
    try {
      return await new TimelineStore(this.work).load();
    } catch (error) {
      this.timelineError = messageOf(error);
      logFailure("年表", {
        作品: this.work.title,
        内容: this.timelineError,
      });
      return null;
    }
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.post();
          return;
        case "order":
          this.order = message.order;
          this.post();
          return;
        case "filter":
          this.characterId = message.characterId;
          this.kinds = message.kinds;
          this.post();
          return;
        case "openCharacter":
          await this.deps.openSettingsRecord(this.work, message.characterId);
          return;
        case "openEpisode":
          // 飛び先は1本の経路だけ（別の道を作らない。6.37.4）
          await revealTextLocation(
            message.filePath,
            1,
            this.deps.revealInManuscript,
            "年表"
          );
          return;
        case "edit":
          await this.deps.editTimeline(this.work);
          // 時期を作った直後の年表が古いままでは、作った手応えがない
          await this.load();
          return;
        case "export":
          await this.exportMarkdown();
          return;
      }
    } catch (error) {
      const detail = messageOf(error);
      logFailure("年表", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(`年表でエラーが起きました。${detail}`);
    }
  }

  private async exportMarkdown(): Promise<void> {
    await openGeneratedMarkdown(
      CHRONICLE_TITLE,
      chronicleToMarkdown(this.sections(), {
        workTitle: this.work.title,
        order: this.order,
      }),
      { preview: false },
      { work: this.work }
    );
  }

  /** 時系列で並べられるか。時期が1つも無ければ並べようがない */
  private canTimeline(): boolean {
    return (this.timeline?.timepoints.length ?? 0) > 0;
  }

  /** いま見えている段。書き出しも画面もここを通る（見えている形を残す） */
  private sections(): ChronicleSection[] {
    const rows = filterChronicle(this.rows, {
      characterId: this.characterId || undefined,
      // 全部にチェックが入っているときは絞らない（行が消えない）
      kinds:
        this.kinds.length === CHRONICLE_EVENT_KINDS.length
          ? undefined
          : this.kinds,
    });

    if (this.order === "timeline") return sortByTimeline(rows, this.timeline);
    // 話数順は段を分けない。段の見出しは時系列順のためのものである
    return rows.length > 0
      ? [{ label: "", line: null, kind: "canonical", rows }]
      : [];
  }

  private post(): void {
    void this.panel.webview.postMessage({
      type: "chronicle",
      data: this.build(),
    });
  }

  private build(): ChronicleView {
    const sections = this.sections();
    return {
      title: `${this.work.title} の年表`,
      order: this.order,
      canTimeline: this.canTimeline(),
      characterId: this.characterId,
      characters: chronicleCharacters(this.rows),
      kinds: this.kinds,
      kindOptions: CHRONICLE_EVENT_KINDS.map((kind) => ({
        key: kind,
        label: CHRONICLE_EVENT_LABELS[kind],
      })),
      sections: sections.map((section) => ({
        label: section.label,
        // IF編・夢の段には、本編ではないと分かる一言を添える
        note:
          section.kind === "alternate"
            ? "本編ではない筋です。本編の資料には混ぜていません。"
            : section.kind === "unassigned"
              ? "時期を決めていない話です。「時期・系統を編集」から決められます。"
              : "",
        // 時期の見出しで切るのは時系列順のときだけ。話数順で切ると、
        // せっかく並べた話数の流れが見出しで途切れる
        groups:
          this.order === "timeline"
            ? groupByTimepoint(section.rows).map((group) => ({
                label: group.label,
                rows: group.rows.map(toRowView),
              }))
            : [{ label: "", rows: section.rows.map(toRowView) }],
      })),
      emptyMessage: this.emptyMessage(),
      notice: this.notice(),
    };
  }

  /**
   * 何も出ないときの案内。
   *
   * **材料が無いのと、絞り込みで消えたのとで、次にすることが違う。**
   * 同じ文言にすると、条件を戻せばよいだけの人に抽出をやり直させる。
   */
  private emptyMessage(): string {
    if (this.rows.length === 0) {
      return (
        "並べる話がありません。作品に本文ファイルを入れてから開き直してください。"
      );
    }
    return "絞り込みに合う話がありません。人物か種類の条件をゆるめてください。";
  }

  /** 画面の上に出す注意書き。読めなかったものを黙って落とさない */
  private notice(): string {
    const notes: string[] = [];
    if (this.timelineError) {
      // **例外の文言をそのまま出す。** どのファイルのどこが悪いかは、
      // 検証が持っている情報がいちばん詳しい
      notes.push(`${this.timelineError} 時系列順は使えません。`);
    } else if (!this.canTimeline()) {
      notes.push(
        "作中の時期がまだ1つもありません。「時期・系統を編集」から作れます。"
      );
    }
    notes.push(...this.loadWarnings);
    return notes.join(" ");
  }
}

function toRowView(row: ChronicleRow): RowView {
  return {
    filePath: row.filePath,
    chapterLabel: row.chapterLabel,
    title: row.title ?? "",
    timepoint: row.timepoint ? timepointLabel(row.timepoint) : "",
    appeared: row.appeared,
    events: row.events.map((event) => ({
      kindLabel: CHRONICLE_EVENT_LABELS[event.kind],
      characterId: event.characterId ?? "",
      text: event.text,
    })),
    synopsis: row.synopsis ?? "",
  };
}

interface RowView {
  filePath: string;
  chapterLabel: string;
  title: string;
  timepoint: string;
  appeared: Array<{ id: string; name: string }>;
  events: Array<{ kindLabel: string; characterId: string; text: string }>;
  synopsis: string;
}

interface ChronicleView {
  title: string;
  order: ChronicleOrder;
  canTimeline: boolean;
  characterId: string;
  characters: Array<{ id: string; name: string }>;
  kinds: ChronicleEventKind[];
  kindOptions: Array<{ key: ChronicleEventKind; label: string }>;
  sections: Array<{
    label: string;
    note: string;
    groups: Array<{ label: string; rows: RowView[] }>;
  }>;
  emptyMessage: string;
  notice: string;
}

type PanelMessage =
  | { type: "ready" }
  | { type: "order"; order: ChronicleOrder }
  | { type: "filter"; characterId: string; kinds: ChronicleEventKind[] }
  | { type: "openCharacter"; characterId: string }
  | { type: "openEpisode"; filePath: string }
  | { type: "edit" }
  | { type: "export" };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
