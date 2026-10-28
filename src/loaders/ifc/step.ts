/**
 * STEP physical file (ISO 10303-21) reader for IFC. One pass over the bytes records, per entity
 * instance, its id, type and the byte offset of its argument list, in typed arrays. Arguments are
 * parsed on demand from the bytes, so a 500 MB file costs its bytes plus ~10 bytes per instance.
 */

/** Reference to another instance (`#123`). */
export class Ref {
  constructor(readonly id: number) {}
}
/** Enumeration value (`.ELEMENT.`, `.T.`). */
export class Enum {
  constructor(readonly value: string) {}
}
/** Typed parameter (`IFCLABEL('x')`); `type` is upper case as in the file. */
export class Typed {
  constructor(readonly type: string, readonly value: Arg) {}
}
export type Arg = number | string | Ref | Enum | Typed | null | Arg[];

const HASH = 35, EQ = 61, LPAR = 40, RPAR = 41, COMMA = 44, SEMI = 59, QUOTE = 39, DQUOTE = 34;
const SLASH = 47, STAR = 42, DOLLAR = 36, DOT = 46, BSLASH = 92;

const isDigit = (c: number) => c >= 48 && c <= 57;
const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
const isNameChar = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95;

/** Growable typed arrays used while scanning. */
interface Grow<T> {
  a: T;
}
function growI32(g: Grow<Int32Array>, need: number): Int32Array {
  if (need <= g.a.length) return g.a;
  const b = new Int32Array(Math.max(need, g.a.length * 2));
  b.set(g.a);
  return (g.a = b);
}
function growU32(g: Grow<Uint32Array>, need: number): Uint32Array {
  if (need <= g.a.length) return g.a;
  const b = new Uint32Array(Math.max(need, g.a.length * 2));
  b.set(g.a);
  return (g.a = b);
}
export function growF64(g: Grow<Float64Array>, need: number): Float64Array {
  if (need <= g.a.length) return g.a;
  const b = new Float64Array(Math.max(need, g.a.length * 2));
  b.set(g.a);
  return (g.a = b);
}

export class StepFile {
  readonly bytes: Uint8Array;
  /** Schema identifier from the header (`IFC2X3`, `IFC4`, `IFC4X3_ADD2`…), upper case. */
  schema = '';
  /** FILE_NAME originating system / preprocessor, when present. */
  application = '';
  /** Type names, upper case; index 0 is '' (complex instances and missing ids). */
  readonly types: string[] = [''];
  private typeHash = new Map<number, number[]>();

  // scan state
  private pos = 0;
  private end = 0;
  private done = false;
  private ids: Grow<Int32Array> = { a: new Int32Array(1 << 12) };
  private offs: Grow<Uint32Array> = { a: new Uint32Array(1 << 12) };
  private tcodes: Grow<Int32Array> = { a: new Int32Array(1 << 12) };
  private n = 0;

  // lookup, built by finish()
  private dense: { off: Uint32Array; type: Uint16Array | Int32Array } | null = null;
  private sparse: Map<number, number> | null = null;
  private byTypeStart: Int32Array | null = null;
  private byTypeIds: Int32Array | null = null;
  /** Ids whose first argument is a 22 character GlobalId (IfcRoot subtypes), in file order. */
  rooted: Int32Array = new Int32Array(0);
  private rootedList: Grow<Int32Array> = { a: new Int32Array(1 << 10) };
  private nRooted = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.end = bytes.length;
    this.readHeader();
  }

  /** Number of entity instances indexed so far. */
  get count(): number {
    return this.n;
  }
  /** 0..1 progress of the scan. */
  get scanned(): number {
    return this.end ? this.pos / this.end : 1;
  }

  private readHeader(): void {
    const b = this.bytes;
    // the header is short; find "DATA;" outside of strings
    let i = 0;
    let inStr = false;
    const lim = Math.min(b.length, 1 << 20);
    let dataAt = -1;
    for (; i < lim; i++) {
      const c = b[i];
      if (c === QUOTE) inStr = !inStr;
      else if (!inStr && c === 68 && b[i + 1] === 65 && b[i + 2] === 84 && b[i + 3] === 65) {
        let j = i + 4;
        while (j < b.length && isWs(b[j])) j++;
        if (b[j] === SEMI && (i === 0 || !isNameChar(b[i - 1]))) {
          dataAt = j + 1;
          break;
        }
      }
    }
    const header = latin1(b, 0, dataAt < 0 ? lim : dataAt);
    const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(header);
    if (schema) this.schema = schema[1].trim().toUpperCase();
    const fn = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/i.exec(header);
    if (fn) {
      // name, time_stamp, (author), (organization), preprocessor_version, originating_system, authorization
      const strs = fn[1].match(/'(?:[^']|'')*'/g) ?? [];
      const sys = strs.length >= 2 ? strs[strs.length - 2] : '';
      this.application = decodeStepString(sys.slice(1, -1));
    }
    this.pos = dataAt < 0 ? 0 : dataAt;
  }

  /**
   * Indexes up to `maxRecords` more instances; returns true when the whole file is indexed (and the
   * lookup tables are built).
   */
  scan(maxRecords = 1 << 16): boolean {
    if (this.done) return true;
    const b = this.bytes;
    const end = this.end;
    let p = this.pos;
    let left = maxRecords;
    while (p < end && left > 0) {
      const c = b[p];
      if (c === HASH) {
        // #id = TYPE( ... );
        let id = 0;
        p++;
        while (p < end && isDigit(b[p])) id = id * 10 + (b[p++] - 48);
        while (p < end && isWs(b[p])) p++;
        if (b[p] !== EQ) continue; // a stray reference: not a record start
        p++;
        while (p < end && isWs(b[p])) p++;
        let code = 0;
        if (b[p] !== LPAR) {
          const s = p;
          while (p < end && isNameChar(b[p])) p++;
          code = this.intern(s, p);
          while (p < end && isWs(b[p])) p++;
        }
        const argStart = p;
        // rooted: first argument is a quoted 22 character GlobalId
        let q = p + 1;
        while (q < end && isWs(b[q])) q++;
        const rooted = code !== 0 && b[q] === QUOTE && b[q + 23] === QUOTE;
        // skip to the record end (';' outside of strings and comments)
        while (p < end) {
          const d = b[p];
          if (d === QUOTE) {
            p++;
            while (p < end) {
              if (b[p] === QUOTE) {
                if (b[p + 1] === QUOTE) p += 2;
                else break;
              } else p++;
            }
            p++;
          } else if (d === DQUOTE) {
            p++;
            while (p < end && b[p] !== DQUOTE) p++;
            p++;
          } else if (d === SLASH && b[p + 1] === STAR) {
            p = skipComment(b, p);
          } else if (d === SEMI) {
            p++;
            break;
          } else p++;
        }
        const k = this.n++;
        growI32(this.ids, this.n)[k] = id;
        growU32(this.offs, this.n)[k] = argStart;
        growI32(this.tcodes, this.n)[k] = code;
        if (rooted) growI32(this.rootedList, this.nRooted + 1)[this.nRooted++] = id;
        left--;
      } else if (c === SLASH && b[p + 1] === STAR) {
        p = skipComment(b, p);
      } else if (c === 69 && b[p + 1] === 78 && b[p + 2] === 68 && b[p + 3] === 83 && b[p + 4] === 69 && b[p + 5] === 67) {
        // ENDSEC: end of the DATA section
        p = end;
      } else p++;
    }
    this.pos = p;
    if (p >= end) {
      this.finish();
      return true;
    }
    return false;
  }

  private intern(s: number, e: number): number {
    const b = this.bytes;
    let h = e - s;
    for (let i = s; i < e; i++) {
      let c = b[i];
      if (c >= 97) c -= 32; // upper case
      h = (Math.imul(h, 31) + c) | 0;
    }
    let bucket = this.typeHash.get(h);
    if (bucket) {
      outer: for (const code of bucket) {
        const name = this.types[code];
        if (name.length !== e - s) continue;
        for (let i = 0; i < name.length; i++) {
          let c = b[s + i];
          if (c >= 97) c -= 32;
          if (name.charCodeAt(i) !== c) continue outer;
        }
        return code;
      }
    } else this.typeHash.set(h, (bucket = []));
    const code = this.types.length;
    this.types.push(latin1(b, s, e).toUpperCase());
    bucket.push(code);
    return code;
  }

  private finish(): void {
    this.done = true;
    const n = this.n;
    const ids = this.ids.a, offs = this.offs.a, codes = this.tcodes.a;
    let maxId = 0;
    for (let i = 0; i < n; i++) if (ids[i] > maxId) maxId = ids[i];
    if (maxId <= Math.max(4 * n, 1 << 20)) {
      const off = new Uint32Array(maxId + 1);
      const type = this.types.length < 65536 ? new Uint16Array(maxId + 1) : new Int32Array(maxId + 1);
      for (let i = 0; i < n; i++) {
        off[ids[i]] = offs[i];
        type[ids[i]] = codes[i];
      }
      this.dense = { off, type };
    } else {
      this.sparse = new Map();
      for (let i = 0; i < n; i++) this.sparse.set(ids[i], i);
    }
    // ids per type (CSR, file order)
    const T = this.types.length;
    const start = new Int32Array(T + 1);
    for (let i = 0; i < n; i++) start[codes[i] + 1]++;
    for (let t = 0; t < T; t++) start[t + 1] += start[t];
    const fill = start.slice(0, T);
    const list = new Int32Array(n);
    for (let i = 0; i < n; i++) list[fill[codes[i]]++] = ids[i];
    this.byTypeStart = start;
    this.byTypeIds = list;
    this.rooted = this.rootedList.a.slice(0, this.nRooted);
    if (!this.sparse) {
      // the scan arrays are no longer needed
      this.ids.a = new Int32Array(0);
      this.offs.a = new Uint32Array(0);
      this.tcodes.a = new Int32Array(0);
    }
  }

  private offsetOf(id: number): number {
    if (this.dense) return id < this.dense.off.length ? this.dense.off[id] : 0;
    const k = this.sparse!.get(id);
    return k === undefined ? 0 : this.offs.a[k];
  }

  /** Type code of an instance (0 when missing or complex). */
  typeCode(id: number): number {
    if (this.dense) return id < this.dense.type.length ? this.dense.type[id] : 0;
    const k = this.sparse!.get(id);
    return k === undefined ? 0 : this.tcodes.a[k];
  }

  /** Upper case type name of an instance ('' when missing or complex). */
  type(id: number): string {
    return this.types[this.typeCode(id)];
  }

  /** Type code of a name, or -1 when no instance of that type exists. */
  codeOf(name: string): number {
    return this.types.indexOf(name);
  }

  /** Ids of all instances of a type (upper case name), in file order. */
  idsOf(name: string): Int32Array {
    const t = this.codeOf(name);
    if (t < 0 || !this.byTypeIds) return new Int32Array(0);
    return this.byTypeIds.subarray(this.byTypeStart![t], this.byTypeStart![t + 1]);
  }

  /** All arguments of an instance (empty for missing ids). */
  args(id: number): Arg[] {
    const o = this.offsetOf(id);
    if (!o || this.bytes[o] !== LPAR) return [];
    this.p = o;
    return this.parseList();
  }

  /** Position of the start of argument `index` (top level) of an instance, or -1. */
  private argPos(id: number, index: number): number {
    const b = this.bytes;
    let p = this.offsetOf(id);
    if (!p || b[p] !== LPAR) return -1;
    p++;
    let depth = 0;
    let k = 0;
    while (k < index) {
      const c = b[p];
      if (c === undefined) return -1;
      if (c === QUOTE) {
        p++;
        while (p < b.length && !(b[p] === QUOTE && b[p + 1] !== QUOTE)) p += b[p] === QUOTE ? 2 : 1;
        p++;
        continue;
      }
      if (c === LPAR) depth++;
      else if (c === RPAR) {
        if (depth === 0) return -1;
        depth--;
      } else if (c === COMMA && depth === 0) k++;
      p++;
    }
    while (isWs(b[p])) p++;
    return p;
  }

  /**
   * Appends every number inside argument `index` of an instance (nested lists flattened, references
   * and strings skipped) to `out` from `at`; returns the new count. The fast path for coordinate
   * and index lists.
   */
  numbers(id: number, index: number, out: Grow<Float64Array>, at = 0): number {
    const b = this.bytes;
    let p = this.argPos(id, index);
    if (p < 0) return at;
    let depth = 0;
    let n = at;
    for (;;) {
      const c = b[p];
      if (c === undefined) break;
      if (c === LPAR) {
        depth++;
        p++;
      } else if (c === RPAR) {
        if (depth === 0) break;
        if (--depth === 0) break;
        p++;
      } else if (c === COMMA) {
        if (depth === 0) break;
        p++;
      } else if (c === HASH) {
        p++;
        while (isDigit(b[p])) p++;
      } else if (c === QUOTE) {
        p++;
        while (p < b.length && !(b[p] === QUOTE && b[p + 1] !== QUOTE)) p += b[p] === QUOTE ? 2 : 1;
        p++;
      } else if (isDigit(c) || c === 45 || c === 43) {
        const s = p;
        p++;
        while (isDigit(b[p]) || b[p] === DOT || b[p] === 69 || b[p] === 101 || ((b[p] === 45 || b[p] === 43) && (b[p - 1] === 69 || b[p - 1] === 101))) p++;
        growF64(out, n + 1)[n++] = parseNumber(b, s, p);
      } else p++;
    }
    return n;
  }

  /** Appends the ids of all references inside argument `index` to `out` from `at`; returns the count. */
  refs(id: number, index: number, out: Grow<Int32Array>, at = 0): number {
    const b = this.bytes;
    let p = this.argPos(id, index);
    if (p < 0) return at;
    let depth = 0;
    let n = at;
    for (;;) {
      const c = b[p];
      if (c === undefined) break;
      if (c === LPAR) depth++;
      else if (c === RPAR) {
        if (depth === 0 || --depth === 0) break;
      } else if (c === COMMA && depth === 0) break;
      else if (c === HASH) {
        let v = 0;
        p++;
        while (isDigit(b[p])) v = v * 10 + (b[p++] - 48);
        growI32(out, n + 1)[n++] = v;
        continue;
      } else if (c === QUOTE) {
        p++;
        while (p < b.length && !(b[p] === QUOTE && b[p + 1] !== QUOTE)) p += b[p] === QUOTE ? 2 : 1;
      }
      p++;
    }
    return n;
  }

  // --- generic argument parser ---------------------------------------------------------------
  private p = 0;

  private ws(): void {
    const b = this.bytes;
    for (;;) {
      while (isWs(b[this.p])) this.p++;
      if (b[this.p] === SLASH && b[this.p + 1] === STAR) this.p = skipComment(b, this.p);
      else return;
    }
  }

  private parseList(): Arg[] {
    const b = this.bytes;
    const out: Arg[] = [];
    this.p++; // (
    this.ws();
    if (b[this.p] === RPAR) {
      this.p++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.parseValue());
      this.ws();
      const c = b[this.p];
      if (c === COMMA) this.p++;
      else {
        if (c === RPAR) this.p++;
        return out;
      }
    }
  }

  private parseValue(): Arg {
    const b = this.bytes;
    const c = b[this.p];
    if (c === HASH) {
      let v = 0;
      this.p++;
      while (isDigit(b[this.p])) v = v * 10 + (b[this.p++] - 48);
      return new Ref(v);
    }
    if (c === QUOTE) {
      const s = ++this.p;
      let simple = true;
      while (this.p < b.length) {
        const d = b[this.p];
        if (d === QUOTE) {
          if (b[this.p + 1] === QUOTE) {
            simple = false;
            this.p += 2;
          } else break;
        } else {
          if (d === BSLASH || d >= 128) simple = false;
          this.p++;
        }
      }
      const e = this.p++;
      return simple ? latin1(b, s, e) : decodeStepBytes(b, s, e);
    }
    if (c === DOLLAR || c === STAR) {
      this.p++;
      return null;
    }
    if (c === LPAR) return this.parseList();
    if (c === DOT) {
      const s = ++this.p;
      while (this.p < b.length && b[this.p] !== DOT) this.p++;
      return new Enum(latin1(b, s, this.p++).toUpperCase());
    }
    if (c === DQUOTE) {
      const s = ++this.p;
      while (this.p < b.length && b[this.p] !== DQUOTE) this.p++;
      return latin1(b, s, this.p++);
    }
    if (isDigit(c) || c === 45 || c === 43) {
      const s = this.p++;
      while (isDigit(b[this.p]) || b[this.p] === DOT || b[this.p] === 69 || b[this.p] === 101 || ((b[this.p] === 45 || b[this.p] === 43) && (b[this.p - 1] === 69 || b[this.p - 1] === 101))) this.p++;
      return parseNumber(b, s, this.p);
    }
    if (isNameChar(c)) {
      const s = this.p;
      while (isNameChar(b[this.p])) this.p++;
      const type = latin1(b, s, this.p).toUpperCase();
      this.ws();
      if (b[this.p] !== LPAR) return type;
      const inner = this.parseList();
      return new Typed(type, inner.length === 1 ? inner[0] : inner);
    }
    // unknown token: skip one byte so the caller makes progress
    this.p++;
    return null;
  }
}

function skipComment(b: Uint8Array, p: number): number {
  p += 2;
  while (p < b.length && !(b[p] === STAR && b[p + 1] === SLASH)) p++;
  return p + 2;
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i += 4096) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 4096)) as unknown as number[]);
  return out;
}

function parseNumber(b: Uint8Array, s: number, e: number): number {
  // fast path for short plain integers, otherwise the exact JS parser
  if (e - s < 10) {
    let i = s;
    let neg = false;
    if (b[i] === 45) {
      neg = true;
      i++;
    } else if (b[i] === 43) i++;
    let v = 0;
    for (; i < e; i++) {
      const c = b[i];
      if (!isDigit(c)) break;
      v = v * 10 + (c - 48);
    }
    if (i === e) return neg ? -v : v;
  }
  const v = +latin1(b, s, e);
  // STEP allows a trailing '.' with no digits ("1.", "-0.") which JS parses fine; "1.E-5" too
  return Number.isNaN(v) ? parseFloat(latin1(b, s, e)) || 0 : v;
}

const utf8 = new TextDecoder('utf-8');

/** Decodes the bytes of a STEP string body (between the quotes). */
function decodeStepBytes(b: Uint8Array, s: number, e: number): string {
  // non-conforming exporters write raw UTF-8; conforming ones use \X\, \X2\ and \S\ escapes
  let ascii = true;
  for (let i = s; i < e; i++) if (b[i] >= 128) {
    ascii = false;
    break;
  }
  return decodeStepString(ascii ? latin1(b, s, e) : utf8.decode(b.subarray(s, e)));
}

/** Decodes STEP string escapes ('' and the \X\, \X2\, \X4\, \S\ and \P\ directives). */
export function decodeStepString(s: string): string {
  if (s.indexOf('\\') < 0) return s.indexOf("''") < 0 ? s : s.replace(/''/g, "'");
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" && s[i + 1] === "'") {
      out += "'";
      i += 2;
    } else if (c === '\\') {
      if (s.startsWith('\\X2\\', i)) {
        const e = s.indexOf('\\X0\\', i + 4);
        const hex = s.slice(i + 4, e < 0 ? s.length : e);
        for (let k = 0; k + 4 <= hex.length; k += 4) out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
        i = e < 0 ? s.length : e + 4;
      } else if (s.startsWith('\\X4\\', i)) {
        const e = s.indexOf('\\X0\\', i + 4);
        const hex = s.slice(i + 4, e < 0 ? s.length : e);
        for (let k = 0; k + 8 <= hex.length; k += 8) out += String.fromCodePoint(parseInt(hex.slice(k, k + 8), 16));
        i = e < 0 ? s.length : e + 4;
      } else if (s.startsWith('\\X\\', i)) {
        out += String.fromCharCode(parseInt(s.slice(i + 3, i + 5), 16));
        i += 5;
      } else if (s.startsWith('\\S\\', i)) {
        out += String.fromCharCode(s.charCodeAt(i + 3) + 128);
        i += 4;
      } else if (s[i + 1] === 'P' && s[i + 3] === '\\') {
        i += 4; // code page switch: ignored
      } else if (s[i + 1] === '\\') {
        out += '\\';
        i += 2;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// --- small accessors over parsed arguments -----------------------------------------------------

export const refId = (a: Arg | undefined): number => (a instanceof Ref ? a.id : 0);
export const num = (a: Arg | undefined, d = 0): number => (typeof a === 'number' ? a : a instanceof Typed && typeof a.value === 'number' ? a.value : d);
export const str = (a: Arg | undefined): string => (typeof a === 'string' ? a : a instanceof Typed && typeof a.value === 'string' ? a.value : '');
export const enumOf = (a: Arg | undefined): string => (a instanceof Enum ? a.value : '');
export const list = (a: Arg | undefined): Arg[] => (Array.isArray(a) ? a : []);
export const refList = (a: Arg | undefined): number[] => list(a).map(refId).filter((x) => x > 0);

/** Plain JS value of a property value (typed values unwrapped, booleans and enums decoded). */
export function plainValue(a: Arg | undefined): unknown {
  if (a === null || a === undefined) return undefined;
  if (a instanceof Typed) return plainValue(a.value);
  if (a instanceof Enum) {
    if (a.value === 'T') return true;
    if (a.value === 'F') return false;
    if (a.value === 'U') return 'UNKNOWN';
    return a.value;
  }
  if (a instanceof Ref) return undefined;
  if (Array.isArray(a)) {
    const v = a.map(plainValue).filter((x) => x !== undefined);
    return v.length === 1 ? v[0] : v;
  }
  return a;
}
