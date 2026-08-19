import path from 'node:path';
import { Transform } from 'node:stream';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function toPosixPath(localBaseDir, absolutePath) {
  const rel = path.relative(localBaseDir, absolutePath);
  return rel.split(path.sep).join('/');
}

export function joinRemotePath(remoteBaseDir, relativePosixPath) {
  if (!relativePosixPath || relativePosixPath === '.') {
    return remoteBaseDir;
  }
  return `${remoteBaseDir.replace(/\/$/, '')}/${relativePosixPath.replace(/^\//, '')}`;
}

export function normalizeError(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return 'Aborted';
  }
  return error.message || String(error);
}

export function createProgressTransform(onChunk, abortSignal) {
  return new Transform({
    transform(chunk, _enc, cb) {
      if (abortSignal?.aborted) {
        cb(new Error('Aborted'));
        return;
      }
      onChunk(chunk.length);
      cb(null, chunk);
    }
  });
}
