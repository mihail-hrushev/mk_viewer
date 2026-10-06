/**
 * Set operations on ascending, duplicate-free id lists (what `PropertyIndex.find` and
 * `viewer.findObjects` return), for combining queries: AND = intersection, OR = union,
 * NOT = difference. Linear merges, results in fresh Float64Arrays.
 */

export function sortedIntersection(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(Math.min(a.length, b.length));
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (x < y) i++;
    else if (y < x) j++;
    else {
      out[k++] = x;
      i++;
      j++;
    }
  }
  return k === out.length ? out : out.slice(0, k);
}

export function sortedUnion(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (x < y) {
      out[k++] = x;
      i++;
    } else if (y < x) {
      out[k++] = y;
      j++;
    } else {
      out[k++] = x;
      i++;
      j++;
    }
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return k === out.length ? out : out.slice(0, k);
}

/** Elements of `a` that are not in `b`. */
export function sortedDifference(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length) {
    const x = a[i];
    while (j < b.length && b[j] < x) j++;
    if (j < b.length && b[j] === x) i++;
    else out[k++] = a[i++];
  }
  return k === out.length ? out : out.slice(0, k);
}
