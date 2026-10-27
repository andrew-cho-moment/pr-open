/** Parse a CalVer string (`YYYY.M.micro`) into numeric parts, or null if any part isn't an integer. */
export function parseVersion(v: string): number[] | null {
  const nums = v.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** Compare two parsed versions element-wise; positive if `a` is newer than `b`, missing parts as 0. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * True when `latest` is a newer release than `current`. Both are compared numerically when they
 * parse as CalVer; a non-parsing `current` (e.g. a `0.0.0-dev` source build) counts as behind any
 * differently-named release.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  return c && l ? compareVersions(l, c) > 0 : current !== latest;
}
