/**
 * Screenshots on the headless viewer (fake GL): size validation, the pixel layout, and that the
 * renderer's own targets, camera viewport and GPU memory are back as they were afterwards. The
 * fake context does not render, so pixels are whatever readPixels leaves (zeros).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeadlessViewer, type HeadlessViewer } from './__tests__/headlessViewer';

let hv: HeadlessViewer | null = null;
afterEach(() => {
  hv?.dispose();
  hv = null;
});

describe('screenshots', () => {
  it('validates the size against the texture limit', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    for (const [w, h] of [[0, 10], [10, 0], [1.5, 10], [10, NaN], [16385, 10], [10, 16385], [-1, 1]]) {
      expect(() => v.getScreenshotPixels(w, h)).toThrow(RangeError);
    }
    expect(() => v.getScreenshotPixels(16385, 10)).toThrow(/1 to 16384 pixels, got 16385/);
    expect(() => v.getScreenshotPixels(1, 1)).not.toThrow();
  });

  it('returns an ImageData layout and leaves the canvas image to restart', () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    v.addMesh({ geometry: v.primitives.box(), material: v.createMaterial(), objectId: 1 });
    hv.frame();
    const before = hv.gpuBytes();
    const main = v.renderer.targets;
    const image = v.getScreenshotPixels(8, 4);
    expect(image.width).toBe(8);
    expect(image.height).toBe(4);
    expect(image.data).toBeInstanceOf(Uint8ClampedArray);
    expect(image.data.length).toBe(8 * 4 * 4);
    // the screenshot's targets are gone, the canvas target is the renderer's again
    expect(hv.gpuBytes()).toBe(before);
    expect(v.renderer.targets).toBe(main); // headless frames never size it, so identity is the check
    expect(v.renderer.idle).toBe(false); // a frame is scheduled to restart the canvas image
    // a second one works the same (nothing left half-swapped by the first)
    expect(v.getScreenshotPixels(3, 5).data.length).toBe(60);
    expect(hv.gpuBytes()).toBe(before);
  });

  it('getScreenshot rejects outside a browser and after dispose', async () => {
    hv = createHeadlessViewer();
    const v = hv.viewer;
    await expect(v.getScreenshot(4, 4)).rejects.toThrow(/needs a browser|getScreenshotPixels/);
    await expect(v.getScreenshot(0, 4)).rejects.toThrow(RangeError);
    hv.dispose();
    hv = null;
    expect(() => v.getScreenshotPixels(4, 4)).toThrow(/disposed/);
  });
});
