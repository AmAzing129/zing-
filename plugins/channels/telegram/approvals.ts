import { randomBytes } from "node:crypto";

import type { ApprovalRequest } from "zing";

const APPROVE = "zing:approve:";
const DECLINE = "zing:decline:";
const MAX_INPUT_CHARS = 1500;

/** The Telegram calls an approval needs, so tests can stand in for the Bot API. */
export type ApprovalTransport = {
  /** Send the question with its two buttons; resolve with the message ID. */
  send: (chatId: number, text: string, buttons: Array<{ text: string; data: string }>) => Promise<number>;
  /** Replace the question's text, which also removes its buttons. */
  edit: (chatId: number, messageId: number, text: string) => Promise<void>;
};

type Pending = { chatId: number; finish: (approved: boolean, note: string) => void };

/** Approvals asked with inline buttons and answered by the button's callback query. */
export function createApprovals(transport: ApprovalTransport) {
  const pending = new Map<string, Pending>();
  /** Questions being sent or waiting for a tap. */
  let open = 0;
  const waiters = new Set<() => void>();

  return {
    /**
     * Resolves once any question is open, at once if one is. Updates are handled one at a time, so a handler that
     * keeps waiting then would hold back the tap that answers it.
     */
    untilAsking(): { asking: Promise<void>; dispose: () => void } {
      let wake!: () => void;
      const asking = new Promise<void>((resolve) => {
        wake = resolve;
      });
      if (open > 0) wake();
      else waiters.add(wake);
      return { asking, dispose: () => waiters.delete(wake) };
    },

    /** Ask in the chat, and wait for a tap. The end of the turn or of the channel declines. */
    async ask(chatId: number, request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return false;
      open += 1;
      for (const wake of [...waiters]) wake();
      waiters.clear();
      try {
        return await question(chatId, request, signal);
      } finally {
        open -= 1;
      }
    },

    /** Apply a tapped button. False when it belongs to no open question in that chat. */
    answer(data: string, chatId: number): boolean {
      const approved = data.startsWith(APPROVE);
      if (!approved && !data.startsWith(DECLINE)) return false;
      const id = data.slice((approved ? APPROVE : DECLINE).length);
      const entry = pending.get(id);
      if (!entry || entry.chatId !== chatId) return false;
      entry.finish(approved, approved ? "已允许。" : "已拒绝。");
      return true;
    },

    /** Decline every open question, as the channel stops. */
    declineAll(): void {
      for (const entry of [...pending.values()]) entry.finish(false, "已失效：机器人正在停止。");
    },
  };

  async function question(chatId: number, request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const id = randomBytes(8).toString("base64url");
    const text = describe(request);
    const messageId = await transport.send(chatId, text, [
      { text: "允许", data: `${APPROVE}${id}` },
      { text: "拒绝", data: `${DECLINE}${id}` },
    ]);
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean, note: string): void => {
        if (!pending.delete(id)) return;
        signal.removeEventListener("abort", expire);
        resolve(approved);
        transport.edit(chatId, messageId, `${text}\n\n${note}`).catch(() => undefined);
      };
      const expire = (): void => finish(false, "已失效：这轮对话已结束。");
      pending.set(id, { chatId, finish });
      signal.addEventListener("abort", expire, { once: true });
      if (signal.aborted) expire();
    });
  }
}

export function describe(request: ApprovalRequest): string {
  let input = JSON.stringify(request.input, null, 2) ?? "{}";
  if (input.length > MAX_INPUT_CHARS) input = `${input.slice(0, MAX_INPUT_CHARS)}\n…`;
  return `需要你确认才会执行：${request.tool}\n\n参数：\n${input}`;
}
