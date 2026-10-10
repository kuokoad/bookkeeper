const slugs: Record<number, string> = { 1: 'cash', 2: 'momo', 3: 'bank' };

export function accountHref(id: number): string {
  return `/accounts/${slugs[id] ?? id}`;
}

export function accountIdFromRoute(value: string): number | undefined {
  const named = Object.entries(slugs).find(([, slug]) => slug === value);
  if (named) return Number(named[0]);
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}
