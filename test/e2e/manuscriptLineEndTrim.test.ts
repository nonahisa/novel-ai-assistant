/**
 * 組んで書く面で、行末の「か？」」のために「30」の直後まで戻って折り返さない
 * （作者の実機報告 2026-10-27、裁定 2026-10-28。設計書6.34）。
 *
 * 作者の画面では「……診断しています。30｜人全員が藪医者やったと思いますか？」」と、
 * 行の右を15字ほど空けて「30」の直後で折れた。原因は Chromium 150（既定の 1.141 と
 * 作者の 1.143 の Electron）で、行末の「」」を詰めて収めようとして収まり切らないと、
 * 直前のテキストノードの境目（縦中横の印 span.tcy の直後）まで戻る。
 * 起きるのは「か？」」がちょうど行末に来る幅だけなので、**段落の幅を 0.5px 刻みに振って**
 * 必ずその幅を通らせる（窓の大きさに頼らない）。
 *
 * 見張ること：どの幅でも、段落の途中の行が行末に3字以上の空きを残して折れない（横・縦）。
 * 作り物の段落は作者の段落と同じ形（1〜2桁の数字→和文→末尾「か？」」）。
 * 0.114.0 の HTML を隠し窓の Chromium 150 で組むと、同じ段落・同じ判定で落ちることを確かめてある
 * （このテストそのものは作者在席のため未実行。2026-10-28）。
 */
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode } from "./support/manuscriptFrame";
import { turnVertical } from "./support/verticalFace";
import { withVsCode } from "./support/vscodeApp";

const EPISODE = "001_診察.md";
const PARAGRAPH =
  "「この3年間で田中さんを診た先生、この町で12人目なんですけど、全員が同じ病気だって言っています。12人全員が間違っていると思いますか？」";
const TEXT = `　前の段落。\n\n${PARAGRAPH}\n\n　後ろの段落。\n`;

interface Sweep {
  /** 振った幅（縦書きでは高さ）の数 */
  tried: number;
  /** 段落が2行以上に折れた幅の数（振った意味があったか） */
  wrapped: number;
  /** 早く折れた例（幅と、その行の終わりの字） */
  early: string[];
  /** 印（縦中横）が段落に付いていたか */
  tcy: number;
}

/**
 * 段落の幅（縦書きでは高さ）を 0.5px 刻みで振り、字ごとの矩形から行を組み立てて、
 * 段落の途中の行が「行末に3字以上の空き」を残して折れていないかを見る。
 * 振り終えたら幅を元に戻す（面の見た目を残さない）。
 */
async function sweepParagraph(frame: Frame, vertical: boolean): Promise<Sweep> {
  return frame.evaluate(
    ({ head, vertical }) => {
      const compose = document.getElementById("compose");
      if (!compose) throw new Error("組んで書く面（#compose）がありません");
      const para = Array.from(compose.querySelectorAll("p, div")).find((el) => (el.textContent ?? "").startsWith(head));
      if (!para) throw new Error("見本の段落が見つかりません");
      const tcy = para.querySelectorAll("span.tcy").length;
      const fontSize = parseFloat(getComputedStyle(para).fontSize);
      const saved = vertical ? compose.style.height : compose.style.width;
      const result = { tried: 0, wrapped: 0, early: [] as string[], tcy };
      for (let size = 14 * fontSize; size <= 44 * fontSize; size += 0.5) {
        if (vertical) compose.style.height = `${size}px`;
        else compose.style.width = `${size}px`;
        result.tried++;
        const lines: { center: number; far: number; text: string }[] = [];
        const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.nodeValue ?? "";
          // 縦書きの縦中横は2字を1字ぶんへ組むので、1字ずつの矩形は行の外へずれる。印ごとの矩形で測る
          const mark = node.parentElement?.closest("span.tcy");
          for (let i = 0; i < value.length; i++) {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = mark ? mark.getBoundingClientRect() : range.getBoundingClientRect();
            const center = vertical ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
            const far = vertical ? rect.bottom : rect.right;
            const line = lines.find((l) => Math.abs(l.center - center) <= fontSize / 2);
            if (line) {
              line.far = Math.max(line.far, far);
              line.text += value[i];
            } else lines.push({ center, far, text: value[i] });
          }
        }
        if (lines.length < 2) continue;
        result.wrapped++;
        const longest = Math.max(...lines.map((l) => l.far));
        for (const line of lines.slice(0, -1)) {
          if (line.far < longest - 3 * fontSize && result.early.length < 5) {
            result.early.push(`${size}px：「${line.text.slice(-10)}」で折れ、行末が ${Math.round(longest - line.far)}px 空いた`);
          }
        }
      }
      if (vertical) compose.style.height = saved;
      else compose.style.width = saved;
      return result;
    },
    { head: PARAGRAPH.slice(0, 6), vertical }
  );
}

for (const vertical of [false, true]) {
  const face = vertical ? "縦書き" : "横書き";
  test(`${face}：行末に「か？」」が来る幅でも、縦中横の数字の直後まで戻って折り返さない`, async () => {
    await withVsCode(`行末の約物と縦中横（${face}）`, [{ name: EPISODE, text: TEXT }], async (session) => {
      let frame = await openEpisode(session.page, EPISODE, "後ろの段落");
      if (vertical) frame = await turnVertical(session, "後ろの段落");
      const sweep = await sweepParagraph(frame, vertical);
      expect(sweep.tcy, "テストの前提（数字に縦中横の印が付く）が崩れています").toBeGreaterThan(0);
      expect(sweep.wrapped, `テストの前提（段落が折り返す）が崩れています：${JSON.stringify(sweep)}`).toBeGreaterThan(sweep.tried / 2);
      expect(sweep.early, `早く折れた幅があります（${sweep.tried}通り振った）`).toEqual([]);
    });
  });
}
