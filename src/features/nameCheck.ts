import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import { expandNameVariants } from "../core/termIndex";
import { findNameOccurrences } from "../core/nameOccurrences";
import {
  findNameCollisions,
  screenNameCandidates,
  type NameEntry,
} from "../core/nameCollision";
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
import { AIRegistry, ensureConfigured } from "../ai/registry";
import { AIError } from "../ai/types";
import {
  buildNameSuggestPrompt,
  NAME_ORIGINS,
  NAME_SUGGEST_COUNT,
  NAME_SUGGEST_SCHEMA,
  NAME_SUGGEST_SYSTEM_PROMPT,
  NAME_SUGGEST_VERSION,
  parseNameSuggest,
  type NameCandidate,
  type NameOrigin,
} from "../prompts/nameSuggest";
import { buildNameCheckPanelHtml } from "../views/nameCheckPanelHtml";
import { withCancellableProgress } from "../views/progress";
import { reportAIError } from "./reportAIError";
import { cancelItem } from "../views/dialogs";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { revealTextLocation, type RevealInManuscript } from "./revealLocation";
import {
  logFailure,
  logStep,
  responseExcerptForLog,
  showLog,
  useLogFile,
} from "../core/logger";

/**
 * 名前の点検（設計書6.37.5）。
 *
 * 上に衝突の組（AIを使わない判定）、下に人物一覧を並べる。
 * **この画面は何も書き換えない。** 押せるのは「候補を出す」（AI・P-29）、
 * 「付け替える」（提案パネルへ流す）、「登場箇所」（本文へ飛ぶ）の3つで、
 * どれも本体側の確認を通ってから動く。
 *
 * 作品ごとに1枚だけ開く。同じ作品を何枚も開いても見比べる意味がない。
 */

const openPanels = new Map<string, vscode.WebviewPanel>();

/** 1人あたり画面へ送る登場箇所の上限。全部送ると数万件になる作品がある */
const MAX_PLACES_PER_PERSON = 30;

export interface NameCheckPanelDeps {
  registry: AIRegistry;
  /** 原稿エディタで示す口（提案パネルと同じもの） */
  revealInManuscript?: RevealInManuscript;
  /** 「付け替える」を押されたときに走らせる処理。実体は `extension.ts` が繋ぐ */
  startRename: (
    work: WorkEntry,
    characterId: string,
    suggested?: { name: string; reading?: string }
  ) => Promise<void>;
}

export async function openNameCheckPanel(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  deps: NameCheckPanelDeps
): Promise<void> {
  const existing = openPanels.get(work.id);
  if (existing) {
    existing.reveal();
    await postNames(existing, work);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.nameCheck",
    `名前の点検: ${work.title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  openPanels.set(work.id, panel);
  context.subscriptions.push(panel);
  panel.onDidDispose(() => openPanels.delete(work.id));

  const nonce = createNonce();
  panel.webview.html = buildNameCheckPanelHtml(nonce, panel.webview.cspSource);

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const parsed = message as {
      type?: string;
      id?: string;
      name?: string;
      reading?: string;
      filePath?: string;
      line?: number;
    };

    if (parsed.type === "ready" || parsed.type === "refresh") {
      // HTMLを流し込んだ直後は受け手がまだ居ない。
      // WebView側から準備完了を知らせてもらってから送る
      await postNames(panel, work);
      return;
    }
    if (parsed.type === "jump" && parsed.filePath && parsed.line) {
      await revealTextLocation(
        parsed.filePath,
        parsed.line,
        deps.revealInManuscript,
        "名前の点検"
      );
      return;
    }
    if (parsed.type === "rename" && parsed.id) {
      await deps.startRename(
        work,
        parsed.id,
        parsed.name ? { name: parsed.name, reading: parsed.reading } : undefined
      );
      // 付け替えの入力で名前が変わっていることがある。読み直して出す
      await postNames(panel, work);
      return;
    }
    if (parsed.type === "suggest" && parsed.id) {
      await suggestNames(panel, work, deps.registry, parsed.id);
    }
  });
}

/** 開いているパネルがあれば内容を作り直す */
export async function refreshNameCheckPanel(work: WorkEntry): Promise<void> {
  const panel = openPanels.get(work.id);
  if (panel) await postNames(panel, work);
}

async function postNames(
  panel: vscode.WebviewPanel,
  work: WorkEntry
): Promise<void> {
  void panel.webview.postMessage({
    type: "names",
    data: await buildNameCheckData(work),
  });
}

/** 画面へ送る1件の登場箇所 */
interface PlaceView {
  filePath: string;
  fileName: string;
  line: number;
  /** 当たった呼び方。別名で出ていることもある */
  name: string;
  before: string;
  after: string;
}

interface PersonView {
  id: string;
  name: string;
  reading: string;
  aliases: string[];
  occurrences: number;
  places: PlaceView[];
}

/**
 * 画面に出すものを集める。
 *
 * **人物以外（場所・組織・能力）も衝突の相手として読む。** 地名と人名が
 * 同じ響きなら、読者はやはり取り違える（設計書6.37.1）。
 */
async function buildNameCheckData(work: WorkEntry) {
  const [characters, abilities, locations, organizations] = await Promise.all([
    new CharacterStore(work).loadAll(),
    createAbilityStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createOrganizationStore(work).loadAll(),
  ]);

  const entries = buildNameEntries({
    characters: characters.characters,
    abilities: abilities.records,
    locations: locations.records,
    organizations: organizations.records,
  });
  const collisions = findNameCollisions(entries);
  const occurrences = await collectOccurrences(work, characters.characters);

  const people: PersonView[] = characters.characters.map((character) => {
    const found = occurrences.get(character.id) ?? [];
    return {
      id: character.id,
      name: character.name,
      reading: character.reading ?? "",
      aliases: character.aliases,
      occurrences: found.length,
      places: found.slice(0, MAX_PLACES_PER_PERSON),
    };
  });

  return {
    title: `名前の点検：${work.title}`,
    collisions: collisions.collisions,
    unreadable: collisions.unreadable,
    people,
    notice:
      "判定はAIを使わず、読みと表記の規則だけで行っています。" +
      "この画面では何も書き換わりません。",
  };
}

/** 資料のレコードを、衝突判定が読める形へ揃える（純粋関数：テストの対象） */
export function buildNameEntries(source: {
  characters: Array<Pick<Character, "id" | "name" | "reading" | "aliases">>;
  abilities: Array<{ id: string; name: string; reading: string | null; aliases: string[] }>;
  locations: Array<{ id: string; name: string; reading: string | null; aliases: string[] }>;
  organizations: Array<{ id: string; name: string; reading: string | null; aliases: string[] }>;
}): NameEntry[] {
  const of = (
    kind: NameEntry["kind"],
    records: Array<{
      id: string;
      name: string;
      reading: string | null;
      aliases: string[];
    }>
  ): NameEntry[] =>
    records
      .filter((record) => record.name.trim())
      .map((record) => ({
        id: record.id,
        kind,
        name: record.name,
        reading: record.reading,
        aliases: record.aliases,
      }));

  return [
    ...of("character", source.characters as Array<{
      id: string;
      name: string;
      reading: string | null;
      aliases: string[];
    }>),
    ...of("ability", source.abilities),
    ...of("location", source.locations),
    ...of("organization", source.organizations),
  ];
}

/**
 * 本文のどこに誰が出ているかを数える。
 *
 * **本文は1回だけ走査する。** 人物ごとに読み直すと、人数×話数の
 * 読み込みになる（用語ハイライトが索引方式を採っているのと同じ理由）。
 *
 * 1つの呼び方を2人が持っていることがある（それ自体が衝突である）。
 * そのときは**両方に数える**——どちらかへ寄せると、片方の登場回数が
 * 実際より少なく見える。
 */
async function collectOccurrences(
  work: WorkEntry,
  characters: Character[]
): Promise<Map<string, PlaceView[]>> {
  const owners = new Map<string, string[]>();
  for (const character of characters) {
    for (const variant of expandNameVariants([
      character.name,
      ...character.aliases,
    ])) {
      const list = owners.get(variant) ?? [];
      list.push(character.id);
      owners.set(variant, list);
    }
  }

  const result = new Map<string, PlaceView[]>();
  if (owners.size === 0) return result;

  const scan = await scanWork(work);
  for (const episode of scan.episodes) {
    let text: string;
    try {
      const file = await readTextFile(episode.filePath);
      // 競合マーカーのあるファイルは触らない（数えるのも当てにならない）
      if (file.hasConflictMarkers) continue;
      text = file.text;
    } catch {
      continue; // 1話が読めなくても、残りは数える
    }

    for (const occurrence of findNameOccurrences(text, [...owners.keys()])) {
      for (const id of owners.get(occurrence.name) ?? []) {
        const list = result.get(id) ?? [];
        list.push({
          filePath: episode.filePath,
          fileName: path.basename(episode.filePath),
          line: occurrence.line,
          name: occurrence.name,
          before: occurrence.before,
          after: occurrence.after,
        });
        result.set(id, list);
      }
    }
  }

  return result;
}

/**
 * 響きが重ならない名前の候補を出す（P-29、設計書6.37.2）。
 *
 * **衝突の判定はコードで行う**（`screenNameCandidates`）。プロンプトで
 * 「避けて」と書いても守られない前提で、当たった候補は理由つきで落とす。
 * **キャッシュしない**——同じ人物へ何度も頼むのは、違う候補が欲しい場面である。
 */
async function suggestNames(
  panel: vscode.WebviewPanel,
  work: WorkEntry,
  registry: AIRegistry,
  characterId: string
): Promise<void> {
  useLogFile(work.folderPath);

  const store = new CharacterStore(work);
  const loaded = await store.loadAll();
  const character = loaded.characters.find((entry) => entry.id === characterId);
  if (!character) {
    vscode.window.showWarningMessage(
      "その人物が見つかりません。「更新」を押して読み直してください。"
    );
    return;
  }

  // 名前の生成は「生成系」の割当に従う（あらすじ・紹介文と同じ扱い）
  const resolved = await ensureConfigured(registry, "generate");
  if (!resolved) return;

  const origin = await pickOrigin();
  if (origin === undefined) return;

  // **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。
  // 繋がらないと分かっているのに料金の話をしても意味がない。
  // 由来を選ばずに閉じた回（上で return する）はAIを呼ばないので、ここに置く。
  // モデル名を渡すのは、LM Studioをこの場から起こしたときの読み込みに要るため
  if (
    !(await confirmProviderReachable(
      resolved.provider,
      "名前の候補づくり",
      resolved.model
    ))
  ) {
    return;
  }

  const ok = await confirmPaidUsage(resolved.provider, {
    actionLabel: "名前の候補",
    model: resolved.model,
    calls: 1,
    detail:
      `送るのは既にある名前の一覧と、作品の世界観の節だけです。\n` +
      "本文は送りません。候補が出るだけで、何も書き換わりません。",
  });
  if (!ok) return;

  void panel.webview.postMessage({ type: "busy", id: characterId });

  const material = await collectSuggestMaterial(work, character);
  let responseText: string | undefined;
  let failure: unknown;

  await withCancellableProgress(
    `「${character.name}」の名前の候補を考えています`,
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        logStep(
          `名前の候補を開始: ${work.title} / ${character.name} / ` +
            `${resolved.provider.displayName} / ${resolved.model} / ` +
            `v${NAME_SUGGEST_VERSION}`
        );
        const response = await resolved.provider.generate({
          systemPrompt: NAME_SUGGEST_SYSTEM_PROMPT,
          userPrompt: buildNameSuggestPrompt({
            workTitle: work.title,
            currentName: character.name,
            gender: character.gender ?? "",
            role: character.role ?? "",
            affiliation: character.affiliation ?? "",
            existingNames: material.existingNames,
            setting: material.setting,
            origin: origin === "auto" ? undefined : origin,
          }),
          model: resolved.model,
          // 候補は広く出させる。当たり外れは作者が選ぶ（P-29）
          temperature: 0.8,
          jsonSchema: NAME_SUGGEST_SCHEMA as unknown as object,
          disableThinking: true,
          meta: { feature: "name_suggest", workFolder: work.folderPath },
          signal: controller.signal,
        });
        if (response.truncated) {
          failure = new Error("応答が出力上限で切れました。");
          return;
        }
        responseText = response.text;
      } catch (error) {
        failure = error;
      }
    }
  );

  if (failure || responseText === undefined) {
    // 中止は失敗ではない。作者が自分で止めたことを警告で知らせ直さない
    if (!(failure instanceof AIError && failure.kind === "aborted")) {
      reportAIError("名前の候補づくり", failure);
    }
    void panel.webview.postMessage({
      type: "candidates",
      data: { characterId, kept: [], dropped: [] },
    });
    return;
  }

  const parsed = parseNameSuggest(responseText);
  if (parsed.length === 0) {
    // **応答の中身は捨てない。** 通知に出さなくても、ログには残す
    logFailure("名前の候補", {
      理由: "応答を読み取れません",
      応答: responseExcerptForLog(responseText),
    });
    const answer = await vscode.window.showWarningMessage(
      "名前の候補を読み取れませんでした。",
      "ログを見る"
    );
    if (answer === "ログを見る") showLog();
  }

  const screened = screenNameCandidates(parsed, material.entries, {
    excludeId: character.id,
  });

  void panel.webview.postMessage({
    type: "candidates",
    data: {
      characterId,
      kept: screened.kept,
      dropped: screened.dropped.map((entry) => ({
        name: entry.candidate.name,
        reason: entry.reason,
      })),
    },
  });

  if (screened.dropped.length > 0) {
    // 黙って減らさない。何件が何で落ちたのかは画面にも出るが、
    // 通知でも一度伝える（画面の下のほうにあると気づかれない）
    vscode.window.showInformationMessage(
      `候補 ${parsed.length}件のうち ${screened.dropped.length}件は、` +
        "既にある名前と響きが重なるため落としました（理由は画面に出ています）。"
    );
  }
}

/** 系統を選ばせる。「指定なし」は既存の名前からAIに1つ推定させる */
async function pickOrigin(): Promise<NameOrigin | "auto" | undefined> {
  const items: Array<{
    label: string;
    detail?: string;
    origin: NameOrigin | "auto";
  }> = [
    {
      label: "$(wand) 指定なし（作品の既存名から推定）",
      detail: "いまある名前の並びから系統を1つ見立てて、その中だけで出します",
      origin: "auto",
    },
    ...NAME_ORIGINS.map((origin) => ({
      label: origin,
      origin: origin as NameOrigin,
    })),
  ];

  const picked = await vscode.window.showQuickPick([...items, cancelItem()], {
    title: `名前の系統（${NAME_SUGGEST_COUNT}件の候補を出します）`,
    placeHolder: "系統は混ぜません。1つだけ選んでください",
    ignoreFocusOut: true,
  });
  if (!picked || !("origin" in picked)) return undefined;
  return picked.origin;
}

interface SuggestMaterial {
  /** 「名前（よみ）」の形に整えた既存の名前 */
  existingNames: string[];
  /** 衝突判定に使う元の一覧 */
  entries: NameEntry[];
  setting: string;
}

async function collectSuggestMaterial(
  work: WorkEntry,
  character: Character
): Promise<SuggestMaterial> {
  const [characters, abilities, locations, organizations] = await Promise.all([
    new CharacterStore(work).loadAll(),
    createAbilityStore(work).loadAll(),
    createLocationStore(work).loadAll(),
    createOrganizationStore(work).loadAll(),
  ]);

  const entries = buildNameEntries({
    characters: characters.characters,
    abilities: abilities.records,
    locations: locations.records,
    organizations: organizations.records,
  });

  const existingNames = entries
    // 付け替える本人の名前は「避ける相手」ではない
    .filter((entry) => entry.id !== character.id)
    .map((entry) =>
      entry.reading ? `${entry.name}（${entry.reading}）` : entry.name
    );

  return { existingNames, entries, setting: await readSetting(work) };
}

/**
 * 作品の世界観・舞台（`plot.md` の該当の節）。
 *
 * 無ければ空文字で渡す。**材料が1つ減るだけなので止めない**
 * （冒頭診断のジャンル・ログラインと同じ扱い）。
 */
async function readSetting(work: WorkEntry): Promise<string> {
  try {
    const sections = parsePlotMarkdown(await readPlotText(work)).sections;
    return [sections.worldview, sections.setting]
      .filter((body) => body && !isBlankPlotSection(body))
      .map((body) => body.trim())
      .join("\n");
  } catch {
    return "";
  }
}


/** 画面へ渡す候補の型を、外からも使えるようにする（テスト・報告用） */
export type { NameCandidate };

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
