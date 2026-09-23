export const workspace = {
  fs: {} as Record<string, (...args: never[]) => unknown>,
  textDocuments: [] as Array<{
    uri: { fsPath: string };
    isDirty: boolean;
    getText(): string;
    save?(): Promise<boolean>;
  }>,
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  }),
  /**
   * 文書への当て込み。**既定は「入った」**——入らなかったときの道を
   * 見るテストは false を返す形へ差し替える。
   */
  applyEdit: (async (_edit: unknown) => true) as (
    edit: unknown
  ) => Promise<boolean>,
  /**
   * 開いている原稿をまとめて保存する。**既定は「全部保存できた」**——
   * 保存しきれなかったときの道（「保存して同期」が確認を挟む）を見る
   * テストは、false を返す形へ差し替える。
   */
  saveAll: (async (_includeUntitled?: boolean) => true) as (
    includeUntitled?: boolean
  ) => Promise<boolean>,
  /**
   * ファイルの見張り。作るたびに `fileSystemWatchers` へ積む
   * （下の `StubFileSystemWatcher`）。
   */
  createFileSystemWatcher,
};

/**
 * `vscode.RelativePattern` の代役。
 *
 * **本物と同じく、基点にUriを取れる形にしてある。** 基点を覗けないと、
 * 見張りがどのフォルダーを見ているかをテストから確かめられない。
 */
export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string
  ) {}
}

/**
 * ファイルの見張り（`createFileSystemWatcher`）の代役。
 *
 * **本物は実際のファイルを見ているので、テストからは起こせない。**
 * テスト側が `fireChange` / `fireCreate` / `fireDelete` を呼んで、
 * 「外で変わった」ことにする。
 */
export class StubFileSystemWatcher {
  disposed = false;
  private readonly changeEmitter = new StubEmitter<unknown>();
  private readonly createEmitter = new StubEmitter<unknown>();
  private readonly deleteEmitter = new StubEmitter<unknown>();

  constructor(readonly pattern: unknown) {}

  onDidChange = this.changeEmitter.event;
  onDidCreate = this.createEmitter.event;
  onDidDelete = this.deleteEmitter.event;

  dispose(): void {
    this.disposed = true;
  }

  /** テスト側から「このファイルが書き換わった」ことにする */
  fireChange(fsPath: string): void {
    this.changeEmitter.fire(Uri.file(fsPath));
  }
  fireCreate(fsPath: string): void {
    this.createEmitter.fire(Uri.file(fsPath));
  }
  fireDelete(fsPath: string): void {
    this.deleteEmitter.fire(Uri.file(fsPath));
  }
}

/**
 * これまでに作られた見張り。**前のテストの分を拾わないよう、
 * 各テストで `resetFileSystemWatchers` を呼んで空にする。**
 */
export const fileSystemWatchers: StubFileSystemWatcher[] = [];

export function resetFileSystemWatchers(): void {
  fileSystemWatchers.length = 0;
}

function createFileSystemWatcher(pattern: unknown): StubFileSystemWatcher {
  const watcher = new StubFileSystemWatcher(pattern);
  fileSystemWatchers.push(watcher);
  return watcher;
}

/** 文書の改行コード（本物と同じ値。1がLF、2がCRLF） */
export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

/**
 * 文書の書き換えのまとめ。**何を入れようとしたかを覗ける形**にしてある
 * ——改行コードを保ったまま当てているかは、入れる文字列を見ないと分からない。
 */
export class WorkspaceEdit {
  readonly replacements: Array<{
    uri: unknown;
    range: unknown;
    text: string;
  }> = [];

  replace(uri: unknown, range: unknown, text: string): void {
    this.replacements.push({ uri, range, text });
  }

  /**
   * 名前の変更。**積むだけで、当て込み（`applyEdit`）はしない**——
   * ディスクへの反映は、テスト側が `applyEdit` を差し替えて行う
   * （単話プロットの付け替え、`features/episodePlotFiles.ts`）。
   */
  readonly renames: Array<{
    from: { fsPath: string };
    to: { fsPath: string };
    options?: { overwrite?: boolean };
  }> = [];

  renameFile(
    from: { fsPath: string },
    to: { fsPath: string },
    options?: { overwrite?: boolean }
  ): void {
    this.renames.push({ from, to, options });
  }
}

/** 画面に出た知らせを覗くための形。テスト側で差し替えて使う */
export type StubMessage = (
  message: string,
  ...items: unknown[]
) => Promise<string | undefined>;

/**
 * ステータスバーに出た「その場限りの完了」の記録（`views/notify.ts`）。
 *
 * **本物は数秒で消えるので、テストからは覗けない。** 出た文言と
 * 消えるまでの長さをここへ積んでおき、テスト側が読む。
 * 溜まったままだと前のテストの分を拾うので、各テストで空にする。
 */
export const statusBarMessages: Array<{ text: string; timeout?: number }> = [];

/**
 * 選択画面（`createQuickPick`）の代役。
 *
 * 本物のQuickPickの全機能ではなく、`pickWithMemory`（`views/notify.ts`）が
 * 使う操作だけを持つ——`createQuickPick` を直に使うのはそこだけである
 * （`quickPickCancel.test.ts`）。本物と違って自動では何も起きない。
 * テスト側が `accept` / `triggerButton` / `hide` を呼んで、選ぶ・ピンを押す・
 * 閉じるを再現する。
 *
 * イベントの配線はここだけの小さな仕組みにしてある（下の `EventEmitter` は
 * まだ定義されていない位置に置きたいため、あえて使わない）。
 */
export interface StubQuickPickItem {
  label: string;
  [key: string]: unknown;
}

class StubEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value?: T): void {
    for (const listener of [...this.listeners]) listener(value as T);
  }
}

export class StubQuickPick<T extends StubQuickPickItem = StubQuickPickItem> {
  title = "";
  placeholder: string | undefined;
  ignoreFocusOut = false;
  items: readonly T[] = [];
  buttons: readonly unknown[] = [];
  selectedItems: readonly T[] = [];
  disposed = false;

  private readonly acceptEmitter = new StubEmitter<void>();
  private readonly hideEmitter = new StubEmitter<void>();
  private readonly buttonEmitter = new StubEmitter<unknown>();

  onDidAccept = this.acceptEmitter.event;
  onDidHide = this.hideEmitter.event;
  onDidTriggerButton = this.buttonEmitter.event;

  // 本物は画面を出すだけ。テストは accept / hide / triggerButton を呼んで進める
  show(): void {}

  hide(): void {
    this.hideEmitter.fire();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** テスト側から「この項目を選んで確定した」ことにする */
  accept(item: T): void {
    this.selectedItems = [item];
    this.acceptEmitter.fire();
  }

  /** テスト側から「右上のピンのボタンを押した」ことにする */
  triggerButton(): void {
    this.buttonEmitter.fire(this.buttons[0]);
  }
}

/**
 * 直近に作られた選択画面。**既定は「まだ作られていない」**。
 *
 * `pickWithMemory` は呼ぶたびに新しく作るので、テストはここから拾って操作する。
 * 溜まったままだと前のテストの分を拾うので、各テストで `resetLastQuickPick`
 * を呼んで空にする。
 */
export let lastQuickPick: StubQuickPick<StubQuickPickItem> | undefined;

/** テストの後始末用。`lastQuickPick` を初期状態へ戻す */
export function resetLastQuickPick(): void {
  lastQuickPick = undefined;
}

function createQuickPick<T extends StubQuickPickItem>(): StubQuickPick<T> {
  const picker = new StubQuickPick<T>();
  lastQuickPick = picker as unknown as StubQuickPick<StubQuickPickItem>;
  return picker;
}

export const window = {
  /** 選択画面。作るたびに `lastQuickPick` へ積む（上の `StubQuickPick`） */
  createQuickPick,
  // 診断ログ。テストでは中身を読まないので、書き込めるだけでよい
  createOutputChannel: () => ({
    appendLine() {},
    show() {},
    dispose() {},
  }),
  /** 消える知らせ。本物と同じく、消し方（Disposable）を返す */
  setStatusBarMessage: (
    text: string,
    timeout?: number
  ): { dispose(): void } => {
    statusBarMessages.push({ text, timeout });
    return { dispose() {} };
  },
  /**
   * 通知の3つ。**書き換えられる形で置く。**
   *
   * 既定は「出しただけで、作者は何も押さなかった」——完了通知の文言を
   * 見張るテストは、これを差し替えて中身を受け取る。
   */
  showInformationMessage: (async () => undefined) as StubMessage,
  showWarningMessage: (async () => undefined) as StubMessage,
  showErrorMessage: (async () => undefined) as StubMessage,
  /**
   * 選択画面。**既定は「何も選ばずに閉じた」**。
   *
   * 何が並んだかを見るテストは、渡された項目を覗く形へ差し替える
   * （前提の関門が出す3つの道は、並び自体が確かめたいものである）。
   */
  showQuickPick: (async (_items: unknown) => undefined) as (
    items: unknown,
    options?: unknown
  ) => Promise<unknown>,
  /**
   * 入力欄（`views/dialogs.ts` の `askText` が通す唯一の窓口）。
   *
   * 既定は「入力欄の初期値をそのまま確定した」体にする——`askText` は
   * 呼び出し側が渡した `value` をそのまま返せば、既定のファイル名で
   * 進むテストが書ける。取りやめを試すテストは `undefined` へ差し替える。
   */
  showInputBox: (async (options?: { value?: string }) =>
    options?.value) as (options?: {
    value?: string;
    [key: string]: unknown;
  }) => Promise<string | undefined>,
  /**
   * ファイル・フォルダーを選ぶダイアログ。**既定は「何も選ばずに閉じた」**。
   *
   * 選んだ体にするテストは、`Uri` の配列を返す形へ差し替える。
   */
  showOpenDialog: (async (_options?: unknown) => undefined) as (
    options?: unknown
  ) => Promise<readonly unknown[] | undefined>,
  /**
   * 進捗つきの処理（`views/progress.ts` が通す唯一の窓口）。
   *
   * **本物と同じく、渡された処理をそのまま走らせて結果を返す。**
   * 進捗の見え方はテストの関心事ではないので、報告は捨てる。
   */
  withProgress: (async <T>(
    _options: unknown,
    task: (
      progress: { report(value: unknown): void },
      token: { isCancellationRequested: boolean }
    ) => Thenable<T>
  ): Promise<T> =>
    task({ report() {} }, { isCancellationRequested: false })) as (
    options: unknown,
    task: (progress: never, token: never) => unknown
  ) => Promise<unknown>,
  /**
   * WebViewパネル。**既定は作らずに断る。**
   *
   * パネルを開くテストは、受け取った postMessage を覗ける作り物へ
   * 差し替える（差し替え忘れに気づけるよう、既定は例外にしてある）。
   */
  createWebviewPanel: ((..._args: unknown[]): unknown => {
    throw new Error("createWebviewPanel はテスト側で差し替えてください。");
  }) as (...args: unknown[]) => unknown,
  // 進捗の中止ボタン。テストでは押さないので、作られるだけでよい
  createStatusBarItem: () => ({
    text: "",
    tooltip: "" as unknown,
    command: "",
    backgroundColor: undefined as unknown,
    show() {},
    hide() {},
    dispose() {},
  }),
  // エディタの切り替え。テストでは発火させないので、購読できるだけでよい
  onDidChangeActiveTextEditor: (_listener: unknown) => ({
    dispose() {},
  }),
  /**
   * 該当箇所に掛ける色。**作られるだけでよい**——本文の見た目は実機でしか
   * 確かめられないので、ここでは相談パネルなどが組み立てられれば足りる。
   */
  createTextEditorDecorationType: (_options?: unknown) => ({
    key: "stub-decoration",
    dispose() {},
  }),
  /** いま開いている本文。**既定は「開いていない」** */
  activeTextEditor: undefined as unknown,
  /** 見えている本文のエディター。`viewColumn` だけを持たせれば足りる */
  visibleTextEditors: [] as { viewColumn?: number }[],
};
export const commands = {
  /**
   * コマンドの呼び出し。**既定は何もせずに返る。**
   *
   * 「押したら何が走ったか」を確かめるテストは、呼ばれたIDを積む形へ
   * 差し替える（前提の関門は、代わりの操作をその場で走らせるのが要件）。
   */
  executeCommand: (async (_command: string, ..._args: unknown[]) =>
    undefined) as (command: string, ...args: unknown[]) => Promise<unknown>,
};

/**
 * 外の世界へ出る2つの道（クリップボードと、ブラウザで開くこと）。
 *
 * 投稿キット（設計書6.68）が使う外向きの道はこの2つだけで、**サイトへ
 * HTTPを発する道は本物にも無い**。テストからは「何をコピーしたか」
 * 「どこを開いたか」を覗く。
 */
export const env = {
  clipboard: {
    /** 直近にコピーした文字列。テストはここを読む */
    text: "",
    async writeText(value: string): Promise<void> {
      env.clipboard.text = value;
    },
    async readText(): Promise<string> {
      return env.clipboard.text;
    },
  },
  /** 開いたURL。**開いただけ**で、中身は読まない（本物も同じ） */
  opened: [] as string[],
  openExternal: async (uri: { toString(): string }): Promise<boolean> => {
    env.opened.push(uri.toString());
    return true;
  },
};

export const authentication = {
  getSession: async (
    _providerId: string,
    _scopes: readonly string[],
    _options?: { createIfNone?: boolean }
  ): Promise<{ accessToken: string } | undefined> => undefined,
};

export enum ProgressLocation {
  Window = 10,
  Notification = 15,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

/** パネルを開く位置。値は本物のVS Codeに合わせる */
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

/** 設定の書き込み先。値は本物のVS Codeに合わせる */
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners: Array<() => void> = [];

  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void): { dispose(): void } => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    },
  };

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.token.isCancellationRequested = true;
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

export class EventEmitter<T> {
  // 以前は何もしない空実装だったが、それでは「選択が変わったら画面を
  // 更新する」のような配線そのものを確かめるテストが書けない。
  // 本物と同じく、登録関数を返し、fire で登録された順に呼ぶ
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value?: T): void {
    for (const listener of [...this.listeners]) listener(value as T);
  }
  /**
   * 後始末。**本物も持っている。** 無いままだと、持ち主の `dispose()` を
   * 通るテストが「本物なら通る所」で落ちる（`gitSyncWatch.test.ts`）。
   */
  dispose(): void {
    this.listeners.clear();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  contextValue?: string;
  id?: string;
  iconPath?: unknown;
  command?: unknown;

  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(readonly value: string = "") {}
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code = "Unknown"
  ) {
    super(message);
  }
}

/**
 * `vscode.Uri` の代役。
 *
 * **`toString` はプロトタイプに置く。** 各オブジェクトに持たせると、
 * 同じ場所を指す2つのUriが「別物」と判定される（`toHaveBeenCalledWith`
 * は関数を参照で比べるため）。本物も同じくプロトタイプに持っている。
 */
class StubUri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly fsPath: string,
    readonly text: string,
    /** 問い合わせ（`?` の後ろ）。**本物と同じく復号した形で持つ** */
    readonly query: string = ""
  ) {}

  toString(): string {
    return this.text;
  }
}

/**
 * 問い合わせ部分を復号する（本物の `vscode.Uri.parse` の再現）。
 *
 * **本物は `?` の後ろを percent-decode して持つ。** そのため
 * `text=%23創作` のように包んだ「#」が生の `#` へ戻り、そこから先が
 * 断片（fragment）として切り離される——`encodeURIComponent` で守った
 * つもりの投稿文が、ハッシュタグの手前で切れる（設計書6.79.8）。
 *
 * ここを素通しにしていたころは、`openExternal` へ Uri を渡す不具合が
 * テストでは一度も再現しなかった。**スタブが本物より親切だと、実機でしか
 * 出ない壊れ方を作ってしまう。**
 */
function decodeUriQuery(value: string): { query: string; text: string } {
  const start = value.indexOf("?");
  if (start < 0) return { query: "", text: value };
  const end = value.indexOf("#", start);
  const raw = end < 0 ? value.slice(start + 1) : value.slice(start + 1, end);
  let query: string;
  try {
    query = decodeURIComponent(raw);
  } catch {
    // 壊れた％列は本物も直さない（読めないものを推測で埋めない）
    query = raw;
  }
  const tail = end < 0 ? "" : value.slice(end);
  return { query, text: `${value.slice(0, start + 1)}${query}${tail}` };
}

export const Uri = {
  file: (fsPath: string) => {
    const normalized = fsPath.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    const slashed = normalized.replace(/\\/g, "/");
    return new StubUri("file", "", slashed, normalized, "file://" + slashed);
  },
  // 操作メニューの印は、実在しないURIを目印に使う（views/actionList.ts）
  from: (parts: { scheme: string; path?: string }) =>
    new StubUri(
      parts.scheme,
      "",
      parts.path ?? "",
      parts.path ?? "",
      `${parts.scheme}:${parts.path ?? ""}`
    ),
  /**
   * **本物に近づけてある。** 以前は道の部分に文字列まるごとを入れていたが、
   * それではブラウザ版のURI（`vscode-vfs://github/...`）を扱う処理を
   * 確かめられない（`authority` が undefined になって黙って壊れる）。
   *
   * **問い合わせ（`?` の後ろ）も本物と同じく復号する**（`decodeUriQuery`）。
   */
  parse: (value: string) => {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(value);
    const decoded = decodeUriQuery(value);
    if (!match) {
      const scheme = value.split(":")[0] ?? "";
      return new StubUri(
        scheme,
        "",
        value,
        value,
        decoded.text,
        decoded.query
      );
    }
    const body = match[3] || "/";
    return new StubUri(
      match[1],
      match[2],
      body,
      body,
      decoded.text,
      decoded.query
    );
  },
};

export enum FileType {
  File = 1,
  Directory = 2,
}

/**
 * 言語モデルの口（`vscode.lm`。設計書6.87.11）。
 *
 * **作り物でも持つ。** 本物の VS Code には 1.90 から在るので、
 * 無いことにすると「作り物でだけ落ちる／作り物でだけ通る」が生まれる。
 *
 * 既定は**1つも見えない**（＝サインインも鍵も無い環境）。テストは
 * `setStubChatModels` で顔ぶれを差し替える。
 */
let stubChatModels: StubChatModel[] = [];

export interface StubChatModel {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: unknown
  ): Promise<{ text: AsyncIterable<string> }>;
  countTokens(text: string): Promise<number>;
}

/** テストから顔ぶれを差し替える */
export function setStubChatModels(models: StubChatModel[]): void {
  stubChatModels = models;
}

export const lm = {
  selectChatModels: async (): Promise<StubChatModel[]> => stubChatModels,
  onDidChangeChatModels: (_listener: () => void): { dispose(): void } => ({
    dispose: () => undefined,
  }),
};

/**
 * 言語モデルの失敗。**`code` で種別を見分ける**のが本物と同じ形。
 */
export class LanguageModelError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "LanguageModelError";
  }

  static NoPermissions(message = "no permissions"): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }
  static Blocked(message = "blocked"): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }
  static NotFound(message = "not found"): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
}

/** 中止。本物と同じく `Error` の一種 */
export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

/**
 * 送るメッセージ。**本物には System が無い**（User と Assistant だけ）ので、
 * 作り物にも足さない——足すと、実際には送れない形でテストが通ってしまう。
 */
export class LanguageModelChatMessage {
  private constructor(
    readonly role: "user" | "assistant",
    readonly content: string
  ) {}

  static User(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage("user", content);
  }
  static Assistant(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage("assistant", content);
  }
}
