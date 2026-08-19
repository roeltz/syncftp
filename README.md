# syncftp

Keep a local directory synchronized with a remote FTP, FTPS, or SFTP server while you work.

`syncftp` watches for changes and updates the remote server as files and directories are added, edited, moved, or removed. It is designed for fast edit-refresh loops, with parallel uploads, retries, and live terminal progress.

## Requirements

- Node.js 20 or later
- Access to an FTP, FTPS, or SFTP server

## Install

Install the command globally:

```bash
npm install -g syncftp
```

## Quick Start

1. Open a terminal in the local project directory you want to synchronize.
2. Start the watcher:

```bash
syncftp
```

3. On the first run, answer the interactive prompts. `syncftp` creates a `.sync.json` file in the current directory.
4. Keep the command running while you edit files. Press `Ctrl+C` to stop it.

On later runs, `syncftp` searches for `.sync.json` in the current directory and then in each parent directory. This lets one configuration serve a whole project tree.

## Configuration

You may use the interactive setup or create `.sync.json` yourself. Copy `.sync.example.json` from the package repository as a starting point.

```json
{
  "protocol": "sftp",
  "host": "example.com",
  "port": 22,
  "username": "deploy",
  "password": "secret",
  "remoteBaseDir": "/var/www/html",
  "localBaseDir": ".",
  "concurrency": 6,
  "debounceMs": 400,
  "retry": {
    "attempts": 3,
    "delayMs": 500
  },
  "ignore": [
    "**/.git/**",
    "**/node_modules/**",
    "**/.DS_Store"
  ],
  "sftp": {
    "privateKeyPath": "",
    "passphrase": ""
  },
  "ftp": {
    "secure": false,
    "secureMode": "explicit",
    "serverName": "",
    "secureOptions": {}
  }
}
```

### Required Settings

| Setting | Description |
| --- | --- |
| `protocol` | `sftp`, `ftp`, or `ftps`. |
| `host` | Server hostname or IP address. |
| `username` | Login username. |
| `remoteBaseDir` | Remote directory that receives synchronized files. |

For SFTP, provide either `password` or `sftp.privateKeyPath`.

### Paths

`localBaseDir` is resolved relative to the directory containing `.sync.json`. Files below it keep their relative path under `remoteBaseDir`.

For example, with `localBaseDir` set to `.` and `remoteBaseDir` set to `/var/www/html`, a local change to `assets/site.css` updates `/var/www/html/assets/site.css` on the server.

### Performance and Retries

| Setting | Default | Description |
| --- | --- | --- |
| `concurrency` | `6` | Maximum simultaneous remote operations. |
| `debounceMs` | `400` | Delay before a saved file is synchronized. Minimum: `50`. |
| `retry.attempts` | `3` | Number of attempts for a failed operation. Minimum: `1`. |
| `retry.delayMs` | `500` | Fixed delay between retry attempts in milliseconds. Minimum: `100`. |

### Ignored Files

`ignore` is an array of glob patterns. The default configuration excludes Git metadata and dependencies:

```json
"ignore": [
  "**/.git/**",
  "**/node_modules/**"
]
```

Use forward slashes in patterns on every operating system. A pattern ending in `/**` also excludes the directory itself.

## Connection Types

### SFTP

SFTP uses port `22` by default. Password authentication works with `password`. For key authentication, set a path relative to `.sync.json`:

```json
{
  "protocol": "sftp",
  "host": "sftp.example.com",
  "username": "deploy",
  "sftp": {
    "privateKeyPath": "./keys/deploy_key",
    "passphrase": ""
  }
}
```

### FTP

FTP uses port `21` by default:

```json
{
  "protocol": "ftp",
  "host": "ftp.example.com",
  "username": "deploy",
  "password": "secret"
}
```

### FTPS

Use `protocol: "ftps"`. Explicit FTPS is the default; set `ftp.secureMode` to `"implicit"` for an implicit FTPS server.

```json
{
  "protocol": "ftps",
  "host": "ftps.example.com",
  "port": 21,
  "username": "deploy",
  "password": "secret",
  "ftp": {
    "secureMode": "explicit",
    "serverName": "ftps.example.com"
  }
}
```

When connecting to an FTPS server by IP address, set `ftp.serverName` to the DNS name on its certificate. If certificate identity verification fails, `syncftp` asks whether to continue for the current session. Accepting disables certificate identity checks only until the command stops.

## Synchronization Behavior

- New and modified files are uploaded.
- Deleted files are removed from the remote server.
- New directories are created remotely; deleted directories are removed remotely.
- A nearby delete-and-add in the same directory is treated as a rename when possible.
- If a file changes during its upload, the running upload is aborted and restarted with the newest version.
- Failed operations retry with the configured fixed delay.
- Initial files are not uploaded when the watcher starts; only subsequent changes are synchronized.

## Security

`.sync.json` may contain a password or private-key passphrase. Do not commit it to source control or share it. Add `.sync.json` to your project's `.gitignore`:

```gitignore
.sync.json
```

Prefer SFTP key authentication where your server supports it. Treat the FTPS certificate-mismatch override as a temporary diagnostic option, not a normal connection setting.
