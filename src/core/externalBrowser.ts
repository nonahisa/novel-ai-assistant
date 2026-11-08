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
 * 2. 空なら OS の既定。Windows では登録簿の ProgId（`ChromeHTML` など）で、
 *    Mac では LaunchServices の https の受け手（`com.google.chrome` など。0.148.0）で見る
 * 3. **読めなければ「分からない」**——推し量って案内を出さない
 *
 * ここは VS Code にも Node にも依存しない（登録簿を読むのは `externalBrowserWindows.ts`、
 * Mac の記録を読むのは `externalBrowserMac.ts`。どちらも動的 import で呼ぶ）。
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
 * Mac の既定のブラウザのアプリの名札（bundle id）から（作者の決定 2026-11-08「Mac でも調べる」）。
 * 名札は大文字小文字が揃わない（`com.google.Chrome` と書く Mac もある）ので、小文字で見る。
 * Chrome のベータ・開発版・Canary は `com.google.chrome.beta` などになる
 */
export function browserFromBundleId(bundleId: string | undefined): BrowserGuess | undefined {
  const id = (bundleId ?? "").trim().toLowerCase();
  if (!id) return undefined;
  if (id === "com.google.chrome" || id.startsWith("com.google.chrome.")) {
    return { chrome: true, name: "Google Chrome" };
  }
  if (id === "com.apple.safari" || id === "com.apple.safaritechnologypreview") {
    return { chrome: false, name: "Safari" };
  }
  if (id.startsWith("com.microsoft.edgemac")) return { chrome: false, name: "Microsoft Edge" };
  if (id.startsWith("org.mozilla.firefox")) return { chrome: false, name: "Firefox" };
  if (id.startsWith("com.brave.browser")) return { chrome: false, name: "Brave" };
  if (id.startsWith("com.operasoftware.opera")) return { chrome: false, name: "Opera" };
  return { chrome: false };
}

/**
 * Mac の LaunchServices の記録（`com.apple.launchservices.secure.plist`）から、https を開くアプリの
 * 名札を拾う。`LSHandlers` のうち `LSHandlerURLScheme` が `https` の行の `LSHandlerRoleAll`。
 *
 * 中身は `plutil -convert json`（読めなければ `-convert xml1`）で文字にしたもの。どちらの形でも読む。
 * **拾えなければ undefined**（Safari のまま一度も既定を変えていない Mac には、https の行が無いことがある）
 */
export function parseLaunchServicesHttpsHandler(text: string): string | undefined {
  const root = text.trimStart().startsWith("<") ? parsePlistXml(text) : parseJson(text);
  if (!isRecord(root) || !Array.isArray(root.LSHandlers)) return undefined;
  for (const handler of root.LSHandlers) {
    if (!isRecord(handler)) continue;
    const scheme = handler.LSHandlerURLScheme;
    const role = handler.LSHandlerRoleAll;
    if (typeof scheme === "string" && scheme.toLowerCase() === "https" && typeof role === "string" && role.trim()) {
      return role.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * plist の XML を、要る分だけ読む（dict・array・key・string。数・日付・真偽・data は値を読まずに
 * 置き場だけ埋める）。plutil が整えて出すものだけを相手にするので、属性や CDATA は見ない
 */
function parsePlistXml(text: string): unknown {
  const tokens = text.match(/<\/?(?:dict|array)\s*>|<(?:dict|array)\s*\/>|<key>[^<]*<\/key>|<string>[^<]*<\/string>|<string\s*\/>|<(?:real|integer|date|data)>[^<]*<\/(?:real|integer|date|data)>|<(?:true|false)\s*\/>/g);
  if (!tokens) return undefined;
  const stack: Array<{ value: Record<string, unknown> | unknown[]; key?: string }> = [];
  let root: unknown;
  const put = (value: unknown): void => {
    const top = stack[stack.length - 1];
    if (!top) {
      root ??= value;
      return;
    }
    if (Array.isArray(top.value)) top.value.push(value);
    else if (top.key !== undefined) {
      top.value[top.key] = value;
      top.key = undefined;
    }
  };
  for (const token of tokens) {
    if (/^<(dict|array)\s*\/>$/.test(token)) {
      put(token.startsWith("<dict") ? {} : []);
    } else if (/^<(dict|array)\s*>$/.test(token)) {
      const value: Record<string, unknown> | unknown[] = token.startsWith("<dict") ? {} : [];
      put(value);
      stack.push({ value });
    } else if (/^<\/(dict|array)/.test(token)) {
      stack.pop();
    } else if (token.startsWith("<key>")) {
      const top = stack[stack.length - 1];
      if (top && !Array.isArray(top.value)) top.key = decodeXmlText(token.slice(5, -6));
    } else if (token.startsWith("<string>")) {
      put(decodeXmlText(token.slice(8, -9)));
    } else if (token.startsWith("<string")) {
      put("");
    } else {
      put(null);
    }
  }
  return root;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
 * @param input.progId Windows の既定のブラウザの ProgId（設定が空のときだけ要る。読めなければ undefined）
 * @param input.bundleId Mac の既定のブラウザのアプリの名札（同じく。読めなければ undefined）
 * @param input.shown もう一度出したか
 */
export function decideSiteLinkGuide(input: {
  setting: unknown;
  progId?: string;
  bundleId?: string;
  shown: boolean;
}): { readonly show: false } | { readonly show: true; readonly browserName: string } {
  if (input.shown) return { show: false };
  const guess =
    browserFromSetting(input.setting) ??
    browserFromProgId(input.progId) ??
    browserFromBundleId(input.bundleId);
  // 読めなければ出さない（推し量らない）。Chrome なら出す理由が無い
  if (!guess || guess.chrome) return { show: false };
  return { show: true, browserName: guess.name ?? DEFAULT_BROWSER_LABEL };
}
