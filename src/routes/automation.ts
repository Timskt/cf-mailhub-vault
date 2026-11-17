import { Hono } from "hono";
import {
  automationError,
  batchVerification,
  inspectMailbox,
  parseTarget,
  parseVerification,
  verifyTarget,
} from "../automation";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) => {
  if (error instanceof SyntaxError)
    return c.json(
      {
        success: false,
        error: "INVALID_JSON",
        message: "JSON 请求格式无效",
        retryable: false,
      },
      400,
    );
  const result = automationError(error);
  if (result.retry_after) c.header("Retry-After", String(result.retry_after));
  return c.json(result, result.status as 400);
});
app.post("/mailbox", async (c) =>
  c.json({
    success: true,
    data: await inspectMailbox(
      c.env,
      parseTarget(await c.req.json()),
      c.get("auth"),
    ),
  }),
);
app.post("/verification", async (c) =>
  c.json({
    success: true,
    data: await verifyTarget(
      c.env,
      parseVerification(await c.req.json()),
      undefined,
      c.get("auth"),
    ),
  }),
);
app.post("/verification/batch", async (c) =>
  c.json({
    success: true,
    data: await batchVerification(c.env, await c.req.json(), c.get("auth")),
  }),
);
export default app;
