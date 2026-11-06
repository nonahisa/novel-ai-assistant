/**
 * 画面の自動テストで押すキーを、走っている OS に合わせて決める（Mac でも通すため。2026-11-06）。
 *
 * ## なぜ要るか
 *
 * キーを `Control+…` で決め打ちしていたので、Mac で初めて流したときに落ちた（製品の不具合ではない）。
 * 押すキーは3種類あり、それぞれ直し方が違う。
 *
 * 1. **VS Code 本体のキー**（Ctrl+S・Ctrl+P・Ctrl+A など）：Mac では Cmd。Playwright の `ControlOrMeta+…` を
 *    テストへ直接書く。ただし **Mac の割り当てが別の形のもの**はこのファイルの定数を使う
 *    （`EDITOR_TOP_PRESS` など。1.141.0 の既定の割り当てを引いて決めた）
 * 2. **製品のキー**（package.json の `contributes.keybindings`）：`key` と `mac` を読んで、OS に合うほうを返す
 *    （`productKey`）。決め打ちすると、package.json のキーを替えたときにテストだけ古いキーを押し続ける
 * 3. **テストが使い捨ての keybindings.json に足すキー**（`ctrl+alt+shift+…`）：そのまま `Control+…` でよい。
 *    VS Code の `ctrl` は Mac でも Control キーを指し、Playwright の `Control` も Mac で Control なので一致する
 *
 * **playwright も DOM も import しない。** 単体テスト（test/unit/cross/e2eKeys.test.ts）から読むので、
 * 画面の土台を引き込まないようにしている。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** package.json の `contributes.keybindings` の1件（使う所だけ） */
export interface ProductKeybinding {
  command: string;
  key: string;
  mac?: string;
}

const isMac = (platform: NodeJS.Platform): boolean => platform === "darwin";

/** VS Code の修飾キーの名前 → Playwright の名前 */
const MODIFIERS: Record<string, string> = {
  ctrl: "Control",
  cmd: "Meta",
  meta: "Meta",
  win: "Meta",
  alt: "Alt",
  shift: "Shift",
};

/** 英数字以外の、VS Code の書き方 → Playwright の `code` の名前（製品で使っているものと、その近く） */
const SPECIAL_KEYS: Record<string, string> = {
  "/": "Slash",
  "\\": "Backslash",
  ".": "Period",
  ",": "Comma",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  home: "Home",
  end: "End",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/**
 * VS Code の keybindings の書き方（`cmd+alt+k`・`ctrl+/`・`shift+f8`）を、Playwright の `keyboard.press` の
 * 書き方（`Meta+Alt+KeyK`・`Control+Slash`・`Shift+F8`）へ直す。
 *
 * 字のキーは `KeyK` の形（`code`）で送る。`k` のように字で送ると、Alt を添えたとき Mac では別の字（˚）に
 * 読まれるおそれがあるため、配列に左右されない `code` に揃える（いまのテストも全部この形）。
 * 2段のキー（`ctrl+k ctrl+s`）は1回の press で送れないので受けない。
 */
export function toPlaywrightChord(vscodeKey: string): string {
  const trimmed = vscodeKey.trim().toLowerCase();
  if (/\s/.test(trimmed)) {
    throw new Error(`2段のキー「${vscodeKey}」は1回の press では送れません（段ごとに分けて押してください）`);
  }
  // `ctrl+=` のように + 自体が字になる形は製品に無いので、素直に + で分ける
  const parts = trimmed.split("+");
  const last = parts.pop();
  if (last === undefined || last === "") throw new Error(`キー「${vscodeKey}」を読めません`);
  const modifiers = parts.map((part) => {
    const name = MODIFIERS[part];
    if (name === undefined) throw new Error(`キー「${vscodeKey}」の修飾「${part}」を読めません`);
    return name;
  });
  return [...modifiers, keyName(last, vscodeKey)].join("+");
}

function keyName(key: string, whole: string): string {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  const special = SPECIAL_KEYS[key];
  if (special !== undefined) return special;
  throw new Error(`キー「${whole}」の「${key}」を Playwright の名前へ直せません（keys.ts の SPECIAL_KEYS に足してください）`);
}

/** その OS で効く、keybindings.json の書き方のキー（`mac` が無ければ `key`） */
export function keybindingFor(binding: ProductKeybinding, platform: NodeJS.Platform = process.platform): string {
  return isMac(platform) && binding.mac !== undefined && binding.mac !== "" ? binding.mac : binding.key;
}

let cachedBindings: ProductKeybinding[] | undefined;

/** 製品の package.json の `contributes.keybindings`（実物を読む。テストの中に写さない） */
export function productKeybindings(): ProductKeybinding[] {
  if (cachedBindings === undefined) {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      contributes?: { keybindings?: ProductKeybinding[] };
    };
    cachedBindings = manifest.contributes?.keybindings ?? [];
  }
  return cachedBindings;
}

function findBinding(command: string): ProductKeybinding {
  const found = productKeybindings().filter((binding) => binding.command === command);
  if (found.length === 0) {
    throw new Error(`製品の package.json に「${command}」のキーがありません（キーを外したなら、テストの押し方も直してください）`);
  }
  if (found.length > 1) {
    throw new Error(`製品の package.json に「${command}」のキーが${found.length}つあります（どれを押すか決められません）`);
  }
  return found[0];
}

/**
 * 製品のコマンドを押すキー（Playwright の書き方）。Windows・Linux は `key`、Mac は `mac`（無ければ `key`）。
 * 例：`productKey("novelai.addEmphasis")` → Windows は `Control+Alt+KeyK`、Mac は `Meta+Alt+KeyK`
 */
export function productKey(command: string, platform: NodeJS.Platform = process.platform): string {
  return toPlaywrightChord(keybindingFor(findBinding(command), platform));
}

/**
 * 製品のコマンドのキーを、keybindings.json の書き方で返す（使い捨ての keybindings.json で製品のキーを
 * 外す `-` の行に使う。Mac で `ctrl+…` を外しても、製品の `cmd+…` は残る）
 */
export function productKeybinding(command: string, platform: NodeJS.Platform = process.platform): string {
  return keybindingFor(findBinding(command), platform);
}

/* ── 製品のキー（テストから押すもの。コマンドIDの打ち間違いをここ1か所に閉じる） ── */

export const CHECK_TYPOS_PRESS = productKey("novelai.checkTyposForFile");
export const CHECK_PROOFREAD_PRESS = productKey("novelai.checkProofread");
export const CHECK_NOTATION_PRESS = productKey("novelai.checkNotation");
export const OPEN_SCENE_MEMOS_PRESS = productKey("novelai.openSceneMemos");
export const ADD_SCENE_MEMO_PRESS = productKey("novelai.addSceneMemo");
export const ADD_EMPHASIS_PRESS = productKey("novelai.addEmphasis");

/* ── VS Code 本体のキーのうち、Mac の割り当てが Cmd＋同じキーでないもの（1.141.0 の既定を引いて決めた） ── */

/**
 * 文書の頭へ（`cursorTop`）。Windows は Ctrl+Home、Mac は Cmd+↑（Mac に Cmd+Home の割り当ては無い）。
 * 原稿エディターの組んで書く面（contenteditable）でも、Mac の Chromium は Cmd+↑ が文書の頭になる
 */
export const EDITOR_TOP_PRESS = isMac(process.platform) ? "Meta+ArrowUp" : "Control+Home";
/** 文書の末へ（`cursorBottom`）。Windows は Ctrl+End、Mac は Cmd+↓ */
export const EDITOR_BOTTOM_PRESS = isMac(process.platform) ? "Meta+ArrowDown" : "Control+End";
/**
 * 前に出ているエディターを閉じる（`workbench.action.closeActiveEditor`）。Windows は Ctrl+F4（Ctrl+W も効く）、
 * Mac は Cmd+W だけ。Windows は前から押していた Ctrl+F4 のまま残す
 */
export const CLOSE_ACTIVE_EDITOR_PRESS = isMac(process.platform) ? "Meta+KeyW" : "Control+F4";
