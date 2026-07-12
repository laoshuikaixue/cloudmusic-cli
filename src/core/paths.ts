import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import envPaths from 'env-paths'

const appPaths = envPaths('cloudmusic-cli', { suffix: '' })
const userHash = createHash('sha1').update(homedir()).digest('hex').slice(0, 10)

export const paths = {
  configDir: appPaths.config,
  dataDir: appPaths.data,
  logDir: appPaths.log,
  configFile: join(appPaths.config, 'config.json'),
  authFile: join(appPaths.config, 'auth.json'),
  sessionFile: join(appPaths.data, 'session.json'),
  daemonLog: join(appPaths.log, 'daemon.log'),
  smtcCoverFile: join(appPaths.data, 'smtc-cover.jpg'),
  daemonSocket:
    process.platform === 'win32'
      ? `\\\\.\\pipe\\cloudmusic-cli-${userHash}`
      : join(appPaths.data, 'daemon.sock'),
}

export const createMpvSocketPath = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\cloudmusic-mpv-${process.pid}-${Date.now()}`
    : join(appPaths.data, `mpv-${process.pid}-${Date.now()}.sock`)
