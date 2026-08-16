import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import {
  CustomFieldStore,
  CustomFieldStoreError,
} from "../core/customFieldStore";
import {
  CUSTOM_FIELD_SCHEMA_VERSION,
  nextCustomFieldKey,
  validateNewField,
  type CustomFieldDefinition,
} from "../models/customField";
import { logFailure } from "../core/logger";
import { askText } from "../views/dialogs";

/**
 * 人物設定に作者が項目を足す・外す。
 *
 * 定義したその作品の**全人物**に同じ項目が並ぶ。人物ごとに違う項目にすると
 * 見比べられなくなるし、どの人物に何を書いたか作者が覚えていられない。
 *
 * 外すときは値を消さない。項目名を付け替えている途中かもしれないし、
 * 「消したら値まで消えた」は作者に見えない損失になる。
 * 定義を戻せば値も戻る。
 */

export async function manageCustomFields(work: WorkEntry): Promise<void> {
  const store = new CustomFieldStore(work);

  let fields: CustomFieldDefinition[];
  try {
    fields = (await store.load()).fields;
  } catch (error) {
    // 壊れたJSONを空として扱って上書きすると、作者が書いた定義が消える
    const message =
      error instanceof CustomFieldStoreError
        ? error.message
        : `項目の定義を読めませんでした: ${errorMessage(error)}`;
    logFailure("customFields.load", { work: work.title, message });
    void vscode.window.showErrorMessage(
      `${message} ファイルを直してから、もう一度お試しください。`
    );
    return;
  }

  const picked = await pickAction(fields);
  if (!picked) return;

  const updated =
    picked === "add" ? await addField(fields) : await removeField(fields);
  if (!updated) return;

  try {
    await store.save({
      schemaVersion: CUSTOM_FIELD_SCHEMA_VERSION,
      fields: updated,
    });
  } catch (error) {
    const message =
      error instanceof CustomFieldStoreError
        ? error.message
        : `項目を保存できませんでした: ${errorMessage(error)}`;
    logFailure("customFields.save", { work: work.title, message });
    void vscode.window.showErrorMessage(message);
    return;
  }

  void vscode.window.showInformationMessage(
    picked === "add"
      ? "項目を追加しました。設定資料を開くと、全員に入力欄が増えています。"
      : "項目を外しました。入力済みの内容は消えていません（項目を戻せば再び表示されます）。"
  );
}

type ManageAction = "add" | "remove";

async function pickAction(
  fields: CustomFieldDefinition[]
): Promise<ManageAction | undefined> {
  const current =
    fields.length > 0
      ? fields.map((field) => field.label).join("、")
      : "（まだありません）";

  const items: Array<vscode.QuickPickItem & { action: ManageAction }> = [
    {
      label: "$(add) 項目を追加",
      description: "全員の設定資料に入力欄が増えます",
      action: "add",
    },
  ];
  if (fields.length > 0) {
    items.push({
      label: "$(remove) 項目を外す",
      description: "入力済みの内容は消えません",
      action: "remove",
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `人物設定の項目　現在: ${current}`,
    placeHolder: "何をしますか？",
  });
  return picked?.action;
}

async function addField(
  fields: CustomFieldDefinition[]
): Promise<CustomFieldDefinition[] | undefined> {
  const label = await askText({
    title: "追加する項目の名前",
    placeHolder: "例: 誕生日 / 身長 / 好きな食べ物 / 家紋",
    prompt: "設定資料に出す見出しになります。",
    validateInput: (value) => validateNewField(fields, value) ?? null,
  });
  if (label === undefined) return undefined;

  const trimmedLabel = label.trim();

  const hint = await askText({
    title: `「${trimmedLabel}」の説明（省略できます）`,
    placeHolder: "例: 本文中で誕生日に触れている箇所があれば書く",
    prompt:
      "AIに項目を埋めさせるときに渡す説明です。" +
      "何を書いてほしいかが具体的なほど、外れた答えが減ります。",
  });
  if (hint === undefined) return undefined;

  const length = await vscode.window.showQuickPick(
    [
      {
        label: "短い（1行）",
        description: "誕生日・身長など",
        multiline: false,
      },
      {
        label: "長い（複数行）",
        description: "生い立ち・口癖など",
        multiline: true,
      },
    ],
    {
      title: `「${trimmedLabel}」の長さ`,
      placeHolder: "入力欄の高さに使います",
    }
  );
  if (!length) return undefined;

  return [
    ...fields,
    {
      key: nextCustomFieldKey(fields),
      label: trimmedLabel,
      hint: hint.trim(),
      multiline: length.multiline,
    },
  ];
}

async function removeField(
  fields: CustomFieldDefinition[]
): Promise<CustomFieldDefinition[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    fields.map((field) => ({
      label: field.label,
      description: field.hint,
      key: field.key,
    })),
    {
      title: "外す項目",
      placeHolder: "入力済みの内容は消えません。表示されなくなるだけです",
    }
  );
  if (!picked) return undefined;

  return fields.filter((field) => field.key !== picked.key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
