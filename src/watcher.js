import path from 'node:path';
import chokidar from 'chokidar';

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function createIgnoreMatcher(config) {
  const patterns = Array.isArray(config.ignore) ? config.ignore : [];

  return (inputPath) => {
    const absolute = path.resolve(inputPath);
    const absolutePosix = toPosixPath(absolute);
    const relativePosix = toPosixPath(path.relative(config.localBaseDir, absolute));

    return patterns.some((pattern) => {
      if (typeof pattern !== 'string' || !pattern) {
        return false;
      }

      return (
        path.matchesGlob(absolutePosix, pattern) ||
        path.matchesGlob(relativePosix, pattern)
      );
    });
  };
}

export function startWatcher(config, syncManager, logger) {
  const isIgnored = createIgnoreMatcher(config);

  const watcher = chokidar.watch(config.localBaseDir, {
    ignored: (watchedPath) => isIgnored(watchedPath),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 20
    }
  });

  const onFileEvent = (eventType) => async (filePath, stats) => {
    if (isIgnored(filePath)) {
      return;
    }
    syncManager.enqueue(eventType, filePath, stats);
  };

  watcher.on('add', onFileEvent('add'));
  watcher.on('change', onFileEvent('change'));
  watcher.on('unlink', onFileEvent('unlink'));
  watcher.on('addDir', onFileEvent('addDir'));
  watcher.on('unlinkDir', onFileEvent('unlinkDir'));

  watcher.on('error', (error) => {
    logger.error(`Watcher error: ${error.message}`);
  });

  return watcher;
}
