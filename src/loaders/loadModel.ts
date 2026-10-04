/**
 * `loadModel(viewer, input, options)`: picks a plugin, runs it with a tracking LoadContext and returns a
 * LoadTask (Promise<Model> + abort + progress). Abort or failure removes everything the load added.
 */
import type { ViewerApi } from '../types';
import { LoadContextImpl, ModelImpl } from './context';
import { isIdentity, multiply, upConversion } from './mat4d';
import { defaultRegistry } from './registry';
import { abortError, isAbortError } from './scheduler';
import { createSource, type ReleasableSource } from './source';
import type { LoaderInput, LoaderPlugin, LoaderSource, LoadOptions, LoadProgress, LoadTask, Model } from './types';

export class LoaderError extends Error {
  /** Plugin name, when the failure happened inside a plugin. */
  readonly plugin?: string;
  readonly cause?: unknown;
  constructor(message: string, plugin?: string, cause?: unknown) {
    super(message);
    this.name = 'LoaderError';
    this.plugin = plugin;
    this.cause = cause;
  }
}

const HEADER_BYTES = 256;

export function loadModel<O = Record<string, unknown>>(viewer: ViewerApi, input: LoaderInput, options: LoadOptions<O> = {}): LoadTask {
  const controller = new AbortController();
  const ext = options.signal;
  const onExtAbort = () => controller.abort();
  if (ext) {
    if (ext.aborted) controller.abort();
    else ext.addEventListener('abort', onExtAbort, { once: true });
  }
  const signal = controller.signal;

  const listeners = new Set<(p: LoadProgress) => void>();
  if (options.onProgress) listeners.add(options.onProgress);
  let overall = 0;
  let lastStage = '';
  const emit = (p: LoadProgress) => {
    for (const l of listeners) {
      try {
        l(p);
      } catch {
        /* listener errors must not break loading */
      }
    }
  };
  const report = (fraction: number, stage: string, loaded?: number, total?: number) => {
    const f = Math.min(1, Math.max(overall, fraction));
    if (f - overall < 0.001 && stage === lastStage && loaded === undefined && f < 1) return;
    overall = f;
    lastStage = stage;
    emit({ fraction: f, stage, loaded, total });
  };

  // URL inputs spend a significant part of the time downloading
  const isUrl = typeof input === 'string' || input instanceof URL;
  const dlWeight = isUrl ? 0.4 : 0;
  let main: LoaderSource | null = null;

  const source: ReleasableSource = createSource(
    input,
    {
      signal,
      resolve: options.resolve,
      fetchInit: options.fetchInit,
      onDownload: (s, loaded, total) => {
        if (s === main && total) report((loaded / total) * dlWeight, 'download', loaded, total);
        else report(overall, 'download', loaded, total);
      },
    },
    { name: options.name, mimeType: options.mimeType },
  );
  main = source;

  const run = async (): Promise<Model> => {
    await Promise.resolve(); // let the caller attach listeners first
    if (signal.aborted) throw abortError();
    const registry = options.registry ?? defaultRegistry;
    const plugin = await choosePlugin(registry, source, options, signal);
    const t0 = now();

    const up = options.up ?? 'y';
    const from = options.sourceUp ?? plugin.up ?? up;
    const conv = upConversion(from, up);
    let root: Float64Array | null = conv;
    if (options.transform) {
      if (options.transform.length < 16) throw new LoaderError('LoadOptions.transform must have 16 elements');
      const t = Float64Array.from(options.transform);
      if (conv) {
        root = new Float64Array(16);
        multiply(root, 0, t, 0, conv, 0); // user transform applied after the up conversion
      } else root = t;
    }
    if (root && isIdentity(root)) root = null;

    const ctx = new LoadContextImpl<O>({
      viewer,
      signal,
      options: (options.options ?? {}) as Partial<O>,
      rootTransform: root,
      sliceMs: options.sliceMs ?? 8,
      onProgress: (f, stage) => report(dlWeight + (1 - dlWeight) * Math.min(1, Math.max(0, f)), stage ?? 'build'),
      onWarning: (m) => options.onWarning?.(m),
    });
    let extras: void | Partial<{ name: string; info: Record<string, unknown> }>;
    try {
      extras = await plugin.load(source, ctx as LoadContextImpl<any>);
      if (signal.aborted) throw abortError();
    } catch (e) {
      ctx.rollback();
      if (signal.aborted || isAbortError(e)) throw abortError();
      const msg = e instanceof Error ? e.message : String(e);
      throw new LoaderError(`[${plugin.name}] failed to load "${source.name}": ${msg}`, plugin.name, e);
    }
    ctx.finish();
    const model = new ModelImpl(
      ctx as LoadContextImpl<unknown>,
      (extras && extras.name) || source.name,
      plugin.name,
      (extras && extras.info) || {},
      now() - t0,
    );
    report(1, 'done');
    return model;
  };

  const promise = run().finally(() => {
    source.release();
    ext?.removeEventListener('abort', onExtAbort);
  }) as LoadTask;
  Object.defineProperty(promise, 'progress', { get: () => overall });
  (promise as { abort: () => void }).abort = () => controller.abort();
  (promise as { onProgress: LoadTask['onProgress'] }).onProgress = (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  return promise;
}

async function choosePlugin<O>(
  registry: import('./registry').LoaderRegistry,
  source: LoaderSource,
  options: LoadOptions<O>,
  signal: AbortSignal,
): Promise<LoaderPlugin<any>> {
  const forced = options.loader;
  if (forced) {
    if (typeof forced !== 'string') return forced;
    const p = registry.get(forced);
    if (!p) throw new LoaderError(`Loader "${forced}" is not registered. Registered: ${registry.describe()}`);
    return p;
  }
  let p = registry.detect({ fileName: source.name, mimeType: source.mimeType });
  // ambiguous extension or nothing matched: look at the first bytes
  const byExt = registry.findByExtension(source.name);
  if (!p || byExt.length > 1) {
    let header: Uint8Array = new Uint8Array(0);
    try {
      header = await source.readRange(0, HEADER_BYTES);
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (!p) throw new LoaderError(`Cannot read "${source.name}": ${e instanceof Error ? e.message : String(e)}`, undefined, e);
    }
    if (signal.aborted) throw abortError();
    p = registry.detect({ fileName: source.name, mimeType: source.mimeType, header }) ?? p;
  }
  if (!p) {
    throw new LoaderError(`No loader plugin recognizes "${source.name}". Registered: ${registry.describe()}`);
  }
  return p;
}

const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
