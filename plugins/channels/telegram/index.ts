import { Bot, type Context, type Filter } from "grammy";
import type { Approver, ZingPluginAPI } from "zing";

import { createApprovals } from "./approvals";

export const TELEGRAM_LIMIT = 4096;
export const START_TEXT =
  "直接发消息就行。需要时效或核实的信息时我会去网上查。\n/reset 开启新对话。";

export default function telegram(zing: ZingPluginAPI) {
  zing.registerChannel({
    id: "telegram",
    async start(signal) {
      signal.throwIfAborted();
      const token = zing.requireEnv("TELEGRAM_BOT_TOKEN");
      const allowedUserIds = parseAllowedUserIds(zing.env.TELEGRAM_ALLOWED_USER_IDS);
      const bot = new Bot(token);
      const approvals = createApprovals({
        send: async (chatId, text, buttons) => {
          const keyboard = [buttons.map((button) => ({ text: button.text, callback_data: button.data }))];
          return (await bot.api.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } })).message_id;
        },
        edit: async (chatId, messageId, text) => {
          await bot.api.editMessageText(chatId, messageId, text);
        },
      });
      /** Turns that let go of their update to wait for a tap. The channel ends after they settle. */
      const detached = new Set<Promise<void>>();

      bot.use(async (ctx, next) => {
        if (!isAllowed(ctx, allowedUserIds)) {
          return;
        }
        await next();
      });

      bot.command("start", async (ctx) => {
        await ctx.reply(START_TEXT);
      });

      bot.command("reset", async (ctx) => {
        if (ctx.chat) {
          await zing.host.resetConversation(zing.conversationId("telegram", String(ctx.chat.id)));
        }
        await ctx.reply("已开始新对话。");
      });

      bot.on("callback_query:data", async (ctx) => {
        const chatId = ctx.callbackQuery.message?.chat.id;
        const outcome = chatId === undefined ? "expired" : approvals.answer(ctx.callbackQuery.data, chatId, ctx.from.id);
        if (outcome === "answered") await ctx.answerCallbackQuery();
        else if (outcome === "not-asker") await ctx.answerCallbackQuery({ text: "只有发起这次请求的人能确认。" });
        else await ctx.answerCallbackQuery({ text: "这个确认已失效。" });
      });

      const respond = async (ctx: Filter<Context, "message:text">): Promise<void> => {
        const conversation = zing.conversationId("telegram", String(ctx.chat.id));
        const sender = ctx.from;
        // Without a sender there is nobody to ask, so calls that need approval are declined.
        const approve: Approver | undefined = sender
          ? (request, signal) => approvals.ask(ctx.chat.id, sender.id, request, signal)
          : undefined;
        const stopTyping = keepTyping(ctx);

        try {
          const result = await zing.host.handleMessage({
            conversationId: conversation,
            text: ctx.message.text,
            senderId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
            // Message IDs are stable on redelivery; update IDs may be reused after inactivity.
            requestId: `telegram:${ctx.me.id}:${ctx.chat.id}:${ctx.message.message_id}`,
            ...(approve ? { approve } : {}),
          });
          for (const chunk of splitMessage(result.text || "(empty response)")) {
            await ctx.reply(chunk);
          }
        } catch (error) {
          console.error("agent run failed", { conversationId: conversation, error });
          await ctx.reply("调用失败，请稍后再试。").catch(() => undefined);
        } finally {
          stopTyping();
        }
      };

      bot.on("message:text", async (ctx) => {
        const untilAsking = approvals.untilAsking();
        let replied = false;
        const reply = respond(ctx).finally(() => {
          replied = true;
        });
        // grammY handles one update at a time. While any question waits for a tap, this handler lets go of its
        // update, or the tap could never arrive. That turn is acknowledged before its reply, as during shutdown.
        await Promise.race([reply, untilAsking.asking]);
        untilAsking.dispose();
        if (!replied) {
          detached.add(reply);
          void reply.finally(() => detached.delete(reply));
        }
      });

      let stopping: Promise<void> | undefined;
      const stop = () => {
        // No tap can arrive once polling stops, so open questions are declined and their turns can finish.
        approvals.declineAll();
        stopping ??= bot.stop().catch((error) => console.error("Telegram channel cleanup failed", error));
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        // stop() cancels polling and confirms the offset, but start() drains middleware.
        // Keep replies alive during that drain; this is graceful delivery, not a durable outbox.
        await bot.start({
          onStart: (info) => {
            console.log(`Telegram channel @${info.username} is running`);
          },
        });
      } finally {
        signal.removeEventListener("abort", stop);
        await stopping;
        approvals.declineAll();
        await Promise.allSettled([...detached]);
      }
    },
  });
}

export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  return chunks;
}

export function parseAllowedUserIds(value: string | undefined): ReadonlySet<number> | null {
  const allowed = value?.trim();
  if (!allowed) {
    return null;
  }
  return new Set(
    allowed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10))
      .filter((id) => Number.isInteger(id)),
  );
}

function isAllowed(ctx: Context, allowedUserIds: ReadonlySet<number> | null): boolean {
  if (allowedUserIds === null) {
    return true;
  }
  const userId = ctx.from?.id;
  return userId !== undefined && allowedUserIds.has(userId);
}

function keepTyping(ctx: Context): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped || !ctx.chat) {
      return;
    }
    try {
      await ctx.replyWithChatAction("typing");
    } catch {
      // The user may have left; keep waiting for the model call either way.
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 4000);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
