import { KeyedAsyncQueue } from "openclaw/plugin-sdk";

export class SendQueue {
  private queue = new KeyedAsyncQueue();
  async send(key: string, message: string) {
    return this.queue.run(key, async () => message);
  }
}
