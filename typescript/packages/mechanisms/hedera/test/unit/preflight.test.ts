import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHederaPreflightTransfer } from "../../src/preflight";

const HBAR = "0.0.0";
const TOKEN = "0.0.6001";
const MIRROR = "https://testnet.mirrornode.hedera.com";

function accountJson(balance: number, maxAuto = 0) {
  return {
    balance: { balance },
    max_automatic_token_associations: maxAuto,
  };
}

function tokensJson(
  tokens: Array<{ token_id: string; balance: number; automatic_association: boolean }>,
  next: string | null = null,
) {
  return { tokens, links: { next } };
}

function installFetchMock(handler: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = handler(url);
      if (body === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("createHederaPreflightTransfer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HBAR: ok when payer balance >= amount", async () => {
    installFetchMock(url => {
      if (url === `${MIRROR}/api/v1/accounts/0.0.9001`) {
        return accountJson(5000);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: HBAR,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result).toEqual({ ok: true });
  });

  it("HBAR: insufficient_balance when payer short", async () => {
    installFetchMock(url => {
      if (url === `${MIRROR}/api/v1/accounts/0.0.9001`) {
        return accountJson(500);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: HBAR,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_balance");
    expect(result.message).toContain("500");
  });

  it("HTS: insufficient token balance when payer has no relationship", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens`)) {
        return tokensJson([]);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_balance");
  });

  it("HTS: insufficient token balance when payer holds less than required", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens`)) {
        return tokensJson([{ token_id: TOKEN, balance: 100, automatic_association: false }]);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("insufficient_balance");
  });

  it("HTS: ok when payTo already associated", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens`)) {
        return tokensJson([{ token_id: TOKEN, balance: 5000, automatic_association: false }]);
      }
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.7001/tokens`)) {
        return tokensJson([{ token_id: TOKEN, balance: 0, automatic_association: false }]);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result).toEqual({ ok: true });
  });

  it("HTS: ok when payTo has unlimited auto-association (-1)", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens`)) {
        return tokensJson([{ token_id: TOKEN, balance: 5000, automatic_association: false }]);
      }
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.7001/tokens?token.id=`)) {
        return tokensJson([]);
      }
      if (url === `${MIRROR}/api/v1/accounts/0.0.7001`) {
        return accountJson(0, -1);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result).toEqual({ ok: true });
  });

  it("HTS: ok when payTo has available auto-association slot", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens?token.id=`)) {
        return tokensJson([{ token_id: TOKEN, balance: 5000, automatic_association: false }]);
      }
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.7001/tokens?token.id=`)) {
        return tokensJson([]);
      }
      if (url === `${MIRROR}/api/v1/accounts/0.0.7001`) {
        return accountJson(0, 3);
      }
      if (url === `${MIRROR}/api/v1/accounts/0.0.7001/tokens?limit=100`) {
        return tokensJson([{ token_id: "0.0.9999", balance: 0, automatic_association: true }]);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result).toEqual({ ok: true });
  });

  it("HTS: pay_to_not_associated when no association and maxAuto is 0", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens`)) {
        return tokensJson([{ token_id: TOKEN, balance: 5000, automatic_association: false }]);
      }
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.7001/tokens?token.id=`)) {
        return tokensJson([]);
      }
      if (url === `${MIRROR}/api/v1/accounts/0.0.7001`) {
        return accountJson(0, 0);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("pay_to_not_associated");
  });

  it("HTS: pay_to_not_associated when auto slots fully consumed", async () => {
    installFetchMock(url => {
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.9001/tokens`)) {
        return tokensJson([{ token_id: TOKEN, balance: 5000, automatic_association: false }]);
      }
      if (url.startsWith(`${MIRROR}/api/v1/accounts/0.0.7001/tokens?token.id=`)) {
        return tokensJson([]);
      }
      if (url === `${MIRROR}/api/v1/accounts/0.0.7001`) {
        return accountJson(0, 2);
      }
      if (url === `${MIRROR}/api/v1/accounts/0.0.7001/tokens?limit=100`) {
        return tokensJson([
          { token_id: "0.0.1", balance: 0, automatic_association: true },
          { token_id: "0.0.2", balance: 0, automatic_association: true },
        ]);
      }
    });
    const preflight = createHederaPreflightTransfer();
    const result = await preflight({
      payer: "0.0.9001",
      payTo: "0.0.7001",
      asset: TOKEN,
      amount: "1000",
      network: "hedera:testnet",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("pay_to_not_associated");
  });

  it("propagates mirror node errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream error", { status: 503 })),
    );
    const preflight = createHederaPreflightTransfer();
    await expect(
      preflight({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        asset: HBAR,
        amount: "1000",
        network: "hedera:testnet",
      }),
    ).rejects.toThrow("mirror node request failed");
  });
});
