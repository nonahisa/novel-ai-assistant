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
});
