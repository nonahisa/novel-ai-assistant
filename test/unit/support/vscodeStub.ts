export const workspace = {
  fs: {} as Record<string, unknown>,
  textDocuments: [],
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  }),
};

export const window = {};
export const commands = {};

export enum ProgressLocation {
  Notification = 15,
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
  file: (fsPath: string) => ({ fsPath }),
};

export enum FileType {
  File = 1,
  Directory = 2,
}
