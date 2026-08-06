// 这个入口文件只负责 EchoMusic 宿主侧的桥接：
// 1. 在歌词视图打开时挂载全屏覆盖层。
// 2. 通过 iframe 加载插件内置的播放器页面。
// 3. 在宿主播放器状态、歌词、频谱数据和 iframe 页面之间转发消息。
const LEGACY_PAGE_PATH = '/main/plugin/player-frontend/player'
const FALLBACK_PATH = '/main/home'
const WALLPAPER_WEB_PORT = 17196
const WALLPAPER_WEB_HOST = '127.0.0.1'
const WALLPAPER_MEDIA_CHUNK_BYTES = 2 * 1024 * 1024
const WALLPAPER_STATIC_MAX_BYTES = 4 * 1024 * 1024
const SQLITE_BUSY_TIMEOUT_MS = 5000
const SQLITE_DEPTH_KEY_PREFIX = 'depth:v1:'
const SQLITE_MIGRATIONS = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS depth_cache (
        hash TEXT PRIMARY KEY,
        data_url TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL DEFAULT '',
        ai INTEGER NOT NULL DEFAULT 1,
        timestamp INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_depth_cache_updated_at ON depth_cache(updated_at DESC);`,
  },
]

// 宿主播放器的播放模式顺序，用于 iframe 请求“切换模式”时循环到下一项。
const playModeOrder = ['sequential', 'list', 'random', 'single']

const WALLPAPER_TEXT_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const WALLPAPER_BINARY_MIME_TYPES = {
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

const WALLPAPER_MEDIA_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

// SQLite 句柄可能被宿主或其他运行时关闭，这里统一识别可重试的错误。
function isSqliteHandleClosedError(error) {
  return /database is not open/i.test(String(error || ''))
}

// 统一序列化要写入 kv_store 的 JSON 值；顶层 undefined 退化为 null。
function stringifySqliteJson(value) {
  if (value === undefined) return 'null'
  const json = JSON.stringify(value)
  return typeof json === 'string' ? json : 'null'
}

// 解析 iframe 传来的逻辑存储键，区分通用 KV 和深度缓存。
function parseSqliteStorageKey(key) {
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) throw new Error('存储键为空')
  if (normalizedKey.startsWith(SQLITE_DEPTH_KEY_PREFIX)) {
    const hash = normalizedKey.slice(SQLITE_DEPTH_KEY_PREFIX.length).trim()
    if (!hash) throw new Error('深度缓存键缺少哈希')
    return { kind: 'depth', key: normalizedKey, hash }
  }
  return { kind: 'kv', key: normalizedKey }
}

// 为宿主桥接创建 SQLite 单例仓储，iframe 继续通过 postMessage 访问。
function createPluginSqliteStore(ctx) {
  let dbHandle = null
  let openPromise = null
  let storeClosed = false

  // 按需打开默认 main 库，并执行一次 schema migration。
  const openDatabase = async () => {
    if (storeClosed) throw new Error('插件数据库已关闭')
    if (dbHandle?.ok) return dbHandle
    if (!ctx?.sqlite?.open) throw new Error('宿主未提供 SQLite 能力')
    if (!openPromise) {
      openPromise = ctx.sqlite
        .open({
          busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
          migrations: SQLITE_MIGRATIONS,
        })
        .then(async (db) => {
          if (!db?.ok) throw new Error(`插件数据库打开或迁移失败: ${db?.error || '未知错误'}`)
          if (storeClosed) {
            try {
              await db.close()
            } catch {}
            throw new Error('插件数据库已关闭')
          }
          dbHandle = db
          openPromise = null
          return db
        })
        .catch((error) => {
          dbHandle = null
          openPromise = null
          throw error
        })
    }
    return openPromise
  }

  // 单次 SQL 操作的公共重试层：遇到句柄失效时丢弃旧句柄并重开一次。
  const withDatabaseResult = async (runner) => {
    let db = await openDatabase()
    let result = await runner(db)
    if (result?.ok !== false || !isSqliteHandleClosedError(result.error)) return result
    dbHandle = null
    db = await openDatabase()
    return runner(db)
  }

  // 从 kv_store 读取并解析 JSON。
  const readKvJson = async (key) => {
    const result = await withDatabaseResult((db) =>
      db.get('SELECT value_json FROM kv_store WHERE key = ?', [key]),
    )
    if (!result?.ok) throw new Error(`插件数据库读取 ${key} 失败: ${result?.error || '未知错误'}`)
    if (!result.row) return null
    const valueJson = String(result.row.value_json ?? '')
    try {
      return JSON.parse(valueJson)
    } catch (error) {
      throw new Error(`插件数据库键 ${key} 的 JSON 解析失败: ${error?.message || String(error)}`)
    }
  }

  // 向 kv_store 写入完整 JSON 值。
  const writeKvJson = async (key, value) => {
    const valueJson = stringifySqliteJson(value)
    const updatedAt = Date.now()
    const result = await withDatabaseResult((db) =>
      db.run(
        `INSERT INTO kv_store (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        [key, valueJson, updatedAt],
      ),
    )
    if (!result?.ok) throw new Error(`插件数据库写入 ${key} 失败: ${result?.error || '未知错误'}`)
    return true
  }

  // 删除 kv_store 中的一个逻辑键。
  const deleteKvKey = async (key) => {
    const result = await withDatabaseResult((db) =>
      db.run('DELETE FROM kv_store WHERE key = ?', [key]),
    )
    if (!result?.ok) throw new Error(`插件数据库删除 ${key} 失败: ${result?.error || '未知错误'}`)
    return true
  }

  // 读取结构化深度缓存，并还原成前端原先使用的对象结构。
  const readDepthCache = async (hash) => {
    const result = await withDatabaseResult((db) =>
      db.get(
        `SELECT hash, data_url, width, height, format, ai, timestamp
         FROM depth_cache
         WHERE hash = ?`,
        [hash],
      ),
    )
    if (!result?.ok) throw new Error(`深度缓存读取 ${hash} 失败: ${result?.error || '未知错误'}`)
    if (!result.row) return null
    return {
      hash: String(result.row.hash ?? hash),
      dataUrl: String(result.row.data_url ?? ''),
      width: Math.max(0, Number(result.row.width || 0)),
      height: Math.max(0, Number(result.row.height || 0)),
      format: String(result.row.format ?? ''),
      ai: Number(result.row.ai ?? 1) !== 0,
      timestamp: Number(result.row.timestamp || 0) || 0,
    }
  }

  // 写入结构化深度缓存，避免把大 dataUrl 塞进通用 JSON 表。
  const writeDepthCache = async (hash, payload) => {
    const dataUrl = String(payload?.dataUrl || '').trim()
    if (!dataUrl) throw new Error('深度缓存缺少 dataUrl')
    const width = Math.max(0, Number(payload?.width || 0))
    const height = Math.max(0, Number(payload?.height || 0))
    const format = String(payload?.format || '').trim()
    const ai = payload?.ai === false ? 0 : 1
    const timestamp = Number(payload?.timestamp || Date.now()) || Date.now()
    const updatedAt = Date.now()
    const result = await withDatabaseResult((db) =>
      db.run(
        `INSERT INTO depth_cache (hash, data_url, width, height, format, ai, timestamp, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           data_url = excluded.data_url,
           width = excluded.width,
           height = excluded.height,
           format = excluded.format,
           ai = excluded.ai,
           timestamp = excluded.timestamp,
           updated_at = excluded.updated_at`,
        [hash, dataUrl, width, height, format, ai, timestamp, updatedAt],
      ),
    )
    if (!result?.ok) throw new Error(`深度缓存写入 ${hash} 失败: ${result?.error || '未知错误'}`)
    return true
  }

  // 删除一个深度缓存键。
  const deleteDepthCache = async (hash) => {
    const result = await withDatabaseResult((db) =>
      db.run('DELETE FROM depth_cache WHERE hash = ?', [hash]),
    )
    if (!result?.ok) throw new Error(`深度缓存删除 ${hash} 失败: ${result?.error || '未知错误'}`)
    return true
  }

  // 对外暴露与原桥接协议一致的 get/set/delete 抽象。
  const get = async (key) => {
    const parsed = parseSqliteStorageKey(key)
    return parsed.kind === 'depth' ? readDepthCache(parsed.hash) : readKvJson(parsed.key)
  }

  const set = async (key, value) => {
    const parsed = parseSqliteStorageKey(key)
    if (parsed.kind === 'depth') return writeDepthCache(parsed.hash, value)
    return writeKvJson(parsed.key, value)
  }

  const remove = async (key) => {
    const parsed = parseSqliteStorageKey(key)
    if (parsed.kind === 'depth') return deleteDepthCache(parsed.hash)
    return deleteKvKey(parsed.key)
  }

  // 激活阶段预热数据库，减少 iframe 首次读写时的等待。
  const warmup = async () => {
    await openDatabase()
  }

  // 插件停用时集中关闭同名句柄。
  const close = async () => {
    storeClosed = true
    const pending = openPromise
    const current = dbHandle
    dbHandle = null
    openPromise = null
    if (pending) {
      try {
        await pending
      } catch {}
    }
    if (!current?.ok || typeof current.close !== 'function') return
    const result = await current.close()
    if (!result?.ok) throw new Error(result?.error || '插件数据库关闭失败')
  }

  return {
    get,
    set,
    remove,
    warmup,
    close,
  }
}

// 兼容旧版插件路由：如果用户还停留在旧页面地址，后续会重定向回首页并改用覆盖层。
function isLegacyPluginPlayerPath(path) {
  return String(path || '').startsWith(LEGACY_PAGE_PATH)
}

// 从宿主路由对象中提取当前路径，兼容 fullPath 和 path 两种字段。
function getRoutePath(ctx) {
  const route = ctx?.router?.currentRoute?.value
  return String(route?.fullPath || route?.path || '')
}

// 将插件目录和相对片段拼成宿主文件系统可以识别的插件内路径。
function getPluginFilePath(ctx, ...parts) {
  const root = String(ctx?.descriptor?.directory || '').replace(/[\\/]+$/, '')
  return [root, ...parts].filter(Boolean).join('/')
}

// 统一处理外部字段：空值、null、undefined 和纯空白文本都落到 fallback。
function text(value, fallback = '') {
  const resolved = String(value ?? '').trim()
  return resolved || fallback
}

// 不同来源的歌曲对象字段名不一致，这里提取最适合展示的标题。
function trackTitle(track) {
  return text(track?.title || track?.name || track?.songname, '未知歌曲')
}

// 提取歌手名，优先使用扁平字段，再兼容 artists/singers 数组。
function trackArtist(track) {
  if (typeof track?.artist === 'string' && track.artist.trim()) return track.artist
  if (typeof track?.author === 'string' && track.author.trim()) return track.author
  const names = [
    ...(Array.isArray(track?.artists) ? track.artists : []),
    ...(Array.isArray(track?.singers) ? track.singers : []),
  ]
    .map((item) => item?.name || item)
    .filter(Boolean)
  return names.length ? names.join(' / ') : '未知歌手'
}

// 提取封面地址，兼容宿主、队列和外部命令可能传入的不同字段名。
function trackCover(track) {
  return text(
    track?.coverUrl ||
      track?.cover ||
      track?.picUrl ||
      track?.albumCover ||
      track?.albumImg ||
      track?.img ||
      track?.image ||
      track?.cover_url,
  )
}

// 将宿主歌曲对象压成 iframe 页面需要的稳定结构，避免子页面直接依赖宿主内部字段。
function normalizeSong(song) {
  if (!song) return null
  return {
    id: String(song.id ?? song.trackId ?? song.hash ?? ''),
    hash: String(song.hash ?? song.id ?? ''),
    name: trackTitle(song),
    title: trackTitle(song),
    artist: trackArtist(song),
    cover: trackCover(song),
    coverUrl: trackCover(song),
    album: text(song.album || song.albumName),
    duration: Number(song.duration || 0),
  }
}

// 根据宿主歌词设置选择翻译或罗马音作为副歌词。
function lyricSecondary(ctx, line) {
  const lyricStore = ctx.stores.lyric
  if (!line) return ''
  if (typeof lyricStore.lineSecondaryText === 'function') return lyricStore.lineSecondaryText(line)
  if (lyricStore.showTranslation && line.translated) return line.translated
  if (lyricStore.showRomanization && line.romanized) return line.romanized
  return ''
}

// 归一化逐字歌词时间轴；异常时间会被钳回 0，空文本字符会被丢弃。
function lyricCharacters(line) {
  const characters = Array.isArray(line?.characters) ? line.characters : []
  return characters
    .map((character) => {
      const startTime = Number(character?.startTime ?? 0)
      const endTime = Number(character?.endTime ?? character?.startTime ?? 0)
      return {
        text: String(character?.text ?? ''),
        startTime: Number.isFinite(startTime) ? startTime : 0,
        endTime: Number.isFinite(endTime) ? endTime : 0,
      }
    })
    .filter((character) => character.text)
}

// 将宿主以秒为单位的歌词行转换为 iframe 使用的毫秒结构，并推算当前行持续时间。
function normalizeLyricLine(ctx, line, index, lines) {
  const startMs = Math.max(0, Math.round(Number(line?.time || 0) * 1000))
  const nextStartMs = Math.max(0, Math.round(Number(lines[index + 1]?.time || 0) * 1000))
  return {
    time_ms: startMs,
    text: text(line?.text),
    secondary: lyricSecondary(ctx, line),
    characters: lyricCharacters(line),
    duration_ms: nextStartMs > startMs ? Math.max(400, nextStartMs - startMs) : 4800,
  }
}

function firstHeaderValue(headers, name) {
  const lowerName = String(name || '').toLowerCase()
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === lowerName)
  if (!entry) return ''
  const value = entry[1]
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function arrayBufferToText(buffer) {
  const source = buffer instanceof ArrayBuffer ? buffer : new ArrayBuffer(0)
  try {
    return new TextDecoder('utf-8').decode(source)
  } catch {
    const bytes = new Uint8Array(source)
    let textValue = ''
    for (const byte of bytes) textValue += String.fromCharCode(byte)
    return decodeURIComponent(escape(textValue))
  }
}

function requestJson(request) {
  const textValue = arrayBufferToText(request?.body)
  if (!textValue.trim()) return {}
  return JSON.parse(textValue)
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: {
      'cache-control': 'no-store',
      ...headers,
    },
    body,
  }
}

function textResponse(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return {
    status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
    body,
  }
}

function binaryResponse(body, contentType, headers = {}, status = 200) {
  return {
    status,
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
      ...headers,
    },
    body,
  }
}

function extensionOf(path) {
  const name = String(path || '').split(/[\\/]/).pop() || ''
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function safeDecodePath(path) {
  try {
    return decodeURIComponent(String(path || ''))
  } catch {
    return String(path || '')
  }
}

function normalizeWallpaperStaticPath(requestPath) {
  const decoded = safeDecodePath(requestPath).replace(/\\/g, '/')
  let relativePath = decoded.replace(/^\/+/, '')
  if (relativePath === 'wallpaper-bridge.js') {
    relativePath = 'player-frontend/vendor/wallpaper-bridge.js'
  }
  if (!relativePath.startsWith('player-frontend/')) return ''
  const parts = relativePath.split('/').filter(Boolean)
  if (!parts.length) return ''
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return ''
  return parts.join('/')
}

function contentTypeForPath(path) {
  const extension = extensionOf(path)
  return (
    WALLPAPER_TEXT_MIME_TYPES[extension] ||
    WALLPAPER_BINARY_MIME_TYPES[extension] ||
    'application/octet-stream'
  )
}

function isTextAsset(path) {
  return Object.prototype.hasOwnProperty.call(WALLPAPER_TEXT_MIME_TYPES, extensionOf(path))
}

function wallpaperHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EchoMusic 壁纸模式</title>
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#010304}
#epf-wallpaper-frame{display:block;width:100vw;height:100vh;border:0;background:#010304}
</style>
</head>
<body>
<iframe id="epf-wallpaper-frame" title="EchoMusic 壁纸模式" allow="autoplay; fullscreen"></iframe>
<script src="/player-frontend/vendor/wallpaper-bridge.js"></script>
<script>window.EchoPlayerFrontendWallpaperBridge.start('/player-frontend/index.html?wallpaper=1');</script>
</body>
</html>`
}

function normalizeWallpaperMedia(media) {
  const path = String(media?.path || '').trim()
  if (!path) return null
  const name = String(media?.name || path.split(/[\\/]/).pop() || 'background').slice(0, 160)
  const extension = name.split('.').pop()?.toLowerCase() || path.split('.').pop()?.toLowerCase() || ''
  const mime = String(media?.mime || WALLPAPER_MEDIA_MIME_BY_EXT[extension] || '').trim()
  const type =
    String(media?.type || '').trim() === 'video' || mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('image/')
        ? 'image'
        : ''
  if (!type || !mime || !WALLPAPER_MEDIA_MIME_BY_EXT[extension]) return null
  if (type === 'image' && !mime.startsWith('image/')) return null
  if (type === 'video' && !mime.startsWith('video/')) return null
  return {
    type,
    path,
    name,
    mime,
    size: Math.max(0, Number(media?.size || 0)),
    modifiedAt: Number(media?.modifiedAt || 0) || 0,
  }
}

function parseRangeHeader(rangeHeader, totalSize) {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/i)
  if (!match || !Number.isFinite(totalSize) || totalSize < 0) return null
  let start = match[1] === '' ? NaN : Number(match[1])
  let end = match[2] === '' ? NaN : Number(match[2])
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    start = Math.max(0, totalSize - end)
    end = Math.max(0, totalSize - 1)
  } else {
    if (!Number.isFinite(start)) start = 0
    if (!Number.isFinite(end)) end = Math.max(0, totalSize - 1)
  }
  start = Math.max(0, Math.trunc(start))
  end = Math.min(Math.max(0, totalSize - 1), Math.trunc(end))
  if (start > end || start >= totalSize) return null
  return { start, end }
}

// 取宿主持有当前歌曲的原始对象，收藏/加歌单依赖的 fileId/mixSongId/albumId 等字段只在原始对象里。
function currentRawTrack(ctx) {
  return ctx.player.currentTrack.value || ctx.stores.player.currentTrackSnapshot || null
}

// 把宿主歌单元数据压缩成 iframe 可展示的稳定结构。
function normalizeHostPlaylist(list) {
  const source = list || {}
  const count = Math.max(0, Number(source.count ?? source.songCount ?? 0) || 0)
  return {
    id: String(source.listid ?? source.id ?? ''),
    listid: source.listid ?? source.id ?? null,
    name: String(source.name || source.title || '未命名歌单'),
    count,
    coverUrl: String(source.coverUrl || source.cover || source.picUrl || ''),
    source: Number(source.source ?? 0),
    type: Number(source.type ?? 0),
    isDefault: Boolean(source.isDefault),
    liked: Boolean(source.isDefault || source.type === 1),
  }
}

// 读取收藏状态；未登录或歌单未加载时静默返回 false，不抛错。
function readFavoriteState(ctx) {
  try {
    const playlistStore = ctx.stores.playlist
    const rawTrack = currentRawTrack(ctx)
    if (!rawTrack || typeof playlistStore?.isFavoriteSong !== 'function') return false
    return Boolean(playlistStore.isFavoriteSong(rawTrack))
  } catch (error) {
    console.warn('[PlayerFrontendBridge] 读取收藏状态失败', error)
    return false
  }
}

// 执行 iframe / 壁纸网页发来的宿主动作，统一收敛收藏、歌单和播放队列的写操作。
async function executeHostAction(ctx, action, payload = {}) {
  const playlistStore = ctx.stores.playlist
  const normalizedAction = String(action || '').trim() || 'unknown'
  const rawTrack = currentRawTrack(ctx)

  try {
    if (normalizedAction === 'favorite-status') {
      return {
        favorite: readFavoriteState(ctx),
        hasTrack: Boolean(rawTrack),
      }
    }

    if (normalizedAction === 'favorite' || normalizedAction === 'unfavorite' || normalizedAction === 'toggle-favorite') {
      if (!rawTrack || typeof playlistStore?.addToFavorites !== 'function') {
        return { ok: false, error: '当前没有可操作的歌曲' }
      }
      const wasFavorite = readFavoriteState(ctx)
      const wantFavorite =
        normalizedAction === 'favorite' ? true :
        normalizedAction === 'unfavorite' ? false :
        !wasFavorite
      if (wantFavorite === wasFavorite) {
        return { ok: true, favorite: wantFavorite, changed: false }
      }
      const result = wantFavorite
        ? await playlistStore.addToFavorites(rawTrack)
        : await playlistStore.removeFavoriteSong(rawTrack)
      return { ok: Boolean(result), favorite: wantFavorite && Boolean(result), changed: true }
    }

    if (normalizedAction === 'playlist-list') {
      // 歌单未加载时主动向酷狗拉取一次，保证首次打开对话框能看到用户歌单。
      if (!Array.isArray(playlistStore?.userPlaylists) || playlistStore.userPlaylists.length === 0) {
        if (typeof playlistStore?.fetchUserPlaylists === 'function') {
          await playlistStore.fetchUserPlaylists()
        }
        if (typeof playlistStore?.ensureLikedPlaylistReady === 'function') {
          await playlistStore.ensureLikedPlaylistReady()
        }
      }
      const playlists = Array.isArray(playlistStore?.userPlaylists)
        ? playlistStore.userPlaylists.map(normalizeHostPlaylist).filter((item) => item.id)
        : []
      const queues = (Array.isArray(playlistStore?.playbackQueueList) ? playlistStore.playbackQueueList : [])
        .filter((queue) => String(queue?.id ?? '') !== 'queue:personal-fm')
        .map((queue) => ({
          id: String(queue?.id ?? ''),
          name: String(queue?.title || '播放队列'),
          count: Math.max(0, Number(queue?.songCount ?? queue?.songs?.length ?? 0) || 0),
          coverUrl: String(queue?.coverUrl || ''),
        }))
        .filter((queue) => queue.id)
      return {
        ok: true,
        playlists,
        queues,
        likedListId: String(playlistStore?.likedPlaylistListId ?? playlistStore?.likedPlaylistQueryId ?? ''),
        hasPlaylists: playlists.length > 0,
      }
    }

    if (normalizedAction === 'playlist-add') {
      const listId = String(payload?.listId ?? payload?.id ?? '').trim()
      if (!listId || !rawTrack || typeof playlistStore?.addToPlaylist !== 'function') {
        return { ok: false, error: '缺少歌单或当前歌曲' }
      }
      const result = await playlistStore.addToPlaylist(listId, rawTrack)
      return {
        ok: result === 'added',
        added: result === 'added',
        exists: result === 'exists',
        result,
        error: result === 'failed' ? '添加到歌单失败' : '',
      }
    }

    if (normalizedAction === 'queue-add') {
      if (!rawTrack || typeof playlistStore?.appendToPlaybackQueue !== 'function') {
        return { ok: false, error: '当前没有可操作的歌曲' }
      }
      const queueId = payload?.queueId ? String(payload.queueId) : undefined
      const addedCount = playlistStore.appendToPlaybackQueue?.([rawTrack], queueId ? { queueId } : {}) ?? 0
      return { ok: addedCount > 0, added: addedCount > 0 }
    }

    return { ok: false, error: '未知宿主动作' }
  } catch (error) {
    console.warn('[PlayerFrontendBridge] 宿主动作执行失败', normalizedAction, error)
    return { ok: false, error: error?.message || String(error || '宿主动作执行失败') }
  }
}

function createPlayerBridgeController(ctx, storageBridge, options = {}) {
  const wallpaper = options.wallpaper === true

  const getQueueState = () => {
    const activeQueue =
      ctx.playlist.activeQueue?.value ||
      ctx.playlist.getActiveQueue?.() ||
      ctx.stores.playlist.activeQueue ||
      null
    const songs = Array.isArray(activeQueue?.songs) ? activeQueue.songs : []
    return {
      queueId: activeQueue?.id ?? ctx.stores.playlist.activeQueueId ?? null,
      currentTrackId: activeQueue?.currentTrackId ?? null,
      songs,
    }
  }

  const ensureLyricLoaded = () => {
    const track = ctx.player.currentTrack.value || ctx.stores.player.currentTrackSnapshot
    const hash = String(track?.hash || track?.id || ctx.stores.player.currentTrackId || '').trim()
    if (!hash) return
    if (
      ctx.stores.lyric.loadedHash === hash &&
      (ctx.stores.lyric.lines.length || ctx.stores.lyric.rawLyric)
    ) {
      return
    }
    void ctx.stores.lyric.fetchLyrics?.(hash, {
      preserveCurrent: true,
      track,
      duration: ctx.stores.player.duration ? ctx.stores.player.duration * 1000 : undefined,
      albumAudioId: track?.albumAudioId || track?.mixSongId,
    })
  }

  const buildLyricsPayload = () => {
    const player = ctx.stores.player
    const lyric = ctx.stores.lyric
    const current = normalizeSong(ctx.player.currentTrack.value || player.currentTrackSnapshot)
    const currentId = String(player.currentTrackId ?? current?.id ?? '')
    const hash = String(current?.hash || currentId || '').trim()
    const loadedHash = String(lyric.loadedHash || '').trim()
    const sourceLines = hash && loadedHash === hash && Array.isArray(lyric.lines) ? lyric.lines : []
    const lines = sourceLines
      .map((line, index) => normalizeLyricLine(ctx, line, index, sourceLines))
      .filter((line) => line.text)
    const key = [
      currentId,
      hash,
      loadedHash,
      lines
        .map((line) =>
          [
            line.time_ms,
            line.text,
            line.secondary,
            line.characters
              .map((character) => [character.text, character.startTime, character.endTime].join(','))
              .join(';'),
          ].join(':'),
        )
        .join('|'),
    ].join('::')

    return {
      key,
      track_id: currentId,
      hash,
      lines,
      tips: lyric.isLoading ? '歌词加载中...' : lyric.tips || '',
    }
  }

  const buildPositionPayload = (cause) => {
    const player = ctx.stores.player
    return {
      position_ms: Math.max(0, Math.round(Number(player.currentTime || 0) * 1000)),
      duration_ms: Math.max(0, Math.round(Number(player.duration || 0) * 1000)),
      is_playing: Boolean(player.isPlaying),
      cause: cause || 'tick',
    }
  }

  const buildSnapshot = () => {
    const player = ctx.stores.player
    const lyric = ctx.stores.lyric
    const current = normalizeSong(ctx.player.currentTrack.value || player.currentTrackSnapshot)
    const queueState = getQueueState()
    const queue = queueState.songs.map(normalizeSong).filter(Boolean)
    const currentId = String(player.currentTrackId ?? current?.id ?? '')
    const currentQueueTrackId = String(queueState.currentTrackId ?? currentId)
    const currentQueueIndex = queue.findIndex((song) => String(song.id) === currentQueueTrackId)

    return {
      track: current,
      currentTrackId: currentId,
      currentQueueIndex,
      queue,
      queueId: queueState.queueId,
      favorite: readFavoriteState(ctx),
      isPlaying: Boolean(player.isPlaying),
      currentTime: Number(player.currentTime || 0),
      duration: Number(player.duration || current?.duration || 0),
      volume: Number(player.volume ?? 0.8),
      playMode: String(player.playMode || 'list'),
      lyric: {
        currentIndex: Number(lyric.currentIndex ?? -1),
        tips: lyric.isLoading ? '歌词加载中...' : lyric.tips || '',
      },
    }
  }

  const buildAppearancePayload = () => {
    const settings = ctx.stores.settings || ctx.settings
    let lyricFontFamily = ''
    try {
      if (typeof settings?.buildLyricFontFamily === 'function') {
        lyricFontFamily = settings.buildLyricFontFamily()
      }
    } catch (error) {
      console.warn('[PlayerFrontendBridge] 读取歌词字体失败', error)
    }
    return {
      lyricFontFamily: String(lyricFontFamily || '').trim(),
    }
  }

  const buildHostControlsPayload = () => ({
    platform: String(window.electron?.platform || ''),
    showFullscreenButton:
      !wallpaper && (ctx.stores.settings || ctx.settings)?.showFullscreenButton !== false,
    canShowMiniPlayer: !wallpaper && typeof window.electron?.miniPlayer?.show === 'function',
    wallpaperMode: wallpaper,
  })

  const handleStoragePayload = async (data) => {
    const action = String(data?.action || 'unknown').trim() || 'unknown'
    const key = String(data?.key || '').trim()
    try {
      if (!key) throw new Error('存储键为空')
      let value = null
      if (action === 'get') {
        value = await storageBridge.get(key)
      } else if (action === 'set') {
        await storageBridge.set(key, data.value)
        value = true
      } else if (action === 'delete') {
        await storageBridge.remove(key)
        value = true
      } else {
        throw new Error('未知存储操作')
      }
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: `SQLite 存储 ${action}(${key || 'unknown'}) 失败: ${error?.message || String(error)}`,
      }
    }
  }

  const cyclePlayMode = () => {
    const mode = String(ctx.stores.player.playMode || 'list')
    const index = playModeOrder.indexOf(mode)
    ctx.player.setPlayMode(playModeOrder[(index + 1) % playModeOrder.length])
  }

  const getQueueSongAt = (index) => {
    const normalizedIndex = Number(index)
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) return null
    const queueState = getQueueState()
    const song = queueState.songs[normalizedIndex]
    if (!song?.id && !song?.hash) return null
    return { queueState, song }
  }

  const queueOptions = (queueState) =>
    queueState?.queueId == null ? undefined : { queueId: queueState.queueId }

  const commandSong = (song) => {
    const source = song || {}
    const normalized = normalizeSong(source)
    if (!normalized?.id && !normalized?.hash) return null
    return {
      ...source,
      ...normalized,
      id: String(source.id ?? source.trackId ?? source.hash ?? normalized.id ?? ''),
      hash: text(source.hash || normalized.hash || normalized.id),
      audioUrl: text(source.audioUrl || source.url),
      mixSongId: source.mixSongId ?? source.mixsongid ?? 0,
    }
  }

  const playQueueIndex = async (index) => {
    const target = getQueueSongAt(index)
    if (!target) return
    const { queueState, song } = target
    const trackId = song.id || song.hash
    if (!trackId) return
    await ctx.player.playTrack(trackId, {
      playlist: queueState.songs,
      sourceQueueId: queueState.queueId,
    })
  }

  const playCommandSong = async (song) => {
    const target = commandSong(song)
    if (!target) return
    await ctx.player.playSong(target)
  }

  const playNextCommandSong = async (song) => {
    const target = commandSong(song)
    if (!target) return
    await ctx.player.playNext(target)
  }

  const playNextQueueIndex = async (index) => {
    const target = getQueueSongAt(index)
    if (!target) return
    await ctx.player.playNext(target.song, queueOptions(target.queueState))
  }

  const removeQueueIndex = async (index) => {
    const target = getQueueSongAt(index)
    if (!target) return
    const trackId = target.song.id || target.song.hash
    if (!trackId) return
    await ctx.playlist.remove(trackId, target.queueState.queueId)
  }

  const clearQueue = async () => {
    const queueState = getQueueState()
    await ctx.playlist.clear(queueState.queueId)
  }

  const setPlayMode = (mode) => {
    const normalized = String(mode || '')
    if (!playModeOrder.includes(normalized)) return
    ctx.player.setPlayMode(normalized)
  }

  const executeCommand = async (data, commandOptions = {}) => {
    const locked = wallpaper || commandOptions.wallpaper === true
    const command = String(data?.command || '')
    if (
      locked &&
      (command === 'close' || command === 'mini-player' || command === 'window-control')
    ) {
      return { ok: true, ignored: true }
    }

    if (command === 'toggle-play') await ctx.player.toggle()
    else if (command === 'play') {
      if (!ctx.stores.player.isPlaying) await ctx.player.toggle()
    } else if (command === 'pause') {
      if (ctx.stores.player.isPlaying) await ctx.player.toggle()
    } else if (command === 'prev') await ctx.player.prev()
    else if (command === 'next') await ctx.player.next()
    else if (command === 'seek') ctx.player.seek(Math.max(0, Number(data.value) || 0))
    else if (command === 'volume') {
      ctx.player.setVolume(Math.max(0, Math.min(1, Number(data.value) || 0)))
    } else if (command === 'cycle-mode') cyclePlayMode()
    else if (command === 'play-index') await playQueueIndex(Number(data.index))
    else if (command === 'play-song') await playCommandSong(data.song)
    else if (command === 'queue-play-next-song') await playNextCommandSong(data.song)
    else if (command === 'queue-play-next-index') await playNextQueueIndex(Number(data.index))
    else if (command === 'queue-remove-index') await removeQueueIndex(Number(data.index))
    else if (command === 'queue-clear') await clearQueue()
    else if (command === 'set-mode') setPlayMode(data.mode)
    else if (command === 'close') commandOptions.close?.()
    else if (command === 'mini-player') void window.electron?.miniPlayer?.show?.()
    else if (command === 'window-control') {
      const action = String(data.action || '')
      if (['minimize', 'fullscreen', 'maximize', 'close'].includes(action)) {
        window.electron?.windowControl?.(action)
      }
    }
    return { ok: true, ignored: false }
  }

  return {
    ensureLyricLoaded,
    buildLyricsPayload,
    buildPositionPayload,
    buildSnapshot,
    buildAppearancePayload,
    buildHostControlsPayload,
    handleStoragePayload,
    executeCommand,
    executeHostAction: (action, payload) => executeHostAction(ctx, action, payload),
  }
}

function createWallpaperWebServer(ctx, storageBridge) {
  const bridge = createPlayerBridgeController(ctx, storageBridge, { wallpaper: true })
  const mediaRegistry = new Map()
  let lastSpectrumFrame = {
    bins: [],
    waveform: [],
    rms: 0,
    peak: 0,
    state: 'idle',
  }
  let spectrumDispose = null
  let started = false

  const pluginAssetPath = (relativePath) => getPluginFilePath(ctx, relativePath)

  const readStaticAsset = async (requestPath) => {
    const relativePath = normalizeWallpaperStaticPath(requestPath)
    if (!relativePath) return textResponse('Not Found', 404)
    const absolutePath = pluginAssetPath(relativePath)
    const contentType = contentTypeForPath(relativePath)
    if (isTextAsset(relativePath)) {
      const result = await ctx.fs.readTextFile(absolutePath, {
        maxBytes: WALLPAPER_STATIC_MAX_BYTES,
      })
      if (!result?.ok) return textResponse(result?.error || '文件读取失败', 404)
      if (result.truncated) return textResponse('Static asset is too large', 413)
      return textResponse(result.content || '', 200, contentType)
    }

    const result = await ctx.fs.readFileBytes(absolutePath, {
      maxBytes: WALLPAPER_STATIC_MAX_BYTES,
    })
    if (!result?.ok) return textResponse(result?.error || '文件读取失败', 404)
    if (result.truncated) return textResponse('Static asset is too large', 413)
    return binaryResponse(result.data, contentType)
  }

  const mediaToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  const pruneMediaRegistry = () => {
    const now = Date.now()
    for (const [token, record] of mediaRegistry.entries()) {
      if (now - record.createdAt > 30 * 60 * 1000) mediaRegistry.delete(token)
    }
  }

  const resolveWallpaperMediaUrl = (media) => {
    const normalized = normalizeWallpaperMedia(media)
    if (!normalized) return { ok: false, error: '背景媒体不可用或格式不支持' }
    pruneMediaRegistry()
    const token = mediaToken()
    mediaRegistry.set(token, {
      media: normalized,
      createdAt: Date.now(),
    })
    return {
      ok: true,
      url: `/media/background/${encodeURIComponent(token)}/${encodeURIComponent(normalized.name)}`,
    }
  }

  const resolveMediaSize = async (media) => {
    if (media.size > 0) return media.size
    const result = await ctx.fs.readFileBytes(media.path, {
      offset: 0,
      length: 0,
      maxBytes: 1,
    })
    if (!result?.ok) throw new Error(result?.error || '背景媒体文件不可访问')
    return Math.max(0, Number(result.size || 0))
  }

  const serveRegisteredMedia = async (request) => {
    const match = String(request.path || '').match(/^\/media\/background\/([^/]+)/)
    const token = match ? safeDecodePath(match[1]) : ''
    const record = token ? mediaRegistry.get(token) : null
    if (!record) return textResponse('Media Not Found', 404)

    const media = record.media
    const totalSize = await resolveMediaSize(media)
    const rangeHeader = firstHeaderValue(request.headers, 'range')
    const requestedRange = parseRangeHeader(rangeHeader, totalSize)
    const needsPartial = media.type === 'video' || totalSize > WALLPAPER_MEDIA_CHUNK_BYTES
    let start = requestedRange?.start ?? 0
    let end = requestedRange?.end ?? Math.max(0, totalSize - 1)

    if (needsPartial) {
      end = Math.min(end, start + WALLPAPER_MEDIA_CHUNK_BYTES - 1)
    }

    const status = requestedRange || needsPartial ? 206 : 200
    const length = totalSize <= 0 ? 0 : Math.max(0, end - start + 1)
    const result = await ctx.fs.readFileBytes(media.path, {
      offset: start,
      length,
      maxBytes: Math.max(1, Math.min(length || 1, WALLPAPER_MEDIA_CHUNK_BYTES)),
    })
    if (!result?.ok) return textResponse(result?.error || '背景媒体读取失败', 404)

    const headers = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    }
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${totalSize}`
    return binaryResponse(result.data, media.mime, headers, status)
  }

  const apiResponse = async (request) => {
    const method = String(request.method || 'GET').toUpperCase()
    const path = String(request.path || '')

    if (method === 'GET' && path === '/api/bootstrap') {
      bridge.ensureLyricLoaded()
      return jsonResponse({
        ok: true,
        init: {
          directEnter: true,
          wallpaperMode: true,
          pluginVersion: String(ctx.manifest?.version || ''),
          hostControls: bridge.buildHostControlsPayload(),
          appearance: bridge.buildAppearancePayload(),
        },
        snapshot: bridge.buildSnapshot(),
        lyrics: bridge.buildLyricsPayload(),
        position: bridge.buildPositionPayload('init'),
        spectrum: lastSpectrumFrame,
      })
    }

    if (method === 'GET' && path === '/api/snapshot') {
      bridge.ensureLyricLoaded()
      return jsonResponse({ ok: true, payload: bridge.buildSnapshot() })
    }
    if (method === 'GET' && path === '/api/lyrics') {
      bridge.ensureLyricLoaded()
      return jsonResponse({ ok: true, payload: bridge.buildLyricsPayload() })
    }
    if (method === 'GET' && path === '/api/position') {
      return jsonResponse({ ok: true, payload: bridge.buildPositionPayload('tick') })
    }
    if (method === 'GET' && path === '/api/appearance') {
      return jsonResponse({ ok: true, payload: bridge.buildAppearancePayload() })
    }
    if (method === 'GET' && path === '/api/spectrum') {
      return jsonResponse({ ok: true, payload: lastSpectrumFrame })
    }
    if (method === 'POST' && path === '/api/storage') {
      return jsonResponse(await bridge.handleStoragePayload(requestJson(request)))
    }
    if (method === 'POST' && path === '/api/background-select') {
      return jsonResponse({
        ok: false,
        canceled: true,
        error: '壁纸网页不支持打开主程序文件选择器',
      })
    }
    if (method === 'POST' && path === '/api/background-resolve') {
      const data = requestJson(request)
      return jsonResponse(resolveWallpaperMediaUrl(data.media || {}))
    }
    if (method === 'POST' && path === '/api/command') {
      const data = requestJson(request)
      const result = await bridge.executeCommand(data, { wallpaper: true })
      return jsonResponse(result)
    }
    if (method === 'POST' && path === '/api/host-action') {
      const data = requestJson(request)
      return jsonResponse(await bridge.executeHostAction(data.action, data.payload || {}))
    }

    return textResponse('Not Found', 404)
  }

  const handler = async (request) => {
    try {
      const path = String(request.path || '/')
      if (path === '/' || path === '/wallpaper') {
        return textResponse(wallpaperHtml(), 200, 'text/html; charset=utf-8')
      }
      if (path === '/health') {
        return jsonResponse({
          ok: true,
          mode: 'wallpaper',
          port: WALLPAPER_WEB_PORT,
        })
      }
      if (path.startsWith('/api/')) return apiResponse(request)
      if (path.startsWith('/media/background/')) return serveRegisteredMedia(request)
      if (path.startsWith('/player-frontend/') || path === '/wallpaper-bridge.js') {
        return readStaticAsset(path)
      }
      if (path === '/favicon.ico') return { status: 204, body: '' }
      return textResponse('Not Found', 404)
    } catch (error) {
      console.warn('[PlayerFrontendWallpaper] 请求处理失败', error)
      return textResponse(error?.message || '壁纸服务请求处理失败', 500)
    }
  }

  const start = async () => {
    try {
      spectrumDispose = ctx.audio.spectrum.subscribe(
        { fps: 24, binCount: 64, smoothing: 0.82, scale: 'mel', includeWaveform: true },
        (frame) => {
          lastSpectrumFrame = {
            bins: Array.isArray(frame?.bins) ? frame.bins : [],
            waveform: Array.isArray(frame?.waveform) ? frame.waveform : [],
            rms: Number(frame?.rms || 0),
            peak: Number(frame?.peak || 0),
            state: frame?.state || 'idle',
            timePos: frame?.timePos,
          }
        },
      )
    } catch (error) {
      spectrumDispose = null
      console.warn('[PlayerFrontendWallpaper] 频谱订阅失败', error)
    }

    const result = await ctx.webServer.listen(handler, {
      host: WALLPAPER_WEB_HOST,
      port: WALLPAPER_WEB_PORT,
    })
    if (result?.ok) {
      started = true
      console.info(`[PlayerFrontendWallpaper] 壁纸服务已启动: ${result.url}`)
    } else {
      console.warn('[PlayerFrontendWallpaper] 壁纸服务启动失败', result?.error || '未知错误')
    }
    return result
  }

  const close = () => {
    if (spectrumDispose) spectrumDispose()
    spectrumDispose = null
    mediaRegistry.clear()
    if (started) void ctx.webServer.close()
    started = false
  }

  return { start, close }
}

// 创建真正承载 iframe 的覆盖层组件。组件内部维护宿主状态快照、消息桥和资源清理逻辑。
function createPlayerFrame(ctx, closeOverlay, storageBridge) {
  const { defineComponent, h, ref, onMounted, onBeforeUnmount } = ctx.vue

  return defineComponent({
    name: 'PlayerFrontendBridgeFrame',
    setup() {
      const iframeRef = ref(null)
      const iframeSrc = ref('')
      const loadError = ref('')
      let ready = false
      let disposed = false
      let lastLyricsKey = ''
      let lastSpectrumFrame = null
      let spectrumDispose = null
      let lyricStoreUnsub = null
      let lastLyricStoreKey = ''
      let stopTrackWatch = null
      let stopVolumeWatch = null
      let stopFavoriteWatch = null
      let stopFontWatch = null
      let commandQueue = Promise.resolve()
      // 位置心跳定时器，每 5 秒向 iframe 推送一次当前进度，防止长时间播放后时钟漂移。
      let positionHeartbeatTimer = null

      // 所有发往 iframe 的消息都带上固定 source，子页面据此区分宿主消息和其他窗口消息。
      const postToFrame = (payload) => {
        const target = iframeRef.value?.contentWindow
        if (!target) return
        target.postMessage(
          {
            ...payload,
            source: 'echo-player-frontend-parent',
          },
          '*',
        )
      }

      // 宿主持久化统一收敛到 SQLite 仓储，iframe 仍复用原有请求协议。
      const replyRequest = (requestId, payload) => {
        if (!requestId) return
        postToFrame({
          ...payload,
          requestId,
        })
      }

      // 兼容宿主文件选择返回的不同形态，统一抽取第一个文件。
      const firstSelectedFile = (result) => {
        if (!result || result.canceled) return null
        const list =
          (Array.isArray(result) && result) ||
          result.filePaths ||
          result.files ||
          result.paths ||
          result.value ||
          []
        if (typeof list === 'string') return { path: list }
        if (!Array.isArray(list) || !list.length) return null
        const item = list[0]
        return typeof item === 'string' ? { path: item } : item
      }

      // 从路径或文件元数据推断浏览器可识别的媒体类型。
      const mediaInfoFromFile = (file) => {
        const path = String(file?.path || file?.filePath || file?.fullPath || '').trim()
        if (!path) return null
        const name = String(file?.name || path.split(/[\\/]/).pop() || '').trim()
        const ext = name.split('.').pop()?.toLowerCase() || ''
        const imageMimes = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
        }
        const videoMimes = {
          mp4: 'video/mp4',
          webm: 'video/webm',
          mov: 'video/quicktime',
        }
        const mime = String(file?.mime || file?.type || imageMimes[ext] || videoMimes[ext] || '').trim()
        const type = mime.startsWith('video/') ? 'video' : (mime.startsWith('image/') ? 'image' : '')
        if (!type) return null
        return {
          type,
          path,
          name,
          mime,
          size: Math.max(0, Number(file?.size || 0)),
          modifiedAt: Number(file?.modifiedAt || file?.lastModified || 0) || 0,
        }
      }

      // 将真实文件路径解析成 iframe 可播放 URL；失败时只报错，不改数据库。
      const resolveMediaUrl = async (media) => {
        const path = String(media?.path || '').trim()
        if (!path) return { ok: false, error: '背景媒体路径为空' }
        const result = await ctx.fs.getFileUrl(path)
        if (!result?.ok || !result.url) {
          return { ok: false, error: result?.error || '背景媒体文件不可访问' }
        }
        return { ok: true, url: result.url }
      }

      // 处理 iframe 发来的持久化请求，并转到宿主 SQLite 单例仓储。
      const handleStorageRequest = async (data) => {
        const requestId = data.requestId
        const action = String(data?.action || 'unknown').trim() || 'unknown'
        const key = String(data?.key || '').trim()
        try {
          if (!key) throw new Error('存储键为空')
          let value = null
          if (action === 'get') {
            value = await storageBridge.get(key)
          } else if (action === 'set') {
            await storageBridge.set(key, data.value)
            value = true
          } else if (action === 'delete') {
            await storageBridge.remove(key)
            value = true
          } else {
            throw new Error('未知存储操作')
          }
          replyRequest(requestId, {
            type: 'echo-player-frontend:storage-result',
            ok: true,
            value,
          })
        } catch (error) {
          replyRequest(requestId, {
            type: 'echo-player-frontend:storage-result',
            ok: false,
            error: `SQLite 存储 ${action}(${key || 'unknown'}) 失败: ${error?.message || String(error)}`,
          })
        }
      }

      // 打开宿主文件选择器，并返回只包含路径元数据和临时 URL 的媒体对象。
      const handleBackgroundSelectRequest = async (data) => {
        const requestId = data.requestId
        try {
          const result = await ctx.dialog.selectFiles({
            title: '选择背景媒体',
            filters: [
              {
                name: '图片或视频',
                extensions: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm', 'mov'],
              },
            ],
            properties: ['openFile'],
          })
          const file = firstSelectedFile(result)
          if (!file) {
            replyRequest(requestId, {
              type: 'echo-player-frontend:background-select-result',
              ok: false,
              canceled: true,
            })
            return
          }
          const media = mediaInfoFromFile(file)
          if (!media) throw new Error('请选择支持的图片或视频文件')
          const resolved = await resolveMediaUrl(media)
          if (!resolved.ok) throw new Error(resolved.error)
          replyRequest(requestId, {
            type: 'echo-player-frontend:background-select-result',
            ok: true,
            media,
            url: resolved.url,
          })
        } catch (error) {
          replyRequest(requestId, {
            type: 'echo-player-frontend:background-select-result',
            ok: false,
            error: error?.message || String(error),
          })
        }
      }

      // 重新把数据库中的背景路径解析成 iframe 可用 URL。
      const handleBackgroundResolveRequest = async (data) => {
        const requestId = data.requestId
        try {
          const resolved = await resolveMediaUrl(data.media || {})
          if (!resolved.ok) throw new Error(resolved.error)
          replyRequest(requestId, {
            type: 'echo-player-frontend:background-resolve-result',
            ok: true,
            url: resolved.url,
          })
        } catch (error) {
          replyRequest(requestId, {
            type: 'echo-player-frontend:background-resolve-result',
            ok: false,
            error: error?.message || String(error),
          })
        }
      }

      // 处理 iframe 发来的宿主动作请求（收藏、歌单列表、添加到歌单等），并回传结果。
      const handleHostRequest = async (data) => {
        const requestId = data.requestId
        try {
          const result = await executeHostAction(ctx, data.action, data.payload || {})
          replyRequest(requestId, {
            type: 'echo-player-frontend:host-request-result',
            ok: result?.ok !== false,
            result,
          })
          // 收藏、加歌单等动作完成后补发一次快照，保证 iframe 内状态与宿主一致。
          const action = String(data.action || '')
          if (
            action === 'favorite' ||
            action === 'unfavorite' ||
            action === 'toggle-favorite' ||
            action === 'playlist-add' ||
            action === 'queue-add'
          ) {
            pushSnapshot(true)
            pushPosition('command')
          }
        } catch (error) {
          replyRequest(requestId, {
            type: 'echo-player-frontend:host-request-result',
            ok: false,
            result: {
              ok: false,
              error: error?.message || String(error || '宿主动作执行失败'),
            },
          })
        }
      }

      // 主动队列可能来自响应式 ref、方法或 store 字段，这里统一取出队列 id、当前项和歌曲列表。
      const getQueueState = () => {
        const activeQueue =
          ctx.playlist.activeQueue?.value ||
          ctx.playlist.getActiveQueue?.() ||
          ctx.stores.playlist.activeQueue ||
          null
        const songs = Array.isArray(activeQueue?.songs) ? activeQueue.songs : []
        return {
          queueId: activeQueue?.id ?? ctx.stores.playlist.activeQueueId ?? null,
          currentTrackId: activeQueue?.currentTrackId ?? null,
          songs,
        }
      }

      // 打开覆盖层时确保当前歌曲歌词已加载；已加载同 hash 的歌词则直接复用。
      const ensureLyricLoaded = () => {
        const track = ctx.player.currentTrack.value || ctx.stores.player.currentTrackSnapshot
        const hash = String(
          track?.hash || track?.id || ctx.stores.player.currentTrackId || '',
        ).trim()
        if (!hash) return
        if (
          ctx.stores.lyric.loadedHash === hash &&
          (ctx.stores.lyric.lines.length || ctx.stores.lyric.rawLyric)
        ) {
          return
        }
        void ctx.stores.lyric.fetchLyrics?.(hash, {
          preserveCurrent: true,
          track,
          duration: ctx.stores.player.duration ? ctx.stores.player.duration * 1000 : undefined,
          albumAudioId: track?.albumAudioId || track?.mixSongId,
        })
      }

      // 构造歌词 payload，并生成内容 key，用于避免重复向 iframe 推送相同歌词。
      const buildLyricsPayload = () => {
        const player = ctx.stores.player
        const lyric = ctx.stores.lyric
        const current = normalizeSong(ctx.player.currentTrack.value || player.currentTrackSnapshot)
        const currentId = String(player.currentTrackId ?? current?.id ?? '')
        const hash = String(current?.hash || currentId || '').trim()
        const loadedHash = String(lyric.loadedHash || '').trim()
        const sourceLines =
          hash && loadedHash === hash && Array.isArray(lyric.lines) ? lyric.lines : []
        const lines = sourceLines
          .map((line, index) => normalizeLyricLine(ctx, line, index, sourceLines))
          .filter((line) => line.text)
        const key = [
          currentId,
          hash,
          loadedHash,
          lines
            .map((line) =>
              [
                line.time_ms,
                line.text,
                line.secondary,
                line.characters
                  .map((character) =>
                    [character.text, character.startTime, character.endTime].join(','),
                  )
                  .join(';'),
              ].join(':'),
            )
            .join('|'),
        ].join('::')

        return {
          key,
          track_id: currentId,
          hash,
          lines,
          tips: lyric.isLoading ? '歌词加载中...' : lyric.tips || '',
        }
      }

      // 构造位置 payload，直接读取宿主当前时间（事件驱动，无需锚点外推）。
      const buildPositionPayload = (cause) => {
        const player = ctx.stores.player
        return {
          position_ms: Math.max(0, Math.round(Number(player.currentTime || 0) * 1000)),
          duration_ms: Math.max(0, Math.round(Number(player.duration || 0) * 1000)),
          is_playing: Boolean(player.isPlaying),
          cause: cause || 'tick',
        }
      }

      // 汇总 iframe 首屏和常规刷新所需的完整播放器快照。
      const buildSnapshot = () => {
        const player = ctx.stores.player
        const lyric = ctx.stores.lyric
        const current = normalizeSong(ctx.player.currentTrack.value || player.currentTrackSnapshot)
        const queueState = getQueueState()
        const queue = queueState.songs.map(normalizeSong).filter(Boolean)
        const currentId = String(player.currentTrackId ?? current?.id ?? '')
        const currentQueueTrackId = String(queueState.currentTrackId ?? currentId)
        const currentQueueIndex = queue.findIndex((song) => String(song.id) === currentQueueTrackId)

        return {
          track: current,
          currentTrackId: currentId,
          currentQueueIndex,
          queue,
          queueId: queueState.queueId,
          favorite: readFavoriteState(ctx),
          isPlaying: Boolean(player.isPlaying),
          currentTime: Number(player.currentTime || 0),
          duration: Number(player.duration || current?.duration || 0),
          volume: Number(player.volume ?? 0.8),
          playMode: String(player.playMode || 'list'),
          lyric: {
            currentIndex: Number(lyric.currentIndex ?? -1),
            tips: lyric.isLoading ? '歌词加载中...' : lyric.tips || '',
          },
        }
      }

      // 从主程序设置读取页面歌词字体，iframe 内的舞台歌词始终跟随这个字体族。
      const buildAppearancePayload = () => {
        const settings = ctx.stores.settings || ctx.settings
        let lyricFontFamily = ''
        try {
          if (typeof settings?.buildLyricFontFamily === 'function') {
            lyricFontFamily = settings.buildLyricFontFamily()
          }
        } catch (error) {
          console.warn('[PlayerFrontendBridge] 读取歌词字体失败', error)
        }
        return {
          lyricFontFamily: String(lyricFontFamily || '').trim(),
        }
      }

      // 把宿主窗口能力暴露给 iframe，子页面据此决定是否显示全屏、小窗等按钮。
      const buildHostControlsPayload = () => ({
        platform: String(window.electron?.platform || ''),
        showFullscreenButton:
          (ctx.stores.settings || ctx.settings)?.showFullscreenButton !== false,
        canShowMiniPlayer: typeof window.electron?.miniPlayer?.show === 'function',
      })

      // 推送歌词，仅事件驱动（歌词内容变更时调用），不再定时轮询。
      const pushLyrics = (force = false) => {
        if (!ready && !force) return
        ensureLyricLoaded()
        const payload = buildLyricsPayload()
        if (!force && payload.key === lastLyricsKey) return
        lastLyricsKey = payload.key
        postToFrame({
          type: 'echo-player-frontend:lyrics',
          payload,
        })
      }

      // 事件驱动的位置推送（取代轮询），仅在关键时机或低频心跳时发送。
      const pushPosition = (cause) => {
        if (!ready) return
        postToFrame({
          type: 'echo-player-frontend:position',
          payload: buildPositionPayload(cause),
        })
      }

      // 推送主程序外观设置，例如页面歌词字体。
      const pushAppearance = (force = false) => {
        if (!ready && !force) return
        postToFrame({
          type: 'echo-player-frontend:appearance',
          payload: buildAppearancePayload(),
        })
      }

      // 推送完整快照，仅在曲目切换或命令完成后调用。
      const pushSnapshot = (force = false) => {
        if (!ready && !force) return
        ensureLyricLoaded()
        postToFrame({
          type: 'echo-player-frontend:snapshot',
          payload: buildSnapshot(),
        })
      }

      // 订阅歌词 store，仅在歌词内容（lines/loadedHash）变化时推送给 iframe。
      const initLyricStoreSubscription = () => {
        if (lyricStoreUnsub) return
        const lyricStore = ctx.stores.lyric
        const buildStoreKey = (state) =>
          [
            Array.isArray(state?.lines) ? state.lines.length : 0,
            String(state?.loadedHash || ''),
            Boolean(state?.isLoading) ? '1' : '0',
            String(state?.tips || ''),
          ].join('::')
        lastLyricStoreKey = buildStoreKey(lyricStore)
        if (typeof lyricStore.$subscribe === 'function') {
          lyricStoreUnsub = lyricStore.$subscribe((mutation, state) => {
            const nextKey = buildStoreKey(state)
            if (nextKey === lastLyricStoreKey) return
            lastLyricStoreKey = nextKey
            pushLyrics(false)
          })
        }
      }

      // 监听曲目切换，事件驱动方式推送快照、歌词和位置。
      const initTrackWatch = () => {
        const getTrackId = () => {
          const player = ctx.stores.player
          const current = ctx.player.currentTrack.value || player.currentTrackSnapshot
          return String(current?.id || current?.hash || player.currentTrackId || '')
        }
        let lastId = getTrackId()
        stopTrackWatch = ctx.vue.watch(
          getTrackId,
          (newId) => {
            if (!newId || newId === lastId) return
            lastId = newId
            pushSnapshot(true)
            pushLyrics(true)
            pushPosition('track_change')
          },
        )
      }

      // 监听主程序音量变更，同步推快照更新 iframe 侧音量滑块和音频。
      const initVolumeWatch = () => {
        stopVolumeWatch = ctx.vue.watch(
          () => Number(ctx.stores.player.volume ?? 0.8),
          () => {
            if (!ready || disposed) return
            pushSnapshot(true)
          },
        )
      }

      // 监听收藏列表变更（后台加载完成或从其他入口收藏），同步刷新 iframe 内红心状态。
      const initFavoriteWatch = () => {
        const playlistStore = ctx.stores.playlist
        let lastKey = ''
        const buildKey = () => {
          try {
            const favorites = playlistStore?.favorites
            return Array.isArray(favorites)
              ? favorites.map((song) => String(song?.id ?? song?.hash ?? '')).join(',')
              : ''
          } catch (error) {
            return ''
          }
        }
        lastKey = buildKey()
        stopFavoriteWatch = ctx.vue.watch(
          buildKey,
          (nextKey) => {
            if (!ready || disposed || nextKey === lastKey) return
            lastKey = nextKey
            pushSnapshot(true)
          },
        )
      }

      // 监听主程序字体设置变化，同步刷新 iframe 内 canvas 歌词纹理。
      const initFontWatch = () => {
        if (stopFontWatch) return
        const settings = ctx.stores.settings || ctx.settings
        stopFontWatch = ctx.vue.watch(
          () => [
            String(settings?.lyricFont || ''),
            String(settings?.globalFont || ''),
            buildAppearancePayload().lyricFontFamily,
          ].join('::'),
          () => {
            if (!ready || disposed) return
            pushAppearance(true)
          },
        )
      }

      // 位置心跳：每 5 秒推送一次当前进度，防止 iframe 本地时钟长时间漂移。
      const startPositionHeartbeat = () => {
        clearInterval(positionHeartbeatTimer)
        positionHeartbeatTimer = setInterval(() => {
          if (!ready || disposed) return
          pushPosition('tick')
        }, 5000)
      }

      // 停止位置心跳。
      const stopPositionHeartbeat = () => {
        clearInterval(positionHeartbeatTimer)
        positionHeartbeatTimer = null
      }

      // 按固定顺序循环播放模式，供 iframe 的模式按钮调用。
      const cyclePlayMode = () => {
        const mode = String(ctx.stores.player.playMode || 'list')
        const index = playModeOrder.indexOf(mode)
        ctx.player.setPlayMode(playModeOrder[(index + 1) % playModeOrder.length])
      }

      // 从当前播放队列中安全取出指定索引的歌曲，非法索引或无效歌曲会返回 null。
      const getQueueSongAt = (index) => {
        const normalizedIndex = Number(index)
        if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) return null
        const queueState = getQueueState()
        const song = queueState.songs[normalizedIndex]
        if (!song?.id && !song?.hash) return null
        return { queueState, song }
      }

      // 队列相关命令需要携带 queueId；没有活动队列时让宿主使用默认行为。
      const queueOptions = (queueState) =>
        queueState?.queueId == null ? undefined : { queueId: queueState.queueId }

      // 归一化 iframe 传回的歌曲对象，补齐宿主播放命令依赖的 id/hash/audioUrl 等字段。
      const commandSong = (song) => {
        const source = song || {}
        const normalized = normalizeSong(source)
        if (!normalized?.id && !normalized?.hash) return null
        return {
          ...source,
          ...normalized,
          id: String(source.id ?? source.trackId ?? source.hash ?? normalized.id ?? ''),
          hash: text(source.hash || normalized.hash || normalized.id),
          audioUrl: text(source.audioUrl || source.url),
          mixSongId: source.mixSongId ?? source.mixsongid ?? 0,
        }
      }

      // 按队列索引播放，保留完整队列上下文，确保宿主能继续处理上一首/下一首。
      const playQueueIndex = async (index) => {
        const target = getQueueSongAt(index)
        if (!target) return
        const { queueState, song } = target
        const trackId = song.id || song.hash
        if (!trackId) return
        await ctx.player.playTrack(trackId, {
          playlist: queueState.songs,
          sourceQueueId: queueState.queueId,
        })
      }

      // 播放 iframe 直接传入的歌曲对象。
      const playCommandSong = async (song) => {
        const target = commandSong(song)
        if (!target) return
        await ctx.player.playSong(target)
      }

      // 将 iframe 传入的歌曲插入下一首播放。
      const playNextCommandSong = async (song) => {
        const target = commandSong(song)
        if (!target) return
        await ctx.player.playNext(target)
      }

      // 将当前队列中的某一项插入下一首。
      const playNextQueueIndex = async (index) => {
        const target = getQueueSongAt(index)
        if (!target) return
        await ctx.player.playNext(target.song, queueOptions(target.queueState))
      }

      // 从当前队列移除指定索引的歌曲。
      const removeQueueIndex = async (index) => {
        const target = getQueueSongAt(index)
        if (!target) return
        const trackId = target.song.id || target.song.hash
        if (!trackId) return
        await ctx.playlist.remove(trackId, target.queueState.queueId)
      }

      // 清空当前活动队列。
      const clearQueue = async () => {
        const queueState = getQueueState()
        await ctx.playlist.clear(queueState.queueId)
      }

      // 接收 iframe 指定的播放模式，只有宿主支持的模式会被应用。
      const setPlayMode = (mode) => {
        const normalized = String(mode || '')
        if (!playModeOrder.includes(normalized)) return
        ctx.player.setPlayMode(normalized)
      }

      // iframe 的所有控制请求最终都汇聚到这里，再映射到 EchoMusic 宿主 API。
      const executeCommand = async (data) => {
        if (data.command === 'toggle-play') await ctx.player.toggle()
        else if (data.command === 'play') {
          if (!ctx.stores.player.isPlaying) await ctx.player.toggle()
        } else if (data.command === 'pause') {
          if (ctx.stores.player.isPlaying) await ctx.player.toggle()
        } else if (data.command === 'prev') await ctx.player.prev()
        else if (data.command === 'next') await ctx.player.next()
        else if (data.command === 'seek') ctx.player.seek(Math.max(0, Number(data.value) || 0))
        else if (data.command === 'volume') {
          ctx.player.setVolume(Math.max(0, Math.min(1, Number(data.value) || 0)))
        } else if (data.command === 'cycle-mode') cyclePlayMode()
        else if (data.command === 'play-index') await playQueueIndex(Number(data.index))
        else if (data.command === 'play-song') await playCommandSong(data.song)
        else if (data.command === 'queue-play-next-song') await playNextCommandSong(data.song)
        else if (data.command === 'queue-play-next-index') await playNextQueueIndex(Number(data.index))
        else if (data.command === 'queue-remove-index') await removeQueueIndex(Number(data.index))
        else if (data.command === 'queue-clear') await clearQueue()
        else if (data.command === 'set-mode') setPlayMode(data.mode)
        else if (data.command === 'close') closeOverlay()
        else if (data.command === 'mini-player') void window.electron?.miniPlayer?.show?.()
        else if (data.command === 'window-control') {
          const action = String(data.action || '')
          if (['minimize', 'fullscreen', 'maximize', 'close'].includes(action)) {
            window.electron?.windowControl?.(action)
          }
        }
      }

      // 命令完成或失败后都主动补发状态，确保 iframe 不会停留在乐观 UI 状态。
      const pushCommandResultState = () => {
        if (disposed) return
        pushSnapshot(true)
        pushPosition('command')
      }

      // 用 Promise 队列串行执行 iframe 命令，避免连续点击导致播放、队列操作交叉执行。
      const handleCommand = (data) => {
        commandQueue = commandQueue
          .catch(() => {})
          .then(async () => {
            await executeCommand(data)
            pushCommandResultState()
          })
          .catch((error) => {
            console.warn('[PlayerFrontendBridge] 命令执行失败', error)
            pushCommandResultState()
          })
      }

      // 处理来自 iframe 的握手、命令和主动刷新请求；source 校验用于隔离其他窗口消息。
      const handleMessage = (event) => {
        const data = event?.data
        if (!data || data.source !== 'echo-player-frontend-child') return

        switch (data.type) {
          case 'echo-player-frontend:ready':
            ready = true
            postToFrame({
              type: 'echo-player-frontend:init',
              payload: {
                directEnter: true,
                pluginVersion: String(ctx.manifest?.version || ''),
                hostControls: buildHostControlsPayload(),
                appearance: buildAppearancePayload(),
              },
            })
            pushSnapshot(true)
            pushLyrics(true)
            pushPosition('init')
            if (lastSpectrumFrame) {
              postToFrame({
                type: 'echo-player-frontend:spectrum',
                payload: lastSpectrumFrame,
              })
            }
            break
          case 'echo-player-frontend:command':
            handleCommand(data)
            break
          case 'echo-player-frontend:storage':
            void handleStorageRequest(data)
            break
          case 'echo-player-frontend:host-request':
            void handleHostRequest(data)
            break
          case 'echo-player-frontend:background-select':
            void handleBackgroundSelectRequest(data)
            break
          case 'echo-player-frontend:background-resolve':
            void handleBackgroundResolveRequest(data)
            break
          case 'echo-player-frontend:request-snapshot':
            pushSnapshot(true)
            pushLyrics(true)
            pushAppearance(true)
            pushPosition('init')
            break
        }
      }

      // Escape 始终关闭覆盖层，并阻止事件继续传给底层页面。
      const handleKeydown = (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        closeOverlay()
      }

      // 通过宿主文件系统 API 获取插件内播放器页面地址，避免硬编码本地文件协议。
      const loadFrame = async () => {
        const result = await ctx.fs.getFileUrl(getPluginFilePath(ctx, 'player-frontend', 'index.html'))
        if (disposed) return
        if (!result?.ok || !result.url) {
          loadError.value = result?.error || '原播放器页面加载失败'
          return
        }
        iframeSrc.value = result.url
      }

      onMounted(() => {
        // 挂载期间标记 body，便于全局样式处理覆盖层打开时的滚动和层级。
        document.body.classList.add('epf-overlay-open')
        window.addEventListener('message', handleMessage)
        window.addEventListener('keydown', handleKeydown, true)
        void loadFrame()
        initLyricStoreSubscription()
        initTrackWatch()
        initVolumeWatch()
        initFavoriteWatch()
        initFontWatch()
        startPositionHeartbeat()

        try {
          // 订阅宿主音频频谱并转发给 iframe，用于驱动可视化；失败时静默降级为无频谱。
          spectrumDispose = ctx.audio.spectrum.subscribe(
            { fps: 24, binCount: 64, smoothing: 0.82, scale: 'mel', includeWaveform: true },
            (frame) => {
              lastSpectrumFrame = {
                bins: Array.isArray(frame?.bins) ? frame.bins : [],
                waveform: Array.isArray(frame?.waveform) ? frame.waveform : [],
                rms: Number(frame?.rms || 0),
                peak: Number(frame?.peak || 0),
                state: frame?.state || 'idle',
                timePos: frame?.timePos,
              }
              postToFrame({
                type: 'echo-player-frontend:spectrum',
                payload: lastSpectrumFrame,
              })
            },
          )
        } catch {
          spectrumDispose = null
        }
      })

      onBeforeUnmount(() => {
        // 组件销毁时撤销所有宿主侧副作用，避免后台继续推送消息或保留音频订阅。
        disposed = true
        ready = false
        document.body.classList.remove('epf-overlay-open')
        window.removeEventListener('message', handleMessage)
        window.removeEventListener('keydown', handleKeydown, true)
        stopPositionHeartbeat()
        if (lyricStoreUnsub) lyricStoreUnsub()
        lyricStoreUnsub = null
        if (stopTrackWatch) stopTrackWatch()
        stopTrackWatch = null
        if (stopVolumeWatch) stopVolumeWatch()
        stopVolumeWatch = null
        if (stopFavoriteWatch) stopFavoriteWatch()
        stopFavoriteWatch = null
        if (stopFontWatch) stopFontWatch()
        stopFontWatch = null
        if (spectrumDispose) spectrumDispose()
        spectrumDispose = null
      })

      // iframe 地址尚未就绪或加载失败时显示轻量占位，并保留关闭入口。
      const renderLoading = () =>
        h('div', { class: 'epf-bridge-loading' }, [
          h('div', { class: 'epf-bridge-loading-text' }, loadError.value || '正在加载插件播放器...'),
          h(
            'button',
            {
              class: 'epf-bridge-close',
              type: 'button',
              onClick: closeOverlay,
            },
            '关闭',
          ),
        ])

      // 覆盖层使用 dialog 语义；真正的播放器界面由 iframe 内的旧前端页面负责渲染。
      return () =>
        h(
          'div',
          {
            class: 'epf-bridge-page',
            role: 'dialog',
            'aria-modal': 'true',
          },
          [
            h('div', { class: 'epf-bridge-drag-strip' }),
            iframeSrc.value
              ? h('iframe', {
                  ref: iframeRef,
                  class: 'epf-bridge-frame',
                  src: iframeSrc.value,
                  allow: 'autoplay; fullscreen',
                  onLoad: () => {
                    ready = true
                    pushSnapshot(true)
                  },
                })
              : renderLoading(),
          ],
        )
    },
  })
}

// 外层组件只根据 overlayOpen 控制 iframe 宿主组件是否存在。
function createPlayerOverlay(ctx, overlayOpen, closeOverlay, storageBridge) {
  const { defineComponent, h } = ctx.vue
  const PlayerFrame = createPlayerFrame(ctx, closeOverlay, storageBridge)

  return defineComponent({
    name: 'PlayerFrontendOverlayHost',
    setup() {
      return () => (overlayOpen.value ? h(PlayerFrame) : null)
    },
  })
}

// 插件激活入口：注册覆盖层、监听歌词视图开关，并迁移旧路由入口。
export function activate(ctx) {
  const overlayOpen = ctx.vue.ref(false)
  const storageBridge = createPluginSqliteStore(ctx)
  const wallpaperServer = createWallpaperWebServer(ctx, storageBridge)

  // 激活时先预热数据库；失败时仅记录日志，具体错误在请求时继续向 iframe 回传。
  void storageBridge.warmup().catch((error) => {
    console.warn('[PlayerFrontendBridge] SQLite 预热失败', error)
  })

  // 预热收藏歌单：登录用户打开歌词页时心形按钮能立刻反映真实收藏状态。
  const warmupFavorites = () => {
    try {
      const playlistStore = ctx.stores.playlist
      if (typeof playlistStore?.ensureLikedPlaylistReady === 'function') {
        void playlistStore.ensureLikedPlaylistReady().catch(() => {})
      } else if (typeof playlistStore?.fetchUserPlaylists === 'function') {
        void playlistStore.fetchUserPlaylists().catch(() => {})
      }
    } catch (error) {
      console.warn('[PlayerFrontendBridge] 收藏歌单预热失败', error)
    }
  }

  // 注册固定 17196 端口的壁纸网页，供本机外部壁纸程序访问。
  void wallpaperServer.start().catch((error) => {
    console.warn('[PlayerFrontendWallpaper] 壁纸服务启动异常', error)
  })

  // 关闭覆盖层时同步关闭宿主歌词视图，避免宿主状态仍认为歌词页处于打开状态。
  const closeOverlay = () => {
    overlayOpen.value = false
    if (ctx.stores.player.isLyricViewOpen) ctx.player.toggleLyricView(false)
  }

  // 打开覆盖层时同样收起宿主原生歌词视图，让自定义播放器接管展示。
  const openOverlay = () => {
    overlayOpen.value = true
    if (ctx.stores.player.isLyricViewOpen) ctx.player.toggleLyricView(false)
    warmupFavorites()
  }

  // 将覆盖层传送到宿主 UI 根节点，由宿主负责生命周期和层级挂载。
  ctx.ui.teleport(createPlayerOverlay(ctx, overlayOpen, closeOverlay, storageBridge), {
    id: 'player-frontend-overlay',
    className: 'epf-overlay-host',
  })

  // 宿主歌词视图被打开时改为展示自定义覆盖层。
  const stopLyricWatch = ctx.vue.watch(
    () => ctx.stores.player.isLyricViewOpen,
    (open) => {
      if (!open) return
      openOverlay()
    },
    { immediate: true, flush: 'sync' },
  )

  // 老版本插件页面不再直接渲染，命中旧路由时回到首页并通过覆盖层打开播放器。
  const stopLegacyRouteWatch = ctx.vue.watch(
    () => getRoutePath(ctx),
    (path) => {
      if (!isLegacyPluginPlayerPath(path)) return
      ctx.router.replace(FALLBACK_PATH).catch(() => {})
    },
    { immediate: true },
  )

  // 跟随插件卸载释放 watcher，并关闭可能仍然打开的覆盖层。
  ctx.dispose(() => {
    stopLyricWatch()
    stopLegacyRouteWatch()
    closeOverlay()
    wallpaperServer.close()
    void storageBridge.close().catch((error) => {
      console.warn('[PlayerFrontendBridge] SQLite 关闭失败', error)
    })
  })
}

// 当前插件没有额外的停用逻辑，清理工作已注册到 ctx.dispose。
export function deactivate() {}
