import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

const callbacks = {
  onTextChange: vi.fn(),
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

describe("DiffCommentAnnotation", () => {
  it("renders the shared draft composer directly in the selected diff", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation kind="draft" rangeLabel="+78" text="" {...callbacks} />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("Local comment");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("⌘/Ctrl+Enterで送信");
    expect(markup).toContain("コメントを追加…");
    expect(markup).toContain(">コメント</button>");
    expect(markup).toContain("autofocus");
    // The comment box is the standard small Textarea, not a bespoke surface.
    expect(markup).toMatch(/<span[^>]*data-size="sm"[^>]*data-slot="textarea-control"/);
  });

  it("lets a pull-request diff configure actions without replacing the composer", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="src/app.ts:4"
        text=""
        {...callbacks}
        submitLabel="Add to review"
        secondaryAction={{
          label: "Add to agent",
          onAction: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain("コメントを追加…");
    expect(markup).toContain(">レビューに追加</button>");
    expect(markup.match(/<button[^>]*disabled[^>]*>レビューに追加<\/button>/)).not.toBeNull();
    expect(markup.match(/<button[^>]*disabled[^>]*>エージェントに追加<\/button>/)).not.toBeNull();
  });

  it("renders a saved comment without a nested card or redundant range label", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Please keep this branch explicit."
        {...callbacks}
      />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("Please keep this branch explicit.");
    expect(markup).toContain('aria-label="コメントを削除"');
    expect(markup).toContain("border-s-2");
    expect(markup).toContain("bg-primary/[0.045]");
    expect(markup).toContain("lucide-message-circle");
  });

  it("renders draft text owned by the annotation wrapper", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text="Keep this unsaved draft"
        {...callbacks}
      />,
    );

    expect(markup).toContain("Keep this unsaved draft");
  });
});
