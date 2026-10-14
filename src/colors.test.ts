import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORS } from './colors';

describe('DEFAULT_COLORS', () => {
  it('is a frozen palette of 10 named colours with components in 0..1', () => {
    expect(Object.isFrozen(DEFAULT_COLORS)).toBe(true);
    expect(DEFAULT_COLORS).toHaveLength(10);
    for (const c of DEFAULT_COLORS) {
      expect(Object.isFrozen(c)).toBe(true);
      expect(Object.isFrozen(c.color)).toBe(true);
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.color.length === 3 || c.color.length === 4).toBe(true);
      for (const v of c.color) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(DEFAULT_COLORS[0]).toEqual({ label: 'Red', color: [1, 0, 0] });
  });
});
