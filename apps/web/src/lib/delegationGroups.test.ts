import { describe, expect, it } from "vite-plus/test";
import {
  createDelegationColorMap,
  delegationColorIndex,
  groupDelegationThreads,
  visibleDelegationThreads,
} from "./delegationGroups";

const thread = (id: string, parent: string | null = null, environmentId = "local") => ({
  id,
  environmentId,
  delegationParentThreadId: parent,
});

describe("delegation family grouping", () => {
  it("keeps a parent's children together and places the parent first even when recent children sort ahead", () => {
    const groups = groupDelegationThreads([
      thread("c", "p"),
      thread("other"),
      thread("p"),
      thread("c2", "p"),
    ]);
    expect(groups.map((g) => [g.isFamily, g.members.map((t) => t.id)])).toEqual([
      [true, ["p", "c", "c2"]],
      [false, ["other"]],
    ]);
  });
  it("does not merge identical thread ids from different environments", () => {
    expect(groupDelegationThreads([thread("c", "p"), thread("c", "p", "remote")])).toHaveLength(2);
  });
  it("retains children whose parent has been filtered, archived or deleted", () => {
    const groups = groupDelegationThreads([thread("c", "missing")]);
    expect(groups[0]).toMatchObject({ key: "local:missing", isFamily: true });
    expect(groups[0]?.members[0]?.id).toBe("c");
  });
  it("does not infer links from titles or merge duplicate rows", () => {
    const groups = groupDelegationThreads([
      thread("[委譲] ordinary"),
      thread("child", "p"),
      thread("child", "p"),
    ]);
    expect(groups[0]?.isFamily).toBe(false);
    expect(groups[1]?.members).toHaveLength(1);
  });
  it("keeps a family's color stable across reloads and child order changes", () => {
    const first = groupDelegationThreads([thread("p"), thread("c", "p")])[0]!;
    const reordered = groupDelegationThreads([thread("c", "p"), thread("p")])[0]!;
    expect(delegationColorIndex(first.key)).toBe(delegationColorIndex(reordered.key));
  });
});

it("allocates different colors to colliding family ids and keeps the map independent of row order", () => {
  const keys = ["env:p1", "env:p7", "other:p1"];
  expect(delegationColorIndex(keys[0]!)).toBe(delegationColorIndex(keys[1]!));
  const colors = createDelegationColorMap(keys);
  expect(new Set(colors.values()).size).toBe(keys.length);
  expect([...colors]).toEqual([...createDelegationColorMap(keys.toReversed())]);
});

it("excludes only collapsed children from navigation and range selection, including missing parents", () => {
  const rows = [
    thread("p"),
    thread("c", "p"),
    thread("q"),
    thread("d", "q"),
    thread("orphan", "missing"),
  ];
  expect(
    visibleDelegationThreads(rows, new Set(["local:p", "local:missing"])).map((t) => t.id),
  ).toEqual(["p", "q", "d"]);
  expect(visibleDelegationThreads(rows, new Set()).map((t) => t.id)).toEqual(rows.map((t) => t.id));
  expect(visibleDelegationThreads([thread("c", "p", "remote")], new Set(["local:p"]))).toHaveLength(
    1,
  );
});
