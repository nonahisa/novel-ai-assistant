import * as vscode from "vscode";
import * as path from "path";
import { WorkRegistry } from "../core/workRegistry";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import { AbilitySystemStore } from "../core/abilityStore";
import {
  TermIndex,
  expandNameVariants,
  type TermEntry,
  type TermKind,
} from "../core/termIndex";
import { SUPPORTED_EXTENSIONS, type WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import type { Ability } from "../models/ability";
import type { Location } from "../models/location";
import type { Organization } from "../models/organization";
import { formatChapters } from "../core/settingsMarkdown";

/**
 * 本文中の用語を色分けし、ホバーで設定を表示する。
 *
 * 種類ごとに色を変えるのは、人名か地名かを一目で区別するため。
 * 同じ青一色だと、地の文で「図書塔」と「灯」が並んだときに
 * どちらが人物か分からない。
 */

/** 種類ごとの表示色。テーマ色を使い、ライト・ダークの両方で読める色にする */
const KIND_STYLE: Record<
  TermKind,
  { light: string; dark: string; label: string }
> = {
  // 人名は青。最も数が多く、既定色として馴染みがある
  character: { light: "#1a5fb4", dark: "#7cb7ff", label: "登場人物" },
  // 地名は緑。人名と混ざらない色相を選ぶ
  location: { light: "#1c7c3c", dark: "#7ee08a", label: "場所" },
  // 能力は紫。地の文で目立ちすぎない明度にする
  ability: { light: "#7a3ea3", dark: "#d3a4f5", label: "能力" },
  // 組織は橙。人名・地名・能力のどれとも混ざらない色相にする
  organization: { light: "#9a5b00", dark: "#e8b06a", label: "組織" },
};

interface WorkSettings {
  index: TermIndex;
  characters: Map<string, Character>;
  abilities: Map<string, Ability>;
  locations: Map<string, Location>;
  organizations: Map<string, Organization>;
  abilityTerm: string;
}

export class TermHighlighter implements vscode.Disposable {
  private readonly decorations = new Map<
    TermKind,
    vscode.TextEditorDecorationType
  >();
  /** 作品ごとの索引。作品を切り替えるたびに読み直さない */
  private readonly cache = new Map<string, WorkSettings>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly registry: WorkRegistry) {
    for (const [kind, style] of Object.entries(KIND_STYLE)) {
      this.decorations.set(
        kind as TermKind,
        vscode.window.createTextEditorDecorationType({
          light: { color: style.light },
          dark: { color: style.dark },
        })
      );
    }

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() =>
        this.scheduleRefresh()
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh();
        }
      }),
      // 設定JSONが保存されたら索引を作り直す
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (path.extname(document.fileName).toLowerCase() === ".json") {
          this.cache.clear();
          this.scheduleRefresh();
        }
      })
    );
  }

  /** 抽出後など、設定が変わったときに呼ぶ */
  invalidate(): void {
    this.cache.clear();
    this.scheduleRefresh();
  }

  /**
   * 入力のたびに走らせると重いので少し待ってからまとめて処理する。
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, 150);
  }

  async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const ext = path.extname(editor.document.fileName).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      this.clear(editor);
      return;
    }

    const work = await this.findWork(editor.document.uri.fsPath);
    if (!work) {
      this.clear(editor);
      return;
    }

    const settings = await this.load(work);
    if (!settings || settings.index.size === 0) {
      this.clear(editor);
      return;
    }

    // 画面に出ている範囲だけを装飾する。
    // 73万字の作品全体を毎回走査するとスクロールが引っかかる。
    const ranges = new Map<TermKind, vscode.DecorationOptions[]>();
    for (const kind of this.decorations.keys()) ranges.set(kind, []);

    for (const visible of editor.visibleRanges) {
      // 前後に余白を取り、スクロール直後の未装飾を減らす
      const start = new vscode.Position(
        Math.max(0, visible.start.line - 50),
        0
      );
      const end = editor.document.lineAt(
        Math.min(editor.document.lineCount - 1, visible.end.line + 50)
      ).range.end;
      const region = new vscode.Range(start, end);
      const offset = editor.document.offsetAt(start);
      const text = editor.document.getText(region);

      for (const match of settings.index.find(text)) {
        const range = new vscode.Range(
          editor.document.positionAt(offset + match.start),
          editor.document.positionAt(offset + match.end)
        );
        ranges.get(match.entry.kind)?.push({
          range,
          hoverMessage: buildHover(match.entry, settings),
        });
      }
    }

    for (const [kind, decoration] of this.decorations) {
      editor.setDecorations(decoration, ranges.get(kind) ?? []);
    }
  }

  /**
   * カーソル位置にある用語を返す。
   *
   * 本文をクリックしたとき、その人物の資料を右側に出すために使う。
   * 装飾と違って画面の見える範囲に限らないが、行単位で照合するので
   * 走査量は小さい。
   */
  async termAt(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<{ work: WorkEntry; entry: TermEntry } | undefined> {
    const ext = path.extname(document.fileName).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return;

    const work = await this.findWork(document.uri.fsPath);
    if (!work) return;

    const settings = await this.load(work);
    if (!settings || settings.index.size === 0) return;

    const line = document.lineAt(position.line);
    const column = position.character;

    for (const match of settings.index.find(line.text)) {
      // 語の直後にカーソルがある場合も、その語を指しているとみなす
      if (match.start <= column && column <= match.end) {
        return { work, entry: match.entry };
      }
    }
    return undefined;
  }

  private clear(editor: vscode.TextEditor): void {
    for (const decoration of this.decorations.values()) {
      editor.setDecorations(decoration, []);
    }
  }

  /** 開いているファイルが属する作品を探す */
  private async findWork(filePath: string): Promise<WorkEntry | undefined> {
    const works = this.registry.list();
    // 深い作品フォルダを先に見て、入れ子の場合に内側を選ぶ
    const sorted = [...works].sort(
      (a, b) => b.folderPath.length - a.folderPath.length
    );
    return sorted.find((work) => isPathInside(work.folderPath, filePath));
  }

  private async load(work: WorkEntry): Promise<WorkSettings | undefined> {
    const cached = this.cache.get(work.id);
    if (cached) return cached;

    try {
      const characters = (await new CharacterStore(work).loadAll()).characters;
      const abilities = (await createAbilityStore(work).loadAll()).records;
      const locations = (await createLocationStore(work).loadAll()).records;
      const organizations = (await createOrganizationStore(work).loadAll())
        .records;
      const system = await new AbilitySystemStore(work).load();

      const entries: TermEntry[] = [];
      for (const character of characters) {
        // モブは数が多く、地の文の普通名詞と重なりやすいので装飾しない
        if (character.isMob) continue;
        // 「マルキオ・イークェス」は本文に「マルキオ」としか出ないことが多い
        for (const text of expandNameVariants([
          character.name,
          ...character.aliases,
        ])) {
          entries.push({
            text,
            kind: "character",
            id: character.id,
            canonicalName: character.name,
          });
        }
      }
      for (const location of locations) {
        for (const text of expandNameVariants([
          location.name,
          ...location.aliases,
        ])) {
          entries.push({
            text,
            kind: "location",
            id: location.id,
            canonicalName: location.name,
          });
        }
      }
      for (const ability of abilities) {
        for (const text of [ability.name, ...ability.aliases]) {
          entries.push({
            text,
            kind: "ability",
            id: ability.id,
            canonicalName: ability.name,
          });
        }
      }
      for (const organization of organizations) {
        // 組織名は区切りで分けない。「冒険者ギルド」を
        // 「冒険者」「ギルド」に割ると、無関係な語まで装飾してしまう
        for (const text of [organization.name, ...organization.aliases]) {
          entries.push({
            text,
            kind: "organization",
            id: organization.id,
            canonicalName: organization.name,
          });
        }
      }

      const settings: WorkSettings = {
        index: new TermIndex(entries),
        characters: new Map(characters.map((c) => [c.id, c])),
        abilities: new Map(abilities.map((a) => [a.id, a])),
        locations: new Map(locations.map((l) => [l.id, l])),
        organizations: new Map(organizations.map((o) => [o.id, o])),
        abilityTerm: system.abilityTerm || "能力",
      };
      this.cache.set(work.id, settings);
      return settings;
    } catch {
      // 設定が壊れていてもハイライトが無いだけで執筆は続けられる。
      // ここでエラーを出すと編集のたびに通知が出てしまう。
      return undefined;
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const decoration of this.decorations.values()) decoration.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** ホバーに出す資料。長くなりすぎないよう要点だけ並べる */
export function buildHover(
  entry: TermEntry,
  settings: {
    characters: Map<string, Character>;
    abilities: Map<string, Ability>;
    locations: Map<string, Location>;
    organizations?: Map<string, Organization>;
    abilityTerm: string;
  }
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;

  const kindLabel =
    entry.kind === "ability" ? settings.abilityTerm : KIND_STYLE[entry.kind].label;
  md.appendMarkdown(`**${entry.canonicalName}**　_${kindLabel}_\n\n`);

  // 別名で一致した場合、どの呼び方で当たったかを示す
  if (entry.text !== entry.canonicalName) {
    md.appendMarkdown(`「${entry.text}」として登場\n\n`);
  }

  if (entry.kind === "character") {
    const character = settings.characters.get(entry.id);
    if (!character) return md;
    appendLine(md, "役割", character.role);
    appendLine(md, "性格", character.personality);
    appendLine(md, "外見", character.appearance);
    if (character.firstPerson.default) {
      appendLine(md, "一人称", character.firstPerson.default);
    }
    if (character.abilities.length > 0) {
      appendLine(
        md,
        settings.abilityTerm,
        character.abilities.map((a) => a.name).join("、")
      );
    }
    if (character.relations.length > 0) {
      appendLine(
        md,
        "関係",
        character.relations
          .map((r) => `${r.name}（${r.relation}）`)
          .join("、")
      );
    }
    appendChapters(md, character.appearedChapters);
    appendConflicts(md, character.conflicts);
    appendNotes(md, character.authorNotes);
  } else if (entry.kind === "organization") {
    const organization = settings.organizations?.get(entry.id);
    if (!organization) return md;
    appendLine(md, "種別", organization.category);
    appendLine(md, "上位組織", organization.parent);
    appendLine(md, "説明", organization.description);
    appendChapters(md, organization.appearedChapters);
    appendConflicts(md, organization.conflicts);
    appendNotes(md, organization.authorNotes);
  } else if (entry.kind === "location") {
    const location = settings.locations.get(entry.id);
    if (!location) return md;
    appendLine(md, "地域", location.region);
    appendLine(md, "説明", location.description);
    appendChapters(md, location.appearedChapters);
    appendConflicts(md, location.conflicts);
    appendNotes(md, location.authorNotes);
  } else {
    const ability = settings.abilities.get(entry.id);
    if (!ability) return md;
    appendLine(md, "分類", ability.category);
    appendLine(md, "効果", ability.description);
    appendLine(md, "代償", ability.cost);
    appendLine(md, "制約", ability.limitation);
    if (ability.userNames.length > 0) {
      appendLine(md, "使い手", ability.userNames.join("、"));
    }
    appendChapters(md, ability.appearedChapters);
    appendConflicts(md, ability.conflicts);
    appendNotes(md, ability.authorNotes);
  }

  return md;
}

function appendLine(
  md: vscode.MarkdownString,
  label: string,
  value: string | null | undefined
): void {
  if (!value) return;
  md.appendMarkdown(`- **${label}**: ${escapeMarkdown(value)}\n`);
}

function appendChapters(
  md: vscode.MarkdownString,
  chapters: number[]
): void {
  if (chapters.length === 0) return;
  md.appendMarkdown(`- **登場話**: ${formatChapters(chapters)}\n`);
}

/** 作者の判断待ちはホバーでも見えるようにする */
function appendConflicts(
  md: vscode.MarkdownString,
  conflicts: Array<{ field: string; values: string[] }>
): void {
  for (const conflict of conflicts) {
    md.appendMarkdown(
      `- $(warning) **要確認（${conflict.field}）**: ${escapeMarkdown(
        conflict.values.join(" / ")
      )}\n`
    );
  }
}

function appendNotes(md: vscode.MarkdownString, notes: string): void {
  const trimmed = notes.trim();
  if (!trimmed) return;
  md.appendMarkdown(`\n---\n\n${escapeMarkdown(trimmed)}\n`);
}

/**
 * 本文由来の文字列を出すので、Markdown記法として解釈されないようにする。
 * 「*強調*」のような表記が設定に入っていても、そのまま読めるべき。
 */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = normalize(parentPath);
  const candidate = normalize(candidatePath);
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
