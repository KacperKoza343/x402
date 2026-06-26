import { beforeEach, describe, expect, it, vi } from "vitest";

const infoExecute = vi.fn();
const setInfoAccountId = vi.fn(function (this: unknown) {
  return this;
});

vi.mock("@hiero-ledger/sdk", async () => {
  const actual = await vi.importActual<typeof import("@hiero-ledger/sdk")>("@hiero-ledger/sdk");
  class AccountInfoQuery {
    setAccountId = setInfoAccountId;
    execute = infoExecute;
  }
  return { ...actual, AccountInfoQuery };
});

import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  createHederaVerifyPayerSignature,
  verifyAccountKeySignedTransaction,
} from "../../src/signer";

const HEDERA_KEY_TYPES = [
  { label: "ED25519", generate: () => PrivateKey.generateED25519() },
  { label: "ECDSA", generate: () => PrivateKey.generateECDSA() },
] as const;

async function createTransferBase64(args: {
  payer: string;
  payTo: string;
  feePayer: string;
  amount: string;
  signWith?: PrivateKey;
}): Promise<string> {
  const tx = new TransferTransaction();
  const amount = BigInt(args.amount);
  tx.addHbarTransfer(AccountId.fromString(args.payer), Hbar.fromTinybars((-amount).toString()));
  tx.addHbarTransfer(AccountId.fromString(args.payTo), Hbar.fromTinybars(amount.toString()));
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(args.feePayer)));
  const client = Client.forTestnet();
  try {
    tx.freezeWith(client);
    const finalized = args.signWith ? await tx.sign(args.signWith) : tx;
    return Buffer.from(finalized.toBytes()).toString("base64");
  } finally {
    client.close();
  }
}

describe.each(HEDERA_KEY_TYPES)("$label payer keys", ({ generate }) => {
  describe("verifyAccountKeySignedTransaction", () => {
    it("returns true when the account public key signed the transaction", async () => {
      const payerKey = generate();
      const transaction = await createTransferBase64({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        feePayer: "0.0.5001",
        amount: "1000",
        signWith: payerKey,
      });
      const tx = TransferTransaction.fromBytes(Buffer.from(transaction, "base64"));
      expect(verifyAccountKeySignedTransaction(payerKey.publicKey, tx)).toBe(true);
    });

    it("returns false when signed with a different key of the same type", async () => {
      const payerKey = generate();
      const wrongKey = generate();
      const transaction = await createTransferBase64({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        feePayer: "0.0.5001",
        amount: "1000",
        signWith: wrongKey,
      });
      const tx = TransferTransaction.fromBytes(Buffer.from(transaction, "base64"));
      expect(verifyAccountKeySignedTransaction(payerKey.publicKey, tx)).toBe(false);
    });

    it("returns false for unsigned transactions", async () => {
      const payerKey = generate();
      const transaction = await createTransferBase64({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        feePayer: "0.0.5001",
        amount: "1000",
      });
      const tx = TransferTransaction.fromBytes(Buffer.from(transaction, "base64"));
      expect(verifyAccountKeySignedTransaction(payerKey.publicKey, tx)).toBe(false);
    });
  });

  describe("createHederaVerifyPayerSignature", () => {
    const client = { close: vi.fn() } as unknown as Client;
    const build = vi.fn(() => client);

    beforeEach(() => {
      infoExecute.mockReset();
      setInfoAccountId.mockClear();
      client.close = vi.fn();
      build.mockClear();
    });

    it("returns ok when payer signed with the correct key", async () => {
      const payerKey = generate();
      infoExecute.mockResolvedValue({ key: payerKey.publicKey });
      const verify = createHederaVerifyPayerSignature(build);
      const transaction = await createTransferBase64({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        feePayer: "0.0.5001",
        amount: "1000",
        signWith: payerKey,
      });
      const result = await verify({
        transaction,
        payer: "0.0.9001",
        network: "hedera:testnet",
      });
      expect(result).toEqual({ ok: true });
      expect(client.close).toHaveBeenCalled();
    });

    it("rejects when transaction was signed with a different key", async () => {
      const payerKey = generate();
      const wrongKey = generate();
      infoExecute.mockResolvedValue({ key: payerKey.publicKey });
      const verify = createHederaVerifyPayerSignature(build);
      const transaction = await createTransferBase64({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        feePayer: "0.0.5001",
        amount: "1000",
        signWith: wrongKey,
      });
      const result = await verify({
        transaction,
        payer: "0.0.9001",
        network: "hedera:testnet",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("payer_signature_invalid");
    });

    it("rejects unsigned transactions", async () => {
      const payerKey = generate();
      infoExecute.mockResolvedValue({ key: payerKey.publicKey });
      const verify = createHederaVerifyPayerSignature(build);
      const transaction = await createTransferBase64({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        feePayer: "0.0.5001",
        amount: "1000",
      });
      const result = await verify({
        transaction,
        payer: "0.0.9001",
        network: "hedera:testnet",
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("payer_signature_invalid");
    });
  });
});
