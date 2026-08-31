import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import pLimit from 'p-limit';
import { RemoteClientPool } from './remote-pool.js';
import { joinRemotePath, normalizeError, sleep, toPosixPath } from './utils.js';

function normalizeFileKey(inputPath) {
  const resolved = path.resolve(inputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class SyncManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.remotePool = new RemoteClientPool(config);

    this.limit = pLimit(config.concurrency);
    this.baseDebounceMs = config.debounceMs;
    this.maxDebounceMs = Math.max(this.baseDebounceMs * 5, 2000);
    this.debounceStepMs = 100;
    this.adaptiveDebounceMs = this.baseDebounceMs;
    this.lastDebounceSampleAt = 0;
    this.debounceTimers = new Map();
    this.pendingTasks = new Map();
    this.activeUploads = new Map();
    this.pendingUnlinks = [];

    this.closed = false;
    this.updateQueueSize();
  }

  getDebounceDelayMs(now = Date.now()) {
    if (this.lastDebounceSampleAt === 0) {
      this.lastDebounceSampleAt = now;
      return this.adaptiveDebounceMs;
    }

    const interval = now - this.lastDebounceSampleAt;
    this.lastDebounceSampleAt = now;

    if (interval < this.adaptiveDebounceMs) {
      this.adaptiveDebounceMs = Math.min(
        this.maxDebounceMs,
        this.adaptiveDebounceMs + this.debounceStepMs
      );
    } else if (interval > this.adaptiveDebounceMs * 2 && this.adaptiveDebounceMs > this.baseDebounceMs) {
      this.adaptiveDebounceMs = Math.max(this.baseDebounceMs, this.adaptiveDebounceMs - this.debounceStepMs);
    }

    return this.adaptiveDebounceMs;
  }

  async withSession(action) {
    return this.remotePool.withClient(action);
  }

  enqueue(eventType, absolutePath, stats) {
    if (this.closed) {
      return;
    }

    const rel = toPosixPath(this.config.localBaseDir, absolutePath);
    if (!rel || rel.startsWith('..')) {
      return;
    }

    const key = `${eventType}:${absolutePath}`;

    if (eventType === 'unlink' || eventType === 'unlinkDir') {
      this.pendingUnlinks.push({
        eventType,
        absolutePath,
        timestamp: Date.now(),
        dir: path.dirname(absolutePath)
      });
      this.prunePendingUnlinks();
    }

    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const delayMs = this.getDebounceDelayMs();

    const timer = setTimeout(() => {
      this.dispatchPendingEvent(key);
    }, delayMs);

    this.debounceTimers.set(key, {
      timer,
      eventType,
      absolutePath,
      stats,
      rel,
      size: this.getPendingEventSize(eventType, stats)
    });
    this.updateQueueSize();
  }

  updateQueueSize() {
    const pendingEvents = [
      ...this.debounceTimers.values(),
      ...this.pendingTasks.values()
    ];
    const pendingBytes = pendingEvents.reduce((total, pendingEvent) => total + pendingEvent.size, 0);
    this.logger.setQueueSize(pendingEvents.length, pendingBytes);
  }

  getPendingEventSize(eventType, stats) {
    if (eventType !== 'add' && eventType !== 'change') {
      return 0;
    }
    return Math.max(0, Number(stats?.size) || 0);
  }

  dispatchPendingEvent(key) {
    const pendingEvent = this.debounceTimers.get(key);
    if (!pendingEvent) {
      return;
    }

    this.debounceTimers.delete(key);
    const task = this.limit(() => this.processEvent(
      pendingEvent.eventType,
      pendingEvent.absolutePath,
      pendingEvent.stats
    ));
    this.pendingTasks.set(task, pendingEvent);
    this.updateQueueSize();
    task.catch((error) => {
      if (error?.message === 'Aborted') {
        return;
      }
      this.logger.error(`Failed to process ${pendingEvent.eventType} ${pendingEvent.rel}: ${normalizeError(error)}`);
    }).finally(() => {
      this.pendingTasks.delete(task);
      this.updateQueueSize();
    });
  }

  prunePendingUnlinks() {
    const cutoff = Date.now() - 1200;
    this.pendingUnlinks = this.pendingUnlinks.filter((item) => item.timestamp >= cutoff);
  }

  consumeRenameCandidate(addEventType, addPath) {
    const expectedUnlinkType = addEventType === 'addDir' ? 'unlinkDir' : 'unlink';
    const now = Date.now();
    const dir = path.dirname(addPath);

    const index = this.pendingUnlinks.findIndex(
      (item) => item.eventType === expectedUnlinkType && item.dir === dir && now - item.timestamp <= 1200
    );

    if (index === -1) {
      return null;
    }

    const [candidate] = this.pendingUnlinks.splice(index, 1);
    return candidate;
  }

  async processEvent(eventType, absolutePath, stats) {
    const rel = toPosixPath(this.config.localBaseDir, absolutePath);
    const remotePath = joinRemotePath(this.config.remoteBaseDir, rel);

    if (eventType === 'add' || eventType === 'change') {
      await this.uploadFile(absolutePath, remotePath);
      return;
    }

    if (eventType === 'unlink') {
      await this.withRetry(`delete ${rel}`, async () => {
        await this.withSession((client) => client.removeFile(remotePath));
      });
      this.logger.deleted(`Remote file ${rel}`);
      return;
    }

    if (eventType === 'addDir') {
      const renameCandidate = this.consumeRenameCandidate(eventType, absolutePath);
      if (renameCandidate) {
        const oldRel = toPosixPath(this.config.localBaseDir, renameCandidate.absolutePath);
        const oldRemotePath = joinRemotePath(this.config.remoteBaseDir, oldRel);
        await this.tryRenameOrCreate('directory', oldRel, oldRemotePath, rel, remotePath);
        return;
      }

      await this.withRetry(`mkdir ${rel}`, async () => {
        await this.withSession((client) => client.ensureDir(remotePath));
      });
      this.logger.success(`Created remote directory ${rel}`);
      return;
    }

    if (eventType === 'unlinkDir') {
      await this.withRetry(`rmdir ${rel}`, async () => {
        await this.withSession((client) => client.removeDir(remotePath));
      });
      this.logger.deleted(`Remote directory ${rel}`);
      return;
    }
  }

  async tryRenameOrCreate(kind, oldRel, oldRemotePath, newRel, newRemotePath) {
    try {
      await this.withRetry(`rename ${kind} ${oldRel} -> ${newRel}`, async () => {
        await this.withSession((client) => client.rename(oldRemotePath, newRemotePath));
      });
      this.logger.success(`Renamed remote ${kind} ${oldRel} -> ${newRel}`);
    } catch {
      if (kind === 'directory') {
        await this.withRetry(`mkdir ${newRel}`, async () => {
          await this.withSession((client) => client.ensureDir(newRemotePath));
        });
        this.logger.warn(`Rename fallback: created remote directory ${newRel}`);
      }
    }
  }

  async uploadFile(absolutePath, remotePath) {
    const fileKey = normalizeFileKey(absolutePath);
    const rel = toPosixPath(this.config.localBaseDir, absolutePath);
    const renameCandidate = this.consumeRenameCandidate('add', absolutePath);

    if (renameCandidate) {
      const oldRel = toPosixPath(this.config.localBaseDir, renameCandidate.absolutePath);
      const oldRemotePath = joinRemotePath(this.config.remoteBaseDir, oldRel);
      try {
        await this.withRetry(`rename file ${oldRel} -> ${rel}`, async () => {
          await this.withSession((client) => client.rename(oldRemotePath, remotePath));
        });
        this.logger.success(`Renamed remote file ${oldRel} -> ${rel}`);
        return;
      } catch {
        this.logger.warn(`Rename fallback: uploading ${rel}`);
      }
    }

    const previous = this.activeUploads.get(fileKey);
    if (previous) {
      previous.controller.abort();
      this.logger.markUploadRestarting(absolutePath);
    }

    const controller = new AbortController();
    this.activeUploads.set(fileKey, { controller });

    const stat = await fsp.stat(absolutePath);
    const totalBytes = stat.size;
    const uploadId = this.logger.startUpload(absolutePath, totalBytes);

    for (let attempt = 1; attempt <= this.config.retry.attempts; attempt += 1) {
      if (attempt > 1) {
        this.logger.markUploadRetry(uploadId);
      }

      let transferred = 0;
      const source = fs.createReadStream(absolutePath);
      const progress = new PassThrough();

      const stopStreams = () => {
        if (!source.destroyed) {
          source.destroy();
        }
        if (!progress.destroyed) {
          progress.destroy();
        }
      };

      const handleAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        stopStreams();
      };

      const handleSourceError = (error) => {
        if (controller.signal.aborted || error?.message === 'Aborted') {
          return;
        }
        handleAbort();
      };

      const handleProgressError = () => {
        // error is handled by the surrounding await and retry path
      };

      source.on('data', (chunk) => {
        transferred += chunk.length;
        this.logger.tickUpload(uploadId, transferred);
      });
      source.once('error', handleSourceError);
      progress.once('error', handleProgressError);
      source.pipe(progress);

      controller.signal.addEventListener('abort', handleAbort, { once: true });

      try {
        await this.withSession((client) => client.uploadFromStream(progress, remotePath, controller.signal));

        if (controller.signal.aborted) {
          throw new Error('Aborted');
        }

        this.logger.finishUpload(uploadId, totalBytes);
        break;
      } catch (error) {
        if (controller.signal.aborted || error.message === 'Aborted') {
          this.logger.markUploadRestarting(uploadId);
          throw new Error('Aborted');
        }

        if (attempt >= this.config.retry.attempts) {
          this.logger.stopUpload(uploadId);
          throw error;
        }

        this.logger.markUploadRetry(uploadId);
        await sleep(this.config.retry.delayMs);
      } finally {
        stopStreams();
        source.removeListener('error', handleSourceError);
        progress.removeListener('error', handleProgressError);
        controller.signal.removeEventListener('abort', handleAbort);
      }
    }

    if (this.activeUploads.get(fileKey)?.controller === controller) {
      this.activeUploads.delete(fileKey);
    }
  }

  async withRetry(label, action) {
    let lastError;
    const attempts = this.config.retry.attempts;

    for (let i = 1; i <= attempts; i += 1) {
      try {
        await action();
        return;
      } catch (error) {
        lastError = error;
        if (error.message === 'Aborted') {
          throw error;
        }
        if (i < attempts) {
          this.logger.warn(`${label} failed (${normalizeError(error)}). Retrying in ${this.config.retry.delayMs}ms...`);
          await sleep(this.config.retry.delayMs);
        }
      }
    }

    throw lastError;
  }

  async close() {
    this.closed = true;
    const pendingKeys = [...this.debounceTimers.keys()];
    for (const key of pendingKeys) {
      const pendingEvent = this.debounceTimers.get(key);
      clearTimeout(pendingEvent.timer);
      this.dispatchPendingEvent(key);
    }

    await Promise.allSettled([...this.pendingTasks.keys()]);
    await this.remotePool.close();
  }
}
