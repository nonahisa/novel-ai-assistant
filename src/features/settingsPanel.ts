import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import { isCharacterTextField, type Character } from "../models/character";
import type { Ability, AbilitySystem } from "../models/ability";
import type { Location } from "../models/location";
import { membersOf, type Organization } from "../models/organization";
import {
  WORLD_CATEGORIES,
  WORLD_CATEGORY_LABELS,
  type WorldItem,
} from "../models/world";
import type { AiNote, AiNoteSource } from "../models/aiNote";
import { CharacterStore } from "../core/characterStore";
import {
  planCharacterSeparation,
  type SeparationPlan,
} from "../core/characterSeparate";
import { normalizeName } from "../core/characterMerge";
import { PendingUpdateStore } from "../core/pendingUpdates";
import {
  AbilitySystemStore,
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import type { SettingsStore } from "../core/settingsStore";
import {
  applyAbilityEdits,
  applyCharacterEdits,
  applyLocationEdits,
  applyOrganizationEdits,
  applyWorldItemEdits,
  appendAiNote,
  removeAiNote,
  toRecordEdits,
  CUSTOM_FIELD_PREFIX,
  SettingsEditError,
  type EditOptions,
  type RecordEdits,
} from "../core/settingsEdit";
import {
  describeAbility,
  describeCharacter,
  describeLocation,
  describeOrganization,
  describeWorldItem,
  KIND_LABELS,
  type SettingsKind,
} from "../core/settingsSummary";
import {
  describeChangeValues,
  describeConflictValues,
  formatChapters,
} from "../core/settingsMarkdown";
import {
  applyPromotion,
  changesOfField,
  promoteConflictToChanges,
} from "../core/recordChanges";
import type {
  RecordChange,
  RecordConflict,
} from "../models/jsonValidation";
import {
  buildAbilityListItems,
  buildCharacterListItems,
  buildLocationListItems,
  buildOrganizationListItems,
  buildWorldListItems,
  type SettingsListItem,
} from "../core/settingsList";
import {
  collectMentionExcerpts,
  EXCERPT_MAX_CHARS,
  type ExcerptSource,
  type MentionExcerpt,
} from "../core/mentionExcerpts";
import { resolveMaxOutputTokens } from "../ai/outputLimit";
import { loadExcerptSources } from "../core/manuscriptSources";
import { expandNameVariants } from "../core/termIndex";
import { evidencePhrases } from "../core/groundedEvidence";
import {
  AIRegistry,
  ensureConfigured,
  type AssignableFeature,
} from "../ai/registry";
import { confirmPaidUsage } from "./aiConnectivity";
import { prepareRetrieval, search, type RetrievalContext } from "./vectorSearch";
import {
  buildSearchQuery,
  buildSearchTermsPrompt,
  parseSearchTerms,
  SEARCH_TERMS_SCHEMA,
  SEARCH_TERMS_SYSTEM_PROMPT,
} from "../prompts/searchTerms";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  buildSettingsChatPrompt,
  SETTINGS_ASSISTANT_SYSTEM_PROMPT,
  type ChatTurn,
} from "../prompts/settingsChat";
import {
  buildEnrichPrompt,
  buildEnrichSchema,
  enrichableFields,
  MISATTRIBUTED_KEY,
  type EnrichableField,
} from "../prompts/settingsEnrich";
import {
  droppedTotal,
  insertMisattributedValue,
  parseMisattributedValues,
  planMisattributedRecord,
  resolveMisattributedDestination,
  type MisattributedDestination,
  type MisattributedValue,
} from "../core/misattributedValues";
import { isMeaningfulValue } from "../core/characterExtractionValidation";
import { CustomFieldStore } from "../core/customFieldStore";
import type { CustomFieldDefinition } from "../models/customField";
import { clampSummary, SUMMARY_MAX_CHARS } from "../core/summaryLimit";
import {
  describeInvolvement,
  scoreChanges,
  stripInvolvementNote,
} from "../core/changeSignificance";
import { buildSettingsPanelHtml } from "../views/settingsPanelHtml";
import { renderMarkdownLite } from "../core/markdownLite";
import { withCancellableProgress } from "../views/progress";
import { logFailure, logStep } from "../core/logger";
import { appendChatLog, summarizeMaterials } from "../core/chatLog";
import * as path from "../core/paths";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { parseSynopsisMarkdown, SYNOPSIS_FILE } from "../core/synopsisDoc";
import { SynopsisStore } from "../core/synopsisStore";

/**
 * 設定資料パネル。
 *
 * 資料を読むだけでなく、その場で直せて、AIに掘り下げさせられるようにする。
 * JSONを直接開いて編集するより間違えにくく、
 * 「どの項目を触ってよいか」が画面から分かる。
 *
 * **AIが書いたものは作者が承認するまで保存しない。**
 * 掘り下げは本文の逐語照合ができない解釈であり、
 * 抽出結果と同じ扱いで自動保存すると、
 * どこまでが本文に書いてあることなのか分からなくなるため。
 */

/** パネルが扱う設定レコード。種別が増えるたびに union を書き足さないための別名 */
type SettingsRecord = Character | Ability | Organization | Location | WorldItem;

/** 作品ごとに1枚だけ開く。同じ作品で何枚も開いても混乱するだけ */
const openPanels = new Map<string, SettingsPanel>();

export async function openSettingsPanel(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  registry: AIRegistry,
  options: { beside?: boolean } = {}
): Promise<SettingsPanel> {
  const existing = openPanels.get(work.id);
  if (existing) {
    existing.reveal(options.beside);
    return existing;
  }
  const panel = new SettingsPanel(context, work, registry, options.beside);
  openPanels.set(work.id, panel);
  await panel.initialize();
  return panel;
}

/** 開いていれば返す。本文のクリックに追従させるために使う */
export function findOpenSettingsPanel(
  workId: string
): SettingsPanel | undefined {
  return openPanels.get(workId);
}

interface DetailField {
  /** 作者が足した項目は `custom:` を付けて区別する */
  key: string;
  label: string;
  value: string;
  multiline: boolean;
  /**
   * チェックボックスで見せる項目。
   * 値は入なら "1"、切なら空文字で受け渡す。
   */
  check?: boolean;
  /** 決まった値から選ぶ項目。画面では選択肢として出す */
  choices?: Array<{ value: string; label: string }>;
  /**
   * 入力の候補（設計書6.5.6）。**選択肢ではない。**
   *
   * 名前欄に別名を並べて、選んで入れ替えられるようにする。
   * `choices` と違い**手で書く道は残す**——まだ別名に無い名前へ
   * 変えられなくなると、打ち間違いの修正すらできない。
   */
  suggestions?: string[];
  /** 欄の下に添える短い説明。**次に何をすればよいか**を書く */
  hint?: string;
}

/** 世界観の分類。画面には日本語の見出しを出し、保存するのは英字のキー */
const WORLD_CATEGORY_CHOICES = WORLD_CATEGORIES.map((category) => ({
  value: category,
  label: WORLD_CATEGORY_LABELS[category],
}));

interface DetailView {
  kind: SettingsKind;
  id: string;
  name: string;
  autoGenerated: boolean;
  /** 名前のすぐ下に出す要点。登場話・食い違いなど、作者が毎回見るもの */
  readOnly: Array<{ label: string; value: string }>;
  fields: DetailField[];
  /**
   * 画面のいちばん下へ回す参考情報。
   *
   * 抽出根拠は「AIがどこを見てそう書いたか」の記録で、
   * 疑わしいときにだけ読むものである。名前の直下に置くと、
   * 毎回読む項目（登場話や編集欄）が押し下げられて読みにくい。
   */
  reference: Array<{
    label: string;
    value: string;
    /**
     * その行に添える操作。今は食い違いを「作中の変化」として
     * 確定させるものだけ（設計書6.18）。
     */
    action?: { label: string; field: string };
  }>;
  /**
   * 別人として切り出せる呼び名（設計書6.5.8）。**人物のときだけ入る。**
   *
   * 敬称を付けただけの呼び方（「アジャン様」）は出さない。
   * 分けても同じ人が2件になるだけで、作者の役に立たない。
   */
  separable?: string[];
  /** html は整形済み。画面側でそのまま挿入する */
  aiNotes: Array<AiNote & { html: string }>;
}


/**
 * 別人として切り出せる呼び名を選ぶ（設計書6.5.8）。
 *
 * **敬称を付けただけの呼び方は出さない。** 「アジャン様」は「アジャン」
 * 自身の呼び方であって、別人ではない。出すと、押した先で必ず断られる
 * ——**押せない札を並べない**（6.5.7の裏返し）。
 *
 * 既に別人だと決めた相手も出さない（分ける操作は済んでいる）。
 */
function separableAliases(character: Character): string[] {
  const own = normalizeName(character.name);
  const decided = new Set(
    (character.distinctFrom ?? []).map((entry) => normalizeName(entry.name))
  );
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of character.aliases) {
    const alias = raw.trim();
    if (!alias) continue;
    const key = normalizeName(alias);
    if (key === own || decided.has(key) || seen.has(key)) continue;
    seen.add(key);
    // 敬称違いは同じ人なので、代表を1つだけ出す（押すと一緒に移る）
    out.push(alias);
  }
  return out;
}
/** メモをそのまま渡さず、整形したHTMLを添える */
function withRenderedNotes(notes: AiNote[]): Array<AiNote & { html: string }> {
  return notes.map((note) => ({ ...note, html: renderMarkdownLite(note.text) }));
}


/**
 * 資料が書き換わったことを、外（拡張機能の本体）へ知らせる口。
 *
 * ## なぜ要るか
 *
 * **このパネルからの保存は、本文の用語ハイライトを引き直していなかった。**
 * `TermHighlighter.invalidate()` を呼ぶのはエディタで `.json` を保存した
 * ときだけで、パネルからの保存は通らない。名前を入れ替えても（6.5.6）、
 * 別人に分けても（6.5.8）、本文の色分けは古い人物を指したままになり、
 * 作者からは「効いていない」ように見える。
 *
 * `atomicWrite.ts` の `setWriteObserver` と同じ形にしてある。
 * パネルは vscode の画面部品を知っていればよく、
 * ハイライトや一覧の都合まで抱え込ませない。
 */
let changeObserver: ((work: WorkEntry) => void) | undefined;

export function setSettingsChangeObserver(
  observer: ((work: WorkEntry) => void) | undefined
): void {
  changeObserver = observer;
}

/**
 * 人物詳細の「相関図」を押されたときに呼ぶ口（設計書6.38.3）。
 *
 * 相関図パネルをここから直に読み込まない。相関図の側にも
 * 「設定資料を開く」があり、互いに読み合う輪になる。`changeObserver` と
 * 同じ形にして、繋ぐのは `extension.ts` の仕事にしてある。
 */
let relationGraphOpener:
  | ((work: WorkEntry, characterId: string) => Promise<void>)
  | undefined;

export function setRelationGraphOpener(
  opener:
    | ((work: WorkEntry, characterId: string) => Promise<void>)
    | undefined
): void {
  relationGraphOpener = opener;
}

export class SettingsPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly characterStore: CharacterStore;
  private readonly abilityStore: SettingsStore<Ability>;
  private readonly locationStore: SettingsStore<Location>;
  private readonly organizationStore: SettingsStore<Organization>;
  private readonly worldStore: SettingsStore<WorldItem>;
  private readonly systemStore: AbilitySystemStore;
  private readonly customFieldStore: CustomFieldStore;

  private characters: Character[] = [];
  private abilities: Ability[] = [];
  private locations: Location[] = [];
  private organizations: Organization[] = [];
  private worldItems: WorldItem[] = [];
  private abilitySystem: AbilitySystem | undefined;
  private customFields: CustomFieldDefinition[] = [];
  private loadErrors: Array<{ file: string; message: string }> = [];

  /** 本文は重いので一度読んだら使い回す。パネルを閉じるまで有効 */
  private excerptSources: ExcerptSource[] | undefined;
  /** 検索の材料。パネルを開いている間は使い回す（毎回読み直すと重い） */
  private retrieval: RetrievalContext | undefined;
  /** 直近の相談で使った検索語。ログに残して、外した場面の原因を追えるようにする */
  private lastSearchTerms: string[] = [];
  /** 作品全体の資料（紹介文・キャッチコピー・各話あらすじ）。読むだけ */
  private workInfo: WorkInfoView = { blurb: "", catchphrase: "", episodes: [] };
  /** 選択中のレコードごとのやり取り。保存はしない */
  private readonly chatHistory = new Map<string, ChatTurn[]>();
  /** 有料のAIについて確認を取り終えたモデル名。切り替えたら取り直す */
  private paidConfirmedFor: string | undefined;
  /**
   * 直近の再読込ではじいた記述（設計書6.31.2）。
   *
   * 画面には見出しと行き先だけを送り、書き込む中身はこちらで持つ。
   * 画面から返ってきた文字列をそのまま保存すると、
   * 照合を通したはずの値が別のものへ差し替わりうる。
   */
  private misattributed: MisattributedValue[] = [];
  /**
   * その再読込の対象種別。
   * 行き先を選べるのは人物だけ（belongsTo は人物の呼び名を前提にしており、
   * 場所の「地域」や能力の「代償」は人物レコードに置き場所が無い）。
   */
  private misattributedKind: SettingsKind | undefined;
  /** 画面が「ready」を返したか。開いた直後に送っても届かないため見張る */
  private ready = false;
  private readyWaiters: Array<() => void> = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly work: WorkEntry,
    private readonly registry: AIRegistry,
    beside = false
  ) {
    this.characterStore = new CharacterStore(work);
    this.abilityStore = createAbilityStore(work);
    this.locationStore = createLocationStore(work);
    this.organizationStore = createOrganizationStore(work);
    this.worldStore = createWorldStore(work);
    this.systemStore = new AbilitySystemStore(work);
    this.customFieldStore = new CustomFieldStore(work);

    this.panel = vscode.window.createWebviewPanel(
      "novelai.settings",
      `設定資料: ${work.title}`,
      // 本文の右側に並べる。本文を読みながら設定を見られるようにするため
      beside
        ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
        : vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);

    this.panel.onDidDispose(() => openPanels.delete(work.id));
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message as PanelMessage);
    });
  }

  reveal(beside = false): void {
    // preserveFocus を立てるのは、本文を書きながら見るときに
    // カーソルが資料側へ飛ばないようにするため
    this.panel.reveal(
      beside ? vscode.ViewColumn.Beside : undefined,
      beside
    );
  }

  get workId(): string {
    return this.work.id;
  }

  /**
   * 外から特定の1件を選ばせる。本文中の用語をクリックしたときに使う。
   * 一覧の選択状態も合わせるため、画面側で種別タブごと切り替える。
   *
   * ## 見つからなければ、一度だけ読み直す（作者の報告、2026-08-28）
   *
   * 「用語ハイライト上を右クリックした場合で、すでに設定資料パネルが
   * 開いている場合は、該当項目の設定資料を表示してください」——**開きっぱなしの
   * パネルは、そのあと増えた資料を知らない。** `openSettingsPanel` は既に
   * 開いていれば `reveal` するだけで読み直さないので、開いたあとに抽出した
   * 人物を右クリックすると、ここで `find` が外れて**黙って何も起きなかった。**
   *
   * 用語ハイライトはディスクの資料から引いているので、**画面が古いほうが
   * 疑わしい。** 読み直してもう一度だけ探す。
   *
   * それでも無ければ、**黙って終わらない。** 押しても何も起きないと、
   * 作者からは壊れているようにしか見えない。
   *
   * @param options.collapseList 一覧を畳んで出す。**本文の用語から開いた
   *   ときだけ**（作者の依頼、2026-08-28）。本文の隣へ並べる資料なので、
   *   狭い幅を一覧に取られると肝心の中身が読めない
   */
  async showRecord(
    kind: SettingsKind,
    id: string,
    options: { collapseList?: boolean } = {}
  ): Promise<void> {
    let detail = this.detailOf(kind, id);
    if (!detail) {
      await this.refreshFromDisk();
      detail = this.detailOf(kind, id);
    }
    if (!detail) {
      logStep(
        `設定資料パネル：用語（${kind}/${id}）が資料に見つかりませんでした`
      );
      void vscode.window.showInformationMessage(
        "設定資料に見つかりませんでした。抽出し直すと直ることがあります。"
      );
      return;
    }

    // **開いた直後の画面へ送っても捨てられる**（スクリプトがまだ走っていない）。
    // 用語から開くときは、パネルもその場で作られていることがある
    await this.whenReady();
    // **送ったことを記録する**（作者の報告、2026-08-28「用語上で右クリック
    // したとき、パネルの説明は切り替わりません」）。ここまで来ていれば
    // 疑うのは画面側、来ていなければ経路の手前と、切り分けられる
    logStep(
      `設定資料パネル：${this.work.title} の ${kind}/${id} を画面へ送りました`
    );
    this.post({
      type: "focus",
      kind,
      id,
      detail,
      ...(options.collapseList ? { collapseList: true } : {}),
    });
  }

  /**
   * 相談パネルから、留意点つきで再読込を始める（設計書6.31.3）。
   *
   * **再読込そのものは `handleEnrich` を通す。** ここで組み立て直すと、
   * 片方だけ直したときに「画面のボタンからと相談からで結果が違う」
   * 食い違いが出る。この口がするのは、対象を開いて留意点を渡すことだけ。
   *
   * 名前の照合は呼び出し側（相談パネル）が済ませているが、開くまでの間に
   * 消えていることもあるので、ここでも実在を確かめる。
   */
  async reloadRecordFromChat(
    kind: SettingsKind,
    id: string,
    notes?: string
  ): Promise<void> {
    this.reveal();

    const detail = this.detailOf(kind, id);
    if (!detail) {
      this.post({
        type: "error",
        message:
          "読み直す設定が見つかりませんでした。資料が変わったようです。",
      });
      return;
    }

    // **画面が受け取れるようになるまで待つ。** 開いた直後は、送っても
    // 捨てられる（スクリプトがまだ走っていない）。待たないと、
    // 提案ができたころに画面が空のままになる
    await this.whenReady();
    // 留意点も一緒に送って、画面の入力欄へ映す。何を添えて読み直したのかが
    // 見えないと、出てきた提案の理由を作者が確かめられない
    this.post({ type: "focus", kind, id, detail, notes });

    try {
      await this.handleEnrich(kind, id, notes);
    } catch (error) {
      // handleMessage の外から呼ばれるので、後片付けはここで行う
      this.setBusy(false);
      this.post({ type: "error", message: describeError(error) });
    }
  }

  /**
   * 画面（WebView）が受け取れる状態になるまで待つ。
   *
   * 作ったばかりのパネルへ送ったメッセージは**届かずに捨てられる**。
   * 作者が押してから開く経路（相談パネルからの再読込）でだけ要る。
   *
   * 待ち切れなくても先へ進む。画面が既に動いていれば映るし、
   * ここで止まると作者は何も起きないまま待たされる。
   *
   * **既に `ready` を受け取っていれば、その場で解決する。** 一度きりの
   * 知らせを待ち続けると、開きっぱなしのパネルへは二度と送れなくなる。
   *
   * **待ち切れなかったことは黙って捨てない**（作者の報告、2026-08-28）。
   * 「押しても切り替わらない」を調べるとき、ここを通ったのかどうかが
   * 分からないと、画面側と拡張機能側のどちらを見ればよいか決められない。
   */
  private whenReady(timeoutMs = 5_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        logStep(
          `設定資料パネル：画面の準備（ready）を${timeoutMs}ミリ秒待ちきれず、` +
            "そのまま送りました"
        );
        resolve();
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const resolve of this.readyWaiters) resolve();
    this.readyWaiters = [];
  }

  /**
   * ファイルを外から書き換えたあとに読み直す。
   *
   * **開いたままのパネルは、自分では気づかない。** 重複をまとめると
   * レコードが減るのに、画面には消えたはずの人物が残り続けていた
   * （実機で発覚、2026-08-15）。古い一覧から選ぶと「見つかりません」になる。
   */
  async refreshFromDisk(): Promise<void> {
    await this.loadAll();
  }

  async initialize(): Promise<void> {
    const nonce = createNonce();
    this.panel.webview.html = buildSettingsPanelHtml(
      nonce,
      this.panel.webview.cspSource
    );
    await this.loadAll();
  }

  private async loadAll(): Promise<void> {
    const loadedCharacters = await this.characterStore.loadAll();
    const loadedAbilities = await this.abilityStore.loadAll();
    const loadedLocations = await this.locationStore.loadAll();
    const loadedOrganizations = await this.organizationStore.loadAll();
    const loadedWorld = await this.worldStore.loadAll();

    this.characters = loadedCharacters.characters;
    this.abilities = loadedAbilities.records;
    this.locations = loadedLocations.records;
    this.organizations = loadedOrganizations.records;
    this.worldItems = loadedWorld.records;
    this.loadErrors = [
      ...loadedCharacters.errors,
      ...loadedAbilities.errors,
      ...loadedLocations.errors,
      ...loadedOrganizations.errors,
      ...loadedWorld.errors,
    ];

    // 能力体系が壊れていても、人物と場所は読めるので画面は出す
    try {
      this.abilitySystem = await this.systemStore.load();
    } catch {
      this.abilitySystem = undefined;
    }

    // 項目の定義が読めなくても、既定の項目は編集できる。
    // 直し方は「一覧に項目を増やす」で伝えるので、ここでは黙って空にする
    this.customFields = await this.customFieldStore.loadFields();
    this.workInfo = await this.loadWorkInfo();

    this.post({
      type: "init",
      groups: this.groups(),
      workInfo: this.workInfo,
      notice: this.notice(),
    });
  }

  private notice(): string {
    if (this.loadErrors.length === 0) return "";
    // 壊れたJSONは勝手に直さない。何が読めていないかだけ伝える
    return `読み込めない設定ファイルが ${this.loadErrors.length} 件あります（${this.loadErrors
      .map((error) => error.file)
      .join("、")}）。その項目は一覧に出ていません。`;
  }

  /**
   * 作品全体の資料（紹介文・キャッチコピー・各話あらすじ）を集める。
   *
   * **設定資料集にも載せる**（作者の要望、2026-08-16）。人物や場所と並んで
   * 作品の資料なのに、`設定/synopsis.md` を自分で開くしか見る方法が無く、
   * 「閲覧がわかりにくい」と言われていた。
   *
   * **読むだけにする。** 紹介文は「作品紹介文を生成」、あらすじは
   * 「各話あらすじを生成」が真実の在り処を持っている。ここで書き換えられると、
   * どちらが正しいのか分からなくなる。
   */
  private async loadWorkInfo(): Promise<WorkInfoView> {
    const info: WorkInfoView = { blurb: "", catchphrase: "", episodes: [] };

    try {
      const config = await readWorkConfig(this.work);
      const file = path.join(
        workPaths(this.work, config).settings,
        SYNOPSIS_FILE
      );
      const bytes = await vscode.workspace.fs.readFile(path.toUri(file));
      const doc = parseSynopsisMarkdown(new TextDecoder().decode(bytes));
      info.blurb = doc.blurb.trim();
      info.catchphrase = (doc.catchphrase ?? "").trim();
    } catch {
      // まだ作っていない作品では、この文書自体が無い
    }

    try {
      const set = await new SynopsisStore(this.work).load();
      info.episodes = set.episodes
        .filter((episode) => episode.synopsis.trim())
        .map((episode) => ({
          label:
            episode.chapter !== null
              ? `第${episode.chapter}話${episode.title ? ` ${episode.title}` : ""}`
              : episode.fileName,
          synopsis: episode.synopsis.trim(),
        }));
    } catch {
      // あらすじが読めなくても、紹介文だけは見せられる
    }

    return info;
  }

  private groups(): Record<SettingsKind, SettingsListItem[]> {
    return {
      character: buildCharacterListItems(this.characters),
      ability: buildAbilityListItems(this.abilities),
      organization: buildOrganizationListItems(
        this.organizations,
        this.characters
      ),
      location: buildLocationListItems(this.locations),
      world: buildWorldListItems(this.worldItems),
    };
  }

  private find(
    kind: SettingsKind,
    id: string
  ): SettingsRecord | undefined {
    if (kind === "character") {
      return this.characters.find((item) => item.id === id);
    }
    if (kind === "ability") return this.abilities.find((item) => item.id === id);
    if (kind === "organization") {
      return this.organizations.find((item) => item.id === id);
    }
    if (kind === "world") return this.worldItems.find((item) => item.id === id);
    return this.locations.find((item) => item.id === id);
  }

  private detailOf(kind: SettingsKind, id: string): DetailView | undefined {
    const record = this.find(kind, id);
    if (!record) return undefined;

    if (kind === "character") {
      const character = record as Character;
      return {
        kind,
        id,
        name: character.name,
        autoGenerated: character.autoGenerated,
        readOnly: [
          { label: "登場話", value: formatChapters(character.appearedChapters) },
          { label: "一人称", value: character.firstPerson.default ?? "" },
        ].filter((entry) => entry.value),
        reference: referenceLines(
          character.conflicts,
          character.evidence,
          character.changes,
          character.appearedChapters
        ),
        fields: [
          nameField(character.name, character.aliases),
          // 紹介は文章なので、1行の入力欄では書いた内容が隠れる
          field(
            "summary",
            `紹介（${SUMMARY_MAX_CHARS}字以内）`,
            character.summary,
            true
          ),
          field("gender", "性別", character.gender),
          field("affiliation", "所属", character.affiliation),
          field("reading", "読み", character.reading),
          field("aliases", "別名（読点区切り）", character.aliases.join("、")),
          field("role", "役割", character.role),
          field("personality", "性格", character.personality, true),
          field("appearance", "外見", character.appearance, true),
          // AIの判定を作者が直せるようにする。外れていると、その人物は
          // 一覧の下へ回り、用語ハイライトとIME辞書からも消えたままになる
          checkField(
            "isMob",
            "モブ・集団として扱う（一覧の下へまとめ、ハイライトと辞書から外す）",
            character.isMob
          ),
          // 作者が足した項目は、既定の項目のあと・メモの前に並べる
          ...customFieldControls(character, this.customFields),
          field("authorNotes", "作者メモ", character.authorNotes, true),
          field("exportNote", "資料用の補足", character.exportNote, true),
        ],
        separable: separableAliases(character),
        aiNotes: withRenderedNotes(character.aiNotes),
      };
    }

    if (kind === "ability") {
      const ability = record as Ability;
      return {
        kind,
        id,
        name: ability.name,
        autoGenerated: ability.autoGenerated,
        readOnly: [
          { label: "使い手", value: ability.userNames.join("、") },
          { label: "登場話", value: formatChapters(ability.appearedChapters) },
        ].filter((entry) => entry.value),
        reference: referenceLines(ability.conflicts, ability.evidence),
        fields: [
          nameField(ability.name, ability.aliases),
          field(
            "summary",
            `紹介（${SUMMARY_MAX_CHARS}字以内）`,
            ability.summary,
            true
          ),
          field("reading", "読み", ability.reading),
          field("aliases", "別名（読点区切り）", ability.aliases.join("、")),
          field("category", "分類", ability.category),
          field("description", "説明", ability.description, true),
          field("cost", "代償", ability.cost, true),
          field("limitation", "制約", ability.limitation, true),
          field("authorNotes", "作者メモ", ability.authorNotes, true),
          field("exportNote", "資料用の補足", ability.exportNote, true),
        ],
        aiNotes: withRenderedNotes(ability.aiNotes),
      };
    }

    if (kind === "organization") {
      const organization = record as Organization;
      // 所属は人物側にしかない。組織だけ見ても誰がいるか分からないので引く
      const members = membersOf(organization, this.characters);
      return {
        kind,
        id,
        name: organization.name,
        autoGenerated: organization.autoGenerated,
        readOnly: [
          { label: "所属する人物", value: members.join("、") },
          {
            label: "登場話",
            value: formatChapters(organization.appearedChapters),
          },
        ].filter((entry) => entry.value),
        reference: referenceLines(organization.conflicts, organization.evidence),
        fields: [
          nameField(organization.name, organization.aliases),
          field(
            "summary",
            `紹介（${SUMMARY_MAX_CHARS}字以内）`,
            organization.summary,
            true
          ),
          field("reading", "読み", organization.reading),
          field(
            "aliases",
            "別名（読点区切り）",
            organization.aliases.join("、")
          ),
          field("category", "種別", organization.category),
          field("parent", "上位組織", organization.parent),
          field("description", "説明", organization.description, true),
          field("authorNotes", "作者メモ", organization.authorNotes, true),
          field("exportNote", "資料用の補足", organization.exportNote, true),
        ],
        aiNotes: withRenderedNotes(organization.aiNotes),
      };
    }

    if (kind === "world") {
      const item = record as WorldItem;
      return {
        kind,
        id,
        name: item.name,
        autoGenerated: item.autoGenerated,
        readOnly: [
          { label: "登場話", value: formatChapters(item.appearedChapters) },
        ].filter((entry) => entry.value),
        reference: referenceLines(item.conflicts, item.evidence),
        fields: [
          nameField(item.name, item.aliases, "見出し（15字以内）"),
          // 分類は決まった7種。自由入力にすると綴りの揺れで
          // 資料の節が増え、読み込み時の検証でも落ちる
          choiceField("category", "分類", item.category, WORLD_CATEGORY_CHOICES),
          // 読みが要るのは「固有の用語」だけ。見出しは本文に出てこないので
          // 辞書に入れても変換の役に立たない。何のための欄かを見出しに書く
          field("reading", "読み（固有の用語のみ。IME辞書に使う）", item.reading),
          field(
            "aliases",
            "別の言い方（読点区切り）",
            item.aliases.join("、")
          ),
          field("description", "内容", item.description, true),
          field("authorNotes", "作者メモ", item.authorNotes, true),
          field("exportNote", "資料用の補足", item.exportNote, true),
        ],
        aiNotes: withRenderedNotes(item.aiNotes),
      };
    }

    const location = record as Location;
    return {
      kind,
      id,
      name: location.name,
      autoGenerated: location.autoGenerated,
      readOnly: [
        { label: "登場話", value: formatChapters(location.appearedChapters) },
      ].filter((entry) => entry.value),
      reference: referenceLines(location.conflicts, location.evidence),
      fields: [
        nameField(location.name, location.aliases),
        field(
            "summary",
            `紹介（${SUMMARY_MAX_CHARS}字以内）`,
            location.summary,
            true
          ),
        field("reading", "読み", location.reading),
        field("aliases", "別名（読点区切り）", location.aliases.join("、")),
        field("region", "地域", location.region),
        field("description", "説明", location.description, true),
        field("authorNotes", "作者メモ", location.authorNotes, true),
        field("exportNote", "資料用の補足", location.exportNote, true),
      ],
      aiNotes: withRenderedNotes(location.aiNotes),
    };
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.markReady();
          this.post({
            type: "init",
            groups: this.groups(),
            workInfo: this.workInfo,
            notice: this.notice(),
          });
          return;
        case "select":
          this.postDetail(message.kind, message.id);
          return;
        case "save":
          await this.handleSave(message.kind, message.id, message.edits);
          return;
        case "enrich":
          await this.handleEnrich(message.kind, message.id, message.notes);
          return;
        case "placeMisattributed":
          await this.handlePlaceMisattributed(message);
          return;
        case "applyProposal":
          await this.handleApplyProposal(message);
          return;
        case "approveNote":
          await this.handleApproveNote(message);
          return;
        case "deleteNote":
          await this.handleDeleteNote(message.kind, message.id, message.noteId);
          return;
        case "chat":
          await this.handleChat(message.kind, message.id, message.question);
          return;
        case "promoteConflict":
          await this.handlePromoteConflict(message.id, message.field);
          return;
        case "retire":
          await this.handleRetire(message.kind, message.id);
          return;
        case "separate":
          await this.handleSeparate(message.kind, message.id, message.alias);
          return;
        case "applyRuby":
          await this.handleApplyRuby();
          return;
        case "relationGraph":
          await this.handleRelationGraph(message.id);
          return;
      }
    } catch (error) {
      this.setBusy(false);
      this.post({ type: "error", message: describeError(error) });
    }
  }

  /**
   * その人物を中心にした相関図を開く（設計書6.38.3）。
   *
   * 押しても何も起きないのがいちばん困るので、繋がっていなければ
   * そう言う（黙って終わらない）。
   */
  private async handleRelationGraph(id: string): Promise<void> {
    if (!relationGraphOpener) {
      void vscode.window.showInformationMessage(
        "人物相関図を開けませんでした。詳細メニューの" +
          "「資料管理 → 設定資料閲覧 → 人物相関図」からお試しください。"
      );
      return;
    }
    await relationGraphOpener(this.work, id);
  }

  /**
   * 資料の読み仮名を、本文のルビとして振る（設計書6.12.5）。
   *
   * **変わるのは原稿のほうである。** 設定資料の画面から押すが、
   * 書き換わるのは本文なので、対象の話も入れ方も、押したあとに選ばせる。
   *
   * 種類をまたいで集める——人物だけでなく、能力や場所の名前にも
   * 読み仮名は入っている。
   */
  private async handleApplyRuby(): Promise<void> {
    const { applySettingsRuby, collectRubyTerms } = await import(
      "./applySettingsRuby.js"
    );
    const terms = collectRubyTerms([
      ...this.characters,
      ...this.abilities,
      ...this.locations,
      ...this.organizations,
    ]);
    await applySettingsRuby(this.work, terms);
  }

  private postDetail(kind: SettingsKind, id: string): void {
    const detail = this.detailOf(kind, id);
    if (!detail) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }
    this.post({ type: "detail", detail });
  }

  /**
   * 食い違いを「作中の変化」として確定させる（設計書6.18）。
   *
   * **値はどちらも消えない。** 判断待ちの印が外れ、変化の記録へ移るだけである。
   * 項目そのものには、いちばん後ろの話に出てきた値を入れ直す
   * （残さないと資料の外見が第1話の姿のままになる）。
   *
   * `autoGenerated` は変えない。作者が触ったのは1項目の読み方であって、
   * レコード全体を引き取ったわけではない。以後の抽出でこの食い違いが
   * 立て直されないことは `characterMerge` 側で担保している。
   */
  private async handlePromoteConflict(
    id: string,
    field: string
  ): Promise<void> {
    const character = this.characters.find((entry) => entry.id === id);
    if (!character) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    const promotion = promoteConflictToChanges(character, field);
    if (!promotion) {
      // 別の窓で先に処理された場合など。読み直して今の状態を見せる
      await this.reloadAfterSave(
        "character",
        id,
        "その食い違いは、すでに記録されています。"
      );
      return;
    }

    await this.persist("character", applyPromotion(character, field, promotion));
    await this.reloadAfterSave(
      "character",
      id,
      `「${field}」を作中の変化として記録しました。`
    );
  }

  private async handleSave(
    kind: SettingsKind,
    id: string,
    edits: Record<string, string>
  ): Promise<void> {
    const record = this.find(kind, id);
    if (!record) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    const updated = this.applyEdits(kind, record, toRecordEdits(edits));
    await this.persist(kind, updated);
    await this.reloadAfterSave(kind, id, "保存しました。");
  }

  private applyEdits(
    kind: SettingsKind,
    record: SettingsRecord,
    edits: RecordEdits,
    options?: EditOptions
  ): SettingsRecord {
    if (kind === "character") {
      return applyCharacterEdits(record as Character, edits, options);
    }
    if (kind === "ability") {
      return applyAbilityEdits(record as Ability, edits, options);
    }
    if (kind === "organization") {
      return applyOrganizationEdits(record as Organization, edits, options);
    }
    if (kind === "world") {
      return applyWorldItemEdits(record as WorldItem, edits, options);
    }
    return applyLocationEdits(record as Location, edits, options);
  }

  private async persist(
    kind: SettingsKind,
    record: SettingsRecord
  ): Promise<void> {
    if (kind === "character") {
      // 既存ファイルは上書きできないため、退避してから作り直す必要がある。
      // save() を直接呼ぶと保存が必ず失敗する
      await this.characterStore.saveOrUpdate(record as Character);
      return;
    }
    if (kind === "ability") {
      await this.abilityStore.saveAll([record as Ability]);
      return;
    }
    if (kind === "organization") {
      await this.organizationStore.saveAll([record as Organization]);
      return;
    }
    if (kind === "world") {
      await this.worldStore.saveAll([record as WorldItem]);
      return;
    }
    await this.locationStore.saveAll([record as Location]);
  }

  /**
   * 保存後は読み直す。
   * ストアが持つハッシュと画面の内容がずれると、
   * 次の保存が「外部で変更された」と誤検出されるため。
   */
  private async reloadAfterSave(
    kind: SettingsKind,
    id: string,
    notice: string
  ): Promise<void> {
    await this.loadAll();
    // 本文の色分け・一覧・操作メニューの印を引き直す。
    // ここを呼ばないと、名前を変えても分けても画面が古いまま残る
    changeObserver?.(this.work);
    const detail = this.detailOf(kind, id);
    this.post({
      type: "saved",
      detail,
      groups: this.groups(),
      workInfo: this.workInfo,
      notice,
    });
  }

  /**
   * 本文を読み直して、各項目に入れる値をAIに提案させる（設計書6.31.1）。
   *
   * 掘り下げ（文章のメモ）と違い、設定資料の項目そのものを埋めるためのもの。
   * **提案は保存しない。** 項目ごとに現在の値と並べて見せ、
   * 作者が選んだものだけを書き込む。
   *
   * 作者は「留意点」を添えられる（「他の登場人物〇〇の情報が混入しています」）。
   * 添えられたときは、この記録のものと確信できる記述だけで書き直させ、
   * 混入と判断された記述は `misattributed` として受け取って行き先を選ばせる。
   * **留意点が空なら、従来の「項目を充実させる」と同じ動きになる。**
   */
  private async handleEnrich(
    kind: SettingsKind,
    id: string,
    notes?: string
  ): Promise<void> {
    const record = this.find(kind, id);
    if (!record) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    // AIで再読込は設定資料の抽出と同じ仕事なので、割当も抽出に揃える
    const resolved = await ensureConfigured(this.registry, "extract");
    if (!resolved) return;

    const excerpts = await this.excerptsFor(kind, record);
    const prompt = buildEnrichPrompt({
      workTitle: this.work.title,
      kind,
      target: {
        kindLabel: KIND_LABELS[kind],
        name: record.name,
        currentSettings: this.describe(kind, record),
      },
      excerpts,
      customFields: this.customFields,
      notes,
    });

    const text = await this.generate(
      "extract",
      prompt,
      `「${record.name}」を読み直しています`,
      buildEnrichSchema(kind, this.customFields)
    );
    if (text === undefined) return;

    const parsed = parseEnrichResult(text);
    if (!parsed) {
      this.post({
        type: "error",
        message:
          "AIの応答をJSONとして解析できませんでした。もう一度試してください。",
      });
      return;
    }

    const current = record as unknown as Record<string, unknown>;
    const proposals: FieldProposal[] = [];
    for (const field of enrichableFields(kind, this.customFields)) {
      const proposed = clampField(field, parsed[field.key]);
      if (!proposed) continue;
      // 追加項目の値は customFields の中にある
      const before = field.custom
        ? (record as Character).customFields[field.key] ?? ""
        : asText(current[field.key]);
      if (before === proposed) continue;
      proposals.push({
        // 反映するときに、既定の項目と同じ経路で書き戻せるようにする
        key: field.custom ? `${CUSTOM_FIELD_PREFIX}${field.key}` : field.key,
        label: field.label,
        before,
        after: proposed,
        multiline: field.multiline === true,
        // 空欄を埋める提案だけを既定で選ぶ。
        // 作者が書いた内容の置き換えは、必ず自分で選んでもらう
        selected: before.length === 0,
      });
    }

    const misattributed = this.buildMisattributed(
      kind,
      parsed[MISATTRIBUTED_KEY],
      excerpts
    );

    if (proposals.length === 0 && misattributed.items.length === 0) {
      this.post({
        type: "error",
        message:
          "本文から新しく書ける内容は見つかりませんでした。抜粋の範囲に手掛かりが無いようです。" +
          misattributed.droppedNotice,
      });
      return;
    }

    // 行き先を選ぶときに、画面から送られてきた値ではなく
    // こちら側の控えを使う。AIの返した文字列が往復するほど、
    // どこで変わったのか分からなくなる
    this.misattributed = misattributed.items;
    this.misattributedKind = kind;

    this.post({
      type: "proposal",
      kind,
      id,
      proposals,
      model: resolved.model,
      misattributed: this.misattributedViews(kind, misattributed.items),
      // 行き先を選べるのは人物だけ。belongsTo は人物の呼び名を前提にしており、
      // 場所や能力の項目（region・cost など）は人物レコードに置き場所が無い
      placeable: kind === "character",
      notice: misattributed.droppedNotice,
    });
  }

  /**
   * はじいた記述を読む（設計書6.31.2）。
   *
   * **照合はここで済ませる。** 本文に無い引用や、設定資料に無い項目名を
   * 抱えたまま画面へ出すと、作者が押した先で初めて失敗することになる。
   * 落としたものは黙って消さず、件数を通知に添える。
   */
  private buildMisattributed(
    kind: SettingsKind,
    raw: unknown,
    excerpts: MentionExcerpt[]
  ): { items: MisattributedValue[]; droppedNotice: string } {
    const allowed = enrichableFields(kind, this.customFields)
      .map((field) => field.key)
      // 行き先は人物レコードなので、人物が持たない項目は置けない。
      // 場所の「地域」を人物へ入れる道を作らない
      .filter((key) => kind !== "character" || isCharacterTextField(key));

    const parsed = parseMisattributedValues(
      raw,
      excerpts.map((excerpt) => excerpt.text).join("\n"),
      allowed
    );

    const dropped = droppedTotal(parsed.dropped);
    if (dropped > 0) {
      // 画面には件数しか出さないので、内訳はログへ残す。
      // 残さないと、照合が厳しすぎるのかAIが外しているのか分からない
      logFailure("再読込ではじいた記述のうち、採らなかったもの", {
        本文と照合できず: parsed.dropped.ungrounded,
        設定資料に無い項目: parsed.dropped.unknownField,
        中身の無い値: parsed.dropped.emptyValue,
        形が違う: parsed.dropped.malformed,
      });
    }

    return {
      items: parsed.entries,
      droppedNotice:
        dropped === 0
          ? ""
          : `（本文と照合できなかった${dropped}件は除きました。内訳はログを参照）`,
    };
  }

  /**
   * 画面へ出す形にする。**行き先の照合はここで行う**（AIには決めさせない）。
   *
   * 項目名は作者が見て分かる見出しに直す。`personality` とだけ出しても、
   * それが「性格」の欄だとは分からない。
   */
  private misattributedViews(
    kind: SettingsKind,
    entries: MisattributedValue[]
  ): MisattributedView[] {
    const labels = new Map(
      enrichableFields(kind, this.customFields).map((field) => [
        field.key,
        field.label,
      ])
    );
    return entries.map((entry, index) => ({
      index,
      belongsTo: entry.belongsTo,
      fieldLabel: labels.get(entry.field) ?? entry.field,
      value: entry.value,
      evidence: entry.evidence,
      destination: resolveMisattributedDestination(
        entry.belongsTo,
        this.characters
      ),
    }));
  }

  /**
   * はじいた記述の行き先を作者が選んだ（設計書6.31.2）。
   *
   * **押されるまで何も書かない。** ここが、はじいた情報が
   * 実際にファイルへ入る唯一の場所である。
   */
  private async handlePlaceMisattributed(
    message: PlaceMisattributedMessage
  ): Promise<void> {
    const entry = this.misattributed[message.index];
    if (!entry) {
      this.post({
        type: "error",
        message: "はじいた記述が見つかりません。もう一度読み直してください。",
      });
      return;
    }
    // 画面側でもボタンを出していないが、古い画面から届くことがある。
    // 書き込む側で必ず確かめる（人物以外は行き先を決められない）
    if (this.misattributedKind !== "character") {
      this.post({
        type: "error",
        message:
          "はじいた情報の行き先を選べるのは、登場人物の再読込だけです。",
      });
      return;
    }

    const destination = resolveMisattributedDestination(
      entry.belongsTo,
      this.characters
    );

    try {
      const notice =
        destination.kind === "existing"
          ? await this.insertIntoExisting(destination, entry)
          : await this.createFromMisattributed(destination.name, entry);

      await this.loadAll();
      // 一覧・本文の色分け・操作メニューの印を引き直す。
      // 新しい人物が増えたことが、他の画面にも伝わらないと分からない
      changeObserver?.(this.work);
      this.post({
        type: "misattributedPlaced",
        index: message.index,
        ok: true,
        message: notice,
        groups: this.groups(),
        // 行き先を引き直して送る。**新しく起こした人物へ、
        // 同じ相手の2件目が「新しいレコードを起こす」で入ると、
        // 同じ名前の記録が2つできる**
        misattributed: this.misattributedViews(
          "character",
          this.misattributed
        ),
      });
    } catch (error) {
      this.post({
        type: "misattributedPlaced",
        index: message.index,
        ok: false,
        message: describeError(error),
        groups: this.groups(),
      });
    }
  }

  /** 既存の人物へ入れる。上書きはせず、食い違えば作者の判断待ちにする */
  private async insertIntoExisting(
    destination: MisattributedDestination & { kind: "existing" },
    entry: MisattributedValue
  ): Promise<string> {
    const target = this.characters.find(
      (character) => character.id === destination.id
    );
    if (!target) {
      throw new Error(
        `「${destination.name}」が見つかりません。別の窓で取り下げられたのかもしれません。`
      );
    }

    const result = insertMisattributedValue(target, entry);
    if (!result.changed) {
      return `「${destination.name}」には、同じ内容が既に入っていました。`;
    }

    await this.characterStore.saveOrUpdate(result.character);
    if (result.conflicted) {
      // 上書きしなかったことを、はっきり伝える。
      // 「入れた」とだけ出すと、作者は元の値が消えたと読む
      return (
        `「${destination.name}」には既に別の値があったので、上書きせず` +
        "「変化かもしれない」として残しました。参考の欄で選べます。"
      );
    }
    return `「${destination.name}」の空いていた項目へ入れました。`;
  }

  /** 行き先が見つからないときに、その値だけを持つ人物を起こす */
  private async createFromMisattributed(
    name: string,
    entry: MisattributedValue
  ): Promise<string> {
    const created = planMisattributedRecord(entry, this.characters);
    await this.characterStore.saveOrUpdate(created);
    return (
      `「${created.name}」を新しく起こしました。中身はこの1項目だけなので、` +
      "「設定資料を抽出」をもう一度実行すると本文から入ります。"
    );
  }

  /** 作者が選んだ項目だけを書き込む */
  private async handleApplyProposal(
    message: ApplyProposalMessage
  ): Promise<void> {
    const record = this.find(message.kind, message.id);
    if (!record) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    const edits = toRecordEdits(message.values);

    // AIの提案を採用しただけなので、作者が確定させた記述としては扱わない。
    // 作者確定にすると、その人物は以後の抽出から締め出されてしまう
    const updated = this.applyEdits(message.kind, record, edits, {
      authorConfirmed: false,
    });
    await this.persist(message.kind, updated);
    await this.reloadAfterSave(
      message.kind,
      message.id,
      `${Object.keys(message.values).length} 項目を反映しました。` +
        "この内容は以後の抽出で更新されることがあります。"
    );
  }

  private async handleChat(
    kind: SettingsKind,
    id: string,
    question: string
  ): Promise<void> {
    const record = this.find(kind, id);
    if (!record) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    const resolved = await ensureConfigured(this.registry, "chat");
    if (!resolved) return;

    const key = `${kind}:${id}`;
    const history = this.chatHistory.get(key) ?? [];
    // 質問を渡す。渡さないと、どの質問でも同じ場面が集まってしまう
    const excerpts = await this.excerptsFor(kind, record, question);
    const started = Date.now();

    const prompt = buildSettingsChatPrompt({
      workTitle: this.work.title,
      target: {
        kindLabel: KIND_LABELS[kind],
        name: record.name,
        currentSettings: this.describe(kind, record),
      },
      question,
      excerpts,
      history,
    });

    const text = await this.generate(
      "chat",
      prompt,
      `「${record.name}」について調べています`
    );
    if (text === undefined) return;

    appendChatLog(this.work, {
      panel: "設定資料パネル",
      provider: resolved.provider.displayName,
      model: resolved.model,
      paid: resolved.provider.isPaid,
      target: `${KIND_LABELS[kind]}: ${record.name}`,
      // 検索語はここでも作っている。何で引いたかが分からないと、
      // 外した場面が渡ったときに原因を追えない
      searchTerms: this.lastSearchTerms,
      materials: summarizeMaterials(excerpts),
      question,
      reply: text,
      elapsedMs: Date.now() - started,
    });

    this.chatHistory.set(key, [
      ...history,
      { role: "author", text: question },
      { role: "assistant", text },
    ]);
    // AIはMarkdownで返してくる。記号のまま見せないよう整形して渡す
    this.post({
      type: "chatAnswer",
      text,
      html: renderMarkdownLite(text),
      question,
      model: resolved.model,
    });
  }

  private async handleApproveNote(message: ApproveNoteMessage): Promise<void> {
    const record = this.find(message.kind, message.id);
    if (!record) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    // 掘り下げメモは相談から出てきたものなので、どのAIが書いたかも相談の割当で見る
    const resolved = this.registry.resolve("chat");
    const updated = appendAiNote(record, {
      topic: message.topic,
      text: message.text,
      model: resolved?.model ?? "",
      source: message.source,
    });
    await this.persist(message.kind, updated as SettingsRecord);
    await this.reloadAfterSave(message.kind, message.id, "掘り下げを追記しました。");
  }

  private async handleDeleteNote(
    kind: SettingsKind,
    id: string,
    noteId: string
  ): Promise<void> {
    const record = this.find(kind, id);
    if (!record) return;
    const updated = removeAiNote(record, noteId);
    await this.persist(kind, updated as SettingsRecord);
    await this.reloadAfterSave(kind, id, "掘り下げを削除しました。");
  }

  /**
   * レコードを取り下げる。
   *
   * AIの抽出は誤ったレコードを作る。実データに、名前が文字列の「null」に
   * なった組織ができていた（2026-08-16、作者が指摘）。それまでパネルには
   * 消す手段が無く、ファイルを直接消してくださいと案内するしかなかった。
   *
   * **消さずに退避する。** 消し間違いは取り返しがつかない。
   * 実体は `.novelai-recovery` に残り、拡張子を `.json` へ戻して
   * 設定フォルダへ置けば復活する。
   *
   * **作者が書いたレコードは、確認の文面を変える。** `autoGenerated: false`
   * は作者が手を入れたもので、AIが作った抜け殻とは重みが違う。
   */
  private async handleRetire(kind: SettingsKind, id: string): Promise<void> {
    const record = this.find(kind, id);
    if (!record) {
      this.post({ type: "error", message: "選択した設定が見つかりません。" });
      return;
    }

    const label = KIND_LABELS[kind];
    const authored = record.autoGenerated === false;
    const answer = await vscode.window.showWarningMessage(
      `${label}「${record.name}」を取り下げますか？`,
      {
        modal: true,
        detail: authored
          ? "この記録には作者の手が入っています（自動生成ではありません）。ファイルは消さず回復用の場所へ移しますが、一覧からは消えます。"
          : "ファイルは消さず、回復用の場所（.novelai-recovery）へ移します。あとから戻せます。",
      },
      "取り下げる"
    );
    if (answer !== "取り下げる") return;

    const recoveryPath = await this.retireFromStore(kind, id);

    await this.loadAll();
    changeObserver?.(this.work);
    this.post({
      type: "saved",
      // 消したものは開けない。詳細は空にして一覧へ戻す
      detail: undefined,
      groups: this.groups(),
      workInfo: this.workInfo,
      notice: `「${record.name}」を取り下げました。実体は ${path.basename(
        recoveryPath
      )} として回復用の場所に残っています。`,
    });
  }

  /**
   * 1つにまとめられた人物を、別人に分ける（設計書6.5.8）。
   *
   * 作者の指摘（2026-08-27）：「アジャンとアジャーノが同一人物として
   * 認識されている作品があります」。まとめる操作（`unifyCharacters`）は
   * あったが、逆向きが無かった。
   *
   * ## 書く順番を守る。**新しいほうが先**
   *
   * 逆にすると、途中で失敗したときに別名がどちらからも消える
   * ——用語ハイライトもIME辞書も、その呼び方を拾わなくなる。
   * この順なら失敗しても「別名が両方にある」だけで、**何も失われない。**
   */
  private async handleSeparate(
    kind: SettingsKind,
    id: string,
    alias: string
  ): Promise<void> {
    if (kind !== "character") return;
    const record = this.find(kind, id) as Character | undefined;
    if (!record) {
      this.post({ type: "error", message: "選択した人物が見つかりません。" });
      return;
    }

    let plan: SeparationPlan;
    try {
      plan = planCharacterSeparation(record, alias, this.characters);
    } catch (error) {
      this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const moved = plan.movedAliases.map((entry) => `「${entry}」`).join("");
    // 確認は拡張機能側で出す。WebViewの confirm は使えない（6.5.5と同じ）
    const KEEP = "分ける（この記録はAIに書き換えさせない）";
    const PLAIN = "分ける";
    const answer = await vscode.window.showWarningMessage(
      `「${alias}」を、別の人物として分けますか？`,
      {
        modal: true,
        detail:
          `・「${alias}」という名前だけの人物ができます\n` +
          `・「${record.name}」の別名から ${moved} が外れます\n` +
          `・紹介・役割・性格・登場話・変化の記録は「${record.name}」に残ります（移しません）\n` +
          "・この2人は別人だと覚えるので、次の抽出でまとめ直されません\n" +
          `・書き換える前に「${record.name}」の控えを取ります（あとから戻せます）\n\n` +
          "新しい人物の中身は空です。「設定資料を抽出」をもう一度実行すると本文から入ります。" +
          "前と同じAI・同じモデルなら、AIは呼ばれません。",
      },
      KEEP,
      PLAIN
    );
    if (answer !== KEEP && answer !== PLAIN) return;

    // 作者がその場で選ぶ。立てると、以後の抽出は登場話数しか足さなくなる
    const original =
      answer === KEEP ? { ...plan.original, autoGenerated: false } : plan.original;

    try {
      // **新しいほうが先**（上の説明を参照）
      await this.characterStore.saveOrUpdate(plan.created);
      await this.characterStore.saveOrUpdate(original);
    } catch (error) {
      this.post({
        type: "error",
        message: `分けられませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    // 承認待ちの更新案は、レコード丸ごとの写しである。
    // 残すと、あとで反映したときに別名も別人の記録も巻き戻る。しかも
    // `characterDiff.ts` は distinctFrom を見ないので**差分に出ない**
    // ＝作者に見えないまま戻る。提案は再抽出で作り直せる
    await this.discardPendingFor(record.id);

    await this.reloadAfterSave(
      kind,
      id,
      `「${alias}」を別の人物として分けました。中身は空なので、` +
        "「設定資料を抽出」をもう一度実行すると本文から入ります。"
    );
  }

  /** 分けた人物の更新案を片づける。読めない・無いときは何もしない */
  private async discardPendingFor(characterId: string): Promise<void> {
    try {
      const store = new PendingUpdateStore(this.work);
      const { updates } = await store.loadAll();
      for (const update of updates) {
        if (update.character.id === characterId) {
          await store.discard(update.filePath);
        }
      }
    } catch {
      // 片づけに失敗しても、分けたこと自体は成立している。
      // ここで止めると作者は「失敗した」と読んで、もう一度押してしまう
    }
  }

  private async retireFromStore(
    kind: SettingsKind,
    id: string
  ): Promise<string> {
    if (kind === "character") return this.characterStore.retire(id);
    if (kind === "ability") return this.abilityStore.retire(id);
    if (kind === "organization") return this.organizationStore.retire(id);
    if (kind === "world") return this.worldStore.retire(id);
    return this.locationStore.retire(id);
  }

  private describe(
    kind: SettingsKind,
    record: SettingsRecord
  ): string {
    if (kind === "character") {
      return describeCharacter(record as Character, this.customFields);
    }
    if (kind === "ability") {
      return describeAbility(record as Ability, this.abilitySystem);
    }
    if (kind === "organization") {
      const organization = record as Organization;
      return describeOrganization(
        organization,
        membersOf(organization, this.characters)
      );
    }
    if (kind === "world") return describeWorldItem(record as WorldItem);
    return describeLocation(record as Location);
  }

  /**
   * その設定について聞かれたことに近い場面を集める。
   *
   * **質問文を検索に使う。** 以前は名前が出てくる場面を集めて作品全体から
   * 均等に間引くだけで、質問はいっさい使っていなかった。実データ
   * （978回登場する人物）で測ると、名前を含む場面733件のうち渡していたのは
   * 30件（4.1%）で、しかもどの質問でも中身が同じだった。
   * 「答えの語が渡した12,000字に入っているか」で数えて1/5しか当たっていない。
   *
   * 質問で並べ替えると3/5、質問を検索語へ直してから意味検索と語句一致を
   * 半々で詰めると5/5になった。
   *
   * 質問が無い場面（項目の充実）では、埋めたい項目名を手掛かりにする。
   */
  private async excerptsFor(
    kind: SettingsKind,
    record: SettingsRecord,
    question?: string
  ): Promise<MentionExcerpt[]> {
    const searched = await this.searchExcerpts(kind, record, question);
    if (searched) return searched;
    return this.evenlySampledExcerpts(kind, record);
  }

  /**
   * 質問に近い場面を検索で集める。
   *
   * 検索の材料が用意できないとき（本文が読めないなど）は undefined を返し、
   * 呼び出し側が従来のやり方へ落ちる。**相談そのものは止めない。**
   */
  private async searchExcerpts(
    kind: SettingsKind,
    record: SettingsRecord,
    question?: string
  ): Promise<MentionExcerpt[] | undefined> {
    const hint = question?.trim() || this.enrichHint(kind);
    if (!hint) return undefined;

    try {
      if (!this.retrieval) {
        this.retrieval = await withCancellableProgress(
          "本文を読み込んでいます",
          async () => prepareRetrieval(this.work)
        );
        if (this.retrieval.conflicted.length > 0) {
          this.post({
            type: "error",
            message: `未解決の競合があるファイルは参照していません（${this.retrieval.conflicted.join(
              "、"
            )}）。`,
          });
        }
      }

      const names = searchTermsFor(kind, record);
      const terms = await this.expandSearchTerms(hint, record.name);
      const query = buildSearchQuery(hint, terms, record.name);

      const found = await search(this.retrieval, query, {
        maxChars: EXCERPT_MAX_CHARS,
        // その設定が出てくる材料に限る。相談の対象が決まっているため
        mustInclude: names,
      });
      if (found.length === 0) return undefined;

      return found.map((candidate) => ({
        label: `${candidate.item.source}・${candidate.item.label}`,
        text: candidate.item.text,
      }));
    } catch (error) {
      logFailure("設定資料パネルの検索に失敗（従来のやり方で続行）", {
        理由: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 質問を検索語へ直す。
   *
   * 実データで、この段が無いと「妬ましさを感じる場面」が30位以内に
   * 入らなかった。「嫉妬」へ直せば1〜2位で出る。
   * **失敗しても質問文そのままで検索する**（今より悪くはならない）。
   */
  private async expandSearchTerms(
    question: string,
    focus: string
  ): Promise<string[]> {
    try {
      // 検索語づくりは相談1回に付随する下ごしらえなので、相談の割当に従う
      const resolved = this.registry.resolve("chat");
      if (!resolved) return [];
      const result = await resolved.provider.generate({
        systemPrompt: SEARCH_TERMS_SYSTEM_PROMPT,
        userPrompt: buildSearchTermsPrompt({
          question,
          focus,
          knownTerms: this.characters.map((character) => character.name),
        }),
        model: resolved.model,
        temperature: 0.2,
        jsonSchema: SEARCH_TERMS_SCHEMA,
        disableThinking: true,
        // 相談1回につき、これがもう1回ぶんの呼び出しになる（P-22）。
        // 本体と分けて数えないと、相談の重さを見誤る
        meta: { feature: "search_terms", workFolder: this.work.folderPath },
      });
      this.lastSearchTerms = parseSearchTerms(result.text);
      return this.lastSearchTerms;
    } catch (error) {
      logFailure("検索語の作成に失敗（質問文のまま検索）", {
        理由: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** 項目の充実では質問が無いので、埋めたい項目名を手掛かりにする */
  private enrichHint(kind: SettingsKind): string {
    return enrichableFields(kind, this.customFields)
      .map((field) => field.label)
      .join(" ");
  }

  /** 従来のやり方。名前が出てくる場面を作品全体から均等に間引く */
  private async evenlySampledExcerpts(
    kind: SettingsKind,
    record: SettingsRecord
  ): Promise<MentionExcerpt[]> {
    if (!this.excerptSources) {
      const loaded = await withCancellableProgress(
        "本文を読み込んでいます",
        async () => loadExcerptSources(this.work)
      );
      this.excerptSources = loaded.sources;
      if (loaded.conflicted.length > 0) {
        this.post({
          type: "error",
          message: `未解決の競合があるファイルは参照していません（${loaded.conflicted.join(
            "、"
          )}）。`,
        });
      }
    }
    // フルネームで登録されていても、本文には片方しか出てこないことが多い。
    // 広げないと、その人物の場面がほとんど集まらない
    return collectMentionExcerpts(
      this.excerptSources,
      searchTermsFor(kind, record)
    );
  }

  /**
   * AIを1回呼ぶ。失敗したら理由と次の操作を画面に出す。
   *
   * **機能キーは呼び出し側が渡す。** この画面からは性質の違う2つが走る
   * （相談＝`chat`、AIで再読込＝`extract`）ので、どちらで呼ばれたかを
   * ここで推し量らない。
   */
  private async generate(
    feature: AssignableFeature,
    prompt: string,
    progressLabel: string,
    jsonSchema?: object
  ): Promise<string | undefined> {
    const resolved = await ensureConfigured(this.registry, feature);
    if (!resolved) return undefined;

    // 有料のAIは呼ぶたびに課金される。**このパネルを開いている間に一度だけ
    // 確認を取る。** 相談も項目の充実も何度も押すものなので、毎回モーダルを
    // 挟むと使い物にならない。**プロバイダとモデルの両方**を覚えるのは、
    // AIを切り替えたときに確認をやり直すため（無料から有料へ黙って移らない）。
    // 機能ごとの割当を入れてからは、Ollama と LM Studio が同じモデル名を
    // 持てるので、モデル名だけでは切り替わりを見落とす
    const paidKey = `${resolved.provider.id}:${resolved.model}`;
    if (resolved.provider.isPaid && this.paidConfirmedFor !== paidKey) {
      const ok = await confirmPaidUsage(resolved.provider, {
        actionLabel: progressLabel,
        model: resolved.model,
        detail:
          "この画面でAIを呼ぶたびに課金されます。\n" +
          "（この確認はこの画面で一度だけです）",
      });
      if (!ok) return undefined;
      this.paidConfirmedFor = paidKey;
    }

    // **本文以外の量を見込まない**（設計書6.27.10）。以前は「本文の抜粋
    // ＋固定12,000字」で必要量を出していたが、固定費は指示・資料の改訂で
    // 育つので、見込みは必ず追い越される。組み上がったプロンプトの実測から
    // 決める道（`contextSizeForPrompt`）へ揃え、出力の見込みだけを渡す。
    // 作者が `ollama.numCtx` を明示していれば、その指定を尊重する
    const configuredNumCtx = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("ollama.numCtx", 0);
    const numCtx = configuredNumCtx > 0 ? configuredNumCtx : undefined;
    const maxOutputTokens = resolveMaxOutputTokens();

    this.setBusy(true, progressLabel);
    try {
      const result = await withCancellableProgress(
        progressLabel,
        async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return resolved.provider.generate({
            systemPrompt: SETTINGS_ASSISTANT_SYSTEM_PROMPT,
            userPrompt: prompt,
            model: resolved.model,
            // 掘り下げは多少ふくらみがあってよい。抽出（0.2）より少し高くする。
            // 項目の提案は設定として書くので、控えめにする
            temperature: jsonSchema ? 0.3 : 0.5,
            numCtx,
            maxOutputTokens,
            jsonSchema,
            disableThinking: true,
            signal: controller.signal,
            meta: {
              // スキーマの有無が、そのまま用途の違いになっている
              // （相談は自由文、項目の充実はJSON）
              feature: jsonSchema ? "settings_enrich" : "settings_chat",
              workFolder: this.work.folderPath,
            },
          });
        }
      );

      if (result.truncated) {
        this.post({
          type: "error",
          message:
            "AIの応答が出力上限で切り詰められました。観点を絞って、もう一度試してください。",
        });
        return undefined;
      }
      const text = result.text.trim();
      if (!text) {
        this.post({
          type: "error",
          message: "AIの応答が空でした。モデル設定を確認してください。",
        });
        return undefined;
      }
      return text;
    } catch (error) {
      this.post({
        type: "error",
        message: describeError(error, {
          provider: resolved.provider.displayName,
          model: resolved.model,
        }),
      });
      return undefined;
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean, label = ""): void {
    this.post({ type: "busy", busy, label });
  }

  private post(message: OutgoingMessage): void {
    void this.panel.webview.postMessage(message);
  }
}

function field(
  key: keyof RecordEdits,
  label: string,
  value: string | null,
  multiline = false
): DetailField {
  return { key, label, value: value ?? "", multiline };
}

/**
 * 名前の欄。**別名を候補に出す**（設計書6.5.6）。
 *
 * 選んで保存すると、元の名前は別名へ移る（`swapNameWithAlias`）。
 * **元の名前は消えない**——消すと本文の照合から外れ、用語ハイライトも
 * IME辞書も、その呼び方を拾わなくなる。
 *
 * ## 別名が無くても、名前は変えられる
 *
 * 作者から「名前が変更できません」「ドロップダウンが出ない」と言われた
 * （2026-08-24、設計書6.5.7）。別名が1つも無い人物では候補が出ないため、
 * **欄そのものが編集できないように見えていた。** ここは元から手で書ける。
 * **候補の有無にかかわらず、次に何をすればよいかを欄の下に書く。**
 */
function nameField(
  value: string,
  aliases: readonly string[],
  label = "名前"
): DetailField {
  const suggestions = aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias && alias !== value.trim());
  return {
    key: "name",
    label,
    value,
    multiline: false,
    suggestions,
    hint:
      suggestions.length > 0
        ? "直接書き換えられます。別名を選ぶと、いまの名前は別名へ移ります（消えません）。変更したら下の「保存」を押してください。"
        : "直接書き換えられます。変更したら下の「保存」を押してください。別名を登録すると、ここから選べるようになります。",
  };
}

/**
 * 入・切だけの項目。
 * 画面との受け渡しは他の項目と同じ文字列にそろえ、
 * 入を "1"、切を空文字で表す（保存の経路を分けない）。
 */
function checkField(
  key: keyof RecordEdits,
  label: string,
  on: boolean
): DetailField {
  return { key, label, value: on ? "1" : "", multiline: false, check: true };
}

/**
 * 本文から場面を集めるときの検索語。
 *
 * **世界観だけは名前で引けない。** 見出し（「詠唱の制約」）は
 * こちらが付けた言葉で、本文には出てこない。名前だけで引くと
 * 場面が1つも集まらず、相談も項目の充実も材料なしで動くことになる。
 * 逐語引用である evidence を手掛かりにする。
 */
export function searchTermsFor(
  kind: SettingsKind,
  record: { name: string; aliases: string[]; evidence?: string | null }
): string[] {
  const names = expandNameVariants([record.name, ...record.aliases]);
  if (kind !== "world") return names;
  return [...names, ...evidencePhrases(record.evidence)];
}

/** 決まった値から選ぶ項目 */
function choiceField(
  key: keyof RecordEdits,
  label: string,
  value: string,
  choices: Array<{ value: string; label: string }>
): DetailField {
  return { key, label, value, multiline: false, choices };
}

/** 作者が足した項目の入力欄 */
function customFieldControls(
  character: Character,
  definitions: CustomFieldDefinition[]
): DetailField[] {
  return definitions.map((definition) => ({
    key: `${CUSTOM_FIELD_PREFIX}${definition.key}`,
    label: definition.label,
    value: character.customFields[definition.key] ?? "",
    multiline: definition.multiline,
  }));
}

/**
 * 画面のいちばん下へ回す参考情報。
 *
 * **食い違いも抽出根拠も、名前の直下から下げた。**
 * どちらも作者が毎回読むものではないのに量が多く、
 * 上に置くと編集欄が画面の外へ押し出される（実際に読みにくいと指摘があった）。
 * 消さずに残すのは、食い違いが作者の判断待ちであり、
 * 抽出根拠が「AIがどこを見てそう書いたか」を確かめる唯一の手掛かりだからである。
 *
 * 食い違いを先に置くのは、こちらだけが作者の操作を待っているため。
 *
 * 「食い違い」ではなく「変化かもしれない」と書くのは、
 * 小説では登場人物が作中で変わるからである。AIの取り違えと
 * 作中での変化を区別できるよう、値を話数と並べて出す。
 */
function referenceLines(
  conflicts: RecordConflict[],
  evidence: string | null,
  /**
   * 変化の記録。**今は人物だけが持つ。**
   * 渡されたときだけ「作中の変化」ボタンを出す（他の種別では押せても
   * 保存先が無い）。空配列と「持っていない」を区別するため省略可能にしてある。
   */
  changes?: RecordChange[],
  /**
   * 登場話。関与度の計算に使う（変化した後の姿が続いているか）。
   * 人物だけが変化を持つので、変化と一緒にしか渡らない
   */
  appearedChapters: readonly number[] = []
): DetailView["reference"] {
  return [
    // 確定した変化を、判断待ちより先に置く。事実として読んでよいものと
    // 疑いの残るものを混ぜない。
    //
    // **関与度を添える**（`changeSignificance.ts`）。AIへ渡す材料と同じ数字を
    // 同じ書き方で出す。紹介に何が書かれ、何が書かれなかったのかを
    // 作者がここで確かめられるようにするためである
    ...scoreChanges(changes ?? [], appearedChapters).map((significance) => ({
      label: `変化（${significance.field}）`,
      value: `${describeChangeValues(
        changesOfField(changes ?? [], significance.field)
      )}［${describeInvolvement(significance)}］`,
    })),
    ...conflicts.map((conflict) => ({
      label: `変化かもしれない（${conflict.field}）`,
      value: [describeConflictValues(conflict), conflict.note ?? ""]
        .filter((part) => part)
        .join(" — "),
      ...(changes
        ? { action: { label: "作中の変化として記録", field: conflict.field } }
        : {}),
    })),
    { label: "抽出根拠", value: evidence ?? "" },
  ].filter((entry) => entry.value);
}

/** AIの応答をJSONとして読む。前後に余計な文字が付くことがある */
function parseEnrichResult(
  text: string
): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 提案された値を、長さの制限まで含めて整える */
function clampField(field: EnrichableField, value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  // AIは「不明」「なし」「（本文から読み取れる記述なし）」を値として返してくる。
  // 判定は抽出側と共有する（片方だけ直しても、もう片方から入り込む）
  if (!isMeaningfulValue(text)) return "";
  // 材料に付けた［関与度 …］を、そのまま値へ書き写してくることがある。
  // 指示語が答えの中身として返るのは、この作品で繰り返し起きている
  // （`placeholderText.ts`）。資料へ載る手前で落とす
  const body = stripInvolvementNote(text);
  if (!body) return "";
  return field.maxChars ? (clampSummary(body, field.maxChars) ?? "") : body;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function describeError(
  error: unknown,
  /** どのAIのどのモデルで起きたか。切り替え後に前のAIの失敗と取り違えないため */
  used?: { provider: string; model: string }
): string {
  if (error instanceof AIError) {
    // 画面には出さない技術的な内容をログへ残す
    logFailure("設定資料パネルでのAI呼び出しの失敗", {
      使用中のAI: used ? `${used.provider} / ${used.model}` : "不明",
      種別: error.kind,
      詳細: error.detail,
    });
    // 残高不足は原因がはっきりしているので、そのまま伝える。
    // 「AI処理に失敗しました」だけでは何をすればよいか分からない
    if (error.kind === "insufficient_credit") return error.message;
    return `AI処理に失敗しました。${recoveryForAIError(error)}（詳細はログを参照）`;
  }
  if (error instanceof SettingsEditError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export interface FieldProposal {
  key: string;
  label: string;
  before: string;
  after: string;
  multiline: boolean;
  /** 既定で選ばれているか。空欄を埋める提案だけを既定にする */
  selected: boolean;
}

/** 画面に出す、はじいた記述1件（設計書6.31.2） */
export interface MisattributedView {
  /** 拡張機能側が持つ控えの位置。書き込む中身はこちらで引く */
  index: number;
  belongsTo: string;
  /** 作者が見て分かる項目名（`personality` ではなく「性格」） */
  fieldLabel: string;
  value: string;
  evidence: string;
  /** 行き先。既存レコードに当たったか、新しく起こすか */
  destination: MisattributedDestination;
}

interface ApplyProposalMessage {
  type: "applyProposal";
  kind: SettingsKind;
  id: string;
  /** 作者が選んだ項目だけ */
  values: Record<string, string>;
}

interface PlaceMisattributedMessage {
  type: "placeMisattributed";
  /** はじいた記述の位置。中身は拡張機能側の控えから引く */
  index: number;
}

type PanelMessage =
  | { type: "ready" }
  /** 留意点は自由記載。空のときは従来の「項目の充実」として動く */
  | { type: "enrich"; kind: SettingsKind; id: string; notes?: string }
  | ApplyProposalMessage
  | PlaceMisattributedMessage
  | { type: "select"; kind: SettingsKind; id: string }
  | {
      type: "save";
      kind: SettingsKind;
      id: string;
      /** 画面から来る生のキー。`custom:` 付きが混ざる */
      edits: Record<string, string>;
    }
  | ApproveNoteMessage
  | { type: "deleteNote"; kind: SettingsKind; id: string; noteId: string }
  | { type: "chat"; kind: SettingsKind; id: string; question: string }
  | { type: "retire"; kind: SettingsKind; id: string }
  /** 1つにまとめられた人物を、別人に分ける（設計書6.5.8） */
  | { type: "separate"; kind: SettingsKind; id: string; alias: string }
  /** 資料の読み仮名を、本文のルビとして振る（設計書6.12.5） */
  | { type: "applyRuby" }
  /** その人物を中心にした人物相関図を開く（設計書6.38.3） */
  | { type: "relationGraph"; kind: SettingsKind; id: string }
  | {
      type: "promoteConflict";
      kind: SettingsKind;
      id: string;
      /** どの項目の食い違いを変化として確定させるか */
      field: string;
    };

interface ApproveNoteMessage {
  type: "approveNote";
  kind: SettingsKind;
  id: string;
  topic: string;
  text: string;
  source: AiNoteSource;
}

/**
 * 作品全体の資料。人物などのレコードとは違い、読むだけの区画。
 */
export interface WorkInfoView {
  blurb: string;
  catchphrase: string;
  episodes: Array<{ label: string; synopsis: string }>;
}

type OutgoingMessage =
  | {
      type: "init";
      groups: Record<SettingsKind, SettingsListItem[]>;
      workInfo: WorkInfoView;
      notice: string;
    }
  | { type: "detail"; detail: DetailView }
  | {
      type: "focus";
      kind: SettingsKind;
      id: string;
      detail: DetailView;
      /**
       * 留意点の入力欄へ映す文章（設計書6.31.3）。
       * 相談から開いたときだけ入る。無ければ空にする
       */
      notes?: string;
      /**
       * 一覧を畳んで出す（作者の依頼、2026-08-28）。
       *
       * **本文の用語から開いたときだけ付ける。** 本文の隣へ並べる資料なので、
       * 狭い幅を一覧に取られると肝心の中身が読めない。メニューなど
       * ほかの入口から開いたときは、これまでどおり一覧から選ぶ。
       */
      collapseList?: boolean;
    }
  | {
      type: "saved";
      detail: DetailView | undefined;
      groups: Record<SettingsKind, SettingsListItem[]>;
      workInfo: WorkInfoView;
      notice: string;
    }
  | {
      type: "proposal";
      kind: SettingsKind;
      id: string;
      proposals: FieldProposal[];
      model: string;
      /** はじいた記述。無ければ空配列 */
      misattributed: MisattributedView[];
      /** 行き先を選べるか（人物だけ）。false なら読むだけで出す */
      placeable: boolean;
      /** 照合で除いた件数の断り。無ければ空文字 */
      notice: string;
    }
  | {
      type: "misattributedPlaced";
      index: number;
      ok: boolean;
      message: string;
      /** 人物が増えることがあるので、一覧も一緒に送る */
      groups: Record<SettingsKind, SettingsListItem[]>;
      /** 行き先を引き直したもの。失敗したときは送らない */
      misattributed?: MisattributedView[];
    }
  | {
      type: "chatAnswer";
      text: string;
      html: string;
      question: string;
      model: string;
    }
  | { type: "busy"; busy: boolean; label: string }
  | { type: "error"; message: string };
