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
  readonly event = (): void => undefined;
  fire(_value?: T): void {}
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

export const Uri = {
  file: (fsPath: string) => ({
    fsPath: fsPath.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()),
  }),
  // 操作メニューの印は、実在しないURIを目印に使う（views/actionList.ts）
  from: (parts: { scheme: string; path?: string }) => ({
    scheme: parts.scheme,
    path: parts.path ?? "",
    fsPath: parts.path ?? "",
  }),
  parse: (value: string) => ({
    scheme: value.split(":")[0] ?? "",
    path: value,
    fsPath: value,
  }),
};

export enum FileType {
  File = 1,
  Directory = 2,
}
