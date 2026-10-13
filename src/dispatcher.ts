import type { Agent } from "./agent";
import type { CapsuleState } from "./capsule";
import type { AgentResult, Channel, ConversationHost, Route, Trigger, TriggerSource } from "./plugin/types";

/** Core-owned capsule state: the last route each conversation was reached through. */
export const ROUTES_KEY = "zing/routes.json";

export type CreateDispatcherOptions = {
  agent: Pick<Agent, "startTurn" | "resetConversation">;
  state: CapsuleState;
  getChannel: (id: string) => Channel | undefined;
};

/**
 * The single entry point for everything that wakes the agent. A trigger runs one turn in its conversation;
 * when it asks for delivery, the reply leaves through the route's channel.
 */
export function createDispatcher(options: CreateDispatcherOptions): ConversationHost {
  const routes = createRouteStore(options.state);

  const outlet = (route: Route): Channel & Required<Pick<Channel, "send">> => {
    const channel = options.getChannel(route.channel);
    if (!channel) {
      throw new Error(`Cannot deliver to unknown channel: ${route.channel}`);
    }
    const send = channel.send;
    if (!send) {
      throw new Error(`Channel ${route.channel} cannot send messages`);
    }
    return { ...channel, send };
  };

  const dispatch = async (trigger: Trigger): Promise<AgentResult> => {
    let route: Route | undefined;
    if (trigger.deliver === "conversation") {
      route = await routes.get(trigger.conversationId);
      if (!route) {
        console.warn(`No route for ${trigger.conversationId}; the ${trigger.kind} reply stays in the conversation only`);
      }
    } else if (trigger.deliver) {
      route = normalizeRoute(trigger.deliver);
      outlet(route);
      await routes.remember(trigger.conversationId, route);
    }

    const result = await options.agent.startTurn({
      threadId: trigger.conversationId,
      text: trigger.text,
      senderId: trigger.senderId,
      requestId: trigger.requestId,
      trigger: { kind: trigger.kind, source: trigger.source },
    }).completed;

    // An empty reply is a deliberate choice to stay silent, which proactive turns need.
    if (route && result.text.trim()) {
      await outlet(route).send({ conversationId: trigger.conversationId, to: route.to, text: result.text });
    }
    return result;
  };

  return {
    dispatch,
    handleMessage: (message) => dispatch({ kind: "message", ...message }),
    resetConversation: (conversationId) => options.agent.resetConversation(conversationId),
  };
}

/**
 * Run a channel and trigger sources as one unit. When any of them stops or fails, the rest are stopped;
 * the first failure is rethrown after all of them settle.
 */
export async function runTriggerSources(sources: readonly TriggerSource[], signal: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  if (signal.aborted) {
    stop();
  }
  signal.addEventListener("abort", stop, { once: true });
  const failures: unknown[] = [];
  try {
    await Promise.all(
      sources.map(async (source) => {
        try {
          await source.start(controller.signal);
        } catch (error) {
          if (controller.signal.aborted) {
            console.error(`Trigger source ${source.id} failed while stopping`, error);
          } else {
            failures.push(new Error(`Trigger source ${source.id} failed`, { cause: error }));
          }
        } finally {
          controller.abort();
        }
      }),
    );
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (failures.length > 0) {
    throw failures[0];
  }
}

function normalizeRoute(route: Route): Route {
  const channel = route.channel.trim();
  const to = route.to.trim();
  if (!channel || !to) {
    throw new Error("A route needs a channel and a destination");
  }
  return { channel, to };
}

type RouteStore = {
  get: (conversationId: string) => Promise<Route | undefined>;
  remember: (conversationId: string, route: Route) => Promise<void>;
};

function createRouteStore(state: CapsuleState): RouteStore {
  // Conversation IDs are opaque; a Map keeps IDs such as "__proto__" or "constructor" ordinary keys.
  let loaded: Promise<Map<string, Route>> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const load = (): Promise<Map<string, Route>> => {
    loaded ??= state.read(ROUTES_KEY).then((text) => parseRoutes(text));
    return loaded;
  };

  return {
    async get(conversationId) {
      return (await load()).get(conversationId);
    },
    async remember(conversationId, route) {
      const routes = await load();
      const current = routes.get(conversationId);
      if (current?.channel === route.channel && current.to === route.to) {
        return;
      }
      routes.set(conversationId, route);
      // Object.fromEntries and JSON.parse both define own properties, so "__proto__" round-trips as data.
      const snapshot = `${JSON.stringify(Object.fromEntries(routes), null, 2)}\n`;
      const write = writes.then(() => state.write(ROUTES_KEY, snapshot));
      writes = write.catch(() => undefined);
      await write;
    },
  };
}

function parseRoutes(text: string | undefined): Map<string, Route> {
  const routes = new Map<string, Route>();
  if (!text?.trim()) {
    return routes;
  }
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${ROUTES_KEY} must be a mapping`);
  }
  for (const [conversationId, value] of Object.entries(raw)) {
    const route = value as Partial<Route> | null;
    if (typeof route?.channel === "string" && typeof route.to === "string") {
      routes.set(conversationId, { channel: route.channel, to: route.to });
    }
  }
  return routes;
}
