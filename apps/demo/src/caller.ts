/**
 * A `LedgerCaller` backed by near-workspaces, so the SDK can drive a local sandbox.
 *
 * The SDK itself depends on no NEAR library (see `packages/sdk/src/client.ts`). This adapter
 * is where the sandbox transport is bolted on; the testnet runtime will have a near-api-js
 * one that satisfies the same interface, and the SDK cannot tell them apart.
 */

import type { CallOptions, LedgerCaller } from "@krexa-ual/sdk";
import type { Account, NearAccount } from "near-workspaces";

/** Gas for an agent write. Matches tests/integration AGENT_GAS: 30 TGas, not the maximum. */
export const DEMO_GAS = 30_000_000_000_000n;

export class WorkspacesCaller implements LedgerCaller {
  constructor(
    private readonly account: NearAccount,
    private readonly contract: NearAccount,
    private readonly defaultGas: bigint = DEMO_GAS,
  ) {}

  get accountId(): string {
    return this.account.accountId;
  }

  async call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<T> {
    const result = await this.account.callRaw(this.contract, method, args, {
      gas: String(opts?.gas ?? this.defaultGas),
      attachedDeposit: String(opts?.deposit ?? 0n),
    });
    if (result.failed) {
      // Surface the contract's own panic string (E03_CHAIN_BROKEN and friends) rather than a
      // generic failure, because the error code is the interesting part.
      throw new Error(`${method} failed: ${JSON.stringify(result.result.status)}`);
    }
    return result.parseResult<T>();
  }

  async view<T = unknown>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.contract.view<T>(method, args);
  }
}

/** The same account seen as a caller, for a different signer. */
export function callerFor(account: Account | NearAccount, contract: NearAccount): LedgerCaller {
  return new WorkspacesCaller(account as NearAccount, contract);
}
