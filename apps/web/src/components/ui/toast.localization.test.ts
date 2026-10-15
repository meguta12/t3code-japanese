import { describe, expect, it } from "vite-plus/test";
import { toastManager } from "./toast";

describe("toast localization", () => {
  it("keeps authored descriptions unchanged when adding and updating", () => {
    const events: unknown[] = [];
    const unsubscribe = toastManager[" subscribe"]((event) => events.push(event.options));
    try {
      const id = toastManager.add({ title: "Done", description: "Done" });
      const description = "Fix login and signup flow. ".repeat(700);
      toastManager.update(id, { description });
      expect(events[0]).toMatchObject({ title: "完了", description: "Done" });
      expect(events[1]).toMatchObject({ description });
      toastManager.close(id);
    } finally {
      unsubscribe();
    }
  });
});
