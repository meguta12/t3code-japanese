import { describe, expect, it } from "vite-plus/test";
import { ja, jaTemplate } from "./ja";

describe("Japanese UI labels", () => {
  it("translates the context menu actions added for the Japanese edition", () => {
    for (const [source, translated] of Object.entries({
      "Copy Path": "パスをコピー",
      "Copy Thread ID": "チャットIDをコピー",
      "Pin thread": "チャットを固定",
      "Archive thread": "チャットをアーカイブ",
      "Open with": "別のアプリで開く",
      "Copy Link": "リンクをコピー",
      "Close others": "ほかのタブを閉じる",
      "Close to the right": "右側のタブを閉じる",
      "Close all": "すべてのタブを閉じる",
      "Copy branch name": "ブランチ名をコピー",
      "Thread ID": "チャットID",
      "Auto-settle behavior": "自動完了の設定",
      "Wake thread": "チャットを再開",
      "Copy mention": "参照をコピー",
    }))
      expect(ja(source)).toBe(translated);
  });

  it("translates fixed counted menu formats before inserting values", () => {
    expect(jaTemplate`Settle (${3})`).toBe("完了扱いにする（3件）");
    expect(jaTemplate`Regenerate titles (${4})`).toBe("タイトルを再生成（4件）");
    expect(jaTemplate`Unpin (${2})`).toBe("固定を解除（2件）");
    expect(jaTemplate`Save ${ja("image")}`).toBe("画像を保存");
    expect(jaTemplate`Save ${ja("video")}`).toBe("動画を保存");
    expect(jaTemplate`Save ${"Done"}`).toBe("Doneを保存");
  });
  it("translates actions and permission choices without changing original keys", () => {
    const option = { value: "fullAccess", label: "Full access" };
    expect(ja(option.label)).toBe("フルアクセス");
    expect(option).toEqual({ value: "fullAccess", label: "Full access" });
    expect(ja("Cancel")).toBe("キャンセル");
  });
  it("preserves model IDs, paths, custom text and non-string React values", () => {
    for (const text of ["gpt-6.1-sol", "/Users/keita/project", "my-project", "const on = true;"])
      expect(ja(text)).toBe(text);
    expect(ja(null)).toBe(null);
    expect(ja(42)).toBe(42);
    const node = { type: "span", props: { children: "Settings" } };
    expect(ja(node)).toBe(node);
  });
});

describe("Settings localization", () => {
  it("localizes dynamic messages while keeping names, IDs and numbers", () => {
    expect(ja("An instance named 'my-codex' already exists.")).toBe(
      "「my-codex」という接続はすでにあります。",
    );
    expect(ja("Move gpt-6.1-sol up")).toBe("gpt-6.1-solを上へ移動");
    expect(ja("Revoked 3 clients")).toBe("クライアント3件のアクセスを取り消しました");
    expect(ja("Use >=0.159.0 for full support.")).toBe(
      "すべての機能を使うには>=0.159.0を使用してください。",
    );
  });
  it("translates nested display labels without changing settings keys", () => {
    expect(ja("Paper is now your dark theme.")).toBe("Paper is now your dark theme.");
    expect(ja("Model for new threads in this project.")).toBe(
      "このプロジェクトの新しいチャットで使うモデルです。",
    );
    expect(ja("light")).toBe("ライト");
    expect(ja("/Users/keita/Light Settings")).toBe("/Users/keita/Light Settings");
  });
});

describe("localization safety", () => {
  it("preserves captures and ignores patterns without a fixed prefix", () => {
    for (const text of [
      "Fix login and signup flow",
      "custom copy",
      "custom process status",
      "custom server",
      "custom theme",
      "constructor",
      "toString",
    ])
      expect(ja(text)).toBe(text);
    expect(ja("An instance named 'Done' already exists.")).toBe(
      "「Done」という接続はすでにあります。",
    );
    expect(ja("ChatGPT - custom. Settings")).toBe("ChatGPT - custom. Settings");
    expect(jaTemplate`An instance named '${"Done"}' already exists.`).toBe(
      "「Done」という接続はすでにあります。",
    );
    expect(jaTemplate`${"custom"} theme`).toBe("customのテーマ");
  });

  it("inserts arbitrary long text into a fixed label without translating it", () => {
    const text = "Fix login and signup flow. Done. ".repeat(600);
    expect(jaTemplate`Jump to message: ${text}`).toBe(`メッセージへ移動: ${text}`);
    expect(jaTemplate`An instance named '${text}' already exists.`).toBe(
      `「${text}」という接続はすでにあります。`,
    );
  });

  it("passes long text through within the UI frame budget", () => {
    const text = "a and a process a server a theme ".repeat(600);
    const startedAt = performance.now();
    for (let index = 0; index < 100; index++) expect(ja(text)).toBe(text);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it("bounds adversarial short template matching without regex backtracking", () => {
    const text = "custom " + " and ".repeat(45) + "?";
    const startedAt = performance.now();
    for (let index = 0; index < 100; index++) expect(ja(text)).toBe(text);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});

describe("remaining interface copy safety", () => {
  it("translates formats before inserting authored titles, IDs and paths", () => {
    const title = "Done and custom copy";
    expect(jaTemplate`Archive thread "${title}"?`).toBe(
      `チャット「${title}」をアーカイブしますか？`,
    );
    expect(jaTemplate`Jump to message: ${title}`).toBe(`メッセージへ移動: ${title}`);
    const path = "/Users/keita/Done and custom copy/README.md";
    expect(jaTemplate`Project settings for ${path}`).toBe(`${path}のプロジェクト設定`);
  });

  it("localizes known server copy only when displaying it", () => {
    const state = {
      message: "Waiting for another provider update to finish.",
      model: "gpt-6.1-sol",
    };
    expect(ja(state.message)).toBe("別のエージェントの更新が終わるのを待っています。");
    expect(state).toEqual({
      message: "Waiting for another provider update to finish.",
      model: "gpt-6.1-sol",
    });
    expect(ja("an unknown provider diagnostic")).toBe("an unknown provider diagnostic");
  });
});
