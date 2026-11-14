import { beforeEach } from "vitest";

/**
 * 単体テストの前に、**読み口を `vscode.workspace.fs` 側へ固定する**
 * （`core/fileRead.ts`）。
 *
 * 0.74.7 から、起動の熱い道（作品の走査・登録簿の整備・チューニング台帳）は
 * **手元では Node の `fs` で読む**ようになった。ところが単体テストも Node の
 * 上で動くので、何もしないと**本物のディスク**を読みにいってしまい、
 * `workspace.fs` に置いた記憶の中の作り物が丸ごと見えなくなる。
 *
 * **`vscode` を、ここで早々に読み込ませてはいけない。**
 * `vi.mock("vscode", () => ...)` で丸ごと差し替えるテストが20本以上あり、
 * 下ごしらえの段で `vscode` を評価してしまうと、**本物の代役が先に
 * 登録されて差し替えが効かなくなる**（実際に2本落ちた）。そのため
 * `core/fileRead.ts` の読み込みは各テストの直前まで遅らせる——
 * このころには差し替えの登録が済んでいる。
 *
 * **製品の道は変えない。** 差し込むのは試験の中だけで、
 * `fileRead.test.ts` は自分で `setFileReaderForTests(undefined)` に戻して
 * Node 側の振る舞いを確かめる。
 */
beforeEach(async () => {
  const { setFileReaderForTests, vscodeFileReaderForTests } = await import(
    "../../../src/core/fileRead"
  );
  setFileReaderForTests(vscodeFileReaderForTests());

  /*
    **書き込みの1手の置き換え（Node の rename）を止める**（`core/atomicWrite.ts`）。
    読み口と同じ理由で、そのままだと本物のディスクで名前を変えにいき、記憶の中の
    一時ファイルが見えずに落ちる。本物の道は `atomicWriteReplaceGap.test.ts` が見る。
    `atomicWrite` を `vi.mock` で丸ごと差し替える試験では口が無く、引くだけで vitest が投げる。
    差し替えた試験は本物の書き込みを通らないので、そのときは何もしない
  */
  const atomicWrite: { setOneStepReplaceForTests?: unknown } = await import("../../../src/core/atomicWrite");
  let setOneStep: unknown;
  try {
    setOneStep = atomicWrite.setOneStepReplaceForTests;
  } catch {
    setOneStep = undefined;
  }
  if (typeof setOneStep === "function") {
    (setOneStep as (value: false | undefined) => void)(false);
  }

  /*
    **手元のAI（Ollama・LM Studio）の口を `globalThis.fetch` へ回す**
    （`ai/fetchTimeouts.ts` の `localFetch`。2026-09-23）。

    製品では手元のAIは npm の undici の fetch で直接投げる（VS Code が
    差し替えた `globalThis.fetch` は、渡した待ち時間を捨てるため）。
    ところが手元のAIの試験の多くは `vi.stubGlobal("fetch", …)` で応答を
    作っており、製品の道のままだと**本物の通信へ出てしまう**。

    **呼ぶたびに `globalThis.fetch` を引く**（差し替えた後の値を見るため）。
    製品の道そのものは `localFetchBypassesPatch.test.ts` が、ここを
    `undefined` へ戻して本物の HTTP サーバーで見る。
  */
  const { setLocalFetchForTests } = await import("../../../src/ai/fetchTimeouts");
  setLocalFetchForTests((url, init) => globalThis.fetch(url, init));

  /*
    **作者の GitHub 名を引く道を「鍵なし」にする**（`features/authorGithubLogin.ts`。0.138.0）。
    採否を決める試験が、本物の gh の鍵で GitHub へ出ていかないように。
    名前を確かめる試験は、自分で鍵と引き方を渡す
  */
  const { setAuthorTokenSourceForTests } = await import("../../../src/features/authorGithubLogin");
  setAuthorTokenSourceForTests(async () => undefined);
});
