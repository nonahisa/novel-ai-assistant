"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// _test_extract_run2.mts
var fs = __toESM(require("node:fs/promises"), 1);
var path2 = __toESM(require("node:path"), 1);

// src/core/episodeParser.ts
var path = __toESM(require("path"));
function toHalfWidthDigits(s) {
  return s.replace(
    /[０-９]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 65248)
  );
}
function parseEpisodeFileName(fileName) {
  const base = toHalfWidthDigits(path.basename(fileName, path.extname(fileName)).trim());
  const kind = detectKind(base);
  if (kind !== "\u672C\u7DE8") {
    const numInKind = base.match(/(\d+)\s*$/);
    return {
      chapterStart: numInKind ? parseInt(numInKind[1], 10) : null,
      chapterEnd: numInKind ? parseInt(numInKind[1], 10) : null,
      subtitle: null,
      kind,
      isInitialName: false
    };
  }
  const onlyNumber = base.match(/^(\d+)$/);
  if (onlyNumber) {
    const n = parseInt(onlyNumber[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: null,
      kind: "\u672C\u7DE8",
      isInitialName: true
    };
  }
  const range = base.match(/^(\d+)\s*[-–—~〜]\s*(\d+)(?:[\s_.．・-]+(.*))?$/);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    return {
      chapterStart: start,
      chapterEnd: end,
      subtitle: range[3]?.trim() || null,
      kind: "\u672C\u7DE8",
      isInitialName: !range[3]
    };
  }
  const withPrefix = base.match(/^第?\s*(\d+)\s*話(?:[\s_.．・-]+(.*))?$/);
  if (withPrefix) {
    const n = parseInt(withPrefix[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: withPrefix[2]?.trim() || null,
      kind: "\u672C\u7DE8",
      isInitialName: !withPrefix[2]
    };
  }
  const numberWithSubtitle = base.match(/^(\d+)[\s_.．・-]+(.+)$/);
  if (numberWithSubtitle) {
    const n = parseInt(numberWithSubtitle[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: numberWithSubtitle[2].trim(),
      kind: "\u672C\u7DE8",
      isInitialName: false
    };
  }
  const prefixRange = base.match(
    /^[A-Za-z]+[\s_.．・-]*(\d+)\s*[-–—~〜]\s*(\d+)(?:[\s_.．・-]+(.*))?$/
  );
  if (prefixRange) {
    return {
      chapterStart: parseInt(prefixRange[1], 10),
      chapterEnd: parseInt(prefixRange[2], 10),
      subtitle: prefixRange[3]?.trim() || null,
      kind: "\u672C\u7DE8",
      isInitialName: !prefixRange[3]
    };
  }
  const prefixNumber = base.match(
    /^[A-Za-z]+[\s_.．・-]*(\d+)(?:[\s_.．・-]+(.*))?$/
  );
  if (prefixNumber) {
    const n = parseInt(prefixNumber[1], 10);
    return {
      chapterStart: n,
      chapterEnd: n,
      subtitle: prefixNumber[2]?.trim() || null,
      kind: "\u672C\u7DE8",
      isInitialName: !prefixNumber[2]
    };
  }
  return {
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "\u4E0D\u660E",
    isInitialName: false
  };
}
function detectKind(base) {
  if (/^(プロローグ|序章|序|prologue)/i.test(base)) return "\u30D7\u30ED\u30ED\u30FC\u30B0";
  if (/^(エピローグ|終章|epilogue)/i.test(base)) return "\u30A8\u30D4\u30ED\u30FC\u30B0";
  if (/^(幕間|閑話|間章|interlude)/i.test(base)) return "\u5E55\u9593";
  return "\u672C\u7DE8";
}

// src/core/metadataParser.ts
var BODY_LABELS = ["\u672C\u6587", "\u307B\u3093\u3076\u3093"];
function parseEpisodeMetadata(rawText) {
  const text = rawText.replace(/\r\n?/g, "\n");
  if (!/^\s*【[^】]+】/.test(text)) {
    return emptyMetadata(text);
  }
  const blocks = splitHeaderBlocks(text);
  if (blocks.blocks.length === 0) {
    return emptyMetadata(text);
  }
  const find = (label) => {
    const b = blocks.blocks.find((x) => x.label === label);
    return b ? b.value.trim() || null : null;
  };
  const bodyBlock = blocks.blocks.find(
    (b) => BODY_LABELS.some((l) => b.label.startsWith(l))
  );
  if (!bodyBlock) {
    return emptyMetadata(text);
  }
  return {
    hasMetadata: true,
    title: find("\u30BF\u30A4\u30C8\u30EB"),
    publishState: find("\u516C\u958B\u72B6\u614B"),
    createdAt: find("\u4F5C\u6210\u65E5\u6642"),
    publishedAt: find("\u516C\u958B\u65E5\u6642"),
    updatedAt: find("\u66F4\u65B0\u65E5\u6642"),
    declaredCharCount: parseDeclaredCount(find("\u6587\u5B57\u6570")),
    body: bodyBlock.value.replace(/^\n+/, "")
  };
}
function splitHeaderBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) {
      current.value = buffer.join("\n");
      blocks.push(current);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const label = current === null ? "" : current.label;
    const isBodyStarted = label !== "" && BODY_LABELS.some((l) => label.startsWith(l));
    const m = isBodyStarted ? null : line.match(/^【([^】]+)】\s*$/);
    if (m) {
      flush();
      current = { label: normalizeLabel(m[1]), value: "" };
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return { blocks };
}
function normalizeLabel(label) {
  return label.replace(/[（(].*?[）)]\s*$/, "").trim();
}
function parseDeclaredCount(value) {
  if (!value) return null;
  const m = value.replace(/[,，]/g, "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function emptyMetadata(body) {
  return {
    hasMetadata: false,
    title: null,
    publishState: null,
    createdAt: null,
    publishedAt: null,
    updatedAt: null,
    declaredCharCount: null,
    body
  };
}

// src/core/textFile.ts
var vscode = __toESM(require("vscode"));
var crypto = __toESM(require("crypto"));
function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// src/core/chunker.ts
function decideChunkSize(contextWindow) {
  const usableTokens = Math.floor(contextWindow * 0.35);
  const chars = Math.floor(usableTokens * 0.7);
  return Math.max(1500, Math.min(chars, 2e4));
}
var DEFAULT_OPTIONS = {
  maxChars: 8e3,
  overlapChars: 0
};
function splitIntoChunks(filePath, text, chapterStart, chapterEnd, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length <= opts.maxChars) {
    return [
      {
        filePath,
        index: 0,
        text: normalized,
        startLine: 0,
        chapterStart,
        chapterEnd,
        hash: hashText(normalized)
      }
    ];
  }
  const chunks = [];
  let cursor = 0;
  let index = 0;
  while (cursor < normalized.length) {
    const hardEnd = Math.min(cursor + opts.maxChars, normalized.length);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      end = findBreakPoint(normalized, cursor, hardEnd);
    }
    const body = normalized.slice(cursor, end);
    const startLine = countLines(normalized, cursor);
    chunks.push({
      filePath,
      index,
      text: body,
      startLine,
      chapterStart,
      chapterEnd,
      hash: hashText(body)
    });
    index++;
    cursor = end;
    if (end <= cursor - 1) break;
  }
  return chunks;
}
function findBreakPoint(text, start, hardEnd) {
  const minEnd = start + Math.floor((hardEnd - start) * 0.7);
  const blankLine = text.lastIndexOf("\n\n", hardEnd);
  if (blankLine > minEnd) return blankLine + 2;
  const newline = text.lastIndexOf("\n", hardEnd);
  if (newline > minEnd) return newline + 1;
  for (let i = hardEnd; i > minEnd; i--) {
    if (text[i] === "\u3002") {
      let j = i + 1;
      while (j < text.length && /[」』）\)]/.test(text[j])) j++;
      return j;
    }
  }
  return hardEnd;
}
function countLines(text, upto) {
  let count = 0;
  for (let i = 0; i < upto; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

// src/models/character.ts
var CHARACTER_SCHEMA_VERSION = "0.1";
function emptyCharacter(id, name) {
  return {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    id,
    name,
    aliases: [],
    reading: null,
    romaji: null,
    icon: null,
    iconSource: "none",
    role: null,
    personality: null,
    appearance: null,
    physical: null,
    firstPerson: { default: null, variants: [] },
    defaultSecondPerson: null,
    addressTerms: [],
    relations: [],
    appearedChapters: [],
    status: "\u767B\u5834\u6E08\u307F",
    spoilerLevel: "public",
    authorNotes: "",
    exportNote: "",
    autoGenerated: true,
    evidence: null,
    conflicts: [],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function characterFileName(c) {
  const safeName = c.name.replace(/[/\\:*?"<>|\s]/g, "").slice(0, 30);
  return safeName ? `${c.id}_${safeName}.json` : `${c.id}.json`;
}
function nextCharacterId(existing) {
  let max = 0;
  for (const c of existing) {
    const m = c.id.match(/^char_(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `char_${String(max + 1).padStart(3, "0")}`;
}

// src/core/characterMerge.ts
function mergeExtractedCharacters(existing, extracted) {
  const result = existing.map((c) => ({ ...c }));
  const added = [];
  const updated = [];
  const conflicts = [];
  for (const item of extracted) {
    const ex = item.data;
    if (!ex.name || !ex.name.trim()) continue;
    const match = findCharacter(result, ex.name, ex.aliases ?? []);
    if (!match) {
      const c = emptyCharacter(nextCharacterId(result), ex.name.trim());
      applyExtracted(c, ex, item.chapters, conflicts);
      result.push(c);
      added.push(c.name);
      continue;
    }
    if (!match.autoGenerated) {
      const before = match.appearedChapters.length;
      match.appearedChapters = mergeChapters(
        match.appearedChapters,
        item.chapters
      );
      if (match.appearedChapters.length !== before) updated.push(match.name);
      continue;
    }
    const changed = applyExtracted(match, ex, item.chapters, conflicts);
    if (changed && !updated.includes(match.name)) updated.push(match.name);
  }
  return { characters: result, added, updated, conflicts };
}
function applyExtracted(target, ex, chapters, conflicts) {
  let changed = false;
  const aliases = new Set(target.aliases);
  const incomingName = ex.name?.trim();
  if (incomingName && incomingName !== target.name && !aliases.has(incomingName)) {
    aliases.add(incomingName);
    changed = true;
  }
  for (const a of ex.aliases ?? []) {
    if (a && a !== target.name && !aliases.has(a)) {
      aliases.add(a);
      changed = true;
    }
  }
  target.aliases = [...aliases];
  changed = fillOrConflict(target, "role", ex.role, conflicts) || changed;
  changed = fillOrConflict(target, "personality", ex.personality, conflicts) || changed;
  changed = fillOrConflict(target, "appearance", ex.appearance, conflicts) || changed;
  if (ex.firstPerson) {
    if (!target.firstPerson.default) {
      target.firstPerson.default = ex.firstPerson;
      changed = true;
    } else if (target.firstPerson.default !== ex.firstPerson) {
      const exists = target.firstPerson.variants.some(
        (v) => v.form === ex.firstPerson
      );
      if (!exists) {
        target.firstPerson.variants.push({
          form: ex.firstPerson,
          context: null,
          chapters: [...chapters],
          evidence: ex.evidence ?? null
        });
        changed = true;
      }
    }
  }
  if (ex.defaultSecondPerson && !target.defaultSecondPerson) {
    target.defaultSecondPerson = ex.defaultSecondPerson;
    changed = true;
  }
  for (const at of ex.addressTerms ?? []) {
    if (!at.targetName || !at.term) continue;
    if (mergeAddressTerm(target, at, chapters)) changed = true;
  }
  for (const rel of ex.relations ?? []) {
    if (!rel.name || !rel.relation) continue;
    const exists = target.relations.some(
      (r) => r.name === rel.name && r.relation === rel.relation
    );
    if (!exists) {
      target.relations.push({ name: rel.name, relation: rel.relation });
      changed = true;
    }
  }
  if (!target.evidence && ex.evidence) {
    target.evidence = ex.evidence;
    changed = true;
  }
  const before = target.appearedChapters.length;
  target.appearedChapters = mergeChapters(target.appearedChapters, chapters);
  if (target.appearedChapters.length !== before) changed = true;
  return changed;
}
function mergeAddressTerm(target, incoming, chapters) {
  let entry = target.addressTerms.find(
    (a) => normalizeName(a.targetName) === normalizeName(incoming.targetName)
  );
  if (!entry) {
    entry = {
      targetName: incoming.targetName,
      targetId: null,
      forms: [],
      authorLocked: false
    };
    target.addressTerms.push(entry);
  }
  if (entry.authorLocked) return false;
  const chapter = chapters.length > 0 ? Math.min(...chapters) : null;
  const lastChapter = chapters.length > 0 ? Math.max(...chapters) : null;
  const existingForm = entry.forms.find((f) => f.term === incoming.term);
  if (existingForm) {
    let changed = false;
    if (chapter !== null && (existingForm.firstChapter === null || chapter < existingForm.firstChapter)) {
      existingForm.firstChapter = chapter;
      changed = true;
    }
    if (lastChapter !== null && (existingForm.lastChapter === null || lastChapter > existingForm.lastChapter)) {
      existingForm.lastChapter = lastChapter;
      changed = true;
    }
    if (!existingForm.context && incoming.context) {
      existingForm.context = incoming.context;
      changed = true;
    }
    return changed;
  }
  entry.forms.push({
    term: incoming.term,
    category: incoming.category ?? null,
    context: incoming.context ?? null,
    firstChapter: chapter,
    lastChapter,
    status: "current",
    evidence: incoming.evidence ?? null
  });
  return true;
}
function fillOrConflict(target, field, incoming, conflicts) {
  const value = incoming?.trim();
  if (!value) return false;
  const current = target[field];
  if (!current) {
    target[field] = value;
    return true;
  }
  if (current === value) return false;
  if (value.includes(current)) {
    target[field] = value;
    return true;
  }
  if (current.includes(value)) return false;
  const already = target.conflicts.find((c) => c.field === field);
  if (already) {
    if (!already.values.includes(value)) {
      already.values.push(value);
      conflicts.push({
        characterName: target.name,
        field,
        values: already.values
      });
      return true;
    }
    return false;
  }
  target.conflicts.push({
    field,
    values: [current, value],
    chapters: [...target.appearedChapters],
    note: null
  });
  conflicts.push({
    characterName: target.name,
    field,
    values: [current, value]
  });
  return true;
}
function findCharacter(list, name, aliases) {
  const keys = [name, ...aliases].map(normalizeName);
  return list.find((c) => {
    const candidates = [c.name, ...c.aliases].map(normalizeName);
    return candidates.some((cand) => keys.includes(cand));
  });
}
function normalizeName(s) {
  return s.replace(/[\s\u3000・･]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).toLowerCase();
}
function mergeChapters(existing, incoming) {
  const set = new Set(existing);
  for (const n of incoming) {
    if (Number.isFinite(n)) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

// src/features/extractCharacters.ts
var vscode8 = __toESM(require("vscode"));

// src/ai/registry.ts
var vscode3 = __toESM(require("vscode"));

// src/ai/ollamaProvider.ts
var vscode2 = __toESM(require("vscode"));

// src/core/scanner.ts
var vscode5 = __toESM(require("vscode"));

// src/core/workRegistry.ts
var vscode4 = __toESM(require("vscode"));

// src/core/characterStore.ts
var vscode6 = __toESM(require("vscode"));

// src/prompts/characterExtract.ts
var BASE_SYSTEM_PROMPT = `\u3042\u306A\u305F\u306F\u65E5\u672C\u8A9E\u306E\u5C0F\u8AAC\u57F7\u7B46\u3092\u652F\u63F4\u3059\u308B\u7DE8\u96C6\u30A2\u30B7\u30B9\u30BF\u30F3\u30C8\u3067\u3059\u3002

\u3010\u7D76\u5BFE\u306B\u5B88\u308B\u539F\u5247\u3011
1. \u672C\u6587\u306B\u66F8\u304B\u308C\u3066\u3044\u306A\u3044\u60C5\u5831\u3092\u63A8\u6E2C\u3067\u88DC\u3063\u3066\u65AD\u5B9A\u3057\u306A\u3044\u3053\u3068\u3002\u6839\u62E0\u304C\u672C\u6587\u306B\u306A\u3044\u5834\u5408\u306F
   \u8A72\u5F53\u30D5\u30A3\u30FC\u30EB\u30C9\u3092 null \u307E\u305F\u306F\u7A7A\u914D\u5217\u3068\u3057\u3001confidence \u3092 low \u3068\u3059\u308B\u3053\u3068\u3002
2. \u4F5C\u8005\u306E\u6587\u4F53\u30FB\u8868\u73FE\u306E\u597D\u307F\u3092\u5C0A\u91CD\u3059\u308B\u3053\u3068\u3002\u3042\u306A\u305F\u306E\u597D\u307F\u3067\u66F8\u304D\u63DB\u3048\u3092\u63D0\u6848\u3057\u306A\u3044\u3002
3. \u6307\u6458\u3084\u63D0\u6848\u3092\u884C\u3046\u969B\u306F\u3001\u5FC5\u305A\u672C\u6587\u4E2D\u306E\u8A72\u5F53\u7B87\u6240\u3092\u7279\u5B9A\u3067\u304D\u308B\u60C5\u5831\u3092\u6DFB\u3048\u308B\u3053\u3068\u3002
4. \u51FA\u529B\u306F\u6307\u5B9A\u3055\u308C\u305FJSON\u5F62\u5F0F\u306E\u307F\u3068\u3057\u3001\u524D\u7F6E\u304D\u30FB\u5F8C\u66F8\u304D\u30FB\u8AAC\u660E\u6587\u30FB
   \u30DE\u30FC\u30AF\u30C0\u30A6\u30F3\u306E\u30B3\u30FC\u30C9\u30D5\u30A7\u30F3\u30B9\u3092\u4E00\u5207\u542B\u3081\u306A\u3044\u3053\u3068\u3002
5. \u4F5C\u54C1\u4E16\u754C\u306E\u8A2D\u5B9A\uFF08\u9020\u8A9E\u3001\u56FA\u6709\u540D\u8A5E\u3001\u72EC\u81EA\u306E\u8A00\u3044\u56DE\u3057\uFF09\u3092\u8AA4\u308A\u3068\u3057\u3066\u6271\u308F\u306A\u3044\u3053\u3068\u3002
   \u5224\u65AD\u306B\u8FF7\u3046\u5834\u5408\u306F\u6307\u6458\u305B\u305A\u3001confidence \u3092 low \u306B\u3059\u308B\u3053\u3068\u3002`;
function buildCharacterExtractPrompt(input) {
  const known = input.knownCharacterNames.length > 0 ? input.knownCharacterNames.join("\u3001") : "\uFF08\u307E\u3060\u767B\u9332\u3055\u308C\u3066\u3044\u307E\u305B\u3093\uFF09";
  return `\u4EE5\u4E0B\u306E\u5C0F\u8AAC\u672C\u6587\u304B\u3089\u3001\u767B\u5834\u4EBA\u7269\u306E\u60C5\u5831\u3092\u62BD\u51FA\u3057\u3066\u304F\u3060\u3055\u3044\u3002

\u3010\u672C\u6587\u3011\uFF08${input.chapterLabel}\uFF09
${input.chunkText}

\u3010\u65E2\u77E5\u306E\u767B\u5834\u4EBA\u7269\u3011\uFF08\u540C\u4E00\u4EBA\u7269\u306E\u5224\u5B9A\u306B\u4F7F\u7528\uFF09
${known}

\u3010\u62BD\u51FA\u30EB\u30FC\u30EB\u3011
- \u540D\u524D\u306E\u3042\u308B\u4EBA\u7269\u3001\u304A\u3088\u3073\u7269\u8A9E\u4E0A\u610F\u5473\u3092\u6301\u3064\u7121\u540D\u306E\u4EBA\u7269\uFF08\u300C\u8001\u3044\u305F\u9580\u756A\u300D\u7B49\uFF09\u3092\u5BFE\u8C61\u3068\u3059\u308B\u3002
- \u540C\u4E00\u4EBA\u7269\u304C\u5225\u306E\u547C\u79F0\u3067\u767B\u5834\u3059\u308B\u5834\u5408\uFF08\u672C\u540D\uFF0F\u901A\u79F0\uFF0F\u3042\u3060\u540D\uFF0F\u5F79\u8077\uFF09\u3001\u65E2\u77E5\u306E\u767B\u5834\u4EBA\u7269\u3068
  \u7167\u5408\u3057\u3001\u540C\u4E00\u3068\u5224\u65AD\u3067\u304D\u308B\u5834\u5408\u306F\u65E2\u77E5\u306E\u540D\u524D\u3092 name \u3068\u3057\u3001\u5225\u547C\u79F0\u3092 aliases \u306B\u5165\u308C\u308B\u3053\u3068\u3002
  \u5224\u65AD\u3067\u304D\u306A\u3044\u5834\u5408\u306F\u65B0\u898F\u4EBA\u7269\u3068\u3057\u3066\u6271\u3046\u3053\u3068\u3002
- \u5404\u9805\u76EE\u306F\u3001\u3053\u306E\u672C\u6587\u7BC4\u56F2\u304B\u3089\u8AAD\u307F\u53D6\u308C\u308B\u5185\u5BB9\u306E\u307F\u3092\u66F8\u304F\u3053\u3068\u3002\u8AAD\u307F\u53D6\u308C\u306A\u3044\u9805\u76EE\u306F
  null \u3068\u3059\u308B\u3053\u3068\u3002\u63A8\u6E2C\u3067\u57CB\u3081\u306A\u3044\u3053\u3068\u3002
- \u300C\u50D5\u300D\u300C\u79C1\u300D\u300C\u4FFA\u300D\u7B49\u306E\u4E00\u4EBA\u79F0\u3084\u3001\u300C\uFF08\u4E3B\uFF09\u300D\u306E\u3088\u3046\u306A\u62BD\u8C61\u7684\u306A\u81EA\u79F0\u3060\u3051\u3092 name \u306B
  \u4F7F\u308F\u306A\u3044\u3053\u3068\u3002name \u306F\u65E2\u77E5\u306E\u767B\u5834\u4EBA\u7269\u3068\u7167\u5408\u3059\u308B\u305F\u3081\u306E\u8B58\u5225\u5B50\u3068\u3057\u3066\u4F55\u5EA6\u3082\u4F7F\u308F\u308C\u308B
  \u305F\u3081\u3001\u3044\u3063\u305F\u3093\u4E00\u4EBA\u79F0\u3084\u81EA\u79F0\u3067\u767B\u9332\u3059\u308B\u3068\u3001\u5F8C\u306E\u672C\u6587\u3067\u672C\u540D\u304C\u5224\u660E\u3057\u3066\u3082\u672C\u540D\u306E\u65B9\u304C
  \u5225\u547C\u79F0\uFF08alias\uFF09\u3068\u3057\u3066\u6271\u308F\u308C\u3066\u3057\u307E\u3046\u3002\u3053\u306E\u672C\u6587\u7BC4\u56F2\u306B\u305D\u306E\u4EBA\u7269\u3092\u6307\u3059\u5177\u4F53\u7684\u306A
  \u540D\u524D\u30FB\u547C\u79F0\u30FB\u5F79\u8077\u304C\u4E00\u5207\u767B\u5834\u3057\u306A\u3044\u5834\u5408\u306F\u3001\u7121\u7406\u306B name \u3092\u4F5C\u3089\u305A\u30EC\u30B3\u30FC\u30C9\u81EA\u4F53\u3092
  \u4F5C\u6210\u3057\u306A\u3044\u3053\u3068\u3002\u4E00\u4EBA\u79F0\u306F firstPerson \u306B\u8A18\u9332\u3059\u308B\u3053\u3068\u3002

\u3010\u547C\u79F0\u306E\u62BD\u51FA\u30EB\u30FC\u30EB\u3011\uFF08\u91CD\u8981\uFF09
\u547C\u79F0\u306F\u300C\u8AB0\u304C\u8AB0\u3092\u3069\u3046\u547C\u3093\u3060\u304B\u300D\u306E\u65B9\u5411\u3092\u6301\u3064\u60C5\u5831\u3067\u3059\u3002
1. \u4F1A\u8A71\u6587\u30FB\u5FC3\u5185\u8A9E\u306E\u4E2D\u3067\u3001\u3042\u308B\u4EBA\u7269\u304C\u5225\u306E\u4EBA\u7269\u3092\u547C\u3093\u3060\u8868\u73FE\u3092\u3059\u3079\u3066\u62FE\u3046\u3053\u3068\u3002
   \u4F8B\uFF1A\u300C\u767D\u702C\u3055\u3093\u3001\u305D\u308C\u306F\u9055\u3046\u300D\u2192 \u8A71\u8005\u304C\u767D\u702C\u3092\u300C\u767D\u702C\u3055\u3093\u300D\u3068\u547C\u3093\u3067\u3044\u308B
2. \u540C\u3058\u76F8\u624B\u306B\u8907\u6570\u306E\u547C\u3073\u65B9\u304C\u3042\u308B\u5834\u5408\u3001\u3059\u3079\u3066\u8A18\u9332\u3059\u308B\u3053\u3068\u3002
   \u307E\u3068\u3081\u305F\u308A\u4EE3\u8868\u7684\u306A\u3082\u306E1\u3064\u306B\u7D5E\u3063\u305F\u308A\u3057\u306A\u3044\u3053\u3068\u3002
   \u4F8B\uFF1A\u5E73\u6642\u306F\u300C\u6FAA\u300D\u3001\u6012\u3063\u305F\u6642\u306F\u300C\u767D\u702C\u300D\u3001\u4EBA\u524D\u3067\u306F\u300C\u767D\u702C\u3055\u3093\u300D\u2192 3\u4EF6\u3059\u3079\u3066\u8A18\u9332
3. \u4F7F\u3044\u5206\u3051\u306E\u6761\u4EF6\u304C\u672C\u6587\u304B\u3089\u8AAD\u307F\u53D6\u308C\u308B\u5834\u5408\u306E\u307F context \u306B\u8A18\u8FF0\u3059\u308B\u3002
4. \u8A71\u8005\u304C\u8AB0\u304B\u7279\u5B9A\u3067\u304D\u306A\u3044\u767A\u8A71\u306E\u547C\u79F0\u306F\u62BD\u51FA\u3057\u306A\u3044\u3053\u3068\u3002\u63A8\u6E2C\u3067\u8A71\u8005\u3092\u6C7A\u3081\u3064\u3051\u306A\u3044\u3053\u3068\u3002
5. \u656C\u79F0\u30FB\u63A5\u5C3E\u8F9E\uFF08\u3055\u3093\u3001\u304F\u3093\u3001\u69D8\u3001\u3061\u3083\u3093\u3001\u5148\u8F29\u3001\u6BBF\uFF09\u306F\u7701\u7565\u305B\u305A\u3001
   \u672C\u6587\u306B\u51FA\u3066\u304D\u305F\u5F62\u306E\u307E\u307E\u8A18\u9332\u3059\u308B\u3053\u3068\u3002
6. \u300C\u541B\u300D\u300C\u304A\u524D\u300D\u300C\u3042\u306A\u305F\u300D\u306A\u3069\u7279\u5B9A\u306E\u76F8\u624B\u3092\u6301\u305F\u306A\u3044\u4E00\u822C\u7684\u306A\u547C\u3073\u304B\u3051\u306F
   defaultSecondPerson \u306B\u5165\u308C\u3001addressTerms \u306B\u306F\u5165\u308C\u306A\u3044\u3053\u3068\u3002

\u3010\u51FA\u529B\u5F62\u5F0F\u3011
\u6307\u5B9A\u3055\u308C\u305FJSON\u5F62\u5F0F\u306E\u307F\u3092\u51FA\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`;
}
var CHARACTER_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          role: { type: ["string", "null"] },
          personality: { type: ["string", "null"] },
          appearance: { type: ["string", "null"] },
          firstPerson: { type: ["string", "null"] },
          defaultSecondPerson: { type: ["string", "null"] },
          addressTerms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                targetName: { type: "string" },
                term: { type: "string" },
                category: { type: ["string", "null"] },
                context: { type: ["string", "null"] },
                evidence: { type: ["string", "null"] }
              },
              required: ["targetName", "term"]
            }
          },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                relation: { type: "string" }
              },
              required: ["name", "relation"]
            }
          },
          evidence: { type: ["string", "null"] }
        },
        required: ["name"]
      }
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  required: ["characters"]
};

// src/core/chunkCache.ts
var vscode7 = __toESM(require("vscode"));

// src/features/extractCharacters.ts
var INVALID_NAME_PATTERN = /^(null|undefined|不明|なし|n\/?a|none)$/i;
var MAX_NAME_LENGTH = 30;
function collect(out, result, chunk) {
  const chapters = [];
  if (chunk.chapterStart !== null) {
    const end = chunk.chapterEnd ?? chunk.chapterStart;
    for (let n = chunk.chapterStart; n <= end; n++) chapters.push(n);
  }
  for (const c of result.characters ?? []) {
    if (!c || typeof c.name !== "string") continue;
    const name = c.name.trim();
    if (!name) continue;
    if (INVALID_NAME_PATTERN.test(name)) continue;
    if (name.length > MAX_NAME_LENGTH) continue;
    if (!evidenceIsGrounded(c.evidence, chunk.text)) continue;
    out.push({ data: c, chapters });
  }
}
function evidenceIsGrounded(evidence, chunkText) {
  if (!evidence || !evidence.trim()) return true;
  const segments = evidence.split(/[\n。]/).map((s) => s.replace(/^[「『"'…\s]+|[」』"'…\s]+$/g, "")).filter((s) => s.length >= 4);
  if (segments.length === 0) return true;
  return segments.some((s) => chunkText.includes(s));
}
function parseResult(text) {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text)
  ];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && Array.isArray(parsed.characters)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}
function extractBraces(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// _test_extract_run2.mts
var WORK_DIR = "C:\\Users\\nonah\\Documents\\\u3053\u3061\u3089\u5192\u967A\u8005\u30AE\u30EB\u30C9\u751F\u6D3B\u4FDD\u8B77\u8AB2!!";
var MODEL = "gemma4:e4b";
var CONTEXT_WINDOW = 131072;
var OLLAMA_ENDPOINT = "http://localhost:11434";
async function main() {
  const chunkChars = decideChunkSize(CONTEXT_WINDOW);
  const entries = (await fs.readdir(WORK_DIR, { withFileTypes: true })).filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name));
  const chunks = [];
  for (const e of entries) {
    const filePath = path2.join(WORK_DIR, e.name);
    const raw = await fs.readFile(filePath);
    const text = decodeBytes(raw).replace(/\r\n?/g, "\n");
    const meta = parseEpisodeMetadata(text);
    if (!meta.body.trim()) continue;
    const parsed = parseEpisodeFileName(e.name);
    chunks.push(
      ...splitIntoChunks(filePath, meta.body, parsed.chapterStart, parsed.chapterEnd, {
        maxChars: chunkChars
      })
    );
  }
  chunks.sort((a, b) => (a.chapterStart ?? 999) - (b.chapterStart ?? 999));
  console.log(`\u7DCF\u30C1\u30E3\u30F3\u30AF\u6570: ${chunks.length}`);
  const numCtx = Math.min(CONTEXT_WINDOW, 16384);
  const extractedAll = [];
  const timings = [];
  for (const chunk of chunks) {
    const label = describeChunk(chunk);
    const knownNames = [...new Set(extractedAll.map((e) => e.data.name))].slice(0, 100);
    const userPrompt = buildCharacterExtractPrompt({
      chunkText: chunk.text,
      chapterLabel: label,
      knownCharacterNames: knownNames
    });
    const started = Date.now();
    const res = await fetchJson("/api/chat", {
      model: MODEL,
      stream: false,
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      options: { temperature: 0.2, num_ctx: numCtx },
      format: CHARACTER_EXTRACT_SCHEMA,
      think: false
    }, 18e4);
    const elapsed = Date.now() - started;
    timings.push(elapsed);
    const text = res.message?.content ?? "";
    const parsed = parseResult(text);
    if (!parsed) {
      console.log(`  [\u5931\u6557] ${label} (${elapsed}ms) \u2014 JSON\u89E3\u6790\u5931\u6557`);
      continue;
    }
    const before = extractedAll.length;
    collect(extractedAll, parsed, chunk);
    const added = extractedAll.length - before;
    console.log(`  [\u5B8C\u4E86] ${label} (${elapsed}ms) \u2014 \u4EBA\u7269 ${added} \u4EF6`);
  }
  const merged = mergeExtractedCharacters([], extractedAll);
  console.log(
    `
\u30DE\u30FC\u30B8\u5F8C: \u767B\u5834\u4EBA\u7269 ${merged.characters.length} \u540D / \u65B0\u898F ${merged.added.length} / \u66F4\u65B0 ${merged.updated.length} / \u8981\u78BA\u8A8D ${merged.conflicts.length}`
  );
  const outDir = path2.join(WORK_DIR, "\u8A2D\u5B9A", "characters");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  for (const c of merged.characters) {
    const fileName = characterFileName(c);
    const body = JSON.stringify({ ...c, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2);
    await fs.writeFile(path2.join(outDir, fileName), body + "\n", "utf8");
  }
  const totalMs = timings.reduce((s, t) => s + t, 0);
  console.log(`
\u6240\u8981\u6642\u9593\u5408\u8A08: ${(totalMs / 1e3).toFixed(1)}\u79D2`);
  console.log("\n\u751F\u6210\u3055\u308C\u305F\u4EBA\u7269\u540D\u4E00\u89A7:");
  for (const c of merged.characters) {
    console.log(`  - ${c.name}  (aliases: ${c.aliases.join(", ") || "\u306A\u3057"})`);
  }
}
function decodeBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}
function describeChunk(chunk) {
  const name = path2.basename(chunk.filePath);
  if (chunk.chapterStart === null) return name;
  const ch = chunk.chapterEnd !== null && chunk.chapterEnd !== chunk.chapterStart ? `\u7B2C${chunk.chapterStart}\u301C${chunk.chapterEnd}\u8A71` : `\u7B2C${chunk.chapterStart}\u8A71`;
  return chunk.index > 0 ? `${ch}(${chunk.index + 1})` : ch;
}
async function fetchJson(p, body, timeoutMs = 8e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}${p}`, {
      method: body === void 0 ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
main().catch((e) => {
  console.error("\u81F4\u547D\u7684\u30A8\u30E9\u30FC:", e);
  process.exit(1);
});
