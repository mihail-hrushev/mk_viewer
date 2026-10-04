/**
 * LoaderSource implementations for URL, Blob/File and in-memory buffers, plus data: URIs and
 * deferred (user-resolved) siblings.
 */
import type { LoaderInput, LoaderSource, ResourceResolver } from './types';
import { abortError } from './scheduler';

export interface SourceEnv {
  signal: AbortSignal;
  resolve?: ResourceResolver;
  fetchInit?: RequestInit;
  /** Download progress of any source (main file and siblings). */
  onDownload?: (source: LoaderSource, loaded: number, total: number | undefined) => void;
}

/** Internal extension: lets loadModel drop cached buffers when a load ends. */
export interface ReleasableSource extends LoaderSource {
  release(): void;
}

const utf8 = new TextDecoder();

function fileNameOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const seg = clean.slice(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function joinUrl(base: string, rel: string): string {
  try {
    return new URL(rel, base).href;
  } catch {
    const b = base.split(/[?#]/)[0];
    return b.slice(0, b.lastIndexOf('/') + 1) + rel;
  }
}

function decodeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/** Decodes a `data:` URI (base64 or percent-encoded). */
export function decodeDataUri(uri: string): { bytes: Uint8Array; mimeType: string } {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) throw new Error('Malformed data URI');
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  const mimeType = meta.split(';')[0] || 'text/plain';
  if (/;base64$/i.test(meta)) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { bytes: out, mimeType };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mimeType };
}

abstract class BaseSource implements ReleasableSource {
  abstract readonly name: string;
  url?: string;
  size?: number;
  mimeType?: string;

  constructor(protected readonly env: SourceEnv) {}

  abstract bytes(): Promise<Uint8Array>;

  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = await this.bytes();
    if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
    return b.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return utf8.decode(await this.bytes());
  }

  stream(): ReadableStream<Uint8Array> {
    let done = false;
    return new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        if (done) return;
        done = true;
        ctrl.enqueue(await this.bytes());
        ctrl.close();
      },
    });
  }

  async readRange(start: number, end: number): Promise<Uint8Array> {
    const b = await this.bytes();
    return b.subarray(Math.max(0, start), Math.min(b.length, end));
  }

  resolve(uri: string): LoaderSource {
    if (uri.startsWith('data:')) {
      const d = decodeDataUri(uri);
      return new MemorySource(d.bytes, this.env, 'data-uri', d.mimeType);
    }
    const custom = this.env.resolve;
    const fallback = this.url ? () => new UrlSource(joinUrl(this.url!, uri), this.env) : null;
    if (custom) return new DeferredSource(decodeUri(uri), this.env, async () => {
      const r = await custom(decodeUri(uri), this);
      if (r !== undefined) return createSource(r, this.env, { name: fileNameOf(uri) });
      if (fallback) return fallback();
      throw new Error(`Cannot resolve "${uri}" referenced by "${this.name}": the resolver returned nothing`);
    });
    if (fallback) return fallback();
    return new DeferredSource(decodeUri(uri), this.env, async () => {
      throw new Error(
        `Cannot resolve "${uri}" referenced by "${this.name}": the input is not a URL; pass LoadOptions.resolve to supply sibling files`,
      );
    });
  }

  release(): void {}

  protected checkAbort(): void {
    if (this.env.signal.aborted) throw abortError();
  }
}

export class MemorySource extends BaseSource {
  private data: Uint8Array | null;
  constructor(data: Uint8Array, env: SourceEnv, readonly name: string, mimeType?: string) {
    super(env);
    this.data = data;
    this.size = data.byteLength;
    this.mimeType = mimeType;
  }
  async bytes(): Promise<Uint8Array> {
    this.checkAbort();
    if (!this.data) throw new Error(`Source "${this.name}" was released`);
    return this.data;
  }
  override async readRange(start: number, end: number): Promise<Uint8Array> {
    return (await this.bytes()).subarray(Math.max(0, start), Math.min(this.size!, end));
  }
  override release(): void {
    this.data = null;
  }
}

export class BlobSource extends BaseSource {
  readonly name: string;
  private blob: Blob | null;
  constructor(blob: Blob, env: SourceEnv, name?: string) {
    super(env);
    this.blob = blob;
    this.name = name ?? (blob as Partial<File>).name ?? 'model';
    this.size = blob.size;
    this.mimeType = blob.type || undefined;
  }
  private get b(): Blob {
    if (!this.blob) throw new Error(`Source "${this.name}" was released`);
    return this.blob;
  }
  async bytes(): Promise<Uint8Array> {
    this.checkAbort();
    const out = new Uint8Array(await this.b.arrayBuffer());
    this.checkAbort();
    this.env.onDownload?.(this, out.byteLength, out.byteLength);
    return out; // not cached: the caller owns it and can drop it
  }
  override async readRange(start: number, end: number): Promise<Uint8Array> {
    this.checkAbort();
    return new Uint8Array(await this.b.slice(start, end).arrayBuffer());
  }
  override stream(): ReadableStream<Uint8Array> {
    return this.b.stream() as ReadableStream<Uint8Array>;
  }
  override release(): void {
    this.blob = null;
  }
}

export class UrlSource extends BaseSource {
  readonly name: string;
  private full: Promise<Uint8Array> | null = null;
  constructor(url: string, env: SourceEnv) {
    super(env);
    this.url = url;
    this.name = fileNameOf(url);
  }

  private async fetch(headers?: Record<string, string>): Promise<Response> {
    this.checkAbort();
    const init = this.env.fetchInit ?? {};
    const h = new Headers(init.headers);
    if (headers) for (const k in headers) h.set(k, headers[k]);
    const res = await fetch(this.url!, { ...init, headers: h, signal: this.env.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} while fetching ${this.url}`);
    const ct = res.headers.get('content-type');
    if (ct && !this.mimeType) this.mimeType = ct.split(';')[0].trim();
    return res;
  }

  private async readAll(res: Response): Promise<Uint8Array> {
    const len = Number(res.headers.get('content-length'));
    const total = len > 0 && !res.headers.get('content-encoding') ? len : undefined;
    if (total !== undefined) this.size = total;
    if (!res.body) {
      const b = new Uint8Array(await res.arrayBuffer());
      this.env.onDownload?.(this, b.byteLength, b.byteLength);
      return b;
    }
    const reader = res.body.getReader();
    // preallocate when the size is known: avoids holding chunks + the concatenated copy
    let out: Uint8Array | null = total !== undefined ? new Uint8Array(total) : null;
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out && loaded + value.byteLength <= out.byteLength) out.set(value, loaded);
      else {
        if (out) { chunks.push(out.subarray(0, loaded)); out = null; }
        chunks.push(value);
      }
      loaded += value.byteLength;
      this.env.onDownload?.(this, loaded, total);
    }
    if (out) return loaded === out.byteLength ? out : out.subarray(0, loaded);
    const all = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    this.size = loaded;
    return all;
  }

  bytes(): Promise<Uint8Array> {
    if (!this.full) {
      this.full = this.fetch().then((r) => this.readAll(r));
      this.full.catch(() => { this.full = null; });
    }
    return this.full;
  }

  override async readRange(start: number, end: number): Promise<Uint8Array> {
    if (this.full) return (await this.full).subarray(start, end);
    const res = await this.fetch({ Range: `bytes=${start}-${end - 1}` });
    if (res.status === 206) return new Uint8Array(await res.arrayBuffer()).subarray(0, end - start);
    // server ignored the range: keep what we download
    this.full = this.readAll(res);
    return (await this.full).subarray(start, end);
  }

  override stream(): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let loaded = 0;
    let total: number | undefined;
    return new ReadableStream<Uint8Array>({
      start: async () => {
        const res = await this.fetch();
        const len = Number(res.headers.get('content-length'));
        total = len > 0 ? len : undefined;
        if (!res.body) throw new Error(`No body for ${this.url}`);
        reader = res.body.getReader();
      },
      pull: async (ctrl) => {
        const { done, value } = await reader!.read();
        if (done) { ctrl.close(); return; }
        loaded += value.byteLength;
        this.env.onDownload?.(this, loaded, total);
        ctrl.enqueue(value);
      },
      cancel: () => reader?.cancel(),
    });
  }

  override release(): void {
    this.full = null;
  }
}

/** A sibling whose actual source is produced asynchronously (user resolver). */
class DeferredSource extends BaseSource {
  private target: Promise<LoaderSource> | null = null;
  constructor(readonly name: string, env: SourceEnv, private readonly open: () => Promise<LoaderSource>) {
    super(env);
  }
  private get t(): Promise<LoaderSource> {
    return (this.target ??= this.open());
  }
  async bytes(): Promise<Uint8Array> {
    return (await this.t).bytes();
  }
  override async readRange(start: number, end: number): Promise<Uint8Array> {
    return (await this.t).readRange(start, end);
  }
  override resolve(uri: string): LoaderSource {
    return new DeferredSource(decodeUri(uri), this.env, async () => (await this.t).resolve(uri));
  }
}

export function createSource(input: LoaderInput, env: SourceEnv, opts: { name?: string; mimeType?: string } = {}): ReleasableSource {
  let s: ReleasableSource;
  if (typeof input === 'string' || input instanceof URL) {
    const href = typeof input === 'string' ? input : input.href;
    if (href.startsWith('data:')) {
      const d = decodeDataUri(href);
      s = new MemorySource(d.bytes, env, opts.name ?? 'data-uri', d.mimeType);
    } else {
      const base = typeof location !== 'undefined' ? location.href : undefined;
      s = new UrlSource(base ? joinUrl(base, href) : href, env);
    }
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    s = new BlobSource(input, env, opts.name);
  } else if (input instanceof Uint8Array) {
    s = new MemorySource(input, env, opts.name ?? 'model');
  } else if (input instanceof ArrayBuffer) {
    s = new MemorySource(new Uint8Array(input), env, opts.name ?? 'model');
  } else {
    throw new TypeError('loadModel: unsupported input (expected URL string, URL, File/Blob, ArrayBuffer or Uint8Array)');
  }
  if (opts.name) (s as { name: string }).name = opts.name;
  if (opts.mimeType) (s as { mimeType?: string }).mimeType = opts.mimeType;
  return s;
}
