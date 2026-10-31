export type IngestAction = "forward" | "store_only" | "reject";

export interface IngestResult {
  action: IngestAction;
  forward_to?: string;
  /** Every destination when there are several (forward_to is the first one, for older Workers). */
  forward_to_all?: string[];
  /** PGP-encrypted copies the Worker must send itself (send_email binding), from `from`. */
  send?: Array<{ from: string; to: string; raw_base64: string }>;
  reason?: string;
  message_id?: string;
  duplicate?: boolean;
}

export interface IngestInput {
  raw: Uint8Array;
  envelopeFrom: string;
  envelopeTo: string;
}
