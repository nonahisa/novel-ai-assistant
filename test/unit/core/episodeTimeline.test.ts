import { describe, expect, test } from "vitest";
import * as paths from "../../../src/core/pathText";
import {
  buildEpisodeTimeline,
  parseAiActionLog,
  parseLogTime,
  recordPointsToEpisode,
  TIMELINE_RECOVERY_LIMIT,
} from "../../../src/core/episodeTimeline";
import type { ProposalView } from "../../../src/models/proposal";
import type { FindingView } from "../../../src/models/finding";
import { emptyPostingLedger, type PostingLedger } from "../../../src/models/posting";

/**
 * タイムラインの欄に並べる項目（設計書6.119）。
 *
 * 記録ごとに `file` の書き方が違う（相対・名前だけ・絶対）。**違う話の記録が
 * 混ざらないこと**と、**その話の記録が漏れないこと**の両方を見る。
 */

const work = paths.join(paths.resolve("/"), "作品");
const episode = paths.join(work, "本文", "第1話.txt");
const other = paths.join(work, "本文", "第2話.txt");

describe("記録がその話を指すか", () => {
  test("作品フォルダーからの相対（区切りは / でも \\ でも）", () => {
    expect(recordPointsToEpisode("本文/第1話.txt", work, episode)).toBe(true);
    expect(recordPointsToEpisode("本文\\第1話.txt", work, episode)).toBe(true);
    expect(recordPointsToEpisode("本文/第2話.txt", work, episode)).toBe(false);
  });

  test("名前だけ（ai_actions.log の書き方）", () => {
    expect(recordPointsToEpisode("第1話.txt", work, episode)).toBe(true);
    expect(recordPointsToEpisode("第2話.txt", work, episode)).toBe(false);
  });

  test("絶対の場所（外のAIの記録）", () => {
    expect(recordPointsToEpisode(episode, work, episode)).toBe(true);
    expect(recordPointsToEpisode(other, work, episode)).toBe(false);
  });

  test("空の記録はどの話も指さない", () => {
    expect(recordPointsToEpisode("", work, episode)).toBe(false);
    expect(recordPointsToEpisode("  ", work, episode)).toBe(false);
  });
});

describe("ai_actions.log の読み方", () => {
  test("壊れた行を飛ばして、残りを読む", () => {
    const text = [
      JSON.stringify({ timestamp: "2026-11-06 10:00:00", category: "typo", action: "applied", file: "第1話.txt", line: 3, target: "誤", suggestion: "正" }),
      "{壊れた行",
      "",
      JSON.stringify({ timestamp: "2026-11-06 11:00:00", category: "contradiction", action: "dismissed", file: "第1話.txt", line: 5, target: "髪", suggestion: "" }),
    ].join("\n");
    const lines = parseAiActionLog(text);
    expect(lines.map((line) => line.action)).toEqual(["applied", "dismissed"]);
  });

  test("時刻は手元の時刻として読む（ISO も読む・読めなければ無し）", () => {
    expect(parseLogTime("2026-11-06 10:00:00")).toBe(new Date(2026, 10, 6, 10, 0, 0).getTime());
    expect(parseLogTime("2026-11-06T01:00:00.000Z")).toBe(Date.parse("2026-11-06T01:00:00.000Z"));
    expect(parseLogTime("いつか")).toBeUndefined();
  });
});

function proposal(overrides: Partial<ProposalView>): ProposalView {
  return {
    id: "p1",
    time: "2026-11-01T00:00:00.000Z",
    proposer: "編集者A",
    file: "本文/第1話.txt",
    line: 2,
    original: "彼はは言った。",
    target: "はは",
    suggestion: "は",
    reason: "重複",
    category: "typo",
    status: "pending",
    ...overrides,
  };
}

function finding(overrides: Partial<FindingView>): FindingView {
  return {
    id: "f1",
    time: "2026-11-02T00:00:00.000Z",
    file: "本文/第1話.txt",
    hintLine: 4,
    original: "雨が降ってた",
    target: "降ってた",
    suggestion: "降っていた",
    before: "",
    after: "",
    message: "い抜き",
    category: "proofread",
    label: "",
    status: "pending",
    ...overrides,
  } as FindingView;
}

describe("項目に並べる", () => {
  test("その話の記録だけを、新しいものから並べる", () => {
    const entries = buildEpisodeTimeline({
      workFolder: work,
      episodePath: episode,
      edits: [
        { time: "2026-11-03T00:00:00.000Z", actor: "author", actorName: "作者", action: "ルビを付けた", file: "本文/第1話.txt", detail: "" },
        { time: "2026-11-04T00:00:00.000Z", actor: "author", actorName: "作者", action: "別の話", file: "本文/第2話.txt", detail: "" },
      ],
      proposals: [proposal({}), proposal({ id: "p2", file: "本文/第2話.txt" })],
      findings: [finding({})],
    });
    expect(entries.map((entry) => entry.label)).toEqual([
      "ルビを付けた",
      "AIの指摘（推敲）「降ってた」→「降っていた」",
      "編集者の提案 「はは」→「は」",
    ]);
    expect(entries.map((entry) => entry.open)).toEqual(["editHistory", "proposalPanel", "editorProposals"]);
  });

  test("提案と指摘は、出たときと決めたときを別の項目にする", () => {
    const entries = buildEpisodeTimeline({
      workFolder: work,
      episodePath: episode,
      proposals: [
        proposal({
          status: "accepted",
          decision: { proposalId: "p1", time: "2026-11-05T00:00:00.000Z", decidedBy: "作者", status: "accepted", note: "" },
        }),
      ],
      findings: [
        finding({
          status: "dismissed",
          decision: { findingId: "f1", time: "2026-11-04T00:00:00.000Z", status: "dismissed", note: "意図した口語" },
        }),
      ],
    });
    expect(entries.map((entry) => entry.label)).toEqual([
      "編集者の提案を採った",
      "AIの指摘（推敲）を退けた",
      "AIの指摘（推敲）「降ってた」→「降っていた」",
      "編集者の提案 「はは」→「は」",
    ]);
    expect(entries[1].detail).toContain("覚え書き：意図した口語");
  });

  test("投稿は実際の投稿と出し直しだけ（導入時の基準線は出さない）", () => {
    const ledger: PostingLedger = {
      ...emptyPostingLedger(),
      posts: [
        { episodePath: "本文/第1話.txt", site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z" },
        { episodePath: "本文/第1話.txt", site: "narou", postedAt: "2026-09-01T00:00:00.000Z", importedBaseline: true },
        { episodePath: "本文/第2話.txt", site: "kakuyomu", postedAt: "2026-10-02T00:00:00.000Z" },
      ],
      revisions: [
        { episodePath: "本文/第1話.txt", site: "kakuyomu", revisedAt: "2026-10-10T00:00:00.000Z" },
      ],
    };
    const entries = buildEpisodeTimeline({ workFolder: work, episodePath: episode, posting: ledger });
    expect(entries.map((entry) => entry.label)).toEqual(["カクヨムへ出し直し", "カクヨムへ投稿"]);
    // 合う画面が無いので押しても何も起きない（中身は説明で読める）
    expect(entries.every((entry) => entry.open === undefined)).toBe(true);
    expect(entries[0].detail).toContain("出し直した");
  });

  test("ai_actions.log（名前だけ）と外のAIの記録（絶対の場所）も拾う", () => {
    const entries = buildEpisodeTimeline({
      workFolder: work,
      episodePath: episode,
      aiActions: parseAiActionLog(
        JSON.stringify({ timestamp: "2026-11-06 10:00:00", category: "typo", action: "applied", file: "第1話.txt", line: 3, target: "誤", suggestion: "正" })
      ),
      external: [
        { time: "2026-11-06T02:00:00.000Z", tool: "novel.read", client: "claude-code", file: episode, exposure: "body", model: "", ok: true, detail: "" },
        // 競合を両方残した二重の行は1つに畳む
        { time: "2026-11-06T02:00:00.000Z", tool: "novel.read", client: "claude-code", file: episode, exposure: "body", model: "", ok: true, detail: "" },
        { time: "2026-11-06T03:00:00.000Z", tool: "novel.read", client: "claude-code", file: other, exposure: "body", model: "", ok: true, detail: "" },
      ],
    });
    expect(entries.map((entry) => entry.kind).sort()).toEqual(["aiAction", "external"]);
    expect(entries.find((entry) => entry.kind === "aiAction")?.label).toBe("誤字の指摘を反映した");
  });

  test("退避の写しは新しいもの5件まで。押すとその写しを開く", () => {
    const recoveries = Array.from({ length: 7 }, (_, index) => ({
      path: paths.join(work, "本文", ".novelai-recovery", `k-${index}.bak`),
      timestamp: Date.parse("2026-11-01T00:00:00.000Z") + index * 1000,
    }));
    const entries = buildEpisodeTimeline({ workFolder: work, episodePath: episode, recoveries });
    expect(entries).toHaveLength(TIMELINE_RECOVERY_LIMIT);
    expect(entries[0].recoveryPath).toBe(recoveries[6].path);
    expect(entries.every((entry) => entry.open === "recovery")).toBe(true);
  });

  test("時刻の読めない記録は出さない（並べる場所が無い）", () => {
    const entries = buildEpisodeTimeline({
      workFolder: work,
      episodePath: episode,
      edits: [{ time: "", actor: "author", actorName: "", action: "時刻なし", file: "本文/第1話.txt", detail: "" }],
    });
    expect(entries).toEqual([]);
  });
});
