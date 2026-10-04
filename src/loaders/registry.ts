/**
 * Plugin registry and format detection: explicit choice > file extension > mime type > `canLoad`
 * sniffing of the first bytes. Later registrations win ties, so an application can override a
 * built-in plugin by registering its own for the same extension.
 */
import type { LoaderPlugin, LoaderProbe } from './types';

export class LoaderRegistry {
  private plugins: LoaderPlugin<any>[] = [];

  /**
   * Adds a plugin. A plugin with the same name is replaced. Returns a function that unregisters it.
   */
  register(plugin: LoaderPlugin<any>): () => void {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name || typeof plugin.load !== 'function') {
      throw new TypeError('LoaderRegistry.register: a plugin needs a name and a load() function');
    }
    if (!Array.isArray(plugin.extensions)) throw new TypeError(`Loader plugin "${plugin.name}": extensions must be an array`);
    this.plugins = this.plugins.filter((p) => p.name !== plugin.name);
    this.plugins.push(plugin);
    return () => this.unregister(plugin);
  }

  /** Removes a plugin by instance or name. Returns whether it was registered. */
  unregister(plugin: LoaderPlugin<any> | string): boolean {
    const n = this.plugins.length;
    this.plugins = this.plugins.filter((p) => (typeof plugin === 'string' ? p.name !== plugin : p !== plugin));
    return this.plugins.length !== n;
  }

  /** Registered plugins, in registration order. */
  list(): readonly LoaderPlugin<any>[] {
    return this.plugins.slice();
  }

  get(name: string): LoaderPlugin<any> | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  /** Plugins claiming the file name's extension, best (longest extension, latest) first. */
  findByExtension(fileName: string): LoaderPlugin<any>[] {
    const lower = fileName.toLowerCase().split(/[?#]/)[0];
    const hits: { p: LoaderPlugin<any>; len: number; order: number }[] = [];
    this.plugins.forEach((p, order) => {
      let best = 0;
      for (const e of p.extensions) {
        const ext = e.toLowerCase().replace(/^\./, '');
        if (lower.endsWith('.' + ext) && ext.length > best) best = ext.length;
      }
      if (best > 0) hits.push({ p, len: best, order });
    });
    hits.sort((a, b) => b.len - a.len || b.order - a.order);
    return hits.map((h) => h.p);
  }

  findByMimeType(mimeType: string): LoaderPlugin<any>[] {
    const m = mimeType.toLowerCase().split(';')[0].trim();
    return this.plugins.filter((p) => p.mimeTypes?.some((t) => t.toLowerCase() === m)).reverse();
  }

  /**
   * Picks a plugin for the probe. When several claim the extension (or mime type) and a header is
   * available, the first whose `canLoad` accepts it wins (plugins without `canLoad` accept anything).
   */
  detect(probe: Partial<LoaderProbe>): LoaderPlugin<any> | undefined {
    const header = probe.header;
    const pick = (cands: LoaderPlugin<any>[]): LoaderPlugin<any> | undefined => {
      if (cands.length <= 1 || !header || header.length === 0) return cands[0];
      for (const p of cands) if (!p.canLoad || safeCanLoad(p, probe as LoaderProbe)) return p;
      return cands[0];
    };
    if (probe.fileName) {
      const p = pick(this.findByExtension(probe.fileName));
      if (p) return p;
    }
    if (probe.mimeType) {
      const p = pick(this.findByMimeType(probe.mimeType));
      if (p) return p;
    }
    if (header && header.length > 0) {
      for (let i = this.plugins.length - 1; i >= 0; i--) {
        const p = this.plugins[i];
        if (p.canLoad && safeCanLoad(p, { fileName: probe.fileName, mimeType: probe.mimeType, header })) return p;
      }
    }
    return undefined;
  }

  /** "gltf (.glb, .gltf), obj (.obj)" — for error messages. */
  describe(): string {
    if (this.plugins.length === 0) return 'none (call registerDefaultLoaders() or registry.register(plugin))';
    return this.plugins.map((p) => `${p.name} (${p.extensions.map((e) => '.' + e).join(', ')})`).join(', ');
  }
}

function safeCanLoad(p: LoaderPlugin<any>, probe: LoaderProbe): boolean {
  try {
    return !!p.canLoad!(probe);
  } catch {
    return false;
  }
}

/** The registry `loadModel` uses when `LoadOptions.registry` is not given. Starts empty. */
export const defaultRegistry = new LoaderRegistry();
