import { Worker } from "bullmq";
import { recordActivity } from "../lib/activity";
import type { ActivityAction, ActivityDetail } from "../lib/activity-actions";
import { reportError } from "../lib/observability";
import { redisConnection } from "../lib/queue";
import { readQrConfig } from "../lib/whatsapp-web/config";
import { createDeliveryHandler } from "../lib/whatsapp-web/delivery";
import { maskE164 } from "../lib/whatsapp-web/mask";
import { prismaSessionRepo, type SessionPatch, type SessionRepo } from "../lib/whatsapp-web/session-repo";
import { runTestSend, type TestJob } from "../lib/whatsapp-web/test-send";
import { WHATSAPP_WEB_TEST_QUEUE } from "../lib/whatsapp-web/test-queue";
import { startWhatsAppWeb } from "./whatsapp-web";
import type { WhatsAppWebManager } from "./whatsapp-web-manager";

/**
 * The messaging side of the optional QR-code WhatsApp mode inside the worker (worker/index.ts starts this instead of calling
 * startWhatsAppWeb directly). On top of the manager it adds:
 *  - delivery receipts of the messages the linked number sent, written onto their `messages` rows (lib/whatsapp-web/delivery.ts);
 *  - the account-activity entries for linking, suspending and being logged out (the e-mail to the influencer is the manager's own
 *    `notify`; the entries here are the trail the influencer and an administrator can read);
 *  - the answer to the dashboard's "send me a test message" (lib/whatsapp-web/test-send.ts), through a one-job queue.
 * Nothing here reads a customer's reply: the transport has no event for incoming messages.
 */

type ActivityRecorder = (influencerId: string, action: ActivityAction, detail: ActivityDetail) => void;

/**
 * The session repository, with a side effect on three kinds of change: a number that becomes LINKED for the first time (not a
 * reconnect), a suspension, and a logout by the phone. The entry carries the masked tail of the influencer's own number or a short
 * machine code, never the login, a QR code or a customer. The recording is best effort and is never waited for.
 */
export function observeSessionRepo(inner: SessionRepo, record: ActivityRecorder): SessionRepo {
  return {
    listManageable: () => inner.listManageable(),
    get: (id) => inner.get(id),
    incrementSent: (id) => inner.incrementSent(id),
    authStorage: (id) => inner.authStorage(id),
    async update(influencerId: string, patch: SessionPatch) {
      let before: string | null = null;
      if (patch.status !== undefined) {
        try {
          before = (await inner.get(influencerId))?.status ?? null;
        } catch {
          before = null;
        }
      }
      await inner.update(influencerId, patch);
      try {
        if (patch.status === "LINKED" && before !== null && before !== "LINKED" && before !== "RECONNECTING") {
          record(influencerId, "whatsapp_web.linked", { phone: maskE164(patch.phoneE164) });
        } else if (patch.status === "SUSPENDED" && before !== "SUSPENDED") {
          record(influencerId, "whatsapp_web.suspended", { code: patch.lastErrorCode ?? null });
        } else if (patch.status === "LOGGED_OUT" && before !== "LOGGED_OUT") {
          record(influencerId, "whatsapp_web.disconnected", { reason: "logged-out" });
        }
      } catch {
        /* a log entry must never disturb the manager */
      }
    },
  };
}

const recordInBackground: ActivityRecorder = (influencerId, action, detail) => {
  void recordActivity({ influencerId, action, actor: "system", detail }).catch(() => {});
};

/** Starts the manager with the messaging hooks. Returns the manager (or null when the mode is off or its library cannot load). */
export async function startWhatsAppWebMessaging(): Promise<WhatsAppWebManager | null> {
  const manager = await startWhatsAppWeb({ repo: observeSessionRepo(prismaSessionRepo, recordInBackground), onDelivery: createDeliveryHandler() });
  if (!manager || !readQrConfig().enabled || !process.env.REDIS_URL) return manager;

  const tests = new Worker<TestJob>(WHATSAPP_WEB_TEST_QUEUE, async (job) => runTestSend(job.data), { connection: redisConnection(), concurrency: 1 });
  tests.on("error", (e) => reportError(e, { where: "worker:whatsapp-web-test" }));
  console.log(`[worker] processing "${WHATSAPP_WEB_TEST_QUEUE}" queue`);
  const shutdown = manager.shutdown.bind(manager);
  manager.shutdown = async () => {
    await tests.close().catch(() => {});
    await shutdown();
  };
  return manager;
}
