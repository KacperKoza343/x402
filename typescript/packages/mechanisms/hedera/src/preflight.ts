import { HEDERA_MAINNET_CAIP2, HEDERA_TESTNET_CAIP2 } from "./constants";
import { assertSupportedHederaNetwork, isHbarAsset } from "./utils";

/**
 * Parameters passed to a `FacilitatorHederaSigner.preflightTransfer` hook.
 */
export type HederaPreflightParams = {
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
  network: string;
};

/**
 * Result returned from a `preflightTransfer` hook.
 */
export type HederaPreflightResult = {
  ok: boolean;
  reason?: string;
  message?: string;
};

/**
 * Configuration for mirror-node-backed preflight checks.
 */
export type HederaPreflightConfig = {
  /**
   * Mirror node base URL, or a resolver from CAIP-2 network to base URL.
   * Defaults to Hedera public mirror nodes for mainnet and testnet.
   */
  mirrorNodeUrl?: string | ((network: string) => string);
  /**
   * Per-request timeout in milliseconds for mirror node fetches.
   * Bounds the verify path against a stalled mirror node. Defaults to 10000.
   */
  timeoutMs?: number;
};

const DEFAULT_MIRROR_NODE_TIMEOUT_MS = 10_000;

type MirrorAccountResponse = {
  balance: { balance: number };
  max_automatic_token_associations: number;
};

type MirrorTokenRelationship = {
  automatic_association: boolean;
  balance: number;
  token_id: string;
};

type MirrorTokensResponse = {
  tokens: MirrorTokenRelationship[];
  links?: { next?: string | null };
};

const DEFAULT_MIRROR_NODE_URLS: Record<string, string> = {
  [HEDERA_TESTNET_CAIP2]: "https://testnet.mirrornode.hedera.com",
  [HEDERA_MAINNET_CAIP2]: "https://mainnet-public.mirrornode.hedera.com",
};

/**
 * Resolves the mirror node base URL for a Hedera CAIP-2 network.
 *
 * @param network - CAIP-2 network identifier
 * @param config - Optional preflight configuration
 * @returns Mirror node base URL without trailing slash
 */
export function resolveHederaMirrorNodeUrl(
  network: string,
  config: HederaPreflightConfig = {},
): string {
  if (typeof config.mirrorNodeUrl === "function") {
    return config.mirrorNodeUrl(network);
  }
  if (typeof config.mirrorNodeUrl === "string") {
    return config.mirrorNodeUrl;
  }
  const url = DEFAULT_MIRROR_NODE_URLS[network];
  if (!url) {
    throw new Error(`Unsupported Hedera network for mirror node: ${network}`);
  }
  return url;
}

/**
 * Performs a JSON GET against a mirror-node URL with a bounded timeout.
 *
 * @param url - Mirror node URL to fetch from
 * @param timeoutMs - Abort the request after this many milliseconds
 * @returns JSON response parsed as the generic type T
 */
async function fetchMirrorJson<T>(
  url: string,
  timeoutMs = DEFAULT_MIRROR_NODE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`mirror node request failed: ${response.status} ${url}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Fetches mirror-node account metadata including HBAR balance and auto-association limit.
 *
 * @param baseUrl - Mirror node base URL
 * @param accountId - Account ID to fetch
 * @param timeoutMs - Per-request timeout in milliseconds
 * @returns Mirror account response
 */
async function fetchMirrorAccount(
  baseUrl: string,
  accountId: string,
  timeoutMs: number,
): Promise<MirrorAccountResponse> {
  return fetchMirrorJson<MirrorAccountResponse>(
    `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`,
    timeoutMs,
  );
}

/**
 * Fetches a single token relationship for an account, if present.
 *
 * @param baseUrl - Mirror node base URL
 * @param accountId - Account ID to fetch
 * @param tokenId - Token ID to fetch
 * @param timeoutMs - Per-request timeout in milliseconds
 * @returns Mirror token relationship
 */
async function fetchTokenRelationship(
  baseUrl: string,
  accountId: string,
  tokenId: string,
  timeoutMs: number,
): Promise<MirrorTokenRelationship | undefined> {
  const url = `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}&limit=1`;
  const data = await fetchMirrorJson<MirrorTokensResponse>(url, timeoutMs);
  return data.tokens[0];
}

/**
 * Counts how many automatic token associations an account has consumed.
 *
 * @param baseUrl - Mirror node base URL
 * @param accountId - Account ID to fetch
 * @param timeoutMs - Per-request timeout in milliseconds
 * @returns Number of automatic token associations consumed
 */
async function countAutomaticAssociations(
  baseUrl: string,
  accountId: string,
  timeoutMs: number,
): Promise<number> {
  let used = 0;
  let nextUrl: string | null =
    `${baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?limit=100`;
  while (nextUrl !== null) {
    const currentUrl = nextUrl;
    const page: MirrorTokensResponse = await fetchMirrorJson<MirrorTokensResponse>(
      currentUrl,
      timeoutMs,
    );
    used += page.tokens.filter(
      (token: MirrorTokenRelationship) => token.automatic_association,
    ).length;
    // links.next is typically a relative path; resolve against the base URL.
    const next = page.links?.next ?? null;
    nextUrl = next === null ? null : new URL(next, baseUrl).toString();
  }
  return used;
}

/**
 * Builds a `preflightTransfer` implementation backed by the Hedera Mirror Node REST API.
 *
 * Checks the payer has sufficient balance of `asset` and that `payTo` is either
 * associated with `asset` or has an available auto-association slot.
 * Implements the SHOULD in `specs/schemes/exact/scheme_exact_hedera.md` §6.
 *
 * @param config - Optional mirror node URL override
 * @returns A function suitable for `FacilitatorHederaSigner.preflightTransfer`
 */
export function createHederaPreflightTransfer(
  config: HederaPreflightConfig = {},
): (params: HederaPreflightParams) => Promise<HederaPreflightResult> {
  return async ({ payer, payTo, asset, amount, network }) => {
    assertSupportedHederaNetwork(network);
    const baseUrl = resolveHederaMirrorNodeUrl(network, config);
    const timeoutMs = config.timeoutMs ?? DEFAULT_MIRROR_NODE_TIMEOUT_MS;
    const required = BigInt(amount);

    if (isHbarAsset(asset)) {
      const account = await fetchMirrorAccount(baseUrl, payer, timeoutMs);
      const payerTinybars = BigInt(account.balance.balance);
      if (payerTinybars < required) {
        return {
          ok: false,
          reason: "insufficient_balance",
          message: `payer has ${payerTinybars} tinybars, needs ${required}`,
        };
      }
      return { ok: true };
    }

    const payerToken = await fetchTokenRelationship(baseUrl, payer, asset, timeoutMs);
    const held = payerToken ? BigInt(payerToken.balance) : 0n;
    if (held < required) {
      return {
        ok: false,
        reason: "insufficient_balance",
        message: `payer holds ${held} of ${asset}, needs ${required}`,
      };
    }

    const payToToken = await fetchTokenRelationship(baseUrl, payTo, asset, timeoutMs);
    if (payToToken) {
      return { ok: true };
    }

    const payToAccount = await fetchMirrorAccount(baseUrl, payTo, timeoutMs);
    const maxAuto = payToAccount.max_automatic_token_associations;
    if (maxAuto === -1) {
      return { ok: true };
    }
    if (maxAuto === 0) {
      return {
        ok: false,
        reason: "pay_to_not_associated",
        message: `payTo ${payTo} is not associated with ${asset} and has no auto-association slots`,
      };
    }

    const usedAuto = await countAutomaticAssociations(baseUrl, payTo, timeoutMs);
    if (usedAuto < maxAuto) {
      return { ok: true };
    }

    return {
      ok: false,
      reason: "pay_to_not_associated",
      message: `payTo ${payTo} is not associated with ${asset} and has no auto-association slots`,
    };
  };
}
