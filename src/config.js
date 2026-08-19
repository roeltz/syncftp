import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DEFAULTS = {
  protocol: 'sftp',
  port: undefined,
  localBaseDir: '.',
  remoteBaseDir: '/',
  concurrency: 6,
  debounceMs: 400,
  retry: {
    attempts: 3,
    delayMs: 500
  },
  ignore: ['**/.git/**', '**/node_modules/**'],
  sftp: {
    privateKeyPath: '',
    passphrase: ''
  },
  ftp: {
    secure: false,
    secureMode: 'explicit',
    serverName: '',
    secureOptions: {}
  }
};

function mergeConfig(input) {
  return {
    ...DEFAULTS,
    ...input,
    retry: {
      ...DEFAULTS.retry,
      ...(input.retry || {})
    },
    sftp: {
      ...DEFAULTS.sftp,
      ...(input.sftp || {})
    },
    ftp: {
      ...DEFAULTS.ftp,
      ...(input.ftp || {})
    }
  };
}

function normalizeIgnorePatterns(ignoreInput) {
  const source = Array.isArray(ignoreInput) ? ignoreInput : DEFAULTS.ignore;
  const normalized = [];
  const seen = new Set();

  const pushUnique = (value) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    normalized.push(value);
  };

  for (const rawPattern of source) {
    if (typeof rawPattern !== 'string') {
      continue;
    }

    const pattern = rawPattern.trim().replace(/\\+/g, '/');
    if (!pattern) {
      continue;
    }

    pushUnique(pattern);

    if (pattern.endsWith('/**')) {
      const withoutRecursive = pattern.slice(0, -3).replace(/\/$/, '');
      pushUnique(withoutRecursive);
    }
  }

  return normalized;
}

function normalizeAndValidate(configPath, raw) {
  const cfg = mergeConfig(raw);

  if (!['ftp', 'ftps', 'sftp'].includes(cfg.protocol)) {
    throw new Error('Invalid protocol. Use ftp, ftps, or sftp.');
  }

  if (!cfg.host || !cfg.username) {
    throw new Error('Missing required fields: host and username.');
  }

  if (cfg.protocol === 'ftps' && !['explicit', 'implicit'].includes(cfg.ftp?.secureMode || 'explicit')) {
    throw new Error('Invalid ftp.secureMode. Use "explicit" or "implicit" for FTPS.');
  }

  if (!cfg.password && !cfg.sftp?.privateKeyPath && cfg.protocol === 'sftp') {
    throw new Error('For sftp, provide password or sftp.privateKeyPath.');
  }

  const baseDir = path.dirname(configPath);
  const localBaseDir = path.resolve(baseDir, cfg.localBaseDir);

  const defaultPort = cfg.protocol === 'sftp' ? 22 : 21;

  return {
    ...cfg,
    port: cfg.port || defaultPort,
    localBaseDir,
    retry: {
      attempts: Math.max(1, Number(cfg.retry.attempts) || 3),
      delayMs: Math.max(100, Number(cfg.retry.delayMs) || 500)
    },
    concurrency: Math.max(1, Number(cfg.concurrency) || 6),
    ignore: normalizeIgnorePatterns(cfg.ignore),
    debounceMs: Math.max(50, Number(cfg.debounceMs) || 400)
  };
}

async function findConfigPath(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, '.sync.json');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue walking upward.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function askWithDefault(rl, label, defaultValue) {
  const answer = await rl.question(`${label}${defaultValue !== '' ? ` (${defaultValue})` : ''}: `);
  return answer.trim() || defaultValue;
}

async function createConfigInCurrentDir(cwd) {
  const rl = createInterface({ input, output });
  try {
    output.write('No .sync.json file was found in current or parent directories.\n');
    output.write(`Creating a new .sync.json in ${cwd}\n\n`);

    const protocol = (await askWithDefault(rl, 'Protocol (sftp/ftp/ftps)', 'sftp')).toLowerCase();
    const host = await askWithDefault(rl, 'Host', '');
    const portDefault = protocol === 'sftp' ? '22' : '21';
    const port = Number(await askWithDefault(rl, 'Port', portDefault));
    const username = await askWithDefault(rl, 'Username', '');
    const password = await askWithDefault(rl, 'Password', '');
    const remoteBaseDir = await askWithDefault(rl, 'Remote base directory', '/');
    const localBaseDir = await askWithDefault(rl, 'Local base directory', '.');
    const concurrency = Number(await askWithDefault(rl, 'Parallel uploads', '6'));
    const debounceMs = Number(await askWithDefault(rl, 'Debounce milliseconds', '400'));
    const retryAttempts = Number(await askWithDefault(rl, 'Retry attempts', '3'));
    const retryDelayMs = Number(await askWithDefault(rl, 'Retry delay milliseconds', '500'));

    const cfg = {
      protocol,
      host,
      port,
      username,
      password,
      remoteBaseDir,
      localBaseDir,
      concurrency,
      debounceMs,
      retry: {
        attempts: retryAttempts,
        delayMs: retryDelayMs
      },
      ignore: ['**/.git/**', '**/node_modules/**'],
      sftp: {
        privateKeyPath: '',
        passphrase: ''
      },
      ftp: {
        secure: protocol === 'ftps',
        secureMode: 'explicit',
        serverName: '',
        secureOptions: {}
      }
    };

    const configPath = path.join(cwd, '.sync.json');
    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    output.write(`\nCreated ${configPath}\n`);
    return configPath;
  } finally {
    rl.close();
  }
}

export async function loadConfig(cwd = process.cwd()) {
  const configPath = await findConfigPath(cwd);
  if (!configPath) {
    throw new Error('Could not find .sync.json in current or parent directories.');
  }
  let content;

  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new Error('Could not find .sync.json in the current directory.');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in .sync.json: ${error.message}`);
  }

  const config = normalizeAndValidate(configPath, parsed);

  if (config.protocol === 'sftp' && config.sftp.privateKeyPath) {
    const privateKeyPath = path.resolve(path.dirname(configPath), config.sftp.privateKeyPath);
    config.sftp.privateKey = await fs.readFile(privateKeyPath);
  }

  return {
    configPath,
    config
  };
}

export async function loadOrCreateConfig(cwd = process.cwd()) {
  let configPath = await findConfigPath(cwd);
  if (!configPath) {
    configPath = await createConfigInCurrentDir(cwd);
  }

  return loadConfig(path.dirname(configPath));
}
