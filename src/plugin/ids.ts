export function conversationId(channel: string, localId: string): string {
  return `${channel}:${localId}`;
}
