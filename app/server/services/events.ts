import { EventEmitter } from "node:events";

export interface MessageEvent {
  type: "message.received";
  address_id: string;
  message_id: string;
  subject: string | null;
  from: string | null;
  received_at: number;
  has_code: boolean;
}
export interface AddressEvent {
  type: "address.updated" | "address.created" | "address.deleted";
  address_id: string;
}
export interface CategoryEvent {
  type: "category.changed";
}
export type AppEvent = MessageEvent | AddressEvent | CategoryEvent;

/** In-process pub/sub, scoped per user. */
export class EventBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  publish(userId: string, event: AppEvent) {
    this.ee.emit(`u:${userId}`, event);
    this.ee.emit("all", userId, event);
  }
  /** Every event of every user (server-side consumers such as automation webhooks). */
  tap(fn: (userId: string, e: AppEvent) => void): () => void {
    this.ee.on("all", fn);
    return () => this.ee.off("all", fn);
  }
  subscribe(userId: string, fn: (e: AppEvent) => void): () => void {
    this.ee.on(`u:${userId}`, fn);
    return () => this.ee.off(`u:${userId}`, fn);
  }
  listenerCount(userId: string) {
    return this.ee.listenerCount(`u:${userId}`);
  }
}
