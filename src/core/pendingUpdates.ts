import * as vscode from "vscode";
import * as path from "./paths";
import { AIWRITER_DIR, WorkEntry } from "../models/types";
import { parseCharacter, type Character } from "../models/character";
import { atomicWriteFile } from "./atomicWrite";

/**
 * 抽出で作られた「既存人物の更新案」の置き場。
 *
 * このプロジェクトは既存ファイルを上書きしない（`atomicWrite` を参照）。
 * そのため抽出しても既存人物には反映されず、以前は毎回失敗として
 * 回復ディレクトリに提案ファイルが溜まるだけだった。
 *
 * 更新案をここへ貯めておき、作者が内容を見て承認したときにだけ反映する。
 * 新規人物の承認制と同じ考え方で、AIの判断を黙って原稿へ入れない。
 *
 * `.aiwriter` の下に置くのは、作者が読む「設定」フォルダーを
 * 未確定のファイルで散らかさないため。
 */

const PENDING_DIR = "pending-characters";

/**
 * その更新案がどこから来たか（設計書6.4.9）。
 *
 * 省略（`undefined`）は**AIの抽出**である。出どころを持たせる前に積まれた
 * ファイルがそう読まれるので、既定を変えてはいけない。
 *
 * plot: 作者が plot.md の「主要登場人物」へ書いたもの。AIの読みではなく
 *   作者の文なので、承認するときの見方が変わる
 */
export type PendingUpdateSource = "plot";

/** 出どころの短い呼び名。画面に出す文言はここだけが持つ */
export function pendingSourceLabel(
  source: PendingUpdateSource | undefined
): string {
  return source === "plot" ? "プロットから" : "";
}

/**
 * 何の案か（設計書6.4.9）。
 *
 * 省略（`undefined`）は**既存レコードの更新**である。これまで積まれた
 * ものはすべてそれなので、既定を変えてはいけない。
 *
 * creation: まだ台帳に無い人物を作る案。**IDは仮**（`PENDING_CREATION_ID`）で、
 *   本当の採番は承認したときに行う——積んだ時点で採ると、別の作品操作で
 *   同じ番号が先に使われる
 */
export type PendingUpdateKind = "creation";

export interface PendingUpdate {
  /** 更新案。既存レコードと同じID（新規案では仮のID） */
  character: Character;
  /** 保留ファイルのパス。反映後に片付ける */
  filePath: string;
  /** どこから来た提案か。古いファイルには無い（＝抽出） */
  source?: PendingUpdateSource;
  /** 何の案か。古いファイルには無い（＝既存レコードの更新） */
  kind?: PendingUpdateKind;
}

/**
 * 新規案のIDは仮である（`core/plotCharacterSync.ts` の
 * `PENDING_CREATION_ID`）。`parseCharacter` がIDの形（`char_数字`）を
 * 確かめるので空にはできないが、**その番号のまま台帳へ入れてはいけない**
 * ——`applyPendingUpdates` が承認のときに採り直す。
 */

export class PendingUpdateStore {
  constructor(private readonly work: WorkEntry) {}

  private get directory(): string {
    return path.join(this.work.folderPath, AIWRITER_DIR, PENDING_DIR);
  }

  /**
   * 更新案を積む。
   *
   * @param options.source 出どころ。**省略したときは、その人物の
   *   既にある更新案から引き継ぐ。** 話数の付け替え（`episodeLedgers`）は
   *   中身だけを直して積み直すので、ここで落とすと「プロットから」の
   *   印が黙って消える
   * @param options.kind 新規案なら `"creation"`。**ファイル名を名前で作る**
   *   ——新規案のIDは仮なので、IDで名付けると別の名前の案どうしが
   *   同じファイルを取り合って、先に積んだ案が黙って消える
   */
  async stage(
    characters: Character[],
    options: { source?: PendingUpdateSource; kind?: PendingUpdateKind } = {}
  ): Promise<void> {
    if (characters.length === 0) return;
    await vscode.workspace.fs.createDirectory(
      path.toUri(this.directory)
    );

    for (const character of characters) {
      const target = path.join(
        this.directory,
        pendingFileName(character, options.kind)
      );
      const source = options.source ?? (await this.sourceOf(target));
      // 何も伝えることが無いものは、**これまでどおり人物のJSONそのもの**を
      // 書く。包みを増やすのは、出どころか種別があるときだけでよい
      const payload =
        source || options.kind
          ? { ...(options.kind ? { kind: options.kind } : {}), ...(source ? { source } : {}), character }
          : character;
      const body = `${JSON.stringify(payload, null, 2)}\n`;
      // 保留ファイルは作者の原稿ではないので、上書きしてよい。
      // 同じ人物の更新案が2つ並んでも作者が困るだけ
      await atomicWriteFile(target, new TextEncoder().encode(body));
    }
  }

  /** 既にある更新案の出どころ。無ければ undefined（読めなくても同じ） */
  private async sourceOf(
    filePath: string
  ): Promise<PendingUpdateSource | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return readSource(parsed);
    } catch {
      // 無い・壊れているときは引き継ぐものが無いだけ。積むこと自体は続ける
      return undefined;
    }
  }

  /** 保留中の更新案を読む。壊れたものは読み飛ばして報告する */
  async loadAll(): Promise<{
    updates: PendingUpdate[];
    errors: Array<{ file: string; message: string }>;
  }> {
    const updates: PendingUpdate[] = [];
    const errors: Array<{ file: string; message: string }> = [];

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        path.toUri(this.directory)
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return { updates, errors };
      }
      throw error;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
      const filePath = path.join(this.directory, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(
          path.toUri(filePath)
        );
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        updates.push({
          character: parseCharacter(unwrap(parsed)),
          filePath,
          source: readSource(parsed),
          kind: readKind(parsed),
        });
      } catch (error) {
        errors.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    updates.sort((a, b) => a.character.id.localeCompare(b.character.id));
    return { updates, errors };
  }

  /** 反映済み・破棄した更新案を片付ける */
  async discard(filePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(path.toUri(filePath));
    } catch {
      // 消せなくても実害はない。次回の一覧に残るだけ
    }
  }

  async count(): Promise<number> {
    return (await this.loadAll()).updates.length;
  }
}

/**
 * 保留ファイルの中身から人物を取り出す。
 *
 * **2つの形がある。** 出どころを持たせる前（設計書6.4.9より前）に
 * 積まれたものは人物のJSONそのもので、作者の環境にはそれが残っている。
 * 読めなくすると、確認を待っている提案が黙って消える。
 */
function unwrap(parsed: unknown): unknown {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "character" in parsed
  ) {
    return (parsed as { character: unknown }).character;
  }
  return parsed;
}

function readSource(parsed: unknown): PendingUpdateSource | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const source = (parsed as { source?: unknown }).source;
  return source === "plot" ? "plot" : undefined;
}

function readKind(parsed: unknown): PendingUpdateKind | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const kind = (parsed as { kind?: unknown }).kind;
  return kind === "creation" ? "creation" : undefined;
}

/**
 * 保留ファイルの名前。
 *
 * 更新案はこれまでどおりレコードのID。新規案は**名前**で付ける
 * （IDが仮であるため。同じ名前を積み直したときだけ上書きされる）。
 */
function pendingFileName(
  character: Character,
  kind: PendingUpdateKind | undefined
): string {
  if (kind !== "creation") return `${character.id}.json`;
  const safeName = character.name
    .replace(/[/\\:*?"<>|\s]/g, "")
    .slice(0, 30);
  return `new_${safeName || character.id}.json`;
}
