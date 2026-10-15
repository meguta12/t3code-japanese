/** A family is identified by its durable parent, never by a generated title. */
export interface DelegationGroupThread {
  readonly id: string;
  readonly environmentId: string;
  readonly delegationParentThreadId?: string | null | undefined;
}

export type DelegationRole = "parent" | "child";

export function delegationThreadKey(thread: DelegationGroupThread): string {
  return `${thread.environmentId}:${thread.id}`;
}

export function delegationFamilyKey(thread: DelegationGroupThread): string {
  return `${thread.environmentId}:${thread.delegationParentThreadId ?? thread.id}`;
}

export function delegationColorIndex(key: string): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return (hash >>> 0) % 6;
}

export function groupDelegationThreads<T extends DelegationGroupThread>(threads: readonly T[]) {
  const groups = new Map<string, { key: string; members: T[]; isFamily: boolean }>();
  for (const thread of threads) {
    const key = delegationFamilyKey(thread);
    const group = groups.get(key) ?? { key, members: [], isFamily: false };
    if (
      !group.members.some((member) => delegationThreadKey(member) === delegationThreadKey(thread))
    ) {
      group.members.push(thread);
    }
    group.isFamily ||= thread.delegationParentThreadId != null;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    members: group.members.toSorted(
      (left, right) =>
        Number(left.delegationParentThreadId != null) -
        Number(right.delegationParentThreadId != null),
    ),
  }));
}

const FAMILY_COLORS = ["#55a7e8", "#b18ade", "#46ad96", "#cf9a4f", "#d77e99", "#8397e0"];

/** Allocate once across all visible environments, so separate lists agree and collisions resolve. */
export function createDelegationColorMap(keys: Iterable<string>): ReadonlyMap<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const key of [...new Set(keys)].toSorted()) {
    const first = delegationColorIndex(key);
    let color = FAMILY_COLORS[first]!;
    for (let offset = 0; used.has(color); offset++) {
      color =
        offset < FAMILY_COLORS.length - 1
          ? FAMILY_COLORS[(first + offset + 1) % FAMILY_COLORS.length]!
          : `hsl(${(first * 59 + offset * 137) % 360} 58% ${55 + Math.floor(offset / 360)}%)`;
    }
    used.add(color);
    colors.set(key, color);
  }
  return colors;
}

export function fallbackDelegationColor(key: string): string {
  return FAMILY_COLORS[delegationColorIndex(key)]!;
}

/** Hidden children must also leave keyboard and range-selection order. */
export function visibleDelegationThreads<T extends DelegationGroupThread>(
  threads: readonly T[],
  collapsedFamilies: ReadonlySet<string>,
): T[] {
  return threads.filter(
    (thread) =>
      thread.delegationParentThreadId == null ||
      !collapsedFamilies.has(delegationFamilyKey(thread)),
  );
}
