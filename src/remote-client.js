import ftp from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

let ftpsMismatchDecision = null;
let ftpsMismatchPrompt = null;
let ftpsAllowInsecureSession = false;
const FTPS_CONNECT_TIMEOUT_MS = 15000;

function withTlsOptions(config) {
  const secureOptions = {
    ...(config.ftp?.secureOptions || {})
  };

  if (config.protocol === 'ftps' && config.ftp?.serverName && !secureOptions.servername) {
    secureOptions.servername = config.ftp.serverName;
  }

  return secureOptions;
}

function withInsecureTlsOptions(config) {
  return {
    ...withTlsOptions(config),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined
  };
}

function getFtpSecureSetting(config, protocol) {
  if (protocol === 'ftps') {
    return config.ftp?.secureMode === 'implicit' ? 'implicit' : true;
  }
  return config.ftp.secure;
}

async function accessWithTimeout(client, options, timeoutMs) {
  let timeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`FTPS connect/login timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    await Promise.race([client.access(options), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function streamToBuffer(stream, abortSignal) {
  const chunks = [];
  for await (const chunk of stream) {
    if (abortSignal?.aborted) {
      throw new Error('Aborted');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isFtpsHostnameMismatch(error) {
  const message = error?.message || '';
  return message.includes("Hostname/IP does not match certificate's altnames") || message.includes('certificate has expired') === false && message.includes('does not match certificate');
}

function isMissingRemotePathError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'ENOENT' || code === '2' || /no such (file|directory)|not found|does not exist/i.test(message);
}

async function askToContinueOnTlsMismatch(host) {
  const rl = createInterface({ input, output });
  try {
    output.write('\nFTPS certificate verification failed.\n');
    output.write(`The server at ${host} presented a certificate whose name does not match the IP/host you configured.\n`);
    output.write('This means the connection cannot be fully verified for this endpoint.\n');
    output.write('If you continue, this choice will be reused for the rest of this session and certificate identity checking will be disabled for FTPS connections.\n\n');

    const answer = await rl.question('Continue anyway? [y/N]: ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function getFtpsMismatchDecision(host) {
  if (ftpsMismatchDecision !== null) {
    return ftpsMismatchDecision;
  }

  if (!ftpsMismatchPrompt) {
    ftpsMismatchPrompt = askToContinueOnTlsMismatch(host)
      .then((decision) => {
        ftpsMismatchDecision = decision;
        return decision;
      })
      .finally(() => {
        ftpsMismatchPrompt = null;
      });
  }

  return ftpsMismatchPrompt;
}

export class RemoteClient {
  constructor(config) {
    this.config = config;
    this.protocol = config.protocol;
    this.ftpClient = null;
    this.sftpClient = null;
  }

  async connect() {
    if (this.protocol === 'sftp') {
      this.sftpClient = new SftpClient();
      await this.sftpClient.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: this.config.password,
        privateKey: this.config.sftp.privateKey,
        passphrase: this.config.sftp.passphrase || undefined,
        readyTimeout: 10000
      });
      return;
    }

    this.ftpClient = new ftp.Client();
    this.ftpClient.ftp.verbose = false;

    const accessOptions = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.username,
      password: this.config.password,
      secure: getFtpSecureSetting(this.config, this.protocol),
      secureOptions: withTlsOptions(this.config)
    };

    const insecureAccessOptions = {
      ...accessOptions,
      secureOptions: withInsecureTlsOptions(this.config)
    };

    if (this.protocol === 'ftps' && ftpsAllowInsecureSession) {
      await accessWithTimeout(this.ftpClient, insecureAccessOptions, FTPS_CONNECT_TIMEOUT_MS);
      return;
    }

    try {
      await accessWithTimeout(this.ftpClient, accessOptions, FTPS_CONNECT_TIMEOUT_MS);
    } catch (error) {
      if (this.protocol === 'ftps' && isFtpsHostnameMismatch(error)) {
        const shouldContinue = await getFtpsMismatchDecision(this.config.host);
        if (!shouldContinue) {
          throw new Error('Connection rejected by user after FTPS certificate mismatch.');
        }

        ftpsAllowInsecureSession = true;
        output.write('Continuing with certificate identity checks disabled for this session.\n');
        output.write('Attempting FTPS reconnect...\n');

        this.ftpClient.close();
        this.ftpClient = new ftp.Client();
        this.ftpClient.ftp.verbose = false;

        await accessWithTimeout(this.ftpClient, insecureAccessOptions, FTPS_CONNECT_TIMEOUT_MS);
        output.write('FTPS reconnect succeeded.\n');
        return;
      }

      throw error;
    }
  }

  async ensureDir(remoteDir) {
    if (this.protocol === 'sftp') {
      await this.sftpClient.mkdir(remoteDir, true);
      return;
    }
    await this.ftpClient.ensureDir(remoteDir);
    await this.ftpClient.cd('/');
  }

  async uploadFromStream(stream, remotePath, abortSignal) {
    const remoteDir = remotePath.split('/').slice(0, -1).join('/') || '/';
    await this.ensureDir(remoteDir);

    if (this.protocol === 'sftp') {
      const buffer = await streamToBuffer(stream, abortSignal);
      if (abortSignal?.aborted) {
        throw new Error('Aborted');
      }
      await this.sftpClient.put(buffer, remotePath);
      return;
    }

    if (abortSignal?.aborted) {
      throw new Error('Aborted');
    }
    await this.ftpClient.uploadFrom(stream, remotePath);
  }

  async removeFile(remotePath) {
    try {
      if (this.protocol === 'sftp') {
        await this.sftpClient.delete(remotePath);
      } else {
        await this.ftpClient.remove(remotePath);
      }
    } catch (error) {
      if (!isMissingRemotePathError(error)) {
        throw error;
      }
    }
  }

  async removeDir(remotePath) {
    try {
      if (this.protocol === 'sftp') {
        await this.sftpClient.rmdir(remotePath, true);
      } else {
        await this.ftpClient.removeDir(remotePath);
      }
    } catch (error) {
      if (!isMissingRemotePathError(error)) {
        throw error;
      }
    }
  }

  async rename(oldRemotePath, newRemotePath) {
    const newDir = newRemotePath.split('/').slice(0, -1).join('/') || '/';
    await this.ensureDir(newDir);
    if (this.protocol === 'sftp') {
      await this.sftpClient.rename(oldRemotePath, newRemotePath);
    } else {
      await this.ftpClient.rename(oldRemotePath, newRemotePath);
    }
  }

  async close() {
    if (this.sftpClient) {
      await this.sftpClient.end();
      this.sftpClient = null;
    }
    if (this.ftpClient) {
      this.ftpClient.close();
      this.ftpClient = null;
    }
  }
}
