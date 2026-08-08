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
  // 進捗の中止ボタン。テストでは押さないので、作られるだけでよい
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: "",
    show() {},
    hide() {},
    dispose() {},
  }),
};
export const commands = {};

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
};

export enum FileType {
  File = 1,
  Directory = 2,
}
