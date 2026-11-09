/**
 * Managed blocks.
 *
 * `gs` edits files it does not own (~/.gitconfig, ~/.ssh/config). Everything it
 * writes lives inside a marked block:
 *
 *     # >>> gs:managed v1 >>>   <-- marker, never escaped: HASH omitted
 *     ...content...
 *     # <<< gs:managed <<<
 *
 * Content outside the block is preserved byte for byte, including the exact
 * line endings used by the original file (CRLF on Windows must survive).
 */

export const BEGIN_MARKER = '# >>> gs:managed >>>';
export const END_MARKER = '# <<< gs:managed <<<';

export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockError';
  }
}

export interface BlockState {
  /** raw content inside the markers, without the marker lines */
  content: string;
  /** byte range of the whole block (markers included) within the file */
  start: number;
  end: number;
}

export interface ParsedBlock {
  present: boolean;
  /** content between the markers */
  content: string;
  start: number;
  end: number;
  /** true when the file contains a BEGIN without a matching END */
  broken: boolean;
}

export function detectEol(text: string): '\r\n' | '\n' {
  const idx = text.indexOf('\n');
  if (idx > 0 && text[idx - 1] === '\r') return '\r\n';
  return '\n';
}

/**
 * Locate the managed block. Throws when the file holds two blocks or an
 * orphaned marker, because guessing there risks corrupting a user file.
 */
export function findBlock(text: string): ParsedBlock {
  const lines = splitLines(text);
  let begin: { start: number; contentStart: number; index: number } | undefined;
  let end: { index: number; contentEnd: number; endPos: number } | undefined;

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed === BEGIN_MARKER) {
      if (begin) throw new BlockError('found more than one BEGIN marker; refusing to guess');
      begin = { start: line.start, contentStart: line.end, index: line.index };
    } else if (trimmed === END_MARKER) {
      if (!begin) throw new BlockError('found END marker before BEGIN marker');
      if (end) throw new BlockError('found more than one END marker; refusing to guess');
      end = { index: line.index, contentEnd: line.start, endPos: line.end };
    }
  }

  if (begin && !end) throw new BlockError('BEGIN marker without END marker');
  if (!begin || !end) {
    return { present: false, content: '', start: -1, end: -1, broken: false };
  }
  if (end.index < begin.index) throw new BlockError('END marker appears before BEGIN marker');

  return {
    present: true,
    content: text.slice(begin.contentStart, end.contentEnd),
    start: begin.start,
    end: end.endPos,
    broken: false,
  };
}

interface Line {
  text: string;
  start: number;
  end: number;
  index: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    // text excludes the trailing \n and \r
    let textEnd = nl === -1 ? text.length : nl;
    if (textEnd > start && text[start + (textEnd - start - 1)] === '\r') textEnd -= 1;
    lines.push({ text: text.slice(start, textEnd), start, end, index });
    start = end;
    index += 1;
  }
  return lines;
}

/**
 * Produce the new file content with the managed block set to `body`.
 *
 * - `body === null` removes the block (and the blank line that separated it).
 * - An empty body removes the block entirely rather than leaving empty markers.
 * - The surrounding text is returned untouched down to the last byte.
 */
export function upsertBlock(text: string, body: string | null, eol?: string): string {
  const newline = eol ?? detectEol(text);
  const block = findBlock(text);
  const normalisedBody = (body ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const desired =
    normalisedBody === ''
      ? ''
      : BEGIN_MARKER + newline + normalisedBody.split('\n').join(newline) + newline + END_MARKER + newline;

  if (block.present) {
    if (desired === '') return removeWithSeparator(text, block, newline);
    return text.slice(0, block.start) + desired + text.slice(block.end);
  }

  if (desired === '') return text;
  return appendBlock(text, desired, newline);
}

function appendBlock(text: string, block: string, newline: string): string {
  if (text === '') return block;
  const separator = text.endsWith(newline + newline) ? '' : text.endsWith(newline) ? newline : newline + newline;
  return text + separator + block;
}

function removeWithSeparator(text: string, block: ParsedBlock, newline: string): string {
  const before = text.slice(0, block.start);
  const after = text.slice(block.end);
  // collapse the separator line we added when appending
  if (before.endsWith(newline + newline) && (after === '' || after.startsWith(newline))) {
    return before.slice(0, before.length - newline.length) + after;
  }
  if (before === '' && after.startsWith(newline)) return after.slice(newline.length);
  return before + after;
}

/** FNV-1a 32-bit: enough to detect accidental hand edits, not a security hash. */
export function contentHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
