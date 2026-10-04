/**
 * GPU mirror of the CPU scene core: fragment + material data textures and one GPU buffer pair per
 * core page (see the mirroring contract in src/core/Pages.ts), plus the VAOs drawing them.
 *
 *  - Merged page    -> vertex + index MirroredBuffer, one merged GeometryVao.
 *  - Shared page    -> vertex + index MirroredBuffer (geometry stored once for instancing).
 *  - Instance page  -> one 'instance' MirroredBuffer (u32 fragment index per instance).
 *  - Instanced items need a VAO per (shared page, instance page) pair; created lazily on first draw.
 *
 * Every VAO gets a dense "slot" number so a time slice of the draw list can be bucketed by VAO with
 * a counting sort (SliceGrouper).
 *
 * Pages never grow, so a page's GPU buffers are allocated once at full capacity and only dirty
 * byte ranges are uploaded afterwards. The CPU copies are kept (PagePool default), which is what
 * lets MirroredBuffer.restore() re-upload everything after a context loss.
 */
import { FRAG_TEX_WIDTH, MAT_TEX_WIDTH } from '../layout';
import { PAGE_INSTANCE, type Scene } from '../core';
import { DataTexture, GeometryVao, MirroredBuffer, type GlContext } from '../gl';

export interface VaoSlot {
  vao: GeometryVao;
  slot: number;
  merged: boolean;
  /** Pair key (instanced) or page id (merged). */
  key: number;
}

const PAIR_SHIFT = 2 ** 21; // page ids are < 2M in any realistic session

export class GpuScene {
  readonly fragTex: DataTexture;
  readonly matTex: DataTexture;
  /** Slot -> VAO (null = free slot). */
  readonly slots: (VaoSlot | null)[] = [];

  private vbuf: (MirroredBuffer | null)[] = [];
  private ibuf: (MirroredBuffer | null)[] = [];
  private mergedVao: (VaoSlot | null)[] = [];
  private pairVao = new Map<number, VaoSlot>();
  private pairsOfPage: (number[] | null)[] = [];
  private freeSlots: number[] = [];
  private pagesVersion = -1;
  private records: Float32Array | null = null;
  private matData: Float32Array | null = null;
  /** Bytes uploaded by the last sync() (textures + buffers); large uploads distort frame timing. */
  lastUploadBytes = 0;

  private readonly onFragRows = (first: number, count: number): void => {
    this.fragTex.uploadRows(first, first + count);
    this.lastUploadBytes += count * this.fragTex.rowFloats * 4;
  };
  private readonly onMatRows = (first: number, count: number): void => {
    this.matTex.uploadRows(first, first + count);
    this.lastUploadBytes += count * this.matTex.rowFloats * 4;
  };

  constructor(private readonly ctx: GlContext) {
    this.fragTex = new DataTexture(ctx, FRAG_TEX_WIDTH, 'fragment texture');
    this.matTex = new DataTexture(ctx, MAT_TEX_WIDTH, 'material texture');
  }

  /** Number of VAO slots ever used (keys for SliceGrouper are < slotCount). */
  get slotCount(): number {
    return this.slots.length;
  }

  /**
   * Uploads what changed in the scene since the last call: dirty fragment/material rows and page
   * data; deletes GPU buffers of released pages. Call once per frame after scene.flush().
   */
  sync(scene: Scene): void {
    this.lastUploadBytes = 0;
    if (this.ctx.isLost) return;
    const fr = scene.fragments;
    if (fr.records !== this.records) {
      this.records = fr.records;
      if (this.fragTex.setSource(fr.records)) {
        fr.dirty.clear();
        this.lastUploadBytes += this.fragTex.byteSize;
      }
    }
    fr.flushDirty(this.onFragRows);
    const ms = scene.materials;
    if (ms.data !== this.matData) {
      this.matData = ms.data;
      if (this.matTex.setSource(ms.data)) ms.dirty.clear();
    }
    ms.flushDirty(this.onMatRows);
    const pool = scene.pages;
    if (pool.version === this.pagesVersion) return;
    const pages = pool.pages;
    for (let id = 0; id < pages.length; id++) {
      const p = pages[id];
      if (!p) continue;
      if (p.released) {
        this.destroyPage(id);
        pool.acknowledgeRelease(id);
        continue;
      }
      let vb = this.vbuf[id];
      if (!vb) {
        if (!p.vertexBytes) continue; // CPU copy dropped before upload: cannot mirror
        vb = new MirroredBuffer(this.ctx, p.kind === PAGE_INSTANCE ? 'instance' : 'vertex', {
          label: `page ${id} vertices`,
        });
        vb.reserve(p.vertexCapacity * p.vertexStride);
        vb.setSource(p.vertexBytes);
        this.vbuf[id] = vb;
        if (p.indexCapacity > 0 && p.indexBytes) {
          const ib = new MirroredBuffer(this.ctx, 'index', { label: `page ${id} indices` });
          ib.reserve(p.indexCapacity * 4);
          ib.setSource(p.indexBytes);
          this.ibuf[id] = ib;
        }
      }
      if (p.vDirtyEnd > p.vDirtyStart) {
        vb.upload(p.vDirtyStart, p.vDirtyEnd);
        this.lastUploadBytes += p.vDirtyEnd - p.vDirtyStart;
      }
      const ib = this.ibuf[id];
      if (ib && p.iDirtyEnd > p.iDirtyStart) {
        ib.upload(p.iDirtyStart, p.iDirtyEnd);
        this.lastUploadBytes += p.iDirtyEnd - p.iDirtyStart;
      }
      pool.markUploaded(id);
    }
    this.pagesVersion = pool.version;
  }

  /** VAO of a merged page (created on first use), or null when the page has no GPU buffers. */
  mergedSlot(page: number): VaoSlot | null {
    const s = this.mergedVao[page];
    if (s) return s;
    const vb = this.vbuf[page];
    const ib = this.ibuf[page];
    if (!vb || !ib) return null;
    const slot = this.newSlot(GeometryVao.merged(this.ctx, vb, ib), true, page);
    this.mergedVao[page] = slot;
    return slot;
  }

  /** VAO of a (shared page, instance page) pair (created on first use), or null. */
  instancedSlot(sharedPage: number, instancePage: number): VaoSlot | null {
    const key = sharedPage * PAIR_SHIFT + instancePage;
    const s = this.pairVao.get(key);
    if (s) return s;
    const vb = this.vbuf[sharedPage];
    const ib = this.ibuf[sharedPage];
    const inst = this.vbuf[instancePage];
    if (!vb || !ib || !inst) return null;
    const slot = this.newSlot(GeometryVao.instanced(this.ctx, vb, ib, inst), false, key);
    this.pairVao.set(key, slot);
    (this.pairsOfPage[sharedPage] ??= []).push(key);
    (this.pairsOfPage[instancePage] ??= []).push(key);
    return slot;
  }

  /** Releases all page buffers and VAOs (scene clear is handled through page release instead). */
  dispose(): void {
    for (let id = 0; id < this.vbuf.length; id++) this.destroyPage(id);
    this.fragTex.dispose();
    this.matTex.dispose();
  }

  /** Number of live GPU page buffers (diagnostics). */
  get bufferCount(): number {
    let n = 0;
    for (const b of this.vbuf) if (b) n++;
    for (const b of this.ibuf) if (b) n++;
    return n;
  }

  private newSlot(vao: GeometryVao, merged: boolean, key: number): VaoSlot {
    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.slots.length;
    const s: VaoSlot = { vao, slot, merged, key };
    this.slots[slot] = s;
    return s;
  }

  private freeSlot(s: VaoSlot): void {
    s.vao.dispose();
    this.slots[s.slot] = null;
    this.freeSlots.push(s.slot);
  }

  private destroyPage(id: number): void {
    const m = this.mergedVao[id];
    if (m) {
      this.freeSlot(m);
      this.mergedVao[id] = null;
    }
    const pairs = this.pairsOfPage[id];
    if (pairs) {
      for (const key of pairs) {
        const s = this.pairVao.get(key);
        if (s) {
          this.freeSlot(s);
          this.pairVao.delete(key);
        }
      }
      this.pairsOfPage[id] = null;
    }
    const vb = this.vbuf[id];
    if (vb) {
      vb.dispose();
      this.vbuf[id] = null;
    }
    const ib = this.ibuf[id];
    if (ib) {
      ib.dispose();
      this.ibuf[id] = null;
    }
  }
}
