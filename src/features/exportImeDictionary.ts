import { openGeneratedMarkdown, revealFolder } from "../views/openDocument";
import * as vscode from "vscode";
import * as path from "../core/paths";
import { WorkEntry } from "../models/types";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { CharacterStore } from "../core/characterStore";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
  createWorldStore,
} from "../core/abilityStore";
import { atomicWriteFile } from "../core/atomicWrite";
import {
  DICTIONARY_FORMATS,
  buildDictionary,
  buildDictionaryPickItems,
  encodeDictionary,
  formatDictionary,
  imeExcludedKey,
  splitByEncodable,
  type DictionaryEntry,
  type DictionaryFormat,
  type ImeDialect,
} from "../core/imeDictionary";

/** 語を選ぶ一覧の項目。区切り線には `entry` が入らない */
interface WordPickItem extends vscode.QuickPickItem {
  entry?: DictionaryEntry;
}

/**
 * 抽出済みの設定からIMEのユーザー辞書を書き出す。
 *
 * 作品固有の固有名詞は変換で出てこないため、毎回打ち直すことになる。
 * 形式はIMEによって違うので、実行のたびに作者が選ぶ。
 * 設定に固定しないのは、複数のIMEを併用することがあるため。
 *
 * `state` は前回外した語の控え置き場（`context.globalState`）。
 * **無くても書き出しは動く**（毎回すべて選ばれた状態で出る）。
 */
export async function exportImeDictionary(
  work: WorkEntry,
  state?: vscode.Memento
): Promise<void> {
  const loadedCharacters = await new CharacterStore(work).loadAll();
  const loadedAbilities = await createAbilityStore(work).loadAll();
  const loadedLocations = await createLocationStore(work).loadAll();
  const loadedOrganizations = await createOrganizationStore(work).loadAll();
  const loadedWorld = await createWorldStore(work).loadAll();

  const errors = [
    ...loadedCharacters.errors,
    ...loadedAbilities.errors,
    ...loadedLocations.errors,
    ...loadedOrganizations.errors,
    ...loadedWorld.errors,
  ];
  if (errors.length > 0) {
    // 読めない設定があるまま書き出すと、欠けた辞書が正しく見えてしまう
    await vscode.window.showErrorMessage(
      "読み込めない設定ファイルがあるため、辞書を書き出しませんでした。" +
        `（${errors.map((error) => error.file).join("、")}）`
    );
    return;
  }

  const built = buildDictionary({
    characters: loadedCharacters.characters,
    abilities: loadedAbilities.records,
    locations: loadedLocations.records,
    organizations: loadedOrganizations.records,
    worldItems: loadedWorld.records,
  });

  if (built.entries.length === 0) {
    vscode.window.showInformationMessage(
      "辞書にできる語がありません。先に「まとめて生成」で設定資料を作ってください。"
    );
    return;
  }

  /**
   * どの語を辞書へ入れるかを先に選んでもらう（作者の依頼、2026-09-10）。
   *
   * 形式より先に置くのは、**選び終わってからでないと書き出す語数が
   * 決まらない**ため。形式の画面は「N 語を書き出します」と件数を名乗るので、
   * 順序が逆だと、そこに出る数と実際に書き出される数がずれる。
   */
  const excluded = state?.get<string[]>(imeExcludedKey(work.id)) ?? [];
  const wordItems: WordPickItem[] = buildDictionaryPickItems(
    built.entries,
    excluded
  ).map((item) =>
    item.separator
      ? { label: item.label, kind: vscode.QuickPickItemKind.Separator }
      : {
          label: item.label,
          description: item.description,
          detail: item.detail,
          picked: item.picked,
          entry: item.entry,
        }
  );

  const pickedWords = await vscode.window.showQuickPick(wordItems, {
    title: `${work.title}の辞書に入れる語（${built.entries.length}件）`,
    placeHolder: "外したい語のチェックを外してください",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  // Escで閉じたときは何も言わずに終える（作者が取りやめた）
  if (!pickedWords) return;

  const chosen = pickedWords
    .map((item) => item.entry)
    .filter((entry): entry is DictionaryEntry => entry !== undefined);
  if (chosen.length === 0) {
    // 空のファイルを置くと「書き出した」ように見えて、
    // 取り込んでも何も増えない理由が分からなくなる
    vscode.window.showInformationMessage(
      "1語も選ばれていないので書き出しませんでした。"
    );
    return;
  }

  /**
   * 外した語を作品ごとに覚えておく。
   *
   * 実データでは辞書に入る語が数百件になる。毎回同じ語のチェックを
   * 外し直させるなら、この一覧は使われなくなる。
   * 覚えるのは**外した語**のほうで、選んだ語ではない——そうしておけば
   * 設定資料を増やしたとき、新しい語は既定で入る。
   */
  if (state) {
    const kept = new Set(chosen.map((entry) => entry.surface));
    const nextExcluded = [
      ...new Set(
        built.entries
          .map((entry) => entry.surface)
          .filter((surface) => !kept.has(surface))
      ),
    ];
    await state.update(imeExcludedKey(work.id), nextExcluded);
  }

  const pickedFormats = await vscode.window.showQuickPick(
    Object.values(DICTIONARY_FORMATS).map((format) => ({
      label: format.label,
      description: format.fileName,
      // 但し書きがある形式は、取り込み手順より先に但し書きを見せる。
      // 「未検証」と知らずに使って原因不明のまま困るのを避けたい
      detail: format.note ? `${format.note} ${format.howTo}` : format.howTo,
      picked: format.defaultPicked,
      dialect: format.dialect,
    })),
    {
      title: `${chosen.length} 語を書き出します。形式を選んでください`,
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (!pickedFormats || pickedFormats.length === 0) return;

  const config = await readWorkConfig(work);
  const settingsDir = workPaths(work, config).settings;
  await vscode.workspace.fs.createDirectory(path.toUri(settingsDir));

  const written: string[] = [];
  /** 文字コードの都合で入れられなかった語。形式ごとに違うのでまとめて集める */
  const dropped = new Map<string, string[]>();
  for (const entry of pickedFormats) {
    const format = DICTIONARY_FORMATS[entry.dialect as ImeDialect];
    // Shift_JISに無い文字を含む語は、化けさせるくらいなら入れない。
    // 何が入らなかったかは後で作者に伝える
    const { usable, unencodable } = splitByEncodable(chosen, format.encoding);
    if (unencodable.length > 0) dropped.set(format.label, unencodable);

    const body = formatDictionary(usable, format.dialect, work.title);
    const target = path.join(settingsDir, format.fileName);
    try {
      await atomicWriteFile(target, encodeDictionary(body, format.encoding));
      written.push(format.fileName);
    } catch (error) {
      await vscode.window.showErrorMessage(
        `${format.label}用の辞書を保存できませんでした。` +
          (error instanceof Error ? error.message : String(error))
      );
      return;
    }
  }

  /**
   * 読みが無くて入らなかった語の伝え方。
   *
   * **「入力してください」とは書かない。** 実データで数えたところ、
   * 入らない語の大半は「廊下」「学校」「父上」のような普通の日本語だった。
   * これらは今のIMEでそのまま変換できるので、辞書に入れる意味が無い。
   * それどころか「学校」を地名、「父上」を人名として登録すると、
   * **作者の普段の日本語入力が悪くなる。**
   *
   * 入れる価値があるのは「聖言」「摂理神術」のような作品固有の語だけで、
   * それを見分けられるのは作者だけである。だから件数だけ伝えて、
   * 「必要なものだけ」という条件を先に置く。
   */
  const missingNote =
    built.missingReading.length > 0
      ? `\n読みが無いため入れなかった語が ${built.missingReading.length} 件あります` +
        `（${built.missingReading.slice(0, 5).join("、")}${
          built.missingReading.length > 5 ? " ほか" : ""
        }）。この中で**作品固有の語だけ**、設定資料パネルの「読み」に入れてください。` +
        "「廊下」「学校」のような普通の語は、入れると普段の変換がかえって悪くなります。"
      : "";

  /**
   * 文字コードで入らなかった語。**黙って減らさない。**
   * 語数だけ見て「全部入った」と思われると、
   * 後で「登録したはずの語が出てこない」と原因の分からない形で表面化する。
   */
  const droppedNote = [...dropped.entries()]
    .map(
      ([label, names]) =>
        `\n${label}は文字コードの都合で ${names.length} 件を入れられませんでした` +
        `（${names.slice(0, 5).join("、")}${names.length > 5 ? " ほか" : ""}）。`
    )
    .join("");

  const action = await vscode.window.showInformationMessage(
    `${chosen.length} 語の辞書を書き出しました（${written.join("、")}）。` +
      `${missingNote}${droppedNote}\n取り込み手順は各IMEの辞書ツールから行ってください。`,
    "フォルダーを開く",
    "取り込み手順を見る"
  );

  if (action === "フォルダーを開く") {
    await revealFolder(path.join(settingsDir, written[0]));
  } else if (action === "取り込み手順を見る") {
    // 手順を見ながらIMEの辞書ツールを操作するので、読める形で開く
    await openGeneratedMarkdown(
      "IME辞書の取り込み手順",
      buildHowToDocument(
        pickedFormats.map((entry) => entry.dialect as ImeDialect)
      )
    );
  }
}

/** 文字コードの表示名。作者が取り込み画面で選ぶときに使う */
function encodingLabel(encoding: DictionaryFormat["encoding"]): string {
  if (encoding === "utf16le") return "UTF-16 LE（BOM付き）";
  if (encoding === "shift_jis") return "Shift_JIS";
  return "UTF-8";
}

function buildHowToDocument(dialects: ImeDialect[]): string {
  const lines = ["# IME辞書の取り込み手順", ""];
  for (const dialect of dialects) {
    const format = DICTIONARY_FORMATS[dialect];
    lines.push(`## ${format.label}`, "");
    lines.push(`ファイル: \`設定/${format.fileName}\``, "");
    lines.push(format.howTo, "");
    lines.push(`文字コードは ${encodingLabel(format.encoding)} です。`, "");
    if (format.note) lines.push(`**${format.note}**`, "");
    if (format.encoding === "shift_jis") {
      lines.push(
        "Shift_JISには無い文字があります（「𠮷」のような字）。",
        "その字を含む語は、化けた形で登録されないよう**書き出しから外して**います。",
        "外した語は書き出し完了のお知らせに出ます。",
        ""
      );
    }
  }

  /**
   * **辞書でできないことを書く。**
   *
   * 書いておかないと「辞書を入れたのに変換が賢くならない」と受け取られる。
   * ユーザー辞書は変換候補を*増やす*ことはできるが、
   * 同音異義語の*並べ替え*はできない。そこはIME側の学習の担当で、
   * 拡張機能からは手が届かない。
   */
  lines.push(
    "## この辞書でできること・できないこと",
    "",
    "**できること**",
    "",
    "- 作品の固有名詞（人物・場所・能力・組織・造語）が変換候補に出るようになります",
    "",
    "**できないこと**",
    "",
    "- **同音異義語の並び順は変えられません。**「堅い／硬い／固い」のどれが先に出るかは",
    "  IME側の学習が決めていて、ユーザー辞書からは指示できません。",
    "  誤変換が本文に残ってしまった場合は、「表記ゆれ検知」や「誤字脱字検知」で見つけられます。",
    "- **取り込みの自動化はできません。** どのIMEも、外部から辞書を流し込む",
    "  正式な仕組みを用意していないため、取り込みは手作業になります。",
    "- **作品ごとの自動切り替えもできません。** 同じ理由です。",
    "  複数の作品を登録しても、作品固有の造語は読みが重なりにくいため、",
    "  実際にはあまり困りません。",
    "",
    "## うまく取り込めない場合",
    "",
    "文字コードが合っていない可能性があります。取り込み時のエラー内容を控えて、",
    "拡張機能の開発側へ伝えてください。形式を調整します。",
    ""
  );
  return lines.join("\n");
}
