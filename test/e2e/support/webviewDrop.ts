/**
 * 画面（WebView）から拡張機能へ向かう便を、種類を名指しして落とす仕掛け（テストの側だけ。製品には何も足さない）。
 *
 * VS Code の WebView の外側の枠（`pre/index.html`）は、内側の枠の `postMessage` を
 * MessagePort で本体へ渡す。前は、開いたあとで外側の枠の `MessagePort.prototype.postMessage`
 * をくるめば落とせた。**VS Code 1.147 からは、外側の枠が読み込みの最初に
 * `MessagePort.prototype.postMessage` を控えて、その控えで送る**ので、あとからくるんでも効かない
 * （2026-11-19 に確かめた。1.147.0 の `pre/index.html` の `nativePortPostMessage`）。
 *
 * そこで、**枠の読み込みより前に**くるむ。起こした VS Code の文脈に初めの台本
 * （`addInitScript`）を置き、外側の枠でだけ `MessagePort.prototype.postMessage` をくるむ。
 * くるみは、枠の `__e2eDropTypes` に名前がある種類の `onmessage` の便だけを落とし、ほかは通す。
 * テストは落としたいときに `dropMessagesToHost` で名前を足す（足すまでは何も落とさない）。
 * 遅らせたいときは `delayMessagesToHost`（同じ長さだけ遅らせるので、便どうしの順は変わらない）。
 * 古い VS Code（控えない版）でも同じくるみが効く。
 */
import type { ElectronApplication, Frame } from "playwright-core";

/** 外側の枠で走らせる初めの台本。文字列で渡す（Playwright が各枠の読み込みの前に流す） */
export const WEBVIEW_DROP_INIT_SCRIPT = `(() => {
  try {
    if (location.protocol !== "vscode-webview:") return;
    if (!/\\/index\\.html$/.test(location.pathname)) return;
    const proto = MessagePort.prototype;
    if (proto.__e2eDropInstalled) return;
    proto.__e2eDropInstalled = true;
    const original = proto.postMessage;
    proto.postMessage = function (...args) {
      const message = args[0];
      const types = self.__e2eDropTypes;
      const delays = self.__e2eDelayTypes;
      if (message && message.channel === "onmessage") {
        const type = message.data && message.data.message && message.data.message.type;
        if (typeof type === "string") {
          if (types && types.has(type)) return;
          const ms = delays && delays.get(type);
          if (typeof ms === "number") {
            setTimeout(() => original.apply(this, args), ms);
            return;
          }
        }
      }
      return original.apply(this, args);
    };
  } catch (error) {
    // 台本の失敗で画面を止めない（落とせなければ、テストの側の待ちが知らせる）
  }
})();`;

/** 起こした VS Code に、上の台本を置く。窓や WebView を開く前に呼ぶ */
export async function installWebviewDrop(app: ElectronApplication): Promise<void> {
  await app.context().addInitScript(WEBVIEW_DROP_INIT_SCRIPT);
}

/**
 * 画面から拡張機能へ向かう便のうち、`types` の種類だけを落とし始める。
 * `frame` は原稿の面（内側の枠）。名前は外側の枠に置く（枠を作り直すと消える）
 */
export async function dropMessagesToHost(frame: Frame, types: readonly string[]): Promise<void> {
  const outer = frame.parentFrame();
  if (!outer) throw new Error("WebView の外側の枠が見つかりません");
  const installed = await outer.evaluate((names) => {
    const target = self as unknown as { __e2eDropTypes?: Set<string> };
    const set = target.__e2eDropTypes ?? new Set<string>();
    for (const name of names) set.add(name);
    target.__e2eDropTypes = set;
    return (MessagePort.prototype as MessagePort & { __e2eDropInstalled?: boolean }).__e2eDropInstalled === true;
  }, [...types]);
  if (!installed) {
    throw new Error("便を落とす仕掛けが外側の枠に入っていません（installWebviewDrop を起こした直後に呼んでいるか）");
  }
}

/** `types` の種類の便を、落とさずに `delayMs` だけ遅らせて渡し始める */
export async function delayMessagesToHost(frame: Frame, types: readonly string[], delayMs: number): Promise<void> {
  const outer = frame.parentFrame();
  if (!outer) throw new Error("WebView の外側の枠が見つかりません");
  const installed = await outer.evaluate(
    ({ names, ms }) => {
      const target = self as unknown as { __e2eDelayTypes?: Map<string, number> };
      const map = target.__e2eDelayTypes ?? new Map<string, number>();
      for (const name of names) map.set(name, ms);
      target.__e2eDelayTypes = map;
      return (MessagePort.prototype as MessagePort & { __e2eDropInstalled?: boolean }).__e2eDropInstalled === true;
    },
    { names: [...types], ms: delayMs }
  );
  if (!installed) {
    throw new Error("便を遅らせる仕掛けが外側の枠に入っていません（installWebviewDrop を起こした直後に呼んでいるか）");
  }
}
