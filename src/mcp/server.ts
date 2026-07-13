import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ensureDaemon, requestDaemonResilient } from '../ipc/client.js'
import { VERSION } from '../version.js'
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
    name: 'search_resources',
    description: '搜索网易云歌单、专辑或歌手。',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string' },
        type: { type: 'string', enum: ['playlist', 'album', 'artist'] },
        limit: { type: 'number', default: 10 },
        offset: { type: 'number', default: 0 },
      },
      required: ['keywords', 'type'],
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
    description: '查看、播放、添加、设为下一首、移动、移除或清空播放队列。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'play', 'add', 'next', 'move', 'remove', 'clear'],
        },
        id: { type: 'number' },
        index: { type: 'number' },
        from: { type: 'number' },
        to: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_lyrics',
    description: '获取当前歌曲或指定歌曲的歌词，包含 YRC/QRC/TTML 逐字时间与升级来源。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        upgrade: { type: 'boolean', description: '是否尝试 TTML/QRC 歌词升级，默认 true。' },
      },
    },
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
    name: 'get_user_profile',
    description: '获取当前登录账号或指定网易云用户的公开资料。',
    inputSchema: { type: 'object', properties: { uid: { type: 'number' } } },
  },
  {
    name: 'get_daily_recommendations',
    description: '获取已登录账号的每日推荐歌曲。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_toplists',
    description: '获取网易云官方榜单列表。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'discover_playlists',
    description: '获取推荐歌单、分类歌单或精品歌单。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['recommended', 'category', 'highquality'],
          default: 'recommended',
        },
        cat: { type: 'string', default: '全部' },
        order: { type: 'string', enum: ['hot', 'new'], default: 'hot' },
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        before: { type: 'number', default: 0 },
      },
    },
  },
  {
    name: 'open_toplist',
    description: '获取或播放指定网易云官方榜单。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        index: { type: 'number', default: 0 },
        play: { type: 'boolean', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_new_songs',
    description: '获取或播放新歌速递，地区支持 0 全部、7 华语、96 欧美、8 日本、16 韩国。',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'number', enum: [0, 7, 96, 8, 16], default: 0 },
        index: { type: 'number', default: 0 },
        play: { type: 'boolean', default: false },
      },
    },
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
    name: 'subscribe_playlist',
    description: '收藏或取消收藏指定网易云歌单。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        subscribed: { type: 'boolean', default: true },
      },
      required: ['id'],
    },
  },
  {
    name: 'manage_playlist',
    description: '创建、重命名、删除自建歌单，或添加和移除歌单歌曲。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'rename', 'delete', 'add_tracks', 'remove_tracks'],
        },
        id: { type: 'number' },
        name: { type: 'string' },
        private: { type: 'boolean', default: false },
        trackIds: { type: 'array', items: { type: 'number' } },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_comments',
    description: '获取网易云歌曲或歌单评论。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['song', 'playlist'], default: 'song' },
        id: { type: 'number' },
        limit: { type: 'number', default: 20 },
        offset: { type: 'number', default: 0 },
      },
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
    name: 'heart_mode',
    description: '根据当前歌曲或指定种子歌曲生成网易云心动模式智能队列，并可立即播放。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '可选的种子歌曲 ID' },
        play: { type: 'boolean', default: true },
      },
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
    name: 'get_subscribed_albums',
    description: '获取登录账号收藏的网易云专辑。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'play_album',
    description: '获取或播放指定网易云专辑。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        index: { type: 'number', default: 0 },
        play: { type: 'boolean', default: true },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_followed_artists',
    description: '获取登录账号关注的网易云歌手。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'play_artist_songs',
    description: '获取或播放指定网易云歌手的热门歌曲。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        index: { type: 'number', default: 0 },
        play: { type: 'boolean', default: true },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_listening_record',
    description: '获取网易云账号本周或全部时间的听歌排行。',
    inputSchema: {
      type: 'object',
      properties: { range: { type: 'string', enum: ['week', 'all'], default: 'all' } },
    },
  },
  {
    name: 'play_listening_record',
    description: '将网易云听歌排行作为播放队列。',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['week', 'all'], default: 'all' },
        index: { type: 'number', default: 0 },
      },
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
    case 'search_resources':
      return request(
        args.type === 'playlist'
          ? 'search.playlists'
          : args.type === 'album'
            ? 'search.albums'
            : 'search.artists',
        args,
      )
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
    case 'get_user_profile':
      return request('library.profile', args)
    case 'get_daily_recommendations':
      return request('library.daily')
    case 'get_toplists':
      return request('library.toplists')
    case 'discover_playlists':
      return request(
        args.kind === 'highquality'
          ? 'library.discover.highquality'
          : args.kind === 'category'
            ? 'library.discover.playlists'
            : 'library.discover.recommended',
        args,
      )
    case 'open_toplist':
      return request(args.play === true ? 'library.toplist.play' : 'library.toplist', args)
    case 'get_new_songs':
      return request(args.play === true ? 'library.new.play' : 'library.new', args)
    case 'get_playlist_tracks':
      return request('library.playlist', args)
    case 'subscribe_playlist':
      return request('library.playlist.subscribe', args)
    case 'manage_playlist': {
      const action = String(args.action)
      if (action === 'create') return request('library.playlist.create', args)
      if (action === 'rename') return request('library.playlist.rename', args)
      if (action === 'delete') return request('library.playlist.delete', args)
      return request('library.playlist.tracks', {
        ...args,
        operation: action === 'remove_tracks' ? 'del' : 'add',
      })
    }
    case 'get_comments':
      return request(args.type === 'playlist' ? 'comments.playlist' : 'comments.song', args)
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
    case 'heart_mode':
      return request(args.play === false ? 'library.heart' : 'library.heart.play', args)
    case 'get_play_history':
      return request('library.history')
    case 'play_history':
      return request('library.history.play', args)
    case 'get_cloud_music':
      return request('library.cloud')
    case 'play_cloud_music':
      return request('library.cloud.play', args)
    case 'get_subscribed_albums':
      return request('library.albums')
    case 'play_album':
      return request(args.play === false ? 'library.album' : 'library.album.play', args)
    case 'get_followed_artists':
      return request('library.artists')
    case 'play_artist_songs':
      return request(args.play === false ? 'library.artist' : 'library.artist.play', args)
    case 'get_listening_record':
      return request('library.record', args)
    case 'play_listening_record':
      return request('library.record.play', args)
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
    { name: 'cloudmusic-cli', version: VERSION },
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
