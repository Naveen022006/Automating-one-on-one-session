import { alertInfluencer } from "../lib/alerts";
import { reportError } from "../lib/observability";
import { bookingAllowsMessage } from "../lib/whatsapp-web/booking-guard";
import { readQrConfig } from "../lib/whatsapp-web/config";
import { fakeTransportFactory } from "../lib/whatsapp-web/fake-transport";
import { getKv } from "../lib/whatsapp-web/kv";
import { setActiveSender } from "../lib/whatsapp-web/send";
import { prismaSessionRepo } from "../lib/whatsapp-web/session-repo";
import type { WhatsAppWebTransportFactory } from "../lib/whatsapp-web/transport";
import { WhatsAppWebManager, type ManagerDeps } from "./whatsapp-web-manager";

/**
 * Starts the optional QR-code WhatsApp manager inside the worker (worker/index.ts calls this once). See
 * worker/whatsapp-web-manager.ts for what it does.
 *
 *  - WHATSAPP_QR_ENABLED unset or false: nothing connects. One pass still runs, to apply the kill switch: every stored login is
 *    deleted (unless WHATSAPP_QR_KEEP_AUTH_WHEN_DISABLED=true), so turning the feature off really removes the data.
 *  - WHATSAPP_QR_FAKE=true (development only, see config.ts): the scriptable simulator instead of WhatsApp.
 *  - otherwise the real library must load. If it cannot, the manager does NOT start: the sessions stay as they are, the dashboard
 *    shows that the worker is not running, and messages keep going through the official connection, SMS and e-mail.
 */
export async function startWhatsAppWeb(overrides: Partial<ManagerDeps> = {}): Promise<WhatsAppWebManager | null> {
  const log = (line: string) => console.log(`[whatsapp-web] ${line}`);
  const cfg = readQrConfig();

  let transportFactory: WhatsAppWebTransportFactory;
  if (!cfg.enabled) {
    transportFactory = () => {
      throw new Error("the QR-code WhatsApp mode is switched off");
    };
  } else if (cfg.fake) {
    log("SIMULATOR in use (WHATSAPP_QR_FAKE=true): nothing reaches WhatsApp");
    transportFactory = fakeTransportFactory;
  } else {
    const { baileysAvailable, createBaileysTransportFactory } = await import("../lib/whatsapp-web/baileys-transport");
    if (!(await baileysAvailable())) {
      console.error("[whatsapp-web] the WhatsApp library could not be loaded, so QR-code linking is not started");
      return null;
    }
    transportFactory = createBaileysTransportFactory();
  }

  const deps: ManagerDeps = {
    config: () => readQrConfig(),
    repo: prismaSessionRepo,
    kv: getKv(),
    transportFactory,
    guard: bookingAllowsMessage,
    notify: async (influencerId, kind, detail) => {
      await alertInfluencer(influencerId, { kind: kind === "logged-out" ? "whatsapp-qr-logged-out" : "whatsapp-qr-suspended", detail });
    },
    log,
    ...overrides,
  };
  const manager = new WhatsAppWebManager(deps);

  if (!cfg.enabled) {
    // One pass: the kill switch. Errors (for example the table is missing) must not stop the rest of the worker.
    try {
      await manager.reconcile();
    } catch (e) {
      reportError(e, { where: "worker:whatsapp-web-kill-switch" });
    }
    await manager.shutdown();
    return null;
  }

  setActiveSender({ send: (req) => manager.send(req), isReady: (id) => manager.isReady(id) });
  manager.start();
  log(`manager started (max ${cfg.maxSessions} numbers, ${cfg.dailyCap} messages a day each, ${cfg.minGapMs} ms between messages)`);
  return manager;
}
