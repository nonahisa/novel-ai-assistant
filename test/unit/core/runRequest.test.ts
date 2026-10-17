import { describe, expect, test } from "vitest";
import {
  RUN_ARRIVAL_MS,
  RUN_CONFIRM_MS,
  RUN_FEATURES,
  RUN_MAX_PER_HOUR,
  RUN_REQUESTABLE_FEATURES,
  buildRunUri,
  checkRunFile,
  checkRunToken,
  countRecentRuns,
  describeExportConfirm,
  describeRunConfirm,
  describeTestAiConfirm,
  findRunFeature,
  isRunExportFeature,
  isConfirmTooLate,
  isRunOpen,
  isRunStale,
  parseRunQuery,
  parseRunState,
  parseRunTicket,
  formatRunTicket,
  runIdOfFileName,
  runFeatureLabel,
  runFeatureTakesFile,
  runStatusOf,
  type RunStateRecord,
  type RunTicket,
} from "../../../src/core/runRequest";
import { sha256Text } from "../../../src/core/hash";
import { permissionKeyOf } from "../../../src/core/externalAccessPermission";
import { paidUsageLines } from "../../../src/core/paidUsageNotice";

/**
 * VS Code の中のAI設定で走らせてもらう道の判定（設計書6.87.22）。
 *
 * **合言葉が合わない依頼は、確認も出さずに断る**——`vscode://` はウェブページの
 * リンク1つでも開かせられる。ここで見るのは、MCP と拡張機能が共有する判定。
 */

const ID = "0123456789abcdef";
const TOKEN = "a".repeat(64);
const CREATED = Date.parse("2026-09-25T10:00:00+09:00");

function ticket(overrides: Partial<RunTicket> = {}): RunTicket {
  return {
    version: 1,
    id: ID,
    tokenHash: sha256Text(TOKEN),
    feature: "typo",
    folder: "C:\\作品\\星の町",
    client: "claude-code",
    createdAt: new Date(CREATED).toISOString(),
    ...overrides,
  };
}

function state(overrides: Partial<RunStateRecord> = {}): RunStateRecord {
  return { version: 1, id: ID, state: "confirming", at: new Date(CREATED).toISOString(), ...overrides };
}

describe("合言葉の照合", () => {
  test("一致すれば通る", () => {
    expect(checkRunToken(ticket(), TOKEN, CREATED + 1000, sha256Text)).toEqual({ ok: true });
  });

  test("一致しなければ「出どころの分からない依頼」", () => {
    const result = checkRunToken(ticket(), "b".repeat(64), CREATED + 1000, sha256Text);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("mismatch");
  });

  test("長さの違う合言葉も一致とは読まない", () => {
    const result = checkRunToken(ticket(), TOKEN.slice(0, 63), CREATED, sha256Text);
    expect(result.ok).toBe(false);
  });

  test("依頼から猶予を過ぎて届いたら断る（控えた URI を後から開かせない）", () => {
    const result = checkRunToken(ticket(), TOKEN, CREATED + RUN_ARRIVAL_MS + 1, sha256Text);
    expect(result.ok === false && result.kind).toBe("late");
  });

  test("猶予ちょうどまでは通る", () => {
    expect(checkRunToken(ticket(), TOKEN, CREATED + RUN_ARRIVAL_MS, sha256Text).ok).toBe(true);
  });

  test("札には合言葉そのものを置かない（ハッシュだけ）", () => {
    const text = formatRunTicket(ticket());
    expect(text).not.toContain(TOKEN);
    expect(parseRunTicket(text)?.tokenHash).toBe(sha256Text(TOKEN));
  });
});

describe("URI のクエリ", () => {
  test("組んだ URI を読み戻せる", () => {
    const uri = buildRunUri(ID, TOKEN);
    expect(uri.startsWith("vscode://nonahisa.novel-ai-assistant/run?")).toBe(true);
    expect(parseRunQuery(uri.slice(uri.indexOf("?") + 1))).toEqual({ ok: true, id: ID, token: TOKEN });
  });

  test("作品の場所も機能も URI に載せない", () => {
    const uri = buildRunUri(ID, TOKEN);
    expect(uri).not.toContain("folder");
    expect(uri).not.toContain("feature");
  });

  test("知らない鍵・同じ鍵の2つ目・形の合わない値は断る", () => {
    expect(parseRunQuery(`id=${ID}&token=${TOKEN}&feature=apply`).ok).toBe(false);
    expect(parseRunQuery(`id=${ID}&id=${ID}&token=${TOKEN}`).ok).toBe(false);
    expect(parseRunQuery(`id=xyz&token=${TOKEN}`).ok).toBe(false);
    expect(parseRunQuery(`id=${ID}`).ok).toBe(false);
  });
});

describe("白名簿", () => {
  test("読み取りと生成だけ", () => {
    expect(RUN_FEATURES.map((def) => def.feature).sort()).toEqual(
      [
        "contradiction",
        "deviation",
        "factContradiction",
        "foreshadow",
        "opening",
        "proofread",
        "settings",
        "synopsis",
        "typo",
      ].sort()
    );
  });

  test("適用・保存・反映の類は無い（抽出は貯めるだけで、保存は extract.commit）", () => {
    for (const name of ["apply", "extract", "extractCommit", "pending", "chat", "episodePlot"]) {
      expect(findRunFeature(name)).toBeUndefined();
    }
  });

  test("機能別AI割当の鍵（2026-10-16 に足した3つ）", () => {
    expect(findRunFeature("opening")?.assigned).toBe("generate");
    // 事実の照合は、取り出し（factExtract）と判定（contradiction）の2つのAIを使う
    expect(findRunFeature("factContradiction")?.assigned).toBe("factExtract");
    expect(findRunFeature("factContradiction")?.verifyAssigned).toBe("contradiction");
    expect(findRunFeature("settings")?.assigned).toBe("extract");
  });

  test("AI接続確認（testAI）は白名簿とは別に通す（本文を送らない）", () => {
    expect(findRunFeature("testAI")).toBeUndefined();
    expect(RUN_REQUESTABLE_FEATURES).toContain("testAI");
    expect(runFeatureLabel("testAI")).toBe("AI接続確認");
  });

  test("話を指せない機能（冒頭診断・AI接続確認）の file は札でも断る", () => {
    expect(runFeatureTakesFile("typo")).toBe(true);
    expect(runFeatureTakesFile("settings")).toBe(true);
    expect(runFeatureTakesFile("opening")).toBe(false);
    expect(runFeatureTakesFile("testAI")).toBe(false);
    expect(parseRunTicket(formatRunTicket(ticket({ feature: "opening" })))?.feature).toBe("opening");
    expect(parseRunTicket(formatRunTicket(ticket({ feature: "opening", file: "本文/第1話.txt" })))).toBeUndefined();
    expect(parseRunTicket(formatRunTicket(ticket({ feature: "testAI", file: "本文/第1話.txt" })))).toBeUndefined();
    expect(parseRunTicket(formatRunTicket(ticket({ feature: "testAI" })))?.feature).toBe("testAI");
  });

  test("白名簿の外の札も読める（受け口が理由を言って断れるように）", () => {
    const parsed = parseRunTicket(formatRunTicket(ticket({ feature: "apply" as never })));
    expect(parsed?.feature).toBe("apply");
    expect(findRunFeature(parsed?.feature)).toBeUndefined();
  });
});

describe("対象の話の指定", () => {
  test("相対パスだけ", () => {
    expect(checkRunFile("本文\\第1話.txt")).toBeUndefined();
    expect(checkRunFile("C:\\外\\x.txt")).toBeDefined();
    expect(checkRunFile("/etc/x")).toBeDefined();
    expect(checkRunFile("本文/../../x.txt")).toBeDefined();
    expect(checkRunFile("a\u0000b")).toBeDefined();
  });
});

describe("run.result の状態", () => {
  test("拡張機能がまだ受け取っていない", () => {
    expect(runStatusOf(ticket(), undefined, CREATED + 1000).status).toBe("waiting");
  });

  test("受け取られないまま猶予を過ぎたら期限切れ", () => {
    expect(runStatusOf(ticket(), undefined, CREATED + RUN_ARRIVAL_MS + 1).status).toBe("expired");
  });

  test("作者の確認待ち", () => {
    const view = runStatusOf(ticket(), state(), CREATED + 60_000);
    expect(view.status).toBe("confirming");
    expect(view.message).toContain("作者");
  });

  test("確認が出たまま期限を過ぎたら期限切れ", () => {
    expect(runStatusOf(ticket(), state(), CREATED + RUN_CONFIRM_MS + 1).status).toBe("expired");
  });

  test("実行中・終わった・断られた・失敗", () => {
    expect(runStatusOf(ticket(), state({ state: "running" }), CREATED).status).toBe("running");
    expect(runStatusOf(ticket(), state({ state: "done" }), CREATED).status).toBe("done");
    const declined = runStatusOf(ticket(), state({ state: "declined" }), CREATED);
    expect(declined.status).toBe("declined");
    const refused = runStatusOf(
      ticket(),
      state({ state: "refused", reason: "許可が無い。", nextAction: "許可する" }),
      CREATED
    );
    expect(refused.status).toBe("refused");
    expect(refused.message).toContain("許可が無い");
    expect(refused.message).toContain("次の操作：許可する");
    expect(runStatusOf(ticket(), state({ state: "failed" }), CREATED).status).toBe("failed");
  });

  test("抽出を終えたら、保存は novel.extract.commit だと言う", () => {
    const view = runStatusOf(ticket({ feature: "settings" }), state({ state: "done" }), CREATED);
    expect(view.message).toContain("novel.extract.commit");
    expect(view.message).toContain("dryRun");
  });

  test("AI接続確認を終えたら、繋がらなかったことも done の中にあると言う", () => {
    const view = runStatusOf(ticket({ feature: "testAI" }), state({ state: "done" }), CREATED);
    expect(view.message).toContain("result.findings");
    expect(view.message).toContain("ok");
  });

  test("返事の出ていない依頼か", () => {
    expect(isRunOpen(ticket(), undefined, CREATED)).toBe(true);
    expect(isRunOpen(ticket(), state(), CREATED)).toBe(true);
    expect(isRunOpen(ticket(), state({ state: "done" }), CREATED)).toBe(false);
    expect(isRunOpen(ticket(), state(), CREATED + RUN_CONFIRM_MS + 1)).toBe(false);
  });

  test("壊れた状態のファイルは読まない", () => {
    expect(parseRunState("{")).toBeUndefined();
    expect(parseRunState(JSON.stringify({ version: 1, id: ID, state: "?", at: "x" }))).toBeUndefined();
  });
});

describe("期限と上限", () => {
  test("「走らせる」の期限は依頼から数える", () => {
    expect(isConfirmTooLate(ticket(), CREATED + RUN_CONFIRM_MS)).toBe(false);
    expect(isConfirmTooLate(ticket(), CREATED + RUN_CONFIRM_MS + 1)).toBe(true);
  });

  test("数えるのは作者が「走らせる」を押した回だけ", () => {
    const now = CREATED + 10 * 60_000;
    const states = [
      state({ state: "done", startedAt: new Date(CREATED).toISOString() }),
      state({ state: "declined" }),
      state({ state: "refused" }),
      state({ state: "done", startedAt: new Date(CREATED - 2 * 60 * 60_000).toISOString() }),
    ];
    expect(countRecentRuns(states, now)).toBe(1);
    expect(RUN_MAX_PER_HOUR).toBeGreaterThan(0);
  });

  test("7日を過ぎた札は片付けてよい", () => {
    expect(isRunStale(new Date(CREATED).toISOString(), CREATED + 6 * 86_400_000)).toBe(false);
    expect(isRunStale(new Date(CREATED).toISOString(), CREATED + 8 * 86_400_000)).toBe(true);
  });

  test("ファイル名から依頼番号を読む", () => {
    expect(runIdOfFileName(`${ID}.request.json`)).toEqual({ id: ID, kind: "request" });
    expect(runIdOfFileName(`${ID}.state.json`)).toEqual({ id: ID, kind: "state" });
    expect(runIdOfFileName(`${ID}.state.json.tmp`)).toBeUndefined();
  });
});

describe("確認のモーダル", () => {
  const base = {
    ticket: ticket(),
    featureLabel: "誤字脱字の検知",
    workTitle: "星の町",
    targetLabel: "第3話.txt",
    providerName: "作り物のクラウドAI",
    model: "model-x",
    bodyChars: 4321,
    episodeCount: 1,
  };

  test("依頼の中身を全部並べる（どこから・作品・話・機能・AI・送る量）", () => {
    const { message, detail } = describeRunConfirm({ ...base, paid: false, paidLines: [] });
    expect(message).toContain("誤字脱字の検知");
    for (const expected of ["claude-code", "自己申告", "星の町", "第3話.txt", "作り物のクラウドAI", "model-x", "4,321字", "無料"]) {
      expect(detail).toContain(expected);
    }
    expect(detail).not.toContain("今後は確認しない");
  });

  test("有料のAIなら、画面の確認と同じ料金の断りを出す", () => {
    const paidLines = paidUsageLines("作り物のクラウドAI", "model-x");
    const { detail } = describeRunConfirm({ ...base, paid: true, paidLines });
    for (const line of paidLines) expect(detail).toContain(line);
    expect(detail).not.toContain("無料");
  });

  test("処理済みを飛ばさない機能では「処理済みの部分は送りません」と言わない", () => {
    const opening = describeRunConfirm({
      ...base,
      featureLabel: "冒頭診断",
      paid: false,
      paidLines: [],
      def: findRunFeature("opening"),
    }).detail;
    expect(opening).not.toContain("処理済みの部分は送りません");
    const typo = describeRunConfirm({ ...base, paid: false, paidLines: [], def: findRunFeature("typo") }).detail;
    expect(typo).toContain("処理済みの部分は送りません");
  });

  test("抽出は、貯める先と保存の道を確認に書く", () => {
    const { detail } = describeRunConfirm({
      ...base,
      featureLabel: "設定資料の抽出",
      paid: false,
      paidLines: [],
      def: findRunFeature("settings"),
    });
    expect(detail).toContain("external-extract.json");
    expect(detail).toContain("novel.extract.commit");
  });

  test("判定に別のAIを使う機能は、両方のAIを並べ、片方が有料なら料金の断りを出す", () => {
    const paidLines = paidUsageLines("判定のクラウドAI", "judge-1");
    const { detail } = describeRunConfirm({
      ...base,
      featureLabel: "矛盾検知（事実の照合）",
      paid: true,
      paidLines,
      def: findRunFeature("factContradiction"),
      verifier: { providerName: "判定のクラウドAI", model: "judge-1", paid: true },
    });
    expect(detail).toContain("作り物のクラウドAI（model-x）");
    expect(detail).toContain("判定のクラウドAI（judge-1）");
    for (const line of paidLines) expect(detail).toContain(line);
  });

  test("AI接続確認の確認は、短い文を1回だけ送ることと料金を並べる", () => {
    const { message, detail } = describeTestAiConfirm({
      ticket: ticket({ feature: "testAI" }),
      workTitle: "星の町",
      providerName: "作り物のクラウドAI",
      model: "model-x",
      paid: true,
    });
    expect(message).toContain("AI接続確認");
    for (const expected of ["claude-code", "自己申告", "作り物のクラウドAI", "model-x", "本文は送りません", "料金"]) {
      expect(detail).toContain(expected);
    }
    expect(detail).not.toContain("今後は確認しない");
  });
});

/**
 * 書き出し（PDF・EPUB。棚卸しの10件目、2026-10-16）。**新しいファイルを作るだけで
 * 原稿を変えない**ので、作者の裁定3（毎回確認つきで頼める）の範囲で受ける。
 */
describe("書き出し（exportPdf・exportEpub）", () => {
  test("白名簿（AIへ本文を送る機能）とは別に通し、話は指せない", () => {
    for (const feature of ["exportPdf", "exportEpub"]) {
      expect(findRunFeature(feature)).toBeUndefined();
      expect(RUN_REQUESTABLE_FEATURES).toContain(feature);
      expect(isRunExportFeature(feature)).toBe(true);
      expect(runFeatureTakesFile(feature)).toBe(false);
      expect(parseRunTicket(formatRunTicket(ticket({ feature: feature as never })))?.feature).toBe(feature);
      expect(
        parseRunTicket(formatRunTicket(ticket({ feature: feature as never, file: "本文/第1話.txt" })))
      ).toBeUndefined();
    }
    expect(runFeatureLabel("exportPdf")).toContain("PDF");
    expect(runFeatureLabel("exportEpub")).toContain("EPUB");
    expect(isRunExportFeature("typo")).toBe(false);
  });

  test("確認には、新しいファイルを作るだけで原稿が変わらないこと・置き場・AIを呼ばないことを並べる", () => {
    const pdf = describeExportConfirm({ ticket: ticket({ feature: "exportPdf" as never }), workTitle: "星の町", episodeCount: 19 });
    expect(pdf.message).toContain("PDF");
    for (const expected of ["claude-code", "自己申告", "星の町", "19話", ".aiwriter/exports/", "新しいファイル", "原稿", "AIは呼びません", "ブラウザは開きません"]) {
      expect(pdf.detail).toContain(expected);
    }
    expect(pdf.detail).not.toContain("今後は確認しない");

    const epub = describeExportConfirm({ ticket: ticket({ feature: "exportEpub" as never }), workTitle: "星の町", episodeCount: 3 });
    expect(epub.message).toContain("EPUB");
    // 表紙は焼いてあればそれ（表紙を焼くの結果）を使う
    expect(epub.detail).toContain("焼いた");
    expect(epub.detail).toContain("book.json");
  });

  test("PDFの確認には、使う紙・向き・範囲と、前回の設定か既定かを並べる（作者の裁定 2026-10-16 夜の3）", () => {
    const pdf = describeExportConfirm({
      ticket: ticket({ feature: "exportPdf" as never }),
      workTitle: "星の町",
      episodeCount: 19,
      pdfPlan: {
        paper: "A5（148mm × 210mm）",
        direction: "縦書き",
        range: "前回選んだ2話（001_灯.txt、003_春.txt）",
        margins: "奇数・偶数ページとも：フッター中央にページ番号",
        source: "前回の［PDF出力］で選んだ設定です",
      },
    });
    for (const expected of [
      "紙：A5（148mm × 210mm）",
      "向き：縦書き",
      "範囲：前回選んだ2話（001_灯.txt、003_春.txt）",
      // 上下の余白の置き方も前回のもの（2026-10-17〜）。作者名の枠は空けると断る
      "上下の余白：奇数・偶数ページとも：フッター中央にページ番号",
      "作者名を置く枠は、外からは名前を訊けないため空けます",
      "前回の［PDF出力］で選んだ設定です",
    ]) {
      expect(pdf.detail).toContain(expected);
    }
    // 決め打ちの「文庫サイズ・縦書き」はもう言わない（使う紙と食い違う）
    expect(pdf.detail).not.toContain("一覧の先頭");
  });

  test("書き出し終えたら、置いた場所が result.findings にあると言う", () => {
    const view = runStatusOf(ticket({ feature: "exportEpub" as never }), state({ state: "done" }), CREATED);
    expect(view.message).toContain("result.findings");
    expect(view.message).toContain(".aiwriter/exports/");
  });
});

describe("許可の鍵", () => {
  test("run.result は run.request と同じ鍵で確かめる", () => {
    expect(permissionKeyOf("run.result", undefined)).toBe("run.request");
    expect(permissionKeyOf("run.request", "typo")).toBe("run.request");
  });
});
