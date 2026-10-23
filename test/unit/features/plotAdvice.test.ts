import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import { installFakeDisk, openFakeDocument } from "../support/openDocumentFake";
import { hashBytes } from "../../../src/core/hash";
import type { WorkEntry } from "../../../src/models/types";
import type { TextFileContent } from "../../../src/core/textFile";
import type { GenerateParams } from "../../../src/ai/types";
import { AIError } from "../../../src/ai/types";
import { PLOT_ADVICE_SUGGESTION_MARK } from "../../../src/core/plotAdviceValidation";
import type { PlotAdviceView } from "../../../src/features/plotAdvice";

/**
 * プロットモードのAI助言（P-01、設計書6.4.10）の送受信と書き込み。
 * 作り物のAIで動かす（本物のAIは呼ばない）。
 *
 * 動いたと言える条件：
 * 1. 送ると「あなた」の発言が並び、答えが来たら会話の文と書き込み案が並ぶ。
 *    案は**画面に並べるだけで何も書かない**
 * 2. 割当は「AIに相談」（chat）、温度は 0.7、思考は止める、`jsonSchema` は渡さない
 * 3. AIへ渡す履歴は直近10往復で切れる
 * 4. ［この案をプロットに書く］は控えた案だけを書き、押した時点で読んだ
 *    ハッシュを添えて本文と同じ口（`writeTextFilePreservingFormat`）を通る
 * 5. 作者の書いた項目を置き換えるときは確認を出し、断られたら書かない
 * 6. ［止める］は失敗にしない。壊れた案は捨てて文だけ出す
 */

const state = vi.hoisted(() => ({
  provider: undefined as unknown,
  generate: vi.fn(),
  paid: vi.fn(async (_provider: unknown, _options: unknown) => true),
  reachable: vi.fn(async () => true),
  ensure: vi.fn(),
  read: vi.fn(),
  write: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
  chatLog: vi.fn(),
  logStep: vi.fn(),
  logFailure: vi.fn(),
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: state.ensure,
}));
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: state.paid,
  confirmProviderReachable: state.reachable,
}));
vi.mock("../../../src/core/textFile", () => ({
  readTextFile: state.read,
  writeTextFilePreservingFormat: state.write,
}));
vi.mock("../../../src/core/chatLog", () => ({ appendChatLog: state.chatLog }));
vi.mock("../../../src/core/logger", () => ({
  logFailure: state.logFailure,
  logStep: state.logStep,
  responseExcerptForLog: (text: string) => text,
  useLogFile: vi.fn(),
}));
vi.mock("../../../src/ai/outputLimit", () => ({
  resolveOutputTokensForSend: () => 4096,
  resolveOutputTokensForPlanning: () => 2048,
}));

const { PlotAdviceSession } = await import("../../../src/features/plotAdvice");

const work: WorkEntry = {
  id: "work_test",
  title: "現代ダンジョンのインフラ担当",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-10-09T00:00:00.000Z",
};
const plotFile = nodePath.join(work.folderPath, "設定", "plot.md");

const PLOT = [
  "# 現代ダンジョンのインフラ担当",
  "",
  "## ログライン",
  "",
  "## テーマ",
  "裏方の仕事が、表の英雄を支えている",
  "",
].join("\n");

function file(text: string): TextFileContent {
  return {
    text,
    encoding: "utf8",
    eol: "\n",
    hasTrailingNewline: true,
    hash: "hash-at-click",
    hasConflictMarkers: false,
    hasMixedEol: false,
  };
}

function answer(text: string) {
  return { text, truncated: false, elapsedMs: 10 };
}

let views: PlotAdviceView[] = [];
let announced: string[] = [];
let plotText = PLOT;

function session() {
  return new PlotAdviceSession({
    work,
    registry: {} as never,
    plotFile,
    readPlot: async () => plotText,
    post: (view) => views.push(view),
  });
}

function lastView(): PlotAdviceView {
  return views[views.length - 1];
}

beforeEach(() => {
  views = [];
  announced = [];
  plotText = PLOT;
  state.generate.mockReset();
  state.provider = {
    id: "ollama",
    displayName: "Ollama",
    isPaid: false,
    generate: state.generate,
  };
  state.ensure.mockReset();
  state.ensure.mockImplementation(async () => ({ provider: state.provider, model: "gemma4:e4b" }));
  state.paid.mockClear();
  state.reachable.mockClear();
  state.read.mockReset();
  state.read.mockImplementation(async () => file(PLOT));
  state.write.mockClear();
  state.write.mockImplementation(async () => ({ ok: true }));
  state.chatLog.mockClear();
  state.logStep.mockClear();
  state.logFailure.mockClear();
  workspace.textDocuments = [];
  window.showInformationMessage = (async (message: string) => {
    announced.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = (async (message: string) => {
    announced.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
});

describe("送って、答えを並べる", () => {
  test("会話の文と書き込み案を並べ、案は何も書かない", async () => {
    state.generate.mockImplementation(async () =>
      answer(
        `ログラインの4つがそろいましたね。障害は班長との関係でしょうか？\n${PLOT_ADVICE_SUGGESTION_MARK}\n` +
          `{"field": "ログライン", "value": "試験に落ちた新人が、地下の配線を守る"}`
      )
    );
    const advice = session();
    const ok = await advice.send("試験に落ちた新人が、地下の配線を守る話です");

    expect(ok).toBe(true);
    // 送った直後に「あなた」の発言と、考えている印が出る
    expect(views[0].status).toBe("busy");
    expect(views[0].turns).toEqual([
      { role: "author", text: "試験に落ちた新人が、地下の配線を守る話です" },
    ]);
    const view = lastView();
    expect(view.status).toBe("idle");
    expect(view.turns[1].text).toBe("ログラインの4つがそろいましたね。障害は班長との関係でしょうか？");
    expect(view.turns[1].suggestion).toMatchObject({
      heading: "ログライン",
      value: "試験に落ちた新人が、地下の配線を守る",
      overwrites: false,
      state: "open",
    });
    // 並べただけ。書いていない
    expect(state.write).not.toHaveBeenCalled();
    // 相談と同じ記録に残す（プロットモードの印つき）
    expect(state.chatLog).toHaveBeenCalledWith(
      work,
      expect.objectContaining({ panel: "プロットモード", promptVersion: "P-01 1.1" })
    );
  });

  test("割当は chat、温度 0.7、思考を止め、形の強制（jsonSchema）は渡さない", async () => {
    state.generate.mockImplementation(async () => answer("テーマを先に決めましょうか？"));
    await session().send("相談です");

    expect(state.ensure).toHaveBeenCalledWith({}, "chat");
    const params = state.generate.mock.calls[0][0] as GenerateParams;
    expect(params.temperature).toBe(0.7);
    expect(params.disableThinking).toBe(true);
    expect(params.jsonSchema).toBeUndefined();
    expect(params.meta?.feature).toBe("plot_advice");
    expect(params.userPrompt).toContain(
      "【話が途切れたときに勧める項目（まだ勧めていません）】\nログライン"
    );
    expect(params.userPrompt).toContain("【作者の発言】\n相談です");
  });

  test("AIへ渡す履歴は直近10往復で切れる", async () => {
    let round = 0;
    state.generate.mockImplementation(async () => answer(`答え${++round}`));
    const advice = session();
    for (let i = 1; i <= 12; i++) await advice.send(`発言${i}`);

    const last = state.generate.mock.calls[11][0] as GenerateParams;
    // 12回目に渡すのは 2〜11回目の10往復
    expect(last.userPrompt).not.toContain("作者：発言1\n");
    expect(last.userPrompt).toContain("作者：発言2");
    expect(last.userPrompt).toContain("編集者：答え11");
    expect(last.userPrompt).toContain("【作者の発言】\n発言12");
  });

  test("壊れた案は捨てて、会話の文だけ出す", async () => {
    state.generate.mockImplementation(async () =>
      answer(`テーマが決まりましたね。\n${PLOT_ADVICE_SUGGESTION_MARK}\n{"field": "テーマ", "value": `)
    );
    await session().send("テーマは誇りです");
    const turn = lastView().turns[1];
    expect(turn.text).toBe("テーマが決まりましたね。");
    expect(turn.suggestion).toBeUndefined();
    expect(state.logStep.mock.calls.flat().join("\n")).toContain("形が読めません");
  });

  test("［止める］で止めたら、失敗の知らせにせず「止めました」と並べる", async () => {
    state.generate.mockImplementation(
      (params: GenerateParams) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () =>
            reject(new AIError("中止", "aborted"))
          );
        })
    );
    const advice = session();
    const pending = advice.send("相談です");
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalled());
    advice.stop();
    expect(await pending).toBe(false);
    expect(lastView().status).toBe("idle");
    expect(lastView().turns[1]).toMatchObject({ text: "（止めました）", failed: true });
    expect(state.logFailure).not.toHaveBeenCalled();
  });

  test("競合の印が残っているプロットでは送らない", async () => {
    plotText = `${PLOT}<<<<<<< HEAD\n`;
    expect(await session().send("相談です")).toBe(false);
    expect(state.generate).not.toHaveBeenCalled();
  });

  test("有料のAIは、この画面で一度だけ確認する", async () => {
    state.provider = { ...(state.provider as object), isPaid: true };
    state.generate.mockImplementation(async () => answer("はい。"));
    const advice = session();
    await advice.send("1回目");
    await advice.send("2回目");
    expect(state.paid).toHaveBeenCalledTimes(1);
    expect(state.paid.mock.calls[0][1]).toMatchObject({
      remember: { id: "ai.paid.plotAdvice" },
      work,
    });
  });
});

describe("案をプロットに書く", () => {
  async function withSuggestion(field: string, value: string) {
    state.generate.mockImplementation(async () =>
      answer(`はい。\n${PLOT_ADVICE_SUGGESTION_MARK}\n${JSON.stringify({ field, value })}`)
    );
    const advice = session();
    await advice.send(value);
    const id = lastView().turns[1].suggestion?.id;
    expect(id).toBeTruthy();
    return { advice, id: id as string };
  }

  test("控えた案を、押した時点のハッシュを添えて本文と同じ口で書く", async () => {
    const { advice, id } = await withSuggestion("ログライン", "新人が地下の配線を守る");
    expect(await advice.apply(id)).toBe(true);

    expect(state.write).toHaveBeenCalledTimes(1);
    const [target, text, , hash] = state.write.mock.calls[0] as unknown as [
      string,
      string,
      TextFileContent,
      string,
    ];
    expect(target).toBe(plotFile);
    expect(hash).toBe("hash-at-click");
    expect(text).toContain("## ログライン\n新人が地下の配線を守る");
    // ほかの節（作者の書いたテーマ）は1文字も変えない
    expect(text).toContain("## テーマ\n裏方の仕事が、表の英雄を支えている");
    expect(lastView().turns[1].suggestion?.state).toBe("written");
    // 同じ案は二度書けない
    expect(await advice.apply(id)).toBe(false);
    expect(state.write).toHaveBeenCalledTimes(1);
  });

  test("plot.md が開いていれば、ディスクを書かずに文書へ当てて保存する", async () => {
    // ディスクを消して作り直すと、開いたままのエディターで Ctrl+S が「ファイルのほうが新しい」で
    // 断られる（0.107.8、作者の裁定「両方直す」）
    const disk = installFakeDisk();
    disk.write(plotFile, PLOT);
    const document = openFakeDocument(disk, plotFile, PLOT);
    const bytes = new TextEncoder().encode(PLOT);
    state.read.mockImplementation(async () => ({ ...file(PLOT), hash: hashBytes(bytes) }));

    const { advice, id } = await withSuggestion("ログライン", "新人が地下の配線を守る");
    expect(await advice.apply(id)).toBe(true);

    expect(state.write).not.toHaveBeenCalled();
    expect(disk.deleted).toEqual([]);
    expect(document.applied.join("")).toContain("新人が地下の配線を守る");
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(lastView().turns[1].suggestion?.state).toBe("written");
    workspace.applyEdit = async () => true;
  });

  test("控えに無い番号（画面から届いた作り物）は何も書かない", async () => {
    const { advice } = await withSuggestion("ログライン", "新人が地下の配線を守る");
    expect(await advice.apply("s999")).toBe(false);
    expect(await advice.apply({ value: "勝手な文" })).toBe(false);
    expect(state.write).not.toHaveBeenCalled();
  });

  test("作者の書いた項目を置き換えるときは確認し、断られたら書かない", async () => {
    const { advice, id } = await withSuggestion("テーマ", "名前の残らない仕事の誇り");
    expect(lastView().turns[1].suggestion?.overwrites).toBe(true);

    let asked: { message: string; modal?: boolean } | undefined;
    window.showWarningMessage = (async (message: string, options?: { modal?: boolean }) => {
      asked = { message, modal: options?.modal };
      return undefined;
    }) as typeof window.showWarningMessage;
    expect(await advice.apply(id)).toBe(false);
    expect(asked?.modal).toBe(true);
    expect(asked?.message).toContain("置き換えますか");
    expect(state.write).not.toHaveBeenCalled();

    window.showWarningMessage = (async () => "置き換える") as typeof window.showWarningMessage;
    expect(await advice.apply(id)).toBe(true);
    const text = (state.write.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain("## テーマ\n名前の残らない仕事の誇り");
  });

  test("保存していない書きかけがあれば書かない", async () => {
    const { advice, id } = await withSuggestion("ログライン", "新人が地下の配線を守る");
    workspace.textDocuments = [
      { uri: { fsPath: plotFile }, isDirty: true, getText: () => PLOT },
    ];
    expect(await advice.apply(id)).toBe(false);
    expect(state.write).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("保存していない変更");
  });

  test("書き戻しの口が外の変更で止めたら、そう伝えて案は残す", async () => {
    const { advice, id } = await withSuggestion("ログライン", "新人が地下の配線を守る");
    state.write.mockImplementation(async () => ({ ok: false, reason: "modified_externally" }));
    expect(await advice.apply(id)).toBe(false);
    expect(announced.join("")).toContain("書き換わったため");
    expect(lastView().turns[1].suggestion?.state).toBe("open");
  });

  test("［採らない］は何も書かず、印だけ変える", async () => {
    const { advice, id } = await withSuggestion("ログライン", "新人が地下の配線を守る");
    advice.dismiss(id);
    expect(lastView().turns[1].suggestion?.state).toBe("dismissed");
    expect(await advice.apply(id)).toBe(false);
    expect(state.write).not.toHaveBeenCalled();
  });
});

/*
  「書いて」と頼まれたときの2回目（P-01b、設計書6.4.10 の12。作者の裁定 2026-10-23
  「『書いて』のときだけ別に頼む」）。gemma4:e4b は決めて「入れて」と頼んでも
  12回中0回しか案を出さず、毎回問いを返した。
*/
describe("「書いて」と頼まれたら、案を別に頼む", () => {
  const ASK = "舞台は瀬戸内の小さな漁村にする。決まりだから舞台の欄に書いてほしい。";
  const FIRST = "瀬戸内の漁村ですね。時代はいつ頃でしょうか？";

  test("1回目に案が無く「書いてほしい」なら、2回目を呼んで案を並べる", async () => {
    state.generate
      .mockImplementationOnce(async () => answer(FIRST))
      .mockImplementationOnce(async () => answer('{"value": "瀬戸内の小さな漁村"}'));
    const advice = session();
    expect(await advice.send(ASK)).toBe(true);

    expect(state.generate).toHaveBeenCalledTimes(2);
    const first = state.generate.mock.calls[0][0] as GenerateParams;
    const second = state.generate.mock.calls[1][0] as GenerateParams;
    // 2回目は形を value だけに決め、温度を下げ、同じ止め口で止まる
    expect(second.jsonSchema).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
    expect(second.temperature).toBeLessThan(first.temperature as number);
    expect(second.disableThinking).toBe(true);
    expect(second.signal).toBe(first.signal);
    expect(second.meta?.feature).toBe("plot_advice_draft");
    expect(second.userPrompt).toContain("【書く項目】\n舞台");
    expect(second.userPrompt).toContain(`【作者の発言】\n${ASK}`);

    // 画面には1回目の文と、2回目の案を1つの答えとして並べる。書きはしない
    const turn = lastView().turns[1];
    expect(turn.text).toBe(FIRST);
    expect(turn.suggestion).toMatchObject({
      heading: "舞台",
      value: "瀬戸内の小さな漁村",
      state: "open",
    });
    expect(state.write).not.toHaveBeenCalled();
    // 2回目のあいだも考えている印のまま（［止める］が効く）。idle は最後の1回だけ
    expect(views.filter((view) => view.status === "idle")).toHaveLength(1);

    // 記録には2回目が分かる形で残る
    expect(state.chatLog).toHaveBeenCalledTimes(2);
    expect(state.chatLog.mock.calls[1][1]).toMatchObject({
      panel: "プロットモード",
      promptVersion: "P-01b 1.0",
      target: expect.stringContaining("2回目"),
      reply: '{"value": "瀬戸内の小さな漁村"}',
    });

    // 案は控えから書ける
    const id = turn.suggestion?.id as string;
    expect(await advice.apply(id)).toBe(true);
    const text = (state.write.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain("瀬戸内の小さな漁村");
  });

  /*
    履歴に分かれた頼み方（2026-10-23 の測定で e4b が3回中1回しか案を出さなかった形）。
    今回の発言は項目を名指ししないので、直前の作者の発言の名指しで2回目を呼ぶ。
    見張りの「作者の言葉」には直前の発言も入るので、そこで決めた言葉を使った案は落ちない。
  */
  test("今回が名指しの無い「書いて」でも、直前の作者の発言の名指しで2回目を呼ぶ", async () => {
    const BEFORE = "世界観の設定を足したい。島は潮の満ち引きで姿が変わる、ということにしたい。";
    const NOW = "干潮の二時間だけ歩いて渡れる。それで決まり。書いて。";
    state.generate
      .mockImplementationOnce(async () => answer("姿が変わる島ですね。どれくらいの時間で変わりますか？"))
      .mockImplementationOnce(async () => answer("なるほど。渡れる時間はどう使いますか？"))
      .mockImplementationOnce(async () =>
        answer('{"value": "島は潮の満ち引きで姿が変わる。"}')
      );
    const advice = session();
    expect(await advice.send(BEFORE)).toBe(true);
    // 1回目の発言は書く依頼でないので2回目は呼ばない
    expect(state.generate).toHaveBeenCalledTimes(1);

    expect(await advice.send(NOW)).toBe(true);
    expect(state.generate).toHaveBeenCalledTimes(3);
    const second = state.generate.mock.calls[2][0] as GenerateParams;
    expect(second.userPrompt).toContain("【書く項目】\n世界観");
    // 決めた中身は直近の会話として届く
    expect(second.userPrompt).toContain(`作者：${BEFORE}`);
    expect(second.userPrompt).toContain(`【作者の発言】\n${NOW}`);

    const turn = lastView().turns[3];
    expect(turn.suggestion).toMatchObject({
      heading: "世界観",
      value: "島は潮の満ち引きで姿が変わる。",
      // 案の言葉は直前の発言にしか無い。見張りに履歴の作者の発言が入っていなければ false になる
      grounded: true,
      state: "open",
    });
  });

  test("案を求めない相談・名指しが2つ・1回目に案があるときは、2回目を呼ばない", async () => {
    state.generate.mockImplementation(async () => answer(FIRST));
    await session().send("舞台を瀬戸内の漁村にするか、山あいの町にするか迷っている");
    await session().send("舞台は漁村、テーマは待つことの意味。プロットに入れて。");
    expect(state.generate).toHaveBeenCalledTimes(2);

    state.generate.mockReset();
    state.generate.mockImplementation(async () =>
      answer(`${FIRST}\n${PLOT_ADVICE_SUGGESTION_MARK}\n{"field": "舞台", "value": "瀬戸内の小さな漁村"}`)
    );
    await session().send(ASK);
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  test("2回目が壊れた JSON・空・呼び出しの失敗なら、1回目の答えだけを出す", async () => {
    const seconds: Array<() => Promise<unknown>> = [
      async () => answer('{"value": '),
      async () => answer('{"value": ""}'),
      async () => answer(""),
      async () => {
        throw new AIError("つながりません", "not_running");
      },
      async () => ({ text: '{"value": "瀬戸内', truncated: true, elapsedMs: 1 }),
    ];
    for (const second of seconds) {
      state.generate.mockReset();
      state.generate.mockImplementationOnce(async () => answer(FIRST)).mockImplementationOnce(second);
      views = [];
      const advice = session();
      expect(await advice.send(ASK)).toBe(true);
      expect(state.generate).toHaveBeenCalledTimes(2);
      const turn = lastView().turns[1];
      expect(turn.text).toBe(FIRST);
      expect(turn.failed).toBeUndefined();
      expect(turn.suggestion).toBeUndefined();
      expect(lastView().status).toBe("idle");
    }
    // 落ちた理由はログに残す
    expect(state.logStep.mock.calls.flat().join("\n")).toContain("書き込み案の2回目");
  });

  test("2回目の最中に［止める］を押せば2回目も止まり、1回目の答えだけを並べる", async () => {
    state.generate
      .mockImplementationOnce(async () => answer(FIRST))
      .mockImplementationOnce(
        (params: GenerateParams) =>
          new Promise((_resolve, reject) => {
            params.signal?.addEventListener("abort", () =>
              reject(new AIError("中止", "aborted"))
            );
          })
      );
    const advice = session();
    const pending = advice.send(ASK);
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(2));
    expect(lastView().status).toBe("busy");
    advice.stop();
    expect(await pending).toBe(true);
    const turn = lastView().turns[1];
    expect(turn.text).toBe(FIRST);
    expect(turn.suggestion).toBeUndefined();
    expect(lastView().status).toBe("idle");
    expect(state.logFailure).not.toHaveBeenCalled();
  });

  test("画面を閉じたときも2回目は止まる", async () => {
    let signal: AbortSignal | undefined;
    state.generate
      .mockImplementationOnce(async () => answer(FIRST))
      .mockImplementationOnce(
        (params: GenerateParams) =>
          new Promise((_resolve, reject) => {
            signal = params.signal;
            params.signal?.addEventListener("abort", () =>
              reject(new AIError("中止", "aborted"))
            );
          })
      );
    const advice = session();
    const pending = advice.send(ASK);
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(2));
    advice.dispose();
    await pending;
    expect(signal?.aborted).toBe(true);
  });

  test("有料のAIの確かめには、もう1回送ることがあると書く", async () => {
    state.provider = { ...(state.provider as object), isPaid: true };
    state.generate.mockImplementation(async () => answer("はい。"));
    await session().send("相談です");
    const options = state.paid.mock.calls[0][1] as { more: string[] };
    expect(options.more.join("\n")).toContain("もう1回送ることがあります");
  });
});
