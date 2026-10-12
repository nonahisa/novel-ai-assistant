import { POSTING_SITES } from "../models/posting";

/**
 * 投稿サイトのリンクを開くブラウザが Chrome かどうか（作者の依頼 2026-10-12）。
 *
 * 作者の言葉：「リンクのブラウザの違いはユーザーに分からないかもしれない。
 * Chrome 以外が開く場合、初回のみヘルパー含め解説を入れてあげてください」。
 *
 * 製品はリンクを `vscode.env.openExternal` で開くので、開くのは**作者の既定の
 * ブラウザ**（作者の機械では Edge）である。読者の反応を取り込むヘルパーは
 * Chrome の拡張機能なので、Edge で開いた管理画面ではヘルパーが働かない。
 *
 * ## 決め方
 *
 * 1. VS Code の設定 `workbench.externalBrowser` が入っていれば、それが開く
 *    （名前〈`chrome`・`edge`・`firefox`〉か、実行ファイルのパス）
 * 2. 空なら OS の既定。Windows では登録簿の ProgId（`ChromeHTML` など）で見る
 * 3. **読めなければ「分からない」**——推し量って案内を出さない
 *
 * ここは VS Code にも Node にも依存しない（登録簿を読むのは
 * `externalBrowserWindows.ts`。動的 import で呼ぶ）。
 */

/** 開くブラウザについて分かったこと */
export interface BrowserGuess {
  readonly chrome: boolean;
  /** 画面に出す名前。分からなければ undefined（「既定のブラウザ」と書く） */
  readonly name?: string;
}

/** 名前が分からないときの呼び方 */
export const DEFAULT_BROWSER_LABEL = "既定のブラウザ";

/**
 * `workbench.externalBrowser` の値から。空なら undefined（OS の既定を見に行く）。
 *
 * 値は名前（`chrome` など）か実行ファイルのパス。パスはファイル名で見る
 * （`C:\Program Files\Google\Chrome\Application\chrome.exe`）。
 */
export function browserFromSetting(value: unknown): BrowserGuess | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const base = (trimmed.split(/[\\/]/).pop() ?? trimmed)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (base === "chrome" || base.startsWith("google-chrome") || base === "google chrome") {
    return { chrome: true, name: "Google Chrome" };
  }
  if (base === "edge" || base === "msedge") return { chrome: false, name: "Microsoft Edge" };
  if (base === "firefox") return { chrome: false, name: "Firefox" };
  if (base === "brave") return { chrome: false, name: "Brave" };
  if (base === "opera") return { chrome: false, name: "Opera" };
  // 知らない名前・パスは Chrome ではない、とだけ分かる（名前は推し量らない）
  return { chrome: false };
}

/**
 * Windows の既定のブラウザの ProgId から。空・読めなければ undefined（案内しない）。
 *
 * ProgId は前方一致で見る——Firefox は `FirefoxURL-308046B0AF4A39CB` のように
 * 後ろに入れた場所ごとの印が付く。Chrome のベータ・開発版は `ChromeBHTML` などになる。
 */
export function browserFromProgId(progId: string | undefined): BrowserGuess | undefined {
  const id = (progId ?? "").trim();
  if (!id) return undefined;
  if (/^Chrome/i.test(id)) return { chrome: true, name: "Google Chrome" };
  if (/^MSEdge/i.test(id)) return { chrome: false, name: "Microsoft Edge" };
  if (/^FirefoxURL/i.test(id)) return { chrome: false, name: "Firefox" };
  if (/^BraveHTML/i.test(id)) return { chrome: false, name: "Brave" };
  if (/^Opera/i.test(id)) return { chrome: false, name: "Opera" };
  if (/^IE\.HTTPS?$/i.test(id)) return { chrome: false, name: "Internet Explorer" };
  return { chrome: false };
}

/**
 * `reg query …\UserChoice /v ProgId` の出力から ProgId を拾う。
 * 形：`    ProgId    REG_SZ    MSEdgeHTM`。拾えなければ undefined
 */
export function parseRegProgId(stdout: string): string | undefined {
  const match = /^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/im.exec(stdout);
  return match?.[1];
}

/**
 * ヘルパーが働くサイトのリンクか（案内を出す対象）。
 *
 * 投稿サイト4つ（`POSTING_SITES` のドメインとその下）と、なろうの数を読む分析サイト
 * Narou.fun（`db.narou.fun`。6.79.7）。**それ以外のリンク（公募の要項・GitHub など）には
 * 案内を出さない**——ヘルパーと関わりが無いページで Chrome を勧める筋は無い。
 */
export function isHelperSiteUrl(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  const domains = [...POSTING_SITES.map((site) => site.domain), "narou.fun"];
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * 案内を出すか。出すなら、開くブラウザの名前。
 *
 * @param input.setting `workbench.externalBrowser` の値
 * @param input.progId 既定のブラウザの ProgId（設定が空のときだけ要る。読めなければ undefined）
 * @param input.shown もう一度出したか
 */
export function decideSiteLinkGuide(input: {
  setting: unknown;
  progId?: string;
  shown: boolean;
}): { readonly show: false } | { readonly show: true; readonly browserName: string } {
  if (input.shown) return { show: false };
  const guess = browserFromSetting(input.setting) ?? browserFromProgId(input.progId);
  // 読めなければ出さない（推し量らない）。Chrome なら出す理由が無い
  if (!guess || guess.chrome) return { show: false };
  return { show: true, browserName: guess.name ?? DEFAULT_BROWSER_LABEL };
}
