/**
 * Builds the text a prompt carries about the editor's current file/selection
 * (P1.5). The Excalibur ACP server accepts TEXT prompts only (no file-reference
 * content blocks), so the extension inlines the relevant code + a precise
 * `file:line` header into the prompt string. Pure + `vscode`-free → unit-tested.
 */

/** A normalized snapshot of the active editor, captured by the extension glue. */
export interface EditorContext {
  /** Workspace-relative (or absolute) path of the active file. */
  filePath?: string;
  /** The editor's languageId (for the fenced code block), e.g. `typescript`. */
  languageId?: string;
  /** A selection, 1-based inclusive line numbers + the selected text. */
  selection?: { startLine: number; endLine: number; text: string };
  /** The full document text (used by whole-file actions like Explain This File). */
  documentText?: string;
}

/** Caps so a huge file/selection never blows past the model's context. */
const MAX_SNIPPET_CHARS = 16_000;

function fence(languageId: string | undefined, body: string): string {
  const lang = languageId !== undefined && languageId.length > 0 ? languageId : '';
  const clipped =
    body.length > MAX_SNIPPET_CHARS
      ? `${body.slice(0, MAX_SNIPPET_CHARS)}\n… (truncated)`
      : body;
  return `\`\`\`${lang}\n${clipped}\n\`\`\``;
}

/** A one-line `file (lines a-b)` location header, or just the file, or empty. */
export function locationHeader(ctx: EditorContext): string {
  if (ctx.filePath === undefined || ctx.filePath.length === 0) {
    return '';
  }
  if (ctx.selection !== undefined) {
    const { startLine, endLine } = ctx.selection;
    const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
    return `${ctx.filePath} (${range})`;
  }
  return ctx.filePath;
}

/**
 * Composes the final prompt sent over ACP: the user's instruction, then a
 * `Context:` block embedding the selection (or, for whole-file actions, the
 * file). When there is no editor context, returns the bare instruction.
 */
export function buildPrompt(instruction: string, ctx: EditorContext = {}): string {
  const parts: string[] = [instruction.trim()];
  const header = locationHeader(ctx);

  if (ctx.selection !== undefined && ctx.selection.text.trim().length > 0) {
    parts.push(
      `Context — selected code from ${header || 'the active editor'}:`,
      fence(ctx.languageId, ctx.selection.text),
    );
  } else if (ctx.documentText !== undefined && ctx.documentText.trim().length > 0) {
    parts.push(
      `Context — the file ${header || 'open in the editor'}:`,
      fence(ctx.languageId, ctx.documentText),
    );
  } else if (header.length > 0) {
    parts.push(`(Active file: ${header})`);
  }

  return parts.join('\n\n');
}
