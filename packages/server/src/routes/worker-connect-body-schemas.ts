/** Request-body schemas for the connect-code routes (#1442). Field-level allowlisting lives in `parseConnectOptions` / the progress handler. */
import { z } from "zod";

/** `POST /api/workers/connect-code`: free-form operator choices, every value validated by `parseConnectOptions`. */
export const connectCodeMintBody = z.record(z.string(), z.unknown()).default({});

/** `POST /connect/:code/progress`: shape-checked in the handler so the 422 can carry the usage hint. */
export const connectProgressBody = z.object({ step: z.unknown(), status: z.unknown(), output: z.unknown() }).partial();
