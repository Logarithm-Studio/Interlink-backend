import assert from "node:assert/strict";
import test from "node:test";
import { createDataSourcePage, createDatabaseRow, createPage, markdownToBlocks } from "./notion.service";

test("Notion exports preserve long reviewed paragraphs and fenced code", () => {
  for (const fenced of [false, true]) {
    const content = "a".repeat(1999) + "🚀" + "b".repeat(2300) + " FINAL APPROVED TERMS";
    const blocks = markdownToBlocks(fenced ? "```\n" + content + "\n```" : content);
    const body = blocks[0][fenced ? "code" : "paragraph"] as { rich_text: { text: { content: string } }[] };
    assert.equal(body.rich_text.map(part => part.text.content).join(""), content);
    for (const part of body.rich_text) {
      assert.ok(part.text.content.length <= 2000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(part.text.content), "do not split an emoji's surrogate pair");
    }
  }
});

test("page creation rejects oversized block lists before creating a partial external copy", async () => {
  const content = Array.from({ length: 101 }, (_, i) => `Line ${i}`).join("\n");
  await assert.rejects(createPage("fixture-user", { parentId: "parent", title: "Reviewed brief", content }), /100 blocks/);
  await assert.rejects(createDataSourcePage("fixture-user", "source", {}, content, "Reviewed campaign"), /100 blocks/);
  await assert.rejects(createDatabaseRow("fixture-user", "database", "Reviewed campaign", content), /100 blocks/);
});
