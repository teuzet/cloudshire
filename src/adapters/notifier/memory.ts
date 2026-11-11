import type { Notifier, OutboundMessage } from '../../ports/notifier.js';

/** Почтовый ящик в памяти: dev-клиент забирает из него вести. */
export class MemoryNotifier implements Notifier {
  private readonly boxes = new Map<string, OutboundMessage[]>();

  async send(message: OutboundMessage): Promise<void> {
    const box = this.boxes.get(message.ownerId) ?? [];
    box.push(message);
    this.boxes.set(message.ownerId, box);
  }

  drain(ownerId: string): OutboundMessage[] {
    const box = this.boxes.get(ownerId) ?? [];
    this.boxes.delete(ownerId);
    return box;
  }
}
