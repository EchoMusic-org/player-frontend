// ===== js/08-panels-files-controls.js =====

// ============================================================
//  播放列表面板
// ============================================================
// 给列表中可见项播放入场动画。
function animateListItems(container, selector, opts) {
  if (!container || !window.gsap) return;
  opts = opts || {};
  // 候选列表项。
  var items = Array.prototype.slice.call(container.querySelectorAll(selector));
  if (!items.length) return;
  // 最大动画项数，避免超长队列一次性创建大量 tween。
  var limit = opts.limit || 18;
  // 本次参与动画的目标项。
  var targets = items.slice(0, limit);
  window.gsap.killTweensOf(targets);
  window.gsap.fromTo(targets, {
    autoAlpha: 0,
    y: opts.y == null ? 8 : opts.y,
    x: opts.x == null ? -6 : opts.x
  }, {
    autoAlpha: 1,
    y: 0,
    x: 0,
    duration: opts.duration || 0.22,
    stagger: opts.stagger || 0.012,
    ease: opts.ease || 'power2.out',
    force3D: true,
    overwrite: true
  });
}
// 将滚动容器平滑滚动到指定子项附近。
function smoothScrollToItem(scroller, item, opts) {
  if (!scroller || !item) return;
  opts = opts || {};
  // 目标 scrollTop，align 控制目标项在视口中的垂直位置。
  var target = item.offsetTop - Math.max(0, (scroller.clientHeight - item.offsetHeight) * (opts.align == null ? 0.42 : opts.align));
  // 目标滚动位置夹在容器可滚动范围内。
  target = Math.max(0, Math.min(target, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
  if (window.gsap) {
    // 如果容器绑定了平滑滚轮，则同步其内部目标，避免两个 tween 抢滚动。
    if (typeof scroller.__syncSmoothWheelTarget === 'function') scroller.__syncSmoothWheelTarget(target);
    window.gsap.killTweensOf(scroller);
    window.gsap.to(scroller, { scrollTop: target, duration: opts.duration || 0.30, ease: opts.ease || 'power2.out', overwrite: true });
  } else if (scroller.scrollTo) {
    scroller.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    scroller.scrollTop = target;
  }
}
// 给滚动容器绑定 GSAP 平滑滚轮。
function bindSmoothWheelScroll(scroller) {
  if (!scroller || scroller.__smoothWheelBound) return;
  // 防重复绑定标记。
  scroller.__smoothWheelBound = true;
  // 当前平滑滚动目标。
  var targetTop = scroller.scrollTop;
  // 当前滚动 tween。
  var tween = null;
  // 供外部同步目标滚动位置。
  scroller.__syncSmoothWheelTarget = function(top){
    if (tween) {
      tween.kill();
      tween = null;
    }
    targetTop = isFinite(top) ? top : scroller.scrollTop;
  };
  scroller.addEventListener('wheel', function(e){
    if (!window.gsap || e.ctrlKey) return;
    // 最大可滚动距离。
    var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (max <= 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    // 滚轮增量。
    var delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 18;
    else if (e.deltaMode === 2) delta *= scroller.clientHeight;
    // 当前滚动基准。
    var current = tween ? targetTop : scroller.scrollTop;
    // 下一个目标位置。
    var next = Math.max(0, Math.min(max, current + delta));
    if (next === current && ((delta < 0 && scroller.scrollTop <= 0) || (delta > 0 && scroller.scrollTop >= max - 1))) {
      targetTop = scroller.scrollTop;
      return;
    }
    e.preventDefault();
    targetTop = next;
    if (tween) tween.kill();
    // 平滑滚到目标位置。
    tween = window.gsap.to(scroller, {
      scrollTop: targetTop,
      duration: 0.24,
      ease: 'power2.out',
      overwrite: true,
      onComplete: function(){
        tween = null;
        targetTop = scroller.scrollTop;
      }
    });
  }, { passive: false });
  // 用户或脚本直接滚动时同步目标位置。
  scroller.addEventListener('scroll', function(){
    if (!tween) targetTop = scroller.scrollTop;
  }, { passive: true });
}
// 给队列相关面板绑定一次平滑滚轮。
function bindSmoothQueueScrolling() {
  if (smoothWheelScrollBound) return;
  // 全局防重复绑定标记。
  smoothWheelScrollBound = true;
  [
    'mini-queue-list',
    'fx-panel'
  ].forEach(function(id){
    bindSmoothWheelScroll(document.getElementById(id));
  });
}
// 设置底部迷你队列弹层打开状态。
function setMiniQueueOpen(open) {
  miniQueueOpen = !!open;
  // 迷你队列弹层。
  var pop = document.getElementById('mini-queue-popover');
  // 迷你队列按钮。
  var btn = document.getElementById('mini-queue-btn');
  if (pop) pop.classList.toggle('show', miniQueueOpen);
  if (btn) btn.classList.toggle('active', miniQueueOpen);
  if (miniQueueOpen) {
    // 弹层打开后在下一帧渲染队列，避免布局状态未更新。
    var seq = ++miniQueueRenderSeq;
    requestAnimationFrame(function(){
      if (seq !== miniQueueRenderSeq || !miniQueueOpen) return;
      renderMiniQueuePanel({ animate: true, scrollCurrent: true });
    });
    revealBottomControls(1300);
  }
}
// 切换迷你队列弹层。
function toggleMiniQueue(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  setMiniQueueOpen(!miniQueueOpen);
}
// 关闭迷你队列弹层。
function closeMiniQueue() {
  setMiniQueueOpen(false);
}
// 渲染底部迷你队列弹层。
function renderMiniQueuePanel(opts) {
  opts = opts || {};
  // 迷你队列列表节点。
  var $list = document.getElementById('mini-queue-list');
  // 迷你队列计数节点。
  var $count = document.getElementById('mini-queue-count');
  if (!$list || !$count) return;
  // 队列总数。
  var total = playQueue.length;
  $count.textContent = total ? (total + ' 首' + (currentIdx >= 0 ? ' · 正在播放 ' + (currentIdx + 1) : '')) : '0 首';
  if (!miniQueueOpen && !opts.animate && !opts.scrollCurrent) return;
  if (!total) {
    // 空队列占位。
    $list.innerHTML = '<div class="mini-queue-empty">队列为空</div>';
    return;
  }
  // 生成迷你队列 HTML。
  $list.innerHTML = playQueue.map(function(song, i){
    // 当前歌曲缩略封面。
    var thumb = songCoverSrc(song, 60);
    // 封面图片或占位块。
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div class="mini-queue-cover"></div>';
    return '<div class="mini-queue-item' + (i === currentIdx ? ' now' : '') + '" onclick="playQueueAt(' + i + ')">' +
      imgTag +
      '<div class="mini-queue-info"><div class="mini-queue-name">' + escHtml(song.name) + '</div><div class="mini-queue-sub">' + escHtml(song.artist || '') + '</div></div>' +
      '<button class="mini-queue-remove mini-queue-next" onclick="event.stopPropagation();requestHostPlayNextIndex(' + i + ')" title="下一首播放">下</button>' +
      '<button class="mini-queue-remove" onclick="event.stopPropagation();removeFromQueue(' + i + ')" title="移除">×</button>' +
    '</div>';
  }).join('');
  if (opts.animate || opts.scrollCurrent) {
    requestAnimationFrame(function(){
      // 弹层打开时播放可见项入场动画。
      if (opts.animate) animateListItems($list, '.mini-queue-item', { x: 0, y: 6, stagger: 0.01, duration: 0.20, limit: 16 });
      // 按需滚到当前播放项。
      if (opts.scrollCurrent) smoothScrollToItem($list, $list.querySelector('.mini-queue-item.now'), { duration: 0.30, align: 0.42 });
    });
  }
}
// 点击底部栏外部时关闭迷你队列。
document.addEventListener('click', function(e){
  if (miniQueueOpen && !(e.target && e.target.closest && e.target.closest('#bottom-bar'))) closeMiniQueue();
});
// 初始化队列相关滚动容器的平滑滚动。
bindSmoothQueueScrolling();
// 初始化通用弹层背景点击关闭逻辑。
bindModalBackdropClose();
// 进度条
// 归一化歌曲时长，兼容毫秒和秒两种单位。
function normalizePlaybackDurationSeconds(value) {
  // 原始时长数值。
  var raw = Number(value);
  if (!isFinite(raw) || raw <= 0) return 0;
  // 大于 1000 的值按毫秒处理。
  return raw > 1000 ? raw / 1000 : raw;
}
// 从歌曲对象读取播放时长。
function playbackDurationFromSong(song) {
  if (!song) return 0;
  return normalizePlaybackDurationSeconds(song.duration || song.durationMs || song.dt || 0);
}
// 获取当前播放总时长，优先使用 audio 元素真实时长。
function getPlaybackDurationSeconds() {
  if (audio && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return playbackDurationFromSong(currentCoverSong());
}
// 获取当前播放进度秒数。
function getPlaybackCurrentSeconds() {
  return audio && isFinite(audio.currentTime) && audio.currentTime > 0 ? audio.currentTime : 0;
}
// 设置进度条填充和滑块位置。
function setProgressVisual(percent) {
  // 进度百分比。
  percent = clampRange(percent || 0, 0, 100);
  // 进度填充节点。
  var fill = document.getElementById('progress-fill');
  // 进度滑块节点。
  var thumb = document.getElementById('progress-thumb');
  if (fill) fill.style.width = percent + '%';
  if (thumb) thumb.style.left = percent + '%';
}
// 刷新播放进度 UI。
function updatePlaybackProgressUi() {
  // 当前歌曲总时长。
  var durationSec = getPlaybackDurationSeconds();
  // 当前播放秒数。
  var currentSec = getPlaybackCurrentSeconds();
  if (durationSec > 0 && currentSec > durationSec) currentSec = durationSec;
  setProgressVisual(durationSec > 0 ? (currentSec / durationSec * 100) : 0);
  // 时间显示节点。
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay) timeDisplay.textContent = formatProgramTime(currentSec) + ' / ' + (durationSec > 0 ? formatProgramTime(durationSec) : '0:00');
}
// 本地刷新播放进度和歌词高亮状态，不向宿主请求数据。
setInterval(function(){
  if (!audio) { updatePlaybackProgressUi(); return; }
  updatePlaybackProgressUi();
  if (audio.currentTime) updateLyricsHighlight();
}, 200);

// ============================================================
//  控制台 — 预设卡片 + 主滑块 + 开关 + 三态
// ============================================================
// 视觉预设卡片的展示文案。
var presetMeta = [
  { name: 'emily专辑封面',  desc: '封面粒子 · 快速入场' },
  { name: '滚筒', desc: '隧道 · 沉浸感' },
  { name: '星球',  desc: '星球 · 雕塑感' },
  { name: '虚空', desc: '无粒子 · 自定义背景' },
  { name: '唱片', desc: '唱片 · 圆形封面' },
  { name: '星河', desc: '壁纸粒子 · 音乐律动' },
  { name: '安魂', desc: '骷髅·YUI7W', descHtml: '骷髅·<span class="pc-yui7w">YUI7W</span>' },
  { name: '音域回响', desc: 'Sonic Topography · 3D 地形' },
];
// 视觉预设卡片对应的 SVG 图标片段。
var presetIcons = [
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 14c3-2 5-2 8 0s5 2 8 0M3 10c3-2 5-2 8 0s5 2 8 0M3 18c3-2 5-2 8 0s5 2 8 0"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><path d="M5 12a7 7 0 0 0 14 0"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="7"/><path d="M8.8 8.8l6.4 6.4"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.4"/><path d="M16.5 5.2c2.1.9 3.4 2.4 4 4.5"/><path d="M18.8 3.2l1.5 4.8"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 15c2.2-4.4 4.4-4.4 6.6 0s4.4 4.4 6.6 0S20.6 10.6 23 15"/><path d="M3 9c2.2 2.2 4.4 2.2 6.6 0s4.4-2.2 6.6 0S20.6 11.2 23 9"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.2h4v6.2h4.2v3.8H14v7.6h-4v-7.6H5.8V9.4H10z"/></svg>',
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M2 12 L22 12 M12 2 L12 22 M6 6 L18 18 M6 18 L18 6" stroke-opacity="0.3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
];
// 控制台预设卡片展示顺序。
var presetDisplayOrder = [0, 6, 5, 4, 2, 1, 3, 7];
// 歌词颜色预设列表。
var lyricColorPresets = [
  { name:'雾蓝', color:'#a9b8c8' },
  { name:'银蓝', color:'#9db8cf' },
  { name:'冰川', color:'#7ec8d8' },
  { name:'青绿', color:'#66d2b5' },
  { name:'松针', color:'#7fa894' },
  { name:'月白', color:'#d7d2c4' },
  { name:'岩金', color:'#c3ae7c' },
  { name:'琥珀', color:'#d9a45f' },
  { name:'暮粉', color:'#c78aa4' },
  { name:'玫红', color:'#d76a8d' },
  { name:'烟紫', color:'#9b83d3' },
  { name:'电紫', color:'#8d70ff' },
  { name:'靛蓝', color:'#5e78d8' },
  { name:'海蓝', color:'#3c9fe0' },
  { name:'霓青', color:'#28c5c3' },
  { name:'夜绿', color:'#245c49' },
  { name:'酒红', color:'#6d1f35' },
  { name:'墨黑', color:'#111318' },
];
// 用户视觉存档数据库键。
var USER_FX_ARCHIVE_STORE_KEY = EPF_USER_FX_ARCHIVE_STORE_KEY;
// 用户视觉存档导出文件类型标记。
var USER_FX_ARCHIVE_EXPORT_TYPE = 'mineradio-user-fx-archive';
// 用户视觉存档结构版本。
var USER_FX_ARCHIVE_SCHEMA = 1;
// 生成默认用户视觉存档名。
function defaultUserFxArchiveName(index) {
  return '存档 ' + (index + 1);
}
// 归一化用户视觉存档名。
function normalizeUserFxArchiveName(name, index) {
  // 合并空白并去掉首尾空格。
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) name = defaultUserFxArchiveName(index);
  // 存档名最长 18 个字符。
  return name.slice(0, 18);
}
// 从存档对象读取数字字段并夹到指定范围。
function archiveNumber(raw, key, fallback, min, max) {
  // 原始字段值。
  var value = raw && raw[key] != null ? Number(raw[key]) : fallback;
  if (!isFinite(value)) value = fallback;
  return clampRange(value, min, max);
}
// 从存档对象读取枚举字段并用正则校验。
function archiveMode(raw, key, pattern, fallback) {
  // 原始枚举值。
  var value = String(raw && raw[key] != null ? raw[key] : fallback);
  return pattern.test(value) ? value : fallback;
}
// 归一化用户视觉存档快照，丢弃非法字段并补齐默认值。
function normalizeFxArchiveSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 存档中的视觉预设索引。
  var savedPreset = normalizeVisualPresetIndex(raw.preset, DEFAULT_PLAYBACK_VISUAL_PRESET);
  if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) savedPreset = 5;
  return {
    // 当前视觉预设 schema。
    visualPresetSchema: VISUAL_PRESET_SCHEMA,
    // 归一化后的视觉预设索引。
    preset: savedPreset,
    intensity: archiveNumber(raw, 'intensity', fxDefaults.intensity, 0.2, 1.6),
    cinemaShake: archiveNumber(raw, 'cinemaShake', fxDefaults.cinemaShake, 0, 1.8),
    depth: archiveNumber(raw, 'depth', fxDefaults.depth, 0.2, 1.8),
    coverResolution: normalizeCoverResolution(raw.coverResolution),
    point: archiveNumber(raw, 'point', fxDefaults.point, 0.5, 2.2),
    speed: archiveNumber(raw, 'speed', fxDefaults.speed, 0.2, 2.5),
    twist: archiveNumber(raw, 'twist', fxDefaults.twist, 0, 0.6),
    color: archiveNumber(raw, 'color', fxDefaults.color, 0.5, 2.0),
    scatter: archiveNumber(raw, 'scatter', fxDefaults.scatter, 0, 0.5),
    bgFade: archiveNumber(raw, 'bgFade', fxDefaults.bgFade, 0, 1.2),
    bloomStrength: archiveNumber(raw, 'bloomStrength', fxDefaults.bloomStrength, 0, 1.6),
    lyricGlowStrength: archiveNumber(raw, 'lyricGlowStrength', fxDefaults.lyricGlowStrength, 0, 0.85),
    lyricScale: archiveNumber(raw, 'lyricScale', fxDefaults.lyricScale, 0.35, 1.65),
    lyricOffsetX: archiveNumber(raw, 'lyricOffsetX', fxDefaults.lyricOffsetX, -2.0, 2.0),
    lyricOffsetY: archiveNumber(raw, 'lyricOffsetY', fxDefaults.lyricOffsetY, -1.2, 1.35),
    lyricOffsetZ: archiveNumber(raw, 'lyricOffsetZ', fxDefaults.lyricOffsetZ, -1.6, 1.6),
    lyricTiltX: archiveNumber(raw, 'lyricTiltX', fxDefaults.lyricTiltX, -42, 42),
    lyricTiltY: archiveNumber(raw, 'lyricTiltY', fxDefaults.lyricTiltY, -42, 42),
    lyricCameraLock: !!raw.lyricCameraLock,
    lyricDisplayMode: archiveMode(raw, 'lyricDisplayMode', /^(single|dual|triple|cinema|custom)$/, fxDefaults.lyricDisplayMode),
    lyricCustomLineCount: Math.round(archiveNumber(raw, 'lyricCustomLineCount', fxDefaults.lyricCustomLineCount, 1, 10)),
    lyricContextOpacity: archiveNumber(raw, 'lyricContextOpacity', fxDefaults.lyricContextOpacity, 0.25, 1),
    lyricContextSpread: archiveNumber(raw, 'lyricContextSpread', fxDefaults.lyricContextSpread, 0.60, 2.40),
    lyricTranslationMode: archiveMode(raw, 'lyricTranslationMode', /^(off|current|dual|multi)$/, fxDefaults.lyricTranslationMode),
    lyricTranslationGap: archiveNumber(raw, 'lyricTranslationGap', fxDefaults.lyricTranslationGap, 0.28, 2.20),
    lyricTranslationScale: archiveNumber(raw, 'lyricTranslationScale', fxDefaults.lyricTranslationScale, 0.46, 1.12),
    lyricTranslationOpacity: archiveNumber(raw, 'lyricTranslationOpacity', fxDefaults.lyricTranslationOpacity, 0.20, 1),
    lyricEdgeFade: archiveNumber(raw, 'lyricEdgeFade', fxDefaults.lyricEdgeFade, 0, 1),
    lyricColorMode: raw.lyricColorMode === 'custom' ? 'custom' : 'auto',
    lyricColor: normalizeHexColor(raw.lyricColor || fxDefaults.lyricColor),
    lyricHighlightMode: raw.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
    lyricHighlightColor: normalizeHexColor(raw.lyricHighlightColor || fxDefaults.lyricHighlightColor),
    lyricGlowLinked: raw.lyricGlowLinked !== false,
    lyricGlowColor: normalizeHexColor(raw.lyricGlowColor || fxDefaults.lyricGlowColor),
    lyricLetterSpacing: archiveNumber(raw, 'lyricLetterSpacing', fxDefaults.lyricLetterSpacing, -0.04, 0.18),
    lyricLineHeight: archiveNumber(raw, 'lyricLineHeight', fxDefaults.lyricLineHeight, 0.86, 1.35),
    lyricWeight: archiveNumber(raw, 'lyricWeight', fxDefaults.lyricWeight, 500, 900),
    lyricTimeOffset: normalizeLyricTimeOffset(raw.lyricTimeOffset),
    lyricFilterEnabled: raw.lyricFilterEnabled !== false,
    lyricFilterRegex: normalizeSavedLyricFilterRegex(raw.lyricFilterRegex),
    visualTintMode: raw.visualTintMode === 'custom' ? 'custom' : 'auto',
    visualTintColor: normalizeHexColor(raw.visualTintColor || fxDefaults.visualTintColor),
    uiAccentColor: normalizeHexColor(raw.uiAccentColor || fxDefaults.uiAccentColor, fxDefaults.uiAccentColor),
    visualIconColor: normalizeHexColor(raw.visualIconColor || fxDefaults.visualIconColor, fxDefaults.visualIconColor),
    backgroundColorMode: raw.backgroundColorMode === 'custom' || raw.backgroundColorCustom ? 'custom' : 'cover',
    backgroundColor: normalizeHexColor(raw.backgroundColor || fxDefaults.backgroundColor, fxDefaults.backgroundColor),
    backgroundOpacity: archiveNumber(raw, 'backgroundOpacity', fxDefaults.backgroundOpacity, 0, 1),
    backgroundColorCustom: raw.backgroundColorMode === 'custom' || !!raw.backgroundColorCustom,
    floatLayer: !!raw.floatLayer,
    cinema: raw.cinema !== false,
    edge: !!raw.edge,
    aiDepthMode: normalizeAIDepthMode(raw.aiDepthMode),
    aiDepthCloudApi: normalizeAIDepthCloudApi(raw.aiDepthCloudApi),
    bloom: !!raw.bloom,
    lyricGlow: raw.lyricGlow !== false,
    lyricGlowBeat: raw.lyricGlowBeat !== false,
    lyricGlowParticles: !!raw.lyricGlowParticles,
    performanceBackground: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true),
    performanceQuality: normalizePerformanceQuality(raw.performanceQuality),
    liveBackgroundKeep: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true) === 'keep',
    particleLyrics: raw.particleLyrics !== false,
    backCover: !!raw.backCover,
    shelf: archiveMode(raw, 'shelf', /^(off|side|stage)$/, fxDefaults.shelf),
    shelfCameraMode: archiveMode(raw, 'shelfCameraMode', /^(dynamic|static)$/, fxDefaults.shelfCameraMode),
    shelfPresence: archiveMode(raw, 'shelfPresence', /^(auto|always)$/, fxDefaults.shelfPresence),
    shelfSize: archiveNumber(raw, 'shelfSize', fxDefaults.shelfSize, 0.65, 1.45),
    shelfOffsetX: archiveNumber(raw, 'shelfOffsetX', fxDefaults.shelfOffsetX, -1.2, 1.2),
    shelfOffsetY: archiveNumber(raw, 'shelfOffsetY', fxDefaults.shelfOffsetY, -0.9, 0.9),
    shelfOffsetZ: archiveNumber(raw, 'shelfOffsetZ', fxDefaults.shelfOffsetZ, -0.9, 0.9),
    shelfAngleY: archiveNumber(raw, 'shelfAngleY', fxDefaults.shelfAngleY, -30, 30),
    shelfAngleYManual: raw.shelfAngleYManual === true,
    shelfOpacity: archiveNumber(raw, 'shelfOpacity', fxDefaults.shelfOpacity, 0.25, 1),
    shelfBgOpacity: archiveNumber(raw, 'shelfBgOpacity', fxDefaults.shelfBgOpacity, 0.25, 0.98),
    shelfAccentColor: normalizeHexColor(raw.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor)
  };
}
// 从宿主数据库快照读取用户视觉存档列表。
function readUserFxArchives() {
  // 原始存档数组。
  var raw = Array.isArray(persistedUserFxArchivesRaw) ? persistedUserFxArchivesRaw : [];
  if (!Array.isArray(raw)) raw = [];
  return raw.map(function(slot, index){
    // 单个存档槽原始对象。
    slot = slot && typeof slot === 'object' ? slot : {};
    // 归一化快照。
    var snapshot = normalizeFxArchiveSnapshot(slot.snapshot);
    return {
      name: normalizeUserFxArchiveName(slot.name, index),
      createdAt: Number(slot.createdAt) || (snapshot ? (Number(slot.savedAt) || Date.now()) : 0),
      savedAt: snapshot ? (Number(slot.savedAt) || Date.now()) : 0,
      snapshot: snapshot
    };
  }).filter(function(slot){
    // 过滤完全空的槽位。
    return !!(slot.snapshot || slot.savedAt || slot.createdAt);
  });
}
// 保存用户视觉存档列表到宿主数据库。
function saveUserFxArchives() {
  if (!hostUserFxArchivesLoaded) return;
  persistedUserFxArchivesRaw = userFxArchives.slice();
  hostStorageSet(USER_FX_ARCHIVE_STORE_KEY, userFxArchives).catch(function(){
    showToast('用户存档保存失败，插件数据库可能不可用');
  });
}
// 判断本机是否已经存在用户视觉存档。
function hasStoredUserFxArchives() {
  return Array.isArray(persistedUserFxArchivesRaw);
}
// 从打包默认快照创建初始用户存档槽。
function createPackagedDefaultUserFxArchiveSlot() {
  return {
    name: normalizeUserFxArchiveName(PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME, 0),
    createdAt: PACKAGED_DEFAULT_USER_FX_ARCHIVE_EXPORTED_AT,
    savedAt: PACKAGED_DEFAULT_USER_FX_ARCHIVE_SAVED_AT,
    snapshot: normalizeFxArchiveSnapshot(clonePackagedDefaultFxSnapshot())
  };
}
// 格式化用户存档保存时间。
function formatUserArchiveTime(ts) {
  ts = Number(ts) || 0;
  if (!ts) return '空槽位';
  // 距离当前时间的毫秒差。
  var diff = Date.now() - ts;
  if (diff < 60000) return '刚刚保存';
  if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  // 保存时间。
  var d = new Date(ts);
  // 两位数补零。
  function pad(v) { return String(v).padStart(2, '0'); }
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// 捕获当前 fx 为可保存的用户视觉快照。
function captureFxArchiveSnapshot() {
  return normalizeFxArchiveSnapshot(Object.assign({ visualPresetSchema: VISUAL_PRESET_SCHEMA }, fx));
}
// 应用已保存的歌词色板状态到舞台歌词。
function applySavedLyricPaletteState() {
  if (!stageLyrics) return;
  setStageLyricPalette(fx.lyricColorMode === 'custom'
    ? lyricPaletteFromHex(fx.lyricColor)
    : (stageLyrics.coverPalette || stageLyrics.palette));
  // 同步歌词颜色相关控件。
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
}
// 应用一个用户视觉存档快照。
function applyFxArchiveSnapshot(snapshot) {
  // 归一化后的存档数据。
  var data = normalizeFxArchiveSnapshot(snapshot);
  if (!data) return false;
  // 目标预设单独处理。
  var targetPreset = data.preset;
  Object.keys(data).forEach(function(key){
    if (key === 'visualPresetSchema' || key === 'preset') return;
    fx[key] = data[key];
  });
  // 保持开发锁相关状态合法。
  normalizeDevelopmentLockedFxState();
  setPreset(targetPreset, { silent: true, preserveCamera: false, skipTransition: false, noSave: true, commitPlaybackPreset: true });
  // 应用所有依赖存档字段的视觉模块。
  applyCoverParticleResolution(fx.coverResolution, { reload: true });
  if (fx.floatLayer) createFloatLayer(); else destroyFloatLayer();
  setParticleLyricsSilently(fx.particleLyrics);
  if (fx.backCover) createBackCoverLayer(); else destroyBackCoverLayer();
  if (isAIDepthEnabled()) {
    aiDepthFailUntil = 0;
    queueAIDepthForCurrentCover(true);
  }
  setShelfMode(fx.shelf);
  if (shelfManager && shelfManager.rebuild) shelfManager.rebuild(true);
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  updateFxInputs();
  applySavedLyricPaletteState();
  refreshCurrentLyricStyle();
  applyWallpaperModeState(true);
  updateRenderPowerClasses();
  applyRendererPowerMode();
  saveLyricLayout();
  return true;
}
// 当前用户视觉存档列表。
var userFxArchives = readUserFxArchives();
if (!userFxArchives.length) {
  // 数据库尚未返回或首次启动时先显示打包默认用户存档。
  userFxArchives = [createPackagedDefaultUserFxArchiveSlot()];
}
// 当前正在编辑名称的用户存档索引。
var userFxArchiveEditing = -1;
// 渲染用户视觉存档网格。
function renderUserFxArchives() {
  // 用户存档网格容器。
  var grid = document.getElementById('user-archive-grid');
  if (!grid) return;
  grid.innerHTML = userFxArchives.map(function(slot, index){
    // 当前槽位是否有快照。
    var hasSave = !!slot.snapshot;
    // 当前槽位是否正在改名。
    var editing = userFxArchiveEditing === index;
    // 名称区域 HTML。
    var nameHtml = editing
      ? '<input class="user-archive-input" id="user-archive-input-' + index + '" type="text" maxlength="18" value="' + escHtml(slot.name) + '" onkeydown="handleUserFxArchiveRenameKey(event,' + index + ')">'
      : '<div class="user-archive-name" title="' + escHtml(slot.name) + '">' + escHtml(slot.name) + '</div>';
    // 操作按钮 HTML。
    var actionsHtml = editing
      ? '<button type="button" onclick="commitUserFxArchiveRename(' + index + ')">确定</button>' +
        '<button type="button" onclick="cancelUserFxArchiveRename()">取消</button>'
      : '<button type="button" onclick="applyUserFxArchive(' + index + ')"' + (hasSave ? '' : ' disabled') + '>应用</button>' +
        '<button type="button" onclick="saveUserFxArchive(' + index + ')">保存</button>' +
        '<button type="button" onclick="renameUserFxArchive(' + index + ')">命名</button>';
    return '<div class="user-archive-slot' + (hasSave ? ' has-save' : '') + '" data-slot="' + index + '">' +
      nameHtml +
      '<div class="user-archive-meta">' + formatUserArchiveTime(slot.savedAt) + '</div>' +
      '<div class="user-archive-actions">' +
        actionsHtml +
      '</div>' +
    '</div>';
  }).join('');
  if (userFxArchiveEditing >= 0) {
    // 改名模式进入后自动聚焦输入框。
    setTimeout(function(){
      var input = document.getElementById('user-archive-input-' + userFxArchiveEditing);
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }
}
// 保存当前视觉状态到指定用户存档槽。
function saveUserFxArchive(index) {
  // 目标槽位索引。
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  userFxArchives[index].snapshot = captureFxArchiveSnapshot();
  userFxArchives[index].savedAt = Date.now();
  userFxArchives[index].name = normalizeUserFxArchiveName(userFxArchives[index].name, index);
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已保存到 ' + userFxArchives[index].name);
}
// 应用指定用户存档槽。
function applyUserFxArchive(index) {
  // 目标槽位索引。
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  // 目标槽位。
  var slot = userFxArchives[index];
  if (!slot || !slot.snapshot) {
    showToast('这个用户存档还是空的');
    return;
  }
  if (applyFxArchiveSnapshot(slot.snapshot)) {
    showToast('已应用 ' + slot.name);
  }
}
// 进入指定用户存档槽的改名状态。
function renameUserFxArchive(index) {
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  userFxArchiveEditing = index;
  renderUserFxArchives();
}
// 提交用户存档改名。
function commitUserFxArchiveRename(index) {
  index = clampRange(Number(index) || 0, 0, Math.max(0, userFxArchives.length - 1));
  // 改名输入框。
  var input = document.getElementById('user-archive-input-' + index);
  userFxArchives[index].name = normalizeUserFxArchiveName(input && input.value, index);
  userFxArchiveEditing = -1;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已命名为 ' + userFxArchives[index].name);
}
// 取消用户存档改名。
function cancelUserFxArchiveRename() {
  userFxArchiveEditing = -1;
  renderUserFxArchives();
}
// 处理用户存档改名输入框快捷键。
function handleUserFxArchiveRenameKey(e, index) {
  if (e.key === 'Enter') {
    // Enter 提交改名。
    e.preventDefault();
    commitUserFxArchiveRename(index);
  } else if (e.key === 'Escape') {
    // Escape 取消改名。
    e.preventDefault();
    cancelUserFxArchiveRename();
  }
}

// 生成用户存档默认名称；后续增强版允许超过 4 个存档。
function defaultUserFxArchiveName(index) {
  return '用户存档 ' + (Number(index) + 1);
}
// 归一化增强版用户存档名称。
function normalizeUserFxArchiveName(name, index) {
  // 合并连续空白并去掉首尾空格。
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) name = defaultUserFxArchiveName(index);
  // 增强版名称最长 28 个字符。
  return name.slice(0, 28);
}
// 按索引读取用户存档槽。
function userFxArchiveAt(index) {
  // 存档索引。
  index = Number(index);
  if (!isFinite(index)) return null;
  index = Math.floor(index);
  return index >= 0 && index < userFxArchives.length ? userFxArchives[index] : null;
}
// 渲染增强版用户视觉存档网格。
function renderUserFxArchives() {
  // 用户存档网格容器。
  var grid = document.getElementById('user-archive-grid');
  if (!grid) return;
  // 顶部工具栏 HTML。
  var toolbar =
    '<div class="user-archive-toolbar">' +
      '<div class="user-archive-note">空白新建，保存当前视觉参数；支持拖拽 JSON 导入，也可以导出为文件备份。</div>' +
      '<div class="user-archive-tools">' +
        '<button class="fx-mini-btn ghost" type="button" onclick="createUserFxArchive()">新建</button>' +
        '<button class="fx-mini-btn ghost" type="button" onclick="importUserFxArchiveFromDialog()">导入</button>' +
      '</div>' +
    '</div>';
  // 存档卡片 HTML。
  var cards = userFxArchives.map(function(slot, index){
    // 当前槽位是否有快照。
    var hasSave = !!slot.snapshot;
    // 当前槽位是否处于改名状态。
    var editing = userFxArchiveEditing === index;
    // 名称区 HTML。
    var nameHtml = editing
      ? '<input class="user-archive-input" id="user-archive-input-' + index + '" type="text" maxlength="28" value="' + escHtml(slot.name) + '" onkeydown="handleUserFxArchiveRenameKey(event,' + index + ')">'
      : '<div class="user-archive-name" title="' + escHtml(slot.name) + '">' + escHtml(slot.name) + '</div>';
    // 操作按钮 HTML。
    var actionsHtml = editing
      ? '<button type="button" onclick="commitUserFxArchiveRename(' + index + ')">确定</button>' +
        '<button type="button" onclick="cancelUserFxArchiveRename()">取消</button>'
      : '<button type="button" onclick="applyUserFxArchive(' + index + ')"' + (hasSave ? '' : ' disabled') + '>应用</button>' +
        '<button type="button" onclick="saveUserFxArchive(' + index + ')">保存</button>' +
        '<button type="button" onclick="renameUserFxArchive(' + index + ')">命名</button>' +
        '<button type="button" onclick="exportUserFxArchive(' + index + ')"' + (hasSave ? '' : ' disabled') + '>导出</button>' +
        '<button type="button" onclick="removeUserFxArchive(' + index + ')">删除</button>';
    return '<div class="user-archive-slot' + (hasSave ? ' has-save' : '') + '" data-slot="' + index + '">' +
      nameHtml +
      '<div class="user-archive-meta">' + (hasSave ? formatUserArchiveTime(slot.savedAt) : '空白存档，点击保存写入当前视觉') + '</div>' +
      '<div class="user-archive-actions">' + actionsHtml + '</div>' +
    '</div>';
  }).join('');
  // 新建空白存档卡片。
  var addCard = '<button class="user-archive-slot is-new" type="button" onclick="createUserFxArchive()"><strong>＋ 新建空白存档</strong><span class="user-archive-meta">可继续创建，不限制 4 个</span></button>';
  grid.innerHTML = toolbar + cards + addCard;
  bindUserFxArchiveDrop();
  if (userFxArchiveEditing >= 0) {
    // 改名模式下自动聚焦输入框。
    setTimeout(function(){
      var input = document.getElementById('user-archive-input-' + userFxArchiveEditing);
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }
}
// 创建一个新的空白用户视觉存档。
function createUserFxArchive() {
  // 新存档索引。
  var index = userFxArchives.length;
  userFxArchives.push({
    name: normalizeUserFxArchiveName('', index),
    createdAt: Date.now(),
    savedAt: 0,
    snapshot: null
  });
  userFxArchiveEditing = index;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已新建空白用户存档');
}
// 保存当前视觉参数到指定存档槽。
function saveUserFxArchive(index) {
  // 目标存档槽。
  var slot = userFxArchiveAt(index);
  if (!slot) return;
  slot.snapshot = captureFxArchiveSnapshot();
  slot.savedAt = Date.now();
  slot.createdAt = slot.createdAt || slot.savedAt;
  slot.name = normalizeUserFxArchiveName(slot.name, index);
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已保存到 ' + slot.name);
}
// 应用指定用户存档。
function applyUserFxArchive(index) {
  // 目标存档槽。
  var slot = userFxArchiveAt(index);
  if (!slot || !slot.snapshot) {
    showToast('这个用户存档还是空白');
    return;
  }
  if (applyFxArchiveSnapshot(slot.snapshot)) showToast('已应用 ' + slot.name);
}
// 进入指定用户存档的改名状态。
function renameUserFxArchive(index) {
  if (!userFxArchiveAt(index)) return;
  userFxArchiveEditing = Math.floor(Number(index) || 0);
  renderUserFxArchives();
}
// 提交增强版用户存档改名。
function commitUserFxArchiveRename(index) {
  // 目标存档槽。
  var slot = userFxArchiveAt(index);
  if (!slot) return;
  // 改名输入框。
  var input = document.getElementById('user-archive-input-' + index);
  slot.name = normalizeUserFxArchiveName(input && input.value, index);
  slot.createdAt = slot.createdAt || Date.now();
  userFxArchiveEditing = -1;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已命名为 ' + slot.name);
}
// 取消增强版用户存档改名。
function cancelUserFxArchiveRename() {
  userFxArchiveEditing = -1;
  renderUserFxArchives();
}
// 删除指定用户存档。
function removeUserFxArchive(index) {
  if (!userFxArchiveAt(index)) return;
  userFxArchives.splice(index, 1);
  userFxArchiveEditing = -1;
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已删除用户存档');
}
// 构建用户存档导出载荷。
function userFxArchiveExportPayload(slot) {
  return {
    type: USER_FX_ARCHIVE_EXPORT_TYPE,
    schema: USER_FX_ARCHIVE_SCHEMA,
    exportedAt: Date.now(),
    name: slot.name,
    savedAt: slot.savedAt,
    snapshot: slot.snapshot
  };
}
// 生成安全的用户存档导出文件名。
function safeArchiveFileName(name) {
  return String(name || 'Mineradio 用户存档').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 48) + '.json';
}
// 将指定用户存档导出为 JSON 文件。
function exportUserFxArchive(index) {
  // 目标存档槽。
  var slot = userFxArchiveAt(index);
  if (!slot || !slot.snapshot) {
    showToast('空白存档不能导出');
    return;
  }
  // 导出载荷。
  var payload = userFxArchiveExportPayload(slot);
  // 格式化后的 JSON 文本。
  var text = JSON.stringify(payload, null, 2);
  // JSON Blob。
  var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  // 临时下载 URL。
  var url = URL.createObjectURL(blob);
  // 临时下载链接。
  var a = document.createElement('a');
  a.href = url;
  a.download = safeArchiveFileName(slot.name);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}
// 归一化导入的用户存档 JSON 载荷。
function normalizeImportedFxArchivePayload(payload, fileName) {
  if (!payload || typeof payload !== 'object') return null;
  // 导入文件可直接是快照，也可以是带 snapshot 的导出包。
  var snapshot = payload.snapshot ? normalizeFxArchiveSnapshot(payload.snapshot) : normalizeFxArchiveSnapshot(payload);
  if (!snapshot) return null;
  // 文件名作为名称兜底。
  var baseName = String(fileName || '').split(/[\\/]/).pop().replace(/\.json$/i, '');
  return {
    name: normalizeUserFxArchiveName(payload.name || baseName, userFxArchives.length),
    createdAt: Date.now(),
    savedAt: Number(payload.savedAt) || Date.now(),
    snapshot: snapshot
  };
}
// 从 JSON 文本导入用户视觉存档。
function importUserFxArchiveText(text, fileName) {
  // 解析后的 JSON 对象。
  var payload = null;
  try { payload = JSON.parse(String(text || '')); } catch (e) {}
  // 归一化后的存档槽。
  var slot = normalizeImportedFxArchivePayload(payload, fileName);
  if (!slot) {
    showToast('导入失败，文件不是有效的用户存档');
    return false;
  }
  userFxArchives.push(slot);
  saveUserFxArchives();
  renderUserFxArchives();
  showToast('已导入 ' + slot.name);
  return true;
}
// 打开系统文件选择框导入用户视觉存档。
function importUserFxArchiveFromDialog() {
  // 临时文件输入。
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = function(){
    // 用户选择的文件。
    var file = input.files && input.files[0];
    if (file) readUserFxArchiveImportFile(file);
  };
  input.click();
}
// 读取并导入用户视觉存档文件。
function readUserFxArchiveImportFile(file) {
  if (!file || !/\.json$/i.test(file.name || '')) {
    showToast('请导入 JSON 用户存档');
    return;
  }
  // 文件读取器。
  var reader = new FileReader();
  reader.onload = function(e){ importUserFxArchiveText(e.target && e.target.result, file.name); };
  reader.onerror = function(){ showToast('导入失败'); };
  reader.readAsText(file, 'utf-8');
}
// 给用户存档网格绑定拖拽导入。
function bindUserFxArchiveDrop() {
  // 用户存档网格容器。
  var grid = document.getElementById('user-archive-grid');
  if (!grid || grid._archiveDropBound) return;
  // 防重复绑定标记。
  grid._archiveDropBound = true;
  grid.addEventListener('dragover', function(e){
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    grid.classList.add('dragover');
  });
  grid.addEventListener('dragleave', function(e){
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('dragover');
  });
  grid.addEventListener('drop', function(e){
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    grid.classList.remove('dragover');
    // 支持一次拖入多个 JSON 文件。
    Array.prototype.forEach.call(e.dataTransfer.files, readUserFxArchiveImportFile);
  });
}

// 构建歌词颜色选择控件。
function buildLyricColorControls() {
  // 歌词颜色色板容器。
  var grid = document.getElementById('lyric-color-grid');
  if (!grid) return;
  // 自动取色按钮 HTML。
  var html = '<button class="lyric-swatch auto" type="button" data-auto="1" onclick="setLyricColorAuto()" title="封面取色">AUTO</button>';
  html += lyricColorPresets.map(function(p, i){
    return '<button class="lyric-swatch" type="button" data-color="' + p.color + '" onclick="setLyricColorPreset(' + i + ')" title="' + escHtml(p.name) + '" style="--swatch:' + p.color + '"></button>';
  }).join('');
  grid.innerHTML = html;
}
// 刷新歌词主色控件状态。
function updateLyricColorControls() {
  // 歌词颜色 input。
  var picker = document.getElementById('lyric-color-picker');
  // 歌词颜色显示文本。
  var value = document.getElementById('lyric-color-value');
  // 自动取色按钮。
  var autoBtn = document.getElementById('lyric-auto-btn');
  // 当前歌词颜色。
  var color = normalizeHexColor(fx.lyricColor);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.lyricColorMode === 'custom' ? color.toUpperCase() : '封面取色';
  if (autoBtn) autoBtn.classList.toggle('active', fx.lyricColorMode !== 'custom');
  document.querySelectorAll('.lyric-swatch').forEach(function(btn){
    // 当前色块是否为自动色块。
    var isAuto = btn.dataset.auto === '1';
    // 当前色块颜色是否匹配自定义颜色。
    var isColor = normalizeHexColor(btn.dataset.color || '') === color;
    btn.classList.toggle('active', isAuto ? fx.lyricColorMode !== 'custom' : (fx.lyricColorMode === 'custom' && isColor));
  });
}
// 刷新歌词高亮色控件状态。
function updateLyricHighlightControls() {
  // 高亮色 input。
  var picker = document.getElementById('lyric-highlight-picker');
  // 高亮色显示文本。
  var value = document.getElementById('lyric-highlight-value');
  // 高亮自动按钮。
  var autoBtn = document.getElementById('lyric-highlight-auto-btn');
  // 当前高亮颜色。
  var color = normalizeHexColor(fx.lyricHighlightColor);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.lyricHighlightMode === 'custom' ? color.toUpperCase() : '跟随歌词';
  if (autoBtn) autoBtn.classList.toggle('active', fx.lyricHighlightMode !== 'custom');
}
// 刷新歌词溢光颜色控件状态。
function updateLyricGlowControls() {
  // 溢光设置行。
  var row = document.getElementById('lyric-glow-row');
  // 溢光颜色 input。
  var picker = document.getElementById('lyric-glow-picker');
  // 溢光颜色显示文本。
  var value = document.getElementById('lyric-glow-value');
  // 溢光链接按钮。
  var linkBtn = document.getElementById('lyric-glow-link-btn');
  // 溢光颜色是否跟随高亮。
  var linked = fx.lyricGlowLinked !== false;
  // 当前溢光颜色。
  var color = normalizeHexColor(fx.lyricGlowColor || '#9db8cf');
  if (picker) picker.value = color;
  if (row) row.classList.toggle('linked', linked);
  if (value) value.textContent = linked ? '跟随高亮' : color.toUpperCase();
  if (linkBtn) {
    linkBtn.classList.toggle('active', linked);
    linkBtn.textContent = linked ? '链接' : '独立';
    linkBtn.title = linked ? '点击后单独设置溢光颜色' : '点击后让溢光跟随高亮';
  }
}
// 将视觉图标颜色写入 CSS 变量。
function applyIconAccentColors() {
  // 当前视觉图标颜色。
  var visualColor = normalizeHexColor(fx.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  // 图标颜色 RGB。
  var visualRgb = hexToRgb(visualColor);
  // 文档根节点。
  var root = document.documentElement;
  root.style.setProperty('--visual-icon-color', visualColor);
  root.style.setProperty('--visual-icon-rgb', visualRgb.r + ',' + visualRgb.g + ',' + visualRgb.b);
}
// 刷新视觉图标颜色控件。
function updateIconAccentControls() {
  applyIconAccentColors();
  // 当前视觉图标颜色。
  var visualColor = normalizeHexColor(fx.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  // 视觉图标颜色选择器。
  var visualPicker = document.getElementById('visual-icon-picker');
  // 视觉图标颜色文本。
  var visualValue = document.getElementById('visual-icon-value');
  if (visualPicker) visualPicker.value = visualColor;
  if (visualValue) visualValue.textContent = visualColor.toUpperCase();
}
// 设置视觉图标颜色。
function setVisualIconColor(color, silent) {
  fx.visualIconColor = normalizeHexColor(color || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  updateIconAccentControls();
  saveLyricLayout();
  if (!silent) showToast('视觉图标: ' + fx.visualIconColor.toUpperCase());
}
// 重置视觉图标颜色为默认值。
function resetVisualIconColor() {
  setVisualIconColor(fxDefaults.visualIconColor || '#7fd8ff');
}
// 应用自定义背景颜色、图片或视频。
function applyCustomBackground() {
  // 背景纯色。
  var color = normalizeHexColor(fx.backgroundColor || '#000000', '#000000');
  // 归一化后的背景媒体。
  var media = normalizeCustomBackgroundMedia(fx.backgroundMedia || fx.backgroundImage);
  // 背景图片地址。
  var image = media && media.type === 'image' ? (media.resolvedUrl || media.src || '') : '';
  // 是否为背景视频。
  var hasVideo = !!(media && media.type === 'video');
  // 背景媒体透明度。
  var opacity = clampRange(fx.backgroundOpacity == null ? 1 : Number(fx.backgroundOpacity), 0, 1);
  // 是否启用自定义颜色。
  var customColor = fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom;
  // 是否需要覆盖默认封面背景。
  var override = !!media || customColor || opacity < 1;
  // 文档根节点。
  var root = document.documentElement;
  // 自定义背景图层。
  var layer = document.getElementById('custom-bg');
  // 自定义背景视频节点。
  var video = document.getElementById('custom-bg-video');
  root.style.setProperty('--custom-bg-color', color);
  document.body.classList.toggle('custom-background-override', override);
  document.body.classList.toggle('custom-background-flat', override && !media);
  document.body.classList.toggle('custom-background-video', hasVideo);
  if (layer) {
    // 背景图层的 CSS 变量。
    layer.style.setProperty('--custom-bg-image', image ? 'url("' + cssImageUrl(image) + '")' : 'none');
    layer.style.setProperty('--custom-bg-image-opacity', image ? opacity.toFixed(3) : '0');
    layer.style.setProperty('--custom-bg-video-opacity', hasVideo ? opacity.toFixed(3) : '0');
    layer.style.setProperty('--custom-bg-overlay-opacity', media ? '0.18' : '0');
  }
  // 背景视频应用 token，防止异步 blob 结果串写。
  var token = ++customBgApplyToken;
  if (media && media.path && !media.resolvedUrl && !media.src) {
    resolveCustomBackgroundMedia(media).then(function(resolved){
      if (token !== customBgApplyToken || !resolved || !resolved.resolvedUrl) return;
      fx.backgroundMedia = resolved;
      if (resolved.type === 'image') fx.backgroundImage = resolved.resolvedUrl;
      applyCustomBackground();
    });
  }
  if (!video) return;
  if (!hasVideo) {
    // 没有视频时停止并清理 video 节点。
    video.pause();
    video.removeAttribute('src');
    video.load();
    return;
  }
  // 设置背景视频 src 并尝试播放。
  function setVideoSrc(src) {
    if (token !== customBgApplyToken || !src) return;
    if (video.getAttribute('src') !== src) {
      video.setAttribute('src', src);
      video.load();
    }
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    var p = video.play();
    if (p && p.catch) p.catch(function(){});
  }
  setVideoSrc(media.resolvedUrl || media.src || '');
}
// 刷新自定义背景相关控件。
function updateCustomBackgroundControls() {
  applyCustomBackground();
  // 当前背景颜色。
  var color = normalizeHexColor(fx.backgroundColor || '#000000', '#000000');
  // 背景颜色选择器。
  var picker = document.getElementById('bg-color-picker');
  // 背景颜色文本。
  var value = document.getElementById('bg-color-value');
  // 背景媒体文本。
  var imageValue = document.getElementById('bg-image-value');
  // 是否处于自定义颜色模式。
  var customColor = fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom;
  if (picker) picker.value = color;
  if (value) value.textContent = customColor ? color.toUpperCase() : '\u5c01\u9762\u6e10\u53d8';
  if (picker && picker.closest) {
    // 给控件行打上封面模式状态。
    var row = picker.closest('.lyric-color-row');
    if (row) row.classList.toggle('bg-cover-mode', !customColor);
  }
  setRange('fx-bgopacity', fx.backgroundOpacity == null ? 1 : fx.backgroundOpacity);
  if (imageValue) imageValue.textContent = customBackgroundMediaLabel(fx.backgroundMedia || fx.backgroundImage);
  applyBackgroundMediaHint();
}
// 设置自定义背景颜色。
function setCustomBackgroundColor(color, silent, customFlag) {
  fx.backgroundColor = normalizeHexColor(color || '#000000', '#000000');
  fx.backgroundColorMode = customFlag === false ? 'cover' : 'custom';
  fx.backgroundColorCustom = customFlag !== false;
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast('背景颜色: ' + fx.backgroundColor.toUpperCase());
}
// 将背景颜色模式恢复为封面渐变。
function setCustomBackgroundCoverMode(silent) {
  fx.backgroundColorMode = 'cover';
  fx.backgroundColorCustom = false;
  fx.backgroundColor = normalizeHexColor(fx.backgroundColor || fxDefaults.backgroundColor || '#000000', '#000000');
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast('\u80cc\u666f\u989c\u8272: \u5c01\u9762\u6e10\u53d8');
}
// 重置自定义背景颜色。
function resetCustomBackgroundColor() {
  setCustomBackgroundCoverMode(false);
}
// 设置自定义背景透明度。
function setCustomBackgroundOpacity(value, silent) {
  fx.backgroundOpacity = clampRange(Number(value), 0, 1);
  fx.backgroundColorMode = 'custom';
  fx.backgroundColorCustom = true;
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast('背景透明度: ' + Math.round(fx.backgroundOpacity * 100) + '%');
}
// 设置自定义背景图片。
function setCustomBackgroundImage(src, silent) {
  // 归一化后的图片地址。
  var image = normalizeCustomBackgroundImage(src);
  fx.backgroundImage = image;
  fx.backgroundMedia = image ? { type: 'image', src: image } : null;
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast(fx.backgroundImage ? '背景图片已应用' : '背景图片已清除');
}
// 清除自定义背景图片。
function clearCustomBackgroundImage() {
  setCustomBackgroundImage('');
}
// 设置自定义背景媒体，兼容图片和视频。
function setCustomBackgroundMedia(media, silent) {
  media = normalizeCustomBackgroundMedia(media);
  fx.backgroundMedia = media;
  fx.backgroundImage = media && media.type === 'image' ? media.src : '';
  updateCustomBackgroundControls();
  saveLyricLayout();
  if (!silent) showToast(media ? (media.type === 'video' ? '背景视频已应用' : '背景图片已应用') : '背景媒体已清除');
}
// 旧文件输入入口保留为兼容壳，实际选择交给宿主文件选择器。
function readBackgroundMediaFile(file) {
  void file;
  selectCustomBackgroundMedia();
}
// 将 UI 强调色写入 CSS 变量。
function applyUiAccentColor() {
  // 当前 UI 强调色。
  var color = normalizeHexColor(fx.uiAccentColor || '#00f5d4', '#00f5d4');
  // 强调色 RGB。
  var rgb = hexToRgb(color);
  // 文档根节点。
  var root = document.documentElement;
  root.style.setProperty('--fc-accent', color);
  root.style.setProperty('--fc-accent-hov', color);
  root.style.setProperty('--fc-accent-rgb', rgb.r + ',' + rgb.g + ',' + rgb.b);
  root.style.setProperty('--glass-border', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.30)');
  root.style.setProperty('--glass-shadow-focus', '0 24px 72px rgba(0,0,0,.34),0 0 0 1px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.13),0 0 42px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.075),inset 0 1px 0 rgba(255,255,255,.20)');
}
// 刷新 UI 强调色控件。
function updateUiAccentControls() {
  applyUiAccentColor();
  // 当前 UI 强调色。
  var color = normalizeHexColor(fx.uiAccentColor || '#00f5d4', '#00f5d4');
  // UI 强调色选择器。
  var picker = document.getElementById('ui-accent-picker');
  // UI 强调色文本。
  var value = document.getElementById('ui-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = color.toUpperCase();
}
// 设置 UI 强调色。
function setUiAccentColor(color, silent) {
  fx.uiAccentColor = normalizeHexColor(color || '#00f5d4', '#00f5d4');
  updateUiAccentControls();
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  saveLyricLayout();
  if (!silent) showToast('界面高亮: ' + fx.uiAccentColor.toUpperCase());
}
// 重置 UI 强调色。
function resetUiAccentColor() {
  setUiAccentColor(fxDefaults.uiAccentColor || '#00f5d4');
}
// 刷新视觉主色控件。
function updateVisualTintControls() {
  // 视觉主色选择器。
  var picker = document.getElementById('visual-tint-picker');
  // 视觉主色文本。
  var value = document.getElementById('visual-tint-value');
  // 自动取色按钮。
  var autoBtn = document.getElementById('visual-tint-auto-btn');
  // 当前视觉主色。
  var color = normalizeHexColor(fx.visualTintColor || '#9db8cf');
  document.documentElement.style.setProperty('--visual-tint', color);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.visualTintMode === 'custom' ? color.toUpperCase() : '封面取色';
  if (autoBtn) autoBtn.classList.toggle('active', fx.visualTintMode !== 'custom');
}
// 设置视觉主色为封面自动取色。
function setVisualTintAuto() {
  fx.visualTintMode = 'auto';
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout();
  showToast('视觉主色: 封面取色');
}
// 重置视觉主色为默认自动模式。
function resetVisualTintColor() {
  fx.visualTintMode = 'auto';
  fx.visualTintColor = normalizeHexColor(fxDefaults.visualTintColor || '#9db8cf');
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout();
  showToast('视觉主色已恢复默认');
}
// 设置自定义视觉主色。
function setVisualTintCustom(color, silent) {
  fx.visualTintMode = 'custom';
  fx.visualTintColor = normalizeHexColor(color || '#9db8cf');
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout();
  if (!silent) showToast('视觉主色: ' + fx.visualTintColor.toUpperCase());
}
// 封面取色器状态。
var coverColorPickerState = { target: 'visualTint', canvas: null };
// 获取当前可用于取色的封面 canvas。
function currentCoverPickerCanvas() {
  if (coverPickerCanvas && coverPickerCanvas.getContext) return coverPickerCanvas;
  if (coverTex && coverTex.image && coverTex.image.getContext) return coverTex.image;
  return null;
}
// 生成封面取色器推荐色块。
function coverPickerSwatchColors() {
  // 当前舞台歌词色板。
  var pal = stageLyrics.coverPalette || stageLyrics.palette || {};
  // 候选颜色列表。
  var list = [pal.primary, pal.secondary, pal.highlight, fx.visualTintColor, fx.uiAccentColor]
    .map(function(c){ return normalizeHexColor(c || '', ''); })
    .filter(function(c){ return /^#[0-9a-f]{6}$/i.test(c); });
  // 去重表。
  var seen = {};
  return list.filter(function(c){
    if (seen[c]) return false;
    seen[c] = true;
    return true;
  }).slice(0, 5);
}
// 设置封面取色器预览颜色。
function setCoverPickerPreview(hex) {
  // 取色预览节点。
  var preview = document.getElementById('cover-color-preview');
  if (preview) preview.style.setProperty('--picked', normalizeHexColor(hex || '#9db8cf'));
}
// 渲染封面取色器推荐色块。
function renderCoverPickerSwatches() {
  // 推荐色块容器。
  var wrap = document.getElementById('cover-color-swatches');
  if (!wrap) return;
  // 推荐颜色列表。
  var colors = coverPickerSwatchColors();
  wrap.innerHTML = colors.map(function(c){
    return '<button type="button" style="--c:' + c + '" title="' + c.toUpperCase() + '" onclick="applyCoverPickerColor(\'' + c + '\')"></button>';
  }).join('');
}
// 打开封面取色器。
function openCoverColorPicker(target) {
  // 目标颜色字段。
  target = target || 'visualTint';
  // 取色器弹层。
  var pop = document.getElementById('cover-color-pop');
  // 封面预览区域。
  var art = document.getElementById('cover-color-art');
  // 提示文本节点。
  var hint = document.getElementById('cover-color-hint');
  if (pop && pop.classList.contains('show') && coverColorPickerState.target === target) {
    closeCoverColorPicker();
    return;
  }
  // 当前可取色封面 canvas。
  var cv = currentCoverPickerCanvas();
  coverColorPickerState.target = target;
  coverColorPickerState.canvas = cv;
  if (!pop || !art) return;
  if (!cv) {
    // 没有封面 canvas 时回退自动取色。
    setVisualTintAuto();
    closeCoverColorPicker();
    showToast('暂无封面，已切换为自动封面取色');
    return;
  }
  // 封面预览图片地址。
  var imgSrc = '';
  try { imgSrc = cv.toDataURL('image/jpeg', 0.84); } catch (e) {}
  if (!imgSrc && currentCoverSource && currentCoverSource.src) imgSrc = currentCoverSource.src;
  art.style.backgroundImage = imgSrc ? 'url("' + cssImageUrl(imgSrc) + '")' : '';
  setCoverPickerPreview(fx.visualTintColor || (stageLyrics.coverPalette && stageLyrics.coverPalette.primary) || '#9db8cf');
  renderCoverPickerSwatches();
  if (hint) hint.textContent = '点击专辑封面任意位置取色，或使用下方推荐色。';
  pop.classList.add('show');
  placeFxFloatingPanel(pop, document.getElementById('visual-tint-auto-btn') || document.getElementById('visual-tint-picker') || art, { gap: 12, pad: 14 });
}
// 关闭封面取色器。
function closeCoverColorPicker() {
  // 取色器弹层。
  var pop = document.getElementById('cover-color-pop');
  if (pop) pop.classList.remove('show');
  hideCoverColorLoupe();
}
// 应用封面取色器选择的颜色。
function applyCoverPickerColor(hex) {
  hex = normalizeHexColor(hex || '#9db8cf');
  setCoverPickerPreview(hex);
  if (coverColorPickerState.target === 'visualTint') {
    // 当前只将取色结果应用到视觉主色。
    setVisualTintCustom(hex, true);
    showToast('视觉主色: ' + hex.toUpperCase());
  }
  closeCoverColorPicker();
}
// 移动封面取色放大镜。
function moveCoverColorLoupe(e) {
  // 当前取色 canvas。
  var cv = coverColorPickerState.canvas || currentCoverPickerCanvas();
  // 放大镜节点。
  var loupe = document.getElementById('cover-color-loupe');
  // 封面预览节点。
  var art = document.getElementById('cover-color-art');
  if (!cv || !loupe || !art) return;
  // 封面预览区域尺寸。
  var rect = art.getBoundingClientRect();
  // 归一化 X。
  var x = clampRange((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  // 归一化 Y。
  var y = clampRange((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  // 放大镜背景图。
  var imgSrc = '';
  try { imgSrc = cv.toDataURL('image/jpeg', 0.84); } catch (err) {}
  if (imgSrc) {
    loupe.style.backgroundImage = 'url("' + cssImageUrl(imgSrc) + '")';
    loupe.style.backgroundSize = '680% 680%';
    loupe.style.backgroundPosition = (x * 100).toFixed(2) + '% ' + (y * 100).toFixed(2) + '%';
  }
  loupe.style.left = Math.min(window.innerWidth - 128, e.clientX + 18) + 'px';
  loupe.style.top = Math.min(window.innerHeight - 128, e.clientY + 18) + 'px';
  loupe.classList.add('show');
}
// 隐藏封面取色放大镜。
function hideCoverColorLoupe() {
  var loupe = document.getElementById('cover-color-loupe');
  if (loupe) loupe.classList.remove('show');
}
// 从封面预览点击位置读取像素颜色。
function pickCoverColorFromArt(e) {
  // 当前取色 canvas。
  var cv = coverColorPickerState.canvas || currentCoverPickerCanvas();
  if (!cv || !cv.getContext) return;
  // 点击目标区域。
  var rect = e.currentTarget.getBoundingClientRect();
  // 点击归一化 X。
  var x = clampRange((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  // 点击归一化 Y。
  var y = clampRange((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  // canvas 像素 X。
  var sx = Math.max(0, Math.min(cv.width - 1, Math.floor(x * cv.width)));
  // canvas 像素 Y。
  var sy = Math.max(0, Math.min(cv.height - 1, Math.floor(y * cv.height)));
  try {
    // 读取单像素 RGB。
    var data = cv.getContext('2d').getImageData(sx, sy, 1, 1).data;
    applyCoverPickerColor(rgbToHexColor(data[0], data[1], data[2]));
  } catch (err) {
    showToast('封面取色不可用，已保留自动取色');
    setVisualTintAuto();
    closeCoverColorPicker();
  }
}
// 设置歌词溢光是否跟随高亮色。
function setLyricGlowLinked(linked, openPicker) {
  fx.lyricGlowLinked = linked !== false;
  if (!fx.lyricGlowLinked) fx.lyricGlowColor = normalizeHexColor(fx.lyricGlowColor || fx.lyricHighlightColor || '#9db8cf');
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricGlowControls();
  saveLyricLayout();
  if (openPicker) {
    // 解除链接后自动打开颜色选择器。
    setTimeout(function(){
      var picker = document.getElementById('lyric-glow-picker');
      if (picker) picker.click();
    }, 0);
  }
}
// 切换歌词溢光链接状态。
function toggleLyricGlowLink(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  setLyricGlowLinked(fx.lyricGlowLinked === false);
}
// 点击溢光设置行时，如果仍跟随高亮则切换到独立颜色。
function handleLyricGlowRowClick(e) {
  if (fx.lyricGlowLinked !== false) {
    if (e && e.preventDefault) e.preventDefault();
    setLyricGlowLinked(false, true);
  }
}
// 设置自定义歌词溢光颜色。
function setLyricGlowCustom(color, silent) {
  fx.lyricGlowLinked = false;
  fx.lyricGlowColor = normalizeHexColor(color || '#9db8cf');
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricGlowControls();
  saveLyricLayout();
  if (!silent) showToast('溢光颜色: ' + fx.lyricGlowColor.toUpperCase());
}
// 设置歌词主色为封面自动取色。
function setLyricColorAuto() {
  fx.lyricColorMode = 'auto';
  setStageLyricPalette(stageLyrics.coverPalette || stageLyrics.palette);
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  showToast('歌词颜色: 封面取色');
}
// 设置自定义歌词主色。
function setLyricColorCustom(color, silent) {
  fx.lyricColorMode = 'custom';
  fx.lyricColor = normalizeHexColor(color);
  setStageLyricPalette(lyricPaletteFromHex(fx.lyricColor));
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  if (!silent) showToast('歌词颜色: ' + fx.lyricColor.toUpperCase());
}
// 从预设色板中选择歌词主色。
function setLyricColorPreset(i) {
  // 目标预设色。
  var p = lyricColorPresets[i];
  if (!p) return;
  setLyricColorCustom(p.color);
}
// 设置歌词高亮色为跟随歌词。
function setLyricHighlightAuto() {
  fx.lyricHighlightMode = 'auto';
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  showToast('高亮颜色: 跟随歌词');
}
// 设置自定义歌词高亮色。
function setLyricHighlightCustom(color, silent) {
  fx.lyricHighlightMode = 'custom';
  fx.lyricHighlightColor = normalizeHexColor(color);
  setStageLyricPalette(fx.lyricColorMode === 'custom' ? lyricPaletteFromHex(fx.lyricColor) : (stageLyrics.coverPalette || stageLyrics.palette));
  updateLyricHighlightControls();
  updateLyricGlowControls();
  saveLyricLayout();
  if (!silent) showToast('高亮颜色: ' + fx.lyricHighlightColor.toUpperCase());
}

// 构建视觉预设卡片网格。
function buildPresetGrid() {
  // 预设网格容器。
  var grid = document.getElementById('preset-grid');
  if (!grid) return;
  // 去重表。
  var seen = {};
  // 展示顺序，先使用指定顺序。
  var order = presetDisplayOrder.filter(function(id){
    // 当前预设 id 是否合法且未出现。
    var ok = id >= 0 && id < presetMeta.length && !seen[id];
    seen[id] = true;
    return ok;
  });
  presetMeta.forEach(function(_, id){
    // 把未列入 presetDisplayOrder 的预设追加到末尾。
    if (!seen[id]) order.push(id);
  });
  grid.innerHTML = order.map(function(i){
    // 预设元信息。
    var p = presetMeta[i];
    // 预设描述支持 HTML 覆盖。
    var desc = p.descHtml || p.desc;
    return '<div class="preset-card" data-preset="' + i + '" onclick="setPreset(' + i + ')">' +
      '<div class="pc-icon">' + presetIcons[i] + '</div>' +
      '<div class="pc-name">' + p.name + '</div>' +
      '<div class="pc-desc">' + desc + '</div>' +
    '</div>';
  }).join('');
  refreshPresetGrid();
}
// 刷新视觉预设卡片选中态。
function refreshPresetGrid() {
  document.querySelectorAll('.preset-card').forEach(function(el){
    el.classList.toggle('active', Number(el.dataset.preset) === fx.preset);
  });
}
// 启动预设切换时的粒子过渡效果。
function triggerPresetParticleTransition(fromPreset, toPreset) {
  presetTransition.active = true;
  presetTransition.start = uniforms.uTime.value;
  presetTransition.duration = toPreset === 5 ? 0.30 : 0.24;
  presetTransition.from = fromPreset;
  presetTransition.to = toPreset;
  // 新视觉预设包含唱片、星河和骷髅等。
  var newVisual = toPreset >= 4;
  // 星河壁纸预设需要更轻的扰动。
  var wallpaperFlow = toPreset === 5;
  uniforms.uScatter.value = Math.max(uniforms.uScatter.value, fx.scatter + (newVisual ? (wallpaperFlow ? 0.008 : 0.024) : 0.12));
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, wallpaperFlow ? 0.05 : 0.15);
  camPunch = Math.max(camPunch, wallpaperFlow ? 0.04 : 0.12);
  for (var i = 0; i < 3; i++) {
    // 预设切换时触发几圈涟漪，掩盖几何重排。
    triggerRipple((Math.random() - 0.5) * 3.4, (Math.random() - 0.5) * 3.4, 0.58 + Math.random() * 0.32);
  }
  // 目标预设卡片。
  var card = document.querySelector('.preset-card[data-preset="' + toPreset + '"]');
  if (card) {
    card.classList.remove('switching');
    void card.offsetWidth;
    card.classList.add('switching');
    setTimeout(function(){ card.classList.remove('switching'); }, 760);
  }
}
// 每帧推进预设切换过渡。
function tickPresetTransition() {
  if (!presetTransition.active) return;
  // 原始过渡进度。
  var raw = (uniforms.uTime.value - presetTransition.start) / presetTransition.duration;
  // 夹紧后的过渡进度。
  var t = Math.max(0, Math.min(1, raw));
  // 半正弦波用于中段增强。
  var wave = Math.sin(t * Math.PI);
  // 是否切到新视觉预设。
  var newVisual = presetTransition.to >= 4;
  // 是否切到星河壁纸预设。
  var wallpaperFlow = presetTransition.to === 5;
  uniforms.uScatter.value = Math.max(uniforms.uScatter.value, fx.scatter + wave * (newVisual ? (wallpaperFlow ? 0.008 : 0.026) : 0.16));
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, wave * (wallpaperFlow ? 0.045 : (newVisual ? 0.12 : 0.15)));
  uniforms.uPointScale.value = fx.point * (1 + wave * (wallpaperFlow ? 0.016 : 0.048));
  if (raw >= 1) {
    presetTransition.active = false;
    syncFxUniforms();
  }
}
// 切换视觉预设。
function setPreset(p, opts) {
  opts = opts || {};
  // 目标预设索引。
  p = Math.max(0, Math.min(presetMeta.length - 1, normalizeVisualPresetIndex(p, DEFAULT_PLAYBACK_VISUAL_PRESET)));
  // 上一个预设索引。
  var prev = fx.preset;
  // 是否真的发生变化。
  var changed = prev !== p;
  fx.preset = p;
  if (changed && prev === SKULL_PRESET_INDEX && p !== SKULL_PRESET_INDEX) clearSkullPresetResidue();
  if (p === SKULL_PRESET_INDEX) loadSkullParticleAsset();
  if (changed) {
    if (typeof MineradioSonicTopography !== 'undefined' && MineradioSonicTopography.onPresetChange) MineradioSonicTopography.onPresetChange(prev, p, { fx: fx, scene: scene });
  }
  uniforms.uPreset.value = p;
  refreshPresetGrid();
  if (changed && !opts.skipTransition) triggerPresetParticleTransition(prev, p);
  // 每个预设对应的相机基线 (改 userOrbit)
  if (changed && !opts.preserveCamera) {
    // 预设切换时重置轨道相机默认基线。
    if (p === 1)      { orbit.userRadius = 6.2; orbit.userPhi = 0.03; orbit.userTheta = 0.0; orbit.baselineRadius = 6.2; orbit.baselinePhi = 0.03; }
    else if (p === 2) { orbit.userRadius = 7.0; orbit.userPhi = 0.15; orbit.userTheta = 0.0; orbit.baselineRadius = 7.0; orbit.baselinePhi = 0.15; }
    else if (p === 3) { orbit.userRadius = 8.0; orbit.userPhi = 0.05; orbit.userTheta = 0.0; orbit.baselineRadius = 8.0; orbit.baselinePhi = 0.05; }
    else if (p === 4) { orbit.userRadius = 6.5; orbit.userPhi = 0.04; orbit.userTheta = 0.0; orbit.baselineRadius = 6.5; orbit.baselinePhi = 0.04; }
    else if (p === 5) { orbit.userRadius = 9.4; orbit.userPhi = 0.34; orbit.userTheta = -0.52; orbit.baselineRadius = 9.4; orbit.baselinePhi = 0.34; }
    else if (p === 6) { orbit.userRadius = 7.4; orbit.userPhi = 0.10; orbit.userTheta = 0.18; orbit.baselineRadius = 7.4; orbit.baselinePhi = 0.10; }
    else if (p === 7) { orbit.userRadius = 8.5; orbit.userPhi = 0.20; orbit.userTheta = 0.0; orbit.baselineRadius = 8.5; orbit.baselinePhi = 0.20; }
    else if (p === 8) { orbit.userRadius = 8.0; orbit.userPhi = 0.15; orbit.userTheta = 0.0; orbit.baselineRadius = 8.0; orbit.baselinePhi = 0.15; }
    else              { orbit.userRadius = 6.6; orbit.userPhi = 0.08; orbit.userTheta = 0.0; orbit.baselineRadius = 6.6; orbit.baselinePhi = 0.08; }
    orbit.baselineTheta = p === 5 ? -0.52 : (p === 6 ? 0.18 : (p === 7 ? 0 : (p === 8 ? 0 : 0.0)));
  }
  if (changed && !opts.silent) showToast('视觉预设: ' + presetMeta[p].name);
  // 是否把本次预设写入播放期默认预设。
  var shouldCommitPlaybackPreset = !!opts.commitPlaybackPreset || !opts.noSave;
  if (shouldCommitPlaybackPreset) {
    playbackVisualPreset = p;
  }
  if (!opts.noSave) {
    saveLyricLayout();
  }
}

// 将 fx 运行时配置同步到 shader uniforms 和可见对象。
function syncFxUniforms() {
  uniforms.uPreset.value = fx.preset;
  uniforms.uIntensity.value = fx.intensity;
  uniforms.uDepth.value = fx.depth;
  uniforms.uPointScale.value = fx.point;
  uniforms.uSpeed.value = fx.speed;
  uniforms.uTwist.value = fx.twist;
  uniforms.uColorBoost.value = fx.color;
  uniforms.uScatter.value = fx.scatter;
  uniforms.uCoverRes.value = normalizeCoverResolution(fx.coverResolution);
  uniforms.uBgFade.value = fx.bgFade;
  uniforms.uBloomStrength.value = fx.bloom ? fx.bloomStrength : 0;
  if (bloomParticles) bloomParticles.visible = fx.bloom && fx.bloomStrength > 0.01;
  uniforms.uEdgeEnabled.value = fx.edge ? 1 : 0;
  // 视觉自定义主色。
  if (uniforms.uTintColor) uniforms.uTintColor.value.set(normalizeHexColor(fx.visualTintColor || '#9db8cf'));
  // 只有自定义主色模式才提高色彩染色强度。
  if (uniforms.uTintStrength) uniforms.uTintStrength.value = fx.visualTintMode === 'custom' ? 0.42 : 0;
  syncSkullParticleColors();
}
// 设置范围输入控件的值和 output 文本。
function setRange(id, value) {
  // 范围输入节点。
  var el = document.getElementById(id);
  if (!el) return;
  // 特殊滑块值归一化。
  if (id === 'fx-lyricglow') value = Math.min(0.85, Math.max(0, value));
  if (id === 'fx-coverres') value = normalizeCoverResolution(value);
  el.value = value;
  // 当前滑块旁的输出文本。
  var out = el.parentElement.querySelector('output');
  if (out) out.textContent = id === 'fx-coverres'
    ? coverParticleCountLabel(value)
    : (id === 'fx-lyricweight' || id === 'fx-lyrictiltx' || id === 'fx-lyrictilty' || id === 'fx-shelfangle' ? String(Math.round(Number(value) || 0)) : Number(value).toFixed(id === 'fx-lyricspacing' ? 3 : 2));
}
// 刷新开发中锁定功能的控件状态。
function updateDevelopmentFxControls() {
  [
    ['wallpaperMode', 't-wallpaperMode', wallpaperModeHintText()]
  ].forEach(function(item){
    // 当前功能是否被开发锁锁定。
    var locked = isDevelopmentLockedFx(item[0]);
    // 对应开关节点。
    var el = document.getElementById(item[1]);
    if (!el) return;
    if (item[0] === 'wallpaperMode') {
      el.classList.remove('dev-locked', 'on');
      el.removeAttribute('aria-disabled');
      el.title = wallpaperModeHintText();
      return;
    }
    el.classList.toggle('dev-locked', locked);
    if (locked) {
      el.classList.remove('on');
      el.setAttribute('aria-disabled', 'true');
      el.title = '开发中，暂不可用';
    } else {
      el.removeAttribute('aria-disabled');
      el.title = item[2];
    }
  });
  [
    ['wallpaperMode', 'fx-wallpaperopacity']
  ].forEach(function(item){
    // 当前功能是否被开发锁锁定。
    var locked = isDevelopmentLockedFx(item[0]);
    // 对应输入节点。
    var input = document.getElementById(item[1]);
    if (!input) return;
    input.disabled = locked;
    // 输入所在行。
    var row = input.closest && input.closest('.fx-slider');
    if (row) row.classList.toggle('dev-locked', locked);
  });
}
// 刷新后台策略和画质档位控件。
function updatePerformanceControls() {
  fx.performanceBackground = normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true);
  fx.liveBackgroundKeep = fx.performanceBackground === 'keep';
  fx.performanceQuality = normalizePerformanceQuality(fx.performanceQuality);
  // 后台策略分段按钮。
  document.querySelectorAll('#performance-background-seg [data-performance-background]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-performance-background') === fx.performanceBackground);
  });
  // 画质档位分段按钮。
  document.querySelectorAll('#performance-quality-seg [data-performance-quality]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-performance-quality') === fx.performanceQuality);
  });
  // 旧保持后台开关兼容。
  var liveBackgroundKeepToggle = document.getElementById('t-liveBackgroundKeep');
  if (liveBackgroundKeepToggle) liveBackgroundKeepToggle.classList.toggle('on', fx.liveBackgroundKeep === true);
}
// 设置后台运行策略。
function setPerformanceBackgroundMode(mode, silent) {
  // 归一化后的后台策略。
  var next = normalizePerformanceBackgroundMode(mode, false);
  fx.performanceBackground = next;
  fx.liveBackgroundKeep = next === 'keep';
  updatePerformanceControls();
  saveLyricLayout();
  updateRenderPowerClasses();
  applyRendererPowerMode();
  if (next === 'keep') recoverVisualsAfterBackground('performance-background-keep');
  else if (next === 'release' && isDeepBackgroundMode()) trimRuntimeCaches('performance-release', true);
  if (!silent) {
    showToast(next === 'keep' ? '后台策略: 保持运行' : (next === 'release' ? '后台策略: 停止并释放' : '后台策略: 自动优化'));
  }
}
// 设置渲染画质档位。
function setPerformanceQualityMode(mode, silent) {
  // 归一化后的画质档位。
  var next = normalizePerformanceQuality(mode);
  fx.performanceQuality = next;
  updatePerformanceControls();
  applyRendererPowerMode();
  saveLyricLayout();
  if (!silent) {
    // 档位展示标签。
    var label = next === 'eco' ? '低' : (next === 'balanced' ? '中' : (next === 'ultra' ? '超高' : '高'));
    showToast('画质档位: ' + label);
  }
}
// 将当前 fx 状态同步到所有控制台输入、开关和颜色控件。
function updateFxInputs() {
  normalizeDevelopmentLockedFxState();
  applyShelfCameraDefaultAngle(false);
  // 数值滑块。
  setRange('fx-intensity', fx.intensity);
  setRange('fx-cineshake', fx.cinemaShake);
  setRange('fx-depth', fx.depth);
  setRange('fx-coverres', fx.coverResolution);
  setRange('fx-lyricglow', fx.lyricGlowStrength);
  setRange('fx-bgopacity', fx.backgroundOpacity == null ? 1 : fx.backgroundOpacity);
  setRange('fx-wallpaperopacity', fx.wallpaperOpacity);
  setRange('fx-shelfsize', fx.shelfSize);
  setRange('fx-shelfx', fx.shelfOffsetX);
  setRange('fx-shelfy', fx.shelfOffsetY);
  setRange('fx-shelfz', fx.shelfOffsetZ);
  setRange('fx-shelfangle', fx.shelfAngleY);
  setRange('fx-shelfopacity', fx.shelfOpacity);
  setRange('fx-shelfbgalpha', fx.shelfBgOpacity);
  setRange('fx-lyricspacing', fx.lyricLetterSpacing);
  setRange('fx-lyriclineheight', fx.lyricLineHeight);
  setRange('fx-lyricweight', fx.lyricWeight);
  setRange('fx-lyriccustomlines', fx.lyricCustomLineCount);
  setRange('fx-lyriccontextopacity', fx.lyricContextOpacity);
  setRange('fx-lyriccontextspread', fx.lyricContextSpread);
  setRange('fx-lyricedgefade', fx.lyricEdgeFade);
  setRange('fx-lyrictranslationgap', fx.lyricTranslationGap);
  setRange('fx-lyrictranslationscale', fx.lyricTranslationScale);
  setRange('fx-lyrictranslationopacity', fx.lyricTranslationOpacity);
  updateLyricTimeOffsetControls();
  setRange('fx-lyricscale', fx.lyricScale);
  setRange('fx-lyricx', fx.lyricOffsetX);
  setRange('fx-lyricy', fx.lyricOffsetY);
  setRange('fx-lyricz', fx.lyricOffsetZ);
  setRange('fx-lyrictiltx', fx.lyricTiltX);
  setRange('fx-lyrictilty', fx.lyricTiltY);
  setRange('fx-point', fx.point);
  setRange('fx-speed', fx.speed);
  setRange('fx-twist', fx.twist);
  setRange('fx-color', fx.color);
  setRange('fx-bloom', fx.bloomStrength);
  setRange('fx-scatter', fx.scatter);
  setRange('fx-bgfade', fx.bgFade);
  updateLyricGlowControls();
  updateLyricFilterControls();
  // 同步开关
  // 浮空粒子开关。
  document.getElementById('t-float').classList.toggle('on', fx.floatLayer);
  var floatToggle = document.getElementById('t-float');
  if (floatToggle) floatToggle.classList.toggle('on', fx.floatLayer);
  // 电影化镜头开关。
  document.getElementById('t-cinema').classList.toggle('on', fx.cinema);
  // 歌词溢光开关。
  var lyricGlowToggle = document.getElementById('t-lyricGlow');
  if (lyricGlowToggle) lyricGlowToggle.classList.toggle('on', fx.lyricGlow);
  // 歌词溢光节拍开关。
  var lyricGlowBeatToggle = document.getElementById('t-lyricGlowBeat');
  if (lyricGlowBeatToggle) lyricGlowBeatToggle.classList.toggle('on', fx.lyricGlowBeat);
  // 歌词溢光粒子开关。
  var lyricGlowParticlesToggle = document.getElementById('t-lyricGlowParticles');
  if (lyricGlowParticlesToggle) lyricGlowParticlesToggle.classList.toggle('on', fx.lyricGlowParticles);
  // 歌词相机锁定开关。
  var lyricCameraLockToggle = document.getElementById('t-lyricCameraLock');
  if (lyricCameraLockToggle) lyricCameraLockToggle.classList.toggle('on', fx.lyricCameraLock);
  // Bloom 开关。
  document.getElementById('t-bloom').classList.toggle('on', fx.bloom);
  // 边缘深度开关。
  document.getElementById('t-edge').classList.toggle('on', fx.edge);
  // 壁纸模式开关。
  var wallpaperModeToggle = document.getElementById('t-wallpaperMode');
  if (wallpaperModeToggle) wallpaperModeToggle.classList.toggle('on', fx.wallpaperMode);
  // 后台保持运行兼容开关。
  var liveBackgroundKeepToggle = document.getElementById('t-liveBackgroundKeep');
  if (liveBackgroundKeepToggle) liveBackgroundKeepToggle.classList.toggle('on', fx.liveBackgroundKeep === true);
  updatePerformanceControls();
  updateDevelopmentFxControls();
  updateAIDepthControls();
  updateLyricDisplayModeControls();
  updateLyricTranslationModeControls();
  // 三态
  // 歌单架模式分段按钮。
  document.querySelectorAll('#shelf-seg button').forEach(function(b){ b.classList.toggle('active', b.dataset.shelf === fx.shelf); });
  // 其它派生控件状态。
  updateShelfControlUi();
  refreshPresetGrid();
  updateLyricColorControls();
  updateLyricHighlightControls();
  updateLyricGlowControls();
  updateUiAccentControls();
  updateIconAccentControls();
  updateCustomBackgroundControls();
  updateVisualTintControls();
  applyControlGlassChromaticOffset();
  syncFxUniforms();
}
// 播放单个滑块重置按钮动画。
function animateFxResetButton(btn) {
  if (!btn || !window.gsap) return;
  window.gsap.fromTo(btn, { rotate: -120, scale: 0.88 }, { rotate: 0, scale: 1, duration: 0.48, ease: 'expo.out', overwrite: true });
  window.gsap.fromTo(btn, { boxShadow: '0 0 0 0 rgba(244,210,138,.38)' }, { boxShadow: '0 0 0 8px rgba(244,210,138,0)', duration: 0.55, ease: 'sine.out', overwrite: true });
}
// 将指定滑块恢复到默认值。
function resetFxSliderValue(id, key, btn) {
  if (!Object.prototype.hasOwnProperty.call(fxDefaults, key)) return;
  if (key === 'shelfAngleY') {
    // 歌单架角度恢复为当前相机模式默认值。
    fx.shelfAngleYManual = false;
    fx.shelfAngleY = shelfDefaultAngleForCameraMode(fx.shelfCameraMode);
  } else {
    fx[key] = fxDefaults[key];
  }
  setRange(id, fx[key]);
  if (key === 'coverResolution') applyCoverParticleResolution(fx[key], { reload: true });
  syncFxUniforms();
  if (key === 'lyricLetterSpacing' || key === 'lyricLineHeight' || key === 'lyricWeight') refreshCurrentLyricStyle();
  saveLyricLayout();
  animateFxResetButton(btn);
  showToast('已恢复默认数值');
}
// 给指定滑块补充单项重置按钮。
function ensureFxSliderResetButton(id, key) {
  // 目标滑块。
  var el = document.getElementById(id);
  if (!el || !el.parentElement || el.parentElement.querySelector('.fx-reset-one')) return;
  // 重置按钮。
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fx-reset-one';
  btn.title = '恢复当前滑条默认值';
  btn.setAttribute('aria-label', '恢复当前滑条默认值');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  btn.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    resetFxSliderValue(id, key, btn);
  });
  el.parentElement.appendChild(btn);
}
// 当前控制台分页。
var fxPanelTab = 'presets';
// 设置控制台当前分页。
function setFxPanelTab(tab) {
  // 允许的分页 key。
  var allowed = { presets:1, appearance:1, lyrics:1, motion:1, advanced:1 };
  fxPanelTab = allowed[tab] ? tab : 'presets';
  // 控制台面板。
  var panel = document.getElementById('fx-panel');
  if (panel) panel.setAttribute('data-active-tab', fxPanelTab);
  // 标签按钮状态。
  document.querySelectorAll('#fx-panel-tabs [data-fx-tab]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-fx-tab') === fxPanelTab);
  });
  // 分页内容状态。
  document.querySelectorAll('#fx-panel .fx-tab-page').forEach(function(page){
    page.classList.toggle('active', page.getAttribute('data-fx-page') === fxPanelTab);
  });
  repositionFxFloatingPanels();
}
// 从控制台节点中查找第一个输入控件 id。
function fxPanelInputId(node) {
  // 节点内部的输入控件。
  var input = node && node.querySelector ? node.querySelector('input[id]') : null;
  return input ? input.id : '';
}
// 判断控制台节点应该归入哪个分页。
function fxPanelTargetForNode(node, current) {
  if (!node) return current || 'presets';
  // 节点自身 id。
  var id = node.id || '';
  // 节点内部输入 id。
  var inputId = fxPanelInputId(node);
  if (id === 'preset-grid' || id === 'user-archive-grid') return 'presets';
  if (id === 'fx-lyric-fold') return 'lyrics';
  if (id === 'fx-overlay-fold' || id === 'fx-stage-fold') return 'motion';
  if (id === 'fx-advanced' || node.classList.contains('fx-actions')) return 'advanced';
  if (node.classList.contains('lyric-color-row') || node.classList.contains('cover-color-pop') || node.classList.contains('color-lab-pop') || node.classList.contains('cover-color-loupe')) return 'appearance';
  if (inputId === 'fx-bgopacity') return 'appearance';
  if (inputId === 'fx-lyricglow') return 'lyrics';
  if (/^fx-(intensity|depth|coverres|cineshake)$/.test(inputId)) return 'motion';
  return current || 'presets';
}
// 将原始控制台 DOM 整理为分页结构。
function organizeFxPanel() {
  // 控制台面板。
  var panel = document.getElementById('fx-panel');
  if (!panel) return;
  if (panel._fxPanelOrganized) {
    setFxPanelTab(fxPanelTab);
    return;
  }
  // 控制台头部。
  var head = panel.querySelector('.fx-head');
  // 分页元信息。
  var tabMeta = [
    ['presets', '\u9884\u8bbe'],
    ['appearance', '\u5916\u89c2'],
    ['lyrics', '\u6b4c\u8bcd'],
    ['motion', '\u52a8\u6001'],
    ['advanced', '\u9ad8\u7ea7']
  ];
  // 分页标签容器。
  var tabs = document.createElement('div');
  tabs.className = 'fx-panel-tabs';
  tabs.id = 'fx-panel-tabs';
  tabMeta.forEach(function(meta){
    // 单个分页按钮。
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-fx-tab', meta[0]);
    btn.textContent = meta[1];
    tabs.appendChild(btn);
  });
  if (head && head.nextSibling) panel.insertBefore(tabs, head.nextSibling);
  else panel.insertBefore(tabs, panel.firstChild);
  // 分页内容容器表。
  var pages = {};
  // 插入参考节点。
  var insertAfter = tabs;
  tabMeta.forEach(function(meta){
    // 单个分页内容容器。
    var page = document.createElement('div');
    page.className = 'fx-tab-page';
    page.setAttribute('data-fx-page', meta[0]);
    insertAfter.parentNode.insertBefore(page, insertAfter.nextSibling);
    insertAfter = page;
    pages[meta[0]] = page;
  });
  // 原始内容节点列表。
  var original = Array.prototype.slice.call(panel.children).filter(function(child){
    return child !== head && child !== tabs && !child.classList.contains('fx-tab-page');
  });
  // 当前节点默认归属分页。
  var current = 'presets';
  original.forEach(function(node, idx){
    // 目标分页。
    var target;
    if (node.classList.contains('fx-section-label')) {
      target = fxPanelTargetForNode(original[idx + 1], current);
      current = target;
    } else {
      target = fxPanelTargetForNode(node, current);
      current = target;
    }
    (pages[target] || pages.presets).appendChild(node);
  });
  // 默认展开折叠分组，分页后由 tab 控制显示。
  ['fx-lyric-fold','fx-overlay-fold','fx-stage-fold','fx-advanced'].forEach(function(id){
    var fold = document.getElementById(id);
    if (fold) fold.classList.add('open');
  });
  // 绑定分页按钮点击。
  tabs.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('[data-fx-tab]') : null;
    if (!btn) return;
    setFxPanelTab(btn.getAttribute('data-fx-tab'));
  });
  // 标记控制台已整理。
  panel._fxPanelOrganized = true;
  setFxPanelTab(fxPanelTab);
}

// 获取控制台控件所在的视觉块节点。
function fxControlBlock(id) {
  // 目标元素。
  var el = document.getElementById(id);
  if (!el) return null;
  return el.closest('.fx-slider,.lyric-color-row,.lyric-color-grid,.fx-seg,.preset-grid,.user-archive-grid') || el;
}
// 在指定控件块前确保有分区标题。
function setFxSectionBefore(id, text) {
  // 控件块。
  var block = fxControlBlock(id);
  if (!block || !block.parentNode) return;
  // 前一个兄弟节点。
  var prev = block.previousElementSibling;
  if (!prev || !prev.classList || !prev.classList.contains('fx-section-label')) {
    // 不存在分区标题时创建。
    prev = document.createElement('div');
    prev.className = 'fx-section-label';
    block.parentNode.insertBefore(prev, block);
  }
  prev.textContent = text;
}
// 设置指定滑块的 label 文案。
function setFxSliderLabel(id, text) {
  // 控件块。
  var block = fxControlBlock(id);
  // 控件 label。
  var label = block && block.querySelector ? block.querySelector('label') : null;
  if (label) label.textContent = text;
}
// 在指定节点前确保有分区标题。
function setFxSectionBeforeNode(node, text) {
  if (!node || !node.parentNode) return;
  // 前一个兄弟节点。
  var prev = node.previousElementSibling;
  if (!prev || !prev.classList || !prev.classList.contains('fx-section-label')) {
    // 不存在分区标题时创建。
    prev = document.createElement('div');
    prev.className = 'fx-section-label';
    node.parentNode.insertBefore(prev, node);
  }
  prev.textContent = text;
}
// 将开关按钮移动到指定网格。
function moveToggleToGrid(toggleId, grid) {
  // 开关节点。
  var node = document.getElementById(toggleId);
  if (!node || !grid || node.parentNode === grid) return;
  grid.appendChild(node);
}
// 确保歌词核心开关被归入歌词开关网格。
function ensureLyricPrimaryControls() {
  // 歌词折叠区内容。
  var body = document.querySelector('#fx-lyric-fold .fx-fold-body');
  if (!body) return;
  // 歌词核心开关网格。
  var grid = document.getElementById('fx-lyric-primary-controls');
  if (!grid) {
    // 分区标题。
    var label = document.createElement('div');
    label.className = 'fx-section-label';
    label.id = 'fx-lyric-primary-label';
    label.textContent = '歌词开关';
    // 新建开关网格。
    grid = document.createElement('div');
    grid.className = 'fx-toggle-grid lyric-primary-toggle-grid';
    grid.id = 'fx-lyric-primary-controls';
    body.insertBefore(grid, body.firstChild);
    body.insertBefore(label, grid);
  }
  // 把相关开关移动到歌词主开关网格。
  [
    't-lyricCameraLock',
    't-lyricGlow',
    't-lyricGlowBeat',
    't-lyricGlowParticles'
  ].forEach(function(id){ moveToggleToGrid(id, grid); });
}
// 给背景媒体控件添加上传提示。
function applyBackgroundMediaHint() {
  // 背景媒体值节点。
  var value = document.getElementById('bg-image-value');
  if (value && !value.dataset.mediaHint) {
    value.dataset.mediaHint = '1';
    value.title = '支持图片 JPG / PNG / WebP 与视频 MP4 / WebM / MOV 上传';
  }
  // 背景媒体所在 label。
  var label = value && value.closest ? value.closest('.fx-color-row-label') : null;
  if (label && !document.getElementById('bg-media-hint')) {
    // 小提示节点。
    var hint = document.createElement('small');
    hint.id = 'bg-media-hint';
    hint.textContent = '支持图片 / 视频上传';
    label.appendChild(hint);
  }
}
// 重命名和整理视觉控制台中的分区和控件标签。
function relabelFxPanelControls() {
  // 控制台标题。
  var title = document.querySelector('#fx-panel .fx-title');
  if (title) title.textContent = '视觉控制台';
  ensureLyricPrimaryControls();
  applyBackgroundMediaHint();
  // 叠加开关所在网格。
  var overlayGrid = document.getElementById('t-cinema');
  overlayGrid = overlayGrid && overlayGrid.closest('.fx-toggle-grid');
  // 分区标题。
  setFxSectionBeforeNode(overlayGrid, '镜头与叠加');
  setFxSectionBefore('preset-grid', '预设与存档');
  setFxSectionBefore('user-archive-grid', '用户存档');
  setFxSectionBefore('ui-accent-picker', '界面与背景');
  setFxSectionBefore('fx-intensity', '画面基础');
  setFxSectionBefore('fx-lyricglow', '歌词溢光强度');
  setFxSectionBefore('lyric-color-grid', '文字颜色');
  setFxSectionBefore('lyric-highlight-picker', '跟唱高亮');
  setFxSectionBefore('lyric-glow-row', '歌词溢光颜色');
  setFxSectionBefore('fx-lyricspacing', '字距与排版');
  setFxSectionBefore('fx-lyricscale', '位置与角度');
  setFxSectionBefore('shelf-seg', '3D 歌单架');
  setFxSectionBefore('shelf-camera-seg', '歌单架镜头');
  setFxSectionBefore('shelf-presence-seg', '歌单架显示');
  setFxSectionBefore('shelf-accent-picker', '歌单架外观');
  setFxSectionBefore('fx-shelfsize', '歌单架参数');
  setFxSectionBefore('fx-point', '粒子高级参数');
  setFxSliderLabel('fx-intensity', '律动强度');
  setFxSliderLabel('fx-depth', '画面景深');
  setFxSliderLabel('fx-coverres', '封面清晰度');
  setFxSliderLabel('fx-cineshake', '电影镜头');
  setFxSliderLabel('fx-lyricglow', '溢光强度');
  setFxSliderLabel('fx-bgopacity', '背景透明度');
  setFxSliderLabel('fx-lyricspacing', '字间距');
  setFxSliderLabel('fx-lyriclineheight', '行距');
  setFxSliderLabel('fx-lyricweight', '字重');
  setFxSliderLabel('fx-lyricscale', '歌词大小');
  setFxSliderLabel('fx-lyricx', '左右位置');
  setFxSliderLabel('fx-lyricy', '上下位置');
  setFxSliderLabel('fx-lyricz', '前后景深');
  setFxSliderLabel('fx-lyrictiltx', '上下旋转');
  setFxSliderLabel('fx-lyrictilty', '左右旋转');
  setFxSliderLabel('fx-wallpaperopacity', '壁纸透明度');
  setFxSliderLabel('fx-shelfsize', '歌单架大小');
  setFxSliderLabel('fx-shelfx', '左右位置');
  setFxSliderLabel('fx-shelfy', '上下位置');
  setFxSliderLabel('fx-shelfz', '前后景深');
  setFxSliderLabel('fx-shelfangle', '侧向角度');
  setFxSliderLabel('fx-shelfopacity', '整体透明度');
  setFxSliderLabel('fx-shelfbgalpha', '背景透明度');
  setFxSliderLabel('fx-point', '粒子尺寸');
  setFxSliderLabel('fx-speed', '运动速度');
  setFxSliderLabel('fx-twist', '粒子扭曲');
  setFxSliderLabel('fx-color', '色彩张力');
  setFxSliderLabel('fx-bloom', '光晕强度');
  setFxSliderLabel('fx-scatter', '离散感');
  setFxSliderLabel('fx-bgfade', '背景压暗');
}

// 初始化并绑定视觉控制台所有交互。
function bindFxPanel() {
  liftFxFloatingPopups();
  organizeFxPanel();
  relabelFxPanelControls();
  buildPresetGrid();
  renderUserFxArchives();
  buildLyricColorControls();
  // 滑块 id 与 fx 字段映射。
  var ids = [
    ['fx-intensity','intensity'],['fx-depth','depth'],['fx-coverres','coverResolution'],['fx-cineshake','cinemaShake'],['fx-lyricglow','lyricGlowStrength'],['fx-bgopacity','backgroundOpacity'],
    ['fx-wallpaperopacity','wallpaperOpacity'],
    ['fx-shelfsize','shelfSize'],['fx-shelfx','shelfOffsetX'],['fx-shelfy','shelfOffsetY'],['fx-shelfz','shelfOffsetZ'],['fx-shelfangle','shelfAngleY'],['fx-shelfopacity','shelfOpacity'],['fx-shelfbgalpha','shelfBgOpacity'],
    ['fx-lyricspacing','lyricLetterSpacing'],['fx-lyriclineheight','lyricLineHeight'],['fx-lyricweight','lyricWeight'],
    ['fx-lyriccustomlines','lyricCustomLineCount'],['fx-lyriccontextopacity','lyricContextOpacity'],['fx-lyriccontextspread','lyricContextSpread'],['fx-lyricedgefade','lyricEdgeFade'],
    ['fx-lyrictranslationgap','lyricTranslationGap'],['fx-lyrictranslationscale','lyricTranslationScale'],['fx-lyrictranslationopacity','lyricTranslationOpacity'],
    ['fx-lyricscale','lyricScale'],['fx-lyricx','lyricOffsetX'],['fx-lyricy','lyricOffsetY'],['fx-lyricz','lyricOffsetZ'],['fx-lyrictiltx','lyricTiltX'],['fx-lyrictilty','lyricTiltY'],
    ['fx-point','point'],['fx-speed','speed'],['fx-twist','twist'],
    ['fx-color','color'],['fx-bloom','bloomStrength'],['fx-scatter','scatter'],['fx-bgfade','bgFade'],
  ];
  ids.forEach(function(pair){
    // 当前滑块。
    var el = document.getElementById(pair[0]);
    if (!el) return;
    ensureFxSliderResetButton(pair[0], pair[1]);
    el.addEventListener('input', function(){
      // 将滑块值写入对应 fx 字段。
      fx[pair[1]] = parseFloat(el.value);
      // 输出文本节点。
      var out = el.parentElement.querySelector('output');
      if (pair[1] === 'coverResolution') {
        // 封面粒子分辨率变化需要重建封面粒子。
        fx.coverResolution = normalizeCoverResolution(fx.coverResolution);
        applyCoverParticleResolution(fx.coverResolution, { reload: true });
      }
      // 字重按 50 的步进吸附。
      if (pair[1] === 'lyricWeight') fx.lyricWeight = Math.round(clampRange(fx.lyricWeight, 500, 900) / 50) * 50;
      if (pair[1] === 'backgroundOpacity') {
        // 调整背景透明度时进入自定义背景模式。
        fx.backgroundOpacity = clampRange(fx.backgroundOpacity, 0, 1);
        fx.backgroundColorMode = 'custom';
        fx.backgroundColorCustom = true;
        updateCustomBackgroundControls();
      }
      // 各特殊滑块范围夹紧。
      if (pair[1] === 'wallpaperOpacity') fx.wallpaperOpacity = clampRange(fx.wallpaperOpacity, 0.35, 1);
      if (pair[1] === 'shelfSize') fx.shelfSize = clampRange(fx.shelfSize, 0.65, 1.45);
      if (pair[1] === 'shelfOffsetX') fx.shelfOffsetX = clampRange(fx.shelfOffsetX, -1.2, 1.2);
      if (pair[1] === 'shelfOffsetY') fx.shelfOffsetY = clampRange(fx.shelfOffsetY, -0.9, 0.9);
      if (pair[1] === 'shelfOffsetZ') fx.shelfOffsetZ = clampRange(fx.shelfOffsetZ, -0.9, 0.9);
      if (pair[1] === 'shelfAngleY') {
        fx.shelfAngleYManual = true;
        fx.shelfAngleY = Math.round(clampRange(fx.shelfAngleY, -30, 30));
      }
      if (pair[1] === 'shelfOpacity') fx.shelfOpacity = clampRange(fx.shelfOpacity, 0.25, 1);
      if (pair[1] === 'shelfBgOpacity') fx.shelfBgOpacity = clampRange(fx.shelfBgOpacity, 0.25, 0.98);
      if (pair[1] === 'lyricTiltX' || pair[1] === 'lyricTiltY') fx[pair[1]] = Math.round(clampRange(fx[pair[1]], -42, 42));
      // 自定义歌词行数按整数吸附。
      if (pair[1] === 'lyricCustomLineCount') fx.lyricCustomLineCount = Math.round(clampRange(fx.lyricCustomLineCount, 1, 10));
      if (pair[1] === 'lyricContextOpacity') fx.lyricContextOpacity = clampRange(fx.lyricContextOpacity, 0.25, 1);
      if (pair[1] === 'lyricContextSpread') fx.lyricContextSpread = clampRange(fx.lyricContextSpread, 0.60, 2.40);
      if (pair[1] === 'lyricEdgeFade') fx.lyricEdgeFade = clampRange(fx.lyricEdgeFade, 0, 1);
      if (pair[1] === 'lyricTranslationGap') fx.lyricTranslationGap = clampRange(fx.lyricTranslationGap, 0.28, 2.20);
      if (pair[1] === 'lyricTranslationScale') fx.lyricTranslationScale = clampRange(fx.lyricTranslationScale, 0.46, 1.12);
      if (pair[1] === 'lyricTranslationOpacity') fx.lyricTranslationOpacity = clampRange(fx.lyricTranslationOpacity, 0.20, 1);
      if (out) out.textContent = pair[1] === 'coverResolution'
        ? coverParticleCountLabel(fx.coverResolution)
        : (pair[1] === 'lyricWeight' || pair[1] === 'lyricTiltX' || pair[1] === 'lyricTiltY' || pair[1] === 'shelfAngleY' || pair[1] === 'lyricCustomLineCount' ? String(Math.round(fx[pair[1]])) : Number(el.value).toFixed(pair[1] === 'lyricLetterSpacing' ? 3 : 2));
      syncFxUniforms();
      // 歌单架相关滑块变化后刷新歌单架主题。
      if (/^shelf(Size|OffsetX|OffsetY|OffsetZ|AngleY|Opacity|BgOpacity)$/.test(pair[1]) && shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
      // 歌词排版变化后刷新当前歌词 mesh。
      if (pair[1] === 'lyricLetterSpacing' || pair[1] === 'lyricLineHeight' || pair[1] === 'lyricWeight') refreshCurrentLyricStyle();
      // 行数与译文相关参数变化后重算行清单；签名不变的行会被复用，不会重建贴图。
      if (/^lyric(CustomLineCount|ContextOpacity|ContextSpread|EdgeFade|TranslationGap|TranslationScale|TranslationOpacity)$/.test(pair[1])) refreshCurrentLyricStyle();
      // 壁纸透明度变化需要推送壁纸状态。
      if (pair[1] === 'wallpaperOpacity') pushWallpaperState(true);
      saveLyricLayout();
    });
  });
  // 歌词主色选择器。
  var lyricPicker = document.getElementById('lyric-color-picker');
  if (lyricPicker) {
    lyricPicker.addEventListener('input', function(){ setLyricColorCustom(lyricPicker.value, true); });
    lyricPicker.addEventListener('change', function(){ showToast('歌词颜色: ' + normalizeHexColor(lyricPicker.value).toUpperCase()); });
  }
  // 歌词高亮色选择器。
  var lyricHighlightPicker = document.getElementById('lyric-highlight-picker');
  if (lyricHighlightPicker) {
    lyricHighlightPicker.addEventListener('input', function(){ setLyricHighlightCustom(lyricHighlightPicker.value, true); });
    lyricHighlightPicker.addEventListener('change', function(){ showToast('高亮颜色: ' + normalizeHexColor(lyricHighlightPicker.value).toUpperCase()); });
  }
  // 歌词溢光色选择器。
  var lyricGlowPicker = document.getElementById('lyric-glow-picker');
  if (lyricGlowPicker) {
    lyricGlowPicker.addEventListener('input', function(){ setLyricGlowCustom(lyricGlowPicker.value, true); });
    lyricGlowPicker.addEventListener('change', function(){ showToast('溢光颜色: ' + normalizeHexColor(lyricGlowPicker.value).toUpperCase()); });
  }
  // UI 强调色选择器。
  var uiAccentPicker = document.getElementById('ui-accent-picker');
  if (uiAccentPicker) {
    uiAccentPicker.addEventListener('input', function(){ setUiAccentColor(uiAccentPicker.value, true); });
    uiAccentPicker.addEventListener('change', function(){ showToast('界面高亮: ' + normalizeHexColor(uiAccentPicker.value, '#00f5d4').toUpperCase()); });
  }
  // 视觉主色选择器。
  var visualTintPicker = document.getElementById('visual-tint-picker');
  if (visualTintPicker) {
    visualTintPicker.addEventListener('input', function(){ setVisualTintCustom(visualTintPicker.value, true); });
    visualTintPicker.addEventListener('change', function(){ showToast('视觉主色: ' + normalizeHexColor(visualTintPicker.value).toUpperCase()); });
  }
  // 视觉图标颜色选择器。
  var visualIconPicker = document.getElementById('visual-icon-picker');
  if (visualIconPicker) {
    visualIconPicker.addEventListener('input', function(){ setVisualIconColor(visualIconPicker.value, true); });
    visualIconPicker.addEventListener('change', function(){ showToast('视觉图标: ' + normalizeHexColor(visualIconPicker.value, '#7fd8ff').toUpperCase()); });
  }
  // 背景颜色选择器。
  var bgColorPicker = document.getElementById('bg-color-picker');
  if (bgColorPicker) {
    bgColorPicker.addEventListener('input', function(){ setCustomBackgroundColor(bgColorPicker.value, true); });
    bgColorPicker.addEventListener('change', function(){ showToast('背景颜色: ' + normalizeHexColor(bgColorPicker.value, '#000000').toUpperCase()); });
  }
  // 歌词过滤正则输入。
  var lyricFilterRegexInput = document.getElementById('lyric-filter-regex');
  if (lyricFilterRegexInput) {
    lyricFilterRegexInput.addEventListener('change', function(){
      setLyricFilterRegex(lyricFilterRegexInput.value);
    });
    lyricFilterRegexInput.addEventListener('keydown', function(e){
      if (e.key === 'Enter') {
        e.preventDefault();
        setLyricFilterRegex(lyricFilterRegexInput.value);
      }
    });
  }
  // 默认歌词过滤规则按钮。
  var lyricFilterDefaultBtn = document.getElementById('lyric-filter-default-btn');
  if (lyricFilterDefaultBtn) {
    lyricFilterDefaultBtn.addEventListener('click', function(){
      resetLyricFilterRegex();
    });
  }
  // 歌单架强调色选择器。
  var shelfAccentPicker = document.getElementById('shelf-accent-picker');
  if (shelfAccentPicker) {
    shelfAccentPicker.addEventListener('input', function(){ setShelfAccentColor(shelfAccentPicker.value, true); });
    shelfAccentPicker.addEventListener('change', function(){ showToast('歌单架颜色: ' + shelfAccentHex().toUpperCase()); });
  }
  ['ui-accent-picker','visual-tint-picker','visual-icon-picker','bg-color-picker','shelf-accent-picker','lyric-color-picker','lyric-highlight-picker','lyric-glow-picker'].forEach(function(id){
    // 给每个颜色输入绑定颜色实验室弹层。
    bindColorLabPicker(document.getElementById(id));
  });
  bindColorLabRows();
  // 颜色实验室饱和度/明度区域。
  var sv = document.getElementById('color-lab-sv');
  if (sv && !sv._bound) {
    // 防重复绑定标记。
    sv._bound = true;
    sv.addEventListener('pointerdown', function(e){
      e.preventDefault();
      colorLabState.dragging = true;
      sv.setPointerCapture && sv.setPointerCapture(e.pointerId);
      updateColorLabFromSv(e);
    });
    sv.addEventListener('pointermove', function(e){ if (colorLabState.dragging) updateColorLabFromSv(e); });
    sv.addEventListener('pointerup', function(){ colorLabState.dragging = false; });
    sv.addEventListener('pointercancel', function(){ colorLabState.dragging = false; });
  }
  // 颜色实验室色相滑块。
  var hue = document.getElementById('color-lab-hue');
  if (hue && !hue._bound) {
    // 防重复绑定标记。
    hue._bound = true;
    hue.addEventListener('input', function(){
      colorLabState.h = clampRange(Number(hue.value) || 0, 0, 360) / 360;
      // 根据 HSV 状态计算当前颜色。
      var hex = hsvToHex(colorLabState.h, colorLabState.s, colorLabState.v);
      syncColorLabUi(hex);
      applyColorLabValue(hex, true);
    });
  }
  // 颜色实验室十六进制输入框。
  var hexInput = document.getElementById('color-lab-hex');
  if (hexInput && !hexInput._bound) {
    // 防重复绑定标记。
    hexInput._bound = true;
    hexInput.addEventListener('change', function(){
      // 输入色值归一化。
      var hex = normalizeHexColor(hexInput.value || '#000000', '#000000');
      syncColorLabUi(hex);
      applyColorLabValue(hex);
    });
  }
  // 颜色实验室预设色容器。
  var presets = document.getElementById('color-lab-presets');
  if (presets && !presets._bound) {
    // 防重复绑定标记。
    presets._bound = true;
    presets.addEventListener('click', function(e){
      // 命中的预设色按钮。
      var btn = e.target && e.target.closest ? e.target.closest('[data-color]') : null;
      if (!btn) return;
      // 预设色值。
      var hex = normalizeHexColor(btn.getAttribute('data-color') || '#000000', '#000000');
      syncColorLabUi(hex);
      applyColorLabValue(hex);
    });
  }
  if (!document._colorLabOutsideBound) {
    // 全局只绑定一次颜色弹层外部点击关闭。
    document._colorLabOutsideBound = true;
    document.addEventListener('mousedown', function(e){
      // 颜色实验室弹层。
      var pop = document.getElementById('color-lab-pop');
      if (!pop || !pop.classList.contains('show')) return;
      if (e.target && (e.target.closest('#color-lab-pop') || e.target.closest('.lyric-color-picker') || e.target.closest('.lyric-color-row'))) return;
      closeColorLab();
    }, true);
    document.addEventListener('mousedown', function(e){
      // 封面取色弹层。
      var pop = document.getElementById('cover-color-pop');
      if (!pop || !pop.classList.contains('show')) return;
      if (e.target && (e.target.closest('#cover-color-pop') || e.target.closest('#visual-tint-auto-btn'))) return;
      closeCoverColorPicker();
    }, true);
  }
  // 三态
  // 歌单架模式按钮。
  document.querySelectorAll('#shelf-seg button').forEach(function(b){
    b.addEventListener('click', function(){ setShelfMode(b.dataset.shelf); });
  });
  // 歌单架镜头模式按钮。
  document.querySelectorAll('#shelf-camera-seg [data-shelf-camera]').forEach(function(b){
    b.addEventListener('click', function(){ setShelfCameraMode(b.getAttribute('data-shelf-camera')); });
  });
  // 歌单架显示策略按钮。
  document.querySelectorAll('#shelf-presence-seg [data-shelf-presence]').forEach(function(b){
    b.addEventListener('click', function(){ setShelfPresence(b.getAttribute('data-shelf-presence')); });
  });
  // 歌词行数模式按钮。
  document.querySelectorAll('#lyric-display-mode-seg [data-lyric-display]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setLyricDisplayMode(btn.getAttribute('data-lyric-display'));
    });
  });
  // 双语翻译模式按钮。
  document.querySelectorAll('#lyric-translation-mode-seg [data-lyric-translation]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setLyricTranslationMode(btn.getAttribute('data-lyric-translation'));
    });
  });
  // AI 立体增强模式按钮。
  document.querySelectorAll('#ai-depth-mode-seg [data-ai-depth-mode]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setAIDepthMode(btn.getAttribute('data-ai-depth-mode'));
    });
  });
  // 云端深度服务地址。
  var aiDepthCloudInput = document.getElementById('ai-depth-cloud-api');
  if (aiDepthCloudInput) {
    aiDepthCloudInput.addEventListener('change', function(){
      setAIDepthCloudApi(aiDepthCloudInput.value);
    });
    aiDepthCloudInput.addEventListener('keydown', function(e){
      if (e.key === 'Enter') {
        e.preventDefault();
        setAIDepthCloudApi(aiDepthCloudInput.value);
      }
    });
  }
  // 后台策略按钮。
  document.querySelectorAll('#performance-background-seg [data-performance-background]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setPerformanceBackgroundMode(btn.getAttribute('data-performance-background'));
    });
  });
  // 画质档位按钮。
  document.querySelectorAll('#performance-quality-seg [data-performance-quality]').forEach(function(btn){
    btn.addEventListener('click', function(){
      setPerformanceQualityMode(btn.getAttribute('data-performance-quality'));
    });
  });
  updateFxInputs();
}
// 切换布尔型视觉功能开关。
function toggleFx(key) {
  if (key === 'wallpaperMode') {
    showWallpaperModeHint();
    return;
  }
  if (isDevelopmentLockedFx(key)) {
    // 开发锁功能不能开启，恢复合法状态并提示用户。
    normalizeDevelopmentLockedFxState();
    saveLyricLayout();
    updateFxInputs();
    applyWallpaperModeState(true);
    showToast('开发中，暂不可用');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(fxDefaults, key) || typeof fxDefaults[key] !== 'boolean') return;
  fx[key] = !fx[key];
  // 根据字段名映射到对应开关 DOM id。
  var toggleId = 't-' + (key === 'floatLayer' ? 'float' : key);
  // 对应开关节点。
  var toggle = document.getElementById(toggleId);
  if (toggle) toggle.classList.toggle('on', fx[key]);
  syncFxUniforms();
  if (key === 'lyricCameraLock' || key === 'lyricGlow' || key === 'lyricGlowBeat' || key === 'lyricGlowParticles' || key === 'bloom' || key === 'edge' || key === 'cinema' || key === 'liveBackgroundKeep') saveLyricLayout();
  // 浮空粒子层需要同步创建或销毁。
  if (key === 'floatLayer') { if (fx.floatLayer) createFloatLayer(); else destroyFloatLayer(); }
  if (key === 'liveBackgroundKeep') {
    // 旧直播后台保持开关同步到新的后台策略。
    fx.performanceBackground = fx.liveBackgroundKeep ? 'keep' : 'auto';
    updatePerformanceControls();
    saveLyricLayout();
    if (fx.liveBackgroundKeep && backgroundCacheTrimTimer) {
      clearTimeout(backgroundCacheTrimTimer);
      backgroundCacheTrimTimer = 0;
    }
    updateRenderPowerClasses();
    applyRendererPowerMode();
    if (fx.liveBackgroundKeep) recoverVisualsAfterBackground('live-background-keep');
  }
  if (key === 'lyricGlow') showToast(fx.lyricGlow ? '歌词溢光已开启' : '歌词溢光已关闭');
  if (key === 'lyricGlowBeat') showToast(fx.lyricGlowBeat ? '歌词溢光跟随鼓点' : '歌词溢光已脱离鼓点');
  if (key === 'lyricGlowParticles') showToast(fx.lyricGlowParticles ? '歌词光粒已开启' : '歌词光粒已关闭');
  if (key === 'liveBackgroundKeep') showToast(fx.liveBackgroundKeep ? '直播后台保持已开启' : '直播后台保持已关闭');
  if (key === 'lyricCameraLock') showToast(fx.lyricCameraLock ? '歌词已绑定镜头' : '歌词已恢复自由漂浮');
  if (key === 'bloom') showToast(fx.bloom ? '溢光已开启' : '溢光已关闭');
  if (key === 'edge') showToast(fx.edge ? '已开启轮廓高亮' : '已关闭轮廓高亮');
  if (key === 'cinema') showToast(fx.cinema ? '已开启电影镜头' : '已关闭电影镜头');
}
// 切换视觉控制台显示状态。
function toggleFxPanel(force) {
  // 控制台面板。
  var el = document.getElementById('fx-panel');
  if (!el) return;
  // 当前是否打开或处于 peek 状态。
  var currentlyOpen = el.classList.contains('show') || el.classList.contains('peek');
  if (peekTimers && peekTimers.fx) { clearTimeout(peekTimers.fx); peekTimers.fx = null; }
  fxPanelPinned = false;
  if (force === false) {
    // 强制关闭时播放 closing 状态。
    el.classList.remove('show', 'peek');
    el.classList.toggle('closing', currentlyOpen);
    setTimeout(function(){ el.classList.remove('closing'); }, 280);
    // 同步悬浮按钮状态。
    var fab = document.getElementById('fx-fab');
    if (fab) fab.classList.remove('active');
    return;
  }
  // 其它情况进入 peek 状态。
  el.classList.remove('show', 'closing');
  setPeek(el, true, 'fx');
}
// 恢复视觉参数到默认值，同时保留歌单架显示配置。
function resetFx() {
  // 当前歌单架模式。
  var savedShelf = fx.shelf;
  // 当前歌单架镜头模式。
  var savedShelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  // 当前歌单架显示策略。
  var savedShelfPresence = normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence);
  fx = Object.assign({}, fxDefaults, {
    shelf: savedShelf,
    shelfCameraMode: savedShelfCameraMode,
    shelfPresence: savedShelfPresence,
    shelfAngleY: shelfDefaultAngleForCameraMode(savedShelfCameraMode),
    shelfAngleYManual: false
  });
  applyCoverParticleResolution(fx.coverResolution, { reload: true });
  updateFxInputs();
  applyWallpaperModeState(true);
  updateRenderPowerClasses();
  applyRendererPowerMode();
  setStageLyricPalette(stageLyrics.coverPalette || stageLyrics.palette);
  setPreset(fx.preset, { silent: true, preserveCamera: true, skipTransition: true });
  if (fx.floatLayer) createFloatLayer(); else destroyFloatLayer();
  if (shelfManager && shelfManager.rebuild) shelfManager.rebuild(true);
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  saveLyricLayout();
  showToast('已恢复默认参数');
}

// 刷新歌词行数模式按钮状态。
function updateLyricDisplayModeControls() {
  fx.lyricDisplayMode = normalizeLyricDisplayMode(fx.lyricDisplayMode);
  document.querySelectorAll('#lyric-display-mode-seg [data-lyric-display]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-lyric-display') === fx.lyricDisplayMode);
  });
  // 只有自定模式才需要显示行数滑块。
  var customLines = document.getElementById('fx-lyriccustomlines');
  if (customLines && customLines.parentElement) {
    customLines.parentElement.style.display = fx.lyricDisplayMode === 'custom' ? '' : 'none';
  }
}

// 刷新双语翻译模式按钮状态。
function updateLyricTranslationModeControls() {
  fx.lyricTranslationMode = normalizeLyricTranslationMode(fx.lyricTranslationMode);
  document.querySelectorAll('#lyric-translation-mode-seg [data-lyric-translation]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-lyric-translation') === fx.lyricTranslationMode);
  });
}

// 当前歌词是否带有任何可用译文。
function currentLyricsHaveTranslation() {
  if (typeof lyricsLines === 'undefined' || !lyricsLines) return false;
  for (var i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i] && String(lyricsLines[i].translation || '').trim()) return true;
  }
  return false;
}

// 设置歌词行数模式。
function setLyricDisplayMode(mode) {
  mode = normalizeLyricDisplayMode(mode);
  fx.lyricDisplayMode = mode;
  updateLyricDisplayModeControls();
  // 按新模式重算行清单并重建轨道，不能沿用切换前那份。
  refreshCurrentLyricStyle();
  saveLyricLayout();
  if (mode === 'single') showToast('歌词显示为单行');
  else if (mode === 'dual') showToast('歌词显示为双行');
  else if (mode === 'triple') showToast('歌词显示为三行');
  else if (mode === 'cinema') showToast('歌词进入沉浸模式');
  else showToast('歌词显示 ' + lyricCustomLineCountValue() + ' 行');
}

// 设置双语翻译模式。
function setLyricTranslationMode(mode) {
  mode = normalizeLyricTranslationMode(mode);
  fx.lyricTranslationMode = mode;
  updateLyricTranslationModeControls();
  // 译文槽位会改变整条轨道的行距，必须重算行清单。
  refreshCurrentLyricStyle();
  saveLyricLayout();
  if (mode === 'off') { showToast('已关闭双语翻译'); return; }
  // 宿主关闭翻译显示时下发的副歌词恒为空，这里给出明确提示，避免误判功能失效。
  if (!currentLyricsHaveTranslation()) { showToast('当前歌词没有翻译数据'); return; }
  if (mode === 'current') showToast('双语翻译：仅当前句');
  else if (mode === 'dual') showToast('双语翻译：当前句和下一句');
  else showToast('双语翻译：所有可见句');
}

// 刷新 AI 立体增强模式和云端配置 UI。
function updateAIDepthControls() {
  fx.aiDepthMode = normalizeAIDepthMode(fx.aiDepthMode);
  fx.aiDepthCloudApi = normalizeAIDepthCloudApi(fx.aiDepthCloudApi);
  document.querySelectorAll('#ai-depth-mode-seg [data-ai-depth-mode]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-ai-depth-mode') === fx.aiDepthMode);
  });
  var config = document.getElementById('ai-depth-cloud-config');
  if (config) config.classList.toggle('show', fx.aiDepthMode === 'cloud');
  var input = document.getElementById('ai-depth-cloud-api');
  if (input && input.value !== fx.aiDepthCloudApi) input.value = fx.aiDepthCloudApi;
}

// 设置 AI 立体增强模式。
function setAIDepthMode(mode) {
  mode = normalizeAIDepthMode(mode);
  fx.aiDepthMode = mode;
  if (mode === 'off') {
    // 关闭时禁用 AI 深度位移，避免已缓存深度继续影响当前封面。
    setCoverDepthState(0, 0, 240);
  } else {
    aiDepthFailUntil = 0;
    queueAIDepthForCurrentCover(true);
  }
  updateAIDepthControls();
  saveLyricLayout();
  if (mode === 'local') showToast('已开启本地 AI 立体增强');
  else if (mode === 'cloud') showToast(fx.aiDepthCloudApi ? '已开启云端 AI 立体增强' : '请先配置云端 API 地址');
  else showToast('已关闭 AI 立体增强');
}

// 保存云端深度服务地址。
function setAIDepthCloudApi(value) {
  var api = normalizeAIDepthCloudApi(value);
  fx.aiDepthCloudApi = api;
  updateAIDepthControls();
  saveLyricLayout();
  if (!api) {
    showToast('云端 API 地址为空或无效');
    return;
  }
  if (isCloudAIDepthMode()) {
    aiDepthFailUntil = 0;
    queueAIDepthForCurrentCover(true);
  }
  showToast('云端 API 已保存');
}

// 应用 3D 歌单架运行态模式，不负责持久化。
function enforceWallpaperShelfHidden() {
  if (!wallpaperRuntimeMode) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    safeShelfCloseContent('wallpaper-lock');
  }
  shelfPinnedOpen = false;
  shelfVisibility = 0;
  shelfHoverCue.target = 0;
  shelfHoverCue.value = 0;
  shelfHoverCue.zoneActive = false;
  shelfHoverCue.enteredAt = 0;
  if (typeof setShelfHoverTabVisible === 'function') setShelfHoverTabVisible(false);
  if (shelfManager && shelfManager.clearSelected) shelfManager.clearSelected();
  if (shelfManager && shelfManager.setMode) shelfManager.setMode('off');
  var bottomBar = document.getElementById('bottom-bar');
  if (bottomBar) bottomBar.classList.remove('stage-mode');
  var hint = document.getElementById('hint');
  if (hint) hint.classList.remove('shelf-hidden');
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
  return true;
}

function applyShelfModeRuntime(m) {
  // 归一化目标模式。
  m = /^(off|side|stage)$/.test(String(m || '')) ? m : fxDefaults.shelf;
  // 壁纸模式只锁运行态，不覆盖用户保存的歌单架配置。
  var runtimeMode = wallpaperRuntimeMode ? 'off' : m;
  if (!wallpaperRuntimeMode || !/^(off|side|stage)$/.test(String(fx.shelf || ''))) fx.shelf = m;
  document.querySelectorAll('#shelf-seg button').forEach(function(b){ b.classList.toggle('active', b.dataset.shelf === runtimeMode); });
  if (shelfManager) shelfManager.setMode(runtimeMode);
  // 舞台模式: 底部控件让位
  // 底部控制条节点。
  var bottomBar = document.getElementById('bottom-bar');
  if (bottomBar) bottomBar.classList.toggle('stage-mode', runtimeMode === 'stage');
  if (wallpaperRuntimeMode) enforceWallpaperShelfHidden();
  return runtimeMode;
}
// 设置 3D 歌单架模式。
function setShelfMode(m) {
  applyShelfModeRuntime(m);
  if (!wallpaperRuntimeMode) saveLyricLayout();
}

// 刷新歌单架控制相关 UI。
function updateShelfControlUi() {
  fx.shelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  fx.shelfPresence = normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence);
  // 歌单架镜头模式按钮。
  document.querySelectorAll('#shelf-camera-seg [data-shelf-camera]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-shelf-camera') === fx.shelfCameraMode);
  });
  // 歌单架显示策略按钮。
  document.querySelectorAll('#shelf-presence-seg [data-shelf-presence]').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-shelf-presence') === fx.shelfPresence);
  });
  // 当前歌单架强调色。
  var color = shelfAccentHex();
  // 歌单架强调色选择器。
  var picker = document.getElementById('shelf-accent-picker');
  // 歌单架强调色文本。
  var value = document.getElementById('shelf-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = color.toUpperCase();
}
// 刷新歌单架视觉状态。
function refreshShelfVisuals(reason) {
  updateShelfControlUi();
  if (wallpaperRuntimeMode) {
    enforceWallpaperShelfHidden();
    return;
  }
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  if (shelfManager && shelfManager.rebuild && reason === 'mode') shelfManager.rebuild(true);
}
// 设置歌单架镜头模式。
function setShelfCameraMode(mode) {
  fx.shelfCameraMode = normalizeShelfCameraMode(mode);
  applyShelfCameraDefaultAngle(true);
  setRange('fx-shelfangle', fx.shelfAngleY);
  updateShelfControlUi();
  if (wallpaperRuntimeMode) {
    enforceWallpaperShelfHidden();
    return;
  }
  if (fx.shelfCameraMode === 'static' && orbit && orbit.focus && /^shelf-/.test(String(orbit.focus.type || ''))) {
    setFocusZone(null, true);
  }
  saveLyricLayout();
  showToast(fx.shelfCameraMode === 'static' ? '3D歌单架: 静态镜头' : '3D歌单架: 动态镜头');
}
// 设置歌单架显示策略。
function setShelfPresence(mode) {
  fx.shelfPresence = normalizeShelfPresence(mode);
  updateShelfControlUi();
  if (wallpaperRuntimeMode) {
    enforceWallpaperShelfHidden();
    return;
  }
  applyShelfModeRuntime(fx.shelf);
  if (fx.shelfPresence === 'auto' && !shelfPinnedOpen) {
    shelfHoverCue.target = 0;
  }
  saveLyricLayout();
  showToast(fx.shelfPresence === 'always' ? '3D歌单架: 常驻' : '3D歌单架: 自动隐藏');
}
// 设置歌单架强调色。
function setShelfAccentColor(color, silent) {
  fx.shelfAccentColor = normalizeHexColor(color || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor);
  refreshShelfVisuals('color');
  saveLyricLayout();
  if (!silent) showToast('歌单架颜色: ' + fx.shelfAccentColor.toUpperCase());
}
// 重置歌单架强调色。
function resetShelfAccentColor() {
  setShelfAccentColor(fxDefaults.shelfAccentColor || '#f4d28a');
}

// 同步控制条自动隐藏按钮状态。
function syncControlsAutoHideButton() {
  // 控制条隐藏按钮。
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', controlsAutoHide);
  if (!controlsAutoHide && controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
}

// 静默设置舞台歌词粒子开关。
function setParticleLyricsSilently(on) {
  fx.particleLyrics = !!on;
  if (fx.particleLyrics) createLyricsParticles();
  else disposeLyricsParticles();
  lyricsVisible = fx.particleLyrics;
}

// 刷新沉浸模式按钮状态。
function updateImmersiveButton() {
  // 沉浸模式按钮。
  var btn = document.getElementById('immersive-btn');
  if (!btn) return;
  btn.classList.toggle('active', immersiveMode);
  btn.setAttribute('aria-pressed', immersiveMode ? 'true' : 'false');
  btn.title = immersiveMode ? '退出全沉浸式' : '全沉浸式';
  btn.setAttribute('aria-label', btn.title);
}

// 关闭进入沉浸模式时会干扰画面的弹层和提示。
function closeImmersiveInterference() {
  closeMiniQueue();
  ['ai-depth-chip', 'beat-chip'].forEach(function(id){
    // 需要隐藏的提示节点。
    var el = document.getElementById(id);
    if (el) el.classList.remove('peek', 'show', 'closing');
  });
  setFocusZone(null, true);
}

// 壁纸模式必须固定在全沉浸式，不允许通过快捷键或桥接命令退出。
function forceWallpaperImmersiveLock() {
  if (!wallpaperRuntimeMode) return;
  document.body.classList.add('wallpaper-runtime-mode');
  if (!immersiveMode) {
    immersiveMode = true;
    document.body.classList.add('immersive-mode');
  }
  closeImmersiveInterference();
  enforceWallpaperShelfHidden();
  controlsAutoHide = true;
  syncControlsAutoHideButton();
  updateImmersiveButton();
  syncCursorAutoHideMode();
  updateControlsChromeState();
}

// 设置全沉浸模式开关。
function setImmersiveMode(on) {
  on = !!on;
  if (!on && wallpaperRuntimeMode) {
    forceWallpaperImmersiveLock();
    return;
  }
  if (immersiveMode === on) return;

  if (on) {
    // 进入沉浸前保存可恢复状态。
    immersiveState = {
      shelfMode: fx.shelf,
      shelfPinnedOpen: shelfPinnedOpen,
      lyrics: fx.particleLyrics,
      controlsAutoHide: controlsAutoHide,
      bottomVisible: !!(document.getElementById('bottom-bar') && document.getElementById('bottom-bar').classList.contains('visible'))
    };
    immersiveMode = true;
    document.body.classList.add('immersive-mode');
    // 进入沉浸时底部控制条直接不可见，不再短暂显示迷你状态。
    controlsHovering = false;
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
    var bottomBarEnter = document.getElementById('bottom-bar');
    if (bottomBarEnter) bottomBarEnter.classList.remove('visible', 'soft-hidden');
    closeImmersiveInterference();
    // 沉浸模式下收起 3D 歌单架，退出时由保存状态恢复。
    setShelfPinnedOpen(false, true);
    applyShelfModeRuntime('off');
    if (!fx.particleLyrics) setParticleLyricsSilently(true);
    controlsAutoHide = true;
    syncControlsAutoHideButton();
    updateImmersiveButton();
    syncCursorAutoHideMode();
    updateControlsChromeState();
    return;
  }

  // 退出沉浸并恢复保存的状态。
  immersiveMode = false;
  document.body.classList.remove('immersive-mode');
  closeMiniQueue();
  if (immersiveState.shelfMode) setShelfMode(immersiveState.shelfMode);
  if (immersiveState.shelfMode === 'side' && immersiveState.shelfPinnedOpen) setShelfPinnedOpen(true, true);
  else setShelfPinnedOpen(false, true);
  if (immersiveState.lyrics === false) setParticleLyricsSilently(false);
  controlsAutoHide = immersiveState.controlsAutoHide !== false;
  syncControlsAutoHideButton();
  updateImmersiveButton();
  syncCursorAutoHideMode();
  var bottomBarExit = document.getElementById('bottom-bar');
  if (immersiveState.bottomVisible) revealBottomControls(900);
  else if (bottomBarExit) bottomBarExit.classList.remove('visible', 'soft-hidden');
  showToast('已退出全沉浸式');
}

// 切换全沉浸模式。
function toggleImmersiveMode() {
  if (wallpaperRuntimeMode) {
    forceWallpaperImmersiveLock();
    return;
  }
  setImmersiveMode(!immersiveMode);
}
