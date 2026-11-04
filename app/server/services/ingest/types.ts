export type IngestAction = "forward" | "store_only" | "reject";

export interface IngestResult {
  action: IngestAction;
  forward_to?: string;
  /** Every destination when there are several (forward_to is the first one, for older Workers). */
  forward_to_all?: string[];
  /**
   * Copies the Worker must send itself (send_email binding), from `from`: PGP-encrypted copies (`encrypted`) and
   * copies changed before forwarding (reverse-alias Reply-To, attachments removed, headers filtered).
   */
  send?: Array<{ from: string; to: string; raw_base64: string; encrypted?: boolean }>;
  /**
   * Fallback destinations, in order: when forwarding (or sending a non-encrypted copy) to a destination fails, the
   * Worker tries these one after the other until one accepts it, then reports every failure to /ingest/report.
   */
  fallback_to?: string[];
  reason?: string;
  message_id?: string;
  duplicate?: boolean;
}

export interface IngestInput {
  raw: Uint8Array;
  envelopeFrom: string;
  envelopeTo: string;
}
