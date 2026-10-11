import { Bot, type Context } from "grammy";
import type { ZingPluginAPI } from "zing";

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

      bot.on("message:text", async (ctx) => {
        const conversation = zing.conversationId("telegram", String(ctx.chat.id));
        const stopTyping = keepTyping(ctx);

        try {
          const result = await zing.host.handleMessage({
            conversationId: conversation,
            text: ctx.message.text,
            senderId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
          });
          for (const chunk of splitMessage(result.text || "(empty response)")) {
            await ctx.reply(chunk);
          }
        } catch (error) {
          console.error("agent run failed", { conversationId: conversation, error });
          if (!signal.aborted) {
            await ctx.reply("调用失败，请稍后再试。");
          }
        } finally {
          stopTyping();
        }
      });

      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= bot.stop().catch((error) => console.error("Telegram channel cleanup failed", error));
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        await bot.start({
          onStart: (info) => {
            console.log(`Telegram channel @${info.username} is running`);
          },
        });
      } finally {
        signal.removeEventListener("abort", stop);
        await stopping;
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

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
