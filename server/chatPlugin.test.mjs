import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeChatAttachment,
  normalizeFirDraftContext,
} from "./chatPlugin.mjs";

test("bounds text attachments before they enter the AI prompt", () => {
  const attachment = normalizeChatAttachment({
    name: "notes.txt",
    mimeType: "text/plain",
    content: "x".repeat(20_000),
  });
  assert.equal(attachment.name, "notes.txt");
  assert.equal(attachment.content.length, 12_000);
  assert.equal("data" in attachment, false);
});

test("accepts bounded PDF data and rejects unsupported attachment types", () => {
  const pdf = normalizeChatAttachment({
    name: "report.pdf",
    mimeType: "application/pdf",
    data: Buffer.from("small synthetic pdf").toString("base64"),
  });
  assert.equal(pdf.mimeType, "application/pdf");
  assert.throws(
    () => normalizeChatAttachment({
      name: "archive.zip",
      mimeType: "application/zip",
      data: "YWJj",
    }),
    /Unsupported attachment type/,
  );
});

test("bounds FIR draft options and authorized defaults", () => {
  const context = normalizeFirDraftContext({
    allowedValues: {
      CrimeHead: Array.from({ length: 30 }, (_, index) => ` Value ${index} `),
    },
    defaults: {
      PoliceStation: ` Whitefield ${"x".repeat(300)} `,
    },
  });
  assert.equal(context.allowedValues.CrimeHead.length, 15);
  assert.equal(context.allowedValues.CrimeHead[0], "Value 0");
  assert.equal(context.defaults.PoliceStation.length, 200);
});
