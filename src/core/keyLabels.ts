import { isMacHost } from "./runtime";

/**
 * 画面に出すキーの名前を、作者の OS に合わせる（2026-11-07、Mac の実機の報告）。
 *
 * Mac では、キーの動きは ⌘ で効いていた（package.json の `mac` の割り当て）のに、
 * 知らせ・案内・マニュアルの文が「Ctrl+P で印刷」「Ctrl+Enterで送信」のまま出ていた。
 * **書き方の規則はこのファイルだけが持つ。** 画面ごとに「Mac なら ⌘」と書くと、
 * 片方だけ直したときに食い違う。画面の自動テストの部品（`test/e2e/support/keys.ts`）も
 * ここを読む（テストの部品を製品から読む向きにはしない）。
 *
 * ## 書き方（VS Code が Mac で出す札に合わせる。1.141.0 の `UILabelProvider` を引いて決めた）
 *
 * - Windows・Linux：修飾は「Ctrl」「Shift」「Alt」、つなぎは「+」（例「Ctrl+Alt+M」）
 * - Mac：修飾は記号「⌃」「⇧」「⌥」「⌘」、つなぎは無し（例「⌥⌘M」）
 * - **並びは OS によらず Ctrl → Shift → Alt → Cmd。** VS Code は押した順でなくこの順で並べる
 *   （`cmd+alt+m` も「⌘⌥M」でなく「⌥⌘M」と出る）
 *
 * ## 2つの入口
 *
 * - `keyLabel`：keybindings の書き方（`cmd+alt+m`）を札にする。`ctrl` は本当の Control（⌃）
 * - `keysInText`：人が書いた文の中の「Ctrl+Shift+P」「Ctrl+A → Ctrl+C」「Ctrl+ホイール」を直す。
 *   **文の中の「Ctrl」は「ふだんの修飾キー」の意味で書いてある**ので、Mac では ⌘ にする
 *   （VS Code の既定の割り当ても、この拡張機能の割り当ても、Mac では ctrl を cmd へ読み替えている。
 *   Mac でも Control のまま押すキーは、いまの割り当てには無い）。Windows・Linux では文を変えない
 *
 * WebView（原稿エディター・相談パネル・関係図）は作者の機械で描かれるので、そこでは
 * WebView の中で `navigator` を見て直す（`KEY_LABEL_SCRIPT`）。拡張機能の側の `process.platform` は、
 * リモート接続では拡張機能の居る機械の OS になってしまうため。
 */

/** キーの書き方を分ける OS の区分（Mac とそれ以外しか書き方が変わらない） */
export type KeyOs = "mac" | "other";

/** いま動いている所の区分（`runtime.isMacHost`） */
export function hostKeyOs(): KeyOs {
  return isMacHost() ? "mac" : "other";
}

interface HeldModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const MODIFIER_LABELS: Record<KeyOs, { ctrl: string; shift: string; alt: string; meta: string; separator: string }> = {
  mac: { ctrl: "⌃", shift: "⇧", alt: "⌥", meta: "⌘", separator: "" },
  other: { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "Windows", separator: "+" },
};

/** 修飾の札を VS Code と同じ並び（Ctrl → Shift → Alt → Cmd）でつなぐ */
function modifierPrefix(held: HeldModifiers, os: KeyOs): string[] {
  const labels = MODIFIER_LABELS[os];
  const pieces: string[] = [];
  if (held.ctrl) pieces.push(labels.ctrl);
  if (held.shift) pieces.push(labels.shift);
  if (held.alt) pieces.push(labels.alt);
  if (held.meta) pieces.push(labels.meta);
  return pieces;
}

/** 英数字・F キー以外のキーの札（製品で使っているもの。VS Code は記号をそのまま出す） */
const LABEL_KEYS: Record<string, string> = {
  "/": "/",
  "\\": "\\",
  ".": ".",
  ",": ",",
  ";": ";",
  "'": "'",
  "`": "`",
  "-": "-",
  "=": "=",
  "[": "[",
  "]": "]",
};

function keyLabelName(key: string, whole: string): string {
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  const label = LABEL_KEYS[key];
  if (label !== undefined) return label;
  throw new Error(`キー「${whole}」の「${key}」の札が分かりません（keyLabels.ts の LABEL_KEYS に足してください）`);
}

function chordLabel(chord: string, whole: string, os: KeyOs): string {
  const parts = chord.split("+");
  const last = parts.pop();
  if (last === undefined || last === "") throw new Error(`キー「${whole}」を読めません`);
  const held: HeldModifiers = { ctrl: false, shift: false, alt: false, meta: false };
  for (const part of parts) {
    if (part === "ctrl") held.ctrl = true;
    else if (part === "shift") held.shift = true;
    else if (part === "alt") held.alt = true;
    else if (part === "cmd" || part === "meta" || part === "win") held.meta = true;
    else throw new Error(`キー「${whole}」の修飾「${part}」を読めません`);
  }
  return [...modifierPrefix(held, os), keyLabelName(last, whole)].join(MODIFIER_LABELS[os].separator);
}

/**
 * keybindings の書き方のキー（`cmd+alt+m`・2段なら `ctrl+k ctrl+s`）を、VS Code が画面に出す札
 * （Mac は「⌥⌘M」、Windows は「Ctrl+Alt+M」）へ直す。2段は空白でつなぐ（VS Code の札と同じ）
 */
export function keyLabel(vscodeKey: string, os: KeyOs): string {
  const chords = vscodeKey.trim().toLowerCase().split(/\s+/);
  return chords.map((chord) => chordLabel(chord, vscodeKey, os)).join(" ");
}

/* ── 人が書いた文の中のキー ── */

/**
 * 文の中のキーの並び（修飾の列＋キー1つ）。WebView へも同じ字の並びを渡す（`KEY_LABEL_SCRIPT`）。
 *
 * - 前に英字が付いたもの（「XCtrl+」）はキーではない
 * - キーは英大文字・数字1字（後ろに英数字が続かない）、F キー、名前のあるキー、矢印、記号、全角の＋－＝、
 *   それと文の言葉（「ホイール」「マウスホイール」「文字」「…」）。**「Win+H」は Windows のキーなので触らない**
 */
const KEY_TOKEN_SOURCE =
  "(?<![A-Za-z])((?:(?:Ctrl|Shift|Alt|Cmd)\\+)+)" +
  "(マウスホイール|ホイール|文字|…|Enter|Esc|Delete|Home|End|Tab|Space|F(?:1[0-9]|2[0-4]|[1-9])(?![0-9])|[A-Z0-9](?![A-Za-z0-9])|[↑↓←→＋－＝/\\\\,.;=\\-])";

/** 修飾とキーのあいだに「+」を残す、言葉のキー（「⌘ホイール」は読みにくいので「⌘+ホイール」） */
const WORD_KEY_SOURCE = "^(マウスホイール|ホイール|文字)$";

/** Mac での1つぶんの書き方（`keysInText` と WebView の台本が同じ規則で書く。下の台本を直すときはここも） */
function macTextToken(modifiers: string, key: string): string {
  const held: HeldModifiers = { ctrl: false, shift: false, alt: false, meta: false };
  for (const name of modifiers.split("+")) {
    if (name === "Ctrl" || name === "Cmd") held.meta = true;
    else if (name === "Shift") held.shift = true;
    else if (name === "Alt") held.alt = true;
  }
  let shownKey = key;
  // やり直し：Windows の Ctrl+Y は、Mac では ⇧⌘Z（VS Code も WebView の本文も）
  if (held.meta && !held.shift && !held.alt && key === "Y") {
    held.shift = true;
    shownKey = "Z";
  }
  const prefix = modifierPrefix(held, "mac").join("");
  return new RegExp(WORD_KEY_SOURCE).test(shownKey) ? `${prefix}+${shownKey}` : prefix + shownKey;
}

/**
 * 文の中のキーの書き方を OS に合わせる。Windows・Linux では文をそのまま返す
 * （文は Windows の書き方で書いておく）。Mac では「Ctrl+Shift+P」→「⇧⌘P」、
 * 「Ctrl+A → Ctrl+C」→「⌘A → ⌘C」、「Alt+↑」→「⌥↑」、「Ctrl+ホイール」→「⌘+ホイール」
 */
export function keysInText(text: string, os: KeyOs): string {
  if (os !== "mac") return text;
  return text.replace(new RegExp(KEY_TOKEN_SOURCE, "g"), (_whole, modifiers: string, key: string) =>
    macTextToken(modifiers, key)
  );
}

/** `keysInText` を、いま動いている所の OS で（知らせ・確認の窓・マニュアルの文に使う） */
export function keysForHost(text: string): string {
  return keysInText(text, hostKeyOs());
}

/**
 * WebView の `<script>` の中に置く素の JS。2つの関数を定義する。
 *
 * - `novelaiKeys(text)`：`keysInText` と同じ直し方。Mac かどうかは WebView の中で
 *   `navigator.userAgentData.platform`（無ければ `navigator.platform`）から決める
 * - `novelaiApplyKeyLabels(root)`：`data-keys` の付いた要素の title・placeholder・aria-label と、
 *   子の要素を持たない要素の字を直す（HTML に書いた案内の字のため）。字はそのあとも見張り、
 *   台本が後から入れた知らせ（下の欄・保存できなかった知らせ）も直す。台本の文を1つずつ包まずに済み、
 *   **原稿の本文には data-keys を付けないので触らない**
 *
 * 字の並び（`KEY_TOKEN_SOURCE`）と言葉のキーはここから渡すので、決まりを2か所に写さない。
 * **この文字列の中にバッククォートも `${` も置かない**（埋め込む先がテンプレートリテラル）。
 */
export const KEY_LABEL_SCRIPT = [
  "var NOVELAI_KEY_MAC = (function () {",
  "  try {",
  "    var data = navigator.userAgentData;",
  "    var name = (data && data.platform) || navigator.platform || '';",
  "    return /mac/i.test(String(name));",
  "  } catch (error) {",
  "    return false;",
  "  }",
  "})();",
  `var NOVELAI_KEY_TOKEN = ${JSON.stringify(KEY_TOKEN_SOURCE)};`,
  `var NOVELAI_KEY_WORD = new RegExp(${JSON.stringify(WORD_KEY_SOURCE)});`,
  "function novelaiKeys(text) {",
  "  var source = String(text);",
  "  if (!NOVELAI_KEY_MAC) return source;",
  "  return source.replace(new RegExp(NOVELAI_KEY_TOKEN, 'g'), function (whole, modifiers, key) {",
  "    var shift = false;",
  "    var alt = false;",
  "    var meta = false;",
  "    var names = modifiers.split('+');",
  "    for (var i = 0; i < names.length; i++) {",
  "      if (names[i] === 'Ctrl' || names[i] === 'Cmd') meta = true;",
  "      else if (names[i] === 'Shift') shift = true;",
  "      else if (names[i] === 'Alt') alt = true;",
  "    }",
  "    var shown = key;",
  "    if (meta && !shift && !alt && key === 'Y') { shift = true; shown = 'Z'; }",
  "    var prefix = (shift ? '\\u21e7' : '') + (alt ? '\\u2325' : '') + (meta ? '\\u2318' : '');",
  "    return NOVELAI_KEY_WORD.test(shown) ? prefix + '+' + shown : prefix + shown;",
  "  });",
  "}",
  "function novelaiKeyText(element) {",
  "  if (!element || element.children.length > 0 || !element.textContent) return;",
  "  var shown = novelaiKeys(element.textContent);",
  // 同じ字なら書かない（書くと見張りがまた呼ばれ、止まらなくなる）
  "  if (shown !== element.textContent) element.textContent = shown;",
  "}",
  "function novelaiApplyKeyLabels(root) {",
  "  if (!NOVELAI_KEY_MAC) return;",
  "  var found = (root || document).querySelectorAll('[data-keys]');",
  "  var names = ['title', 'placeholder', 'aria-label'];",
  "  for (var i = 0; i < found.length; i++) {",
  "    var element = found[i];",
  "    for (var j = 0; j < names.length; j++) {",
  "      var value = element.getAttribute(names[j]);",
  "      if (value !== null) element.setAttribute(names[j], novelaiKeys(value));",
  "    }",
  "    novelaiKeyText(element);",
  "    if (typeof MutationObserver === 'function') {",
  "      new MutationObserver(function (records) {",
  "        for (var k = 0; k < records.length; k++) {",
  "          var target = records[k].target;",
  "          novelaiKeyText(target.nodeType === 1 ? target : target.parentElement);",
  "        }",
  "      }).observe(element, { childList: true, characterData: true, subtree: true });",
  "    }",
  "  }",
  "}",
].join("\n");
