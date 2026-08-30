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
};

export const window = {
  // 診断ログ。テストでは中身を読まないので、書き込めるだけでよい
  createOutputChannel: () => ({
    appendLine() {},
    show() {},
    dispose() {},
  }),
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
};
export const commands = {};

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
    readonly text: string
  ) {}

  toString(): string {
    return this.text;
  }
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
   */
  parse: (value: string) => {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(value);
    if (!match) {
      const scheme = value.split(":")[0] ?? "";
      return new StubUri(scheme, "", value, value, value);
    }
    const body = match[3] || "/";
    return new StubUri(match[1], match[2], body, body, value);
  },
};

export enum FileType {
  File = 1,
  Directory = 2,
}
