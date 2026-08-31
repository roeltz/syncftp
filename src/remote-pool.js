import { RemoteClient } from './remote-client.js';

export class RemoteClientPool {
  constructor(config) {
    this.config = config;
    this.maxSize = Math.max(1, Number(config.concurrency) || 1);
    this.available = [];
    this.waiters = [];
    this.created = 0;
    this.closed = false;
  }

  async acquire() {
    if (this.closed) {
      throw new Error('Remote client pool is closed.');
    }

    const ready = this.available.pop();
    if (ready) {
      return ready;
    }

    if (this.created < this.maxSize) {
      this.created += 1;
      const client = new RemoteClient(this.config);
      try {
        await client.connect();
        return client;
      } catch (error) {
        this.created -= 1;
        throw error;
      }
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async release(client, keep = true) {
    if (!client) {
      return;
    }

    if (this.closed || !keep) {
      client.close().catch(() => {});
      if (this.closed) {
        return;
      }

      if (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        try {
          const replacement = new RemoteClient(this.config);
          await replacement.connect();
          waiter.resolve(replacement);
        } catch (error) {
          if (this.created > 0) {
            this.created -= 1;
          }
          waiter.reject?.(error);
        }
        return;
      }

      if (this.created > 0) {
        this.created -= 1;
      }
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(client);
      return;
    }

    this.available.push(client);
  }

  async withClient(action) {
    const client = await this.acquire();
    try {
      const result = await action(client);
      await this.release(client, true);
      return result;
    } catch (error) {
      await this.release(client, false);
      throw error;
    }
  }

  async close() {
    this.closed = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter.reject?.(new Error('Remote client pool is closed.'));
    }

    const clients = this.available.splice(0);
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}