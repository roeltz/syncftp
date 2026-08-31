import chalk from 'chalk';
import path from 'node:path';

const DEFAULT_COLUMNS = 100;
const TICK_INTERVAL_MS = 100;
const RENDER_INTERVAL_MS = 120;
const MAX_BAR_WIDTH = 20;
const QUEUE_STATUS_ID = 'status:queue';

function stripAnsi(input) {
  return String(input).replace(/\u001b\[[0-9;]*m/g, '');
}

function getTerminalColumns() {
  const columns = Number(process.stdout?.columns);
  return Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_COLUMNS;
}

function fitVisible(input, maxWidth) {
  const text = stripAnsi(String(input));
  if (maxWidth <= 0) {
    return '';
  }

  if (text.length <= maxWidth) {
    return text;
  }

  if (maxWidth <= 3) {
    return text.slice(0, maxWidth);
  }

  return `${text.slice(0, maxWidth - 3)}...`;
}

function shortName(input) {
  return input.length > 42 ? `...${input.slice(-39)}` : input;
}

function normalizeUploadId(inputPath) {
  const resolved = path.resolve(inputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const formatted = size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1);
  return `${formatted}${units[unitIndex]}`;
}

function formatMetrics(value, total) {
  const safeTotal = Math.max(total, 1);
  const percent = Math.min(100, Math.floor((value / safeTotal) * 100));
  return `${percent}% ${formatBytes(value)}/${formatBytes(total)}`;
}

function renderBar(value, total, width) {
  const safeTotal = Math.max(total, 1);
  const ratio = Math.max(0, Math.min(1, value / safeTotal));
  const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function resolveTone(status) {
  if (status === 'uploading') {
    return 'blue';
  }
  if (status === 'done') {
    return 'green';
  }
  if (status === 'failed') {
    return 'red';
  }
  return 'yellow';
}

function colorLine(line, status) {
  const tone = resolveTone(status);
  if (tone === 'blue') {
    return chalk.blue(line);
  }
  if (tone === 'green') {
    return chalk.green(line);
  }
  if (tone === 'red') {
    return chalk.red(line);
  }
  return chalk.yellow(line);
}

export class ProgressLogger {
  constructor() {
    this.isTty = Boolean(process.stdout?.isTTY);
    this.items = new Map();
    this.order = [];
    this.lastTickAt = new Map();
    this.renderedLines = 0;
    this.lastRenderAt = 0;
    this.needsRender = false;
    this.stopped = false;
    this.logCounter = 0;

    this.handleResize = () => {
      this.render(true);
    };

    if (this.isTty) {
      process.stdout.write('\u001b[?25l');
      process.stdout.on('resize', this.handleResize);
      this.renderTimer = setInterval(() => {
        this.render();
      }, RENDER_INTERVAL_MS);
      if (typeof this.renderTimer.unref === 'function') {
        this.renderTimer.unref();
      }
    }
  }

  markDirty() {
    this.needsRender = true;
  }

  touchItemOrder(id) {
    const index = this.order.indexOf(id);
    if (index >= 0) {
      this.order.splice(index, 1);
    }
    this.order.push(id);
  }

  upsertItem(id, next) {
    const current = this.items.get(id) || {
      id,
      file: '',
      totalBytes: 1,
      value: 0,
      status: 'pending',
      startedAt: Date.now()
    };

    const merged = {
      ...current,
      ...next,
      totalBytes: Math.max(1, Number(next.totalBytes ?? current.totalBytes) || 1),
      value: Math.max(0, Number(next.value ?? current.value) || 0)
    };

    if (merged.value > merged.totalBytes) {
      merged.value = merged.totalBytes;
    }

    this.items.set(id, merged);
    this.touchItemOrder(id);
    return merged;
  }

  addLogItem(message, status) {
    const id = `log:${Date.now()}:${this.logCounter++}`;
    const text = stripAnsi(message).replace(/\s+/g, ' ').trim();
    this.upsertItem(id, {
      file: text || '(empty message)',
      totalBytes: 1,
      value: 1,
      status
    });
  }

  resolveBarWidth(maxWidth) {
    return Math.max(6, Math.min(MAX_BAR_WIDTH, Math.floor(maxWidth * 0.2)));
  }

  buildFrameLines() {
    const maxWidth = Math.max(20, getTerminalColumns() - 1);
    const barWidth = this.resolveBarWidth(maxWidth);

    const orderedItems = this.order
      .map((id) => this.items.get(id))
      .filter(Boolean);
    const queueStatus = orderedItems.find((item) => item.id === QUEUE_STATUS_ID);
    const visibleItems = orderedItems.filter((item) => item.id !== QUEUE_STATUS_ID);
    if (queueStatus) {
      visibleItems.push(queueStatus);
    }

    return visibleItems
      .map((item) => {
        if (item.id === QUEUE_STATUS_ID) {
          return colorLine(fitVisible(item.file, maxWidth), item.status);
        }
        if (item.presentation === 'deleted') {
          return colorLine(fitVisible(`${item.file} deleted`, maxWidth), item.status);
        }
        const bar = renderBar(item.value, item.totalBytes, barWidth);
        const metrics = formatMetrics(item.value, item.totalBytes);
        const fileLabel = shortName(item.file);
        const plain = `${bar} ${fileLabel} ${metrics} ${item.status}`.trim();
        return colorLine(fitVisible(plain, maxWidth), item.status);
      });
  }

  render(force = false) {
    if (this.stopped || !this.isTty) {
      return;
    }

    const now = Date.now();
    if (!force) {
      if (!this.needsRender) {
        return;
      }
      if (now - this.lastRenderAt < RENDER_INTERVAL_MS) {
        return;
      }
    }

    const frameLines = this.buildFrameLines();
    const moveUp = this.renderedLines > 0 ? `\u001b[${this.renderedLines}A` : '';
    process.stdout.write(`${moveUp}\u001b[0J${frameLines.join('\n')}\n`);
    this.renderedLines = frameLines.length;
    this.lastRenderAt = now;
    this.needsRender = false;
  }

  log(message) {
    this.addLogItem(message, 'info');
    if (!this.isTty) {
      process.stdout.write(`${message}\n`);
      return;
    }
    this.markDirty();
    this.render();
  }

  info(msg) {
    this.addLogItem(`[info] ${msg}`, 'info');
    this.markDirty();
    this.render(true);
    if (!this.isTty) {
      process.stdout.write(`${chalk.blue('[info]')} ${msg}\n`);
    }
  }

  success(msg) {
    this.addLogItem(`[done] ${msg}`, 'done');
    this.markDirty();
    this.render(true);
    if (!this.isTty) {
      process.stdout.write(`${chalk.green('[done]')} ${msg}\n`);
    }
  }

  deleted(msg) {
    const id = `log:${Date.now()}:${this.logCounter++}`;
    this.upsertItem(id, {
      file: msg,
      totalBytes: 1,
      value: 0,
      status: 'done',
      presentation: 'deleted'
    });
    this.markDirty();
    this.render(true);
    if (!this.isTty) {
      process.stdout.write(`${chalk.green(msg)} deleted\n`);
    }
  }

  warn(msg) {
    this.addLogItem(`[warn] ${msg}`, 'warning');
    this.markDirty();
    this.render(true);
    if (!this.isTty) {
      process.stdout.write(`${chalk.yellow('[warn]')} ${msg}\n`);
    }
  }

  error(msg) {
    this.addLogItem(`[error] ${msg}`, 'failed');
    this.markDirty();
    this.render(true);
    if (!this.isTty) {
      process.stdout.write(`${chalk.red('[error]')} ${msg}\n`);
    }
  }

  setQueueSize(count, pendingBytes = 0) {
    const queueSize = Math.max(0, Number(count) || 0);
    const queuedBytes = Math.max(0, Number(pendingBytes) || 0);
    this.upsertItem(QUEUE_STATUS_ID, {
      id: QUEUE_STATUS_ID,
      file: `Queued sync operations: ${queueSize} | Pending file data: ${formatBytes(queuedBytes)}`,
      totalBytes: 1,
      value: 0,
      status: queueSize > 0 ? 'pending' : 'done'
    });
    this.markDirty();
    this.render();
  }

  startUpload(absolutePath, totalBytes) {
    const id = normalizeUploadId(absolutePath);
    const file = shortName(path.basename(absolutePath));
    this.upsertItem(id, {
      id,
      file,
      totalBytes: Math.max(totalBytes, 1),
      value: 0,
      status: 'uploading',
      startedAt: Date.now()
    });
    this.lastTickAt.set(id, 0);
    this.markDirty();
    this.render();
    return id;
  }

  tickUpload(id, value) {
    const normalizedId = normalizeUploadId(id);
    const upload = this.items.get(normalizedId);
    if (!upload) {
      return;
    }

    const now = Date.now();
    const lastTick = this.lastTickAt.get(normalizedId) || 0;
    const isFinalUpdate = value >= upload.totalBytes;
    if (!isFinalUpdate && now - lastTick < TICK_INTERVAL_MS) {
      return;
    }

    this.lastTickAt.set(normalizedId, now);
    this.upsertItem(normalizedId, {
      value: Math.min(value, upload.totalBytes),
      status: 'uploading'
    });
    this.markDirty();
    this.render();
  }

  markUploadRetry(id) {
    const normalizedId = normalizeUploadId(id);
    const upload = this.items.get(normalizedId);
    if (!upload) {
      return;
    }

    this.upsertItem(normalizedId, {
      value: 0,
      status: 'retrying'
    });
    this.markDirty();
    this.render(true);
  }

  markUploadRestarting(id) {
    const normalizedId = normalizeUploadId(id);
    const upload = this.items.get(normalizedId);
    if (!upload) {
      return;
    }

    this.upsertItem(normalizedId, {
      status: 'restarting'
    });
    this.markDirty();
    this.render(true);
  }

  finishUpload(id, totalBytes) {
    const normalizedId = normalizeUploadId(id);
    const upload = this.items.get(normalizedId);
    if (!upload) {
      return;
    }

    const finalTotal = Math.max(totalBytes, 1);
    this.upsertItem(normalizedId, {
      totalBytes: finalTotal,
      value: finalTotal,
      status: 'done'
    });
    this.lastTickAt.delete(normalizedId);
    this.markDirty();
    this.render(true);
  }

  stopUpload(id) {
    const normalizedId = normalizeUploadId(id);
    const upload = this.items.get(normalizedId);
    if (!upload) {
      return;
    }

    this.upsertItem(normalizedId, {
      status: 'failed'
    });
    this.lastTickAt.delete(normalizedId);
    this.markDirty();
    this.render(true);
  }

  shutdown() {
    this.stopped = true;

    if (this.isTty && this.handleResize) {
      process.stdout.off('resize', this.handleResize);
    }

    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }

    if (this.isTty) {
      process.stdout.write(`\u001b[${Math.max(this.renderedLines, 0)}A\u001b[0J`);
      process.stdout.write('\u001b[?25h');
    }

    this.items.clear();
    this.order = [];
    this.lastTickAt.clear();
  }
}
