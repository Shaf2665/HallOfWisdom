import { z } from "zod";

/**
 * The protocol version every Hall message is stamped with, so Hall Core,
 * Hall Runner, the web app, and adapters can detect incompatible messages
 * instead of silently misinterpreting them.
 */
export const PROTOCOL_VERSION = "0.1";

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
