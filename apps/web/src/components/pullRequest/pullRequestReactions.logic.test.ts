import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";

function reaction(overrides: Partial<PullRequestReaction> = {}): PullRequestReaction {
  return {
    content: "heart",
    count: 1,
    actors: ["octocat"],
    viewerHasReacted: false,
    ...overrides,
  };
}

describe("reaction presentation", () => {
  it("names and draws all eight, in GitHub's picker order", () => {
    expect(PULL_REQUEST_REACTION_ORDER).toEqual([
      "thumbs-up",
      "thumbs-down",
      "laugh",
      "hooray",
      "confused",
      "heart",
      "rocket",
      "eyes",
    ]);
    expect(PULL_REQUEST_REACTION_ORDER.map(pullRequestReactionEmoji)).toEqual([
      "👍",
      "👎",
      "😄",
      "🎉",
      "😕",
      "❤️",
      "🚀",
      "👀",
    ]);
    expect(pullRequestReactionName("thumbs-up")).toBe("賛成");
    expect(pullRequestReactionName("eyes")).toBe("注目");
  });
});

describe("reaction tooltip", () => {
  it("reads as GitHub's sentence for one, two and three names", () => {
    expect(
      pullRequestReactionTooltip(reaction({ content: "thumbs-up", count: 1, actors: ["Bil0000"] })),
    ).toBe("Bil0000が賛成でリアクション");
    expect(pullRequestReactionTooltip(reaction({ count: 2, actors: ["Bil0000", "octocat"] }))).toBe(
      "Bil0000とoctocatがハートでリアクション",
    );
    expect(
      pullRequestReactionTooltip(
        reaction({
          content: "eyes",
          count: 3,
          actors: ["Bil0000", "octocat"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("あなた、Bil0000とoctocatが注目でリアクション");
  });

  it("counts everyone past the third name, including the ones the host never named", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({
          content: "rocket",
          count: 15,
          actors: ["a", "b", "c", "d"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("あなた、a、bとほか12人がロケットでリアクション");
    // A host that counted more than it named still says who is missing.
    expect(pullRequestReactionTooltip(reaction({ count: 2, actors: ["octocat"] }))).toBe(
      "octocatとほか1人がハートでリアクション",
    );
    // Nothing named at all leaves the count to speak for itself, and nobody to be "other" than.
    expect(pullRequestReactionTooltip(reaction({ count: 4, actors: [] }))).toBe(
      "4人がハートでリアクション",
    );
    expect(pullRequestReactionTooltip(reaction({ count: 1, actors: [] }))).toBe(
      "1人がハートでリアクション",
    );
  });

  it("names the viewer as You, ahead of the other people who reacted", () => {
    // The host already leaves the viewer's own login out of `actors`.
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 3, actors: ["Bil0000", "octocat"], viewerHasReacted: true }),
      ),
    ).toBe("あなた、Bil0000とoctocatがハートでリアクション");
  });

  it("names nobody as You when the viewer has not reacted", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["Bil0000", "octocat"], viewerHasReacted: false }),
      ),
    ).toBe("Bil0000とoctocatがハートでリアクション");
  });

  it("names actors as given, and leaves off You, for a host with no room for the viewer", () => {
    // `count` says two and `actors` already lists two logins, one of them the viewer's own —
    // there is no slot left for "You" that wouldn't invent or hide a real reactor.
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["Bil0000", "octocat"], viewerHasReacted: true }),
      ),
    ).toBe("Bil0000とoctocatがハートでリアクション");
    // Same shape past the naming cap: the display limit still leaves an honest remainder.
    expect(
      pullRequestReactionTooltip(
        reaction({
          count: 4,
          actors: ["Bil0000", "octocat", "hubot", "zzz"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("Bil0000、octocat、hubotとほか1人がハートでリアクション");
  });

  it("keeps naming the viewer You when the host does leave them room", () => {
    // `actors` has fewer logins than `count`, so the viewer fits without being counted twice.
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["octocat"], viewerHasReacted: true }),
      ),
    ).toBe("あなたとoctocatがハートでリアクション");
  });
});

describe("reaction tooltip, with a reaction in flight", () => {
  it("still says You after an optimistic react, even at full capacity", () => {
    // The host's last snapshot had every reactor named and nobody left over; the optimistic
    // bump grows `count` without touching `actors`, so there is now room for "You" and the
    // sentence should use it rather than reading as a non-compliant host.
    const applied = applyPendingPullRequestReactions(
      [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: false })],
      new Map([["heart", true] as const]),
    );
    expect(pullRequestReactionTooltip(applied[0]!)).toBe("あなた、aとbがハートでリアクション");
  });

  it("drops You after an optimistic un-react, without treating the host as non-compliant", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ count: 2, actors: ["octocat"], viewerHasReacted: true })],
      new Map([["heart", false] as const]),
    );
    expect(pullRequestReactionTooltip(applied[0]!)).toBe("octocatがハートでリアクション");
  });
});

describe("pending reactions", () => {
  const pending = (
    entries: ReadonlyArray<readonly [PullRequestReactionContent, boolean]>,
  ): ReadonlyMap<PullRequestReactionContent, boolean> => new Map(entries);

  it("returns the host's list untouched while nothing is in flight", () => {
    const reactions = [reaction()];
    expect(applyPendingPullRequestReactions(reactions, pending([]))).toBe(reactions);
  });

  it("adds a reaction nobody had yet, in picker order", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ content: "rocket", count: 2, actors: ["a", "b"] })],
      pending([["thumbs-up", true]]),
    );
    expect(applied).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      { content: "rocket", count: 2, actors: ["a", "b"], viewerHasReacted: false },
    ]);
  });

  it("joins and leaves an existing reaction, and drops the pill nobody is left on", () => {
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"] })],
        pending([["heart", true]]),
      ),
    ).toEqual([{ content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([{ content: "heart", count: 1, actors: ["a", "b"], viewerHasReacted: false }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 1, viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([]);
  });

  it("ignores a pending state the host has already caught up with", () => {
    const reactions = [reaction({ count: 3, viewerHasReacted: true })];
    expect(applyPendingPullRequestReactions(reactions, pending([["heart", true]]))).toEqual(
      reactions,
    );
    expect(applyPendingPullRequestReactions([], pending([["heart", false]]))).toEqual([]);
  });
});
