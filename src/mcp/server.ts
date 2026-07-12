import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ensureDaemon, requestDaemon } from '../ipc/client.js'

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
  switch (name) {
    case 'search_songs':
      return requestDaemon('search', args)
    case 'play_song':
      return requestDaemon('play', args)
    case 'get_player_status':
      return requestDaemon('status')
    case 'control_playback': {
      const action = String(args.action)
      if (action === 'seek')
        return requestDaemon('seek', { value: args.value, relative: args.relative })
      if (action === 'volume') return requestDaemon('volume', { value: args.value })
      return requestDaemon(action)
    }
    case 'manage_queue': {
      const action = String(args.action)
      return requestDaemon(`queue.${action}`, args)
    }
    case 'get_lyrics':
      return requestDaemon('lyrics', args)
    case 'get_spectrum_snapshot':
      return requestDaemon('spectrum')
    case 'get_user_playlists':
      return requestDaemon('library.playlists')
    case 'get_daily_recommendations':
      return requestDaemon('library.daily')
    case 'like_song':
      return requestDaemon('like', args)
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
