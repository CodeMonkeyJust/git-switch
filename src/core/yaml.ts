/**
 * Minimal YAML subset parser / serialiser.
 *
 * The goal is NOT general YAML support. It covers exactly what
 * `profiles.yaml` needs so that `gs` keeps zero runtime dependencies:
 *
 *   - block mappings            key: value
 *   - block sequences           - item
 *   - nesting by 2-space indent
 *   - comments                  # ...
 *   - scalars: plain, 'single', "double", integers, booleans
 *   - inline flow sequences     [a, b, c]
 *
 * Unsupported (and rejected with a clear error instead of misparsed):
 * anchors/aliases, multi-line scalars (| and >), flow mappings ({a: b}),
 * tabs for indentation, multiple documents.
 */

export class YamlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`YAML line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

type Scalar = string | number | boolean | null;
export type YamlValue = Scalar | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
  no: number;
}

const INDENT = 2;

function preprocess(source: string): Line[] {
  const out: Line[] = [];
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    if (raw.trim() === '') continue;
    if (raw.trimStart().startsWith('#')) continue;
    if (/^\s*\t/.test(raw)) {
      throw new YamlError('tabs are not allowed for indentation (use spaces)', i + 1);
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent % INDENT !== 0) {
      throw new YamlError(`indentation must be a multiple of ${INDENT} spaces`, i + 1);
    }
    const text = stripComment(raw.trim());
    if (text === '') continue;
    out.push({ indent, text, no: i + 1 });
  }
  return out;
}

/** Remove a trailing comment that is not inside quotes. */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function parseScalar(token: string, line: number): Scalar {
  const t = token.trim();
  if (t === '') return null;
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (t.startsWith("'") || t.startsWith('"')) {
    const quote = t[0] as '"' | "'";
    if (!t.endsWith(quote) || t.length < 2) {
      throw new YamlError('unterminated quoted scalar', line);
    }
    const inner = t.slice(1, -1);
    return quote === "'" ? inner.replace(/''/g, "'") : unescapeDouble(inner, line);
  }
  return t;
}

function unescapeDouble(inner: string, line: number): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[++i];
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        throw new YamlError(`unsupported escape sequence \\${next ?? ''}`, line);
    }
  }
  return out;
}

function parseFlowSequence(text: string, line: number): YamlValue[] {
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  const parts = splitFlowItems(inner, line);
  return parts.map((p) => parseScalar(p, line));
}

/** `{ a: 1, b: x }` -> mapping. One line only, no nesting of flow mappings. */
function parseFlowMapping(text: string, line: number): { [key: string]: YamlValue } {
  const inner = text.slice(1, -1).trim();
  const out: { [key: string]: YamlValue } = {};
  if (inner === '') return out;
  for (const part of splitFlowItems(inner, line)) {
    const { key, value } = splitKeyValue(part.trim(), line);
    if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, line);
    out[key] = parseInlineValue(value, line);
  }
  return out;
}

function parseInlineValue(value: string, line: number): YamlValue {
  const t = value.trim();
  if (t.startsWith('[') && t.endsWith(']')) return parseFlowSequence(t, line);
  if (t.startsWith('{') && t.endsWith('}')) return parseFlowMapping(t, line);
  return parseScalar(t, line);
}

function splitFlowItems(inner: string, line: number): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (quote) throw new YamlError('unterminated quoted scalar in flow sequence', line);
  items.push(current);
  return items.map((s) => s.trim()).filter((s) => s !== '');
}

interface Parser {
  lines: Line[];
  pos: number;
}

function parseBlock(p: Parser, indent: number): YamlValue {
  const first = p.lines[p.pos];
  if (!first) return null;
  return first.text.startsWith('- ') || first.text === '-'
    ? parseSequence(p, indent)
    : parseMapping(p, indent);
}

function parseSequence(p: Parser, indent: number): YamlValue[] {
  const items: YamlValue[] = [];
  while (p.pos < p.lines.length) {
    const line = p.lines[p.pos] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.no);
    if (!(line.text.startsWith('- ') || line.text === '-')) break;

    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    p.pos++;

    if (rest === '') {
      const next = p.lines[p.pos];
      if (next && next.indent > indent) {
        items.push(parseBlock(p, next.indent));
      } else {
        items.push(null);
      }
      continue;
    }

    // Inline mapping inside a sequence item: `- key: value`
    if (looksLikeMapping(rest)) {
      const itemIndent = indent + INDENT;
      const obj: { [key: string]: YamlValue } = {};
      assignEntry(obj, rest, p, itemIndent);
      while (p.pos < p.lines.length) {
        const nxt = p.lines[p.pos] as Line;
        if (nxt.indent !== itemIndent || nxt.text.startsWith('- ')) break;
        p.pos++;
        assignEntry(obj, nxt.text, p, itemIndent);
      }
      items.push(obj);
      continue;
    }

    items.push(parseScalar(rest, line.no));
  }
  return items;
}

function looksLikeMapping(text: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1] ?? ''))) {
      return true;
    }
  }
  return false;
}

function splitKeyValue(text: string, no: number): { key: string; value: string } {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1] ?? ''))) {
      const rawKey = text.slice(0, i).trim();
      if (rawKey === '') throw new YamlError('empty key', no);
      return { key: rawKey, value: text.slice(i + 1).trim() };
    }
  }
  throw new YamlError(`expected "key: value", got ${JSON.stringify(text)}`, no);
}

function assignEntry(
  obj: { [key: string]: YamlValue },
  text: string,
  p: Parser,
  indent: number,
): void {
  const line = p.lines[p.pos - 1];
  const no = line ? line.no : 0;
  const { key, value } = splitKeyValue(text, no);
  if (Object.hasOwn(obj, key)) throw new YamlError(`duplicate key "${key}"`, no);

  if (value !== '') {
    obj[key] = parseInlineValue(value, no);
    return;
  }

  const next = p.lines[p.pos];
  if (next && next.indent > indent - INDENT) {
    obj[key] = parseBlock(p, next.indent);
  } else {
    obj[key] = null;
  }
}

function parseMapping(p: Parser, indent: number): { [key: string]: YamlValue } {
  const obj: { [key: string]: YamlValue } = {};
  while (p.pos < p.lines.length) {
    const line = p.lines[p.pos] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.no);
    if (line.text.startsWith('- ') || line.text === '-') break;
    p.pos++;
    assignEntry(obj, line.text, p, indent + INDENT);
  }
  return obj;
}

export function parse(source: string): { [key: string]: YamlValue } {
  const clean = source.replace(/^\uFEFF/, '');
  if (/^---\s*$/m.test(clean)) {
    // single-document files are fine; drop the separator
  }
  if (/^\s*(&|\*)\S/m.test(clean)) {
    throw new YamlError('anchors and aliases are not supported', 0);
  }
  if (/:\s*[|>]\s*$/m.test(clean)) {
    throw new YamlError('block scalars (| and >) are not supported', 0);
  }
  const lines = preprocess(clean);
  if (lines.length === 0) return {};
  const p: Parser = { lines, pos: 0 };
  const top = p.lines[0] as Line;
  if (top.indent !== 0) throw new YamlError('document must start at indentation 0', top.no);
  const result = parseBlock(p, 0);
  if (p.pos < p.lines.length) {
    const stray = p.lines[p.pos] as Line;
    throw new YamlError('unexpected content after document', stray.no);
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new YamlError('top level must be a mapping', top.no);
  }
  return result as { [key: string]: YamlValue };
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

const RESERVED_PLAIN = /^(true|false|null|~|-?\d+)$/;

export function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (RESERVED_PLAIN.test(value)) return true;
  if (/^[\s]|[\s]$/.test(value)) return true;
  if (/[:#\[\]{},&*!|>'"%@`]/.test(value)) return true;
  if (/^[-?]/.test(value)) return true;
  return false;
}

export function formatScalar(value: Scalar): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return needsQuoting(value) ? `'${value.replace(/'/g, "''")}'` : value;
}

export function stringify(value: { [key: string]: YamlValue }): string {
  const out: string[] = [];
  writeMapping(value, 0, out);
  return out.join('\n') + '\n';
}

function writeMapping(obj: { [key: string]: YamlValue }, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) {
        out.push(`${pad}${key}: []`);
      } else {
        out.push(`${pad}${key}:`);
        writeSequence(val, indent + INDENT, out);
      }
    } else if (isPlainObject(val)) {
      const keys = Object.keys(val).filter((k) => val[k] !== undefined);
      if (keys.length === 0) {
        out.push(`${pad}${key}: {}`);
      } else {
        out.push(`${pad}${key}:`);
        writeMapping(val, indent + INDENT, out);
      }
    } else {
      out.push(`${pad}${key}: ${formatScalar(val)}`);
    }
  }
}

function writeSequence(items: YamlValue[], indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const item of items) {
    if (Array.isArray(item)) {
      out.push(`${pad}-`);
      writeSequence(item, indent + INDENT, out);
    } else if (isPlainObject(item)) {
      const entries = Object.entries(item).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        out.push(`${pad}- {}`);
        continue;
      }
      const [firstKey, firstVal] = entries[0] as [string, YamlValue];
      const inline = isScalarValue(firstVal);
      if (inline) {
        out.push(`${pad}- ${firstKey}: ${formatScalar(firstVal)}`);
      } else {
        out.push(`${pad}- ${firstKey}:`);
        writeValueBlock(firstVal, indent + 2 * INDENT, out);
      }
      for (const [k, v] of entries.slice(1)) {
        const nestedPad = ' '.repeat(indent + INDENT);
        if (isScalarValue(v)) {
          out.push(`${nestedPad}${k}: ${formatScalar(v)}`);
        } else {
          out.push(`${nestedPad}${k}:`);
          writeValueBlock(v, indent + 2 * INDENT, out);
        }
      }
    } else {
      out.push(`${pad}- ${formatScalar(item)}`);
    }
  }
}

function writeValueBlock(value: YamlValue, indent: number, out: string[]): void {
  if (Array.isArray(value)) {
    writeSequence(value, indent, out);
  } else if (isPlainObject(value)) {
    writeMapping(value, indent, out);
  } else {
    out.push(`${' '.repeat(indent)}${formatScalar(value)}`);
  }
}

function isScalarValue(v: YamlValue | undefined): v is Scalar {
  return v === null || typeof v !== 'object';
}

function isPlainObject(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
