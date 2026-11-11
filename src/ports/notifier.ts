/** Сообщение игроку вне ответа на его реплику: весть жреца, служебное. */
export interface OutboundMessage {
  ownerId: string;
  text: string;
  kind: 'news' | 'system';
  cityId: string | null;
}

export interface Notifier {
  send(message: OutboundMessage): Promise<void>;
}
