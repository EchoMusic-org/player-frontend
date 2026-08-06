// ===== js/00-core-state.js =====
'use strict';

// 文件总览：
// 这是嵌入 iframe 内运行的播放器主前端，负责 Three.js 可视化、歌词舞台、3D 歌单架、控制面板和 EchoMusic 宿主桥接。
// 宿主只通过 postMessage 推送播放状态、歌词、队列和频谱；本文件不直接解码音频，也不直接持有真实播放源。
// 维护时优先确认数据来源：宿主快照负责业务状态，主循环负责视觉状态，控制命令最终都回传宿主执行。

// ============================================================
//  Global State
// ============================================================
// 真实音频元素在桥接模式下会被伪 audio 替换；旧播放器逻辑通过这个变量读取播放时间和状态。
var audio = null;
// UI 音效的 AudioContext 和上一次歌单架选择音效时间，用于限制交互音效触发频率。
var uiSfxCtx = null, lastShelfSelectSfxAt = 0;
// 普通频谱缓存长度，保留旧可视化代码需要的 FFT 尺寸。
var FFT_SIZE = 2048;
// 主频谱数据缓存，主循环会把宿主推送的 bins 映射到这个数组。
var frequencyData = new Uint8Array(FFT_SIZE / 2);
// 主波形数据缓存，主循环会把宿主推送的 waveform 映射到这个数组。
var timeDomainData = new Uint8Array(FFT_SIZE);
// 节拍检测专用 FFT 尺寸，保留给实时节拍引擎读取。
var BEAT_FFT_SIZE = 2048;
// 节拍检测频谱缓存，和普通频谱分开便于后续算法独立调参。
var beatFrequencyData = new Uint8Array(BEAT_FFT_SIZE / 2);
// 节拍检测波形缓存，用于 RMS、瞬态和实时节拍判断。
var beatTimeDomainData = new Uint8Array(BEAT_FFT_SIZE);
// 宿主频谱按 44.1kHz 采样率理解，保证频段划分和历史可视化逻辑一致。
var HOST_SPECTRUM_SAMPLE_RATE = 44100;
// 宿主频谱超过这个时间未更新就视为失效，避免暂停或失焦后沿用旧能量。
var HOST_SPECTRUM_TTL_MS = 650;
// 宿主频谱的最新一帧缓存；主循环每帧读取它来驱动低频、中频、高频和节拍效果。
var hostSpectrumFrame = { bins: [], waveform: [], rms: 0, peak: 0, updatedAt: 0 };
// 当前帧的低频、中频、高频、总能量和节拍脉冲，主循环每帧更新并同步给 shader。
var bass = 0, mid = 0, treble = 0, audioEnergy = 0, beatPulse = 0, prevEnergy = 0;
// 歌词“阳光溢光”效果的门限和包络状态，用于判断副歌或高能段落的持续提亮。
var lyricSunEnergy = 0, lyricSunTarget = 0, lyricSunHold = 0, lyricSunAvg = 0, lyricSunPeak = 0.55;
// 频段平滑后的能量，避免原始频谱跳变直接驱动视觉造成闪烁。
var smoothBass = 0, smoothMid = 0, smoothTreb = 0, smoothEnergy = 0;
// 动态峰值基线，用于把不同歌曲的能量归一化到相近视觉强度。
var bassPeak = 0.12, midPeak = 0.10, treblePeak = 0.08, energyPeak = 0.10;
var beatOnsetFlag = false;        // beat 上升沿瞬时标志,每帧消费一次
var lastStrongDrop = 0;           // 用于 burst 预设的强 drop 时刻

// 歌词行、歌词显示状态、是否有原生逐字歌词，以及当前歌词时间来源。
var lyricsLines = [], lyricsVisible = false, lyricsHasNativeKaraoke = false, lyricsTimingSource = 'none';
// 播放列表、当前播放队列、当前索引、播放状态和播放按钮忙碌锁。
var playlist = [], playQueue = [], currentIdx = -1, playing = false, playToggleBusy = false;
// 音量动画句柄和切歌 token；切歌 token 用于丢弃旧歌曲的异步 UI/封面回调。
var volumeTween = null, trackSwitchToken = 0;
// 歌单封面加载缓存，避免 3D 歌单架重复请求同一封面。
var playlistCoverCache = {};
// 宿主桥接消息来源标识。
var ECHO_BRIDGE_CHILD_SOURCE = 'echo-player-frontend-child';
var ECHO_BRIDGE_PARENT_SOURCE = 'echo-player-frontend-parent';
// 壁纸运行模式只由外部 17196 页面启用，主程序内覆盖层不使用这个锁定状态。
var wallpaperRuntimeMode = (function(){
  try {
    return new URLSearchParams(location.search || '').get('wallpaper') === '1';
  } catch (e) {
    return /(?:^|[?&])wallpaper=1(?:&|$)/.test(location.search || '');
  }
})();
// 插件数据库键名。
var EPF_STATE_STORE_KEY = 'state:v1';
var EPF_USER_FX_ARCHIVE_STORE_KEY = 'user-fx-archives:v1';
var EPF_DEPTH_STORE_PREFIX = 'depth:v1:';
// 新版深度缓存只保存不透明灰度深度图，避免把亮度通道当 PNG alpha 回读。
var EPF_DEPTH_CACHE_FORMAT = 'depth-r-opaque-v2';
// 深度缓存输入至少应为真实辅助纹理尺寸，避免 4×4 占位图写入数据库。
var EPF_MIN_DEPTH_CACHE_SIZE = 32;
// 已从宿主数据库读出的状态快照；启动早期为空时使用打包默认值。
var persistedStateSnapshot = null;
// 已从宿主数据库读出的用户视觉存档原始数组。
var persistedUserFxArchivesRaw = null;
// state:v1 是否已经完成首次读取；读取前不写入，避免默认值覆盖旧数据。
var hostStateLoaded = false;
// 用户视觉存档是否已经完成首次读取。
var hostUserFxArchivesLoaded = false;
// 宿主请求序号和等待表。
var hostRequestSeq = 0;
var hostRequestPending = {};
// 状态写入合并缓存，避免滑块拖动时密集写库。
var pendingStatePatch = null;
var pendingStateSaveTimer = 0;

// 向父层发送宿主桥接请求。
function postParentBridgeMessage(type, extra) {
  try {
    parent.postMessage(Object.assign({
      source: ECHO_BRIDGE_CHILD_SOURCE,
      type: type
    }, extra || {}), '*');
  } catch (e) {}
}

// 发起带 requestId 的宿主请求。
function requestHostBridge(type, payload, timeoutMs) {
  var requestId = 'req-' + (++hostRequestSeq) + '-' + Date.now();
  return new Promise(function(resolve, reject){
    var timer = setTimeout(function(){
      delete hostRequestPending[requestId];
      reject(new Error('宿主请求超时'));
    }, timeoutMs || 12000);
    hostRequestPending[requestId] = {
      resolve: resolve,
      reject: reject,
      timer: timer
    };
    postParentBridgeMessage(type, Object.assign({ requestId: requestId }, payload || {}));
  });
}

// 完成宿主异步请求。
function settleHostBridgeRequest(data) {
  var requestId = data && data.requestId;
  var pending = requestId && hostRequestPending[requestId];
  if (!pending) return false;
  delete hostRequestPending[requestId];
  clearTimeout(pending.timer);
  if (data.ok || data.canceled) pending.resolve(data);
  else pending.reject(new Error(data.error || '宿主请求失败'));
  return true;
}

// 接收宿主请求结果，播放桥接消息仍由后面的播放器桥接层处理。
window.addEventListener('message', function(event) {
  var data = event && event.data;
  if (!data || data.source !== ECHO_BRIDGE_PARENT_SOURCE) return;
  if (
    data.type === 'echo-player-frontend:storage-result' ||
    data.type === 'echo-player-frontend:host-request-result' ||
    data.type === 'echo-player-frontend:background-select-result' ||
    data.type === 'echo-player-frontend:background-resolve-result'
  ) {
    settleHostBridgeRequest(data);
  }
});

// 从宿主数据库读取单个键。
function hostStorageGet(key) {
  return requestHostBridge('echo-player-frontend:storage', { action: 'get', key: key }).then(function(result){
    return result.value;
  });
}

// 写入宿主数据库。
function hostStorageSet(key, value) {
  return requestHostBridge('echo-player-frontend:storage', { action: 'set', key: key, value: value }).then(function(){
    return true;
  });
}

// 合并并延迟写入 state:v1。
function saveStatePatch(patch, delay) {
  if (!patch || typeof patch !== 'object') return;
  if (!hostStateLoaded) return;
  persistedStateSnapshot = Object.assign({}, persistedStateSnapshot || {}, patch);
  pendingStatePatch = Object.assign({}, pendingStatePatch || {}, patch);
  clearTimeout(pendingStateSaveTimer);
  pendingStateSaveTimer = setTimeout(function(){
    var next = Object.assign({}, persistedStateSnapshot || {}, pendingStatePatch || {});
    pendingStatePatch = null;
    hostStorageSet(EPF_STATE_STORE_KEY, next).catch(function(err){
      console.warn('[存储] 状态写入失败', err);
    });
  }, delay == null ? 180 : delay);
}
// 视觉预设存档结构版本，用于兼容旧存档迁移。
var VISUAL_PRESET_SCHEMA = 'skull-preset-v2';
// 默认播放视觉预设索引。
var DEFAULT_PLAYBACK_VISUAL_PRESET = 0;
// 最大可用视觉预设索引，所有外部输入都会被限制到这个范围。
var MAX_VISUAL_PRESET_INDEX = 7;
// 底部控制条自动隐藏偏好的数据库偏好键名。
var CONTROLS_AUTO_HIDE_STORE_KEY = 'mineradio-controls-auto-hide-v1';
// 自由相机配置在 state:v1 中的字段名。
var FREE_CAMERA_STORE_KEY = 'mineradio-free-camera-v1';
// 把任意输入规整为合法视觉预设索引，异常值回退到 fallback 或默认预设。
function normalizeVisualPresetIndex(value, fallback) {
  // 先尝试转数值，外部存档可能是字符串、null 或损坏数据。
  var n = Number(value);
  // 第一次回退使用调用方传入的 fallback，fallback 也非法时再落到内置默认。
  if (!isFinite(n)) n = fallback == null ? DEFAULT_PLAYBACK_VISUAL_PRESET : Number(fallback);
  if (!isFinite(n)) n = DEFAULT_PLAYBACK_VISUAL_PRESET;
  // 最终四舍五入并钳制到可用预设范围，避免小数索引进入数组访问。
  return Math.round(clampRange(n, 0, MAX_VISUAL_PRESET_INDEX));
}
// 系统级“减少动态效果”偏好，后续动画逻辑可以据此降低运动强度。
var prefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// 插件版本号由宿主桥接从 ctx.manifest.version 动态下发，用于云端深度服务识别客户端。
var playerFrontendVersion = '';
// 生成云端深度服务请求使用的 UA。
function cloudDepthUserAgent() {
  return 'EchoMusic-player-frontend/' + (playerFrontendVersion || 'unknown');
}
// 启动阶段性能打点列表，保留最近若干关键时间点供调试。
var appPerfMarks = [];
// 记录启动或关键流程的性能时间点，同时写入 Performance Timeline。
function markAppPerf(name) {
  try {
    // 使用 performance.now 获取相对页面启动的高精度时间。
    var value = performance.now();
    // 内存里保留简化后的整数时间，便于控制台查看。
    appPerfMarks.push({ name: name, value: Math.round(value) });
    // 浏览器支持时同步写 performance.mark，方便用 Performance 面板分析。
    if (performance && performance.mark) performance.mark('mineradio:' + name);
    // 只打印前 16 条，防止调试日志过多影响启动阶段。
    if (appPerfMarks.length <= 16) console.debug('[MineradioPerf]', name, Math.round(value) + 'ms');
  } catch (e) {}
}
// 脚本开始执行的首个性能标记。
markAppPerf('script-start');
// 安装启动阶段长任务观察器，用于定位首屏前 15 秒内的卡顿来源。
function installStartupLongTaskObserver() {
  try {
    // 不支持 PerformanceObserver 的环境直接跳过，保持兼容。
    if (!('PerformanceObserver' in window)) return;
    // 观察 longtask 条目并把启动早期的长任务打印到控制台。
    var observer = new PerformanceObserver(function(list){
      list.getEntries().forEach(function(entry){
        // 只关心启动早期，长期运行阶段由主循环性能统计负责。
        if (entry.startTime > 15000) return;
        console.debug('[MineradioPerf] longtask', Math.round(entry.startTime) + 'ms', Math.round(entry.duration) + 'ms');
      });
    });
    // longtask 只作为诊断工具，不参与业务逻辑。
    observer.observe({ entryTypes: ['longtask'] });
    // 16 秒后断开观察器，避免长期持有额外性能监听。
    setTimeout(function(){ try { observer.disconnect(); } catch (e) {} }, 16000);
  } catch (e) {}
}
// 启动时立即启用长任务观察，失败会被函数内部吞掉。
installStartupLongTaskObserver();
// 播放模式和迷你队列面板开关。
var playMode = 'loop', miniQueueOpen = false;
// 迷你队列渲染序号，用于丢弃异步批量渲染中的旧任务。
var miniQueueRenderSeq = 0;
// 平滑滚轮处理器是否已经绑定，防止重复监听。
var smoothWheelScrollBound = false;
// 封面处理和 AI 深度估计都是异步的，coverProcessToken 用来丢弃已经过期的图片加载或模型结果。
var coverProcessToken = 0, currentCoverDepthCacheSeed = '', currentCoverEdgeCacheSeed = '', aiDepthPipeline = null, aiDepthReady = false, aiDepthBusy = false, aiDepthFailUntil = 0;
// AI 深度最近运行时间和最小间隔，防止频繁切歌时连续触发模型推理。
var aiDepthLastRunAt = 0, aiDepthMinGapMs = 18000;
// 从宿主数据库状态读取音量，读取失败或值非法时使用最大音量。
function readSavedVolume() {
  var v = persistedStateSnapshot && Number(persistedStateSnapshot.volume);
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1.0;
}
// 读取布尔偏好，启动早期没有数据库状态时使用默认值。
function readBooleanPreference(key, fallback) {
  var prefs = persistedStateSnapshot && persistedStateSnapshot.booleanPreferences;
  if (!prefs || !Object.prototype.hasOwnProperty.call(prefs, key)) return !!fallback;
  return !!prefs[key];
}
// 保存布尔偏好到宿主数据库状态。
function saveBooleanPreference(key, on) {
  var prefs = Object.assign({}, (persistedStateSnapshot && persistedStateSnapshot.booleanPreferences) || {});
  prefs[key] = !!on;
  saveStatePatch({ booleanPreferences: prefs });
}
// 当前目标音量，启动时从本地存储恢复。
var targetVolume = readSavedVolume();
// 最近一次非静音音量，用于静音按钮恢复原音量。
var lastNonZeroVolume = targetVolume > 0.01 ? targetVolume : 0.8;
// 音量浮层自动关闭计时器。
var volumeCloseTimer = null;

// 宿主频谱模式: 插件端不再生成、解码或缓存节奏分析结果。
// 普通 beatMap 缓存，保留结构是为了兼容后续 tickBeatMap 和旧接口。
var beatMapCache = {};       // { songId: { kicks: [t1, t2, ...], duration: ... } }
var currentBeatMap = null;   // 当前播放的歌的 beatMap
var beatMapNextIdx = 0;      // 下一个待触发的 kick index
var beatMapToken = 0;        // 取消旧分析
// 普通 beatMap 分析定时器，切歌或进入 DJ 模式时会取消。
var beatAnalysisTimer = null;
// DJ 模式下的 beatMap 缓存，和普通模式隔离，避免不同分析策略互相污染。
var djBeatMapCache = {};
// 当前 DJ beatMap 和下一个要消费的节拍索引。
var currentDjBeatMap = null;
var djBeatMapNextIdx = 0;
// DJ 模式下用于视觉脉冲的独立节拍索引。
var djBeatPulseNextIdx = 0;
// DJ beatMap 异步分析 token，切歌或退出 DJ 时递增以取消旧结果。
var djBeatMapToken = 0;
// DJ beatMap 分析定时器句柄。
var djBeatAnalysisTimer = null;
// 节拍镜头状态：保存预解析节拍、实时节拍、镜头冲击包络和统计信息。
var beatCam = {
  nextIdx: 0,
  events: [],
  punch: 0,
  lookahead: 0.075,
  lastTriggerAt: -10,
  lastRealtimeAt: -10,
  minInterval: 0.500,
  fallbackMinInterval: 0.320,
  realtimeMinInterval: 0.460,
  realtimeMergeWindow: 0.135,
  attack: 0.028,
  hold: 0.030,
  release: 0.185,
  thetaKick: 0,
  phiKick: 0,
  radiusKick: 0,
  rollKick: 0,
  prevAudioTime: -1,
  stats: { map: 0, live: 0, merged: 0, liveBlocked: 0 }
};
// 实时镜头强度的均值、峰值和上一帧原始值，用于稳定镜头触发。
var liveCamAvg = 0, liveCamPeak = 0.28, liveCamLastRaw = 0;
// 电影镜头动态缩放统计，综合持续能量和低频能量决定镜头幅度。
var cinemaDynamics = { avg: 0, lowAvg: 0, peak: 0.30, scale: 0.82 };
// 当前歌曲的电影镜头画像，用较慢的包络描述能量、低频、人声、旋律和密度。
var cinemaTrackProfile = {
  scale: 1.0,
  target: 1.0,
  nameHint: 1.0,
  frames: 0,
  energyAvg: 0,
  lowAvg: 0,
  vocalAvg: 0,
  melodyAvg: 0,
  punchPeak: 0.10,
  density: 0
};
// 实时节拍检测器的多频段包络和统计状态。
var rtBeat = {
  subFast: 0, subSlow: 0, lowFast: 0, lowSlow: 0,
  bodyFast: 0, bodySlow: 0, vocalFast: 0, vocalSlow: 0, snapFast: 0, snapSlow: 0,
  prevSub: 0, prevLow: 0, prevBody: 0, prevVocal: 0, prevSnap: 0, prevRms: 0,
  onsetAvg: 0.012, onsetPeak: 0.060,
  subPeak: 0.14, lowPeak: 0.18, bodyPeak: 0.16, vocalPeak: 0.16, snapPeak: 0.14,
  lastHitAt: -10,
  tempoGap: 0,
  tempoConfidence: 0,
  beatCount: 0,
  primedFrames: 0,
  warmupUntil: 0,
  pulse: 0,
  score: 0,
  stats: { hits: 0, blocked: 0, assisted: 0, strong: 0, rejected: 0 }
};
// DJ 模式状态，记录当前歌曲键、节拍稳定度、段落能量和视觉脉冲。
var djMode = {
  active: false,
  songKey: '',
  startedAt: 0,
  lastNoticeAt: -100000,
  tempoGap: 0,
  tempoConfidence: 0,
  sectionEnergy: 0,
  sectionLow: 0,
  sectionChange: 0,
  visualPulse: 0,
  lastBeatAt: -10
};

// 为 DJ 模式生成稳定歌曲键，优先使用本地键，其次按来源和歌曲标识组合。
function djSongKey(song) {
  if (!song) return '';
  // 本地歌曲用 localKey，避免不同本地文件只靠歌名冲突。
  if (song.localKey) return 'local:' + song.localKey;
  // QQ 音乐优先使用 mid/songmid，缺失时降级到 id 或标题歌手组合。
  if (songProviderKey(song) === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  // 其他来源至少使用 id 或歌曲名作为缓存键。
  return 'song:' + (song.id || song.name || '');
}

// 重置 DJ 模式下的实时量表和视觉脉冲状态。
function resetDjModeMeter() {
  djMode.tempoGap = 0;
  djMode.tempoConfidence = 0;
  djMode.sectionEnergy = 0;
  djMode.sectionLow = 0;
  djMode.sectionChange = 0;
  djMode.visualPulse = 0;
  djMode.lastBeatAt = -10;
}

// 清空当前 DJ beatMap 指针，通常在退出 DJ、切歌或取消分析时调用。
function resetDjBeatMapState() {
  currentDjBeatMap = null;
  djBeatMapNextIdx = 0;
  djBeatPulseNextIdx = 0;
}

// 取消正在等待的 DJ beatMap 分析任务，避免旧歌曲的延迟任务继续运行。
function cancelDjBeatAnalysisTimer() {
  if (djBeatAnalysisTimer) {
    clearTimeout(djBeatAnalysisTimer);
    djBeatAnalysisTimer = null;
  }
}

// 切换 DJ 模式，并按模式切换清理普通 beatMap 或 DJ beatMap 的状态。
function setDjModeActive(active, song) {
  // active 统一转布尔，song 只在开启 DJ 模式时用于生成 songKey。
  active = !!active;
  var key = active ? djSongKey(song) : '';
  // 模式开关或歌曲变化都视为状态变化，需要重置 DJ 量表。
  var changed = djMode.active !== active || djMode.songKey !== key;
  djMode.active = active;
  djMode.songKey = key;
  if (changed) {
    djMode.startedAt = performance.now();
    resetDjModeMeter();
  }
  if (active) {
    // DJ 模式接管节拍逻辑，普通 beatMap 要停掉，避免双重触发镜头。
    currentBeatMap = null;
    beatMapNextIdx = 0;
    cancelBeatAnalysisTimer();
    hideBeatChip();
  } else {
    // 退出 DJ 时递增 token 并清理 DJ 专用分析状态。
    djBeatMapToken++;
    cancelDjBeatAnalysisTimer();
    resetDjBeatMapState();
  }
}

// DJ 模式开启时低频提示用户当前处于离线锁拍模式。
function maybeAnnounceDjMode() {
  if (!djMode.active) return;
  // 提示至少间隔 8 秒，避免频繁刷新或切换时刷屏。
  var now = performance.now();
  if (now - djMode.lastNoticeAt > 8000) {
    djMode.lastNoticeAt = now;
    showToast('DJ Mode · 离线锁拍');
  }
}

// 桥接模式下舞台歌词跟随主程序页面歌词字体。
var BRIDGE_LYRIC_FONT_FAMILY_FALLBACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
var bridgeLyricFontFamily = BRIDGE_LYRIC_FONT_FAMILY_FALLBACK;
// 默认歌词过滤正则，命中后在接收歌词时从时间轴中移除。
var DEFAULT_LYRIC_FILTER_REGEX = '^([^：]*)：.*$|^([^:]*):.*$|^([^翻唱]*)翻唱.*$|^([^许可]*)许可.*$|^([^音乐人]*)音乐人.*$|^([^国风]*)国风.*$|^([^纯音乐]*)纯音乐.*$|^([^星曜计划]*)星曜计划.*$';

// fx 状态: 预设 + 主滑块 + 开关 + 三态
// 用户可调视觉参数的默认值。fx 会在此基础上叠加本地存档，并在控制台、shader 和布局逻辑之间共享。
var fxDefaults = {
  // 默认视觉预设索引，启动时会根据存档覆盖。
  preset: DEFAULT_PLAYBACK_VISUAL_PRESET,            // 0=专辑封面，1=滚筒，2=星球，3=虚空，4=唱片，5=星河，6=安魂，7=音域回响
  // 主视觉强度，作为低频、中频、高频映射到 shader 时的总倍率。
  intensity: 0.85,
  // 电影镜头震动幅度，影响节拍镜头和相机动态。
  cinemaShake: 0.5,
  // 粒子景深位移倍率，主要影响封面深度纹理带来的 Z 轴层次。
  depth: 1.0,
  // 封面纹理处理分辨率倍率，越高越清晰但 CPU/canvas 成本更高。
  coverResolution: 1.55,
  // 粒子点大小、运动速度、扭曲、颜色增益、散射和背景淡化的基础滑条值。
  point: 1.0, speed: 1.0, twist: 0.0, color: 1.10, scatter: 0.0, bgFade: 0.20,
  // 泛光强度，后续会同步给粒子材质和辉光层。
  bloomStrength: 0.62,
  // 歌词辉光基础强度。
  lyricGlowStrength: 0.28,
  // 3D 歌词整体缩放。
  lyricScale: 1.0,
  // 3D 歌词 X 轴偏移。
  lyricOffsetX: 0,
  // 3D 歌词 Y 轴偏移。
  lyricOffsetY: 0,
  // 3D 歌词 Z 轴偏移，用于控制歌词离相机远近。
  lyricOffsetZ: 0,
  // 3D 歌词绕 X 轴倾斜角。
  lyricTiltX: 0,
  // 3D 歌词绕 Y 轴倾斜角。
  lyricTiltY: 0,
  // 歌词主色模式，auto 表示从封面或主题自动取色。
  lyricColorMode: 'auto',
  // 手动歌词主色。
  lyricColor: '#a9b8c8',
  // 当前歌词高亮色模式，auto 表示自动取色。
  lyricHighlightMode: 'auto',
  // 手动歌词高亮色。
  lyricHighlightColor: '#fac900',
  // 歌词辉光颜色是否跟随歌词高亮色。
  lyricGlowLinked: true,
  // 手动歌词辉光颜色。
  lyricGlowColor: '#008aff',
  // 歌词字间距倍率。
  lyricLetterSpacing: 0,
  // 歌词行高倍率。
  lyricLineHeight: 1.0,
  // 歌词字重。
  lyricWeight: 900,
  // 歌词时间矫正，正值让歌词提前显示，负值让歌词延后显示。
  lyricTimeOffset: 0,
  // 是否启用歌词过滤。
  lyricFilterEnabled: true,
  // 歌词过滤正则。
  lyricFilterRegex: DEFAULT_LYRIC_FILTER_REGEX,
  // 主视觉染色模式，auto 表示跟随封面色。
  visualTintMode: 'auto',
  // 手动主视觉染色。
  visualTintColor: '#9db8cf',
  // UI 强调色，影响按钮、滑条和歌单架点缀。
  uiAccentColor: '#ffffff',
  // 视觉控制台图标颜色。
  visualIconColor: '#ffffff',
  // 背景颜色模式，cover 表示从封面取色，custom 表示使用用户颜色。
  backgroundColorMode: 'cover',
  // 自定义背景底色。
  backgroundColor: '#000000',
  // 自定义背景透明度。
  backgroundOpacity: 1,
  // 底部玻璃控制条色差位移强度。
  controlGlassChromaticOffset: 90,
  // 是否明确启用自定义背景颜色。
  backgroundColorCustom: false,
  // 旧版自定义背景图片字段，仍用于兼容存档。
  backgroundImage: '',
  // 新版自定义背景媒体对象，可表示图片或视频。
  backgroundMedia: null,
  // 壁纸模式不由主程序开关控制，外部壁纸页面会单独启用。
  wallpaperMode: false,
  // 壁纸模式透明度，保留给旧配置兼容。
  wallpaperOpacity: 1,
  // 各类视觉特效开关：浮空粒子、电影镜头、边缘、泛光和歌词辉光。
  floatLayer: false, cinema: true, edge: false, bloom: false, lyricGlow: true,
  // AI 立体增强模式：off 关闭，local 使用本地模型，cloud 请求云端深度服务。
  aiDepthMode: 'off',
  // 云端深度服务基础地址，留空时不发起云端请求。
  aiDepthCloudApi: '',
  // 歌词辉光是否随节拍增强。
  lyricGlowBeat: true,
  // 是否启用歌词周围的辉光粒子。
  lyricGlowParticles: false,
  // 歌词相机锁定开关，开启后歌词相机不会随部分镜头效果移动。
  lyricCameraLock: false,
  // 是否显示 3D 粒子歌词。
  particleLyrics: true,    // v7.2: 粒子歌词
  // 是否启用背面封面粒子层。
  backCover: false,        // 旧的封面背面粒子层关闭；浮空粒子层会跟随封面翻转
  // 3D 歌单架模式，side 表示右侧侧栏。
  shelf: 'side',
  // 歌单架相机跟随模式。
  shelfCameraMode: 'static',
  // 歌单架出现策略，always 表示始终可见或可触发。
  shelfPresence: 'always',
  // 歌单架整体缩放。
  shelfSize: 1,
  // 歌单架 X 轴用户偏移。
  shelfOffsetX: 0,
  // 歌单架 Y 轴用户偏移。
  shelfOffsetY: 0,
  // 歌单架 Z 轴用户偏移。
  shelfOffsetZ: 0,
  // 歌单架绕 Y 轴角度，单位在后续同步时转换。
  shelfAngleY: -15,
  // 用户是否手动改过歌单架角度，用于区分自动布局和用户设置。
  shelfAngleYManual: false,
  // 歌单架整体不透明度。
  shelfOpacity: 1,
  // 歌单架卡片背景不透明度。
  shelfBgOpacity: 0.90,
  // 歌单架强调色。
  shelfAccentColor: '#ffffff',
  // 后台渲染策略，auto/keep/release 等模式会影响主循环和缓存回收。
  performanceBackground: 'auto',
  // 渲染质量档位。
  performanceQuality: 'high',
  // 后台是否保持动态背景，不保持时会进入深度省电模式。
  liveBackgroundKeep: false,
  // === 音域回响 (Sonic Topography) 预设参数 ==========
  sonicGroundAmplitude: 50,
  sonicGroundMotionSpeed: 50,
  sonicGroundDensity: 46,
  sonicGroundRange: 82,
  sonicGroundLower: 68,
  sonicGroundDepth: 62,
  sonicGroundAutoRotate: 50,
  sonicGroundColorMode: 'cover',
  sonicGroundBaseColor: '#05070c',
  sonicGroundCoolColor: '#0066ff',
  sonicGroundWarmColor: '#ff3c19',
  sonicGroundAccentColor: '#33e6ff',
  sonicGroundGlow: 68,
  sonicGroundSubBass: 90,
  sonicGroundBass: 92,
  sonicGroundLowMid: 50,
  sonicGroundMid: 50,
  sonicGroundHighMid: 50,
  sonicGroundPresence: 50,
  sonicGroundBrilliance: 50,
  sonicGroundAir: 48,
  sonicGroundFloatingEnabled: true,
  sonicGroundFloatingIntensity: 55,
  sonicGroundFloatingMinSize: 9,
  sonicGroundFloatingMaxSize: 26,
  sonicGroundFloatingSpeed: 77,
  sonicGroundFloatingCount: 80,
};
// 内置用户视觉存档的显示名称。
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME = '默认测试';
// 内置用户视觉存档的导出时间戳，用于展示和排序。
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_EXPORTED_AT = 1782276031784;
// 内置用户视觉存档的保存时间戳。
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_SAVED_AT = 1782273019045;
// 打包内置的默认视觉快照，Object.freeze 防止运行期误改模板对象。
var PACKAGED_DEFAULT_FX_SNAPSHOT = Object.freeze({
  // 快照版本字段，用于导入或恢复默认时判断是否需要迁移。
  visualPresetSchema: VISUAL_PRESET_SCHEMA,
  // 以下字段对应 fxDefaults 的一份稳定副本，作为“恢复默认”和内置存档的源数据。
  preset: DEFAULT_PLAYBACK_VISUAL_PRESET,
  intensity: 0.85,
  cinemaShake: 0.5,
  depth: 1,
  coverResolution: 1.55,
  point: 1,
  speed: 1,
  twist: 0,
  color: 1.1,
  scatter: 0,
  bgFade: 0.2,
  bloomStrength: 0.62,
  lyricGlowStrength: 0.28,
  lyricScale: 1,
  lyricOffsetX: 0,
  lyricOffsetY: 0,
  lyricOffsetZ: 0,
  lyricTiltX: 0,
  lyricTiltY: 0,
  lyricCameraLock: false,
  lyricColorMode: 'auto',
  lyricColor: '#a9b8c8',
  lyricHighlightMode: 'auto',
  lyricHighlightColor: '#fac900',
  lyricGlowLinked: true,
  lyricGlowColor: '#008aff',
  lyricLetterSpacing: 0,
  lyricLineHeight: 1,
  lyricWeight: 900,
  lyricTimeOffset: 0,
  lyricFilterEnabled: true,
  lyricFilterRegex: DEFAULT_LYRIC_FILTER_REGEX,
  visualTintMode: 'auto',
  visualTintColor: '#9db8cf',
  uiAccentColor: '#ffffff',
  visualIconColor: '#ffffff',
  backgroundColorMode: 'cover',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  controlGlassChromaticOffset: 90,
  backgroundColorCustom: false,
  floatLayer: false,
  cinema: true,
  edge: false,
  aiDepthMode: 'off',
  aiDepthCloudApi: '',
  bloom: false,
  lyricGlow: true,
  lyricGlowBeat: true,
  lyricGlowParticles: false,
  performanceBackground: 'auto',
  performanceQuality: 'high',
  liveBackgroundKeep: false,
  particleLyrics: true,
  backCover: false,
  shelf: 'side',
  shelfCameraMode: 'static',
  shelfPresence: 'always',
  shelfSize: 1,
  shelfOffsetX: 0,
  shelfOffsetY: 0,
  shelfOffsetZ: 0,
  shelfAngleY: -15,
  shelfAngleYManual: false,
  shelfOpacity: 1,
  shelfBgOpacity: 0.9,
  shelfAccentColor: '#ffffff',
  // === 音域回响 (Sonic Topography) 预设参数 ==========
  sonicGroundAmplitude: 50,
  sonicGroundMotionSpeed: 50,
  sonicGroundDensity: 46,
  sonicGroundRange: 82,
  sonicGroundLower: 68,
  sonicGroundDepth: 62,
  sonicGroundAutoRotate: 50,
  sonicGroundColorMode: 'cover',
  sonicGroundBaseColor: '#05070c',
  sonicGroundCoolColor: '#0066ff',
  sonicGroundWarmColor: '#ff3c19',
  sonicGroundAccentColor: '#33e6ff',
  sonicGroundGlow: 68,
  sonicGroundSubBass: 90,
  sonicGroundBass: 92,
  sonicGroundLowMid: 50,
  sonicGroundMid: 50,
  sonicGroundHighMid: 50,
  sonicGroundPresence: 50,
  sonicGroundBrilliance: 50,
  sonicGroundAir: 48,
  sonicGroundFloatingEnabled: true,
  sonicGroundFloatingIntensity: 55,
  sonicGroundFloatingMinSize: 9,
  sonicGroundFloatingMaxSize: 26,
  sonicGroundFloatingSpeed: 77,
  sonicGroundFloatingCount: 80,
});
// 返回打包默认快照的浅拷贝，避免调用方直接修改冻结模板。
function clonePackagedDefaultFxSnapshot() {
  return Object.assign({}, PACKAGED_DEFAULT_FX_SNAPSHOT);
}
// 读取打包默认歌词布局时复用视觉快照，保持恢复默认的入口一致。
function packagedDefaultLyricLayoutRaw() {
  return clonePackagedDefaultFxSnapshot();
}
// 开发期锁定的视觉字段；锁定字段会在读取存档后被强制归一化。
var DEVELOPMENT_LOCKED_FX = {
  // 壁纸模式只允许外部壁纸引擎页面启用，不允许被主程序存档重新开启。
  wallpaperMode: true
};
// 壁纸引擎需要添加的本机网页地址。
var WALLPAPER_ENGINE_URL = 'http://127.0.0.1:17196';
// 壁纸模式入口只提供外部使用提示，不切换主程序状态。
function wallpaperModeHintText() {
  return '请在壁纸引擎中添加 ' + WALLPAPER_ENGINE_URL + ' 即可使用壁纸模式';
}
// 显示壁纸模式外部接入提示，并保持开关处于关闭态。
function showWallpaperModeHint() {
  normalizeDevelopmentLockedFxState();
  // 壁纸入口是提示按钮，不能表现为已开启。
  var toggle = document.getElementById('t-wallpaperMode');
  if (toggle) toggle.classList.remove('on');
  showToast(wallpaperModeHintText());
}
// 判断某个视觉字段是否被开发锁强制接管。
function isDevelopmentLockedFx(key) {
  return !!DEVELOPMENT_LOCKED_FX[key];
}
// 把开发锁字段恢复到允许的运行态。
function normalizeDevelopmentLockedFxState() {
  // fx 尚未初始化时直接跳过，避免启动顺序中的空引用。
  if (!fx) return;
  // 壁纸模式在当前桥接播放器中固定关闭。
  fx.wallpaperMode = false;
}
// 归一化歌词时间矫正，限制在正负 10 秒并吸附到 0.1 秒。
function normalizeLyricTimeOffset(value) {
  var number = Number(value);
  if (!isFinite(number)) number = 0;
  return Math.round(clampRange(number, -10, 10) * 10) / 10;
}
// 格式化歌词时间矫正显示文本。
function formatLyricTimeOffset(value) {
  var offset = normalizeLyricTimeOffset(value);
  return (offset > 0 ? '+' : '') + offset.toFixed(1) + 's';
}
// 返回只用于歌词显示和逐字进度的校正后播放时间。
function effectiveLyricPlaybackTime() {
  var base = audio && isFinite(audio.currentTime) ? audio.currentTime : 0;
  return base + normalizeLyricTimeOffset(fx && fx.lyricTimeOffset);
}
// 刷新歌词时间矫正控件。
function updateLyricTimeOffsetControls() {
  var offset = normalizeLyricTimeOffset(fx && fx.lyricTimeOffset);
  var value = document.getElementById('lyric-time-offset-value');
  var minus = document.getElementById('lyric-time-offset-minus');
  var plus = document.getElementById('lyric-time-offset-plus');
  if (value) value.textContent = formatLyricTimeOffset(offset);
  if (minus) minus.disabled = offset <= -10;
  if (plus) plus.disabled = offset >= 10;
}
// 设置歌词时间矫正。
function setLyricTimeOffset(value, silent) {
  if (!fx) return;
  fx.lyricTimeOffset = normalizeLyricTimeOffset(value);
  updateLyricTimeOffsetControls();
  saveLyricLayout();
  if (!silent) showToast('歌词时间矫正: ' + formatLyricTimeOffset(fx.lyricTimeOffset));
}
// 按步进调整歌词时间矫正。
function adjustLyricTimeOffset(delta) {
  setLyricTimeOffset(normalizeLyricTimeOffset(fx && fx.lyricTimeOffset) + Number(delta || 0));
}
// 从本地布局存档里读取上次使用的视觉预设索引。
function readSavedPlaybackVisualPreset() {
  try {
    // 启动早期数据库状态可能尚未返回，此时回退默认预设。
    var raw = (persistedStateSnapshot && persistedStateSnapshot.lyricLayout) || {};
    // 旧用户没有保存 preset 时直接使用默认播放预设。
    if (!Object.prototype.hasOwnProperty.call(raw, 'preset')) return DEFAULT_PLAYBACK_VISUAL_PRESET;
    // 先做合法范围归一化，再处理历史版本迁移。
    var savedPreset = normalizeVisualPresetIndex(raw.preset, DEFAULT_PLAYBACK_VISUAL_PRESET);
    // 旧 schema 中的 3 号预设语义变化过，未带新版本号时迁移到 5 号。
    if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) savedPreset = 5;
    return savedPreset;
  } catch (e) {
    return DEFAULT_PLAYBACK_VISUAL_PRESET;
  }
}
// 启动时确定的播放视觉预设，后续用于首屏和存档同步。
var playbackVisualPreset = readSavedPlaybackVisualPreset();
// 运行期视觉状态：所有滑条、开关、预设和布局设置最终都会同步到这个对象。
var fx = Object.assign({}, fxDefaults, readSavedLyricLayout());
// 读取用户存档后立刻应用开发锁，保证后续模块看到的是可用状态。
normalizeDevelopmentLockedFxState();
// 预设切换动画状态，from/to 记录切换前后预设，duration 控制过渡时长。
var presetTransition = { active:false, start:-10, duration:0.92, from:0, to:0 };
// 底部控制条自动隐藏偏好。
var controlsAutoHide = readBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, false);
// 鼠标是否正悬停在控制条区域。
var controlsHovering = false;
// 控制条隐藏延迟计时器。
var controlsHideTimer = null;
// 最近一次控制区域指针移动时间。
var controlsLastMoveAt = 0;
// 歌单架交互期间临时抑制控制条自动隐藏的截止时间。
var controlsShelfSuppressUntil = 0;
// 鼠标指针自动隐藏计时器。
var cursorHideTimer = null;
// 鼠标静止多久后隐藏指针。
var CURSOR_HIDE_DELAY = 2500;
// 视觉控制台是否固定展开。
var fxPanelPinned = false;
// 沉浸模式开关。
var immersiveMode = false;
// 进入沉浸模式前需要暂存的界面状态，退出时按这里恢复。
var immersiveState = {
  shelfMode: null,
  shelfPinnedOpen: false,
  lyrics: true,
  controlsAutoHide: true,
  bottomVisible: false
};

// 鼠标 / 指针视差
// 当前已经平滑后的指针视差，用于镜头和歌单架轻微跟随。
var pointerParallax = { x:0, y:0 };
// 指针视差目标值，mousemove 只写目标，主循环负责缓动。
var pointerTarget = { x:0, y:0 };
// 头部/封面视差状态，active 表示当前是否启用头部追踪式视差。
var headParallax = { x:0, y:0, active:false };
// 头部视差的中性点，用于把输入坐标转成相对位移。
var headNeutral = null;

// 给对象上的某个数值字段打一段短脉冲，常用于按钮、镜头或视觉状态的瞬时反馈。
function pulseObjectValue(target, key, amount, duration) {
  // 目标对象不存在时直接跳过，便于在可选模块中安全调用。
  if (!target) return;
  // 脉冲先立刻抬到指定强度，再由动画归零。
  target[key] = Math.max(target[key] || 0, amount || 1);
  if (window.gsap) {
    // 有 GSAP 时使用补间，覆盖同字段旧动画。
    window.gsap.killTweensOf(target, key);
    var vars = { duration: duration || 0.42, ease: 'power3.out' };
    vars[key] = 0;
    window.gsap.to(target, vars);
  } else {
    // 没有 GSAP 时降级为延迟清零，不保证平滑但保持状态不会卡住。
    setTimeout(function(){ if (target) target[key] = 0; }, (duration || 0.42) * 1000);
  }
}

// 桌面宿主窗口状态，影响后台省电、全屏歌词相机校准和恢复策略。
var desktopRuntimeState = {
  desktop: false,
  minimized: false,
  visible: true,
  focused: true,
  fullscreen: false
};
// 渲染器当前功耗模式缓存，避免重复 setSize/setPixelRatio。
var renderPowerState = { mode: '', width: 0, height: 0, pixelRatio: 0 };
// 后台缓存裁剪的延迟计时器。
var backgroundCacheTrimTimer = 0;
// 后台省电和缓存裁剪的运行时统计。它既用于调试，也用于避免隐藏窗口继续保留过多纹理和缓存。
var runtimePerfState = {
  lastCacheTrimAt: 0,
  cacheTrimCount: 0,
  lastCacheTrimReason: '',
  lastHeapSampleAt: 0,
  heapMB: 0,
  cacheCounts: {}
};
function isDeepBackgroundMode() {
  // 深度后台模式会显著降低渲染频率并触发缓存裁剪；用户选择“后台保持”时跳过该策略。
  if (isLiveBackgroundKeepMode()) return false;
  return !!(document.hidden || desktopRuntimeState.minimized || desktopRuntimeState.visible === false);
}
function currentPerformanceBackgroundMode() {
  // 统一读取性能后台策略，兼容旧的 liveBackgroundKeep 开关。
  return normalizePerformanceBackgroundMode(fx && fx.performanceBackground, fx && fx.liveBackgroundKeep === true);
}
// 判断后台是否保持动态背景，保持时不进入深度睡眠。
function isLiveBackgroundKeepMode() {
  return currentPerformanceBackgroundMode() === 'keep';
}
// 判断后台是否尽快释放资源。
function isBackgroundReleaseMode() {
  return currentPerformanceBackgroundMode() === 'release';
}
// 当前是否因为 document.hidden 进入后台优化状态。
function isHiddenForBackgroundOptimization() {
  return !!(document.hidden && !isLiveBackgroundKeepMode());
}
// 预留的可见后台模式判断，当前固定关闭。
function isVisibleBackgroundMode() {
  return false;
}
function updateRenderPowerClasses() {
  // CSS 类和 renderer 电源模式分开维护：类负责界面表现，renderer 负责实际像素比与刷新策略。
  document.body.classList.toggle('render-deep-sleep', isDeepBackgroundMode());
  document.body.classList.toggle('render-background-eco', isVisibleBackgroundMode());
}
function safeObjectKeys(obj) {
  // 某些缓存对象可能被外部污染或置空，统一保护 Object.keys。
  try { return obj ? Object.keys(obj) : []; } catch (e) { return []; }
}
// 向保护表写入一个字符串 key，空 key 会被忽略。
function markProtectedKey(map, key) {
  if (key) map[String(key)] = true;
}
// 收集当前仍在使用的封面 URL，缓存裁剪时不能删除这些封面的加载记录。
function collectProtectedCoverUrls() {
  // 使用无原型对象作为集合，避免和内置属性名冲突。
  var keep = Object.create(null);
  // 本地 helper 统一做空值保护。
  function mark(url) { if (url) keep[String(url)] = true; }
  try {
    // 当前播放歌曲的多个尺寸封面都要保护，因为 UI 和 3D 卡片可能使用不同尺寸。
    var song = (typeof currentCoverSong === 'function') ? currentCoverSong() : (playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null);
    if (song) {
      mark(song.cover);
      if (typeof songCoverSrc === 'function') {
        mark(songCoverSrc(song, 60));
        mark(songCoverSrc(song, 360));
        mark(songCoverSrc(song, 400));
      }
    }
    if (typeof currentCoverSource !== 'undefined' && currentCoverSource && currentCoverSource.src) mark(currentCoverSource.src);
    // 当前已渲染的 3D 歌单卡片封面也需要保护，避免卡片贴图突然丢失。
    if (shelfManager && shelfManager.getCards) {
      shelfManager.getCards().forEach(function(card){
        if (card && card.item) mark(card.item.cover);
      });
    }
  } catch (e) {}
  return keep;
}
// 收集当前播放附近和 DJ 模式使用中的 beatMap key，避免裁剪掉马上要消费的节拍数据。
function collectProtectedBeatMapKeys() {
  var keep = Object.create(null);
  try {
    // 当前歌曲前后 5 首都保留，兼顾上一首/下一首快速切换。
    if (typeof beatMapSongKey === 'function' && playQueue && playQueue.length) {
      var start = Math.max(0, currentIdx - 5);
      var end = Math.min(playQueue.length - 1, currentIdx + 5);
      for (var i = start; i <= end; i++) markProtectedKey(keep, beatMapSongKey(playQueue[i]));
    }
    if (typeof djMode !== 'undefined' && djMode && djMode.songKey) markProtectedKey(keep, djMode.songKey);
  } catch (e) {}
  return keep;
}
// 收藏封面深度缓存由宿主 SQLite 统一管理，内存侧不再持有，无需裁剪。
// 通用对象缓存裁剪：保留 keep 个未保护项，返回实际删除数量。
function trimObjectCache(cache, keep, protectedKeys, skipRecord) {
  // 空缓存或数量未超过上限时无需裁剪。
  var keys = safeObjectKeys(cache);
  if (!cache || keys.length <= keep) return 0;
  // drop 是需要删除的数量，按 keys 顺序从旧项开始尝试删除。
  var drop = keys.length - keep;
  var dropped = 0;
  for (var i = 0; i < keys.length && drop > 0; i++) {
    var key = keys[i];
    // 保护表命中的 key 不能删除。
    if (protectedKeys && protectedKeys[key]) continue;
    var rec = cache[key];
    // skipRecord 允许调用方保护正在 loading 的条目等特殊状态。
    if (skipRecord && skipRecord(rec, key)) continue;
    delete cache[key];
    drop--;
    dropped++;
  }
  return dropped;
}
// 收集当前运行时性能快照，供 window.__mineradioPerfSnapshot 调试调用。
function collectRuntimePerfSnapshot(now) {
  // now 可由调用方传入，避免同一帧内重复读取 performance.now。
  now = now || performance.now();
  // 统计各类缓存数量，便于观察裁剪是否生效。
  runtimePerfState.cacheCounts = {
    playlistCovers: safeObjectKeys(playlistCoverCache).length,
    beatMaps: safeObjectKeys(beatMapCache).length,
    djBeatMaps: safeObjectKeys(djBeatMapCache).length
  };
  if (performance && performance.memory && now - runtimePerfState.lastHeapSampleAt > 12000) {
    // Chrome/Electron 下可读取 JS 堆内存；采样间隔较长，避免频繁触碰性能接口。
    runtimePerfState.lastHeapSampleAt = now;
    runtimePerfState.heapMB = Math.round((performance.memory.usedJSHeapSize || 0) / 1048576);
  }
  return {
    // 主循环渲染状态由后面模块创建，启动早期不存在时返回 null。
    render: (typeof renderPerfState !== 'undefined') ? {
      mode: renderPerfState.mode,
      fps: renderPerfState.fps,
      skipped: renderPerfState.skipped,
      longFrames: renderPerfState.longFrames
    } : null,
    runtime: runtimePerfState,
    // renderer.info 提供 GPU 资源和 draw call 统计。
    renderer: (typeof renderer !== 'undefined' && renderer && renderer.info) ? {
      geometries: renderer.info.memory && renderer.info.memory.geometries,
      textures: renderer.info.memory && renderer.info.memory.textures,
      calls: renderer.info.render && renderer.info.render.calls,
      triangles: renderer.info.render && renderer.info.render.triangles
    } : null,
    // 当前视口和实际 canvas 像素信息，用于排查 DPR 和后台省电尺寸。
    viewport: (typeof renderer !== 'undefined' && renderer && renderer.domElement) ? {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      renderPixelRatio: renderer.getPixelRatio ? Number(renderer.getPixelRatio().toFixed(3)) : 0,
      canvasWidth: renderer.domElement.width || 0,
      canvasHeight: renderer.domElement.height || 0,
      renderPixels: (renderer.domElement.width || 0) * (renderer.domElement.height || 0),
      targetFps: (typeof getAdaptiveRenderFps === 'function') ? getAdaptiveRenderFps() : 0,
      interactionBoost: (typeof isRenderInteractionActive === 'function') ? isRenderInteractionActive() : false,
      interactionReason: (typeof renderInteractionReason !== 'undefined') ? renderInteractionReason : ''
    } : null,
    deepSleep: isDeepBackgroundMode()
  };
}
// 暴露调试函数，控制台可直接调用查看当前性能和缓存状态。
window.__mineradioPerfSnapshot = collectRuntimePerfSnapshot;
// 执行一次运行时缓存裁剪，aggressive=true 时用于后台深度清理。
function trimRuntimeCaches(reason, aggressive) {
  // 先收集保护集合，确保当前播放和当前可见卡片使用的资源不被删除。
  var protectedCovers = collectProtectedCoverUrls();
  var protectedBeats = collectProtectedBeatMapKeys();
  var dropped = 0;
  // 播放列表封面缓存较大，后台时保留更少；正在加载的记录暂不删除。
  dropped += trimObjectCache(playlistCoverCache, aggressive ? 72 : 180, protectedCovers, function(rec){
    return rec && rec.loading;
  });
  // 普通 beatMap 和 DJ beatMap 分别裁剪，避免大量歌曲切换后积累。
  dropped += trimObjectCache(beatMapCache, aggressive ? 12 : 36, protectedBeats);
  dropped += trimObjectCache(djBeatMapCache, aggressive ? 4 : 12, protectedBeats);
  // 激进裁剪时释放 renderer 内部 renderLists，降低隐藏窗口的 GPU/CPU 占用。
  if (aggressive && typeof renderer !== 'undefined' && renderer && renderer.renderLists && renderer.renderLists.dispose) {
    try { renderer.renderLists.dispose(); } catch (e) {}
  }
  runtimePerfState.lastCacheTrimAt = performance.now();
  runtimePerfState.cacheTrimCount += 1;
  runtimePerfState.lastCacheTrimReason = reason || (aggressive ? 'deep' : 'active');
  // 裁剪后立即刷新一次快照，便于调试看到最新数量。
  collectRuntimePerfSnapshot(runtimePerfState.lastCacheTrimAt);
  return dropped;
}
// 只有处于深度后台模式时才执行后台视觉缓存裁剪。
function trimVisualCachesForBackground() {
  if (!isDeepBackgroundMode()) return;
  trimRuntimeCaches('deep-background', true);
}
// 延迟触发后台缓存裁剪，避免 visibility/blur 事件中同步做重活。
function scheduleBackgroundCacheTrim() {
  if (!isDeepBackgroundMode()) return;
  // 多次进入后台只保留最后一个计时器。
  if (backgroundCacheTrimTimer) clearTimeout(backgroundCacheTrimTimer);
  backgroundCacheTrimTimer = setTimeout(function(){
    backgroundCacheTrimTimer = 0;
    trimVisualCachesForBackground();
  }, 900);
}
function maybeTrimRuntimeCaches(now) {
  // 主循环定期调用这里；真正的裁剪会避开当前封面和当前 3D 歌单卡片仍在使用的资源。
  now = now || performance.now();
  var deep = isDeepBackgroundMode();
  // 后台裁剪间隔更短，release 模式最激进；前台只做低频维护性裁剪。
  var gap = deep ? (isBackgroundReleaseMode() ? 3600 : 7000) : 45000;
  // 启动前 30 秒不做前台裁剪，避免首屏阶段和资源加载竞争。
  if (!deep && now < 30000) return;
  if (now - runtimePerfState.lastCacheTrimAt < gap) return;
  trimRuntimeCaches(deep ? (isBackgroundReleaseMode() ? 'release-frame' : 'deep-frame') : 'active-frame', deep);
}
// 根据当前后台状态调整 renderer 尺寸和像素比。
function applyRendererPowerMode() {
  // renderer 在后面 Three.js 场景模块才创建，提前调用时安全跳过。
  if (typeof renderer === 'undefined' || !renderer) return;
  var deep = isDeepBackgroundMode();
  // 深度睡眠时把 canvas 缩到 4x4，保留渲染链路但大幅降低像素成本。
  var width = deep ? 4 : Math.max(1, innerWidth);
  var height = deep ? 4 : Math.max(1, innerHeight);
  var pixelRatio = getRenderPixelRatio();
  var mode = deep ? 'sleep' : 'active';
  // 状态未变化时避免重复 setSize，减少 layout 和 WebGL 状态切换。
  if (renderPowerState.mode === mode && renderPowerState.width === width && renderPowerState.height === height && Math.abs(renderPowerState.pixelRatio - pixelRatio) < 0.001) return;
  renderPowerState = { mode: mode, width: width, height: height, pixelRatio: pixelRatio };
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  // uPixel 影响 shader 点大小，需要和 renderer DPR 保持同步。
  if (typeof uniforms !== 'undefined' && uniforms && uniforms.uPixel) uniforms.uPixel.value = renderer.getPixelRatio();
  if (deep) {
    // 进入睡眠时顺手释放 renderLists，并安排后台缓存裁剪。
    if (renderer.renderLists && renderer.renderLists.dispose) renderer.renderLists.dispose();
    scheduleBackgroundCacheTrim();
  }
}
// 安装可见性和焦点监听，把宿主窗口状态变化同步到 CSS、renderer 和视觉恢复逻辑。
function installRenderPowerHooks() {
  updateRenderPowerClasses();
  document.addEventListener('visibilitychange', function(){
    // 页面隐藏/显示时立即更新功耗模式。
    updateRenderPowerClasses();
    applyRendererPowerMode();
    if (!isDeepBackgroundMode()) recoverVisualsAfterBackground('visibilitychange');
  });
  window.addEventListener('focus', function(){
    // 窗口重新聚焦时恢复前台渲染，并触发视觉层恢复。
    desktopRuntimeState.focused = true;
    updateRenderPowerClasses();
    applyRendererPowerMode();
    if (!isDeepBackgroundMode()) recoverVisualsAfterBackground('focus');
  });
  window.addEventListener('blur', function(){
    // 失焦只降低状态，不主动恢复视觉。
    desktopRuntimeState.focused = false;
    updateRenderPowerClasses();
    applyRendererPowerMode();
  });
}


