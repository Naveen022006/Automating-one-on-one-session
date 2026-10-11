import { SMS_API_KEY } from "./fixtures";
import { takeFault } from "./faults";
import { HttpError, randomHex, type Ctx, type Router } from "./http";

/**
 * An SMS sink: the app's "generic" SMS provider (SMS_PROVIDER=generic, SMS_API_URL=<mock>/sms/send, lib/sms.ts) posts { to, body }
 * with a Bearer key and gets an id back. That is existing, legitimate configuration, so no app code changes for it. MSG91 and
 * Twilio are not mocked.
 */

async function send(c: Ctx): Promise<void> {
  const rt = c.rt;
  if (c.bearer() !== SMS_API_KEY) throw new HttpError(401, { error: "unauthorized" });
  if (takeFault(rt, "sms", c) === "500") throw new HttpError(500, { error: "SMS gateway unavailable (injected fault)" });
  const body = await c.readJson<{ to?: unknown; body?: unknown }>();
  if (typeof body.to !== "string" || !body.to || typeof body.body !== "string" || !body.body) throw new HttpError(400, { error: "to and body are required" });
  const id = `MOCK-SMS-${randomHex(8)}`;
  rt.state.sms.push({ id, at: new Date(rt.now()).toISOString(), to: body.to, body: body.body });
  if (rt.state.sms.length > 500) rt.state.sms.splice(0, rt.state.sms.length - 500);
  rt.save();
  rt.activity(`SMS to ${body.to}: "${body.body.slice(0, 120)}"`, "/__mock/sms");
  c.sendJson(200, { id, messageId: id });
}

export function registerSms(router: Router): void {
  router.add("POST", /^\/sms\/send$/, send, "sms");
}
