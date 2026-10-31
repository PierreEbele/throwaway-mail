export { ThrowawayMail, type ThrowawayMailOptions, type EventsOptions, type StreamEvent } from "./client.js";
export { ThrowawayMailError } from "./errors.js";
export type { FetchLike, RequestOptions } from "./http.js";
export { parseSse, type SseMessage } from "./sse.js";
export type * from "./types.js";
export type {
  CreateAddressParams,
  UpdateAddressParams,
  ListAddressesParams,
  ListMessagesParams,
  BulkAddressAction,
  SenderAction,
  GetCodeParams,
  WaitForCodeOptions,
  Since,
} from "./resources/addresses.js";
export type { BulkMessageAction, BulkMessageScope } from "./resources/messages.js";
export type { CategoryParams } from "./resources/categories.js";
export type { NotifyTargetParams } from "./resources/misc.js";
export type { Addresses } from "./resources/addresses.js";
export type { Messages } from "./resources/messages.js";
export type { Categories } from "./resources/categories.js";
export type { SmartFolders, Directories, Destinations, Notifications, Keys } from "./resources/misc.js";
export type { Account } from "./resources/account.js";
