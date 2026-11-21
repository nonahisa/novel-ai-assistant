import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "./workRegistry";
import {
  emptyNotationChoiceSet,
  NOTATION_CHOICE_SCHEMA_VERSION,
  parseNotationChoiceSet,
  withNotationChoice,
  type NotationChoice,
  type NotationChoiceSet,
} from "../models/notationChoice";
import { atomicWriteFile, createManagedRecoveryPath } from "./atomicWrite";
import {
  detectExternalChange,
  externalChangeMessage,
  isExternalChangeError,
  snapshotOf,
  type ReadSnapshot,
} from "./readWriteGuard";

/**
 * 表記ゆれで選んだ「揃える先」の保存先（`設定/notation_choices.json`。設計書6.8.9）。
 *
 * 守り方は `keepWordStore.ts` と同じ：読んだときの控えと書く直前に照合し、
 * 元のファイルを回復先へ退避してから新規作成する。壊れた JSON は直さず止める。
 */

export const NOTATION_CHOICES_FILE = "notation_choices.json";

export class NotationChoiceStoreError extends Error {
  constructor(
    message: string,
    readonly recoveryPaths: string[] = [],
    /** 読み直してやり直す合図（`readWriteGuard.isExternalChangeError` が見る） */
    readonly kind?: "modified_externally"
  ) {
    super(message);
    this.name = "NotationChoiceStoreError";
  }
}

/** 作品の設定フォルダーの中の置き場（設定フォルダーを替えた作品にも合わせる） */
export async function notationChoicesPath(work: WorkEntry): Promise<string> {
  const config = await readWorkConfig(work);
  return path.join(workPaths(work, config).settings, NOTATION_CHOICES_FILE);
}

export class NotationChoiceStore {
  private snapshot: ReadSnapshot;

  constructor(private readonly work: WorkEntry) {}

  /** 読み込む。ファイルが無ければ「決めごとなし」を返す */
  async load(): Promise<NotationChoiceSet> {
    const target = await notationChoicesPath(this.work);
    this.snapshot = undefined;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(path.toUri(target));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        this.snapshot = null;
        return emptyNotationChoiceSet();
      }
      throw error;
    }
    try {
      const parsed = parseNotationChoiceSet(JSON.parse(new TextDecoder().decode(bytes)));
      this.snapshot = snapshotOf(bytes);
      return parsed;
    } catch (error) {
      throw new NotationChoiceStoreError(
        `${NOTATION_CHOICES_FILE} を読めませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [target]
      );
    }
  }

  /**
   * 決めた表記を入れる（1回の検知の分をまとめて1回で書く。組ごとに書くと
   * 回復先の世代が1回の検知で埋まる）。外で書き換わっていたら1回だけ読み直して
   * やり直す（入れる件は今の中身に依らないので、読み直せば外で足された件も残る）。
   *
   * @returns 書いたなら true、どれも同じ決めごとが既にあったなら false
   */
  async record(choices: readonly NotationChoice[]): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      let set = await this.load();
      let changed = false;
      for (const choice of choices) {
        const next = withNotationChoice(set, choice);
        if (next) {
          set = next;
          changed = true;
        }
      }
      if (!changed) return false;
      await this.save(set);
      return true;
    };
    try {
      return await run();
    } catch (error) {
      if (!isExternalChangeError(error)) throw error;
      return run();
    }
  }

  private async save(set: NotationChoiceSet): Promise<void> {
    const target = await notationChoicesPath(this.work);
    const body = JSON.stringify(
      { schemaVersion: NOTATION_CHOICE_SCHEMA_VERSION, choices: set.choices },
      null,
      2
    );
    const bytes = new TextEncoder().encode(`${body}\n`);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));

    const change = await detectExternalChange(target, this.snapshot);
    if (change) {
      throw new NotationChoiceStoreError(
        externalChangeMessage({
          label: "表記の決めごと",
          fileLabel: `設定/${NOTATION_CHOICES_FILE}`,
          change,
        }),
        [target],
        "modified_externally"
      );
    }

    let recoveryPath: string | undefined;
    if (await exists(target)) {
      try {
        recoveryPath = await createManagedRecoveryPath(target);
        await vscode.workspace.fs.rename(path.toUri(target), path.toUri(recoveryPath), {
          overwrite: false,
        });
      } catch (error) {
        throw new NotationChoiceStoreError(
          `${NOTATION_CHOICES_FILE} を退避できませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
          [target]
        );
      }
    }

    try {
      await atomicWriteFile(target, bytes, { mode: "create" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new NotationChoiceStoreError(
        recoveryPath
          ? `${NOTATION_CHOICES_FILE} を保存できませんでした: ${detail} 元の内容は「${recoveryPath}」にあります。手動で戻してください。`
          : `${NOTATION_CHOICES_FILE} を保存できませんでした: ${detail}`,
        recoveryPath ? [recoveryPath] : []
      );
    }
    this.snapshot = snapshotOf(bytes);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(target));
    return true;
  } catch {
    return false;
  }
}
