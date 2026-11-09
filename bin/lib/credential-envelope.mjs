import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// Credentials cross the bridge terminal, whose scrollback anyone with the terminal can read, so they
// travel sealed to the `watch` process: X25519 agreement with its published key, HKDF, AES-256-GCM.
export const ENVELOPE_VERSION = 1;
const INFO = Buffer.from("orca-colab credential envelope v1");

export function createEnvelopeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
}

function deriveKey(privateKey, publicKey) {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
}

export function sealForRecipient(recipientPublicKeyB64, payload) {
  const recipient = createPublicKey({
    key: Buffer.from(recipientPublicKeyB64, "base64"),
    type: "spki",
    format: "der",
  });
  const ephemeral = generateKeyPairSync("x25519");
  const key = deriveKey(ephemeral.privateKey, recipient);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    epk: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    iv: iv.toString("base64"),
    ct: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function openEnvelope(privateKey, envelope) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION) {
    throw new Error("unsupported credential envelope");
  }
  const sender = createPublicKey({ key: Buffer.from(envelope.epk, "base64"), type: "spki", format: "der" });
  const key = deriveKey(privateKey instanceof Object && privateKey.type ? privateKey : createPrivateKey(privateKey), sender);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
