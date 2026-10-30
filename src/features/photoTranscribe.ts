import * as vscode from "vscode";
import * as path from "../core/paths";
import type { AIRegistry } from "../ai/registry";
import { ASSIGNABLE_FEATURE_LABELS, ensureConfigured } from "../ai/registry";
import { AIError, type AIProvider, type ModelInfo } from "../ai/types";
import { canSendImages, imageSupportFor, type ImageSupport } from "../ai/imageInput";
import { describePhotoSend } from "../core/photoTranscribeConfirm";
import {
  PHOTO_REQUEST_MAX_CHARS,
  checkPhotoRequest,
  countPhotoRequestChars,
  photoRequestEchoes,
} from "../core/photoTranscribeRequest";
import { readPhotoRequest, savePhotoRequest } from "../core/photoTranscribeRequestStore";
import { parsePhotoTranscriptionStoppingRepeats } from "../core/photoTranscribeValidation";
import { endsWithInlineRepetition } from "../core/inlineRepetition";
import { readExifOrientation } from "../core/exifOrientation";
import { isLocalProviderId } from "../core/localProviders";
import {
  combinePhotoOrient,
  describePhotoOrientGuess,
  parsePhotoOrient,
  photoOrientSettled,
  placePhotoByGuess,
  shouldAskPhotoOrient,
  type PhotoOrientProbe,
} from "../core/photoOrientValidation";
import {
  ORIENT_PROBE_TURNS,
  PHOTO_ORIENT_NUM_CTX,
  PHOTO_ORIENT_VERSION,
  buildPhotoOrientRequest,
} from "../prompts/photoOrient";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { fromLfText } from "../core/eolSpace";
import { scanWork } from "../core/scanner";
import { nextChapterNumber, parseEpisodeFileName } from "../core/episodeParser";
import type { MissingEpisodeFile } from "../core/backupMissingEpisodes";
import type { WorkEntry } from "../models/types";
import {
  PHOTO_TRANSCRIBE_NUM_CTX,
  PHOTO_TRANSCRIBE_VERSION,
  buildPhotoTranscribeRequest,
} from "../prompts/photoTranscribe";
import { buildPhotoTranscribeHtml } from "../views/photoTranscribePanelHtml";
import { askText } from "../views/dialogs";
import { wideViewColumn } from "./editorColumn";
import { nameNewEpisodes, writeNewEpisodes } from "./addEpisodeFiles";
import { describeAIError } from "./reportAIError";
import { confirmProviderReachable } from "./aiConnectivity";
import { isInsideWork, lastManuscriptCaret, openManuscriptTabUris } from "./manuscriptEditor";
import { createNonce } from "../core/webviewNonce";

/**
 * 写真から原稿を起こす（設計書6.117）。作品ごとに1枚の画面。
 *
 * 流れ：写真を選ぶ → 画面で回す・切る → 外へ送る確認 → 1ページずつAIへ →
 * 写真と並べて作者が直す → 新しい話として保存／開いている話へ差し込む。
 */

/** 送信量の記録とログに使う機能の名前 */
export const PHOTO_TRANSCRIBE_FEATURE = "photo_transcribe";
/** 向きを尋ねる（P-49）の記録の名前 */
export const PHOTO_ORIENT_FEATURE = "photo_orient";

/** 選べる写真の種類（拡張子 → 種類） */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface PhotoTranscribeDeps {
  /** 作品一覧を描き直す */
  refreshTree(work: WorkEntry): void;
  /**
   * 執筆量の基準を置き直す（新しい話を足したとき）。**置き直さないと、
   * このあと作者が保存した回が「ファイル数が変わった回」として数えられず、
   * 当日の執筆量が消える**（`novelai.addEpisode` と同じ）
   */
  rebaseline(work: WorkEntry): Promise<void>;
  /** 足した話を原稿エディターで開く */
  openEpisode(work: WorkEntry, filePath: string): Promise<void>;
}

/** 画面から届く1ページ */
interface PageInput {
  id: string;
  label: string;
  mimeType: string;
  base64: string;
}

const openPanels = new Map<string, vscode.WebviewPanel>();

export async function openPhotoTranscribe(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  registry: AIRegistry,
  deps: PhotoTranscribeDeps
): Promise<void> {
  useLogFile(work.folderPath);
  const existing = openPanels.get(work.id);
  if (existing) {
    existing.reveal();
    await addPhotos(existing);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.photoTranscribe",
    `写真から原稿を起こす: ${work.title}`,
    wideViewColumn(),
    { enableScripts: true, retainContextWhenHidden: true }
  );
  openPanels.set(work.id, panel);
  context.subscriptions.push(panel);

  let abort: AbortController | undefined;
  panel.onDidDispose(() => {
    openPanels.delete(work.id);
    abort?.abort();
  });
  panel.webview.html = buildPhotoTranscribeHtml(createNonce(), panel.webview.cspSource);

  /*
    作者からの頼みは作品フォルダーに置く（設計書6.117.7。`core/photoTranscribeRequestStore.ts`）。
    `knownRequest` はこの画面が最後に読んだ（書いた）頼み。**読めなかったら undefined
    にして、画面を開き直すまで書かない**——壊れたファイル・競合の印が入ったファイルを
    上書きすると、そこに残っている作者の文が消える。読めなくても書き起こしは止めない
    （いま欄にある頼みは作者の手元にあり、送るのはそちらだから）
  */
  let knownRequest: string | undefined;
  const postRequestNote = (note: string): void => {
    void panel.webview.postMessage({ type: "requestNote", text: note });
  };
  const loadRequest = async (): Promise<void> => {
    const read = await readPhotoRequest(work);
    knownRequest = read.ok ? read.text : undefined;
    if (!read.ok) {
      logFailure("写真の書き起こし：AIへの頼みを読む", { 内容: read.reason });
    }
    void panel.webview.postMessage({
      type: "request",
      text: read.ok ? read.text : "",
      max: PHOTO_REQUEST_MAX_CHARS,
      note: read.ok ? "" : read.reason,
    });
  };
  const saveRequest = async (raw: unknown): Promise<void> => {
    if (knownRequest === undefined) return;
    try {
      const saved = await savePhotoRequest(work, knownRequest, typeof raw === "string" ? raw : "");
      if (saved.ok) {
        knownRequest = saved.text;
        postRequestNote("");
        return;
      }
      // 上限を超えた頼みは覚えない（画面が超えたことを出している）
      if (saved.kind === "over") return;
      logFailure("写真の書き起こし：AIへの頼みを覚える", { 内容: saved.reason });
      postRequestNote(saved.reason);
    } catch (error) {
      // 覚えられなくても、いま画面にある頼みで書き起こしは続けられる。理由はログと画面へ
      const detail = error instanceof Error ? error.message : String(error);
      logFailure("写真の書き起こし：AIへの頼みを覚える", { 内容: detail });
      postRequestNote(
        `AIへの頼みを作品フォルダーに覚えられませんでした（${detail}）。いまの欄の頼みで書き起こしはできます。`
      );
    }
  };

  const postAi = (): Promise<void> => postAiState(panel, registry);
  const orientQueue = new PhotoOrientQueue(panel, registry, work);
  panel.onDidDispose(() => orientQueue.stopAll());
  // 割当を別の画面で変えても、こちらの表示を追わせる
  const selection = registry.onDidChangeSelection(() => void postAi());
  panel.onDidDispose(() => selection.dispose());

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const message = raw as { type?: string } & Record<string, unknown>;
    switch (message.type) {
      case "ready":
        await loadRequest();
        await postAi();
        await addPhotos(panel);
        break;
      case "saveRequest":
        await saveRequest(message.text);
        break;
      case "addPhotos":
        await addPhotos(panel);
        break;
      case "photoError":
        void vscode.window.showWarningMessage(
          `写真「${String(message.name)}」を読めませんでした。jpg・png・webp の写真をお選びください。`
        );
        break;
      case "pickAi": {
        const { assignOneFeatureAI } = await import("./assignFeatureAI.js");
        await assignOneFeatureAI(registry, "transcribe");
        await postAi();
        break;
      }
      case "cancel":
        abort?.abort();
        break;
      case "orientProbe": {
        const probe = readOrientProbe(message);
        if (probe) orientQueue.add(probe);
        break;
      }
      case "orientCancel":
        if (typeof message.id === "string") orientQueue.cancel(message.id);
        break;
      case "transcribe": {
        if (abort) return; // 走っている間は受けない（画面の［書き起こす］も押せない）
        const pages = readPages(message.pages);
        const photos = typeof message.photos === "number" ? message.photos : pages.length;
        if (pages.length === 0) return;
        /*
          頼みは画面にある文をそのまま送る（覚えた文と画面の文が食い違わないよう、
          押されたときの文を覚え直してから使う）。**上限を超えていたら黙って切らずに止める**
        */
        const request = checkPhotoRequest(message.request);
        if (!request.ok) {
          failAll(panel, pages, request.reason);
          return;
        }
        // 書き起こしを始めたら、向きを尋ねるのはやめる（同じ手元のAIを取り合わない）
        orientQueue.stopAll();
        // 覚えるのを待つ間に2度目の［書き起こす］が届いても受けないよう、先に旗を立てる
        abort = new AbortController();
        try {
          await saveRequest(request.text);
          await transcribePages(panel, work, registry, pages, photos, request.text, abort.signal);
        } finally {
          abort = undefined;
          void panel.webview.postMessage({ type: "running", on: false, text: "" });
        }
        break;
      }
      case "saveNew":
        if (typeof message.text === "string") await saveAsNewEpisode(work, message.text, deps);
        break;
      case "insert":
        if (typeof message.text === "string") await insertAtCaret(work, message.text);
        break;
    }
  });
}

/** 写真を選ばせ、画面へ渡す。**バイト列を読んで base64 で渡すだけ**（処理は画面の canvas） */
async function addPhotos(panel: vscode.WebviewPanel): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: "この写真を読む",
    title: "書き起こす写真を選んでください（複数選べます）",
    filters: { 写真: ["jpg", "jpeg", "png", "webp"] },
  });
  if (!uris || uris.length === 0) return;
  const items: { id: string; name: string; dataUrl: string; orientation?: number }[] = [];
  for (const uri of uris) {
    const name = path.basename(path.fromUri(uri));
    const mime = IMAGE_TYPES[path.extname(name).toLowerCase()];
    if (!mime) {
      void vscode.window.showWarningMessage(`「${name}」は写真として読めません（jpg・png・webp だけ）。`);
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      // 向きの印（EXIF）を読んで画面へ添える。回すのは画面の描き方に任せ、
      // 画面は「自動で回した」ことを出すのに使う（設計書6.117.3）
      const orientation = readExifOrientation(bytes);
      items.push({
        id: `p${Date.now().toString(36)}${items.length}`,
        name,
        dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
        ...(orientation !== undefined ? { orientation } : {}),
      });
    } catch (error) {
      void vscode.window.showWarningMessage(
        `「${name}」を読めませんでした：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (items.length > 0) void panel.webview.postMessage({ type: "photos", items });
}

/**
 * いまの割当のAIと、写真を読めるかを画面の帯へ出す形にする。
 */
async function describeAssignedAi(
  registry: AIRegistry
): Promise<{ label: string; canSend: boolean; note?: string }> {
  const resolved = registry.resolve("transcribe");
  const featureLabel = ASSIGNABLE_FEATURE_LABELS.transcribe;
  if (!resolved) {
    return {
      label: `${featureLabel}に使うAIが、まだ決まっていません。`,
      canSend: false,
      note: "［AIを選ぶ］から、写真を読めるAIを選んでください。",
    };
  }
  const info = await modelInfoOf(resolved.provider, resolved.model);
  const support = imageSupportFor(resolved.provider.id, info);
  const assigned = registry.assignments().transcribe !== undefined;
  const label =
    `${featureLabel}に使うAI：${resolved.provider.displayName}（${resolved.model}）` +
    (assigned ? "" : "　※割当が無いので、既定のAIです");
  return { label, canSend: canSendImages(support), note: supportNote(support) };
}

function supportNote(support: ImageSupport): string | undefined {
  if (support.kind === "no") return `写真を送れません：${support.reason}［AIを選ぶ］から選び直してください。`;
  if (support.kind === "unknown") return support.note;
  return undefined;
}

async function modelInfoOf(provider: AIProvider, model: string): Promise<ModelInfo | undefined> {
  try {
    if (provider.getModel) return await provider.getModel(model);
    return (await provider.listModels()).find((one) => one.id === model);
  } catch {
    // 情報が取れなくても「分からない」として扱う（送ってみて断られたら知らせる）
    return undefined;
  }
}

/** 割当のAIの帯と、向きを尋ねられるかを画面へ送る */
async function postAiState(panel: vscode.WebviewPanel, registry: AIRegistry): Promise<void> {
  const [ai, orient] = await Promise.all([describeAssignedAi(registry), resolveOrientAi(registry)]);
  void panel.webview.postMessage({ type: "ai", ...ai, canOrient: orient !== undefined });
}

/**
 * 向きを尋ねる相手（設計書6.117.11）。**写真の書き起こしの割当（既定へ落ちた先を含む）
 * が、写真を読めると申告した手元のAIのときだけ**。
 *
 * 割当がクラウドなら尋ねない（作者が送るのを確かめる前に写真を外へ出さない）。
 * 手元の別のモデルを探して勝手に使うこともしない——作者が選んでいない大きな
 * モデルを読み込ませ、メモリを取り合うことになるため。
 */
async function resolveOrientAi(
  registry: AIRegistry
): Promise<{ provider: AIProvider; model: string; info: ModelInfo | undefined } | undefined> {
  const resolved = registry.resolve("transcribe");
  if (!resolved || !isLocalProviderId(resolved.provider.id)) return undefined;
  const info = await modelInfoOf(resolved.provider, resolved.model);
  if (!shouldAskPhotoOrient(resolved.provider.id, imageSupportFor(resolved.provider.id, info))) {
    return undefined;
  }
  return { ...resolved, info };
}

/** 画面から届く、向きを尋ねる写し（見えている向きから回した角度ごと） */
interface OrientProbeInput {
  id: string;
  /** 見えている写真の幅と高さ（見開きを推せなかったとき、回したあとの縦横比で切り方を決める） */
  width: number;
  height: number;
  images: { turn: number; base64: string }[];
}

function readOrientProbe(message: Record<string, unknown>): OrientProbeInput | undefined {
  if (typeof message.id !== "string" || !Array.isArray(message.images)) return undefined;
  const { width, height } = message;
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0)) {
    return undefined;
  }
  const images: { turn: number; base64: string }[] = [];
  for (const item of message.images) {
    if (typeof item !== "object" || item === null) continue;
    const one = item as Record<string, unknown>;
    if (
      typeof one.turn === "number" &&
      (ORIENT_PROBE_TURNS as readonly number[]).includes(one.turn) &&
      typeof one.base64 === "string" &&
      one.base64.length > 0
    ) {
      images.push({ turn: one.turn, base64: one.base64 });
    }
  }
  return images.length > 0 ? { id: message.id, width, height, images } : undefined;
}

/**
 * 1枚の写真に掛けてよい時間（ミリ秒）。手元の gemma4:26b は読み込みに約30秒、
 * 1回約10秒で、1枚に2〜3回尋ねる（2026-10-12）。これを過ぎたら黙って諦める
 */
const ORIENT_TIMEOUT_MS = 90_000;

/**
 * 写真の向きを、手元のAIへ1枚ずつ順に尋ねる（設計書6.117.11）。
 *
 * **1枚ずつ**にするのは、同じ手元のAIへ同時に投げると、どれも遅くなるうえ
 * メモリを取り合うため。**失敗は黙って元のまま**（画面は縦横比の既定のまま）で、
 * 理由はログに1行だけ残す。作者が回した・外した写真、書き起こしを始めたときは
 * 尋ねるのをやめる。
 */
class PhotoOrientQueue {
  private readonly waiting: OrientProbeInput[] = [];
  private current: { id: string; abort: AbortController } | undefined;
  private running = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly registry: AIRegistry,
    private readonly work: WorkEntry
  ) {}

  add(probe: OrientProbeInput): void {
    this.cancel(probe.id);
    this.waiting.push(probe);
    void this.drain();
  }

  cancel(id: string): void {
    const index = this.waiting.findIndex((one) => one.id === id);
    if (index >= 0) this.waiting.splice(index, 1);
    if (this.current?.id === id) this.current.abort.abort();
  }

  stopAll(): void {
    this.waiting.length = 0;
    this.current?.abort.abort();
  }

  /** 画面を閉じたあとに届いた答えは捨てる（閉じた画面へ送ると例外になる） */
  private post(message: Record<string, unknown>): void {
    try {
      void this.panel.webview.postMessage(message);
    } catch {
      // 閉じた画面。知らせる先が無い
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let probe = this.waiting.shift(); probe; probe = this.waiting.shift()) {
        const abort = new AbortController();
        this.current = { id: probe.id, abort };
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, ORIENT_TIMEOUT_MS);
        try {
          await this.askOne(probe, abort.signal, () => timedOut);
        } finally {
          clearTimeout(timer);
          this.current = undefined;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async askOne(
    probe: OrientProbeInput,
    signal: AbortSignal,
    timedOut: () => boolean
  ): Promise<void> {
    const ai = await resolveOrientAi(this.registry);
    if (!ai) {
      this.post({ type: "orientResult", id: probe.id });
      return;
    }
    const numCtx = Math.min(PHOTO_ORIENT_NUM_CTX, ai.info?.contextWindow ?? PHOTO_ORIENT_NUM_CTX);
    const probes: PhotoOrientProbe[] = [];
    let failure: string | undefined;
    // 製品の順（ORIENT_PROBE_TURNS）に尋ね、2つ一致したら残りは尋ねない
    for (const turn of ORIENT_PROBE_TURNS) {
      const image = probe.images.find((one) => one.turn === turn);
      if (!image) continue;
      if (signal.aborted) break;
      try {
        const result = await ai.provider.generate({
          ...buildPhotoOrientRequest({
            image: { mimeType: "image/jpeg", base64: image.base64 },
            model: ai.model,
            numCtx,
          }),
          signal: signal,
          meta: { feature: PHOTO_ORIENT_FEATURE, workFolder: this.work.folderPath },
        });
        probes.push({ turn, answer: parsePhotoOrient(result.text) });
      } catch (error) {
        if (signal.aborted || (error instanceof AIError && error.kind === "aborted")) break;
        failure = describeAIError(error);
        break;
      }
      if (photoOrientSettled(probes)) break;
    }
    if (signal.aborted) {
      // 作者が回した・外した・書き起こしを始めた、か時間切れ。作者の操作で止めたときはログに残さない
      if (timedOut()) {
        logStep(
          `写真の向き：手元のAI（${ai.model}）が${ORIENT_TIMEOUT_MS / 1000}秒のうちに答えなかったので、推しませんでした（P-49 ${PHOTO_ORIENT_VERSION}）。`
        );
      }
      this.post({ type: "orientResult", id: probe.id });
      return;
    }
    const guess = combinePhotoOrient(probes);
    if (failure) {
      logStep(`写真の向き：手元のAIに尋ねられなかったので、推しませんでした（${failure}）。`);
    } else if (!guess) {
      logStep(
        `写真の向き：手元のAI（${ai.model}）の${probes.length}回の答えが揃わなかったので、推しませんでした（P-49 ${PHOTO_ORIENT_VERSION}）。`
      );
    }
    this.post({
      type: "orientResult",
      id: probe.id,
      ...(guess
        ? { ...placePhotoByGuess(guess, probe.width, probe.height), label: describePhotoOrientGuess(guess) }
        : {}),
    });
  }
}

function readPages(raw: unknown): PageInput[] {
  if (!Array.isArray(raw)) return [];
  const pages: PageInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const page = item as Record<string, unknown>;
    if (
      typeof page.id === "string" &&
      typeof page.label === "string" &&
      typeof page.mimeType === "string" &&
      typeof page.base64 === "string" &&
      page.base64.length > 0
    ) {
      pages.push({ id: page.id, label: page.label, mimeType: page.mimeType, base64: page.base64 });
    }
  }
  return pages;
}

/**
 * 1ページずつ書き起こす。**1ページの失敗で残りを止めない**（失敗はそのページに出す）。
 * 中止されたら、残りのページには「中止しました」を出して終える。
 */
async function transcribePages(
  panel: vscode.WebviewPanel,
  work: WorkEntry,
  registry: AIRegistry,
  pages: readonly PageInput[],
  photos: number,
  /** 作者からの頼み（検査済み。空なら添えない） */
  request: string,
  signal: AbortSignal
): Promise<void> {
  const resolved = await ensureConfigured(registry, "transcribe");
  if (!resolved) return failAll(panel, pages, "AIが決まっていないので書き起こしませんでした。");

  /*
    **既定へ落ちた先が写真を読めないなら、始めない**（設計書6.117.4）。
    `resolve` は割当先が使えないとき既定へ黙って落とすが、文字だけのAIへ
    写真を回すと、写真を見ないまま作文が返る
  */
  const info = await modelInfoOf(resolved.provider, resolved.model);
  const support = imageSupportFor(resolved.provider.id, info);
  if (!canSendImages(support)) {
    const PICK = "AIを選ぶ";
    const answer = await vscode.window.showWarningMessage(
      `${resolved.provider.displayName}（${resolved.model}）へは写真を送れません。`,
      { modal: true, detail: support.kind === "no" ? support.reason : undefined },
      PICK
    );
    if (answer === PICK) {
      const { assignOneFeatureAI } = await import("./assignFeatureAI.js");
      await assignOneFeatureAI(registry, "transcribe");
      await postAiState(panel, registry);
    }
    return failAll(panel, pages, "写真を読めるAIを選んでから、もう一度［書き起こす］を押してください。");
  }

  // **繋がるかを、送る確認より先に確かめる**（設計書6.51）
  if (!(await confirmProviderReachable(resolved.provider, "写真の書き起こし", resolved.model))) {
    return failAll(panel, pages, "AIにつながらなかったので書き起こしませんでした。");
  }

  // **外へ送る前の確認は毎回出す**（設計書6.117.5。「以降は訊かない」を付けない）
  const confirm = describePhotoSend({
    providerId: resolved.provider.id,
    providerName: resolved.provider.displayName,
    model: resolved.model,
    pages: pages.length,
    photos,
    isPaid: resolved.provider.isPaid,
    request,
  });
  const answer = await vscode.window.showWarningMessage(
    confirm.message,
    { modal: true, detail: confirm.detail },
    confirm.proceed
  );
  if (answer !== confirm.proceed) {
    return failAll(panel, pages, "送るのをやめました。");
  }

  logStep(
    `写真の書き起こし：${pages.length}ページ → ${resolved.provider.displayName}（${resolved.model}）` +
      `（P-48 ${PHOTO_TRANSCRIBE_VERSION}）` +
      // 頼みの文は記録に書かない（長さだけ。どの頼みで読んだかは画面に残っている）
      (request === "" ? "" : `・頼みあり（${countPhotoRequestChars(request)}字）`)
  );
  const requestEchoes = photoRequestEchoes(request);
  // 手元のAIへは num_ctx を明示する（写真の分は文字数の見積もりに入らない。規則6）
  const numCtx = Math.min(PHOTO_TRANSCRIBE_NUM_CTX, info?.contextWindow ?? PHOTO_TRANSCRIBE_NUM_CTX);

  let done = 0;
  for (const page of pages) {
    if (signal.aborted) {
      void panel.webview.postMessage({ type: "pageResult", id: page.id, ok: false, error: "中止しました。" });
      continue;
    }
    void panel.webview.postMessage({
      type: "running",
      on: true,
      text: `${page.label}を書き起こしています…（${done + 1}／${pages.length}）`,
    });
    try {
      const result = await resolved.provider.generate({
        ...buildPhotoTranscribeRequest({
          pageLabel: page.label,
          image: { mimeType: page.mimeType, base64: page.base64 },
          model: resolved.model,
          numCtx,
          request,
        }),
        signal: signal,
        /*
          **1行の中で同じ並びが続いたら、流しの途中で受け取りをやめる**（残課題 A17）。
          gemma4:26b の実測（2026-10-11）：逆向きの写真で、1行の中に同じ9字を
          903回書き続けて上限まで待った。流さないAIでは、届いたあとで切り詰める
        */
        stopWhen: (content) => endsWithInlineRepetition(content) !== undefined,
        meta: { feature: PHOTO_TRANSCRIBE_FEATURE, workFolder: work.folderPath },
      });
      const { parse: parsed, repeatStopped } = parsePhotoTranscriptionStoppingRepeats(
        result.text,
        { requestEchoes }
      );
      if (repeatStopped) {
        logStep(`写真の書き起こし：${page.label}で同じ字が続いたので、1つ目の並びで切りました。`);
      }
      if (!parsed.ok) {
        logFailure("写真の書き起こし", { ページ: page.label, 詳細: parsed.reason });
        void panel.webview.postMessage({
          type: "pageResult",
          id: page.id,
          ok: false,
          /*
            途中で切れた答えは、向きの違う写真で起きやすい。繰り返しで止めた回は
            理由にその旨が入っているので、重ねて添えない
          */
          error:
            result.truncated && !repeatStopped
              ? `${parsed.reason}答えが途中で切れました。写真の向きをお確かめください。`
              : parsed.reason,
        });
      } else {
        void panel.webview.postMessage({
          type: "pageResult",
          id: page.id,
          ok: true,
          text: parsed.value.text,
          latin: parsed.value.latinRuns.length,
          descriptive: parsed.value.descriptiveLines.length,
          droppedEchoes: parsed.value.droppedEchoes,
          exampleChars: parsed.value.exampleChars,
          stoppedEarly: result.stoppedEarly !== undefined,
          repeatStopped,
          // 繰り返しで止めた回は、切れたのはこちらが止めたからなので「途中で切れた」と言わない
          truncated: result.truncated && !repeatStopped,
        });
      }
    } catch (error) {
      const aborted = signal.aborted || (error instanceof AIError && error.kind === "aborted");
      if (!aborted) {
        logFailure("写真の書き起こし", {
          ページ: page.label,
          種別: error instanceof AIError ? error.kind : "unknown",
          内容: describeAIError(error),
        });
      }
      void panel.webview.postMessage({
        type: "pageResult",
        id: page.id,
        ok: false,
        error: aborted ? "中止しました。" : `書き起こせませんでした：${describeAIError(error)}`,
      });
    }
    done += 1;
  }
}

function failAll(panel: vscode.WebviewPanel, pages: readonly PageInput[], reason: string): void {
  for (const page of pages) {
    void panel.webview.postMessage({ type: "pageResult", id: page.id, ok: false, error: reason });
  }
}

/**
 * 新しい話として保存する（設計書6.117.6）。
 *
 * **既存の話の作成の道を通る**（`writeNewEpisodes`。`mode: "create"` だけで、
 * 既にあれば書かない。手元のいちばん新しい話の文字コード・改行で書く）。
 */
async function saveAsNewEpisode(
  work: WorkEntry,
  text: string,
  deps: PhotoTranscribeDeps
): Promise<void> {
  useLogFile(work.folderPath);
  let scan: Awaited<ReturnType<typeof scanWork>>;
  try {
    scan = await scanWork(work);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `「${work.title}」の原稿を読めませんでした：${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  const number = nextChapterNumber(
    scan.episodes.map((episode) => parseEpisodeFileName(episode.fileName))
  );
  const ext = vscode.workspace.getConfiguration("novelai").get<string>("episodeFileExtension", ".txt");
  const file: MissingEpisodeFile = {
    order: number,
    label: "写真から起こした話",
    part: null,
    number,
    defaultFileName: `${String(number).padStart(3, "0")}${ext}`,
    renamable: true,
    content: { kind: "text", text: ensureTrailingNewline(text) },
  };
  const existing = scan.episodes.map((episode) =>
    path.relative(scan.manuscriptDir, episode.filePath).replace(/\\/g, "/")
  );
  const naming = nameNewEpisodes([file], scan, existing);
  const suggested = naming.named[0]?.name ?? file.defaultFileName;

  const name = (
    await askText({
      title: "新しい話のファイル名",
      prompt: `「${path.basename(scan.manuscriptDir)}」の中に新しく作ります。既存の話には触りません。`,
      value: suggested,
      valueSelection: [0, suggested.length - path.extname(suggested).length],
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed === "") return "ファイル名を入力してください";
        if (/[\\:*?"<>|]/.test(trimmed)) return "ファイル名に使えない文字が含まれています";
        const e = path.extname(trimmed).toLowerCase();
        if (e !== ".txt" && e !== ".md") return "拡張子は .txt か .md にしてください";
        if (existing.some((one) => one.toLowerCase() === trimmed.toLowerCase())) {
          return "同じ名前の話が既にあります（上書きしません）";
        }
        return null;
      },
    })
  )?.trim();
  if (!name) return;

  const result = await writeNewEpisodes(work, scan, [{ file, name }]);
  if (result.added.length === 0) {
    void vscode.window.showErrorMessage(
      result.skipped[0]?.reason ?? "新しい話を作れませんでした。"
    );
    return;
  }
  const added = result.added[0].path;
  logStep(`写真の書き起こし：新しい話として保存（${name}）`);
  deps.refreshTree(work);
  await deps.rebaseline(work);
  await deps.openEpisode(work, added);
  void vscode.window.showInformationMessage(`新しい話「${name}」として保存しました。`);
}

/** 新しい話の末尾は改行で終える（手元の話の流儀に揃えるのは書く側〈encodeForNewFile〉） */
function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** 差し込む先。原稿エディターは行しか知らせないので、そのときは行の頭 */
interface InsertTarget {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  /** 確かめの窓に出す言い方 */
  readonly where: string;
}

/**
 * 開いている話のカーソルの行へ差し込む（設計書6.117.6）。
 *
 * **開いている文書へは `WorkspaceEdit` で入れる**（口述の整文・付箋の行と
 * 同じ流儀）。Ctrl+Z で戻せ、保存は VS Code が文字コードを保ったまま行う。
 * `writeTextFilePreservingFormat` を使わないのは、開いている文書に未保存の
 * 変更があると必ず断るうえ、書いた中身が開いている画面と食い違うため。
 */
async function insertAtCaret(work: WorkEntry, text: string): Promise<void> {
  const target = findInsertTarget(work);
  if (!target) {
    void vscode.window.showInformationMessage(
      `差し込む話が開いていません。「${work.title}」の話を原稿エディターで開き、差し込みたい行にカーソルを置いてから押してください。`
    );
    return;
  }
  const body = text.replace(/\s+$/u, "");
  const lineCount = body.split("\n").length;
  const INSERT = "差し込む";
  const answer = await vscode.window.showInformationMessage(
    `${target.where}に、書き起こした ${lineCount}行（${body.length}字）を差し込みますか？`,
    { modal: true, detail: "差し込んだあとは、その話の画面で Ctrl+Z で戻せます。保存はいつもどおりです。" },
    INSERT
  );
  if (answer !== INSERT) return;

  // 確かめの窓を出している間に、その行が消えていないか（行が減った等）
  if (target.document.isClosed || target.position.line >= target.document.lineCount) {
    void vscode.window.showWarningMessage("差し込む先の行が変わったので、差し込みませんでした。もう一度お試しください。");
    return;
  }
  const atLineHead = target.position.character === 0;
  const insertion = atLineHead ? `${body}\n` : body;
  const change = new vscode.WorkspaceEdit();
  change.insert(
    target.document.uri,
    target.position,
    // 新しく作る改行は文書の宣言に合わせる（既にある行には触らない）
    fromLfText(insertion, target.document.eol === vscode.EndOfLine.CRLF)
  );
  if (!(await vscode.workspace.applyEdit(change))) {
    void vscode.window.showWarningMessage("差し込めませんでした。もう一度お試しください。");
    return;
  }
  logStep(`写真の書き起こし：${path.fromUri(target.document.uri)} の ${target.position.line + 1}行目へ差し込み`);
  void vscode.window.showInformationMessage(`${target.where}に差し込みました。`);
}

function findInsertTarget(work: WorkEntry): InsertTarget | undefined {
  /*
    原稿エディターで最後にカーソルがあった話。**いま原稿エディターで開いていて、
    この作品の中にあるときだけ**（閉じた話や別の作品へは入れない）
  */
  const caret = lastManuscriptCaret();
  if (caret && isInsideWork(work.folderPath, caret.filePath)) {
    const uri = path.toUri(caret.filePath).toString();
    const open = openManuscriptTabUris().some((one) => one.toString() === uri);
    const document = vscode.workspace.textDocuments.find((one) => one.uri.toString() === uri);
    if (open && document && caret.line >= 1 && caret.line <= document.lineCount) {
      return {
        document,
        position: new vscode.Position(caret.line - 1, 0),
        where: `「${path.basename(caret.filePath)}」の ${caret.line}行目の前`,
      };
    }
  }
  // 素のエディターで見えている、この作品の話
  for (const editor of vscode.window.visibleTextEditors) {
    const filePath = path.fromUri(editor.document.uri);
    if (!isInsideWork(work.folderPath, filePath)) continue;
    const position = editor.selection.active;
    return {
      document: editor.document,
      position,
      where: `「${path.basename(filePath)}」の ${position.line + 1}行目のカーソルの位置`,
    };
  }
  return undefined;
}

/** バイト列を base64 にする（ブラウザ版でも動く `btoa`。一度に渡すと引数の数の上限に当たる） */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
