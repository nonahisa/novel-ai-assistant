import * as vscode from "vscode";
import * as paths from "../core/paths";

/**
 * 作品フォルダーの見張りを、**フォルダーごとに1本**へ束ねる（残課題 C2、0.84.4）。
 *
 * **束ねる理由。** VS Code 本体の拡張ホストは、開いているフォルダーの外に
 * 「サブフォルダーまで見る見張り」（パターンに `**` か `/` を含む
 * `RelativePattern`）を1本張るたびに、`files.watcherExclude` を場所の指定
 * なしで読んで警告を1件ログへ出す（1.138 の `ensureWatching`）。公開APIに
 * 止める口は無いので、**本数を減らすしかない**。以前は本文・同期・設定資料・
 * 単話プロットがそれぞれ作品ごとに張っており、作品16で42件出ていた。
 *
 * **仕組み。** 各機能は「この場所（根）の下で、この条件に合う変化を知らせて」
 * と `subscribe` する。ここは根ごとに `**\/*` の見張りを1本だけ張り、
 * 届いた知らせを条件（`accepts`）で絞って配る。条件の判定は
 * `core/folderWatchMatch.ts`（今の各見張りの glob と同じ結果になることを
 * テストが確かめる）。
 *
 * - **根が入れ子なら外側の1本で受ける。** 単話プロットの置き場
 *   （`設定/episode-plots` の1つ上）は作品フォルダーの中にあるので、
 *   作品フォルダーの見張りがあれば新しく張らない。外側が無ければ自分の根に
 *   張る（取りこぼさない）
 * - **書庫でも作品ごとに1本**。書庫の親フォルダーで1本にすると本数は
 *   もっと減るが、親には作品以外のもの（別のリポジトリ、`node_modules`
 *   など）も入りうる。再帰の見張りはその中身すべてを見るので重くなる。
 *   見る範囲を「登録した作品フォルダーの和」から広げない
 * - **知らせは1本の見張りからだけ配る。** 張り替えの一瞬に外側と内側の
 *   両方があっても、同じ知らせを2度配らない
 * - 見張りを張れない環境（古い VS Code・試験の代役）では何も配らない。
 *   各機能は、これまでどおり保存などの契機だけで動く
 */

export type FolderChangeKind = "create" | "change" | "delete";

export interface FolderWatchRequest {
  /**
   * どこの下を見てほしいか（多くは作品フォルダー）。見張りはここ、または
   * ここを含む別の根に張られる。**ここの外の知らせは配らない。**
   */
  readonly root: string;
  /** 知らせてほしいファイルか。今の各見張りの glob と同じ判定を入れる */
  readonly accepts: (filePath: string) => boolean;
  /** 知らせ。場所は `paths.fromUri(uri)` と同じ文字列でも渡す */
  readonly onEvent: (kind: FolderChangeKind, uri: vscode.Uri, filePath: string) => void;
}

interface Subscription {
  readonly request: FolderWatchRequest;
  readonly key: string;
  /** 知らせを受け取る見張りの鍵（自分の根か、それを含む外側の根） */
  coverKey: string | undefined;
}

interface ActiveWatcher {
  readonly root: string;
  readonly watcher: vscode.FileSystemWatcher;
}

/** 見張りを作る口。**試験で差し替えられるように**分けてある */
export type CreateFolderWatcher = (root: string) => vscode.FileSystemWatcher;

const createRecursiveWatcher: CreateFolderWatcher = (root) =>
  vscode.workspace.createFileSystemWatcher(
    // **文字列を直に渡さない。** `RelativePattern` は文字列を受けると中で
    // `Uri.file()` を呼び、ブラウザ版では無い場所を見張る（規則7）
    new vscode.RelativePattern(paths.toUri(root), "**/*")
  );

export class FolderWatchHub implements vscode.Disposable {
  private readonly subscriptions = new Set<Subscription>();
  private readonly watchers = new Map<string, ActiveWatcher>();
  private disposed = false;

  constructor(private readonly createWatcher: CreateFolderWatcher = createRecursiveWatcher) {}

  /** 捨てたあとか（共有の口が作り直すかを決める） */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** いま張っている見張りの根（試験と記録用） */
  get watchedRoots(): string[] {
    return [...this.watchers.values()].map((entry) => entry.root);
  }

  /**
   * 知らせを受け取る。返ってきたものを `dispose` すると受け取りをやめ、
   * 誰も使わなくなった見張りは外れる。
   */
  subscribe(request: FolderWatchRequest): vscode.Disposable {
    // `vscode.Disposable` を作らず素の形で返す（試験の代役に無いことがある）
    if (this.disposed) return { dispose: () => undefined };
    const subscription: Subscription = {
      request,
      key: paths.normalizeForComparison(request.root),
      coverKey: undefined,
    };
    this.subscriptions.add(subscription);
    this.reconcile();
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.subscriptions.delete(subscription);
        if (!this.disposed) this.reconcile();
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.watchers.values()) entry.watcher.dispose();
    this.watchers.clear();
    this.subscriptions.clear();
  }

  /**
   * 受け取り手に合わせて、見張りを張り・外す。
   *
   * **先に張ってから外す。** 外側の根が増えて内側の見張りが要らなくなった
   * とき、先に外すと、その間に来た知らせを落とす。
   */
  private reconcile(): void {
    const roots = new Map<string, string>();
    for (const subscription of this.subscriptions) {
      if (!roots.has(subscription.key)) {
        roots.set(subscription.key, subscription.request.root);
      }
    }
    // 他の根の中に入っている根は、外側の見張りで受ける
    const covers = new Map<string, string>();
    for (const [key, root] of roots) {
      const outer = [...roots.values()].some(
        (other) => other !== root && paths.isPathInside(other, root)
      );
      if (!outer) covers.set(key, root);
    }

    for (const [key, root] of covers) {
      if (this.watchers.has(key)) continue;
      let watcher: vscode.FileSystemWatcher | undefined;
      try {
        watcher = this.createWatcher(root);
        const entry: ActiveWatcher = { root, watcher };
        const dispatch = (kind: FolderChangeKind) => (uri: vscode.Uri) =>
          this.dispatch(key, entry, kind, uri);
        watcher.onDidCreate(dispatch("create"));
        watcher.onDidChange(dispatch("change"));
        watcher.onDidDelete(dispatch("delete"));
        this.watchers.set(key, entry);
      } catch {
        // 張れない・知らせの口が揃っていない（古い VS Code・試験の代役）なら
        // 張りかけのものを捨てて、その根には何も配らない。各機能は
        // 保存などの契機だけで動く（束ねる前と同じ扱い）
        watcher?.dispose();
      }
    }

    for (const subscription of this.subscriptions) {
      subscription.coverKey = [...covers.keys()].find(
        (key) =>
          key === subscription.key ||
          paths.isPathInside(covers.get(key) ?? "", subscription.request.root)
      );
    }

    for (const [key, entry] of this.watchers) {
      if (covers.has(key)) continue;
      entry.watcher.dispose();
      this.watchers.delete(key);
    }
  }

  private dispatch(
    key: string,
    entry: ActiveWatcher,
    kind: FolderChangeKind,
    uri: vscode.Uri
  ): void {
    // 外したあとに遅れて届いた知らせは配らない（張り替え後の見張りが配る）
    if (this.disposed || this.watchers.get(key) !== entry) return;
    const filePath = paths.fromUri(uri);
    // 配っている最中に受け取りをやめる機能があるので、写しを回す
    for (const subscription of [...this.subscriptions]) {
      if (subscription.coverKey !== key) continue;
      if (!paths.isPathInside(subscription.request.root, filePath)) continue;
      if (!subscription.request.accepts(filePath)) continue;
      subscription.request.onEvent(kind, uri, filePath);
    }
  }
}

let shared: FolderWatchHub | undefined;

/**
 * 拡張機能の中で共有する1つ。**製品の配線は必ずこれを渡す**——各機能が
 * 自前で作ると、束ねたことにならない（本数が元に戻るだけで、壊れはしない）。
 *
 * 各機能の既定は「自前の1つ」にしてある。試験が機能ごとに見張りを
 * 覗けるようにするためで、製品では `extension.ts` がこちらを渡す。
 * 捨てるのは `extension.ts`（`context.subscriptions`）。
 */
export function sharedFolderWatchHub(): FolderWatchHub {
  if (!shared || shared.isDisposed) shared = new FolderWatchHub();
  return shared;
}
