import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DelegationThreadGroup, useDelegationTreeStore } from "./DelegationThreadGroup";

vi.mock("../../state/delegation", () => ({ useDelegationFamilyColor: () => "#55a7e8" }));
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useDelegationTreeStore.setState({ collapsedFamilies: new Set() });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("collapses children while retaining the parent, restores them, and leaves another family open", () => {
  act(() => {
    renderer = create(
      <ul>
        <DelegationThreadGroup familyKey="local:p" hasParent asListItem>
          <li data-row="p">parent</li>
          <li data-row="c">child</li>
        </DelegationThreadGroup>
        <DelegationThreadGroup familyKey="local:q" hasParent asListItem>
          <li data-row="q">other parent</li>
          <li data-row="d">other child</li>
        </DelegationThreadGroup>
      </ul>,
    );
  });
  const rows = () =>
    renderer!.root
      .findAll((node) => node.type === "li" && node.props["data-row"])
      .map((node) => node.props["data-row"]);
  const toggle = () => renderer!.root.findAllByType("button")[0]!;
  expect(rows()).toEqual(["p", "c", "q", "d"]);
  act(() => toggle().props.onClick());
  expect(rows()).toEqual(["p", "q", "d"]);
  expect(toggle().props["aria-expanded"]).toBe(false);
  act(() => toggle().props.onClick());
  expect(rows()).toEqual(["p", "c", "q", "d"]);
});

it("keeps an orphan family expandable without presenting its first child as a parent", () => {
  act(() => {
    renderer = create(
      <ul>
        <DelegationThreadGroup familyKey="local:missing" hasParent={false} asListItem>
          <li data-row="orphan">child</li>
        </DelegationThreadGroup>
      </ul>,
    );
  });
  const toggle = () => renderer!.root.findByType("button");
  act(() => toggle().props.onClick());
  expect(renderer!.root.findAll((node) => node.props["data-row"] === "orphan")).toHaveLength(0);
  act(() => toggle().props.onClick());
  expect(renderer!.root.findAll((node) => node.props["data-row"] === "orphan")).toHaveLength(1);
});
