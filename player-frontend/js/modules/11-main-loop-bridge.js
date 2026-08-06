// ===== js/11-main-loop-bridge.js =====

// ============================================================
//  主循环
// ============================================================
// 上一帧时间戳。
var prevTime = performance.now();
// 主循环性能计数器会挂到 window，便于宿主或调试面板观察实际帧率、跳帧和长帧数量。
// 渲染性能采样状态。
var renderPerfState = {
  // 当前渲染模式。
  mode: 'vsync',
  // 最近一次采样 FPS。
  fps: 0,
  // 当前采样窗口帧数。
  frames: 0,
  // 跳过的帧数。
  skipped: 0,
  // 长帧数量。
  longFrames: 0,
  // 上一次实际渲染时间。
  lastRenderAt: 0,
  // 上一次性能采样时间。
  lastSampleAt: performance.now()
};
// 暴露性能状态给调试和宿主。
window.__mineradioPerf = renderPerfState;
// 主循环是否已启动。
var mainLoopStarted = false;
// 主循环错误是否已上报。
var mainLoopErrorReported = false;
// 各视觉步骤错误上报标记。
var visualStepErrorReported = {};
function reportMainLoopError(error) {
  // 主循环异常只上报一次，避免同一错误每帧刷屏；桥接层仍继续工作，控制命令不受影响。
  if (mainLoopErrorReported) return;
  mainLoopErrorReported = true;
  console.warn('[EchoMusicBridge] 主循环异常，桥接层继续运行', error);
}
function safeVisualStep(label, fn) {
  // 可选视觉模块独立容错，某个模块失败时不会中断整帧渲染或播放器控制。
  try {
    fn();
  } catch (error) {
    if (visualStepErrorReported[label]) return;
    visualStepErrorReported[label] = true;
    console.warn('[EchoMusicBridge] 可选视觉步骤异常，已跳过本步骤: ' + label, error);
  }
}
function getAdaptiveRenderFps() {
  // 根据后台状态、可见模式和当前负载决定是否限帧；返回 0 表示跟随 requestAnimationFrame。
  if (isDeepBackgroundMode()) return 1;
  if (RENDER_VISIBLE_VSYNC) return 0;
  var tier = (typeof getRenderLoadTier === 'function') ? getRenderLoadTier() : 0;
  if (typeof isRenderInteractionActive === 'function' && isRenderInteractionActive()) {
    if (tier >= 2) return RENDER_INTERACTION_HUGE_FPS;
    if (tier >= 1) return RENDER_INTERACTION_LARGE_FPS;
    return RENDER_INTERACTION_FPS;
  }
  if (tier >= 2) return RENDER_HUGE_FPS;
  if (tier >= 1) return RENDER_LARGE_FPS;
  return RENDER_ACTIVE_FPS;
}
function shouldSkipAdaptiveRenderFrame(now) {
  // 限帧模式下直接跳过整帧视觉计算，减少隐藏窗口和重负载场景的 CPU/GPU 占用。
  var fps = getAdaptiveRenderFps();
  renderPerfState.mode = fps ? (fps + 'fps') : 'vsync';
  if (!fps) {
    renderPerfState.lastRenderAt = now;
    return false;
  }
  var minGap = 1000 / fps;
  if (now - renderPerfState.lastRenderAt < minGap) {
    renderPerfState.skipped += 1;
    return true;
  }
  renderPerfState.lastRenderAt = now;
  return false;
}
function sampleRenderPerf(now, dt) {
  // 每秒采样一次渲染性能，并顺带触发运行时缓存裁剪检查。
  renderPerfState.frames += 1;
  if (dt > 0.034) renderPerfState.longFrames += 1;
  if (now - renderPerfState.lastSampleAt >= 1000) {
    renderPerfState.fps = Math.round(renderPerfState.frames * 1000 / Math.max(1, now - renderPerfState.lastSampleAt));
    renderPerfState.frames = 0;
    renderPerfState.lastSampleAt = now;
  }
  maybeTrimRuntimeCaches(now);
}
function animate() {
  // 主循环只消费宿主已经推送的状态，不主动拉取网络或音频；每帧顺序是频谱分析、状态平滑、视觉更新、渲染。
  requestAnimationFrame(animate);
  try {
  // 当前帧时间戳。
  var now = performance.now();
  if (shouldSkipAdaptiveRenderFrame(now)) return;
  // 本帧时间步长，最长限制到 50ms。
  var dt = Math.min((now - prevTime) / 1000, 0.05);
  prevTime = now;
  sampleRenderPerf(now, dt);
  uniforms.uTime.value += dt;
  // 指针视差缓动。
  pointerParallax.x += (pointerTarget.x - pointerParallax.x) * 0.040;
  pointerParallax.y += (pointerTarget.y - pointerParallax.y) * 0.040;

  // 宿主频谱映射: 插件只消费 EchoMusic 推送的 bins/waveform/rms/peak。
  beatOnsetFlag = false;
  if (hasHostSpectrumFrame() && playing && audio && !audio.paused) {
    readHostFrequencyData(frequencyData);
    readHostWaveformData(timeDomainData);
    // 频谱长度。
    var len = frequencyData.length;
    // kick 低频区截止。
    var kickEnd  = 7;
    // 人声区截止。
    var vocalEnd = Math.min(len, 140);
    // 中频乐器区截止。
    var midEnd   = Math.min(len, 280);
    // 低频、中频、高频、人声和 RMS 累加值。
    var bKick = 0, mInst = 0, tHigh = 0, voc = 0, rms = 0;
    for (var i = 0; i < kickEnd; i++) bKick += frequencyData[i] / 255;
    for (var i = kickEnd; i < vocalEnd; i++) voc += frequencyData[i] / 255;
    for (var i = vocalEnd; i < midEnd; i++) mInst += frequencyData[i] / 255;
    for (var i = midEnd; i < len; i++) tHigh += frequencyData[i] / 255;
    for (var j = 0; j < timeDomainData.length; j++) {
      var tv = (timeDomainData[j] - 128) / 128;
      rms += tv * tv;
    }
    bKick /= kickEnd;
    voc /= (vocalEnd - kickEnd);
    mInst /= Math.max(1, midEnd - vocalEnd);
    tHigh /= Math.max(1, len - midEnd);
    rms = readHostSpectrumRms(Math.sqrt(rms / timeDomainData.length));

    // 动态峰值跟踪
    bassPeak = Math.max(bassPeak * 0.994, bKick, 0.030);
    midPeak  = Math.max(midPeak  * 0.993, mInst, 0.026);
    treblePeak = Math.max(treblePeak * 0.992, tHigh, 0.018);
    energyPeak = Math.max(energyPeak * 0.995, rms, 0.030);

    // 各频段相对峰值的归一化强度。
    var rb = Math.min(1, Math.pow(bKick / Math.max(0.038, bassPeak * 0.66), 0.78));
    var rm = Math.min(1, Math.pow(mInst / Math.max(0.025, midPeak  * 0.70), 0.86));
    var rt = Math.min(1, Math.pow(tHigh / Math.max(0.020, treblePeak * 0.74), 0.92));
    var re = Math.min(1, Math.pow(rms / Math.max(0.034, energyPeak * 0.68), 0.82));

    // 低频突增量。
    var bassOnset = Math.max(0, rb - smoothBass);
    // 总能量突增量。
    var energyOnset = Math.max(0, re - prevEnergy);
    prevEnergy = prevEnergy * 0.88 + re * 0.12;

    // 实时节拍引擎输出。
    var realtimeBeat = processRealtimeBeatEngine(dt);
    // 实时节拍优先用于镜头和粒子脉冲；预解析 beatmap 不可用时才承担主要触发职责。
    if (realtimeBeat && realtimeBeat.hit) {
      // 当前是否 DJ 模式。
      var dj = djMode.active;
      // DJ 节拍图是否覆盖当前播放时间。
      var djMapCoversCurrentTime = !dj || !currentDjBeatMap || !currentDjBeatMap.partialUntilSec || !audio || (audio.currentTime || 0) <= currentDjBeatMap.partialUntilSec - 1.25;
      // DJ 模式节拍图是否可用于相机。
      var djBeatMapReadyForCamera = dj && currentDjBeatMap && currentDjBeatMap.cameraBeats && currentDjBeatMap.cameraBeats.length >= 4 && djMapCoversCurrentTime;
      // 当前模式下节拍图是否可用于相机。
      var beatMapReadyForCamera = dj ? djBeatMapReadyForCamera : (currentBeatMap && currentBeatMap.cameraBeats && currentBeatMap.cameraBeats.length >= 4);
      // 是否还在等待离线节拍图。
      var waitingForBeatMap = false;
      // 实时 kick 触发帧判定。
      var liveKickFrame = dj
        ? (realtimeBeat.low > 0.48 && rb > 0.38 && bassOnset > 0.055 && energyOnset > 0.010 && (realtimeBeat.lowDominance || 0) > 0.82)
        : (realtimeBeat.low > 0.50 && rb > 0.42 && bassOnset > 0.070 && energyOnset > 0.016);
      // 强实时节拍判定。
      var liveStrongHit = dj
        ? (realtimeBeat.confidence > 0.60 && realtimeBeat.strength > 0.56 && realtimeBeat.score > 0.50 && liveKickFrame)
        : (realtimeBeat.confidence > 0.76 && realtimeBeat.strength > 0.70 && realtimeBeat.score > 0.56 && liveKickFrame);
      // 速度辅助节拍判定。
      var liveTempoHit = dj
        ? (realtimeBeat.tempoAssist && realtimeBeat.confidence > 0.62 && realtimeBeat.strength > 0.52 && realtimeBeat.low > 0.48 && (liveKickFrame || bassOnset > 0.046))
        : (realtimeBeat.tempoAssist && realtimeBeat.confidence > 0.80 && realtimeBeat.strength > 0.66 && realtimeBeat.low > 0.50 && bassOnset > 0.052);
      // 实时节拍是否允许作为离线节拍图补位。
      var liveFallbackOk = dj
        ? (liveStrongHit || liveTempoHit)
        : (waitingForBeatMap
          ? (liveStrongHit || liveTempoHit)
          : (realtimeBeat.confidence > 0.84 && realtimeBeat.strength > 0.80 && realtimeBeat.low > 0.54 && (liveKickFrame || realtimeBeat.score > 0.68)));
      if (!beatMapReadyForCamera && liveFallbackOk) {
        // 调度实时节拍相机事件。
        scheduleBeatCamera({
          time: realtimeBeat.time,
          strength: realtimeBeat.strength,
          confidence: realtimeBeat.confidence,
          low: realtimeBeat.low,
          body: realtimeBeat.body,
          snap: realtimeBeat.snap,
          mass: realtimeBeat.mass,
          sharpness: realtimeBeat.sharpness,
          combo: realtimeBeat.combo,
          impact: clamp01(realtimeBeat.strength * 0.46 + realtimeBeat.confidence * 0.20 + realtimeBeat.low * 0.28),
          preview: waitingForBeatMap,
          primary: true,
          dj: dj
        }, 'live');
      }
      if (!beatMapReadyForCamera && liveFallbackOk) {
        // 等待离线节拍图期间压低实时脉冲强度。
        var previewPulseScale = waitingForBeatMap && !dj ? 0.68 : 1;
        // 实时节拍粒子脉冲强度。
        var rtPulse = Math.min(dj ? 0.34 : (waitingForBeatMap ? 0.46 : 0.62), realtimeBeat.strength * (realtimeBeat.tempoAssist ? (dj ? 0.42 : 0.62) : (dj ? 0.48 : 0.68)) * previewPulseScale);
        if (rtPulse > beatPulse + 0.09) beatOnsetFlag = true;
        beatPulse = Math.max(beatPulse, rtPulse);
      }
    } else if (bassOnset > 0.075 && rb > 0.32 && energyOnset > 0.020) {
      beatPulse = Math.max(beatPulse, Math.min(0.12, bassOnset * 0.18));
    }
    beatPulse *= Math.pow(0.36, dt);

    // v7.2+: 预解析 beatmap 只在实时引擎暂时没锁住时补位.
    tickDjBeatMap();
    tickBeatMap();
    if (scheduledBeatFlag) {
      beatOnsetFlag = true;
      scheduledBeatFlag = false;
    }
    // scheduledBeatPulse 衰减并合并到 beatPulse
    if (scheduledBeatPulse > beatPulse) beatPulse = scheduledBeatPulse;
    scheduledBeatPulse *= Math.pow(0.32, dt);

    // 简单包络跟随函数。
    function env(prev, next, attack, release) {
      // 上升和下降使用不同响应速度。
      var k = next > prev ? attack : release;
      return prev + (next - prev) * k;
    }
    // smoothBass 主要由 kick 驱动 (不被人声干扰)
    smoothBass  = env(smoothBass, Math.min(0.82, rb * 0.78 + re * 0.025), 0.28, 0.075);
    // smoothMid 用 中高乐器, 不再混入人声
    smoothMid   = env(smoothMid,  Math.min(0.68, rm * 0.64 + re * 0.025), 0.18, 0.060);
    smoothTreb  = env(smoothTreb, Math.min(0.56, rt * 0.54), 0.18, 0.055);
    smoothEnergy= env(smoothEnergy, Math.min(0.72, re), 0.16, 0.055);
    updateCinemaDynamics(re, rb);
    updateCinemaTrackProfile({ energy: re, low: rb, vocal: voc, melody: rm, lowOnset: bassOnset, energyOnset: energyOnset });
    // 歌词阳光溢光: 独立于律动强度, 看持续能量 + 中高频抬升, 更像副歌/高音段落而不是单个鼓点.
    // 持续能量分量。
    var sunEnergy = clamp01((smoothEnergy - 0.18) / 0.38);
    // 人声分量。
    var sunVoice = clamp01((voc - 0.11) / 0.34);
    // 旋律中频分量。
    var sunMelody = clamp01((smoothMid - 0.16) / 0.27);
    // 空气高频分量。
    var sunAir = clamp01((smoothTreb - 0.105) / 0.17);
    // 合成阳光溢光原始强度。
    var sunRaw = clamp01(sunEnergy * 0.36 + sunVoice * 0.18 + sunMelody * 0.26 + sunAir * 0.20);
    sunRaw = sunRaw * sunRaw * (3 - 2 * sunRaw);
    lyricSunAvg += (sunRaw - lyricSunAvg) * 0.006;
    lyricSunPeak = Math.max(0.48, lyricSunPeak * 0.9985, sunRaw);
    // 动态阈值，避免安静段误触发太阳光。
    var sunThreshold = Math.max(0.78, lyricSunAvg + 0.20, lyricSunPeak * 0.74);
    // 超过阈值后的门控强度。
    var sunGate = clamp01((sunRaw - sunThreshold) / Math.max(0.08, 1.0 - sunThreshold));
    sunGate = sunGate * sunGate * (3 - 2 * sunGate);
    lyricSunHold += (sunGate - lyricSunHold) * (sunGate > lyricSunHold ? 0.035 : 0.014);
    lyricSunTarget = lyricSunHold > 0.16 ? clamp01((lyricSunHold - 0.16) / 0.84) : 0;
    lyricSunEnergy += (lyricSunTarget - lyricSunEnergy) * (lyricSunTarget > lyricSunEnergy ? 0.075 : 0.030);
  } else {
    // 无频谱或未播放时，各能量状态自然衰减。
    smoothBass *= 0.91; smoothMid *= 0.91; smoothTreb *= 0.91; smoothEnergy *= 0.91; beatPulse *= 0.82;
    liveCamAvg *= 0.94;
    liveCamPeak = Math.max(0.28, liveCamPeak * 0.98);
    liveCamLastRaw *= 0.80;
    lyricSunTarget = 0;
    lyricSunHold *= 0.90;
    lyricSunEnergy *= 0.92;
    lyricSunAvg *= 0.995;
    lyricSunPeak = Math.max(0.48, lyricSunPeak * 0.997);
  }
  // 全局音频能量。
  audioEnergy = Math.max(smoothEnergy, beatPulse * 0.30);
  // 最终低频视觉强度。
  bass = Math.min(0.90, smoothBass * 1.05 + beatPulse * 0.18) * fx.intensity;
  // 最终中频视觉强度。
  mid  = Math.min(0.72, smoothMid * 1.12) * fx.intensity;
  // 最终高频视觉强度。
  treble = Math.min(0.62, smoothTreb * 1.20) * fx.intensity;
  if (fx.preset >= 4) {
    // 壁纸预设使用更克制的音频响应。
    var wallpaperAudio = fx.preset === 5;
    // 圆环低频响应。
    var ringBass = smoothBass * (wallpaperAudio ? 1.10 : 1.58) + beatPulse * (wallpaperAudio ? 0.18 : 0.42) - smoothMid * 0.16 - smoothTreb * 0.06;
    // 圆环中频响应。
    var ringMid = smoothMid * (wallpaperAudio ? 1.16 : 1.82) - smoothBass * 0.14 - smoothTreb * 0.07;
    // 圆环高频响应。
    var ringTreble = smoothTreb * (wallpaperAudio ? 1.34 : 2.28) - smoothMid * 0.10 - smoothBass * 0.05;
    bass = Math.pow(clamp01((ringBass - 0.050) / 0.58), 0.72) * fx.intensity;
    mid = Math.pow(clamp01((ringMid - 0.045) / 0.46), 0.78) * fx.intensity;
    treble = Math.pow(clamp01((ringTreble - 0.030) / 0.34), 0.84) * fx.intensity;
    if (wallpaperAudio) {
      bass = Math.min(bass, 0.46 * fx.intensity);
      mid = Math.min(mid, 0.40 * fx.intensity);
      treble = Math.min(treble, 0.36 * fx.intensity);
      beatPulse *= 0.34;
    }
  }
  if (djMode.active) {
    // DJ 模式下提升低频脉冲和段落能量。
    bass = Math.min(1.00, bass * 1.06 + beatPulse * 0.085);
    mid = Math.min(0.76, mid * 1.00 + clamp01(djMode.sectionChange * 1.6) * 0.020);
    treble = Math.min(0.66, treble * 0.98);
    audioEnergy = Math.max(audioEnergy, beatPulse * 0.38, djMode.sectionEnergy * 0.54);
  }

  // 唱片旋转速度倍率。
  var vinylSpeedMul = isFinite(fx.speed) ? Math.max(0.05, fx.speed) : 1;
  // 唱片本帧旋转速度。
  var vinylSpinSpeed = (0.40 + smoothBass * 0.09) * vinylSpeedMul;
  uniforms.uVinylSpin.value = (uniforms.uVinylSpin.value + dt * vinylSpinSpeed) % (Math.PI * 2);

  updateParticlePointerFrame();
  // 写入 shader 音频强度 uniform。
  uniforms.uBass.value   = bass;
  uniforms.uMid.value    = mid;
  uniforms.uTreble.value = treble;
  uniforms.uBeat.value   = beatPulse;
  uniforms.uEnergy.value = audioEnergy;
  uniforms.uMouseXY.value.set(mouseWorld.x, mouseWorld.y);
  uniforms.uMouseActive.value = mouseActive ? 1 : 0;
  // 骷髅预设默认背景压暗值。
  var sonicActive = fx && fx.preset === SONIC_TOPGRAPHY_INDEX;
  var skullBackdropDim = fx && fx.preset === SKULL_PRESET_INDEX ? 0.58 : (sonicActive ? 0.55 : 1);
  // 歌单架或骷髅预设要求的粒子压暗目标。
  var shelfDimTarget = shouldDimWallpaperForShelf() ? 0.48 : skullBackdropDim;
  // 粒子压暗缓动速度。
  var shelfDimEase = shelfDimTarget < uniforms.uParticleDim.value ? 0.18 : 0.10;
  uniforms.uParticleDim.value += (shelfDimTarget - uniforms.uParticleDim.value) * Math.min(1, shelfDimEase * Math.max(1, dt * 60));

  // 通用转场脉冲: 只作为切换预设时的短促提亮。
  uniforms.uBurstAmt.value *= 0.90;
  tickPresetTransition();

  updateRipples(dt);
  updateFloatLayer(dt);
  // 共享主循环里只允许单个可选视觉模块失败，不让错误扩散到 renderer.render。
  if (shelfManager) safeVisualStep('playlist-shelf', function(){ shelfManager.update(dt); });
  tickLyricsParticles();

  // 电影镜头
  updateCinema(dt);
  updateFreeCamera(dt);
  updateCamera();
  applySkullCameraPose(dt);

  // v7.2 旋转 = 头部+眼球追踪 + 鼠标拖动 + 惯性
  tickParticleSpin(dt);
  // 骷髅预设是否激活。
  var skullPresetActive = fx && fx.preset === SKULL_PRESET_INDEX;
  // 音域预设是否激活。
  var sonicPresetActive = fx && fx.preset === SONIC_TOPGRAPHY_INDEX;
  var hideDefaultParticles = skullPresetActive || sonicPresetActive;
  // 骷髅/音域预设接管主粒子层时隐藏普通封面粒子。
  particles.visible = !hideDefaultParticles;
  if (bloomParticles) bloomParticles.visible = !hideDefaultParticles && fx.bloom && fx.bloomStrength > 0.01;
  if (floatGroup) floatGroup.visible = !hideDefaultParticles;
  if (backCoverGroup) backCoverGroup.visible = !hideDefaultParticles;
  // 粒子目标 Y 旋转。
  var targetRotY = orbit.centerLocked ? 0 : (headParallax.active ? headParallax.x * 0.5 : 0) + particleRotation.y;
  // 粒子目标 X 旋转。
  var targetRotX = orbit.centerLocked ? 0 : (headParallax.active ? -headParallax.y * 0.35 : 0) + particleRotation.x;
  particles.rotation.y += (targetRotY - particles.rotation.y) * 0.055;
  particles.rotation.x += (targetRotX - particles.rotation.x) * 0.055;
  if (bloomParticles) {
    bloomParticles.rotation.copy(particles.rotation);
  }
  // 同步给背面粒子层
  if (floatGroup) {
    floatGroup.rotation.copy(particles.rotation);
  }
  if (backCoverGroup) {
    backCoverGroup.rotation.copy(particles.rotation);
  }
  updateSkullParticleLayer(dt);
  // 音域预设音频帧
  var sonicAudioFrame = { subBass: bass, bass: bass, lowMid: mid, mid: mid, highMid: treble, presence: treble, brilliance: treble, air: treble, kickEnvelope: beatPulse, energy: audioEnergy, treble: treble, beat: beatPulse };
  if (typeof MineradioSonicTopography !== 'undefined' && MineradioSonicTopography.update) {
    safeVisualStep('sonic-topography', function(){ MineradioSonicTopography.update(dt, { fx: fx, scene: scene, audio: sonicAudioFrame }); });
  }

  updateStageLyrics3D(dt);
  syncDesktopOverlayState();

  // 缩略图脉动
  if (currentIdx >= 0) {
    // 缩略封面随低频轻微缩放。
    var s = 1 + bass * 0.08;
    // 缩略封面节点。
    var thumbCoverEl = document.getElementById('thumb-cover');
    if (thumbCoverEl) thumbCoverEl.style.transform = 'scale(' + s + ')';
  }

// 渲染当前场景。
renderer.render(scene, camera);
  } catch (error) {
    reportMainLoopError(error);
  }
}
// 安全启动主循环。
function startMainLoopSafely() {
  // 统一启动入口防止重复 requestAnimationFrame；失败时仍保留桥接层的消息处理能力。
  if (mainLoopStarted) return;
  mainLoopStarted = true;
  try {
    requestAnimationFrame(animate);
  } catch (error) {
    reportMainLoopError(error);
  }
}

// ============================================================
//  EchoMusic 插件桥接层
// ============================================================
// 应用布尔型可选视觉层运行态，不负责持久化。
function applyOptionalVisualLayerRuntimeState() {
  var requestedFloatLayer = !!fx.floatLayer;
  if (requestedFloatLayer) createFloatLayer();
  else destroyFloatLayer();
  if (requestedFloatLayer !== !!fx.floatLayer) {
    var floatToggle = document.getElementById('t-float');
    if (floatToggle) floatToggle.classList.toggle('on', fx.floatLayer);
  }
  if (fx.particleLyrics) createLyricsParticles();
  else disposeLyricsParticles();
  lyricsVisible = !!fx.particleLyrics;
  if (fx.backCover) createBackCoverLayer();
  else destroyBackCoverLayer();
}

// 应用性能相关运行态，不负责持久化。
function applyPerformanceRuntimeState() {
  fx.performanceBackground = normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true);
  fx.liveBackgroundKeep = fx.performanceBackground === 'keep';
  fx.performanceQuality = normalizePerformanceQuality(fx.performanceQuality);
  updatePerformanceControls();
  updateRenderPowerClasses();
  applyRendererPowerMode();
  if (fx.performanceBackground === 'keep') {
    recoverVisualsAfterBackground('storage-restore-keep');
  } else if (fx.performanceBackground === 'release' && isDeepBackgroundMode()) {
    trimRuntimeCaches('storage-restore-release', true);
  }
}

// 应用 AI 深度运行态，不负责持久化。
function applyAIDepthRuntimeState() {
  fx.aiDepthMode = normalizeAIDepthMode(fx.aiDepthMode);
  fx.aiDepthCloudApi = normalizeAIDepthCloudApi(fx.aiDepthCloudApi);
  updateAIDepthControls();
  if (!isAIDepthEnabled()) {
    setCoverDepthState(0, 0, 240);
    return;
  }
  aiDepthFailUntil = 0;
  queueAIDepthForCurrentCover(true);
}

// 应用歌单架运行态，不负责持久化。
function applyShelfRuntimeState() {
  fx.shelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  fx.shelfPresence = normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence);
  applyShelfModeRuntime(fx.shelf);
  updateShelfControlUi();
  if (wallpaperRuntimeMode) {
    enforceWallpaperShelfHidden();
    return;
  }
  if (fx.shelfCameraMode === 'static' && orbit && orbit.focus && /^shelf-/.test(String(orbit.focus.type || ''))) {
    setFocusZone(null, true);
  }
  if (shelfManager && shelfManager.rebuild) shelfManager.rebuild(true);
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
}

// 数据库状态恢复后统一重放所有视觉运行态副作用，不负责持久化。
function applyFxRuntimeStateAfterStorageLoad() {
  normalizeDevelopmentLockedFxState();
  applyShelfCameraDefaultAngle(false);
  setPreset(fx.preset, { silent: true, preserveCamera: true, skipTransition: true, noSave: true });
  applyCoverParticleResolution(fx.coverResolution, { reload: true });
  syncFxUniforms();
  updateFxInputs();
  applySavedLyricPaletteState();
  refreshCurrentLyricStyle();
  applyControlGlassChromaticOffset();
  applyWallpaperModeState(true);
  applyOptionalVisualLayerRuntimeState();
  applyPerformanceRuntimeState();
  applyShelfRuntimeState();
  applyAIDepthRuntimeState();
}

// 把宿主数据库状态应用到已经启动的播放器运行态。
function applyHostPersistentState(state) {
  if (!state || typeof state !== 'object') return;
  persistedStateSnapshot = state;
  hostStateLoaded = true;
  var nextFx = Object.assign({}, fxDefaults, readSavedLyricLayout());
  fx = nextFx;
  normalizeDevelopmentLockedFxState();
  playbackVisualPreset = normalizeVisualPresetIndex(fx.preset, DEFAULT_PLAYBACK_VISUAL_PRESET);
  targetVolume = readSavedVolume();
  if (targetVolume > 0.01) lastNonZeroVolume = targetVolume;
  controlsAutoHide = readBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, false);
  try {
    var nextCamera = readFreeCameraState();
    if (freeCamera && nextCamera) {
      freeCamera.locked = nextCamera.locked;
      freeCamera.active = false;
      freeCamera.position.copy(nextCamera.position);
      freeCamera.yaw = nextCamera.yaw;
      freeCamera.pitch = nextCamera.pitch;
      freeCamera.roll = nextCamera.roll;
      freeCamera.fov = nextCamera.fov;
    }
  } catch (e) {}
  try { applyVolumeToAudio(); } catch (e1) {}
  try { updateVolumeUi(); } catch (e2) {}
  try { applyControlsAutoHidePreference(); } catch (e3) {}
  try { applyFxRuntimeStateAfterStorageLoad(); } catch (e4) {}
}

// 应用宿主数据库里的用户视觉存档；数据库为空时写入打包默认存档。
function applyHostUserFxArchives(raw) {
  var exists = Array.isArray(raw);
  persistedUserFxArchivesRaw = exists ? raw : [];
  hostUserFxArchivesLoaded = true;
  userFxArchives = readUserFxArchives();
  if (!exists || !userFxArchives.length) {
    userFxArchives = [createPackagedDefaultUserFxArchiveSlot()];
    saveUserFxArchives();
  }
  try { renderUserFxArchives(); } catch (e) {}
}

// 初始化宿主数据库数据。
async function loadHostPersistentStorage() {
  try {
    var values = await Promise.all([
      hostStorageGet(EPF_STATE_STORE_KEY),
      hostStorageGet(USER_FX_ARCHIVE_STORE_KEY)
    ]);
    applyHostPersistentState(values[0] && typeof values[0] === 'object' ? values[0] : {});
    applyHostUserFxArchives(values[1]);
  } catch (e) {
    console.warn('[存储] 初始化读取失败', e);
  }
}

(function initEchoMusicPluginBridge() {
  // 桥接层运行在 iframe 子页面内：接收父页面推送的快照、歌词、进度和频谱，并把用户操作回传给宿主。
  // 原播放器的大部分 UI 和视觉逻辑继续复用，但真实播放、队列修改和窗口控制都交给 EchoMusic 宿主执行。
  // 宿主消息 source 标识。
  var BRIDGE_PARENT_SOURCE = ECHO_BRIDGE_PARENT_SOURCE;
  // 子页面消息 source 标识。
  var BRIDGE_CHILD_SOURCE = ECHO_BRIDGE_CHILD_SOURCE;
  // 最近一次宿主快照。
  var bridgeSnapshot = null;
  // 桥接频谱帧引用。
  var bridgeSpectrum = hostSpectrumFrame;
  // 最近一次封面地址。
  var bridgeLastCover = '';
  // 最近一次队列签名。
  var bridgeQueueKey = '';
  // 最近一次歌词签名。
  var bridgeLyricKey = '';
  // 最近一次未经过滤处理的歌词载荷。
  var bridgeRawLyricsPayload = null;
  // 宿主播放时钟锚点。
  var bridgePlaybackClock = { time: 0, duration: 0, playing: false, rate: 1, receivedAt: 0 };
  // 宿主控制能力。
  var bridgeHostControls = { platform: '', showFullscreenButton: true, canShowMiniPlayer: false };
  // 当前歌曲是否已收藏（红心状态）。
  var bridgeFavorite = false;
  // 收藏动作是否正在等待宿主确认。
  var bridgeFavoriteBusy = false;
  // 播放/暂停乐观状态。
  var bridgePlaybackPending = null;
  // 歌词是否被桥接层强制打开过。
  var bridgeLyricsForcedOpen = false;
  // 播放/暂停乐观状态超时时间。
  var BRIDGE_PLAYBACK_PENDING_TIMEOUT = 1800;

  // 向父页面发送桥接协议消息。
  function post(type, extra) {
    // 子页面发给宿主的消息统一带 source，父页面只接受这个来源，避免误处理其他窗口消息。
    postParentBridgeMessage(type, extra);
  }

  // 发送宿主播放器控制命令。
  function command(name, payload) {
    // 所有控制命令都收敛成统一协议，宿主侧再映射到真实播放器 API。
    if (wallpaperRuntimeMode && (name === 'close' || name === 'mini-player' || name === 'window-control')) {
      forceWallpaperImmersiveLock();
      return;
    }
    post('echo-player-frontend:command', Object.assign({ command: name }, payload || {}));
  }
  // 暴露调试命令入口，便于宿主或控制台直接发送桥接命令。
  window.__echoBridgeCommand = command;

  // 发起带结果回执的宿主动作请求（收藏、歌单列表、添加到歌单等）。
  function requestHostAction(action, payload, timeoutMs) {
    return requestHostBridge('echo-player-frontend:host-request', Object.assign({
      action: action
    }, payload ? { payload: payload } : {}), timeoutMs);
  }

  // 刷新底部控制条收藏按钮的红心状态。
  function updateFavoriteButton() {
    var btn = document.getElementById('favorite-btn');
    if (!btn) return;
    btn.classList.toggle('active', !!bridgeFavorite);
    btn.classList.toggle('busy', !!bridgeFavoriteBusy);
    btn.title = bridgeFavorite ? '取消收藏' : '收藏';
    btn.setAttribute('aria-label', btn.title);
  }

  // 切换当前歌曲收藏状态（乐观更新，宿主确认后以快照为准）。
  function toggleBridgeFavorite(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (bridgeFavoriteBusy) return;
    bridgeFavoriteBusy = true;
    bridgeFavorite = !bridgeFavorite;
    updateFavoriteButton();
    requestHostAction('toggle-favorite').then(function(result) {
      if (result && result.ok && result.result) {
        bridgeFavorite = result.result.favorite === true;
      }
      if (typeof showToast === 'function') {
        showToast(bridgeFavorite ? '已收藏' : '已取消收藏');
      }
    }).catch(function() {
      if (typeof showToast === 'function') showToast('收藏操作失败');
    }).then(function() {
      bridgeFavoriteBusy = false;
      updateFavoriteButton();
      // 宿主后续会推送最新快照，这里主动再取一次，确保红心与真实状态一致。
      requestHostAction('favorite-status').then(function(status) {
        if (status && status.ok && status.result) {
          bridgeFavorite = status.result.favorite === true;
          updateFavoriteButton();
        }
      }).catch(function() {});
    });
  }

  // 打开“添加到歌单”对话框并拉取歌单列表。
  function openAddToPlaylistDialog(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    var mask = document.getElementById('add-to-playlist-dialog');
    if (!mask) return;
    var loading = document.getElementById('atp-loading');
    var status = document.getElementById('atp-status');
    var queueList = document.getElementById('atp-queue-list');
    var playlistList = document.getElementById('atp-playlist-list');
    mask.classList.add('show');
    mask.setAttribute('aria-hidden', 'false');
    if (loading) loading.style.display = '';
    if (status) status.style.display = 'none';
    if (queueList) queueList.innerHTML = '';
    if (playlistList) playlistList.innerHTML = '';
    requestHostAction('playlist-list').then(function(result) {
      var payload = result && result.ok ? result.result : null;
      if (loading) loading.style.display = 'none';
      if (status) status.style.display = '';
      if (status) {
        status.textContent = payload && payload.playlists && payload.playlists.length
          ? ''
          : (payload && payload.queues && payload.queues.length ? '' : '暂无可用歌单，请先在 EchoMusic 登录账号');
        status.style.display = status.textContent ? '' : 'none';
      }
      if (queueList && payload && Array.isArray(payload.queues)) {
        queueList.innerHTML = payload.queues.map(function(queue) {
          return '<button type="button" class="atp-item atp-item--queue" data-id="' + escHtml(String(queue.id)) + '">' +
            '<span class="atp-item-name">' + escHtml(queue.name || '播放队列') + '</span>' +
            '<span class="atp-item-count">' + (Number(queue.count) || 0) + ' 首</span>' +
          '</button>';
        }).join('');
      }
      if (playlistList && payload && Array.isArray(payload.playlists)) {
        playlistList.innerHTML = payload.playlists.map(function(playlist) {
          var name = String(playlist.name || '未命名歌单');
          var badge = playlist.liked ? '<em style="font-style:normal;color:#ff6688;margin-right:6px">♥</em>' : '';
          return '<button type="button" class="atp-item" data-id="' + escHtml(String(playlist.id)) + '">' +
            '<span class="atp-item-name">' + badge + escHtml(name) + '</span>' +
            '<span class="atp-item-count">' + (Number(playlist.count) || 0) + ' 首</span>' +
          '</button>';
        }).join('');
      }
      if (queueList && !queueList.__atpQueueBound) {
        queueList.__atpQueueBound = true;
        queueList.addEventListener('click', function(ev) {
          var item = ev.target && ev.target.closest ? ev.target.closest('.atp-item') : null;
          if (!item || !item.dataset || item.dataset.id == null) return;
          handleQueueSelect(ev, String(item.dataset.id));
        });
      }
      if (playlistList && !playlistList.__atpPlaylistBound) {
        playlistList.__atpPlaylistBound = true;
        playlistList.addEventListener('click', function(ev) {
          var item = ev.target && ev.target.closest ? ev.target.closest('.atp-item') : null;
          if (!item || !item.dataset || item.dataset.id == null) return;
          handlePlaylistSelect(ev, String(item.dataset.id));
        });
      }
    }).catch(function() {
      if (loading) loading.style.display = 'none';
      if (status) {
        status.style.display = '';
        status.textContent = '歌单加载失败，请稍后重试';
      }
    });
  }

  // 关闭“添加到歌单”对话框。
  function closeAddToPlaylistDialog() {
    var mask = document.getElementById('add-to-playlist-dialog');
    if (!mask) return;
    mask.classList.remove('show');
    mask.setAttribute('aria-hidden', 'true');
  }

  // 选择播放队列，把当前歌曲追加到该队列。
  function handleQueueSelect(e, queueId) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!queueId) return;
    requestHostAction('queue-add', { queueId: queueId }).then(function(result) {
      if (result && result.ok && result.result && result.result.added) {
        if (typeof showToast === 'function') showToast('已添加到播放队列');
      } else if (typeof showToast === 'function') {
        showToast('歌曲已在播放队列中');
      }
      closeAddToPlaylistDialog();
    }).catch(function() {
      if (typeof showToast === 'function') showToast('添加到队列失败');
      closeAddToPlaylistDialog();
    });
  }

  // 选择歌单，把当前歌曲添加到指定歌单。
  function handlePlaylistSelect(e, listId) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!listId) return;
    requestHostAction('playlist-add', { listId: listId }).then(function(result) {
      if (result && result.ok && result.result) {
        if (result.result.added) {
          if (typeof showToast === 'function') showToast('已添加到歌单');
        } else if (result.result.exists) {
          if (typeof showToast === 'function') showToast('歌单中已有此歌曲');
        } else {
          if (typeof showToast === 'function') showToast(result.result.error || '添加到歌单失败');
        }
      } else if (typeof showToast === 'function') {
        showToast('添加到歌单失败');
      }
      closeAddToPlaylistDialog();
    }).catch(function() {
      if (typeof showToast === 'function') showToast('添加到歌单失败');
      closeAddToPlaylistDialog();
    });
  }

  // 暴露给 HTML inline onclick 使用。
  window.toggleBridgeFavorite = toggleBridgeFavorite;
  window.openAddToPlaylistDialog = openAddToPlaylistDialog;
  window.closeAddToPlaylistDialog = closeAddToPlaylistDialog;
  window.handleQueueSelect = handleQueueSelect;
  window.handlePlaylistSelect = handlePlaylistSelect;

  // 获取桥接层使用的高精度时间。
  function bridgeNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  // 判断播放/暂停乐观状态是否仍在有效期内。
  function isBridgePlaybackPendingActive() {
    // 播放/暂停采用本地乐观状态，等待宿主确认；超过超时时间仍未确认则回到宿主实际状态。
    if (!bridgePlaybackPending) return false;
    if (bridgeNow() - bridgePlaybackPending.startedAt > BRIDGE_PLAYBACK_PENDING_TIMEOUT) {
      bridgePlaybackPending = null;
      return false;
    }
    return true;
  }

  // 合并宿主播放状态与本地乐观播放状态。
  function resolveBridgePlaybackPlaying(hostPlaying) {
    // 宿主播放状态布尔化。
    var normalized = !!hostPlaying;
    if (!isBridgePlaybackPendingActive()) return normalized;
    if (bridgePlaybackPending.targetPlaying === normalized) {
      bridgePlaybackPending = null;
      return normalized;
    }
    return bridgePlaybackPending.targetPlaying;
  }

  // 立即应用本地播放状态到 UI 和伪 audio。
  function applyLocalPlaybackState(nextPlaying) {
    // 先更新本地 UI 和伪 audio 状态，让按钮、进度条和歌词立即响应用户点击。
    // 目标播放状态。
    nextPlaying = !!nextPlaying;
    bridgePlaybackClock.time = bridgeCurrentTime();
    bridgePlaybackClock.playing = nextPlaying;
    bridgePlaybackClock.receivedAt = bridgeNow();
    playing = nextPlaying;
    if (audio) {
      audio.paused = !nextPlaying;
      audio.ended = false;
    }
    if (bridgeSnapshot) {
      bridgeSnapshot.currentTime = bridgePlaybackClock.time;
      bridgeSnapshot.isPlaying = nextPlaying;
    }
    if (typeof setPlayIcon === 'function') setPlayIcon(nextPlaying);
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  }

  // 请求宿主切换播放状态。
  function requestBridgePlayback(nextPlaying) {
    // 播放请求先记录目标状态，再发送宿主命令；后续 progress/snapshot 会清掉 pending。
    nextPlaying = !!nextPlaying;
    bridgePlaybackPending = {
      targetPlaying: nextPlaying,
      startedAt: bridgeNow()
    };
    applyLocalPlaybackState(nextPlaying);
    command(nextPlaying ? 'play' : 'pause');
  }

  // 切换当前播放状态。
  function toggleBridgePlayback() {
    // 当前有效播放状态，pending 状态优先。
    var currentPlaying = isBridgePlaybackPendingActive()
      ? bridgePlaybackPending.targetPlaying
      : !!playing;
    requestBridgePlayback(!currentPlaying);
  }

  // 把数字夹到 0..1。
  function clamp01(value) {
    value = Number(value) || 0;
    return Math.max(0, Math.min(1, value));
  }

  // 设置桥接播放时钟当前时间。
  function setBridgeClockTime(value) {
    bridgePlaybackClock.time = Math.max(0, Number(value) || 0);
    bridgePlaybackClock.receivedAt = bridgeNow();
  }

  // 根据宿主锚点和本地时间差计算当前播放时间。
  function bridgeCurrentTime() {
    // 子页面用宿主最近一次进度作为锚点，本地按时间差外推，避免 100ms 推送间隔造成进度卡顿。
    var t = Math.max(0, Number(bridgePlaybackClock.time) || 0);
    if (bridgePlaybackClock.playing) {
      t += Math.max(0, performance.now() - (bridgePlaybackClock.receivedAt || performance.now())) * 0.001 * Math.max(0.25, Math.min(4, Number(bridgePlaybackClock.rate) || 1));
    }
    if (bridgePlaybackClock.duration > 0) t = Math.min(bridgePlaybackClock.duration + 0.12, t);
    return Math.max(0, t);
  }

  // 应用宿主推送的定位包（事件驱动，取代高频进度轮询）。
  function applyPositionPayload(payload) {
    payload = payload || {};
    var positionMs = Number(payload.position_ms);
    var durationMs = Number(payload.duration_ms);
    if (!isFinite(positionMs)) positionMs = Number(payload.currentTime || 0) * 1000;
    if (!isFinite(durationMs)) durationMs = Number(payload.duration || 0) * 1000;
    var hostPlaying = payload.is_playing != null ? !!payload.is_playing : !!payload.isPlaying;
    // 合并本地乐观状态后的播放状态。
    var effectivePlaying = resolveBridgePlaybackPlaying(hostPlaying);
    bridgePlaybackClock.time = Math.max(0, positionMs || 0) / 1000;
    bridgePlaybackClock.duration = Math.max(0, durationMs || 0) / 1000;
    bridgePlaybackClock.playing = effectivePlaying;
    bridgePlaybackClock.receivedAt = bridgeNow();
    playing = bridgePlaybackClock.playing;
    if (audio) {
      audio.paused = !playing;
      audio.ended = false;
      audio.duration = bridgePlaybackClock.duration;
    }
    if (bridgeSnapshot) {
      bridgeSnapshot.currentTime = bridgePlaybackClock.time;
      bridgeSnapshot.duration = bridgePlaybackClock.duration;
      bridgeSnapshot.isPlaying = playing;
    }
    if (typeof setPlayIcon === 'function') setPlayIcon(playing);
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  }

  // 应用宿主外观设置，舞台歌词字体跟随主程序页面歌词字体。
  function applyAppearancePayload(payload) {
    var nextFamily = normalizeBridgeLyricFontFamily(payload && payload.lyricFontFamily);
    if (nextFamily === bridgeLyricFontFamily) return;
    bridgeLyricFontFamily = nextFamily;
    if (typeof refreshCurrentLyricStyle === 'function') refreshCurrentLyricStyle();
  }

  // 转义 CSS url 中的双引号。
  function escapeCssUrl(value) {
    return String(value || '').replace(/"/g, '\\"');
  }

  // 将宿主播放模式映射到旧播放器内部模式。
  function hostModeToMine(mode) {
    mode = String(mode || '');
    if (mode === 'random') return 'shuffle';
    if (mode === 'single') return 'single';
    return 'loop';
  }

  // 从宿主歌曲对象提取封面地址。
  function bridgeSongCover(song) {
    song = song || {};
    return String(song.cover || song.coverUrl || song.picUrl || song.albumCover || song.albumImg || song.img || song.image || song.cover_url || '');
  }

  // 归一化宿主歌曲对象为旧播放器内部歌曲模型。
  function normalizeBridgeSong(song) {
    // 宿主歌曲结构在不同来源下字段不完全一致，桥接层统一成旧播放器内部使用的歌曲模型。
    song = song || {};
    // 归一化后的封面地址。
    var cover = bridgeSongCover(song);
    return {
      // 旧播放器列表和 DOM key 使用的主 id。
      id: String(song.id || song.hash || ''),
      // 兼容旧播放队列逻辑中的 hash 字段。
      hash: String(song.hash || song.id || ''),
      // 主标题，缺省时给出稳定占位。
      name: String(song.name || song.title || '未知歌曲'),
      // 兼容部分 UI 仍读取 title 的路径。
      title: String(song.title || song.name || '未知歌曲'),
      // 歌手名，缺省时给出稳定占位。
      artist: String(song.artist || '未知歌手'),
      // 旧封面字段。
      cover: cover,
      // 新旧代码兼容的封面字段。
      coverUrl: cover,
      // 专辑名。
      album: String(song.album || ''),
      // 歌曲时长，单位沿用宿主传入值。
      duration: Number(song.duration || 0),
      // 标记歌曲来自 EchoMusic 宿主。
      source: 'echo'
    };
  }

  // 注入桥接层专用样式。
  function installBridgeStyle() {
    // iframe 内补充宿主窗口控制按钮样式，避免依赖外层应用的全局样式。
    if (document.getElementById('echo-plugin-bridge-style')) return;
    // 运行时样式节点。
    var style = document.createElement('style');
    style.id = 'echo-plugin-bridge-style';
    // close 按钮和窗口控制按钮的最小样式集合。
    style.textContent = [
      '#echo-bridge-close{position:fixed;z-index:80;top:8px;left:16px;right:auto;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:rgba(255,255,255,.7);cursor:pointer;padding:0;transition:color .2s ease,background .2s ease}',
      '#echo-bridge-close:hover{color:#fff;background:rgba(255,255,255,.1)}',
      '#echo-bridge-close svg{width:20px;height:20px;display:block;stroke:currentColor}',
      '#echo-bridge-window-controls{position:fixed;z-index:80;top:0;right:0;height:48px;display:flex;align-items:center;color:rgba(255,255,255,.72)}',
      '.echo-bridge-window-control{width:48px;height:48px;display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;transition:color .2s ease,background .2s ease,opacity .2s ease}',
      '.echo-bridge-window-control:hover{color:#fff;background:rgba(255,255,255,.1)}',
      '.echo-bridge-window-control--mini{width:40px}',
      '.echo-bridge-window-control--mini:hover{background:transparent;color:var(--color-primary,#31cfa1)}',
      '.echo-bridge-window-control--close:hover{background:#ff3b30;color:#fff}',
      '.echo-bridge-window-control svg{width:14px;height:14px;display:block;stroke:currentColor;fill:none}',
      '.echo-bridge-window-control--mini svg{width:16px;height:16px}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // 安装左上角返回按钮。
  function installCloseButton() {
    if (wallpaperRuntimeMode) return;
    if (document.getElementById('echo-bridge-close')) return;
    // 返回按钮节点。
    var button = document.createElement('button');
    button.id = 'echo-bridge-close';
    button.type = 'button';
    button.title = '返回';
    button.setAttribute('aria-label', '返回');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
    button.addEventListener('click', function(e) {
      // 返回按钮只通知宿主关闭或收起当前 iframe 页面。
      e.preventDefault();
      command('close');
    });
    document.body.appendChild(button);
  }

  // 返回桥接窗口按钮使用的内联 SVG 图标。
  function bridgeIcon(name) {
    // mini 模式图标。
    if (name === 'mini') return '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M8 13h6v4H8z"></path></svg>';
    // 最小化图标。
    if (name === 'minimize') return '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path></svg>';
    // 全屏图标。
    if (name === 'fullscreen') return '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V3h4"></path><path d="M21 7V3h-4"></path><path d="M3 17v4h4"></path><path d="M21 17v4h-4"></path></svg>';
    // 最大化图标。
    if (name === 'maximize') return '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>';
    // 默认返回关闭图标。
    return '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
  }

  // 根据按钮配置创建一个宿主窗口控制按钮。
  function createBridgeWindowButton(options) {
    // 窗口控制按钮节点。
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'echo-bridge-window-control' + (options.extraClass ? ' ' + options.extraClass : '');
    button.title = options.title;
    button.setAttribute('aria-label', options.title);
    button.innerHTML = bridgeIcon(options.icon);
    button.addEventListener('click', function(e) {
      // 窗口按钮事件只发送给宿主，由宿主操作真实窗口。
      e.preventDefault();
      if (options.command === 'mini-player') {
        command('mini-player');
      } else {
        command('window-control', { action: options.action });
      }
    });
    return button;
  }

  // 根据宿主能力安装窗口控制按钮组。
  function installWindowControls() {
    // 旧按钮组需要先移除，避免宿主能力变更后残留按钮。
    var existing = document.getElementById('echo-bridge-window-controls');
    if (existing) existing.remove();
    if (wallpaperRuntimeMode) return;

    // macOS 使用宿主原生红绿灯按钮，子页面不再绘制右侧窗口按钮。
    var isMac = String(bridgeHostControls.platform || '').toLowerCase() === 'darwin';
    // 将要渲染的按钮配置列表。
    var buttons = [];
    if (bridgeHostControls.canShowMiniPlayer) {
      buttons.push({ title: 'mini 模式', icon: 'mini', command: 'mini-player', extraClass: 'echo-bridge-window-control--mini' });
    }
    if (!isMac) {
      buttons.push({ title: '最小化', icon: 'minimize', action: 'minimize' });
      if (bridgeHostControls.showFullscreenButton !== false) {
        buttons.push({ title: '全屏', icon: 'fullscreen', action: 'fullscreen' });
      }
      buttons.push({ title: '最大化', icon: 'maximize', action: 'maximize' });
      buttons.push({ title: '关闭', icon: 'close', action: 'close', extraClass: 'echo-bridge-window-control--close' });
    }
    if (!buttons.length) return;

    // 右上角窗口控制容器。
    var controls = document.createElement('div');
    controls.id = 'echo-bridge-window-controls';
    buttons.forEach(function(options) {
      // 逐个创建并插入窗口控制按钮。
      controls.appendChild(createBridgeWindowButton(options));
    });
    document.body.appendChild(controls);
  }

  // 安装宿主播放代理 audio 对象。
  function installAudioShim() {
    // 旧播放器内部大量逻辑依赖 audio 对象；这里用伪 audio 接管读写，并把播放控制转成宿主命令。
    // 伪 audio 只维护状态和访问器，不创建真实媒体流。
    audio = {
      // 当前暂停状态。
      paused: true,
      // 桥接模式不使用 HTMLMediaElement ended 事件。
      ended: false,
      // 当前时间通过宿主时钟外推。
      get currentTime() { return bridgeCurrentTime(); },
      // seek 写入本地时钟，具体跳转由命令触发。
      set currentTime(value) { setBridgeClockTime(value); },
      // 当前总时长。
      duration: 0,
      // 播放速度。
      playbackRate: 1,
      // 占位 src，避免旧代码把 audio 当成未初始化。
      src: 'echo-plugin-host',
      // 兼容旧封面/音频逻辑读取跨域字段。
      crossOrigin: 'anonymous',
      // 事件接口占位，兼容旧绑定代码。
      addEventListener: function() {},
      // 事件解绑接口占位。
      removeEventListener: function() {},
      // load 接口占位。
      load: function() {},
      // play 被旧代码调用时转成宿主播放命令。
      play: function() { requestBridgePlayback(true); return Promise.resolve(); },
      // pause 被旧代码调用时转成宿主暂停命令。
      pause: function() { requestBridgePlayback(false); },
    };
  }

  // 强制旧播放器界面进入桥接模式首屏。
  function forcePlayerSurface() {
    // 标记桥接模式，显示底部控制条，确保 iframe 首屏就是可交互播放器。
    document.body.classList.add('echo-plugin-bridge');
    var bottom = document.getElementById('bottom-bar');
    if (bottom) bottom.classList.add('visible');
    setControlsHidden(false);
    forcePlaybackControlsInteractive();
    if (wallpaperRuntimeMode) setImmersiveMode(true);
  }

  // 请求刷新 Three.js 主渲染视口。
  function refreshBridgeViewport(reason) {
    try {
      if (typeof scheduleMainRendererViewportRefresh === 'function') {
        scheduleMainRendererViewportRefresh(reason || 'echo-bridge');
      }
    } catch (error) {
      console.warn('[EchoMusicBridge] 视口刷新失败', error);
    }
  }

  // 请求从后台恢复视觉层。
  function recoverBridgeVisuals(reason) {
    try {
      if (typeof recoverVisualsAfterBackground === 'function') {
        recoverVisualsAfterBackground(reason || 'echo-bridge');
      }
    } catch (error) {
      console.warn('[EchoMusicBridge] 视觉恢复失败', error);
    }
  }

  // 唤醒桥接模式下的视觉渲染表面。
  function revealBridgeVisualSurface() {
    // 收到有效宿主快照后唤醒视觉层，处理后台恢复、加载态清理和粒子透明度渐入。
    refreshBridgeViewport('echo-bridge-snapshot');
    recoverBridgeVisuals('echo-bridge-snapshot');
    if (typeof markRenderInteraction === 'function') markRenderInteraction('echo-bridge-snapshot', 1200);
    if (typeof uniforms === 'undefined' || !uniforms) return;
    if (uniforms.uLoading) {
      try {
        if (typeof forceLoadingSettled === 'function') forceLoadingSettled('echo-bridge-snapshot');
        else uniforms.uLoading.value = 0;
      } catch (error) {
        console.warn('[EchoMusicBridge] 加载态清理失败', error);
        uniforms.uLoading.value = 0;
      }
    }
    if (!uniforms.uAlpha) return;

    // 当前主粒子透明度。
    var currentAlpha = Number(uniforms.uAlpha.value || 0);
    if (currentAlpha >= 0.98) return;
    if (typeof firstPlayDone !== 'undefined') firstPlayDone = true;

    try {
      // 优先走用户预设粒子显隐函数，缺失时退回通用透明度补间。
      if (typeof revealUserPresetParticles === 'function') {
        revealUserPresetParticles({ alpha: 1.0, duration: 260 });
      } else if (typeof tweenParticleAlpha === 'function') {
        tweenParticleAlpha(currentAlpha, 1.0, 260);
      } else {
        uniforms.uAlpha.value = 1.0;
      }
    } catch (error) {
      console.warn('[EchoMusicBridge] 视觉层唤醒失败', error);
      uniforms.uAlpha.value = 1.0;
    }
  }

  // 确保桥接模式默认开启粒子歌词。
  function ensureBridgeLyricsEnabled() {
    // 桥接模式默认打开粒子歌词，确保从宿主歌词页进入时能立刻看到歌词舞台。
    if (bridgeLyricsForcedOpen) return;
    bridgeLyricsForcedOpen = true;
    if (typeof setParticleLyricsSilently === 'function') {
      try {
        setParticleLyricsSilently(true);
      } catch (error) {
        console.warn('[EchoMusicBridge] 歌词首屏开启失败', error);
        if (typeof fx === 'object' && fx) fx.particleLyrics = true;
        lyricsVisible = true;
      }
    } else if (typeof fx === 'object' && fx) {
      fx.particleLyrics = true;
      lyricsVisible = true;
    }
  }

  // 刷新歌词渲染表面。
  function refreshBridgeLyricsSurface() {
    if (fx && fx.particleLyrics && typeof createLyricsParticles === 'function') {
      try {
        createLyricsParticles();
      } catch (error) {
        console.warn('[EchoMusicBridge] 歌词粒子刷新失败', error);
      }
      return;
    }
    if (typeof renderLyrics === 'function') renderLyrics();
  }

  // 设置桥接等待宿主歌曲的空态。
  function setBridgeWaitingState(waiting) {
    // 是否进入等待态。
    waiting = !!waiting;
    document.body.classList.toggle('bridge-waiting', waiting);
    if (!waiting) return;
    // 控制条曲名节点。
    var controlTitle = document.getElementById('control-title');
    // 控制条歌手节点。
    var controlArtist = document.getElementById('control-artist');
    // 控制条封面节点。
    var controlCover = document.getElementById('control-cover');
    // 播放时间显示节点。
    var timeDisplay = document.getElementById('time-display');
    if (controlTitle) controlTitle.textContent = '等待 EchoMusic';
    if (controlArtist) controlArtist.textContent = '播放歌曲后将在这里显示歌词';
    if (controlCover) controlCover.classList.add('cover-empty');
    if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
    if (typeof setPlayIcon === 'function') setPlayIcon(false);
    if (typeof setProgressVisual === 'function') setProgressVisual(0);
  }

  // 应用宿主当前歌曲封面到 UI 和粒子纹理链路。
  function applyCover(song) {
    // 当前歌曲封面地址。
    var cover = bridgeSongCover(song);
    if (cover === bridgeLastCover) return;
    bridgeLastCover = cover;
    // 右下角缩略封面图片。
    var thumb = document.getElementById('thumb-cover');
    if (thumb) {
      if (cover) thumb.src = cover;
      else thumb.removeAttribute('src');
    }
    if (typeof setControlCoverSrc === 'function') setControlCoverSrc(cover);
    // 背景专辑图节点。
    var albumBg = document.getElementById('album-bg');
    if (albumBg) {
      if (cover) {
        albumBg.style.backgroundImage = 'url("' + escapeCssUrl(cover) + '")';
        albumBg.classList.add('visible');
      } else {
        albumBg.style.backgroundImage = '';
        albumBg.classList.remove('visible');
      }
    }
    if (cover && typeof applyCoverDataUrl === 'function' && isInlineCoverSrc(cover)) {
      // 内联封面直接走 data url 解码链路。
      try { applyCoverDataUrl(cover, { deferHeavy: true, timeout: 1600 }); } catch (e) {}
    } else if (cover && typeof loadCoverFromUrl === 'function' && /^https?:\/\//i.test(cover)) {
      // 远程封面走 URL 加载链路。
      try { loadCoverFromUrl(cover, { deferHeavy: true, timeout: 1600 }); } catch (e) {}
    } else if (!cover && typeof loadCoverFromUrl === 'function') {
      // 无封面时触发旧链路清理封面纹理。
      try { loadCoverFromUrl('', { deferHeavy: true, timeout: 1600 }); } catch (e) {}
    }
  }

  // 应用宿主推送的歌词载荷。
  function applyLyricsPayload(payload, options) {
    // 歌词包用 key 去重；逐字歌词会保留到 characters，没有逐字时退回行级时间。
    options = options || {};
    payload = payload || {};
    if (!options.fromCache) bridgeRawLyricsPayload = payload;
    // 宿主歌词行数组。
    var lines = Array.isArray(payload.lines) ? payload.lines : [];
    // 歌词去重签名，优先使用宿主 key，否则按行时间、文本和逐字时间生成。
    var rawKey = payload.key || (lines.length + '|' + lines.map(function(line) {
      // 当前行逐字歌词数组。
      var chars = Array.isArray(line.characters) ? line.characters : [];
      // 当前行逐字歌词签名。
      var charKey = chars.map(function(character) {
        // 单字文本和起止时间组成稳定签名。
        return [character && (character.text != null ? character.text : character.t) || '', character && (character.startTime != null ? character.startTime : character.s) || 0, character && (character.endTime != null ? character.endTime : character.e) || 0].join(',');
      }).join(';');
      // 行级时间、主文本、翻译文本和逐字签名组成整行签名。
      return [line.time_ms || line.t || line.time || 0, line.text || '', line.secondary || '', charKey].join(':');
    }).join('|'));
    // 过滤配置也纳入签名，保证同一份歌词在配置变化后重新处理。
    var key = rawKey + '::filter::' + lyricFilterSignature(bridgeSnapshot);
    if (!options.force && key === bridgeLyricKey) return;
    bridgeLyricKey = key;
    // 收到歌词时统一生成过滤后的时间轴，渲染层不再判断过滤规则。
    var filteredLines = filterReceivedLyricLines(lines, bridgeSnapshot);
    lyricsLines = filteredLines.map(function(line, index) {
      // 当前行开始时间，宿主优先使用毫秒字段。
      var startMs = line.time_ms != null ? Number(line.time_ms || 0) : Number(line.t || line.time || 0) * 1000;
      // 下一行开始时间，用于推算当前行持续时间。
      var nextMs = filteredLines[index + 1] ? (filteredLines[index + 1].time_ms != null ? Number(filteredLines[index + 1].time_ms || 0) : Number(filteredLines[index + 1].t || filteredLines[index + 1].time || 0) * 1000) : 0;
      // 当前行开始秒。
      var start = Math.max(0, startMs || 0) / 1000;
      // 下一行开始秒。
      var next = Math.max(0, nextMs || 0) / 1000;
      // 当前行显示文本，缺主文本时退回 secondary。
      var text = String(line.text || line.secondary || '');
      // 逐字歌词统一归一化为旧播放器字符时间结构。
      var characters = normalizeLyricCharacters(line.characters, 'ms');
      return {
        // 行开始时间。
        t: start,
        // 行文本。
        text: text,
        // 行持续时间，优先使用宿主持续时间，否则用下一行间隔。
        duration: line.duration_ms != null ? Math.max(0.4, Number(line.duration_ms || 0) / 1000) : Number(line.duration || (next > start ? next - start : 4.8)),
        // 逐字歌词数据。
        characters: characters,
        // 逐字模式下的字符总数。
        charCount: Math.max(1, characters.length ? characters[characters.length - 1].c1 : text.length),
        // 歌词来源标识。
        source: line.source || 'echo',
        // 保留宿主原始歌词行号，过滤占位行后仍能映射 current_index。
        sourceIndex: line.source_index != null ? Number(line.source_index) : index,
      };
    }).filter(function(line){ return line.text && !isNoLyricText(line.text); });
    // 是否存在可用的原生逐字时间。
    lyricsHasNativeKaraoke = lyricsLines.some(hasValidLyricCharacters);
    // 当前歌词时间来源。
    lyricsTimingSource = lyricsLines.length ? (lyricsHasNativeKaraoke ? 'echo-characters' : 'echo-line') : 'none';
    refreshBridgeLyricsSurface();
  }

  // 歌词过滤配置变化时，使用最近一次原始歌词载荷重新生成时间轴。
  window.__refreshBridgeLyricsAfterFilterChange = function() {
    if (!bridgeRawLyricsPayload) return;
    applyLyricsPayload(bridgeRawLyricsPayload, { force: true, fromCache: true });
  };

  // 应用宿主播放队列快照。
  function applyQueue(snapshot) {
    // 队列签名只关心当前索引、数量和歌曲标识，减少相同队列反复重建面板和 3D 歌单架。
    // 宿主队列数组。
    var queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    // 队列去重签名。
    var key = String(snapshot.currentQueueIndex == null ? '' : snapshot.currentQueueIndex) + '|' + queue.length + '|' + queue.map(function(song) {
      // 每首歌只取稳定标识和封面参与签名。
      return [
        String(song && (song.id || song.hash) || ''),
        bridgeSongCover(song)
      ].join(':');
    }).join(',');
    if (key === bridgeQueueKey) return;
    bridgeQueueKey = key;
    // 旧播放器主队列。
    playQueue = queue.map(normalizeBridgeSong);
    // 当前播放索引。
    currentIdx = Number(snapshot.currentQueueIndex);
    if (!isFinite(currentIdx) || currentIdx < 0 || currentIdx >= playQueue.length) {
      currentIdx = -1;
    }
    // 旧播放器歌单视图沿用同一份队列快照。
    playlist = playQueue.slice();
    if (typeof renderMiniQueuePanel === 'function') renderMiniQueuePanel({ scrollCurrent: true });
    if (typeof safeShelfRebuild === 'function') {
      try { safeShelfRebuild('echo-bridge', true); } catch (e) {}
    }
  }

  // 应用宿主完整播放快照。
  function applySnapshot(snapshot) {
    // 完整快照是桥接层的主入口：同步歌曲、队列、封面、播放模式、音量和首屏等待状态。
    if (!snapshot) return;
    // 宿主原始歌曲对象。
    var rawTrack = snapshot.track || null;
    // 是否有可展示的当前歌曲。
    var hasTrack = !!(rawTrack && (rawTrack.id || rawTrack.hash || rawTrack.name || rawTrack.title));
    // 合并本地乐观状态后的播放状态。
    var snapshotPlaying = resolveBridgePlaybackPlaying(snapshot.isPlaying);
    if (!hasTrack) snapshotPlaying = false;
    bridgeSnapshot = snapshot;
    bridgeSnapshot.isPlaying = snapshotPlaying;
    bridgeFavorite = snapshot.favorite === true;
    updateFavoriteButton();
    installAudioShim();
    forcePlayerSurface();

    // 归一化后的当前歌曲。
    var song = normalizeBridgeSong(rawTrack);
    // 当前歌曲总时长。
    var duration = Math.max(0, Number(snapshot.duration || song.duration || 0));
    // 当前歌曲播放位置，完整快照也可作为本地时钟锚点。
    var snapshotTime = Number(snapshot.currentTime);
    if (!isFinite(snapshotTime)) snapshotTime = bridgeCurrentTime();
    playing = hasTrack && snapshotPlaying;
    bridgePlaybackClock.time = Math.max(0, snapshotTime || 0);
    bridgePlaybackClock.duration = duration;
    bridgePlaybackClock.playing = playing;
    bridgePlaybackClock.rate = 1;
    bridgePlaybackClock.receivedAt = bridgeNow();
    audio.paused = !playing;
    audio.ended = false;
    audio.duration = duration;
    audio.playbackRate = 1;
    targetVolume = clamp01(snapshot.volume == null ? targetVolume : snapshot.volume);
    if (targetVolume > 0.01) lastNonZeroVolume = targetVolume;
    audio.volume = targetVolume;
    // 播放模式同步到旧播放器内部枚举。
    playMode = hostModeToMine(snapshot.playMode);

    applyQueue(snapshot);
    applyCover(hasTrack ? song : {});
    if (hasTrack) revealBridgeVisualSurface();

    // 初始提示节点。
    var hint = document.getElementById('hint');
    if (hint) hint.classList.add('hidden');
    // 缩略封面外层节点。
    var thumbWrap = document.getElementById('thumb-wrap');
    if (thumbWrap) thumbWrap.classList.toggle('visible', hasTrack && !!song.id);
    // 缩略曲名节点。
    var thumbTitle = document.getElementById('thumb-title');
    // 缩略歌手节点。
    var thumbArtist = document.getElementById('thumb-artist');
    if (hasTrack) {
      // 有歌曲时退出等待态并刷新控制条曲目信息。
      setBridgeWaitingState(false);
      if (thumbTitle) thumbTitle.textContent = song.name || '';
      if (thumbArtist) thumbArtist.textContent = song.artist || '';
      if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
    } else {
      // 无歌曲时清空当前索引和缩略文本，展示等待宿主状态。
      currentIdx = -1;
      if (thumbTitle) thumbTitle.textContent = '';
      if (thumbArtist) thumbArtist.textContent = '';
      setBridgeWaitingState(true);
    }
    if (typeof updatePlayModeButton === 'function') updatePlayModeButton(false);
    if (typeof setPlayIcon === 'function') setPlayIcon(playing);
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    if (typeof updateVolumeUi === 'function') updateVolumeUi();
  }

  // 安装旧播放器控件的桥接拦截器。
  function installControlInterceptors() {
    // 拦截旧播放器控件事件，阻止它们执行本地播放逻辑，改为发送 EchoMusic 宿主命令。
    // 播放/暂停按钮。
    var playButton = document.getElementById('play-btn');
    if (playButton && !playButton.__echoBridgePlayBound) {
      playButton.__echoBridgePlayBound = true;
      playButton.onclick = null;
      playButton.addEventListener('click', function(e) {
        // 捕获阶段阻止旧点击处理器执行。
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        toggleBridgePlayback();
      }, true);
    }

    // 播放进度条。
    var progress = document.getElementById('progress-bar');
    if (progress && !progress.__echoBridgeBound) {
      progress.__echoBridgeBound = true;
      // 根据指针事件位置计算并提交 seek。
      var seekFromEvent = function(e) {
        if (!bridgeSnapshot || !bridgeSnapshot.duration) return;
        // 进度条视口矩形。
        var rect = progress.getBoundingClientRect();
        // 指针所在比例。
        var ratio = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
        // 目标播放时间。
        var value = ratio * Number(bridgeSnapshot.duration || 0);
        setBridgeClockTime(value);
        bridgeSnapshot.currentTime = value;
        command('seek', { value: value });
      };
      progress.addEventListener('pointerdown', function(e) {
        // 拖动开始时立即 seek，并标记进度条处于拖动状态。
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        progress.setPointerCapture && progress.setPointerCapture(e.pointerId);
        progress.classList.add('is-dragging');
        seekFromEvent(e);
      }, true);
      progress.addEventListener('pointermove', function(e) {
        // 只有拖动状态下才连续发送 seek。
        if (!progress.classList.contains('is-dragging')) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        seekFromEvent(e);
      }, true);
      progress.addEventListener('pointerup', function(e) {
        // 拖动结束时提交最后一次 seek。
        progress.classList.remove('is-dragging');
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        seekFromEvent(e);
      }, true);
      progress.addEventListener('click', function(e) {
        // 普通点击进度条也走同一个 seek 逻辑。
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        seekFromEvent(e);
      }, true);
    }

    // 音量滑块。
    var volume = document.getElementById('volume-slider');
    if (volume && !volume.__echoBridgeBound) {
      volume.__echoBridgeBound = true;
      volume.addEventListener('input', function(e) {
        // 滑动期间实时把音量交给宿主。
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        var next = clamp01(Number(volume.value || 0));
        targetVolume = next;
        if (next > 0.01) lastNonZeroVolume = next;
        saveStatePatch({ volume: next });
        command('volume', { value: next });
      }, true);
      volume.addEventListener('change', function(e) {
        // change 事件作为 input 的兜底提交。
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        var next = clamp01(Number(volume.value || 0));
        targetVolume = next;
        if (next > 0.01) lastNonZeroVolume = next;
        saveStatePatch({ volume: next });
        command('volume', { value: next });
      }, true);
    }

    // 提交桥接音量并同步本地 UI。
    function commitBridgeVolume(value) {
      // 归一化后的音量。
      var next = clamp01(value);
      targetVolume = next;
      if (next > 0.01) lastNonZeroVolume = next;
      if (typeof updateVolumeUi === 'function') updateVolumeUi();
      saveStatePatch({ volume: next });
      command('volume', { value: next });
    }

    // 静音按钮。
    var volumeButton = document.getElementById('volume-btn');
    if (volumeButton && !volumeButton.__echoBridgeMuteBound) {
      volumeButton.__echoBridgeMuteBound = true;
      volumeButton.addEventListener('click', function(e) {
        // 静音/恢复音量都走宿主音量命令。
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        commitBridgeVolume(targetVolume > 0.01 ? 0 : (lastNonZeroVolume || 0.8));
      }, true);
    }

    // 音量控件外层，用于滚轮调节音量。
    var volumeWrap = document.getElementById('volume-control');
    if (volumeWrap && !volumeWrap.__echoBridgeWheelBound) {
      volumeWrap.__echoBridgeWheelBound = true;
      volumeWrap.addEventListener('wheel', function(e) {
        // 滚轮调节音量时保持音量面板打开。
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        if (typeof keepVolumePanelOpen === 'function') keepVolumePanelOpen();
        commitBridgeVolume(targetVolumeAfterWheel(e));
      }, { capture: true, passive: false });
    }
  }

  // 覆盖原播放入口: 控件只驱动 EchoMusic 宿主播放器。
  // 播放/暂停入口覆盖为桥接播放切换。
  togglePlay = function() { toggleBridgePlayback(); };
  // 下一首入口覆盖为宿主下一首命令。
  nextTrack = function() { command('next'); };
  // 上一首入口覆盖为宿主上一首命令。
  prevTrack = function() { command('prev'); };
  // 播放模式循环入口覆盖为宿主模式切换命令。
  cyclePlayMode = function() { command('cycle-mode'); };
  // 队列点击播放入口覆盖为按索引播放宿主队列。
  playQueueAt = function(index) { command('play-index', { index: Number(index) || 0 }); };
  // 请求宿主把队列索引设为下一首。
  requestHostPlayNextIndex = function(index) { command('queue-play-next-index', { index: Number(index) || 0 }); };
  // 请求宿主把详情页歌曲加入下一首。
  queueDetailSongNext = function(song) {
    // 转成宿主命令可接受的歌曲结构。
    var payloadSong = hostCommandSong(song);
    if (!payloadSong) return;
    command('queue-play-next-song', { song: payloadSong });
    if (typeof showToast === 'function') showToast('已发送下一首: ' + (song.name || ''));
  };
  // 请求宿主直接播放指定歌曲。
  requestHostPlaySong = function(song) {
    // 转成宿主命令可接受的歌曲结构。
    var payloadSong = hostCommandSong(song);
    if (!payloadSong) return false;
    command('play-song', { song: payloadSong });
    return true;
  };
  // 随机播放入口覆盖为宿主随机模式命令。
  shuffleQueue = function() { command('set-mode', { mode: 'random' }); };
  // 清空队列入口覆盖为宿主清空队列命令。
  clearQueue = function() { command('queue-clear'); };
  // 移除队列歌曲入口覆盖为宿主按索引移除命令。
  removeFromQueue = function(index) { command('queue-remove-index', { index: Number(index) || 0 }); };
  // 歌词面板入口在桥接模式下只切换粒子歌词显示。
  toggleLyricsPanel = function() {
    if (typeof setParticleLyricsSilently === 'function') setParticleLyricsSilently(!fx.particleLyrics);
  };
  // 全屏入口覆盖为宿主窗口控制命令。
  toggleFullscreen = function() { command('window-control', { action: 'fullscreen' }); };

  // Esc 键关闭或返回宿主页面。
  window.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      // 阻止旧播放器或浏览器默认处理 Esc。
      e.preventDefault();
      e.stopPropagation();
      var atpMask = document.getElementById('add-to-playlist-dialog');
      if (atpMask && atpMask.classList.contains('show')) {
        closeAddToPlaylistDialog();
        return;
      }
      if (wallpaperRuntimeMode) {
        forceWallpaperImmersiveLock();
        return;
      }
      command('close');
    }
  }, true);

  // 接收 EchoMusic 宿主通过 postMessage 推送的桥接协议消息。
  window.addEventListener('message', function(event) {
    // 父页面消息分为初始化、完整快照、歌词、进度和频谱；频谱只更新缓存，实际消费在主循环。
    // 原始 message 数据。
    var data = event && event.data;
    if (!data || data.source !== BRIDGE_PARENT_SOURCE) return;
    if (data.type === 'echo-player-frontend:init') {
      // 初始化消息包含插件版本和宿主窗口控制能力。
      var initPayload = data.payload || {};
      if (initPayload.wallpaperMode) wallpaperRuntimeMode = true;
      document.body.classList.toggle('wallpaper-runtime-mode', !!wallpaperRuntimeMode);
      playerFrontendVersion = String(initPayload.pluginVersion || '').trim();
      bridgeHostControls = Object.assign(bridgeHostControls, initPayload.hostControls || {});
      applyAppearancePayload(initPayload.appearance);
      forcePlayerSurface();
      if (wallpaperRuntimeMode) setImmersiveMode(true);
      refreshBridgeViewport('echo-bridge-init');
      installWindowControls();
      loadHostPersistentStorage().catch(function(err){ console.warn('[存储] 初始化失败', err); });
      // 初始化完成后主动索要一次完整快照。
      post('echo-player-frontend:request-snapshot');
    } else if (data.type === 'echo-player-frontend:snapshot') {
      // 完整快照同步当前歌曲、队列、音量和播放状态。
      applySnapshot(data.payload);
    } else if (data.type === 'echo-player-frontend:lyrics') {
      // 歌词消息只刷新歌词缓存和显示层。
      applyLyricsPayload(data.payload);
    } else if (data.type === 'echo-player-frontend:position') {
      // 位置消息事件驱动到达，更新播放时钟锚点。
      applyPositionPayload(data.payload);
    } else if (data.type === 'echo-player-frontend:appearance') {
      // 外观消息同步主程序页面歌词字体等设置。
      applyAppearancePayload(data.payload);
    } else if (data.type === 'echo-player-frontend:spectrum') {
      // 频谱消息只写入宿主频谱帧，主循环下一帧再消费。
      var spectrum = data.payload || {};
      // 频率柱数据。
      bridgeSpectrum.bins = isHostSpectrumArray(spectrum.bins) ? spectrum.bins : [];
      // 波形数据。
      bridgeSpectrum.waveform = isHostSpectrumArray(spectrum.waveform) ? spectrum.waveform : [];
      // RMS 能量。
      bridgeSpectrum.rms = isFinite(Number(spectrum.rms)) ? clamp01(Number(spectrum.rms)) : 0;
      // 峰值能量。
      bridgeSpectrum.peak = isFinite(Number(spectrum.peak)) ? clamp01(Number(spectrum.peak)) : 0;
      // 频谱帧更新时间。
      bridgeSpectrum.updatedAt = bridgeNow();
    }
  });

  // 安装桥接专用样式。
  installBridgeStyle();
  // 初始化顺序很重要：先安装样式和伪 audio，再拦截控件、打开歌词、显示等待态，最后通知父页面 ready。
  // 安装返回按钮。
  installCloseButton();
  // 安装窗口控制按钮。
  installWindowControls();
  // 安装伪 audio。
  installAudioShim();
  // 安装控件拦截器。
  installControlInterceptors();
  // 默认开启歌词视觉。
  ensureBridgeLyricsEnabled();
  // 强制显示播放器表面。
  forcePlayerSurface();
  // 初始进入等待宿主歌曲状态。
  setBridgeWaitingState(true);
  setInterval(function() {
    // 部分旧 UI 会重建节点，定时补绑可保持桥接拦截持续有效。
    forcePlayerSurface();
    installControlInterceptors();
  }, 1000);
  // 通知宿主 iframe 已就绪。
  post('echo-player-frontend:ready');
})();
// 启动主循环。
startMainLoopSafely();
