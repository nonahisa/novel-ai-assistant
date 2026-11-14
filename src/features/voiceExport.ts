import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { ReadingSentence } from "../core/readAloud";
import type { VoicePlanUnit } from "../core/voiceCast";
import { atomicWriteFile } from "../core/atomicWrite";
import { workPaths } from "../core/workRegistry";
import { logFailure, logStep, useLogFile } from "../core/logger";
import {
  findStyle,
  VOICE_ENGINE_IDS,
  VOICE_ENGINE_LABEL,
  VoiceEngineError,
  voiceEngineNextStep,
  type VoiceEngineId,
  type VoiceSpeaker,
} from "../core/voiceEngine";
import { clipSeconds, joinClips, parseWav, WavError, type PcmClip } from "../core/wavPcm";
import { encodeMp3, type Mp3EncoderFactory } from "../core/mp3Encode";
import { expectedWorkSeconds } from "../core/voicePace";
import {
  buildCreditNotice,
  classifyLicense,
  creditSummary,
  describeVoice,
  engineBrandOf,
  isNonCommercial,
  licenseFileBody,
  licenseFileStem,
  parseAivmModels,
  parsePolicy,
  type AivmModelInfo,
  type EngineBrand,
  type VoiceTerms,
} from "../core/voiceLicense";
import { sanitizeFileName } from "../core/episodeParser";
import { withCancellableProgress } from "../views/progress";
import { confirmRun, notifyDone, warnWithLog, whenNoticePicked } from "../views/notify";
import { revealFolder } from "../views/openDocument";
import {
  engineUrlSettingLabel,
  isEngineTimeout,
  isEngineUnreachable,
  showVoiceEngineDown,
  showVoiceEngineSlow,
  type VoiceReadingService,
} from "./voiceReading";

/**
 * 人物の声の朗読を、音声ファイル（MP3）に書き出す（設計書6.42.4）。
 *
 * 作者の答え（2026-11-07 夜）：
 * 1. 形式は MP3、1話を1ファイル。文ごとの WAV を製品の計画どおりに作り、
 *    文の間（gapMs）の無音を入れてつなぐ
 * 2. 書き出したフォルダーに「クレジットと利用条件.txt」（声ごとの要点）と
 *    「ライセンス/〈モデル名か話者名〉.txt」（全文）。要点は知らせにも出す
 * 3. **ライセンス・規約が取れない声、分からない声を使う話は、書き出さずに止める**
 * 4. 非商用の声が混じるときは、書き出す前に確かめ、注意書きの先頭に書く
 * 5. 置き場は作品の `.aiwriter/exports/音声/〈話〉/`（`.gitignore` 済みの
 *    `.aiwriter/exports/` の下なので、GitHub の同期に載らない。行は足さない）
 *
 * **本文へは一切書かない**（読むだけ）。作るのは新しいファイルだけで、
 * 同じ名前があれば別名にする（実装ルール2。`atomicWriteFile` の新規作成だけを使う）。
 */

/** `.aiwriter/exports/` の下の置き場の名前 */
export const VOICE_EXPORT_DIR = "音声";
export const CREDIT_NOTICE_NAME = "クレジットと利用条件";
export const LICENSE_DIR_NAME = "ライセンス";

/**
 * 書き出しの速さ。**画面の［速さ］は使わず、いつも 1**——その場の聞き方で変える値で、
 * 書き出した音に残すものではない（声の調子は感情の分だけ寄せる）
 */
export const VOICE_EXPORT_RATE = 1;

/**
 * 2つのエンジンを混ぜて書き出すときに揃える標本化の速さ（Hz。0.151.0）。AivisSpeech の既定の速さに
 * 合わせる（VOICEVOX の 24000 を上げる側。下げると AivisSpeech の音の高い所が削れる）
 */
export const VOICE_EXPORT_MIXED_SAMPLE_RATE = 44100;

/**
 * 確認の窓に出す「おおよその長さ」の見当。1秒に読む字の数（標準の速さの朗読で
 * 1分におよそ400字）。合成するまで実際の長さは分からないので「おおよそ」と書く
 */
const CHARS_PER_SECOND = 7;

/** 止めたときに添える「どこを確かめればよいか」（作者の答え4） */
const WHERE_TO_CHECK: Record<EngineBrand, string> = {
  aivis: "AivisSpeech の画面の［音声合成モデルの管理］で、このモデルのライセンスを確かめてください。",
  voicevox:
    "VOICEVOX の［ヘルプ］の［音声ライブラリの利用規約］で、このキャラクターの規約を確かめてください。",
};

export interface VoiceExportTarget {
  work: WorkEntry;
  episodePath: string;
  /** 本文（LF区切り）。計画と台詞の推定を引くのに使う。**書き換えない** */
  text: string;
  /** 人物の声で読むときの文の計画（`buildReadingPlan(..., { splitDialogue: true })`） */
  sentences: readonly ReadingSentence[];
  /** ［声］で選んだエンジン（0.146.0） */
  engine: VoiceEngineId;
}

/** 名乗り（brand_name）の見分けを、声の割り当ての印へ */
const ENGINE_OF_BRAND: Record<EngineBrand, VoiceEngineId> = { aivis: "aivisspeech", voicevox: "voicevox" };

export interface VoiceExportDeps {
  /** MP3 の変換器の作り方（製品では `dist/lame.js` を読む。テストはパッケージを直接） */
  mp3Encoder: () => Promise<Mp3EncoderFactory>;
  now?: () => Date;
}

export type VoiceExportOutcome =
  | { kind: "written"; folder: string; mp3: string; notice: string; licenseFiles: string[] }
  | { kind: "stopped"; reason: string }
  | { kind: "declined" }
  | { kind: "cancelled" };

/** 話のファイル名（拡張子なし）。置き場と MP3 の名前に使う */
function episodeStem(episodePath: string): string {
  const base = path.basename(episodePath);
  const ext = path.extname(base);
  const stem = sanitizeFileName(ext ? base.slice(0, -ext.length) : base);
  return stem === "" ? "話" : stem;
}

/** 書き出しの置き場（`.aiwriter/exports/音声/〈話〉`） */
export function voiceExportFolder(work: WorkEntry, episodePath: string): string {
  return path.join(workPaths(work).aiwriter, "exports", VOICE_EXPORT_DIR, episodeStem(episodePath));
}

/** 作品フォルダーからの道（確認の窓に出す。`/` 区切り） */
function shownFolder(work: WorkEntry, folder: string): string {
  return path.relative(work.folderPath, folder).replace(/\\/g, "/");
}

/** 使った声（話者ごと）。スタイルは使った順 */
interface UsedVoice {
  speaker: VoiceSpeaker;
  styles: string[];
}

/**
 * 使った声を、**エンジンごと**に話者でまとめる（0.146.0）。スタイルの番号はエンジンごとに
 * 振られるので、引くのはその文のエンジンの一覧から。人物ごとに混ぜる形（2段目。0.151.0）では、
 * エンジンごとにライセンス・規約を引き分ける
 */
function usedVoices(
  units: readonly VoicePlanUnit[],
  speakersOf: ReadonlyMap<VoiceEngineId, readonly VoiceSpeaker[]>
): Map<VoiceEngineId, UsedVoice[]> | string {
  const byEngine = new Map<VoiceEngineId, Map<string, UsedVoice>>();
  for (const unit of units) {
    const found = findStyle(speakersOf.get(unit.engine) ?? [], unit.styleId);
    if (!found) {
      // 計画はいまの一覧から作るので起きないはず。起きたら、どの声か分からないまま書き出さない
      return `声（${VOICE_ENGINE_LABEL[unit.engine]}のスタイル ${unit.styleId}）がエンジンの話者の一覧に見つかりません。［声の割り当て］で選び直してください。`;
    }
    const byUuid = byEngine.get(unit.engine) ?? new Map<string, UsedVoice>();
    const entry = byUuid.get(found.speaker.uuid) ?? { speaker: found.speaker, styles: [] };
    if (!entry.styles.includes(found.style.name)) entry.styles.push(found.style.name);
    byUuid.set(found.speaker.uuid, entry);
    byEngine.set(unit.engine, byUuid);
  }
  return new Map([...byEngine].map(([engine, byUuid]) => [engine, [...byUuid.values()]]));
}

/**
 * 使った声ごとのライセンス・規約を引く。**1人でも取れない・分からない声があれば止める**
 * （作者の答え4）。止める理由は声ごとに、どこを確かめればよいかと一緒に返す。
 * どれも本文を運ばない頼み（モデルの一覧・話者の情報）なので、外のホストの確認の前に引いてよい
 */
async function gatherTerms(
  service: VoiceReadingService,
  engine: VoiceEngineId,
  brand: EngineBrand,
  voices: readonly UsedVoice[],
  work: WorkEntry
): Promise<{ terms: VoiceTerms[] } | { problems: string[] }> {
  const client = service.engineClient(engine);
  const problems: string[] = [];
  const terms: VoiceTerms[] = [];

  /** 話者の規約。失敗はログへ残して undefined（AivisSpeech では判別に使わないので止めない） */
  const policyOf = async (voice: UsedVoice): Promise<string | undefined> => {
    try {
      return parsePolicy(await client.speakerInfo(voice.speaker.uuid));
    } catch (error) {
      logEngineFailure("話者の規約を引く", error, work, voice.speaker.name);
      return undefined;
    }
  };

  if (brand === "voicevox") {
    for (const voice of voices) {
      const policy = await policyOf(voice);
      if (!policy) {
        problems.push(
          `${voice.speaker.name}：キャラクターの規約（speaker_info の policy）が取れませんでした。${WHERE_TO_CHECK.voicevox}`
        );
        continue;
      }
      terms.push({
        kind: "voicevox",
        speakerUuid: voice.speaker.uuid,
        speakerName: voice.speaker.name,
        styles: voice.styles,
        policy,
      });
    }
    return problems.length > 0 ? { problems } : { terms };
  }

  let models: AivmModelInfo[];
  try {
    models = parseAivmModels(await client.aivmModels());
  } catch (error) {
    logEngineFailure("音声合成モデルの一覧を引く", error, work);
    return {
      problems: [
        `音声合成モデルの一覧（aivm_models）が取れず、どの声のライセンスも確かめられませんでした。${WHERE_TO_CHECK.aivis}`,
      ],
    };
  }
  for (const voice of voices) {
    const model = models.find((m) => m.speakerUuids.includes(voice.speaker.uuid));
    if (!model) {
      problems.push(`${voice.speaker.name}：この話者のモデルが一覧に見つからず、ライセンスが取れませんでした。${WHERE_TO_CHECK.aivis}`);
      continue;
    }
    if (!model.license) {
      problems.push(`${voice.speaker.name}（${model.name}）：モデルにライセンスの全文がありません。${WHERE_TO_CHECK.aivis}`);
      continue;
    }
    const license = classifyLicense(model.license);
    if (!license) {
      const heading = model.license.split(/\r?\n/).find((line) => line.trim() !== "")?.trim().slice(0, 60) ?? "";
      problems.push(
        `${voice.speaker.name}（${model.name}）：ライセンスの種類が分かりません（見出し「${heading}」）。` +
          `分かるのは ACML 1.0・ACML-NC 1.0・CC BY 系だけです。${WHERE_TO_CHECK.aivis}`
      );
      continue;
    }
    terms.push({
      kind: "aivis",
      speakerUuid: voice.speaker.uuid,
      speakerName: voice.speaker.name,
      styles: voice.styles,
      modelName: model.name,
      creators: model.creators,
      license,
      licenseText: model.license,
      policy: await policyOf(voice),
    });
  }
  return problems.length > 0 ? { problems } : { terms };
}

/** エンジンの失敗をログへ。**本文（detail）を捨てない**（実装ルール5） */
function logEngineFailure(step: string, error: unknown, work: WorkEntry, who?: string): void {
  useLogFile(work.folderPath);
  logFailure(`人物の声で音声に書き出す：${step}`, {
    ...(who ? { 話者: who } : {}),
    ...(error instanceof VoiceEngineError
      ? { 種別: error.kind, 内容: error.message, ...(error.detail ? { 詳しく: error.detail } : {}) }
      : { 内容: error instanceof Error ? error.message : String(error) }),
  });
}

/** 作者向けの1文（エンジンの失敗） */
function engineProblem(error: unknown): string {
  if (error instanceof VoiceEngineError) return voiceEngineNextStep(error, "export");
  return `音声に書き出せませんでした（${error instanceof Error ? error.message : String(error)}）。詳しくはログにあります。`;
}

/** 「約3分」「1分未満」 */
function minutesLabel(seconds: number): string {
  if (seconds < 60) return "1分未満";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `約${minutes}分` : `約${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** 書く名前の組。同じ名前のものが1つでもあれば、全部に同じ番号を付けて別名にする */
interface ExportNames {
  mp3: string;
  notice: string;
  licenseDir: string;
  licenses: Array<{ terms: VoiceTerms; file: string; relative: string }>;
}

async function exists(location: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(path.toUri(location));
    return true;
  } catch {
    return false;
  }
}

/**
 * 名前を決める。**上書きしない**——1つ目の書き出しは「〈話〉.mp3」、2つ目からは
 * 「〈話〉 (2).mp3」「クレジットと利用条件 (2).txt」「ライセンス (2)/…」と、組で同じ番号にする
 * （どの注意書きがどの音のものか、名前で分かるように）
 */
async function freshNames(folder: string, stem: string, terms: readonly VoiceTerms[]): Promise<ExportNames> {
  for (let n = 1; n <= 99; n++) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const licenseDirName = `${LICENSE_DIR_NAME}${suffix}`;
    const licenseDir = path.join(folder, licenseDirName);
    const used = new Set<string>();
    const licenses = terms.map((t) => {
      // 同じ名前のモデルが2つあれば、2つ目に番号を付ける（全文を混ぜない）
      let name = licenseFileStem(t);
      for (let k = 2; used.has(name); k++) name = `${licenseFileStem(t)}${k}`;
      used.add(name);
      return {
        terms: t,
        file: path.join(licenseDir, `${name}.txt`),
        relative: `${licenseDirName}/${name}.txt`,
      };
    });
    const names: ExportNames = {
      mp3: path.join(folder, `${stem}${suffix}.mp3`),
      notice: path.join(folder, `${CREDIT_NOTICE_NAME}${suffix}.txt`),
      licenseDir,
      licenses,
    };
    const all = [names.mp3, names.notice, ...licenses.map((l) => l.file)];
    const taken = await Promise.all(all.map(exists));
    if (!taken.some(Boolean)) return names;
  }
  throw new Error("書き出し先の名前を決められませんでした（同じ名前のファイルが多すぎます）。");
}

/**
 * 1話を人物の声で MP3 に書き出す。結果を返す（画面の側とテストが、何が起きたかを見る）。
 * 失敗・中止・取りやめのどれでも、**途中まで作ったファイルを残さない**——書くのは
 * 音ができあがってからだけ。
 */
export async function exportVoiceAudio(
  target: VoiceExportTarget,
  service: VoiceReadingService,
  deps: VoiceExportDeps
): Promise<VoiceExportOutcome> {
  const { work, episodePath } = target;
  useLogFile(work.folderPath);
  const stop = (reason: string): VoiceExportOutcome => {
    void warnWithLog(reason);
    return { kind: "stopped", reason };
  };
  /*
    **エンジンに届かなかったら、右下でなく画面の真ん中の窓**（2026-11-08 作者の実機確認：
    「ポップアップさせてください」）。押したすぐ（計画・話者の一覧）でも、合成の途中でも同じ。
    ログは呼ぶ前に残してある（実装ルール5）
  */
  /** 届かなかったエンジン（失敗に印があればそれ、無ければ［声］で選んだ側） */
  const stopEngineDown = (error?: unknown): VoiceExportOutcome => ({
    kind: "stopped",
    reason: showVoiceEngineDown(
      "export",
      error instanceof VoiceEngineError && error.engine ? error.engine : target.engine
    ),
  });

  /*
    **待てる時間のうちに答えが来なかったら、届かないときとは別の窓**（0.147.1）。声づくりは文の長さと
    順番待ちを数えずに待つので、ここへ来るのはエンジンが止まったままのとき。1文の時間切れで書き出し
    全体を止める（作り終えた音を継いだ MP3 は、文が抜けた音になる）
  */
  const stopEngineSlow = (error?: unknown): VoiceExportOutcome => ({
    kind: "stopped",
    reason: showVoiceEngineSlow(
      "export",
      error instanceof VoiceEngineError && error.engine ? error.engine : target.engine
    ),
  });

  // 届かなかったエンジンの覚え（読み上げの間のもの）は使わず、押したときに問い合わせ直す（0.151.0）
  const planned = await service.plan(work, episodePath, target.text, target.sentences, target.engine, {
    recheckEngines: true,
  });
  if ("problem" in planned) {
    if (planned.engineDown) return stopEngineDown();
    if (planned.engineSlow) return stopEngineSlow();
    return stop(planned.problem);
  }
  const units = planned.units.filter((unit) => unit.speech.trim() !== "");
  if (units.length === 0) return stop("この話には、読み上げる文がありません。");

  /*
    使うエンジンごとに、話者の一覧と名乗り（brand_name）を引く。人物ごとに混ぜる形（2段目。0.151.0）
    では文の印から2つになる。**名乗りがそのエンジンと違えば止める**——
    接続先の設定が別のエンジンを指していると、ライセンスを別のエンジンの決まりで確かめてしまう
  */
  // 並びは決まった順（AivisSpeech・VOICEVOX）。最初の文の声で注意書きのエンジンの並びが変わらないように
  const engines = VOICE_ENGINE_IDS.filter((engine) => units.some((unit) => unit.engine === engine));
  const speakersOf = new Map<VoiceEngineId, VoiceSpeaker[]>();
  const brands = new Map<VoiceEngineId, { brand: EngineBrand; name: string }>();
  for (const engine of engines) {
    let brand: { brand: EngineBrand; name: string } | undefined;
    try {
      speakersOf.set(engine, await service.speakers(engine));
      brand = engineBrandOf(await service.engineClient(engine).engineManifest());
    } catch (error) {
      logEngineFailure("エンジンの名乗りを引く", error, work);
      if (isEngineUnreachable(error)) return stopEngineDown(error);
      if (isEngineTimeout(error)) return stopEngineSlow(error);
      brand = undefined;
    }
    if (!brand) {
      // 名乗りが読めない・知らないエンジン。どのライセンスの声か確かめられないので書き出さない
      return stop(
        "音声合成のエンジンが AivisSpeech か VOICEVOX か分からないため、声のライセンス・規約を確かめられず、書き出しませんでした。" +
          `設定 ${engineUrlSettingLabel(engine)} が ${VOICE_ENGINE_LABEL[engine]} を指しているか確かめてください。詳しくはログにあります。`
      );
    }
    if (ENGINE_OF_BRAND[brand.brand] !== engine) {
      // ［声］で選んでいない側（人物に割り当てた声のエンジン。2段目）なら、［声］を変えても直らない
      const why =
        engine === target.engine
          ? `［声］で ${VOICE_ENGINE_LABEL[engine]} を選んでいますが`
          : `人物の声に ${VOICE_ENGINE_LABEL[engine]} の声を割り当てていますが`;
      const fix =
        engine === target.engine
          ? `［声］で ${brand.name} を選ぶか、設定 ${engineUrlSettingLabel(engine)} を ${VOICE_ENGINE_LABEL[engine]} の接続先にしてください。`
          : `設定 ${engineUrlSettingLabel(engine)} を ${VOICE_ENGINE_LABEL[engine]} の接続先にするか、［声の割り当て］で選び直してください。`;
      return stop(
        `${why}、接続先のエンジンは ${brand.name} と名乗りました。` +
          `声のライセンス・規約を確かめられないので、書き出しませんでした（ファイルは作っていません）。` +
          fix
      );
    }
    brands.set(engine, brand);
  }

  const voices = usedVoices(units, speakersOf);
  if (typeof voices === "string") return stop(voices);
  const terms: VoiceTerms[] = [];
  const problems: string[] = [];
  for (const [engine, list] of voices) {
    const brand = brands.get(engine);
    if (!brand) continue;
    const gathered = await gatherTerms(service, engine, brand.brand, list, work);
    if ("problems" in gathered) problems.push(...gathered.problems);
    else terms.push(...gathered.terms);
  }
  if (problems.length > 0) {
    return stop(
      `ライセンス・規約を確かめられない声があるので、書き出しませんでした（ファイルは作っていません）。\n` +
        problems.map((line) => `・${line}`).join("\n")
    );
  }
  /** 注意書きに書くエンジンの名前（混ぜたときは「AivisSpeech・VOICEVOX」） */
  const engineName = [...brands.values()].map((b) => b.name).join("・");

  const stem = episodeStem(episodePath);
  const folder = voiceExportFolder(work, episodePath);
  const chars = units.reduce((sum, unit) => sum + unit.speech.length, 0);
  const gapSeconds = units.reduce((sum, unit, i) => sum + (i === 0 ? 0 : unit.gapMs), 0) / 1000;
  const estimate = minutesLabel(chars / CHARS_PER_SECOND + gapSeconds);
  const nonCommercial = terms.filter(isNonCommercial);
  /*
    かかる見込み（2026-11-14）。音の長さの見積もり×このエンジンで測った比。**測った比が無いエンジンが
    1つでもあれば出さない**（推測の数字を出さない）。ノートPC（CPU）では音の長さの約3.7倍かかった。
    文の間の無音は、その文のエンジンの分として数える
  */
  const expected = expectedWorkSeconds(
    engines.map((engine) => ({
      audioSeconds: units.reduce(
        (sum, unit, i) =>
          unit.engine === engine ? sum + unit.speech.length / CHARS_PER_SECOND + (i === 0 ? 0 : unit.gapMs / 1000) : sum,
        0
      ),
      ratio: service.paceRatio(engine),
    }))
  );

  /*
    確認は処理量を示してから（実装スタイル）。文の数・おおよその長さ・置き場。
    **非商用の声が混じれば、いちばん上に書いて警告の顔で訊く**（作者の答え5）
  */
  const ok = await confirmRun(
    [
      ...(nonCommercial.length > 0
        ? [`この声は非商用のみです：${nonCommercial.map(describeVoice).join("、")}。営利の目的では使えません。`]
        : []),
      `「${stem}」を人物の声で音声（MP3）に書き出します。${units.length}文・長さはおおよそ${estimate.replace(/^約/, "")}です。`,
      ...(expected !== undefined
        ? [`この PC では、書き出しにおおよそ${minutesLabel(expected).replace(/^約/, "")}かかる見込みです（前に測った速さから）。`]
        : []),
      `置き場：${shownFolder(work, folder)}/`,
      `使う声：${terms.map(describeVoice).join("、")}`,
      // 割り当てた声が引けず代わりの声で読むなら、書き出す前に分かるようにする（0.146.0）
      ...(planned.notice ? [planned.notice] : []),
      "本文は書き換えません。長い話は数分かかります（途中で中止できます）。",
    ].join("\n"),
    "書き出す",
    { work, ...(nonCommercial.length > 0 ? { kind: "warning" as const } : {}) }
  );
  if (!ok) return { kind: "declined" };

  // **本文を運ぶ前の確認**（外のホストのエンジンなら、朗読と同じ窓）
  for (const engine of engines) {
    const allowed = await service.allowCarryText(engine);
    if (!allowed.ok) {
      return stop(
        `本文を ${allowed.host} へ送ることを許可していないので、書き出しませんでした。` +
          `この PC の外のホストへ送りたくなければ、設定 ${engineUrlSettingLabel(engine)} をこの PC の接続先にしてください。`
      );
    }
  }

  logStep(
    `人物の声で音声に書き出す：開始 ${work.title} / ${stem} / ${units.length}文・${chars}字 / ${engineName} / ` +
      terms.map(describeVoice).join("、")
  );

  /*
    **2つのエンジンを混ぜるときは、標本化の速さを揃えて作らせる**（0.151.0）。既定の速さはエンジンごとに
    違い（AivisSpeech 44100・VOICEVOX 24000）、文ごとの WAV をつなぐ側（joinClips）は合わせ直す計算を
    持たない。揃えるのはエンジン自身（audio_query の outputSamplingRate）。1つのエンジンのときは今までどおり
    既定の速さのまま（朗読の控えも使える）
  */
  const mixedRate = engines.length > 1 ? { outputSamplingRate: VOICE_EXPORT_MIXED_SAMPLE_RATE } : {};

  type Made =
    | { mp3: Uint8Array; clip: PcmClip }
    | { failed: string }
    | { engineDown: unknown }
    | { engineSlow: unknown }
    | "cancelled";
  const made: Made = await withCancellableProgress("人物の声で音声に書き出しています", async (progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const wavs: Uint8Array[] = new Array(units.length);
      let next = 0;
      let done = 0;
      /*
        2つずつ頼む（エンジンは1つずつ作るが、送り返しと次の下ごしらえが重なる）。2つのエンジンを
        混ぜるときは、頼み手もエンジンの数だけ増やす（枠はエンジンごとなので、2つのエンジンが並んで作れる）
      */
      const worker = async (): Promise<void> => {
        while (next < units.length) {
          const index = next++;
          wavs[index] = await service.synthesizeForExport(
            units[index],
            VOICE_EXPORT_RATE,
            controller.signal,
            mixedRate
          );
          done++;
          progress.report({ message: `文 ${done}/${units.length}`, increment: 90 / units.length });
        }
      };
      await Promise.all(Array.from({ length: 2 * engines.length }, () => worker()));
      if (controller.signal.aborted) return "cancelled";
      const clip = joinClips(units.map((unit, i) => ({ clip: parseWav(wavs[i]), gapMs: unit.gapMs })));
      progress.report({ message: "MP3 に変換しています" });
      const factory = await deps.mp3Encoder();
      let reported = 0;
      const mp3 = await encodeMp3(clip, factory, {
        signal: controller.signal,
        onProgress: (fraction) => {
          const step = Math.floor(fraction * 10);
          if (step > reported) {
            progress.report({ message: `MP3 に変換しています（${step * 10}%）`, increment: (step - reported) });
            reported = step;
          }
        },
      });
      return { mp3, clip };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof VoiceEngineError && error.kind === "aborted")) {
        return "cancelled";
      }
      logEngineFailure("音を作る", error, work);
      if (isEngineUnreachable(error)) return { engineDown: error };
      if (isEngineTimeout(error)) return { engineSlow: error };
      return { failed: error instanceof WavError ? `${error.message}。` : engineProblem(error) };
    }
  });

  if (made === "cancelled") {
    notifyDone("音声の書き出しを中止しました。ファイルは作っていません。");
    return { kind: "cancelled" };
  }
  if ("engineDown" in made) return stopEngineDown(made.engineDown);
  if ("engineSlow" in made) return stopEngineSlow(made.engineSlow);
  if ("failed" in made) return stop(`音声に書き出せませんでした（ファイルは作っていません）。${made.failed}`);

  // ── ここから書く（新規作成だけ。上書きしない） ──
  const at = (deps.now ?? (() => new Date()))();
  const written: string[] = [];
  try {
    const names = await freshNames(folder, stem, terms);
    await vscode.workspace.fs.createDirectory(path.toUri(names.licenseDir));
    const encoder = new TextEncoder();
    for (const license of names.licenses) {
      await atomicWriteFile(license.file, encoder.encode(licenseFileBody(license.terms)), { mode: "create" });
      written.push(license.file);
    }
    const notice = buildCreditNotice({
      workTitle: work.title,
      episodeName: stem,
      engineName,
      at,
      voices: names.licenses.map((l) => ({ terms: l.terms, licenseFile: l.relative })),
    });
    await atomicWriteFile(names.notice, encoder.encode(notice), { mode: "create" });
    written.push(names.notice);
    await atomicWriteFile(names.mp3, made.mp3, { mode: "create" });
    written.push(names.mp3);

    const seconds = clipSeconds(made.clip);
    logStep(
      `人物の声で音声に書き出す：済み ${names.mp3}（${Math.round(seconds)}秒・${made.mp3.length}バイト）`
    );
    // 要点は知らせにも出す（作者の答え3）。［フォルダーを開く］は押されるのを待たない
    whenNoticePicked(
      vscode.window.showInformationMessage(
        `音声に書き出しました（${path.basename(names.mp3)}・${minutesLabel(seconds)}）。` +
          `${creditSummary(terms)}` +
          `条件は「${path.basename(names.notice)}」と全文のファイルを読んでください。`,
        "フォルダーを開く"
      ),
      (picked) => (picked === "フォルダーを開く" ? revealFolder(folder) : undefined),
      { label: "人物の声で音声に書き出す", workFolder: work.folderPath }
    );
    return {
      kind: "written",
      folder,
      mp3: names.mp3,
      notice: names.notice,
      licenseFiles: names.licenses.map((l) => l.file),
    };
  } catch (error) {
    logFailure("人物の声で音声に書き出す：ファイルを書く", {
      内容: error instanceof Error ? error.message : String(error),
      書けたもの: written.join("、") || "なし",
    });
    // **届いていないことを先に書く**（MP3 が無いのに「済んだ」と読ませない）
    return stop(
      `音声のファイルを書けませんでした（${error instanceof Error ? error.message : String(error)}）。` +
        (written.length > 0
          ? `途中まで書いたもの（${written.map((f) => path.basename(f)).join("、")}）は残っています。`
          : "ファイルは作っていません。") +
        "詳しくはログにあります。"
    );
  }
}
