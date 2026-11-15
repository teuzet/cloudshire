import type { Notifier, OutboundMessage } from '../../ports/notifier.js';

/** Почтовый ящик в памяти: dev-клиент забирает из него вести. */
export class MemoryNotifier implements Notifier {
  private readonly boxes = new Map<string, OutboundMessage[]>();

  async send(message: OutboundMessage): Promise<void> {
    const box = this.boxes.get(message.ownerId) ?? [];
    box.push(message);
    this.boxes.set(message.ownerId, box);
  }

  /** Сколько вестей ждёт в ящике, не забирая их. */
  pending(ownerId: string): number {
    return this.boxes.get(ownerId)?.length ?? 0;
  }

  drain(ownerId: string): OutboundMessage[] {
    const box = this.boxes.get(ownerId) ?? [];
    this.boxes.delete(ownerId);
    return box;
  }
}
