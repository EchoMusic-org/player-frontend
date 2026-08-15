// ===== js/07-audio-queue-lyrics.js =====

// 确保 UI 音效使用的 AudioContext 可用。
function ensureUiSfxContext() {
  // 浏览器 AudioContext 构造函数。
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  // 首次使用或上下文被关闭时重新创建。
  if (!uiSfxCtx || uiSfxCtx.state === 'closed') uiSfxCtx = new AudioContextCtor();
  // 用户手势后尝试恢复 suspended 状态。
  if (uiSfxCtx.state === 'suspended' && uiSfxCtx.resume) uiSfxCtx.resume().catch(function(){});
  return uiSfxCtx;
}

// 播放歌单架选择移动时的短促 UI 音效。
function playShelfSelectTick(direction, variant) {
  // 当前时间戳。
  var nowMs = performance.now();
  // 行和卡片使用不同最小触发间隔，避免滚轮高速时音效过密。
  var minGap = variant === 'row' ? 36 : 42;
  if (nowMs - lastShelfSelectSfxAt < minGap) return;
  // UI 音效上下文。
  var ctx = ensureUiSfxContext();
  if (!ctx) return;
  // 记录最近播放时间。
  lastShelfSelectSfxAt = nowMs;
  // 移动方向。
  var dir = direction < 0 ? -1 : 1;
  // 上下移动使用轻微不同音高。
  var pitch = dir > 0 ? 1.035 : 0.965;
  // 行音效比卡片音效略轻。
  var rowScale = variant === 'row' ? 0.74 : 1.0;
  // 音效音量跟随当前播放器音量。
  var volumeScale = 0.38 + Math.max(0, Math.min(1, targetVolume == null ? 0.65 : targetVolume)) * 0.62;
  // 音效开始时间。
  var t = ctx.currentTime + 0.002;
  // 输出增益节点。
  var out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.linearRampToValueAtTime(0.058 * rowScale * volumeScale, t + 0.002);
  out.gain.exponentialRampToValueAtTime(0.0001, t + 0.082);
  out.connect(ctx.destination);

  // 音频采样率。
  var sampleRate = ctx.sampleRate || 44100;
  // 噪声样本长度。
  var len = Math.max(1, Math.floor(sampleRate * 0.034));
  // 噪声缓冲区。
  var buf = ctx.createBuffer(1, len, sampleRate);
  // 噪声通道数据。
  var data = buf.getChannelData(0);
  for (var i = 0; i < len; i++) {
    // 噪声包络。
    var e = Math.pow(1 - i / len, 4.2);
    data[i] = (Math.random() * 2 - 1) * e;
  }
  // 噪声源。
  var noise = ctx.createBufferSource();
  noise.buffer = buf;
  // 高频滤波器。
  var hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(4200 * pitch, t);
  // 带通滤波器突出点击质感。
  var bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(8400 * pitch, t);
  bp.Q.setValueAtTime(7.2, t);
  // 噪声增益。
  var ng = ctx.createGain();
  ng.gain.setValueAtTime(0.56, t);
  noise.connect(hp);
  hp.connect(bp);
  bp.connect(ng);
  ng.connect(out);
  noise.start(t);
  noise.stop(t + 0.040);

  // 创建一个短振荡器点击层。
  function clickOsc(type, freq, delay, dur, gainValue, bend) {
    // 振荡器。
    var osc = ctx.createOscillator();
    // 振荡器增益。
    var g = ctx.createGain();
    // 开始时间。
    var start = t + delay;
    // 结束时间。
    var end = start + dur;
    osc.type = type;
    osc.frequency.setValueAtTime(freq * pitch, start);
    osc.frequency.exponentialRampToValueAtTime(freq * pitch * (bend || 0.72), end);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gainValue, start + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(out);
    osc.start(start);
    osc.stop(end + 0.004);
  }

  // 叠加多个短促音层，形成清脆选择反馈。
  clickOsc('triangle', 720, 0.000, 0.030, 0.18, 0.70);
  clickOsc('square', 2180, 0.004, 0.022, 0.30, 0.86);
  clickOsc('triangle', 4200, 0.011, 0.018, 0.18, 0.94);
  clickOsc('square', 7100, 0.018, 0.012, 0.070, 0.98);
  // 音效结束后断开输出节点。
  setTimeout(function(){
    try { out.disconnect(); } catch (_) {}
  }, 160);
}

// 将当前目标音量写入 audio 元素。
function applyVolumeToAudio() {
  if (audio) {
    audio.muted = false;
    audio.volume = targetVolume;
  }
}

// 根据 targetVolume 刷新音量滑块、数值和图标。
function updateVolumeUi() {
  // 音量滑块。
  var slider = document.getElementById('volume-slider');
  // 音量百分比文本。
  var value = document.getElementById('volume-value');
  // 音量图标。
  var icon = document.getElementById('volume-icon');
  // 音量控件外层。
  var wrap = document.getElementById('volume-control');
  // 当前音量百分比。
  var pct = Math.round(targetVolume * 100);
  if (slider && Math.abs(parseFloat(slider.value) - targetVolume) > 0.001) slider.value = targetVolume;
  if (value) value.textContent = pct + '%';
  if (wrap) wrap.classList.toggle('muted', targetVolume <= 0.01);
  if (icon) {
    // 根据音量区间切换静音、低音量和高音量图标。
    icon.innerHTML = targetVolume <= 0.01
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="17" y1="9" x2="22" y2="14"/><line x1="22" y1="9" x2="17" y2="14"/>'
      : targetVolume < 0.45
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 10.5a2 2 0 0 1 0 3"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/>';
  }
}

// 设置播放器音量并同步宿主。
function setVolume(value, silent) {
  // 音量归一化到 0..1。
  var next = Math.max(0, Math.min(1, Number(value) || 0));
  targetVolume = next;
  if (next > 0.01) lastNonZeroVolume = next;
  applyVolumeToAudio();
  updateVolumeUi();
  sendEchoHostCommand('volume', { value: next });
  saveStatePatch({ volume: next });
  if (!silent) showToast('音量 ' + Math.round(next * 100) + '%');
}
// 通过键盘快捷键按步进调整音量。
function adjustVolumeByKeyboard(delta) {
  // 音量步长。
  var step = Number(delta) || 0;
  if (!step) return;
  setVolume(clampRange(targetVolume + step, 0, 1), false);
}

// 保持音量浮层打开。
function keepVolumePanelOpen() {
  // 音量控件外层。
  var wrap = document.getElementById('volume-control');
  if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
  if (wrap) wrap.classList.add('open');
}

// 延迟关闭音量浮层。
function closeVolumePanelSoon() {
  // 音量控件外层。
  var wrap = document.getElementById('volume-control');
  if (volumeCloseTimer) clearTimeout(volumeCloseTimer);
  volumeCloseTimer = setTimeout(function(){
    volumeCloseTimer = null;
    if (wrap) wrap.classList.remove('open');
  }, 520);
}

// 将滚轮事件转换为音量变化量。
function volumeWheelDelta(e) {
  if (!e || !isFinite(e.deltaY) || e.deltaY === 0) return 0;
  // 限制单次滚轮幅度，避免高精度触控板一次改变过多。
  var normalized = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120);
  // macOS 和 Windows 滚轮方向习惯差异。
  var platform = String(navigator.platform || '').toLowerCase();
  var direction = platform.indexOf('mac') >= 0 ? 1 : -1;
  return (normalized / 120) * 0.05 * direction;
}

// 计算滚轮调整后的目标音量。
function targetVolumeAfterWheel(e) {
  // 滚轮音量增量。
  var delta = volumeWheelDelta(e);
  if (!delta) return targetVolume;
  return clampRange(targetVolume + delta, 0, 1);
}

// 静音和恢复上次非零音量。
function toggleMute(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  setVolume(targetVolume > 0.01 ? 0 : (lastNonZeroVolume || 0.8), true);
}

// 绑定音量控件事件。
function bindVolumeControls() {
  // 音量滑块。
  var slider = document.getElementById('volume-slider');
  // 音量控件外层。
  var wrap = document.getElementById('volume-control');
  if (wrap) {
    wrap.addEventListener('mouseenter', keepVolumePanelOpen);
    wrap.addEventListener('mouseleave', closeVolumePanelSoon);
  }
  if (slider) {
    slider.addEventListener('focus', keepVolumePanelOpen);
    slider.addEventListener('blur', closeVolumePanelSoon);
  }
  document.addEventListener('click', function(e){
    if (!wrap) return;
    if (!wrap.contains(e.target)) {
      // 点击外部时立即关闭音量浮层。
      if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
      wrap.classList.remove('open');
    }
  });
  updateVolumeUi();
  applyVolumeToAudio();
}

// ============================================================
//  播放队列
// ============================================================
// 规范化发送给宿主的歌曲对象。
function hostCommandSong(song) {
  if (!song) return null;
  // 克隆歌曲，避免补字段时修改原对象。
  var cloned = typeof cloneSong === 'function' ? cloneSong(song) : Object.assign({}, song);
  // 宿主需要的歌曲 id。
  var id = cloned.id != null && cloned.id !== '' ? cloned.id : (cloned.hash || cloned.trackId || '');
  // hash 兼容字段。
  var hash = cloned.hash || id;
  if (id == null || id === '') return null;
  // 统一写入宿主需要的字段。
  cloned.id = String(id);
  cloned.hash = String(hash || id);
  cloned.title = cloned.title || cloned.name || '未知歌曲';
  cloned.name = cloned.name || cloned.title;
  cloned.artist = cloned.artist || '未知歌手';
  cloned.coverUrl = cloned.coverUrl || cloned.cover || '';
  cloned.cover = cloned.cover || cloned.coverUrl || '';
  cloned.duration = Number(cloned.duration || 0);
  return cloned;
}
// 向 EchoMusic 宿主发送桥接命令。
function sendEchoHostCommand(name, payload) {
  window.__echoBridgeCommand(name, payload || {});
}
// 请求宿主播放指定歌曲。
function requestHostPlaySong(song) {
  // 规范化后的歌曲载荷。
  var payloadSong = hostCommandSong(song);
  if (!payloadSong) return false;
  sendEchoHostCommand('play-song', { song: payloadSong });
  return true;
}
// 请求宿主将指定歌曲插入下一首。
function requestHostPlayNextSong(song) {
  // 规范化后的歌曲载荷。
  var payloadSong = hostCommandSong(song);
  if (!payloadSong) return false;
  sendEchoHostCommand('queue-play-next-song', { song: payloadSong });
  return true;
}
// 将二级内容中的歌曲发送为下一首。
function queueDetailSongNext(song) {
  if (!song) return;
  requestHostPlayNextSong(song);
  if (typeof showToast === 'function') showToast('已发送下一首: ' + (song.name || ''));
}
// 请求宿主把队列指定索引设置为下一首。
function requestHostPlayNextIndex(i) {
  i = Number(i);
  if (!isFinite(i) || i < 0 || i >= playQueue.length) return;
  sendEchoHostCommand('queue-play-next-index', { index: i });
}
// 首次播放是否已经完成。
var firstPlayDone = false;

// 请求宿主播放队列中的指定索引。
async function playQueueAt(idx, opts) {
  opts = opts || {};
  hideLoading();
  forcePlaybackControlsInteractive();
  // 目标队列索引。
  idx = Number(idx);
  if (!isFinite(idx) || idx < 0) return false;
  sendEchoHostCommand('play-index', { index: idx });
  return false;
}
// 请求宿主切换播放/暂停。
async function togglePlay() {
  if (playToggleBusy) return;
  playToggleBusy = true;
  forcePlaybackControlsInteractive();
  hideLoading();
  sendEchoHostCommand('toggle-play');
  playToggleBusy = false;
}
// 设置播放按钮图标。
function setPlayIcon(p) {
  document.getElementById('play-icon').innerHTML = p
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<path d="M8 5v14l11-7z"/>';
}
// 请求宿主播放下一首。
function nextTrack() {
  playToggleBusy = false;
  forcePlaybackControlsInteractive();
  sendEchoHostCommand('next');
}
// 请求宿主播放上一首。
function prevTrack() {
  playToggleBusy = false;
  forcePlaybackControlsInteractive();
  sendEchoHostCommand('prev');
}
// 请求宿主切换随机模式。
function shuffleQueue() {
  sendEchoHostCommand('set-mode', { mode: 'random' });
}
// 请求宿主清空播放队列。
function clearQueue() {
  sendEchoHostCommand('queue-clear');
}
// 请求宿主移除播放队列中的指定索引。
function removeFromQueue(idx) {
  // 队列索引归一化为数字。
  idx = Number(idx);
  if (!isFinite(idx) || idx < 0) return;
  sendEchoHostCommand('queue-remove-index', { index: idx });
}
// 将播放模式 key 转换为用户可读标签。
function playModeLabel(mode) {
  return { loop: '顺序循环', shuffle: '随机播放', single: '单曲循环' }[mode] || '顺序循环';
}

// 根据播放模式返回对应的 SVG 图标片段。
function playModeIconMarkup(mode) {
  if (mode === 'shuffle') {
    // 随机播放图标。
    return '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>';
  }
  if (mode === 'single') {
    // 单曲循环图标。
    return '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M12 9v6"/><path d="M10.5 10.5 12 9l1.5 1.5"/>';
  }
  // 默认顺序循环图标。
  return '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
}

// 刷新播放模式按钮的文本、图标、可访问标签和切换动画。
function updatePlayModeButton(animate) {
  // 当前播放模式标签。
  var label = playModeLabel(playMode);
  // 播放模式按钮。
  var btn = document.getElementById('play-mode-btn');
  // 播放模式图标容器。
  var icon = document.getElementById('play-mode-icon');
  if (btn) {
    // 用 dataset、title 和 aria-label 同步当前模式。
    btn.dataset.mode = playMode;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('active', playMode !== 'loop');
  }
  if (icon) icon.innerHTML = playModeIconMarkup(playMode);
  if (!animate || !btn) return;
  if (window.gsap) {
    // 使用 GSAP 做按钮弹跳和外扩光圈。
    window.gsap.killTweensOf(btn);
    if (icon) window.gsap.killTweensOf(icon);
    window.gsap.timeline({ defaults: { overwrite: true } })
      .fromTo(btn, { scale: 0.86, rotate: -8 }, { scale: 1.12, rotate: 4, duration: 0.16, ease: 'power2.out' })
      .to(btn, { scale: 1, rotate: 0, duration: 0.34, ease: 'back.out(2.1)' });
    window.gsap.fromTo(btn,
      { boxShadow: '0 0 0 0 rgba(255,63,85,.36)' },
      { boxShadow: '0 0 0 14px rgba(255,63,85,0)', duration: 0.58, ease: 'sine.out', overwrite: false, onComplete: function(){ window.gsap.set(btn, { clearProps: 'boxShadow' }); } }
    );
    if (icon) window.gsap.fromTo(icon, { y: 4, autoAlpha: 0.32, rotate: -22, scale: 0.74 }, { y: 0, autoAlpha: 1, rotate: 0, scale: 1, duration: 0.42, ease: 'expo.out', overwrite: true });
  } else {
    // 无 GSAP 时使用 CSS class 触发一次过渡动画。
    btn.classList.remove('mode-switching');
    void btn.offsetWidth;
    btn.classList.add('mode-switching');
    setTimeout(function(){ btn.classList.remove('mode-switching'); }, 460);
  }
}

// 请求宿主循环切换播放模式。
function cyclePlayMode() {
  sendEchoHostCommand('cycle-mode');
}
// 初始化播放模式按钮为当前状态，不播放动画。
updatePlayModeButton(false);

// 控制条玻璃位移图的尺寸缓存状态。
var controlGlassState = { key: '' };
// 将控制条玻璃色散偏移写入 SVG filter（固定为无色差偏移 0）。
function applyControlGlassChromaticOffset() {
  // 控制条玻璃滤镜节点。
  var filter = document.getElementById('mineradio-control-glass-filter');
  if (!filter) return;
  // 红蓝通道横向偏移量固定为 0，不产生附加色差位移。
  filter.querySelectorAll('feOffset').forEach(function(node){
    node.setAttribute('dx', '0');
    node.setAttribute('dy', '0');
  });
}
// 检测当前浏览器是否适合启用 SVG backdrop-filter 玻璃位移。
function supportsControlGlassSvgFilter() {
  try {
    // Safari 和 Firefox 对该滤镜组合兼容性不足，直接禁用。
    var ua = navigator.userAgent || '';
    if ((/Safari/.test(ua) && !/Chrome/.test(ua)) || /Firefox/.test(ua)) return false;
    // 使用 style 赋值探测浏览器是否接受 url filter。
    var div = document.createElement('div');
    div.style.backdropFilter = 'url(#mineradio-control-glass-filter)';
    return div.style.backdropFilter !== '';
  } catch (e) {
    return false;
  }
}
// 生成控制条玻璃位移贴图 data URL。
function generateControlGlassDisplacementMap(width, height, radius) {
  // 位移贴图宽度。
  width = Math.max(240, Math.round(width || 400));
  // 位移贴图高度。
  height = Math.max(48, Math.round(height || 92));
  // 圆角半径。
  radius = Math.max(12, Math.round(radius || 50));
  // 边缘折射带宽度比例。
  var borderWidth = 0.07;
  // 边缘实际宽度。
  var edge = Math.min(width, height) * (borderWidth * 0.5);
  // 内部稳定区域宽度。
  var innerW = Math.max(1, width - edge * 2);
  // 内部稳定区域高度。
  var innerH = Math.max(1, height - edge * 2);
  // 位移图 SVG 内容。
  var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
    '<linearGradient id="glass-red" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>' +
    '<linearGradient id="glass-blue" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>' +
    '</defs>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="black"/>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" rx="' + radius + '" fill="url(#glass-red)"/>' +
    '<rect x="0" y="0" width="' + width + '" height="' + height + '" rx="' + radius + '" fill="url(#glass-blue)" style="mix-blend-mode:difference"/>' +
    '<rect x="' + edge.toFixed(2) + '" y="' + edge.toFixed(2) + '" width="' + innerW.toFixed(2) + '" height="' + innerH.toFixed(2) + '" rx="' + radius + '" fill="hsl(0 0% 50% / 1)" style="filter:blur(11px)"/>' +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
// 根据元素实际尺寸刷新玻璃位移贴图。
function updateGlassDisplacementMapForElement(el, img, stateKey) {
  if (!el || !img) return;
  // 目标元素屏幕尺寸。
  var rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  // 读取元素圆角半径，保证位移图和真实外形一致。
  var radius = parseFloat(getComputedStyle(el).borderRadius) || 24;
  // 当前尺寸状态键。
  var key = Math.round(rect.width) + 'x' + Math.round(rect.height) + ':' + Math.round(radius);
  if (key === controlGlassState[stateKey]) return;
  controlGlassState[stateKey] = key;
  // 新的位移图 data URL。
  var href = generateControlGlassDisplacementMap(rect.width, rect.height, radius);
  img.setAttribute('href', href);
  try { img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href); } catch (e) {}
}
// 刷新底部控制条玻璃位移贴图。
function updateControlGlassDisplacementMap() {
  updateGlassDisplacementMapForElement(
    document.getElementById('bottom-bar'),
    document.getElementById('control-glass-map'),
    'key'
  );
}
// 初始化底部控制条玻璃表面滤镜和尺寸监听。
function initControlGlassSurface() {
  if (supportsControlGlassSvgFilter()) document.documentElement.classList.add('control-glass-svg-ok');
  applyControlGlassChromaticOffset();
  updateControlGlassDisplacementMap();
  // 底部控制条节点。
  var bar = document.getElementById('bottom-bar');
  if (window.ResizeObserver && bar) {
    // 控制条尺寸变化时重建位移贴图。
    var ro = new ResizeObserver(function(){
      requestAnimationFrame(updateControlGlassDisplacementMap);
    });
    if (bar) ro.observe(bar);
  }
  // 窗口尺寸变化也可能影响控制条宽度。
  window.addEventListener('resize', function(){
    requestAnimationFrame(updateControlGlassDisplacementMap);
  });
}

// 为底部播放控制按钮绑定悬停、按压和点击动画。
function bindPlayerControlAnimations() {
  if (!window.gsap) return;
  document.querySelectorAll('#bottom-bar .ctrl-btn').forEach(function(btn){
    if (!btn || btn.dataset.controlAnimBound === '1') return;
    // 防止重复绑定同一个按钮。
    btn.dataset.controlAnimBound = '1';
    // 当前按钮是否为主播放按钮。
    var isPlay = btn.id === 'play-btn';
    // 按钮内的图标动画目标。
    var iconTarget = btn.querySelector('svg,.lyrics-word-icon');
    // 判断当前按钮是否可播放动画。
    function canAnimate() {
      return !btn.disabled && !btn.classList.contains('busy');
    }
    // 指针悬停进入动画。
    function hoverIn(e) {
      if (!canAnimate() || (e && e.pointerType === 'touch')) return;
      window.gsap.to(btn, { y: -2, scale: isPlay ? 1.07 : 1.08, duration: 0.20, ease: 'power2.out', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: isPlay ? 1.08 : 1.10, duration: 0.22, ease: 'power2.out', overwrite: 'auto' });
    }
    // 指针离开或失焦时恢复按钮状态。
    function hoverOut() {
      window.gsap.to(btn, { y: 0, scale: 1, rotate: 0, duration: 0.26, ease: 'power2.out', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: 1, rotate: 0, duration: 0.22, ease: 'power2.out', overwrite: 'auto' });
    }
    // 按下按钮时的压缩反馈。
    function pressDown() {
      if (!canAnimate()) return;
      window.gsap.to(btn, { y: 0, scale: isPlay ? 0.91 : 0.90, duration: 0.10, ease: 'power2.out', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: 0.88, duration: 0.10, ease: 'power2.out', overwrite: 'auto' });
    }
    // 释放按钮时根据是否仍悬停决定回弹目标。
    function release(e) {
      if (!canAnimate()) return;
      // 触摸释放不按 hover 处理。
      var hovered = e && e.pointerType !== 'touch' && btn.matches(':hover');
      window.gsap.to(btn, { y: hovered ? -2 : 0, scale: hovered ? (isPlay ? 1.07 : 1.08) : 1, duration: 0.24, ease: 'back.out(1.9)', overwrite: 'auto' });
      if (iconTarget) window.gsap.to(iconTarget, { scale: hovered ? 1.06 : 1, duration: 0.22, ease: 'back.out(1.8)', overwrite: 'auto' });
    }
    // 点击时播放外扩脉冲反馈。
    function clickPulse() {
      if (!canAnimate() || btn.id === 'play-mode-btn') return;
      // 主播放按钮使用更大的脉冲。
      var pulseSize = isPlay ? 18 : 10;
      // 主播放按钮使用品牌红，其它按钮使用浅白。
      var pulseColor = isPlay ? 'rgba(255,63,85,.34)' : 'rgba(255,255,255,.22)';
      window.gsap.killTweensOf(btn, 'boxShadow');
      window.gsap.fromTo(btn,
        { boxShadow: '0 0 0 0 ' + pulseColor },
        { boxShadow: '0 0 0 ' + pulseSize + 'px rgba(255,63,85,0)', duration: isPlay ? 0.58 : 0.42, ease: 'sine.out', overwrite: false, onComplete: function(){ window.gsap.set(btn, { clearProps: 'boxShadow' }); } }
      );
      if (iconTarget) window.gsap.fromTo(iconTarget, { rotate: isPlay ? 0 : -5 }, { rotate: 0, duration: 0.34, ease: 'elastic.out(1,0.55)', overwrite: 'auto' });
    }
    // 绑定指针、鼠标和焦点事件。
    btn.addEventListener('pointerenter', hoverIn);
    btn.addEventListener('pointerleave', hoverOut);
    btn.addEventListener('pointercancel', hoverOut);
    btn.addEventListener('mousedown', function(e){ e.preventDefault(); });
    btn.addEventListener('pointerdown', pressDown);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('click', clickPulse);
    btn.addEventListener('focus', function(){ hoverIn(); });
    btn.addEventListener('blur', hoverOut);
  });
}

// 清理底部播放控制按钮的焦点和动画残留状态。
function clearPlayerControlFocusState(reason) {
  try {
    document.querySelectorAll('#bottom-bar .ctrl-btn').forEach(function(btn){
      if (!btn) return;
      // 如果按钮当前获得焦点，主动移除焦点。
      if (document.activeElement === btn) btn.blur();
      btn.classList.remove('focus-visible');
      if (window.gsap) {
        // 清理按钮本体动画并恢复基础状态。
        window.gsap.killTweensOf(btn);
        window.gsap.set(btn, { y: 0, scale: 1, rotate: 0, clearProps: 'boxShadow' });
        // 清理按钮图标动画。
        var iconTarget = btn.querySelector('svg,.lyrics-word-icon');
        if (iconTarget) {
          window.gsap.killTweensOf(iconTarget);
          window.gsap.set(iconTarget, { scale: 1, rotate: 0 });
        }
      } else {
        // 无 GSAP 时清空内联样式。
        btn.style.transform = '';
        btn.style.boxShadow = '';
      }
    });
  } catch (e) {
    console.warn('[ControlFocusClear]', reason || 'unknown', e);
  }
}

// ============================================================
//  歌词
// ============================================================
// 判断歌词文本是否属于“无歌词”占位内容。
function isNoLyricText(text) {
  // 去除空白和常见标点后再比较。
  var compact = String(text || '').replace(/\s+/g, '').replace(/[，,。.!！?？、~～]/g, '');
  return !compact ||
    compact === '纯音乐请欣赏' ||
    compact === '暂无歌词' ||
    compact === '暂无歌词敬请期待' ||
    compact === '此歌曲为没有填词的纯音乐请您欣赏';
}
// 读取当前歌词过滤正则文本。
function currentLyricFilterRegexText() {
  return normalizeLyricFilterRegexText(
    fx && fx.lyricFilterRegex,
    fxDefaults.lyricFilterRegex || DEFAULT_LYRIC_FILTER_REGEX
  );
}
// 编译当前可用的歌词过滤正则。
function activeLyricFilterMatcher() {
  if (!fx || fx.lyricFilterEnabled === false) return null;
  // 空规则表示不开启实际过滤，避免空正则匹配所有歌词。
  var pattern = currentLyricFilterRegexText();
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch (e) {
    return null;
  }
}
// 获取首行过滤时展示的歌曲兜底文本。
function lyricFilterFallbackText(snapshot) {
  // 桥接快照中的当前歌曲。
  var track = snapshot && snapshot.track ? snapshot.track : {};
  // 歌名。
  var title = String((track && (track.name || track.title)) || '').trim() || '未知歌曲';
  // 歌手。
  var artist = String((track && track.artist) || '').trim() || '未知歌手';
  return title + ' - ' + artist;
}
// 生成歌词过滤签名，确保配置变化后同一份歌词也会重新处理。
function lyricFilterSignature(snapshot) {
  return [
    fx && fx.lyricFilterEnabled !== false ? '1' : '0',
    currentLyricFilterRegexText(),
    lyricFilterFallbackText(snapshot)
  ].join('::');
}
// 判断单行歌词是否命中过滤规则。
function lyricLineMatchesFilter(line, matcher) {
  if (!matcher || !line) return false;
  // 主歌词优先，缺失时退回副歌词。
  var text = String(line.text || line.secondary || '');
  if (!text) return false;
  matcher.lastIndex = 0;
  return matcher.test(text);
}
// 构造首行被过滤时使用的合成歌词行。
function buildLyricFilterFallbackLine(line, index, snapshot) {
  // 复用被过滤行的时间字段，文本替换为歌曲信息。
  var fallback = Object.assign({}, line || {});
  fallback.text = lyricFilterFallbackText(snapshot);
  fallback.secondary = '';
  fallback.characters = [];
  fallback.source = 'echo-filter-fallback';
  fallback.source_index = line && line.source_index != null ? Number(line.source_index) : index;
  return fallback;
}
// 给未过滤歌词补齐原始行号，避免过滤后使用压缩数组索引。
function withLyricSourceIndex(line, index) {
  if (!line || line.source_index != null) return line;
  // 只在缺字段时浅拷贝，避免修改宿主传入的原始 payload。
  return Object.assign({}, line, { source_index: index });
}
// 在接收阶段过滤歌词行；命中的中间行直接移除，让上一行自然延续。
function filterReceivedLyricLines(lines, snapshot) {
  if (!Array.isArray(lines) || !lines.length) return [];
  // 当前过滤正则。
  var matcher = activeLyricFilterMatcher();
  if (!matcher) return lines;
  // 过滤后的歌词行。
  var output = [];
  // 是否已经插入首行兜底。
  var insertedFallback = false;
  lines.forEach(function(line, index) {
    if (!lyricLineMatchesFilter(line, matcher)) {
      output.push(withLyricSourceIndex(line, index));
      return;
    }
    if (!output.length && !insertedFallback) {
      output.push(buildLyricFilterFallbackLine(line, index, snapshot));
      insertedFallback = true;
    }
  });
  return output;
}
// 正则配置变化后刷新桥接歌词缓存。
function refreshLyricFilterOutput() {
  if (typeof window !== 'undefined' && typeof window.__refreshBridgeLyricsAfterFilterChange === 'function') {
    window.__refreshBridgeLyricsAfterFilterChange();
  }
}
// 刷新歌词过滤控件状态。
function updateLyricFilterControls() {
  // 当前启用状态。
  var enabled = !fx || fx.lyricFilterEnabled !== false;
  // 当前正则文本。
  var pattern = currentLyricFilterRegexText();
  // 配置块。
  var config = document.getElementById('lyric-filter-config');
  if (config) config.classList.toggle('off', !enabled);
  // 开关按钮。
  var toggle = document.getElementById('t-lyricFilterEnabled');
  if (toggle) {
    toggle.classList.toggle('on', enabled);
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }
  // 正则输入框。
  var input = document.getElementById('lyric-filter-regex');
  if (input && input.value !== pattern) input.value = pattern;
}
// 设置歌词过滤开关。
function setLyricFilterEnabled(enabled, silent) {
  if (!fx) return;
  // 新状态。
  var next = enabled !== false;
  if (fx.lyricFilterEnabled === next) {
    updateLyricFilterControls();
    return;
  }
  fx.lyricFilterEnabled = next;
  updateLyricFilterControls();
  saveLyricLayout();
  refreshLyricFilterOutput();
  if (!silent) showToast(next ? '歌词过滤已开启' : '歌词过滤已关闭');
}
// 切换歌词过滤开关。
function toggleLyricFilterEnabled() {
  setLyricFilterEnabled(!(fx && fx.lyricFilterEnabled !== false));
}
// 设置歌词过滤正则；非法正则会保留旧规则。
function setLyricFilterRegex(pattern, silent) {
  if (!fx) return false;
  // 旧规则用于非法输入回退。
  var previous = normalizeSavedLyricFilterRegex(fx.lyricFilterRegex);
  // 新规则，允许清空表示不实际过滤。
  var next = normalizeLyricFilterRegexText(pattern, '');
  if (next) {
    try {
      new RegExp(next);
    } catch (e) {
      fx.lyricFilterRegex = previous;
      updateLyricFilterControls();
      showToast('歌词过滤正则无效，已保留旧规则');
      return false;
    }
  }
  fx.lyricFilterRegex = next;
  updateLyricFilterControls();
  saveLyricLayout();
  refreshLyricFilterOutput();
  if (!silent) showToast(next ? '歌词过滤规则已更新' : '歌词过滤规则已清空');
  return true;
}
// 恢复默认歌词过滤正则。
function resetLyricFilterRegex() {
  if (setLyricFilterRegex(DEFAULT_LYRIC_FILTER_REGEX, true)) {
    showToast('已恢复默认歌词过滤规则');
  }
}
// 渲染歌词入口；当前版本由 3D 舞台歌词系统接管。
function renderLyrics() {
  // v8: 歌词渲染由 stageLyrics 在每帧 tickLyricsParticles 里推动
  clearStageLyrics();
}
// 切换舞台歌词显示状态。
function toggleLyricsPanel(force) {
  // force 为布尔值时直接写入，否则取反当前状态。
  if (force === false) fx.particleLyrics = false;
  else if (force === true) fx.particleLyrics = true;
  else fx.particleLyrics = !fx.particleLyrics;
  if (fx.particleLyrics) {
    // 开启时创建歌词粒子系统。
    createLyricsParticles();
    showToast('歌词已开启');
  } else {
    // 关闭时清理舞台歌词。
    clearStageLyrics();
    showToast('歌词已关闭');
  }
  lyricsVisible = fx.particleLyrics;
}
// 歌词高亮更新入口；当前由舞台歌词逐帧逻辑接管。
function updateLyricsHighlight() { /* v8: 由 tickLyricsParticles 接管 */ }


