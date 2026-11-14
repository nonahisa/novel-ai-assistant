import { DEFAULT_MEMO_MARKERS, type MemoMarkers } from "../../../src/core/memoMarkers";

/**
 * `core/memoMarkerStore.ts` の代役（設計書6.40.8）。作品の設定ファイルを読まずに、
 * 既定の印（`//` と `／／`）を返す。設定ファイルを読む道を持たない流れのテスト
 * （`vscode.workspace.fs` を一部だけ差し替えたもの）で使う：
 *
 *   vi.mock("../../../src/core/memoMarkerStore", () => import("../support/memoMarkerStoreStub"));
 */
export async function readMemoMarkers(): Promise<MemoMarkers> {
  return DEFAULT_MEMO_MARKERS;
}

export async function readMemoMarkersForFile(): Promise<MemoMarkers> {
  return DEFAULT_MEMO_MARKERS;
}

export function cachedMemoMarkersForPath(): MemoMarkers | undefined {
  return undefined;
}

export function onDidChangeMemoMarkers(): { dispose(): void } {
  return { dispose: () => undefined };
}

export async function writeMemoMarkers(): Promise<MemoMarkers> {
  return DEFAULT_MEMO_MARKERS;
}

export { DEFAULT_MEMO_MARKERS };
