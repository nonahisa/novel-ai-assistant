import { describe, expect, it } from "vitest";
import {
  VSCODE_PROTOCOL_COMMAND_KEY,
  restoreProtocolHandler,
  snapshotProtocolHandler,
  withProtocolHandlerGuard,
} from "../../../scripts/protocolHandlerGuard.mjs";

/*
  試験用の VS Code が `vscode://` の受け手を書き換えたまま残す件（2026-10-17）。

  作者の機械で、`HKCU\Software\Classes\vscode\shell\open\command` が配布前の検査で
  起こした `.vscode-test` の 1.138.0 に書き換わっていた。入っている VS Code は
  取り返さないので、外部AIの run.request が作者の知らない試験版の窓を起こし、
  確認の窓が作者に見えなかった。

  試験の前に控え、終わったら（失敗しても）戻す。レジストリには本物で触らず、
  `reg` の呼び出しを差し替えて順番と引数を確かめる。
*/

interface Call {
  command: string;
  args: string[];
}

const BEFORE =
  "\r\nHKEY_CURRENT_USER\\Software\\Classes\\vscode\\shell\\open\\command\r\n" +
  '    (既定)    REG_SZ    "C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" --open-url -- "%1"\r\n';
const AFTER_TEST =
  "\r\nHKEY_CURRENT_USER\\Software\\Classes\\vscode\\shell\\open\\command\r\n" +
  '    (既定)    REG_SZ    "C:\\repo\\.vscode-test\\vscode-win32-x64-archive-1.90.0\\Code.exe" --open-url -- "%1"\r\n';

/** reg の作り物。query は queryOutputs を順に返す */
function fakeReg(options: { queryOutputs: Array<string | undefined>; exportStatus?: number; importStatus?: number }) {
  const calls: Call[] = [];
  const outputs = [...options.queryOutputs];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    const verb = args[0];
    if (verb === "query") {
      const out = outputs.length > 1 ? outputs.shift() : outputs[0];
      return out === undefined
        ? { status: 1, stdout: "", stderr: "指定されたレジストリ キーまたは値が見つかりません" }
        : { status: 0, stdout: out, stderr: "" };
    }
    if (verb === "export") return { status: options.exportStatus ?? 0, stdout: "", stderr: "" };
    if (verb === "import") return { status: options.importStatus ?? 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "想定外" };
  };
  const logs: string[] = [];
  return { calls, run, log: (line: string) => logs.push(line), logs };
}

describe("試験用の VS Code が書き換えた vscode:// の受け手を戻す", () => {
  it("Windows 以外では何もしない（reg を呼ばない）", async () => {
    const reg = fakeReg({ queryOutputs: [BEFORE] });
    const result = await withProtocolHandlerGuard(async () => "走った", {
      platform: "linux",
      run: reg.run,
      log: reg.log,
    });
    expect(result).toBe("走った");
    expect(reg.calls).toEqual([]);
  });

  it("控えを取ってから試験を走らせ、書き換わっていたら控えから戻す", async () => {
    const reg = fakeReg({ queryOutputs: [BEFORE, AFTER_TEST, BEFORE] });
    const order: string[] = [];
    const wrapped = (command: string, args: string[]) => {
      order.push(`reg ${args[0]}`);
      return reg.run(command, args);
    };
    await withProtocolHandlerGuard(
      async () => {
        order.push("試験");
      },
      { platform: "win32", run: wrapped, log: reg.log }
    );
    expect(order).toEqual(["reg query", "reg export", "試験", "reg query", "reg import", "reg query"]);
    // 鍵は vscode の受け手だけ（vscode-insiders には触らない）
    for (const call of reg.calls) {
      expect(call.command).toBe("reg");
      if (call.args[0] !== "import") expect(call.args[1]).toBe(VSCODE_PROTOCOL_COMMAND_KEY);
    }
    expect(VSCODE_PROTOCOL_COMMAND_KEY).toBe("HKCU\\Software\\Classes\\vscode\\shell\\open\\command");
    // 書き出した控えのファイルを、そのまま読み込み直す
    const exported = reg.calls.find((call) => call.args[0] === "export");
    const imported = reg.calls.find((call) => call.args[0] === "import");
    expect(imported?.args[1]).toBe(exported?.args[2]);
    expect(reg.logs.join("\n")).toContain("戻しました");
  });

  it("試験が失敗しても戻す（失敗はそのまま投げ直す）", async () => {
    const reg = fakeReg({ queryOutputs: [BEFORE, AFTER_TEST, BEFORE] });
    await expect(
      withProtocolHandlerGuard(
        async () => {
          throw new Error("試験が落ちた");
        },
        { platform: "win32", run: reg.run, log: reg.log }
      )
    ).rejects.toThrow("試験が落ちた");
    expect(reg.calls.map((call) => call.args[0])).toContain("import");
  });

  it("書き換わっていなければ読み込み直さない", async () => {
    const reg = fakeReg({ queryOutputs: [BEFORE, BEFORE] });
    await withProtocolHandlerGuard(async () => undefined, { platform: "win32", run: reg.run, log: reg.log });
    expect(reg.calls.map((call) => call.args[0])).toEqual(["query", "export", "query"]);
  });

  it("控えが取れなかった（キーが無い）ときは戻さない——値を勝手に作らない", async () => {
    const reg = fakeReg({ queryOutputs: [undefined, AFTER_TEST] });
    await withProtocolHandlerGuard(async () => undefined, { platform: "win32", run: reg.run, log: reg.log });
    expect(reg.calls.map((call) => call.args[0])).toEqual(["query"]);
    expect(reg.logs.join("\n")).toContain("控え");
  });

  it("書き出しに失敗したときも戻さない", async () => {
    const reg = fakeReg({ queryOutputs: [BEFORE, AFTER_TEST], exportStatus: 1 });
    await withProtocolHandlerGuard(async () => undefined, { platform: "win32", run: reg.run, log: reg.log });
    expect(reg.calls.map((call) => call.args[0])).toEqual(["query", "export"]);
  });

  it("戻すのは1回だけ（Ctrl+C の後始末と finally が重なっても）", () => {
    const reg = fakeReg({ queryOutputs: [BEFORE, AFTER_TEST, BEFORE] });
    const snapshot = snapshotProtocolHandler({ platform: "win32", run: reg.run, log: reg.log });
    expect(snapshot).toBeDefined();
    restoreProtocolHandler(snapshot, { run: reg.run, log: reg.log });
    restoreProtocolHandler(snapshot, { run: reg.run, log: reg.log });
    expect(reg.calls.filter((call) => call.args[0] === "import")).toHaveLength(1);
  });

  it("読み込み直しに失敗したら、そう書く（試験の結果は変えない）", async () => {
    const reg = fakeReg({ queryOutputs: [BEFORE, AFTER_TEST], importStatus: 1 });
    const result = await withProtocolHandlerGuard(async () => "通った", {
      platform: "win32",
      run: reg.run,
      log: reg.log,
    });
    expect(result).toBe("通った");
    expect(reg.logs.join("\n")).toContain("戻せませんでした");
  });
});
