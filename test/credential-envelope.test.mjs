import assert from "node:assert/strict";
import test from "node:test";
import { createEnvelopeKeyPair, openEnvelope, sealForRecipient } from "../bin/lib/credential-envelope.mjs";

test("a sealed envelope opens only with the recipient's private key and detects tampering", () => {
  const recipient = createEnvelopeKeyPair();
  const other = createEnvelopeKeyPair();
  const secret = { refreshToken: "1//0gabc", accessToken: "ya29.x", email: "someone@example.com" };
  const envelope = sealForRecipient(recipient.publicKeyB64, secret);
  assert.ok(!JSON.stringify(envelope).includes("1//0gabc"));
  assert.deepEqual(openEnvelope(recipient.privateKey, envelope), secret);
  assert.throws(() => openEnvelope(other.privateKey, envelope));
  const tampered = { ...envelope, ct: Buffer.from("x" + Buffer.from(envelope.ct, "base64").toString("latin1").slice(1), "latin1").toString("base64") };
  assert.throws(() => openEnvelope(recipient.privateKey, tampered));
});
