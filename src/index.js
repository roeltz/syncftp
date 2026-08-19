import process from 'node:process';
import { loadOrCreateConfig } from './config.js';
import { ProgressLogger } from './logger.js';
import { RemoteClient } from './remote-client.js';
import { SyncManager } from './sync-manager.js';
import { startWatcher } from './watcher.js';

async function main() {
  const logger = new ProgressLogger();

  try {
    const { configPath, config } = await loadOrCreateConfig(process.cwd());

    logger.info(`Loaded config from ${configPath}`);
    logger.info(`Protocol: ${config.protocol.toUpperCase()} | Host: ${config.host}:${config.port}`);
    logger.info(`Local: ${config.localBaseDir}`);
    logger.info(`Remote: ${config.remoteBaseDir}`);
    logger.info(`Concurrency: ${config.concurrency} | Debounce: ${config.debounceMs}ms | Retry: ${config.retry.attempts}x`);

    const startupProbe = new RemoteClient(config);
    await startupProbe.connect();
    await startupProbe.close();
    logger.success('Connected to remote server.');

    const syncManager = new SyncManager(config, logger);
    const watcher = startWatcher(config, syncManager, logger);

    logger.info('Watching for file and directory changes. Press Ctrl+C to stop.');

    const shutdown = async () => {
      logger.warn('Shutting down...');
      await watcher.close();
      await syncManager.close();
      logger.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error(error.message || String(error));
    logger.shutdown();
    process.exit(1);
  }
}

main();
