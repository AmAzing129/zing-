import { setTimeout as sleep } from "node:timers/promises";

import { Bot, type Context } from "grammy";
import type { IncomingMessage, ZingPluginAPI } from "zing";

export const TELEGRAM_LIMIT = 4096;
/** Larger images are refused rather than sent to the model; the Bot API serves files up to 20 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_FAILED_TEXT = "I couldn't read that image. Please try again, or send a smaller one.";
/** Registered with Telegram at startup, so typing "/" shows them; each has a handler below. */
export const COMMANDS = [
  { command: "reset", description: "Start a new conversation" },
  { command: "start", description: "Show how to use this bot" },
] as const;
/** Waits before each attempt to register the command menu; a flaky network should not leave it missing. */
export const COMMAND_RETRY_DELAYS_MS = [0, 2_000, 10_000, 60_000];
export const START_TEXT =
  "Just send a message. I'll search the web when you need current or verified information.\nUse /reset to start a new conversation.";

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
        await ctx.reply("Started a new conversation.");
      });

      const answer = async (ctx: Context, text: string, readImage?: () => Promise<ImageInput>) => {
        const chat = ctx.chat!;
        const message = ctx.message!;
        const conversation = zing.conversationId("telegram", String(chat.id));
        const stopTyping = keepTyping(ctx);

        try {
          let images: IncomingMessage["images"];
          if (readImage) {
            try {
              images = [await readImage()];
            } catch (error) {
              console.error(`Telegram image download failed in ${conversation}: ${describeError(error, token)}`);
              await ctx.reply(IMAGE_FAILED_TEXT);
              return;
            }
          }
          const result = await zing.host.handleMessage({
            conversationId: conversation,
            text,
            ...(images ? { images } : {}),
            senderId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
            // Message IDs are stable on redelivery; update IDs may be reused after inactivity.
            requestId: `telegram:${ctx.me.id}:${chat.id}:${message.message_id}`,
          });
          for (const chunk of splitMessage(result.text || "(empty response)")) {
            await ctx.reply(chunk);
          }
        } catch (error) {
          console.error(`agent run failed in ${conversation}: ${describeError(error, token)}`);
          await ctx.reply("The request failed. Please try again later.");
        } finally {
          stopTyping();
        }
      };

      bot.on("message:text", (ctx) => answer(ctx, ctx.message.text));

      // Telegram sends a photo in several sizes, smallest first, and re-encodes it as JPEG.
      bot.on("message:photo", (ctx) => {
        const largest = ctx.message.photo.at(-1)!;
        return answer(ctx, ctx.message.caption ?? "", () => downloadImage(ctx, token, largest.file_id, "image/jpeg", largest.file_size));
      });

      // An image sent as a file keeps its original encoding and resolution.
      bot.on("message:document", (ctx) => {
        const { file_id, mime_type, file_size } = ctx.message.document;
        if (!mime_type?.startsWith("image/")) return;
        return answer(ctx, ctx.message.caption ?? "", () => downloadImage(ctx, token, file_id, mime_type, file_size));
      });

      // The menu is a convenience: register it in the background, so a failure never keeps the bot from answering.
      // Retries end with the channel, whether it was stopped or polling failed on its own.
      const channelDone = new AbortController();
      const menuSignal = AbortSignal.any([signal, channelDone.signal]);
      const registerCommands = async () => {
        let failure: unknown;
        for (const delay of COMMAND_RETRY_DELAYS_MS) {
          try {
            if (delay > 0) await sleep(delay, undefined, { signal: menuSignal });
            if (menuSignal.aborted) return;
            await bot.api.setMyCommands(COMMANDS);
            return;
          } catch (error) {
            if (menuSignal.aborted) return;
            failure = error;
          }
        }
        console.warn(`Telegram command menu registration failed: ${describeError(failure, token)}`);
      };

      let stopping: Promise<void> | undefined;
      const stop = () => {
        stopping ??= bot.stop().catch((error) => console.error(`Telegram channel cleanup failed: ${describeError(error, token)}`));
      };
      signal.addEventListener("abort", stop, { once: true });
      void registerCommands();
      try {
        // stop() cancels polling and confirms the offset, but start() drains middleware.
        // Keep replies alive during that drain; this is graceful delivery, not a durable outbox.
        await bot.start({
          onStart: (info) => {
            console.log(`Telegram channel @${info.username} is running`);
          },
        });
      } finally {
        channelDone.abort();
        signal.removeEventListener("abort", stop);
        await stopping;
      }
    },
  });
}

type ImageInput = NonNullable<IncomingMessage["images"]>[number];

async function downloadImage(
  ctx: Context,
  token: string,
  fileId: string,
  mimeType: string,
  size: number | undefined,
): Promise<ImageInput> {
  if (size !== undefined && size > MAX_IMAGE_BYTES) throw new Error(`Image is ${size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file path");
  // The URL carries the bot token: never log it.
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download failed with status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  return { type: "image", data: bytes.toString("base64"), mimeType };
}

/** grammy's network errors nest the request URL, which carries the bot token: log the message only, redacted. */
export function describeError(error: unknown, token: string): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(token, "<redacted>");
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
