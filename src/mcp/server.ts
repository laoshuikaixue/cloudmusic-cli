import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ensureDaemon, requestDaemonResilient } from '../ipc/client.js'
import type { AppConfig } from '../core/types.js'

const tools = [
  {
    name: 'search_songs',
    description: '搜索网易云歌曲，返回可用于播放的歌曲 ID。',
    inputSchema: {
      type: 'object',
      properties: { keywords: { type: 'string' }, limit: { type: 'number', default: 10 } },
      required: ['keywords'],
    },
  },
  {
    name: 'play_song',
    description: '播放指定网易云歌曲 ID。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'get_player_status',
    description: '获取当前歌曲、进度、播放状态、音源和队列信息。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'control_playback',
    description: '暂停、恢复、切歌、停止、Seek 或调节音量。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'toggle', 'stop', 'next', 'previous', 'seek', 'volume'],
        },
        value: { type: 'number' },
        relative: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_queue',
    description: '查看、添加、移除或清空播放队列。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'clear'] },
        id: { type: 'number' },
        index: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_lyrics',
    description: '获取当前歌曲或指定歌曲的时间轴歌词。',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
  },
  {
    name: 'get_spectrum_snapshot',
    description: '获取当前播放位置对应的真实 PCM 频谱快照。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_user_playlists',
    description: '获取已登录账号的歌单。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_daily_recommendations',
    description: '获取已登录账号的每日推荐歌曲。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_playlist_tracks',
    description: '获取指定网易云歌单的完整歌曲列表。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'play_playlist',
    description: '用完整歌单替换当前队列，并从指定索引开始播放。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, index: { type: 'number', default: 0 } },
      required: ['id'],
    },
  },
  {
    name: 'play_daily_recommendations',
    description: '播放账号的每日推荐歌曲，可指定起始索引。',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', default: 0 } },
    },
  },
  {
    name: 'personal_fm',
    description: '获取、开始播放私人 FM，或将当前 FM 歌曲移入垃圾桶。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['get', 'play', 'trash'] } },
      required: ['action'],
    },
  },
  {
    name: 'get_play_history',
    description: '获取最近播放历史及实际收听时长。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'play_history',
    description: '将最近播放历史作为队列播放。',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', default: 0 } },
    },
  },
  {
    name: 'get_cloud_music',
    description: '获取登录账号的网易云音乐云盘歌曲和容量信息。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'play_cloud_music',
    description: '将音乐云盘歌曲作为队列播放。',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', default: 0 } },
    },
  },
  {
    name: 'set_playback_mode',
    description: '设置顺序、单曲循环或随机播放模式。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['sequence', 'repeat-one', 'shuffle'] },
      },
      required: ['mode'],
    },
  },
  {
    name: 'configure_player',
    description: '配置音质、解灰、试听、听歌上报开关和 NCBL/legacy 上报方式。',
    inputSchema: {
      type: 'object',
      properties: {
        quality: {
          type: 'string',
          enum: ['standard', 'higher', 'exhigh', 'lossless', 'hires'],
        },
        unblockEnabled: { type: 'boolean' },
        allowTrial: { type: 'boolean' },
        scrobbleEnabled: { type: 'boolean' },
        scrobbleMode: { type: 'string', enum: ['ncbl', 'legacy'] },
      },
    },
  },
  {
    name: 'like_song',
    description: '喜欢或取消喜欢一首歌曲。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, liked: { type: 'boolean', default: true } },
      required: ['id'],
    },
  },
]

const invokeTool = async (name: string, args: Record<string, unknown>) => {
  const request = requestDaemonResilient
  switch (name) {
    case 'search_songs':
      return request('search', args)
    case 'play_song':
      return request('play', args)
    case 'get_player_status':
      return request('status')
    case 'control_playback': {
      const action = String(args.action)
      if (action === 'seek') return request('seek', { value: args.value, relative: args.relative })
      if (action === 'volume') return request('volume', { value: args.value })
      return request(action)
    }
    case 'manage_queue': {
      const action = String(args.action)
      return request(`queue.${action}`, args)
    }
    case 'get_lyrics':
      return request('lyrics', args)
    case 'get_spectrum_snapshot':
      return request('spectrum')
    case 'get_user_playlists':
      return request('library.playlists')
    case 'get_daily_recommendations':
      return request('library.daily')
    case 'get_playlist_tracks':
      return request('library.playlist', args)
    case 'play_playlist':
      return request('library.playlist.play', args)
    case 'play_daily_recommendations':
      return request('library.daily.play', args)
    case 'personal_fm': {
      const action = String(args.action)
      return request(
        action === 'trash'
          ? 'library.fm.trash'
          : action === 'play'
            ? 'library.fm.play'
            : 'library.fm',
      )
    }
    case 'get_play_history':
      return request('library.history')
    case 'play_history':
      return request('library.history.play', args)
    case 'get_cloud_music':
      return request('library.cloud')
    case 'play_cloud_music':
      return request('library.cloud.play', args)
    case 'set_playback_mode':
      return request('mode.set', args)
    case 'configure_player': {
      const current = (await request('config.get')) as AppConfig
      return request('config.set', {
        patch: {
          ...(typeof args.quality === 'string' ? { quality: args.quality } : {}),
          ...(typeof args.allowTrial === 'boolean' ? { allowTrial: args.allowTrial } : {}),
          ...(typeof args.unblockEnabled === 'boolean'
            ? { unblock: { ...current.unblock, enabled: args.unblockEnabled } }
            : {}),
          ...(typeof args.scrobbleEnabled === 'boolean' || typeof args.scrobbleMode === 'string'
            ? {
                scrobble: {
                  ...current.scrobble,
                  ...(typeof args.scrobbleEnabled === 'boolean'
                    ? { enabled: args.scrobbleEnabled }
                    : {}),
                  ...(typeof args.scrobbleMode === 'string' ? { mode: args.scrobbleMode } : {}),
                  configured: true,
                },
              }
            : {}),
        },
      })
    }
    case 'like_song':
      return request('like', args)
    default:
      throw new Error(`未知工具：${name}`)
  }
}

export const runMcpServer = async () => {
  await ensureDaemon()
  const server = new Server(
    { name: 'cloudmusic-cli', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await invokeTool(request.params.name, request.params.arguments || {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }
    }
  })
  await server.connect(new StdioServerTransport())
}
