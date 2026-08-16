// ===== js/03-stage-lyrics.js =====

// ============================================================
//  舞台歌词系统 v9 — Three.js 文字平面, 跟随专辑粒子 3D 运动
// ============================================================
// 舞台歌词运行期状态，集中保存当前歌词 mesh、退出动画、发光状态和歌词色板。
var stageLyrics = {
  // Three.js 分组，所有歌词相关对象都会挂在这里。
  group: null,
  // 当前正在显示的歌词 mesh。
  current: null,
  // 正在淡出的上一句歌词 mesh 队列。
  outgoing: [],
  // 当前歌词在解析结果中的索引。
  currentIdx: -1,
  // 当前显示的歌词行清单，元素为 buildStageLyricRowEntries 生成的 entry。
  currentEntries: null,
  // 多行轨道当前持有的行对象数组。
  rows: [],
  // 行复用索引，键为 lineIndex + ':' + (译文行 t / 主行 p)。
  rowMap: null,
  // 轨道滚动相位，单位是主行虚拟索引，每帧向目标行插值。
  scrollOffset: 0,
  // 轨道当前对齐的目标行号。
  targetLineIndex: -1,
  // 目标行和下一行的虚拟索引缓存，避免每帧重复求前缀和。
  targetVirtualIndex: 0,
  nextVirtualIndex: 1,
  // 高频触发的歌词高亮辉光强度。
  highBloom: 0,
  // 节拍触发的歌词发光强度。
  beatGlow: 0,
  // 辉光跟随的横向偏移。
  glowFollowX: 0,
  // 辉光跟随的纵向偏移。
  glowFollowY: 0,
  // 辉光跟随的轻微旋转。
  glowFollowRoll: 0,
  // 当前实际用于歌词绘制的色板。
  palette: {
    primary: '#d6f8ff',
    secondary: '#9cffdf',
    highlight: '#eef7ff',
    shadow: 'rgba(2,8,12,0.42)',
    glow: 'rgba(143,233,255,0.34)',
  },
  // 从封面提取出的基础色板，自动色模式会参考它。
  coverPalette: {
    primary: '#d6f8ff',
    secondary: '#9cffdf',
    highlight: '#eef7ff',
    shadow: 'rgba(2,8,12,0.42)',
    glow: 'rgba(143,233,255,0.34)',
  },
  // 歌词后方的星河粒子对象。
  starRiver: null,
  // 星河粒子带宽度，会随歌词宽度平滑变化。
  starRiverWidth: 4.2,
  // 星河粒子带高度，会随歌词高度平滑变化。
  starRiverHeight: 0.58,
  // 相机锁定模式下的歌词适配缩放。
  lockFitScale: 1,
  // 请求歌词相机短暂贴合的剩余帧数。
  snapCameraLockFrames: 0,
};
// 歌词阳光色，作为部分高亮和辉光计算的暖色基准。
var lyricSunColor = new THREE.Color(0xffe6a4);
// 歌词强高亮阳光色。
var lyricSunHotColor = new THREE.Color(0xfff4cc);
// 歌词布局使用的相机前方向。
var lyricCameraDir = new THREE.Vector3();
// 歌词布局使用的相机右方向。
var lyricCameraRight = new THREE.Vector3();
// 歌词布局使用的相机上方向。
var lyricCameraUp = new THREE.Vector3();
// 歌词相机锁定时的目标点缓存。
var lyricCameraTarget = new THREE.Vector3();
// 歌词布局基础坐标缓存。
var lyricLayoutBase = new THREE.Vector3();
// 歌词布局最终目标坐标缓存。
var lyricLayoutTarget = new THREE.Vector3();
// 封面中心的世界坐标缓存。
var lyricCoverWorldPos = new THREE.Vector3();
// 封面世界旋转缓存。
var lyricCoverWorldQuat = new THREE.Quaternion();
// 歌词基础朝向欧拉角缓存。
var lyricBaseEuler = new THREE.Euler(0, 0, 0, 'YXZ');
// 歌词倾斜欧拉角缓存。
var lyricTiltEuler = new THREE.Euler(0, 0, 0, 'YXZ');
// 歌词基础朝向四元数缓存。
var lyricBaseQuat = new THREE.Quaternion();
// 歌词倾斜四元数缓存。
var lyricTiltQuat = new THREE.Quaternion();
// 歌词最终目标四元数缓存。
var lyricTargetQuat = new THREE.Quaternion();
// 相机锁定模式下歌词最大缩放上限，避免贴屏过大。
var LYRIC_CAMERA_LOCK_MAX_SCALE = 0.80;
// 根据当前相机或传入四元数刷新歌词布局用的视图基向量。
function setStageLyricViewBasisFromCameraOrQuaternion(fallbackQuat) {
  if (fallbackQuat) {
    // 有传入四元数时，用它推导前、右、上方向。
    lyricCameraDir.set(0, 0, 1).applyQuaternion(fallbackQuat);
    lyricCameraRight.set(1, 0, 0).applyQuaternion(fallbackQuat);
    lyricCameraUp.set(0, 1, 0).applyQuaternion(fallbackQuat);
  } else if (camera) {
    // 默认从当前 Three.js 相机读取视图方向。
    camera.getWorldDirection(lyricCameraDir);
    lyricCameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    lyricCameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  } else {
    // 没有相机时使用世界坐标轴兜底。
    lyricCameraDir.set(0, 0, 1);
    lyricCameraRight.set(1, 0, 0);
    lyricCameraUp.set(0, 1, 0);
  }
  lyricCameraDir.normalize();
  lyricCameraRight.normalize();
  lyricCameraUp.normalize();
}
// 按相机视图基向量对歌词目标点叠加局部偏移。
function applyStageLyricLayoutOffset(target, x, y, z) {
  return target
    .addScaledVector(lyricCameraRight, x || 0)
    .addScaledVector(lyricCameraUp, y || 0)
    .addScaledVector(lyricCameraDir, z || 0);
}
// 基于基础朝向和用户倾斜角计算歌词目标朝向。
function stageLyricTargetQuaternion(baseQuat, tiltX, tiltY) {
  // 用户倾斜参数以角度保存，这里转换为弧度欧拉角。
  lyricTiltEuler.set((tiltX || 0) * Math.PI / 180, (tiltY || 0) * Math.PI / 180, 0, 'YXZ');
  lyricTiltQuat.setFromEuler(lyricTiltEuler);
  return lyricTargetQuat.copy(baseQuat || lyricBaseQuat).multiply(lyricTiltQuat);
}
// 统计当前歌词和淡出歌词的最大世界尺寸。
function getStageLyricLockBounds() {
  // 最大宽高会用于相机锁定模式的安全缩放计算。
  var maxW = 0, maxH = 0;
  // 多行轨道下真正需要的是整块歌词的上下边界，而不是单行高度。
  var top = null, bottom = null;
  // 内部辅助函数负责读取单个歌词 mesh 的尺寸。
  function take(mesh) {
    if (!mesh || !mesh.userData || !mesh.userData.lyric) return;
    // 歌词数据中保存了 canvas 映射到世界空间后的尺寸。
    var d = mesh.userData.lyric;
    // mesh 可能正在动画缩放，需要把当前 scale 计入包围尺寸。
    var meshScale = Math.max(mesh.scale && isFinite(mesh.scale.x) ? mesh.scale.x : 1, mesh.scale && isFinite(mesh.scale.y) ? mesh.scale.y : 1);
    var w = (d.textWorldW || d.worldW || 6.1) * meshScale;
    var h = (d.textWorldH || d.worldH || 1.0) * meshScale;
    maxW = Math.max(maxW, w);
    maxH = Math.max(maxH, h);
    // 行在轨道里的纵向位置决定整块的上下边界。
    var y = mesh.position && isFinite(mesh.position.y) ? mesh.position.y : 0;
    top = top == null ? y + h / 2 : Math.max(top, y + h / 2);
    bottom = bottom == null ? y - h / 2 : Math.min(bottom, y - h / 2);
  }
  take(stageLyrics.current);
  for (var i = 0; i < stageLyrics.outgoing.length; i++) take(stageLyrics.outgoing[i]);
  // 多行轨道的每一行都要计入，否则相机锁定只按当前行高度算，多行会溢出安全区。
  for (var r = 0; stageLyrics.rows && r < stageLyrics.rows.length; r++) {
    take(stageLyrics.rows[r] && stageLyrics.rows[r].mesh);
  }
  // 整块高度优先于单行高度。
  if (top != null && bottom != null) maxH = Math.max(maxH, top - bottom);
  return { w: maxW || 5.4, h: maxH || 0.78 };
}
// 计算歌词相机锁定模式下为了完整显示歌词所需的缩放倍率。
function lyricCameraLockFit(layoutScale, layoutX, layoutY, distance) {
  // 非透视相机下无法按视锥计算，直接不缩放。
  if (!camera || !camera.isPerspectiveCamera) return 1;
  // 布局缩放需要有最小值，避免除零。
  layoutScale = Math.max(0.1, layoutScale || 1);
  // 当前相机垂直视场角。
  var fov = (camera.fov || 45) * Math.PI / 180;
  // 歌词到相机的估计距离。
  var dist = Math.max(1.4, distance || 4.85);
  // 距离处可见的世界空间高度。
  var visibleH = 2 * Math.tan(fov * 0.5) * dist;
  // 距离处可见的世界空间宽度。
  var visibleW = visibleH * (camera.aspect || (innerWidth / Math.max(1, innerHeight)) || 1.78);
  // 读取当前歌词实际包围尺寸。
  var bounds = getStageLyricLockBounds();
  // 骷髅预设需要更保守的安全区域。
  var skullSafe = !!(fx && fx.preset === SKULL_PRESET_INDEX);
  // 横向安全宽度会扣除用户偏移，避免歌词贴边。
  var safeW = Math.max(visibleW * (skullSafe ? 0.36 : 0.42), visibleW * (skullSafe ? 0.70 : 0.84) - Math.abs(layoutX || 0) * (skullSafe ? 1.36 : 1.22));
  // 纵向安全高度也会扣除用户偏移。
  var safeH = Math.max(visibleH * (skullSafe ? 0.16 : 0.18), visibleH * (skullSafe ? 0.34 : 0.44) - Math.abs(layoutY || 0) * (skullSafe ? 0.98 : 0.82));
  // 当前布局缩放后的歌词宽度。
  var scaledW = Math.max(0.01, bounds.w * layoutScale);
  // 当前布局缩放后的歌词高度。
  var scaledH = Math.max(0.01, bounds.h * layoutScale);
  // 根据宽高同时求得视口适配倍率。
  var viewportFit = Math.min(1, safeW / scaledW, safeH / scaledH);
  // 再叠加一个整体上限，避免锁定模式强行放大。
  var lockScaleCap = Math.min(1, (skullSafe ? 0.94 : LYRIC_CAMERA_LOCK_MAX_SCALE) / layoutScale);
  return clampRange(Math.min(viewportFit, lockScaleCap), skullSafe ? 0.36 : 0.42, 1);
}
// 兼容旧变量名以便其它代码不破坏
// 旧版歌词粒子对象引用，保留给历史调用点。
var lyricsParticles = null;
// 旧版歌词几何引用，保留给历史调用点。
var lyricsGeo = null;

// 三个 attribute: 源位置(随机扩散态), 目标位置(组成字), color, brightness
// 歌词粒子目标位置 A 缓存。
var lyricsAttrTargetA = null;
// 歌词粒子目标位置 B 缓存。
var lyricsAttrTargetB = null;
// 歌词粒子随机种子 attribute 缓存。
var lyricsAttrSeed = null;

// 确保舞台歌词分组存在。
function createLyricsParticles() {
  // 已创建分组时只确保星河粒子存在。
  if (stageLyrics.group) {
    ensureLyricStarRiver();
    return;
  }
  // 歌词对象统一挂在独立 Group 上，便于整体定位和隐藏。
  stageLyrics.group = new THREE.Group();
  stageLyrics.group.renderOrder = 38;
  scene.add(stageLyrics.group);
  ensureLyricStarRiver();
}

// 创建或返回歌词背后的星河粒子层。
function ensureLyricStarRiver() {
  // 歌词分组不存在时不能创建；已存在时直接返回缓存。
  if (!stageLyrics.group || stageLyrics.starRiver) return stageLyrics.starRiver;
  // 星河粒子数量固定，主要用于歌词后方细光流。
  var count = 420;
  // 星河粒子几何只保存随机种子、轨道和深度种子。
  var geo = new THREE.BufferGeometry();
  // 每个粒子的随机种子。
  var seeds = new Float32Array(count);
  // 每个粒子所在流动轨道。
  var lanes = new Float32Array(count);
  // 每个粒子的深度随机值。
  var depths = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    seeds[i] = Math.random() * 1000;
    lanes[i] = Math.random();
    depths[i] = Math.random();
  }
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('lane', new THREE.BufferAttribute(lanes, 1));
  geo.setAttribute('depthSeed', new THREE.BufferAttribute(depths, 1));
  // 星河材质完全由 shader 生成位置和颜色，不需要每帧改几何。
  var mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uTime: uniforms.uTime,
      uPixel: uniforms.uPixel,
      uBass: uniforms.uBass,
      uBeat: uniforms.uBeat,
      uWidth: { value: stageLyrics.starRiverWidth || 4.2 },
      uHeight: { value: stageLyrics.starRiverHeight || 0.58 },
      uOpacity: { value: 0 },
      uColorA: { value: lyricThreeColor(stageLyrics.palette.secondary, '#9cffdf', 0.42) },
      uColorB: { value: lyricThreeColor(stageLyrics.palette.highlight, '#fff7d2', 0.44) }
    },
    vertexShader: [
      'precision highp float;',
      'attribute float seed,lane,depthSeed;',
      'uniform float uTime,uPixel,uBass,uBeat,uWidth,uHeight;',
      'varying float vSeed,vLane,vGlow;',
      'float hash(float n){return fract(sin(n)*43758.5453123);}',
      'void main(){',
      '  float laneBand = floor(lane * 5.0);',
      '  float laneLocal = fract(lane * 5.0);',
      '  float speed = 0.030 + hash(seed * 1.71) * 0.055 + laneBand * 0.005;',
      '  float flow = fract(hash(seed * 2.13) + uTime * speed);',
      '  float x = (flow - 0.5) * uWidth * (1.08 + hash(seed * 5.1) * 0.18);',
      '  float curve = sin(flow * 6.2831853 * (0.92 + hash(seed * 4.0) * 0.46) + seed * 0.071 + uTime * 0.34);',
      '  float breath = sin(uTime * (0.42 + hash(seed * 6.9) * 0.42) + seed * 0.093);',
      '  float y = (laneBand - 2.0) * uHeight * 0.135 + curve * uHeight * (0.20 + hash(seed * 9.0) * 0.18) + (laneLocal - 0.5) * uHeight * 0.16 + breath * uHeight * 0.10;',
      '  float z = -0.08 + (depthSeed - 0.5) * 0.44 + sin(uTime * (0.18 + hash(seed) * 0.24) + seed) * 0.08;',
      '  vec3 pos = vec3(x, y, z);',
      '  float edge = smoothstep(0.0, 0.18, flow) * (1.0 - smoothstep(0.82, 1.0, flow));',
      '  vSeed = seed;',
      '  vLane = lane;',
      '  vGlow = edge * (0.62 + 0.38 * sin(uTime * (0.9 + hash(seed * 8.0) * 0.7) + seed));',
      '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
      '  float dist = max(0.45, -mv.z);',
      '  float size = (0.030 + hash(seed * 12.0) * 0.040 + vGlow * 0.024 + uBeat * 0.010) * (1.0 + uBass * 0.18);',
      '  gl_PointSize = clamp(size * uPixel * 120.0 / dist, 1.0, 7.2);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColorA,uColorB;',
      'uniform float uOpacity,uTime,uBeat;',
      'varying float vSeed,vLane,vGlow;',
      'void main(){',
      '  vec4 tex = texture2D(uMap, gl_PointCoord);',
      '  if(tex.a < 0.02) discard;',
      '  float tw = pow(0.5 + 0.5 * sin(uTime * (0.55 + fract(vSeed) * 0.35) + vSeed), 4.0);',
      '  vec3 col = mix(uColorA, uColorB, smoothstep(0.12, 0.92, vLane) * 0.45 + tw * 0.42 + vGlow * 0.26);',
      '  float alpha = tex.a * uOpacity * (0.20 + vGlow * 0.78 + tw * 0.32 + uBeat * 0.10);',
      '  gl_FragColor = vec4(col * (0.82 + vGlow * 0.72 + tw * 0.32), alpha);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  });
  // 创建星河 Points，并放在歌词稍后的局部空间。
  var points = new THREE.Points(geo, mat);
  points.renderOrder = 45;
  points.frustumCulled = false;
  points.position.set(0, 0.20, 1.53);
  stageLyrics.group.add(points);
  stageLyrics.starRiver = points;
  return points;
}

// 每帧更新歌词星河的尺寸、透明度、色彩和轻微漂移。
function updateLyricStarRiver(dt) {
  // 确保星河对象存在。
  var river = ensureLyricStarRiver();
  // 材质异常时跳过。
  if (!river || !river.material || !river.material.uniforms) return;
  if (fx && fx.preset === SKULL_PRESET_INDEX) {
    // 骷髅预设的嘴部歌词不显示星河，避免干扰面部构图。
    river.visible = false;
    if (river.material.uniforms.uOpacity) river.material.uniforms.uOpacity.value = 0;
    return;
  }
  // 缓存 uniform 引用。
  var u = river.material.uniforms;
  // 当前歌词 mesh 上保存了文本世界尺寸。
  var data = stageLyrics.current && stageLyrics.current.userData ? stageLyrics.current.userData.lyric : null;
  // 星河宽度随歌词宽度变化。
  var targetW = data ? clampRange((data.textWorldW || data.worldW || 4.2) * 1.12 + 0.80, 2.25, 7.20) : 3.4;
  // 星河高度随歌词高度变化。
  var targetH = data ? clampRange((data.textWorldH || data.worldH || 0.58) * 1.85 + 0.18, 0.52, 1.35) : 0.58;
  stageLyrics.starRiverWidth += (targetW - stageLyrics.starRiverWidth) * Math.min(1, dt * 5.2);
  stageLyrics.starRiverHeight += (targetH - stageLyrics.starRiverHeight) * Math.min(1, dt * 4.6);
  u.uWidth.value = stageLyrics.starRiverWidth;
  u.uHeight.value = stageLyrics.starRiverHeight;
  // 歌词辉光开关和强度共同决定星河透明度。
  var lyricGlowStrength = fx.lyricGlow ? Math.min(0.85, Math.max(0, fx.lyricGlowStrength)) : 0;
  var targetOpacity = (stageLyrics.current && fx.lyricGlowParticles)
    ? clampRange(0.22 + lyricGlowStrength * 0.58 + stageLyrics.highBloom * 0.16 + stageLyrics.beatGlow * 0.12, 0.16, 0.86)
    : 0;
  u.uOpacity.value += (targetOpacity - u.uOpacity.value) * (targetOpacity > u.uOpacity.value ? 0.10 : 0.055);
  u.uColorA.value.copy(lyricThreeColor(stageLyrics.palette.secondary || stageLyrics.palette.primary, '#9cffdf', 0.42));
  u.uColorB.value.copy(lyricThreeColor(stageLyrics.palette.highlight || stageLyrics.palette.primary, '#fff7d2', 0.46));
  // 透明度接近 0 且无当前歌词时才隐藏对象。
  river.visible = u.uOpacity.value > 0.01 || !!stageLyrics.current;
  // 星河本体保持微弱漂浮，增强舞台层次。
  var t = uniforms.uTime.value;
  river.position.y += ((0.18 + Math.sin(t * 0.44) * 0.035 + Math.sin(t * 0.91 + 1.7) * 0.018) - river.position.y) * 0.08;
  river.position.z += ((1.54 + Math.cos(t * 0.31) * 0.060) - river.position.z) * 0.08;
  river.rotation.z = Math.sin(t * 0.22) * 0.012;
}

// 移除并释放单个歌词 mesh 及其所有子对象资源。
function disposeLyricMesh(mesh) {
  // 空对象直接跳过。
  if (!mesh) return;
  // 先从父级移除，避免继续参与渲染。
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.traverse(function(obj){
    if (obj.material) {
      // 多材质对象逐个释放贴图和材质。
      if (Array.isArray(obj.material)) {
        obj.material.forEach(function(m){ if (m.map) m.map.dispose(); m.dispose(); });
      } else {
        // 单材质对象需要处理普通 map 和自定义 uniform 贴图。
        if (obj.material.map) obj.material.map.dispose();
        if (obj.material.uniforms && obj.material.uniforms.uMap && obj.material.uniforms.uMap.value) obj.material.uniforms.uMap.value.dispose();
        obj.material.dispose();
      }
    }
    if (obj.geometry) obj.geometry.dispose();
  });
}

// 将数值限制在 0..1。
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
// RGB 转 HSL，供歌词色板推导使用。
function rgbToHsl(r, g, b) {
  // 转换到 0..1 区间。
  r /= 255; g /= 255; b /= 255;
  // 取最大最小通道用于计算亮度、饱和度和色相。
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  // 默认灰度色的色相和饱和度为 0。
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    // d 是通道跨度，决定饱和度。
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h:h, s:s, l:l };
}
// HSL 转 RGB，供色板调整后回写 CSS 色值。
function hslToRgb(h, s, l) {
  // 根据色相分段计算单个 RGB 通道。
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  // 输出通道临时变量。
  var r, g, b;
  if (s === 0) r = g = b = l;
  else {
    // q/p 是 HSL 到 RGB 的标准中间参数。
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r:Math.round(r * 255), g:Math.round(g * 255), b:Math.round(b * 255) };
}
// 把 RGB 对象转成 CSS rgb/rgba 字符串。
function rgbCss(c, a) {
  if (a == null) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
}
// 通用范围限制函数。
function clampRange(v, min, max) { return Math.max(min, Math.min(max, v)); }
// 归一化封面粒子分辨率档位。
function normalizeCoverResolution(v) {
  return clampRange(Number(v) || 1, 0.75, 1.55);
}
// 归一化后台性能策略。
function normalizePerformanceBackgroundMode(v, liveKeepFallback) {
  // 配置统一转为字符串再判断。
  var value = String(v || '');
  if (value === 'keep' || liveKeepFallback === true) return 'keep';
  if (value === 'release') return 'release';
  return 'auto';
}
// 归一化渲染质量档位。
function normalizePerformanceQuality(v) {
  // 只接受已知档位，非法值回退默认。
  var value = String(v || '');
  return /^(eco|balanced|high|ultra)$/.test(value) ? value : fxDefaults.performanceQuality;
}
// 归一化 AI 立体增强模式。
function normalizeAIDepthMode(value) {
  // 旧 aiDepth 字段不再兼容，只有显式新字段会生效。
  value = String(value || '');
  return /^(off|local|cloud)$/.test(value) ? value : fxDefaults.aiDepthMode;
}
// 归一化云端深度服务基础地址。
function normalizeAIDepthCloudApi(value) {
  // 地址留空表示不请求云端；非 http(s) 地址直接视为空。
  var url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return '';
  return url.replace(/\/+$/, '');
}
// 判断当前是否启用任一种 AI 深度模式。
function isAIDepthEnabled() {
  return normalizeAIDepthMode(fx && fx.aiDepthMode) !== 'off';
}
// 判断当前是否使用本地 AI 深度模式。
function isLocalAIDepthMode() {
  return normalizeAIDepthMode(fx && fx.aiDepthMode) === 'local';
}
// 判断当前是否使用云端 AI 深度模式。
function isCloudAIDepthMode() {
  return normalizeAIDepthMode(fx && fx.aiDepthMode) === 'cloud';
}
// 根据分辨率档位计算封面粒子网格边长。
function coverParticleGridForResolution(v) {
  // 基准网格 118，按档位缩放。
  var grid = Math.round(118 * normalizeCoverResolution(v));
  // 限制网格边长，避免粒子数量过低或过高。
  grid = Math.max(88, Math.min(183, grid));
  // 保持奇数边长，让平面中心落在一个粒子上。
  return grid % 2 ? grid : grid + 1;
}
// 生成分辨率 UI 显示用的粒子网格标签。
function coverParticleCountLabel(v) {
  // 读取实际网格边长。
  var grid = coverParticleGridForResolution(v);
  return grid + 'x' + grid;
}
// 根据粒子分辨率选择封面纹理处理尺寸。
function coverTextureSizeForResolution(v) {
  // 先归一化档位，再映射到固定纹理尺寸。
  v = normalizeCoverResolution(v);
  if (v >= 1.32) return 512;
  if (v >= 1.10) return 384;
  return 256;
}
// 归一化歌词过滤正则文本；空字符串表示启用开关下也不实际过滤。
function normalizeLyricFilterRegexText(value, fallback) {
  if (value == null) return fallback == null ? DEFAULT_LYRIC_FILTER_REGEX : String(fallback);
  return String(value).trim();
}
// 读取或导入时校验歌词过滤正则，非法值回退到默认规则。
function normalizeSavedLyricFilterRegex(value) {
  // 候选正则文本。
  var pattern = normalizeLyricFilterRegexText(value, DEFAULT_LYRIC_FILTER_REGEX);
  if (!pattern) return '';
  try {
    // 只验证语法，不在这里执行匹配。
    new RegExp(pattern);
    return pattern;
  } catch (e) {
    return DEFAULT_LYRIC_FILTER_REGEX;
  }
}
// 从宿主数据库状态读取歌词布局和视觉配置。
function readSavedLyricLayout() {
  try {
    // 没有用户保存时使用打包默认布局。
    var raw = (persistedStateSnapshot && persistedStateSnapshot.lyricLayout) || packagedDefaultLyricLayoutRaw();
    // 读取并归一化视觉预设。
    var savedPreset = normalizeVisualPresetIndex(raw.preset, DEFAULT_PLAYBACK_VISUAL_PRESET);
    if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) {
      savedPreset = 5;
    }
    // 背景色和透明度按当前合法范围归一化。
    var savedBgColor = normalizeHexColor(raw.backgroundColor || '#000000', '#000000');
    var savedBgOpacity = clampRange(raw.backgroundOpacity == null ? fxDefaults.backgroundOpacity : Number(raw.backgroundOpacity), 0, 1);
    // 背景颜色模式只接受封面或自定义。
    var savedBgMode = /^(cover|custom)$/.test(String(raw.backgroundColorMode || '')) ? String(raw.backgroundColorMode) : '';
    // 兼容旧字段 backgroundColorCustom 和透明度设置。
    var savedBgCustom = savedBgMode
      ? savedBgMode === 'custom'
      : (raw.backgroundColorCustom === true || (raw.backgroundColorCustom !== false && savedBgColor !== '#000000') || savedBgOpacity < 1);
    // 歌单架相机模式会影响默认角度。
    var savedShelfCameraMode = normalizeShelfCameraMode(raw.shelfCameraMode || fxDefaults.shelfCameraMode);
    // 手动角度标记用于判断是否覆盖默认角度。
    var savedShelfAngleManual = raw.shelfAngleYManual === true;
    // 最终歌单架角度，手动时读保存值，否则按模式取默认。
    var savedShelfAngle = savedShelfAngleManual
      ? clampRange(raw.shelfAngleY == null ? shelfDefaultAngleForCameraMode(savedShelfCameraMode) : Number(raw.shelfAngleY), -30, 30)
      : shelfDefaultAngleForCameraMode(savedShelfCameraMode);
    return {
      preset: savedPreset,
      intensity: clampRange(Number(raw.intensity) || fxDefaults.intensity, 0.2, 1.6),
      cinemaShake: clampRange(Number(raw.cinemaShake) || fxDefaults.cinemaShake, 0, 1.8),
      depth: clampRange(Number(raw.depth) || fxDefaults.depth, 0.2, 1.8),
      point: clampRange(Number(raw.point) || fxDefaults.point, 0.5, 2.2),
      speed: clampRange(Number(raw.speed) || fxDefaults.speed, 0.2, 2.5),
      twist: clampRange(Number(raw.twist) || fxDefaults.twist, 0, 0.6),
      color: clampRange(Number(raw.color) || fxDefaults.color, 0.5, 2.0),
      scatter: clampRange(Number(raw.scatter) || fxDefaults.scatter, 0, 0.5),
      bgFade: clampRange(Number(raw.bgFade) || fxDefaults.bgFade, 0, 1.2),
      bloomStrength: clampRange(Number(raw.bloomStrength) || fxDefaults.bloomStrength, 0, 1.6),
      lyricGlowStrength: clampRange(Number(raw.lyricGlowStrength) || fxDefaults.lyricGlowStrength, 0, 0.85),
      lyricScale: clampRange(Number(raw.lyricScale) || 1, 0.35, 1.65),
      lyricOffsetX: clampRange(Number(raw.lyricOffsetX) || 0, -2.0, 2.0),
      lyricOffsetY: clampRange(Number(raw.lyricOffsetY) || 0, -1.2, 1.35),
      lyricOffsetZ: clampRange(Number(raw.lyricOffsetZ) || 0, -1.6, 1.6),
      lyricTiltX: clampRange(Number(raw.lyricTiltX) || 0, -42, 42),
      lyricTiltY: clampRange(Number(raw.lyricTiltY) || 0, -42, 42),
      lyricCameraLock: !!raw.lyricCameraLock,
      lyricDisplayMode: normalizeLyricDisplayMode(raw.lyricDisplayMode || fxDefaults.lyricDisplayMode),
      lyricCustomLineCount: clampRange(Math.round(raw.lyricCustomLineCount == null ? fxDefaults.lyricCustomLineCount : Number(raw.lyricCustomLineCount)), 1, 10),
      lyricContextOpacity: clampRange(raw.lyricContextOpacity == null ? fxDefaults.lyricContextOpacity : Number(raw.lyricContextOpacity), 0.25, 1),
      lyricContextSpread: clampRange(raw.lyricContextSpread == null ? fxDefaults.lyricContextSpread : Number(raw.lyricContextSpread), 0.60, 2.40),
      lyricTranslationMode: normalizeLyricTranslationMode(raw.lyricTranslationMode || fxDefaults.lyricTranslationMode),
      lyricTranslationGap: clampRange(raw.lyricTranslationGap == null ? fxDefaults.lyricTranslationGap : Number(raw.lyricTranslationGap), 0.28, 2.20),
      lyricTranslationScale: clampRange(raw.lyricTranslationScale == null ? fxDefaults.lyricTranslationScale : Number(raw.lyricTranslationScale), 0.46, 1.12),
      lyricTranslationOpacity: clampRange(raw.lyricTranslationOpacity == null ? fxDefaults.lyricTranslationOpacity : Number(raw.lyricTranslationOpacity), 0.20, 1),
      lyricEdgeFade: clampRange(raw.lyricEdgeFade == null ? fxDefaults.lyricEdgeFade : Number(raw.lyricEdgeFade), 0, 1),
      lyricColorMode: raw.lyricColorMode === 'custom' ? 'custom' : 'auto',
      lyricColor: normalizeHexColor(raw.lyricColor || '#a9b8c8'),
      lyricHighlightMode: raw.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
      lyricHighlightColor: normalizeHexColor(raw.lyricHighlightColor || '#fff0b8'),
      lyricGlowLinked: raw.lyricGlowLinked !== false,
      lyricGlowColor: normalizeHexColor(raw.lyricGlowColor || '#9db8cf'),
      lyricLetterSpacing: clampRange(Number(raw.lyricLetterSpacing) || 0, -0.04, 0.18),
      lyricLineHeight: clampRange(Number(raw.lyricLineHeight) || 1, 0.86, 1.35),
      lyricWeight: clampRange(Number(raw.lyricWeight) || 900, 500, 900),
      lyricTimeOffset: normalizeLyricTimeOffset(raw.lyricTimeOffset),
      lyricFilterEnabled: raw.lyricFilterEnabled !== false,
      lyricFilterRegex: normalizeSavedLyricFilterRegex(raw.lyricFilterRegex),
      lyricGlow: raw.lyricGlow !== false,
      lyricGlowBeat: raw.lyricGlowBeat !== false,
      lyricGlowParticles: !!raw.lyricGlowParticles,
      cinema: raw.cinema !== false,
      bloom: raw.bloom === true,
      edge: raw.edge === true,
      aiDepthMode: normalizeAIDepthMode(raw.aiDepthMode),
      aiDepthCloudApi: normalizeAIDepthCloudApi(raw.aiDepthCloudApi),
      visualTintMode: raw.visualTintMode === 'custom' ? 'custom' : 'auto',
      visualTintColor: normalizeHexColor(raw.visualTintColor || '#9db8cf'),
      uiAccentColor: normalizeHexColor(raw.uiAccentColor || '#00f5d4', '#00f5d4'),
      visualIconColor: normalizeHexColor(raw.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff'),
      backgroundColorMode: savedBgCustom ? 'custom' : 'cover',
      backgroundColor: savedBgColor,
      backgroundOpacity: savedBgOpacity,
      backgroundColorCustom: savedBgCustom,
      backgroundImage: normalizeCustomBackgroundImage(raw.backgroundImage),
      backgroundMedia: normalizeCustomBackgroundMedia(raw.backgroundMedia || raw.backgroundImage),
      performanceBackground: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true),
      performanceQuality: normalizePerformanceQuality(raw.performanceQuality),
      liveBackgroundKeep: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true) === 'keep',
      wallpaperMode: false,
      wallpaperOpacity: clampRange(raw.wallpaperOpacity == null ? fxDefaults.wallpaperOpacity : Number(raw.wallpaperOpacity), 0.35, 1),
      coverResolution: normalizeCoverResolution(raw.coverResolution),
      shelf: /^(off|side|stage)$/.test(String(raw.shelf || '')) ? raw.shelf : fxDefaults.shelf,
      shelfCameraMode: savedShelfCameraMode,
      shelfPresence: normalizeShelfPresence(raw.shelfPresence || fxDefaults.shelfPresence),
      shelfSize: clampRange(raw.shelfSize == null ? fxDefaults.shelfSize : Number(raw.shelfSize), 0.65, 1.45),
      shelfOffsetX: clampRange(raw.shelfOffsetX == null ? fxDefaults.shelfOffsetX : Number(raw.shelfOffsetX), -1.2, 1.2),
      shelfOffsetY: clampRange(raw.shelfOffsetY == null ? fxDefaults.shelfOffsetY : Number(raw.shelfOffsetY), -0.9, 0.9),
      shelfOffsetZ: clampRange(raw.shelfOffsetZ == null ? fxDefaults.shelfOffsetZ : Number(raw.shelfOffsetZ), -0.9, 0.9),
      shelfAngleY: savedShelfAngle,
      shelfAngleYManual: savedShelfAngleManual,
      shelfOpacity: clampRange(raw.shelfOpacity == null ? fxDefaults.shelfOpacity : Number(raw.shelfOpacity), 0.25, 1),
      shelfBgOpacity: clampRange(raw.shelfBgOpacity == null ? fxDefaults.shelfBgOpacity : Number(raw.shelfBgOpacity), 0.25, 0.98),
      shelfAccentColor: normalizeHexColor(raw.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor)
    };
  } catch (e) {
    // 读取失败时返回空对象，由调用方使用默认配置兜底。
    return {};
  }
}
// 保存当前歌词布局和视觉配置到宿主数据库状态。
function saveLyricLayout() {
  try {
    // 保存前再次归一化预设索引，避免写入非法值。
    var presetForSave = normalizeVisualPresetIndex(fx.preset, DEFAULT_PLAYBACK_VISUAL_PRESET);
    saveStatePatch({ lyricLayout: {
      visualPresetSchema: VISUAL_PRESET_SCHEMA,
      preset: presetForSave,
      intensity: clampRange(Number(fx.intensity) || fxDefaults.intensity, 0.2, 1.6),
      cinemaShake: clampRange(Number(fx.cinemaShake) || fxDefaults.cinemaShake, 0, 1.8),
      depth: clampRange(Number(fx.depth) || fxDefaults.depth, 0.2, 1.8),
      point: clampRange(Number(fx.point) || fxDefaults.point, 0.5, 2.2),
      speed: clampRange(Number(fx.speed) || fxDefaults.speed, 0.2, 2.5),
      twist: clampRange(Number(fx.twist) || fxDefaults.twist, 0, 0.6),
      color: clampRange(Number(fx.color) || fxDefaults.color, 0.5, 2.0),
      scatter: clampRange(Number(fx.scatter) || fxDefaults.scatter, 0, 0.5),
      bgFade: clampRange(Number(fx.bgFade) || fxDefaults.bgFade, 0, 1.2),
      bloomStrength: clampRange(Number(fx.bloomStrength) || fxDefaults.bloomStrength, 0, 1.6),
      lyricGlowStrength: clampRange(Number(fx.lyricGlowStrength) || fxDefaults.lyricGlowStrength, 0, 0.85),
      lyricScale: clampRange(Number(fx.lyricScale) || 1, 0.35, 1.65),
      lyricOffsetX: clampRange(Number(fx.lyricOffsetX) || 0, -2.0, 2.0),
      lyricOffsetY: clampRange(Number(fx.lyricOffsetY) || 0, -1.2, 1.35),
      lyricOffsetZ: clampRange(Number(fx.lyricOffsetZ) || 0, -1.6, 1.6),
      lyricTiltX: clampRange(Number(fx.lyricTiltX) || 0, -42, 42),
      lyricTiltY: clampRange(Number(fx.lyricTiltY) || 0, -42, 42),
      lyricCameraLock: !!fx.lyricCameraLock,
      lyricDisplayMode: normalizeLyricDisplayMode(fx.lyricDisplayMode),
      lyricCustomLineCount: lyricCustomLineCountValue(),
      lyricContextOpacity: lyricContextOpacityValue(),
      lyricContextSpread: lyricContextSpreadValue(),
      lyricTranslationMode: normalizeLyricTranslationMode(fx.lyricTranslationMode),
      lyricTranslationGap: lyricTranslationGapValue(),
      lyricTranslationScale: lyricTranslationScaleValue(),
      lyricTranslationOpacity: lyricTranslationOpacityValue(),
      lyricEdgeFade: lyricEdgeFadeValue(),
      lyricColorMode: fx.lyricColorMode === 'custom' ? 'custom' : 'auto',
      lyricColor: normalizeHexColor(fx.lyricColor || '#a9b8c8'),
      lyricHighlightMode: fx.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
      lyricHighlightColor: normalizeHexColor(fx.lyricHighlightColor || '#fff0b8'),
      lyricGlowLinked: fx.lyricGlowLinked !== false,
      lyricGlowColor: normalizeHexColor(fx.lyricGlowColor || '#9db8cf'),
      lyricLetterSpacing: clampRange(Number(fx.lyricLetterSpacing) || 0, -0.04, 0.18),
      lyricLineHeight: clampRange(Number(fx.lyricLineHeight) || 1, 0.86, 1.35),
      lyricWeight: clampRange(Number(fx.lyricWeight) || 900, 500, 900),
      lyricTimeOffset: normalizeLyricTimeOffset(fx.lyricTimeOffset),
      lyricFilterEnabled: fx.lyricFilterEnabled !== false,
      lyricFilterRegex: normalizeSavedLyricFilterRegex(fx.lyricFilterRegex),
      lyricGlow: !!fx.lyricGlow,
      lyricGlowBeat: !!fx.lyricGlowBeat,
      lyricGlowParticles: !!fx.lyricGlowParticles,
      cinema: !!fx.cinema,
      bloom: !!fx.bloom,
      edge: !!fx.edge,
      aiDepthMode: normalizeAIDepthMode(fx.aiDepthMode),
      aiDepthCloudApi: normalizeAIDepthCloudApi(fx.aiDepthCloudApi),
      visualTintMode: fx.visualTintMode === 'custom' ? 'custom' : 'auto',
      visualTintColor: normalizeHexColor(fx.visualTintColor || '#9db8cf'),
      uiAccentColor: normalizeHexColor(fx.uiAccentColor || '#00f5d4', '#00f5d4'),
      visualIconColor: normalizeHexColor(fx.visualIconColor || '#7fd8ff', '#7fd8ff'),
      backgroundColorMode: fx.backgroundColorMode === 'custom' || fx.backgroundColorCustom ? 'custom' : 'cover',
      backgroundColor: normalizeHexColor(fx.backgroundColor || '#000000', '#000000'),
      backgroundOpacity: clampRange(fx.backgroundOpacity == null ? fxDefaults.backgroundOpacity : Number(fx.backgroundOpacity), 0, 1),
      backgroundColorCustom: fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom,
      backgroundImage: '',
      backgroundMedia: serializeCustomBackgroundMedia(fx.backgroundMedia || fx.backgroundImage),
      performanceBackground: normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true),
      performanceQuality: normalizePerformanceQuality(fx.performanceQuality),
      liveBackgroundKeep: normalizePerformanceBackgroundMode(fx.performanceBackground, fx.liveBackgroundKeep === true) === 'keep',
      wallpaperMode: false,
      wallpaperOpacity: clampRange(fx.wallpaperOpacity == null ? fxDefaults.wallpaperOpacity : Number(fx.wallpaperOpacity), 0.35, 1),
      coverResolution: normalizeCoverResolution(fx.coverResolution),
      shelf: /^(off|side|stage)$/.test(String(fx.shelf || '')) ? fx.shelf : fxDefaults.shelf,
      shelfCameraMode: normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode),
      shelfPresence: normalizeShelfPresence(fx.shelfPresence || fxDefaults.shelfPresence),
      shelfSize: clampRange(fx.shelfSize == null ? fxDefaults.shelfSize : Number(fx.shelfSize), 0.65, 1.45),
      shelfOffsetX: clampRange(fx.shelfOffsetX == null ? fxDefaults.shelfOffsetX : Number(fx.shelfOffsetX), -1.2, 1.2),
      shelfOffsetY: clampRange(fx.shelfOffsetY == null ? fxDefaults.shelfOffsetY : Number(fx.shelfOffsetY), -0.9, 0.9),
      shelfOffsetZ: clampRange(fx.shelfOffsetZ == null ? fxDefaults.shelfOffsetZ : Number(fx.shelfOffsetZ), -0.9, 0.9),
      shelfAngleY: clampRange(fx.shelfAngleY == null ? fxDefaults.shelfAngleY : Number(fx.shelfAngleY), -30, 30),
      shelfAngleYManual: fx.shelfAngleYManual === true,
      shelfOpacity: clampRange(fx.shelfOpacity == null ? fxDefaults.shelfOpacity : Number(fx.shelfOpacity), 0.25, 1),
      shelfBgOpacity: clampRange(fx.shelfBgOpacity == null ? fxDefaults.shelfBgOpacity : Number(fx.shelfBgOpacity), 0.25, 0.98),
      shelfAccentColor: normalizeHexColor(fx.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor)
    } });
  } catch (e) {}
}
// 归一化十六进制颜色，支持 #rgb 展开。
function normalizeHexColor(value, fallback) {
  // 先把输入转为去空格字符串。
  var hex = String(value || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    // 三位十六进制展开为六位。
    hex = '#' + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2) + hex.charAt(3) + hex.charAt(3);
  }
  // fallback 本身也必须是合法六位色，否则使用歌词默认色。
  fallback = /^#[0-9a-f]{6}$/i.test(String(fallback || '')) ? String(fallback).toLowerCase() : '#a9b8c8';
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : fallback;
}
// 归一化歌单架相机模式。
function normalizeShelfCameraMode(value) {
  return String(value || '') === 'static' ? 'static' : 'dynamic';
}
// 根据歌单架相机模式给出默认 Y 轴角度。
function shelfDefaultAngleForCameraMode(mode) {
  return normalizeShelfCameraMode(mode) === 'static' ? -15 : 0;
}
// 按当前相机模式应用歌单架默认角度。
function applyShelfCameraDefaultAngle(force) {
  // fx 尚未初始化时不处理。
  if (!fx) return;
  // 先确保相机模式合法。
  fx.shelfCameraMode = normalizeShelfCameraMode(fx.shelfCameraMode || fxDefaults.shelfCameraMode);
  if (force || fx.shelfAngleYManual !== true) {
    // 强制或未手动设置时，使用模式默认角度。
    fx.shelfAngleYManual = false;
    fx.shelfAngleY = shelfDefaultAngleForCameraMode(fx.shelfCameraMode);
  } else {
    // 手动角度只做范围裁剪和整数化。
    fx.shelfAngleY = Math.round(clampRange(Number(fx.shelfAngleY) || 0, -30, 30));
  }
}
// 归一化歌单架存在策略。
function normalizeShelfPresence(value) {
  return String(value || '') === 'always' ? 'always' : 'auto';
}
// 读取并裁剪歌单架数字设置。
function normalizedShelfNumber(key, fallback, min, max) {
  // 优先读取 fx 中的当前值。
  var value = fx && fx[key] != null ? Number(fx[key]) : fallback;
  // 非数值回退默认。
  if (!isFinite(value)) value = fallback;
  return clampRange(value, min, max);
}
// 汇总歌单架当前布局设置。
function shelfSettings() {
  // 角度可能来自手动设置，也可能由相机模式默认决定。
  var angleDeg = fx && fx.shelfAngleYManual === true
    ? normalizedShelfNumber('shelfAngleY', shelfDefaultAngleForCameraMode(fx.shelfCameraMode), -30, 30)
    : shelfDefaultAngleForCameraMode(fx && fx.shelfCameraMode);
  return {
    size: normalizedShelfNumber('shelfSize', fxDefaults.shelfSize, 0.65, 1.45),
    x: normalizedShelfNumber('shelfOffsetX', fxDefaults.shelfOffsetX, -1.2, 1.2),
    y: normalizedShelfNumber('shelfOffsetY', fxDefaults.shelfOffsetY, -0.9, 0.9),
    z: normalizedShelfNumber('shelfOffsetZ', fxDefaults.shelfOffsetZ, -0.9, 0.9),
    angle: angleDeg * Math.PI / 180,
    opacity: normalizedShelfNumber('shelfOpacity', fxDefaults.shelfOpacity, 0.25, 1),
    bgOpacity: normalizedShelfNumber('shelfBgOpacity', fxDefaults.shelfBgOpacity, 0.25, 0.98),
    accent: normalizeHexColor((fx && fx.shelfAccentColor) || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor)
  };
}
// 判断歌单架是否配置为始终可见。
function shelfAlwaysVisible() {
  return !!(fx && normalizeShelfPresence(fx.shelfPresence) === 'always');
}
// 判断当前歌单架相关相机类型是否使用动态相机。
function shouldUseShelfDynamicCamera(type) {
  // 非歌单架相机类型默认允许动态处理。
  if (!/^shelf-/.test(String(type || ''))) return true;
  // 静态模式下禁用歌单架动态相机。
  return !(fx && normalizeShelfCameraMode(fx.shelfCameraMode) === 'static');
}
// 读取当前歌单架强调色。
function shelfAccentHex() {
  return normalizeHexColor((fx && fx.shelfAccentColor) || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor);
}
// 把歌单架强调色转换为 rgba 字符串。
function shelfAccentRgba(alpha, fallback) {
  // 先转为 RGB 对象。
  var rgb = hexToRgb(shelfAccentHex());
  // 转换失败时使用传入兜底或默认暖色。
  if (!rgb) return fallback || 'rgba(244,210,138,' + alpha + ')';
  return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
}
// 将 RGB 数值转换为六位十六进制颜色。
function rgbToHexColor(r, g, b) {
  // 单通道转换并裁剪到 0..255。
  function part(v) {
    return Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0');
  }
  return '#' + part(r) + part(g) + part(b);
}
// 归一化宿主下发的页面歌词字体族。
function normalizeBridgeLyricFontFamily(value) {
  var family = String(value || '').trim();
  if (!family || /[\r\n;]/.test(family)) return BRIDGE_LYRIC_FONT_FAMILY_FALLBACK;
  return family;
}
// 读取歌词字体字重。
function lyricFontWeightValue() {
  return Math.round(clampRange(Number(fx && fx.lyricWeight) || 900, 500, 900) / 50) * 50;
}
// 生成 canvas 字体 CSS 字符串。
function lyricFontCss(fontSize) {
  return lyricFontWeightValue() + ' ' + fontSize + 'px ' + normalizeBridgeLyricFontFamily(bridgeLyricFontFamily);
}
// 根据字体大小计算歌词字距像素值。
function lyricLetterSpacingPx(fontSize) {
  return clampRange(Number(fx && fx.lyricLetterSpacing) || 0, -0.04, 0.18) * Math.max(1, fontSize || 1);
}
// 读取歌词行高倍率。
function lyricLineHeightFactor() {
  return clampRange(Number(fx && fx.lyricLineHeight) || 1, 0.86, 1.35);
}
// 测量带自定义字距的文本宽度。
function measureTextWithLetterSpacing(ctx, text, spacing) {
  // 保证输入是字符串。
  text = String(text || '');
  // 字距非法时按 0 处理。
  spacing = Number(spacing) || 0;
  // 没有字距或单字符时直接使用 canvas 原生测量。
  if (!spacing || text.length < 2) return ctx.measureText(text).width;
  // Array.from 能正确处理代理对和部分组合字符。
  var chars = Array.from(text);
  // 累加后的文本宽度。
  var w = 0;
  for (var i = 0; i < chars.length; i++) {
    w += ctx.measureText(chars[i]).width;
    if (i < chars.length - 1) w += spacing;
  }
  return Math.max(1, w);
}
// 按当前歌词配置测量文本宽度。
function lyricMeasureText(ctx, text, fontSize) {
  return measureTextWithLetterSpacing(ctx, text, lyricLetterSpacingPx(fontSize));
}
// 绘制带自定义字距的文本，支持填充和描边。
function drawTextWithLetterSpacing(ctx, text, x, y, spacing, stroke) {
  // 统一输入格式。
  text = String(text || '');
  spacing = Number(spacing) || 0;
  if (!spacing || text.length < 2) {
    // 没有字距时保留 canvas 原生对齐行为。
    if (stroke) ctx.strokeText(text, x, y);
    else ctx.fillText(text, x, y);
    return;
  }
  // 拆成可迭代字符，避免普通 split 拆坏 emoji 或扩展字符。
  var chars = Array.from(text);
  // 记录原始对齐方式，绘制后恢复。
  var align = ctx.textAlign || 'left';
  // 按自定义字距测量总宽。
  var width = measureTextWithLetterSpacing(ctx, text, spacing);
  // 根据原始对齐方式计算左侧起点。
  var start = x;
  if (align === 'center') start = x - width / 2;
  else if (align === 'right' || align === 'end') start = x - width;
  ctx.textAlign = 'left';
  // 当前字符绘制位置。
  var cursor = start;
  for (var i = 0; i < chars.length; i++) {
    if (stroke) ctx.strokeText(chars[i], cursor, y);
    else ctx.fillText(chars[i], cursor, y);
    cursor += ctx.measureText(chars[i]).width + (i < chars.length - 1 ? spacing : 0);
  }
  ctx.textAlign = align;
}
// 使用当前字距配置绘制填充歌词文本。
function lyricFillText(ctx, text, x, y, fontSize) {
  drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize), false);
}
// 使用当前字距配置绘制描边歌词文本。
function lyricStrokeText(ctx, text, x, y, fontSize) {
  drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize), true);
}
// 将六位十六进制颜色转换为 RGB 对象。
function hexToRgb(hex) {
  // normalizeHexColor 保证后续 slice 可用。
  hex = normalizeHexColor(hex).slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}
// 归一化自定义背景图片来源。
function normalizeCustomBackgroundImage(value) {
  // 仅保留旧存档或宿主解析后的可访问 URL。
  var src = String(value || '').trim();
  if (!src) return '';
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(src)) return src;
  if (/^(https?|file|blob):\/\//i.test(src)) return src;
  return '';
}
// 归一化自定义背景媒体，兼容旧字符串字段和新对象字段。
function normalizeCustomBackgroundMedia(value) {
  // 空值表示没有自定义媒体。
  if (!value) return null;
  if (typeof value === 'string') {
    // 字符串先尝试作为图片处理。
    var img = normalizeCustomBackgroundImage(value);
    if (img) return { type: 'image', src: img };
    if (/^data:video\/(mp4|webm|quicktime);base64,/i.test(value) || /^(https?|file|blob):\/\//i.test(value)) return { type: 'video', src: String(value) };
    return null;
  }
  // 非对象无法表达媒体元数据。
  if (typeof value !== 'object') return null;
  // 只接受图片和视频两类。
  var type = value.type === 'video' ? 'video' : (value.type === 'image' ? 'image' : '');
  if (type === 'image') {
    // 新存档只需要路径；src/resolvedUrl 仅作为运行时 URL 或旧存档兼容。
    var imagePath = String(value.path || '').trim();
    var imageSrc = normalizeCustomBackgroundImage(value.resolvedUrl || value.src || value.url || '');
    if (!imagePath && !imageSrc) return null;
    return {
      type: 'image',
      path: imagePath,
      src: imageSrc,
      resolvedUrl: imageSrc,
      name: String(value.name || '').slice(0, 120),
      mime: String(value.mime || '').slice(0, 80),
      size: Math.max(0, Number(value.size) || 0),
      modifiedAt: Number(value.modifiedAt || 0) || 0
    };
  }
  if (type === 'video') {
    // 新存档只需要路径；src/resolvedUrl 仅作为运行时 URL 或旧存档兼容。
    var videoPath = String(value.path || '').trim();
    var src = String(value.resolvedUrl || value.src || value.url || '').trim();
    if (!videoPath && !/^data:video\/(mp4|webm|quicktime);base64,/i.test(src) && !/^(https?|file|blob):\/\//i.test(src)) return null;
    return {
      type: 'video',
      path: videoPath,
      src: src,
      resolvedUrl: src,
      name: String(value.name || '').slice(0, 120),
      mime: String(value.mime || '').slice(0, 80),
      size: Math.max(0, Number(value.size) || 0),
      modifiedAt: Number(value.modifiedAt || 0) || 0
    };
  }
  return null;
}
// 序列化背景媒体到数据库，只保留真实文件路径元数据。
function serializeCustomBackgroundMedia(media) {
  media = normalizeCustomBackgroundMedia(media);
  if (!media || !media.path) return null;
  return {
    type: media.type,
    path: media.path,
    name: String(media.name || '').slice(0, 120),
    mime: String(media.mime || '').slice(0, 80),
    size: Math.max(0, Number(media.size) || 0),
    modifiedAt: Number(media.modifiedAt || 0) || 0
  };
}
// 返回自定义背景媒体在 UI 上的简短状态文本。
function customBackgroundMediaLabel(media) {
  // 先归一化，避免展示无效媒体。
  media = normalizeCustomBackgroundMedia(media);
  if (!media) return '未设置';
  return media.name || (media.type === 'video' ? '视频已设置' : '图片已设置');
}
// 自定义背景应用 token，用于异步加载防串。
var customBgApplyToken = 0;
// 请求父层解析背景媒体路径。
async function resolveCustomBackgroundMedia(media) {
  media = normalizeCustomBackgroundMedia(media);
  if (!media || !media.path) return media;
  try {
    var result = await requestHostBridge('echo-player-frontend:background-resolve', { media: serializeCustomBackgroundMedia(media) });
    media.resolvedUrl = String(result.url || '');
    media.src = media.resolvedUrl;
  } catch (e) {
    showToast('背景媒体文件不可访问');
    console.warn('[背景媒体] 路径解析失败', e);
  }
  return media;
}
// 打开宿主文件选择器选择背景媒体。
async function selectCustomBackgroundMedia() {
  try {
    var result = await requestHostBridge('echo-player-frontend:background-select', {});
    if (result.canceled) return;
    var media = normalizeCustomBackgroundMedia(Object.assign({}, result.media || {}, { resolvedUrl: result.url, src: result.url }));
    if (!media) {
      showToast('请选择图片或视频文件');
      return;
    }
    setCustomBackgroundMedia(media);
  } catch (e) {
    showToast(e && e.message ? e.message : '背景媒体选择失败');
  }
}
// 从插件数据库读取指定 hash 的深度缓存。
async function getDepthFromStorage(hash) {
  if (!hash) return null;
  try {
    return await hostStorageGet(EPF_DEPTH_STORE_PREFIX + hash);
  } catch (e) {
    console.warn('[深度缓存] 数据库读取失败', e);
    return null;
  }
}
// 将深度缓存写入插件数据库，永久保留，不做自动清理。
async function putDepthToStorage(hash, dataUrl, width, height, format) {
  if (!hash || !dataUrl) return;
  try {
    var payload = { hash: hash, dataUrl: dataUrl, width: width, height: height, ai: true, timestamp: Date.now() };
    if (format) payload.format = format;
    await hostStorageSet(EPF_DEPTH_STORE_PREFIX + hash, payload);
  } catch (e) {
    console.warn('[深度缓存] 数据库写入失败', e);
  }
}
// 颜色实验室弹层的运行状态。
var colorLabState = { picker: null, id: '', h: 0, s: 1, v: 1, dragging: false };
// 颜色实验室内置预设色。
var COLOR_LAB_PRESETS = [
  { name: '极黑', color: '#000000' },
  { name: '极白', color: '#ffffff' },
  { name: '克莱因蓝', color: '#002fa7' },
  { name: '法拉利红', color: '#f00000' },
  { name: '香槟金', color: '#c8a96a' },
  { name: '孔雀绿', color: '#006b5b' },
  { name: '午夜紫', color: '#2b164f' },
  { name: '银雾', color: '#d9dde2' }
];
// RGB 转 HSV，供颜色实验室二维面板使用。
function rgbToHsv(r, g, b) {
  // 转换到 0..1 区间。
  r /= 255; g /= 255; b /= 255;
  // 取最大最小通道计算色相、饱和度和明度。
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  // d 是通道跨度，灰度色时色相保持 0。
  var d = max - min, h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h, s: max === 0 ? 0 : d / max, v: max };
}
// HSV 转十六进制颜色。
function hsvToHex(h, s, v) {
  // 色相循环，饱和度和明度裁剪。
  h = ((h % 1) + 1) % 1; s = clampRange(s, 0, 1); v = clampRange(v, 0, 1);
  // HSV 六分区参数。
  var i = Math.floor(h * 6), f = h * 6 - i;
  // 中间颜色通道。
  var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  // 输出 RGB 通道。
  var r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return rgbToHexColor(r * 255, g * 255, b * 255);
}
// 将颜色实验室当前值应用到对应的设置项。
function applyColorLabValue(hex, silent) {
  // 统一成合法颜色。
  hex = normalizeHexColor(hex || '#000000', '#000000');
  // 当前弹层绑定的控件 id 决定写入哪个设置。
  var id = colorLabState.id;
  if (id === 'ui-accent-picker') setUiAccentColor(hex, true);
  else if (id === 'visual-tint-picker') setVisualTintCustom(hex, true);
  else if (id === 'visual-icon-picker') setVisualIconColor(hex, true);
  else if (id === 'bg-color-picker') setCustomBackgroundColor(hex, true, true);
  else if (id === 'shelf-accent-picker') setShelfAccentColor(hex, true);
  else if (id === 'lyric-color-picker') setLyricColorCustom(hex, true);
  else if (id === 'lyric-highlight-picker') setLyricHighlightCustom(hex, true);
  else if (id === 'lyric-glow-picker') setLyricGlowCustom(hex, true);
  if (!silent) showToast('颜色: ' + hex.toUpperCase());
}
// 根据十六进制颜色同步颜色实验室 UI 状态。
function syncColorLabUi(hex) {
  // 统一输入颜色。
  hex = normalizeHexColor(hex || '#000000', '#000000');
  // 转换为 HSV，驱动色相条和饱和明度面板。
  var rgb = hexToRgb(hex);
  var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  colorLabState.h = hsv.h; colorLabState.s = hsv.s; colorLabState.v = hsv.v;
  // 查找弹层和控件节点。
  var pop = document.getElementById('color-lab-pop');
  var sv = document.getElementById('color-lab-sv');
  var cursor = document.getElementById('color-lab-cursor');
  var hue = document.getElementById('color-lab-hue');
  var hexInput = document.getElementById('color-lab-hex');
  var preview = document.getElementById('color-lab-preview');
  // 当前色相对应的纯色，用于面板背景。
  var hueHex = hsvToHex(colorLabState.h, 1, 1);
  if (pop) {
    pop.style.setProperty('--lab-color', hex);
    pop.style.setProperty('--lab-hue', hueHex);
  }
  if (sv) sv.style.setProperty('--lab-hue', hueHex);
  if (cursor) { cursor.style.left = (colorLabState.s * 100).toFixed(2) + '%'; cursor.style.top = ((1 - colorLabState.v) * 100).toFixed(2) + '%'; }
  if (hue) hue.value = Math.round(colorLabState.h * 360);
  if (hexInput) hexInput.value = hex.toUpperCase();
  if (preview) preview.style.setProperty('--lab-color', hex);
}
// 关闭颜色实验室弹层并清理绑定状态。
function closeColorLab() {
  // 隐藏弹层 DOM。
  var pop = document.getElementById('color-lab-pop');
  if (pop) pop.classList.remove('show');
  // 解除当前 picker 绑定。
  colorLabState.picker = null;
  colorLabState.id = '';
}
// 把视觉控制台的浮动面板放到锚点附近，并限制在视口内。
function placeFxFloatingPanel(pop, anchor, opts) {
  // 必须有面板和可测量的锚点。
  if (!pop || !anchor || !anchor.getBoundingClientRect) return;
  // opts 控制间距和视口边距。
  opts = opts || {};
  // 面板与锚点之间的间隔。
  var gap = opts.gap == null ? 12 : opts.gap;
  // 面板与视口边缘的最小留白。
  var pad = opts.pad == null ? 14 : opts.pad;
  // 锚点矩形。
  var rect = anchor.getBoundingClientRect();
  // 视口宽高兜底到 320，避免极端环境出现负尺寸。
  var vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 320);
  var vh = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 320);
  // 面板实际尺寸，同时不能超过视口安全宽高。
  var pw = Math.min(pop.offsetWidth || pop.getBoundingClientRect().width || 330, vw - pad * 2);
  var ph = Math.min(pop.offsetHeight || pop.getBoundingClientRect().height || 260, vh - pad * 2);
  // 最终左上角位置。
  var left;
  var top;
  if (vw < 760) {
    left = Math.max(pad, Math.min(vw - pw - pad, rect.left + rect.width / 2 - pw / 2));
    top = rect.bottom + gap;
    if (top + ph > vh - pad) top = Math.max(pad, rect.top - ph - gap);
  } else {
    var roomRight = vw - rect.right - pad;
    var roomLeft = rect.left - pad;
    if (roomRight >= pw + gap || roomRight >= roomLeft) left = rect.right + gap;
    else left = rect.left - pw - gap;
    left = Math.max(pad, Math.min(vw - pw - pad, left));
    top = rect.top + rect.height / 2 - ph / 2;
    top = Math.max(pad, Math.min(vh - ph - pad, top));
  }
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  pop.style.transform = 'none';
}
// 打开颜色实验室并绑定到指定颜色选择器。
function openColorLabForPicker(picker) {
  // 查找颜色实验室弹层。
  var pop = document.getElementById('color-lab-pop');
  // 没有选择器或弹层时不能打开。
  if (!picker || !pop) return;
  if (pop.classList.contains('show') && colorLabState.picker === picker) {
    // 再次点击同一个选择器时关闭弹层。
    closeColorLab();
    return;
  }
  // 记录当前绑定的 picker 和 id。
  colorLabState.picker = picker;
  colorLabState.id = picker.id || '';
  // 颜色行用于定位弹层和生成标题。
  var label = picker.closest('.lyric-color-row');
  // 弹层标题显示当前颜色项名称。
  var title = document.getElementById('color-lab-title');
  if (title) title.textContent = label ? (label.textContent || 'Color').replace(/#[0-9a-f]{6}/ig, '').trim().slice(0, 24) : 'Color';
  // 用 picker 当前值同步 HSV 面板。
  syncColorLabUi(picker.value || '#000000');
  // 渲染预设色按钮。
  var presets = document.getElementById('color-lab-presets');
  if (presets) {
    presets.innerHTML = COLOR_LAB_PRESETS.map(function(p){
      return '<button type="button" title="' + escHtml(p.name) + '" style="--c:' + p.color + '" data-color="' + p.color + '"></button>';
    }).join('');
  }
  // 显示弹层并放到对应颜色行附近。
  pop.classList.add('show');
  placeFxFloatingPanel(pop, label || picker, { gap: 12, pad: 14 });
}
// 根据饱和度/明度面板上的指针位置更新颜色。
function updateColorLabFromSv(e) {
  // 查找二维颜色区域。
  var sv = document.getElementById('color-lab-sv');
  if (!sv) return;
  // 读取区域尺寸，将指针坐标转换成 0..1。
  var rect = sv.getBoundingClientRect();
  colorLabState.s = clampRange((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  colorLabState.v = 1 - clampRange((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  // 根据当前 HSV 得到新颜色。
  var hex = hsvToHex(colorLabState.h, colorLabState.s, colorLabState.v);
  // 同步 UI 并静默写入目标设置。
  syncColorLabUi(hex);
  applyColorLabValue(hex, true);
}
// 给原生颜色 input 绑定自定义颜色实验室交互。
function bindColorLabPicker(picker) {
  // 避免重复绑定同一个 input。
  if (!picker || picker._colorLabBound) return;
  picker._colorLabBound = true;
  // 标记此控件会打开 dialog 样式弹层。
  picker.setAttribute('aria-haspopup', 'dialog');
  picker.setAttribute('data-color-lab-picker', '1');
  // 从 pointer/click/键盘事件统一打开弹层。
  function openFromPickerEvent(e) {
    if (e) {
      // 阻止原生颜色选择器弹出，改用自定义颜色实验室。
      e.preventDefault();
      e.stopPropagation();
    }
    picker._colorLabOpenedAt = Date.now();
    openColorLabForPicker(picker);
  }
  picker.addEventListener('pointerdown', openFromPickerEvent);
  // mousedown/click 都阻止原生颜色选择器抢焦点。
  picker.addEventListener('mousedown', function(e){ e.preventDefault(); e.stopPropagation(); });
  picker.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - (picker._colorLabOpenedAt || 0) < 260) return;
    openColorLabForPicker(picker);
  });
  picker.addEventListener('keydown', function(e){
    // 键盘也支持回车和空格打开。
    if (e.key === 'Enter' || e.key === ' ') openFromPickerEvent(e);
  });
}
// 把浮动弹层节点提升到 body，避免被控制台容器裁剪。
function liftFxFloatingPopups() {
  ['cover-color-pop', 'color-lab-pop', 'cover-color-loupe'].forEach(function(id){
    // 只移动已存在且不在 body 下的节点。
    var el = document.getElementById(id);
    if (el && el.parentElement !== document.body) document.body.appendChild(el);
  });
}
// 给颜色行绑定点击打开颜色实验室的交互。
function bindColorLabRows() {
  document.querySelectorAll('.lyric-color-row').forEach(function(row){
    // 已绑定、无效或联动行不处理。
    if (!row || row._colorLabRowBound || row.classList.contains('linked')) return;
    // 行内必须有颜色选择器。
    var picker = row.querySelector('.lyric-color-picker');
    if (!picker) return;
    row._colorLabRowBound = true;
    row.addEventListener('pointerdown', function(e){
      // 忽略按钮、滑杆、选择框等子控件事件。
      if (!e || !e.target) return;
      if (e.target.closest('button,.fx-mini-btn,input[type="range"],select,textarea')) return;
      e.preventDefault();
      e.stopPropagation();
      picker._colorLabOpenedAt = Date.now();
      openColorLabForPicker(picker);
    });
  });
}
// 视口变化或布局变化时重新定位已打开的浮动面板。
function repositionFxFloatingPanels() {
  // 颜色实验室跟随当前 picker。
  var colorPop = document.getElementById('color-lab-pop');
  if (colorPop && colorPop.classList.contains('show') && colorLabState.picker) {
    placeFxFloatingPanel(colorPop, colorLabState.picker.closest('.lyric-color-row') || colorLabState.picker, { gap: 12, pad: 14 });
  }
  // 封面取色弹层跟随视觉色调自动按钮或 picker。
  var coverPop = document.getElementById('cover-color-pop');
  if (coverPop && coverPop.classList.contains('show')) {
    placeFxFloatingPanel(coverPop, document.getElementById('visual-tint-auto-btn') || document.getElementById('visual-tint-picker') || coverPop, { gap: 12, pad: 14 });
  }
}
// 窗口尺寸变化时重排浮动面板。
window.addEventListener('resize', function(){
  if (window.requestAnimationFrame) requestAnimationFrame(repositionFxFloatingPanels);
  else repositionFxFloatingPanels();
});
// 读取当前 UI 强调色。
function uiAccentHex(fallback) {
  return normalizeHexColor((fx && fx.uiAccentColor) || fallback || '#00f5d4', fallback || '#00f5d4');
}
// 把 UI 强调色转换为 rgba 字符串。
function uiAccentRgba(alpha, fallback) {
  // 先把强调色转换成 RGB。
  var c = hexToRgb(uiAccentHex(fallback));
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (alpha == null ? 1 : alpha) + ')';
}
// 根据背景色亮度选择可读的前景墨色。
function readableInkForHex(hex) {
  // 计算感知亮度。
  var c = hexToRgb(hex || '#00f5d4');
  var lum = (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255;
  return lum > 0.54 ? '#06100f' : '#f8fbff';
}
// 从一个十六进制颜色生成歌词色板。
function lyricPaletteFromHex(hex) {
  // 转换为 RGB 和 HSL，便于调整亮度和饱和度。
  var c = hexToRgb(hex);
  var hsl = rgbToHsl(c.r, c.g, c.b);
  // 低饱和色按中性处理，避免强行生成有色副色。
  var neutral = hsl.s < 0.035;
  // 计算适合歌词主色的饱和度。
  var s = neutral ? 0 : clampRange(hsl.s * 1.08, 0.14, 0.92);
  // 根据输入亮度调整到歌词可读范围。
  var l = hsl.l;
  if (l < 0.11) l = 0.15 + l * 1.18;
  else if (l < 0.28) l = 0.21 + (l - 0.11) * 1.18;
  else l = clampRange(l, 0.30, 0.82);
  l = clampRange(l, 0.14, 0.84);
  // 主色、副色和高亮色分别从同一色相附近派生。
  var primary = hslToRgb(hsl.h, s, l);
  var secondary = hslToRgb((hsl.h + 0.055) % 1, neutral ? 0 : clampRange(s * 0.88, 0.12, 0.78), clampRange(l + (l < 0.38 ? 0.10 : -0.08), 0.18, 0.76));
  var highlight = hslToRgb((hsl.h + 0.018) % 1, neutral ? 0 : clampRange(s * 0.72, 0.10, 0.70), clampRange(l + 0.22, 0.38, 0.92));
  // 深色歌词用深阴影，浅色歌词用浅阴影。
  var darkText = l < 0.40;
  return {
    primary: rgbCss(primary),
    secondary: rgbCss(secondary),
    highlight: rgbCss(highlight),
    shadow: darkText ? 'rgba(0,6,10,0.46)' : 'rgba(248,253,255,0.34)',
    glow: rgbCss(primary, 0.26),
  };
}
// 封面过暗或低彩度时使用的银蓝默认歌词色板。
function silverBlueLyricPalette() {
  return {
    primary: '#d8f1ff',
    secondary: '#9db8cf',
    highlight: '#eef7ff',
    shadow: 'rgba(0,7,12,0.48)',
    glow: 'rgba(138,190,255,0.26)',
  };
}
// 设置歌词粒子火花透明度，兼容 ShaderMaterial 和普通 PointsMaterial。
function setLyricSparkOpacity(data, value) {
  // 没有火花材质时跳过。
  if (!data || !data.sparkMat) return;
  // 裁剪透明度范围。
  value = clampRange(Number(value) || 0, 0, 1);
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uOpacity) data.sparkMat.uniforms.uOpacity.value = value;
  else data.sparkMat.opacity = value;
}
// 读取歌词粒子火花透明度。
function getLyricSparkOpacity(data) {
  // 缺省透明度为 0。
  if (!data || !data.sparkMat) return 0;
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uOpacity) return Number(data.sparkMat.uniforms.uOpacity.value) || 0;
  return Number(data.sparkMat.opacity) || 0;
}
// 设置歌词粒子火花尺寸。
function setLyricSparkSize(data, value) {
  // 没有火花材质时跳过。
  if (!data || !data.sparkMat) return;
  // 保证粒子尺寸有最小值。
  value = Math.max(0.002, Number(value) || 0.035);
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uSize) data.sparkMat.uniforms.uSize.value = value;
  else data.sparkMat.size = value;
}
// 读取歌词粒子火花尺寸。
function getLyricSparkSize(data) {
  // 缺省尺寸和创建时保持一致。
  if (!data || !data.sparkMat) return 0.035;
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uSize) return Number(data.sparkMat.uniforms.uSize.value) || 0.035;
  return Number(data.sparkMat.size) || 0.035;
}
// 设置歌词火花颜色，兼容 shader uniform 和普通材质 color。
function setLyricSparkColor(data, color) {
  // 没有火花材质时跳过。
  if (!data || !data.sparkMat) return;
  if (data.sparkMat.uniforms && data.sparkMat.uniforms.uColor) data.sparkMat.uniforms.uColor.value.copy(color);
  else if (data.sparkMat.color) data.sparkMat.color.copy(color);
}
// 将当前歌词色板应用到已存在的歌词 mesh。
function applyLyricPaletteToMesh(mesh) {
  // mesh 没有歌词数据时跳过。
  if (!mesh || !mesh.userData || !mesh.userData.lyric) return;
  // 当前有效歌词色板。
  var pal = stageLyrics.palette || {};
  // 歌词 mesh 的材质和子层数据。
  var data = mesh.userData.lyric;
  if (data.textMat && data.textMat.uniforms) {
    // 更新文字 shader 的基础色、高亮色、辉光色和暖光色。
    var u = data.textMat.uniforms;
    if (u.uBaseColor) u.uBaseColor.value.copy(lyricThreeColor(pal.primary, '#d6f8ff', 0.38));
    if (u.uHiColor) u.uHiColor.value.copy(lyricThreeColor(pal.highlight || pal.primary, '#fff0b8', 0.48));
    if (u.uGlowColor) u.uGlowColor.value.copy(lyricThreeColor(pal.glowColor || pal.secondary || pal.primary, '#9cffdf', 0.36));
    if (u.uSolarColor) u.uSolarColor.value.copy(lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.50));
    // 译文行用的背面可读材质只有单一 uColor。
    if (u.uColor) u.uColor.value.copy(lyricThreeColor(pal.highlight || pal.primary, '#eaf6ff', 0.42));
    if (u.uSolar && !isFinite(u.uSolar.value)) u.uSolar.value = 0;
    if (u.uOpacity && !isFinite(u.uOpacity.value)) u.uOpacity.value = 0;
    data.textMat.needsUpdate = true;
  }
  if (data.glowMat) data.glowMat.color.copy(lyricThreeColor(pal.glowColor || pal.secondary || pal.primary, '#9cffdf', 0.36));
  if (data.sparkMat) setLyricSparkColor(data, lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.46));
  if (data.sunMat) data.sunMat.color.copy(lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.50));
}
// 合并封面色板和用户自定义歌词色设置，得到最终歌词色板。
function effectiveLyricPalette(pal) {
  // 输入色板优先，其次封面色板，最后当前色板。
  var src = pal || stageLyrics.coverPalette || stageLyrics.palette || {};
  // 先生成基础输出，确保字段齐全。
  var out = {
    primary: src.primary || '#d6f8ff',
    secondary: src.secondary || '#9cffdf',
    highlight: src.highlight || '#eef7ff',
    shadow: src.shadow || 'rgba(2,8,12,0.42)',
    glow: src.glow || 'rgba(143,233,255,0.34)'
  };
  if (fx.lyricHighlightMode === 'custom') {
    // 自定义高亮色只替换高亮，必要时联动辉光色。
    var hi = lyricPaletteFromHex(fx.lyricHighlightColor);
    out.highlight = hi.primary;
    if (fx.lyricGlowLinked !== false) {
      out.glowColor = hi.secondary || hi.primary;
      out.glow = hi.glow || out.glow;
    }
  }
  if (fx.lyricGlowLinked === false) {
    // 关闭联动时，辉光使用独立自定义颜色。
    var glowPal = lyricPaletteFromHex(fx.lyricGlowColor || '#9db8cf');
    out.glowColor = glowPal.primary;
    out.glow = glowPal.glow || out.glow;
  }
  if (!out.glowColor) out.glowColor = out.secondary;
  return out;
}
// 设置舞台歌词色板并同步所有相关对象。
function setStageLyricPalette(pal) {
  // 先计算最终有效色板。
  stageLyrics.palette = effectiveLyricPalette(pal);
  // 更新歌词暖光缓存色。
  lyricSunColor.copy(lyricThreeColor(stageLyrics.palette.glowColor || stageLyrics.palette.secondary || stageLyrics.palette.primary, '#ffe6a4', 0.44));
  lyricSunHotColor.copy(lyricThreeColor(stageLyrics.palette.highlight || stageLyrics.palette.primary, '#fff4cc', 0.54));
  applyLyricPaletteToMesh(stageLyrics.current);
  stageLyrics.outgoing.forEach(applyLyricPaletteToMesh);
  // 多行轨道里的上下文行和译文行同样要跟随色板。
  for (var pi = 0; stageLyrics.rows && pi < stageLyrics.rows.length; pi++) {
    if (stageLyrics.rows[pi]) applyLyricPaletteToMesh(stageLyrics.rows[pi].mesh);
  }
  syncSkullParticleColors();
}
// 根据封面主色的 HSL、平均亮度和彩度生成歌词色板。
function lyricTextPaletteFromHsl(hsl, avgL, chroma) {
  if (avgL < 0.16 || chroma < 0.08) {
    // 过暗或低彩度封面使用银蓝色，保证可读性。
    return silverBlueLyricPalette();
  }
  // 取封面代表色相。
  var hue = hsl.h;
  if (avgL < 0.30 && (hue < 0.06 || hue > 0.86 || (hue > 0.75 && hue < 0.86))) return silverBlueLyricPalette();
  if (avgL > 0.82 && chroma < 0.12) {
    // 很亮且低彩度的封面使用偏深的青色文字。
    return {
      primary: '#064b5b',
      secondary: '#168c88',
      highlight: '#315f68',
      shadow: 'rgba(255,255,255,0.48)',
      glow: 'rgba(143,233,255,0.14)',
    };
  }
  // 暗封面用亮字，亮封面用深字。
  var lightText = avgL < 0.52;
  // 提高饱和度，让歌词比封面更醒目。
  var s = Math.max(0.42, Math.min(0.78, hsl.s + 0.16));
  // 主色和副色。
  var c1 = hslToRgb(hsl.h, s, lightText ? 0.74 : 0.34);
  var c2 = hslToRgb((hsl.h + 0.08) % 1, Math.max(0.36, s - 0.10), lightText ? 0.62 : 0.46);
  return {
    primary: rgbCss(c1),
    secondary: rgbCss(c2),
    highlight: rgbCss(hslToRgb((hsl.h + 0.03) % 1, Math.max(0.28, s - 0.18), lightText ? 0.86 : 0.58)),
    shadow: lightText ? 'rgba(0,6,10,0.44)' : 'rgba(248,253,255,0.40)',
    glow: rgbCss(c1, lightText ? 0.24 : 0.14),
  };
}
// 从封面 canvas 抽样更新歌词自动色板。
function updateLyricPaletteFromCover(coverCanvas) {
  // 没有封面 canvas 时保持现有色板。
  if (!coverCanvas) return;
  try {
    // 读取封面像素数据。
    var ctx = coverCanvas.getContext('2d');
    var img = ctx.getImageData(0, 0, coverCanvas.width, coverCanvas.height).data;
    // 缓存宽高。
    var w = coverCanvas.width, h = coverCanvas.height;
    // 累加平均亮度所需的 RGB 和样本数。
    var sumR = 0, sumG = 0, sumB = 0, count = 0;
    // best 保存最适合做歌词色相参考的高彩度像素。
    var best = { score:-1, r:143, g:233, b:255 };
    for (var y = 0; y < h; y += 8) {
      for (var x = 0; x < w; x += 8) {
        var di = (y * w + x) * 4;
        // 当前采样点 RGBA。
        var r = img[di], g = img[di+1], b = img[di+2], a = img[di+3] / 255;
        if (a < 0.5) continue;
        // 亮度和彩度用于评分。
        var lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        var maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        var chroma = (maxC - minC) / 255;
        var edgePenalty = Math.abs(lum - 0.5);
        // 中等亮度且彩度高的像素更适合做歌词色。
        var score = chroma * 1.6 + (0.5 - edgePenalty) * 0.45;
        sumR += r; sumG += g; sumB += b; count++;
        if (lum > 0.08 && lum < 0.92 && score > best.score) best = { score:score, r:r, g:g, b:b };
      }
    }
    if (!count) return;
    // 计算封面平均亮度。
    var avgL = (sumR / count * 0.299 + sumG / count * 0.587 + sumB / count * 0.114) / 255;
    // 代表色转 HSL 后生成歌词色板。
    var hsl = rgbToHsl(best.r, best.g, best.b);
    stageLyrics.coverPalette = lyricTextPaletteFromHsl(hsl, avgL, Math.max(0, best.score));
    if (fx.lyricColorMode !== 'custom') setStageLyricPalette(stageLyrics.coverPalette);
  } catch (e) {}
}

// 将歌词文本按宽度和行数限制拆分成多行。
function wrapLyricText(ctx, text, maxWidth, maxLines, fontSize) {
  // 清理输入文本。
  text = String(text || '').trim();
  // 英文/数字带空格时按词组切，中文等无空格文本按字符切。
  var useWords = /\s/.test(text) && /[A-Za-z0-9]/.test(text);
  // 拆分单元，保留空格以便英文排版。
  var units = useWords ? text.split(/(\s+)/).filter(Boolean) : text.split('');
  // 输出行和当前行。
  var lines = [], line = '';
  for (var i = 0; i < units.length; i++) {
    // 尝试把当前单元加入当前行。
    var test = line + units[i];
    if (lyricMeasureText(ctx, test, fontSize) > maxWidth && line) {
      // 超宽时提交当前行，并从当前单元开启新行。
      lines.push(line.trim());
      line = units[i].trimStart ? units[i].trimStart() : units[i].replace(/^\s+/, '');
      if (lines.length >= maxLines) {
        // 超过最大行数时用省略号截断最后一行。
        var rest = units.slice(i).join('').trim();
        if (rest) lines[lines.length - 1] = lines[lines.length - 1].replace(/[.。,…，、\s]*$/, '') + '...';
        return lines;
      }
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line.trim());
  return lines.length ? lines : [''];
}

// 将 CSS 颜色字符串转换为 Three.Color。
function cssColorToThreeColor(css, fallback) {
  // 先用 fallback 初始化，解析失败时保持这个颜色。
  var c = new THREE.Color(fallback || '#d6f8ff');
  // 支持十六进制、rgb/rgba 和浏览器可识别的 CSS 色。
  var value = String(css || fallback || '#d6f8ff').trim();
  try {
    if (/^#[0-9a-f]{3}$/i.test(value) || /^#[0-9a-f]{6}$/i.test(value)) {
      c.set(normalizeHexColor(value));
      return c;
    }
    // 解析 rgb/rgba 数字格式。
    var m = value.match(/^rgba?\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*([.\d]+)/i);
    if (m) {
      c.setRGB(
        Math.max(0, Math.min(255, parseFloat(m[1]))) / 255,
        Math.max(0, Math.min(255, parseFloat(m[2]))) / 255,
        Math.max(0, Math.min(255, parseFloat(m[3]))) / 255
      );
      return c;
    }
    c.setStyle(value);
  } catch (e) {
    // setStyle 失败时再次尝试 fallback。
    try { c.set(normalizeHexColor(fallback || '#d6f8ff')); } catch (e2) {}
  }
  return c;
}
// 转换歌词用 Three.Color，并确保最低亮度。
function lyricThreeColor(css, fallback, minLum) {
  // 先解析 CSS 颜色。
  var c = cssColorToThreeColor(css, fallback || '#d6f8ff');
  // 感知亮度用于避免歌词过暗。
  var lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  // floor 是最小亮度阈值。
  var floor = minLum == null ? 0.34 : minLum;
  if (lum < floor) {
    // 直接抬升 RGB 通道，保持色相大致不变。
    var lift = floor - lum;
    c.r = Math.min(1, c.r + lift);
    c.g = Math.min(1, c.g + lift);
    c.b = Math.min(1, c.b + lift);
  }
  return c;
}

// 舞台歌词最大行数，当前保持单行以适配 3D 舞台构图。
var STAGE_LYRIC_MAX_LINES = 1;

// 将歌词文本绘制成 alpha 遮罩贴图。
function makeLyricMask(text, opts) {
  opts = opts || {};
  // 分辨率倍率。当前主行用 1 保持原有清晰度，上下文行和译文行降档换显存与切行开销。
  // 画布等比缩放，返回值里的 textMin/textMax 是归一化值、世界尺寸由宽高比推导，下游无需感知。
  var res = clampRange(Number(opts.resolutionScale) || 1, 0.25, 1);
  // 独立 canvas 用于绘制文字遮罩。
  var canvas = document.createElement('canvas');
  // 遮罩固定高分辨率，保证文字边缘细腻。
  var W = Math.round(2048 * res), H = Math.round(384 * res);
  canvas.width = W; canvas.height = H;
  // 绘制上下文。
  var ctx = canvas.getContext('2d');
  // 文字最大宽度，左右保留边距给辉光和抗锯齿。
  var maxWidth = W - Math.round(190 * res);
  // 最大行数来自全局歌词配置。
  var maxLines = STAGE_LYRIC_MAX_LINES;
  // 初始字号，从大到小尝试适配。
  var fontSize = Math.round(128 * res);
  // 字号下限和步进同样按分辨率缩放，保证适配循环的行为与全分辨率一致。
  var minFontSize = Math.max(8, Math.round(42 * res));
  var fontStep = Math.max(1, Math.round(4 * res));
  // 归一化歌词文本空白。
  text = String(text || '').replace(/\s+/g, ' ').trim();
  // 当前适配后的行数组。
  var lines = [text];
  // 当前最宽行宽度。
  var widest = 1;
  for (; fontSize >= minFontSize; fontSize -= fontStep) {
    // 设置当前尝试字号。
    ctx.font = lyricFontCss(fontSize);
    // 如果允许多行且超宽，按宽度换行。
    lines = maxLines > 1 && lyricMeasureText(ctx, text, fontSize) > maxWidth ? wrapLyricText(ctx, text, maxWidth, maxLines, fontSize) : [text];
    widest = 1;
    // 测量所有行，找到最宽行。
    for (var li = 0; li < lines.length; li++) widest = Math.max(widest, lyricMeasureText(ctx, lines[li], fontSize));
    if (widest <= maxWidth) break;
  }
  // 使用最终字号重新测量。
  ctx.font = lyricFontCss(fontSize);
  if (!lines.length) lines = [''];
  widest = 1;
  for (var mi = 0; mi < lines.length; mi++) widest = Math.max(widest, lyricMeasureText(ctx, lines[mi], fontSize));
  // 记录实际文字宽度。
  var width = Math.min(maxWidth, widest);
  // 单行仍超宽时做水平压缩，避免直接裁切文字。
  var fitScaleX = maxLines <= 1 && widest > maxWidth ? Math.max(0.68, maxWidth / widest) : 1;
  if (fitScaleX < 1) width = Math.min(maxWidth, widest * fitScaleX);
  // 行高与块高度用于绘制居中和世界尺寸换算。
  var lineHeight = fontSize * (lines.length > 1 ? 1.02 : 1.0) * lyricLineHeightFactor();
  var blockH = fontSize + (lines.length - 1) * lineHeight;
  // 绘制起点，整体垂直居中。
  var x = W / 2, y0 = H / 2 - blockH / 2 + fontSize * 0.82;
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  for (var di = 0; di < lines.length; di++) {
    if (fitScaleX < 1) {
      // 水平压缩时以中心为原点缩放。
      ctx.save();
      ctx.translate(x, 0);
      ctx.scale(fitScaleX, 1);
      lyricFillText(ctx, lines[di], 0, y0 + di * lineHeight, fontSize);
      ctx.restore();
    } else {
      lyricFillText(ctx, lines[di], x, y0 + di * lineHeight, fontSize);
    }
  }
  // 把遮罩 canvas 转为 Three.js 纹理。
  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  // 返回纹理以及后续布局和 shader 需要的文本边界信息。
  return { texture:tex, width:W, height:H, textWidth:width, textHeight:blockH, fontSize:fontSize, lineHeight:lineHeight, lineCount:lines.length, lines:lines, fitScaleX:fitScaleX, textMin:(W / 2 - width / 2) / W, textMax:(W / 2 + width / 2) / W };
}

// 为歌词生成只跟随文字形状的黑白可读性描边贴图。
function makeLyricReadabilityTexture(mask) {
  // 可读性层与文字遮罩保持同尺寸。
  var canvas = document.createElement('canvas');
  // 读取遮罩尺寸和排版信息。
  var W = mask && mask.width || 2048;
  var H = mask && mask.height || 384;
  var fontSize = mask && mask.fontSize || 128;
  var lines = mask && Array.isArray(mask.lines) && mask.lines.length ? mask.lines : [''];
  var lineHeight = mask && mask.lineHeight || fontSize * lyricLineHeightFactor();
  var fitScaleX = mask && mask.fitScaleX || 1;
  canvas.width = W; canvas.height = H;
  // 绘制上下文。
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.font = lyricFontCss(fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  // 当前文本块高度和首行基线。
  var blockH = fontSize + (lines.length - 1) * lineHeight;
  var y0 = H / 2 - blockH / 2 + fontSize * 0.82;
  // 按指定偏移描边所有歌词行。
  function strokeLines(dx, dy) {
    for (var i = 0; i < lines.length; i++) {
      // 当前行基线。
      var y = y0 + i * lineHeight + (dy || 0);
      if (fitScaleX < 1) {
        // 与遮罩绘制一致，超宽歌词需要水平压缩。
        ctx.save();
        ctx.translate(W / 2 + (dx || 0), 0);
        ctx.scale(fitScaleX, 1);
        lyricStrokeText(ctx, lines[i], 0, y, fontSize);
        ctx.restore();
      } else {
        lyricStrokeText(ctx, lines[i], W / 2 + (dx || 0), y, fontSize);
      }
    }
  }

  // Black/white readability layer: text-shaped only, no rectangular backing.
  // 第一层大范围黑色柔影，用于浅色背景可读性。
  ctx.save();
  ctx.filter = 'blur(14px)';
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(18, fontSize * 0.16);
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  strokeLines(0, fontSize * 0.018);
  ctx.restore();

  // 第二层较细黑描边，增强字形边界。
  ctx.save();
  ctx.filter = 'blur(5px)';
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = Math.max(9, fontSize * 0.075);
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  strokeLines(0, fontSize * 0.012);
  ctx.restore();

  // 第三层白色柔边，帮助深色背景上的字形分离。
  ctx.save();
  ctx.filter = 'blur(4px)';
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = Math.max(9, fontSize * 0.070);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  strokeLines(0, 0);
  ctx.restore();

  // 第四层更细的白色边缘，避免文字被暗背景吞掉。
  ctx.save();
  ctx.filter = 'blur(1.2px)';
  ctx.globalAlpha = 0.26;
  ctx.lineWidth = Math.max(3.2, fontSize * 0.030);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  strokeLines(0, 0);
  ctx.restore();

  // 转为纹理供可读性 mesh 使用。
  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  return tex;
}

// 为歌词生成扩散辉光贴图。
function makeLyricGlowTexture(text, fontSize, textWidth, lines, lineHeight, fitScaleX) {
  // 清理文本并决定实际绘制行。
  text = String(text || '').replace(/\s+/g, ' ').trim();
  var drawLines = Array.isArray(lines) && lines.length ? lines : [text];
  // 辉光 canvas 会按文字实际尺寸动态创建。
  var canvas = document.createElement('canvas');
  // 单独测量 canvas 用于计算辉光贴图尺寸。
  var measureCanvas = document.createElement('canvas');
  var measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = lyricFontCss(fontSize);
  fitScaleX = fitScaleX || 1;
  // 计算所有行中实际最宽的文本宽度。
  var measuredWidth = Math.max(1, textWidth || lyricMeasureText(measureCtx, text, fontSize) * fitScaleX);
  for (var li = 0; li < drawLines.length; li++) measuredWidth = Math.max(measuredWidth, lyricMeasureText(measureCtx, drawLines[li], fontSize) * fitScaleX);
  // 辉光贴图需要额外边距容纳模糊半径。
  var padX = Math.max(160, fontSize * 1.45);
  var padY = Math.max(86, fontSize * 0.78);
  // 行高和文本块高度。
  var lh = lineHeight || fontSize * 1.04;
  var blockH = fontSize + (drawLines.length - 1) * lh;
  // 最终辉光贴图尺寸。
  var W = Math.ceil(measuredWidth + padX * 2);
  var H = Math.ceil(blockH + padY * 2);
  canvas.width = W; canvas.height = H;
  // 绘制上下文。
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = lyricFontCss(fontSize);
  // 第一行基线。
  var y0 = H / 2 - blockH / 2 + fontSize * 0.82;
  // 按偏移绘制所有辉光文字。
  function drawGlowText(dx, dy) {
    for (var i = 0; i < drawLines.length; i++) {
      var y = y0 + i * lh + (dy || 0);
      if (fitScaleX < 1) {
        // 与遮罩一致，超宽歌词使用水平缩放。
        ctx.save();
        ctx.translate(W / 2 + (dx || 0), 0);
        ctx.scale(fitScaleX, 1);
        if (ctx.lineWidth > 0) lyricStrokeText(ctx, drawLines[i], 0, y, fontSize);
        lyricFillText(ctx, drawLines[i], 0, y, fontSize);
        ctx.restore();
      } else {
        if (ctx.lineWidth > 0) lyricStrokeText(ctx, drawLines[i], W / 2 + (dx || 0), y, fontSize);
        lyricFillText(ctx, drawLines[i], W / 2 + (dx || 0), y, fontSize);
      }
    }
  }
  // 小半径强辉光。
  ctx.save();
  ctx.filter = 'blur(14px)';
  ctx.globalAlpha = 0.46;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(10, fontSize * 0.10);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  // 中半径辉光。
  ctx.save();
  ctx.filter = 'blur(34px)';
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(18, fontSize * 0.18);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  // 大半径环境辉光。
  ctx.save();
  ctx.filter = 'blur(78px)';
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(28, fontSize * 0.26);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  // 极大范围弱辉光，形成舞台光晕。
  ctx.save();
  ctx.filter = 'blur(116px)';
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = Math.max(42, fontSize * 0.40);
  ctx.strokeStyle = '#fff';
  drawGlowText(0, 0);
  ctx.restore();
  // 周向轻微重复绘制，让辉光边缘更饱满。
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(8px)';
  ctx.globalAlpha = 0.26;
  ctx.fillStyle = '#fff';
  for (var ri = 0; ri < 8; ri++) {
    // 围绕文字周边偏移采样。
    var ang = ri / 8 * Math.PI * 2;
    drawGlowText(Math.cos(ang) * 7, Math.sin(ang) * 4);
  }
  ctx.restore();
  // 用水平和垂直渐变遮罩裁掉贴图边缘。
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  // 水平淡出遮罩。
  var xMask = ctx.createLinearGradient(0, 0, W, 0);
  xMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  xMask.addColorStop(0.10, 'rgba(255,255,255,1)');
  xMask.addColorStop(0.90, 'rgba(255,255,255,1)');
  xMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = xMask;
  ctx.fillRect(0, 0, W, H);
  // 垂直淡出遮罩。
  var yMask = ctx.createLinearGradient(0, 0, 0, H);
  yMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  yMask.addColorStop(0.16, 'rgba(255,255,255,1)');
  yMask.addColorStop(0.84, 'rgba(255,255,255,1)');
  yMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = yMask;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // 转为 Three.js 纹理，并把尺寸元数据写入 userData。
  var tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.userData = { width:W, height:H, textWidth:measuredWidth };
  return tex;
}

// 歌词太阳辉光纹理缓存。
var lyricSunBloomTexture = null;
// 获取或生成歌词后方的椭圆太阳辉光纹理。
function getLyricSunBloomTexture() {
  // 已生成时直接复用。
  if (lyricSunBloomTexture) return lyricSunBloomTexture;
  // 大尺寸 canvas 用于承载横向椭圆辉光。
  var canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 512;
  // 绘制上下文。
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 中心点。
  var cx = canvas.width * 0.50, cy = canvas.height * 0.50;
  // 主径向辉光先通过横向缩放变成椭圆。
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(2.05, 1);
  var radial = ctx.createRadialGradient(0, 0, 0, 0, 0, canvas.height * 0.43);
  radial.addColorStop(0.00, 'rgba(255,246,186,0.92)');
  radial.addColorStop(0.18, 'rgba(255,219,126,0.44)');
  radial.addColorStop(0.46, 'rgba(255,186,82,0.15)');
  radial.addColorStop(1.00, 'rgba(255,186,82,0)');
  ctx.fillStyle = radial;
  ctx.fillRect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);
  ctx.restore();
  // 叠加多层更柔和的暖色椭圆辉光。
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(34px)';
  ctx.fillStyle = 'rgba(255,235,168,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, canvas.width * 0.33, canvas.height * 0.14, -0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'blur(58px)';
  ctx.fillStyle = 'rgba(255,214,122,0.11)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, canvas.width * 0.45, canvas.height * 0.19, -0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'blur(18px)';
  var core = ctx.createRadialGradient(cx, cy, 0, cx, cy, canvas.width * 0.16);
  core.addColorStop(0.00, 'rgba(255,252,220,0.38)');
  core.addColorStop(0.34, 'rgba(255,230,158,0.20)');
  core.addColorStop(1.00, 'rgba(255,210,116,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  // 边缘淡出遮罩，避免平面边界可见。
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  // 水平淡出。
  var xMask = ctx.createLinearGradient(0, 0, canvas.width, 0);
  xMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  xMask.addColorStop(0.11, 'rgba(255,255,255,1)');
  xMask.addColorStop(0.89, 'rgba(255,255,255,1)');
  xMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = xMask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 垂直淡出。
  var yMask = ctx.createLinearGradient(0, 0, 0, canvas.height);
  yMask.addColorStop(0.00, 'rgba(255,255,255,0)');
  yMask.addColorStop(0.18, 'rgba(255,255,255,1)');
  yMask.addColorStop(0.82, 'rgba(255,255,255,1)');
  yMask.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = yMask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  // 转为纹理并缓存。
  lyricSunBloomTexture = new THREE.CanvasTexture(canvas);
  lyricSunBloomTexture.minFilter = THREE.LinearFilter;
  lyricSunBloomTexture.magFilter = THREE.LinearFilter;
  lyricSunBloomTexture.generateMipmaps = false;
  return lyricSunBloomTexture;
}

// 创建歌词文字本体使用的 shader 材质。
function makeLyricShaderMaterial(mask, pal) {
  return new THREE.ShaderMaterial({
    uniforms: {
      // 文字 alpha 遮罩。
      uMap: { value: mask.texture },
      // 卡拉 OK 进度，控制高亮区域。
      uProgress: { value: 0 },
      // 文字实际横向范围，用于把进度映射到文本宽度。
      uTextMin: { value: mask.textMin },
      uTextMax: { value: mask.textMax },
      // 整体透明度。
      uOpacity: { value: 0 },
      // 基础文字颜色。
      uBaseColor: { value: lyricThreeColor(pal.primary, '#d6f8ff', 0.38) },
      // 已唱进度高亮颜色。
      uHiColor: { value: lyricThreeColor(pal.highlight || pal.primary, '#fff0b8', 0.48) },
      // 进度边缘辉光颜色。
      uGlowColor: { value: lyricThreeColor(pal.glowColor || pal.secondary, '#9cffdf', 0.36) },
      // 太阳暖光颜色。
      uSolarColor: { value: lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff0b8', 0.50) },
      // 原生逐字歌词使用更窄羽化，没有逐字时更柔和。
      uFeather: { value: lyricsHasNativeKaraoke ? 0.100 : 0.220 },
      // 太阳暖光混合强度。
      uSolar: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform float uProgress,uTextMin,uTextMax,uOpacity,uFeather,uSolar;',
      'uniform vec3 uBaseColor,uHiColor,uGlowColor,uSolarColor;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);',
      '  float mask = texture2D(uMap, uv).a;',
      '  if(mask < 0.01) discard;',
      '  float denom = max(0.001, uTextMax - uTextMin);',
      '  float p = clamp((uv.x - uTextMin) / denom, 0.0, 1.0);',
      '  float filled = 1.0 - smoothstep(uProgress, uProgress + uFeather, p);',
      '  float edge = 1.0 - smoothstep(0.0, uFeather * 2.8, abs(p - uProgress));',
      '  vec3 color = mix(uBaseColor, uHiColor, filled * 0.88);',
      '  color += uGlowColor * edge * 0.14;',
      '  vec3 solar = uSolarColor;',
      '  color = mix(color, color + solar * 0.34, uSolar * (0.25 + filled * 0.45));',
      '  color += solar * edge * uSolar * 0.22;',
      '  float lum = dot(color, vec3(0.299, 0.587, 0.114));',
      '  color += vec3(max(0.0, 0.30 - lum));',
      '  gl_FragColor = vec4(color, mask * uOpacity);',
      '}',
    ].join('\n'),
    transparent:true, depthWrite:false, depthTest:false, side:THREE.DoubleSide,
  });
}

// 根据文本构建完整舞台歌词 mesh 组。
function buildLyricMesh(text, opts) {
  opts = opts || {};
  // 图层档位：full 为当前主行的完整五层，context 为上下文主行，translation 为译文行。
  // 不传 opts 时行为与改造前完全一致。
  var variant = opts.variant || 'full';
  var isTranslation = variant === 'translation';
  // 太阳辉光和火花只保留给当前主行，避免多行时开销和亮度失控。
  var wantSun = variant === 'full';
  var wantSparks = variant === 'full';
  // 上下文行和当前句译文保留一层弱辉光，其余行不要。
  var wantGlow = variant === 'full' || opts.glow === true;
  // 译文行字号小、透明度低，描边层收益不大，省掉一整张同尺寸画布。
  var wantReadability = !isTranslation;
  // 归一化文本空白。
  text = String(text || '').replace(/\s+/g, ' ').trim();
  // 先生成文字遮罩。
  var mask = makeLyricMask(text, { resolutionScale: opts.resolutionScale });
  // 使用当前舞台歌词色板。
  var pal = stageLyrics.palette;
  // 歌词平面基础世界宽度。
  var worldW = 6.10;
  // 根据遮罩纵横比计算世界高度。
  var worldH = worldW * (mask.height / mask.width);
  // 文字平面几何。
  var geo = new THREE.PlaneGeometry(worldW, worldH, 1, 1);
  // 文字实际内容在世界空间中的宽高。
  var textWorldW = worldW * (mask.textWidth / mask.width);
  var textWorldH = worldH * ((mask.textHeight || mask.fontSize) / mask.height);
  // 完整歌词组，包含太阳、辉光、可读性层、文字和火花。
  var group = new THREE.Group();
  // 译文行和上下文行压在当前行之后渲染，避免与当前行争 z 序。
  group.renderOrder = variant === 'full' ? 42 : (isTranslation ? 41.4 : 41.8);
  group.position.set((Math.random() - 0.5) * 0.08, 0.20, 1.46);
  group.scale.setScalar(0.96);
  group.userData.age = 0;
  group.userData.state = 'in';
  group.userData.lastLyricProgress = -1;
  group.userData.floatSeed = Math.random() * 100;

  // 太阳辉光材质，位于歌词后方。
  var sunMat = null, sun = null;
  if (wantSun) {
    sunMat = new THREE.MeshBasicMaterial({
      map:getLyricSunBloomTexture(), transparent:true, opacity:0,
      depthWrite:false, depthTest:false, side:THREE.DoubleSide,
      blending:THREE.AdditiveBlending, color:lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#ffe7a6', 0.50)
    });
    // 根据文字实际宽高计算太阳辉光平面尺寸。
    var sunWorldW = Math.max(textWorldW + worldH * 1.10, textWorldW * 1.18);
    sunWorldW = Math.min(worldW * 1.16, Math.max(worldH * 1.35, sunWorldW));
    var sunWorldH = Math.max(worldH * 1.02, Math.min(worldH * 1.54, worldH + textWorldW * 0.070));
    // 太阳辉光 mesh。
    sun = new THREE.Mesh(new THREE.PlaneGeometry(sunWorldW, sunWorldH, 1, 1), sunMat);
    sun.renderOrder = 40;
    sun.position.set(0, 0.02, -0.030);
    sun.scale.set(0.78, 0.58, 1);
    group.add(sun);
  }

  // 文字辉光贴图和材质。
  var glowMat = null, glow = null;
  if (wantGlow) {
    var glowTex = makeLyricGlowTexture(text, mask.fontSize, mask.textWidth, mask.lines, mask.lineHeight, mask.fitScaleX);
    glowMat = new THREE.MeshBasicMaterial({
      map: glowTex, transparent:true, opacity:0, depthWrite:false, depthTest:false,
      side:THREE.DoubleSide, blending:THREE.AdditiveBlending, color:lyricThreeColor(pal.secondary, '#9cffdf', 0.36)
    });
    // 读取辉光贴图元数据用于换算世界尺寸。
    var glowMeta = glowTex.userData || {};
    // 辉光平面宽度按贴图实际宽度映射。
    var glowWorldW = textWorldW * ((glowMeta.width || mask.width) / Math.max(1, glowMeta.textWidth || mask.textWidth));
    glowWorldW = Math.min(worldW * 1.10, Math.max(textWorldW + worldH * 0.38, glowWorldW));
    var glowWorldH = worldH * ((glowMeta.height || mask.height) / mask.height);
    glowWorldH = Math.min(worldH * 1.42, Math.max(worldH * 0.92, glowWorldH));
    // 辉光 mesh 位于文字后方。
    glow = new THREE.Mesh(new THREE.PlaneGeometry(glowWorldW, glowWorldH, 1, 1), glowMat);
    glow.renderOrder = 41;
    glow.scale.set(1.0, 1.06, 1);
    group.add(glow);
  }

  // 可读性层贴图和材质。
  var readabilityMat = null, readability = null;
  if (wantReadability) {
    var readabilityTex = makeLyricReadabilityTexture(mask);
    readabilityMat = new THREE.MeshBasicMaterial({
      map: readabilityTex, transparent:true, opacity:0, depthWrite:false, depthTest:false,
      side:THREE.DoubleSide
    });
    // 可读性层和文字平面同尺寸，只在文字描边区域有 alpha。
    readability = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH, 1, 1), readabilityMat);
    readability.renderOrder = 42;
    readability.position.set(0, 0, -0.012);
    group.add(readability);
  }

  // 文字本体材质。译文行不参与卡拉 OK，用没有 uProgress 的背面可读材质。
  var textMat = isTranslation
    ? makeLyricBackfaceReadableMaterial({
        map: mask.texture,
        opacity: 0,
        color: lyricThreeColor(pal.highlight || pal.primary, '#eaf6ff', 0.42)
      })
    : makeLyricShaderMaterial(mask, pal);
  var textMesh = new THREE.Mesh(geo, textMat);
  textMesh.renderOrder = 43;
  group.add(textMesh);

  // 歌词周围火花粒子数量。
  var sparkCount = 132;
  var ppos = null, pmat = null, sparks = null;
  if (wantSparks) {
  // 火花粒子几何。
  var pgeo = new THREE.BufferGeometry();
  // 火花粒子位置数组。
  ppos = new Float32Array(sparkCount * 3);
  // 火花粒子随机种子。
  var pseed = new Float32Array(sparkCount);
  for (var i = 0; i < sparkCount; i++) {
    // 用椭圆环分布在文字周围。
    var angle = Math.random() * Math.PI * 2;
    var ring = 0.78 + Math.pow(Math.random(), 1.45) * 0.58;
    var rx = textWorldW * (0.50 + Math.random() * 0.22) + 0.10;
    var ry = worldH * (0.42 + Math.random() * 0.22) + 0.08;
    ppos[i*3] = Math.cos(angle) * rx * ring + (Math.random() - 0.5) * textWorldW * 0.12;
    ppos[i*3+1] = Math.sin(angle) * ry * ring + (Math.random() - 0.5) * worldH * 0.14;
    ppos[i*3+2] = (Math.random() - 0.5) * 0.24;
    pseed[i] = Math.random() * 1000;
  }
  pgeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
  pgeo.setAttribute('seed', new THREE.BufferAttribute(pseed, 1));
  // 火花粒子材质，shader 中按 seed 控制大小和闪烁。
  pmat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uSize: { value: 0.052 },
      uOpacity: { value: 0 },
      uColor: { value: lyricThreeColor(pal.highlight || pal.secondary || pal.primary, '#fff7d2', 0.30) },
      uPixel: uniforms.uPixel
    },
    vertexShader: [
      'attribute float seed;',
      'uniform float uSize;',
      'uniform float uPixel;',
      'varying float vSeed;',
      'void main(){',
      '  vSeed = seed;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  float jitter = 0.58 + fract(sin(seed * 19.17) * 43758.5453) * 1.18;',
      '  float depth = clamp(2.2 / max(0.35, -mv.z), 0.54, 1.55);',
      '  gl_PointSize = uSize * jitter * depth * uPixel * 120.0;',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColor;',
      'uniform float uOpacity;',
      'varying float vSeed;',
      'void main(){',
      '  vec4 tex = texture2D(uMap, gl_PointCoord);',
      '  float twinkle = 0.72 + fract(sin(vSeed * 7.31) * 91.7) * 0.28;',
      '  gl_FragColor = vec4(uColor * twinkle, tex.a * uOpacity);',
      '}'
    ].join('\n'),
    transparent:true, depthWrite:false, depthTest:false, blending:THREE.AdditiveBlending
  });
  // 火花粒子对象。
  sparks = new THREE.Points(pgeo, pmat);
  sparks.renderOrder = 44;
  sparks.visible = !!fx.lyricGlowParticles;
  group.add(sparks);
  }

  // 把后续更新所需的材质、尺寸和基础粒子位置都挂到 userData。
  group.userData.lyric = {
    mask:mask, textMesh:textMesh, readability:readability, glow:glow, sparks:sparks, sun:sun,
    textMat:textMat, readabilityMat:readabilityMat, glowMat:glowMat, sparkMat:pmat, sunMat:sunMat,
    basePositions:ppos ? (ppos.slice ? ppos.slice(0) : new Float32Array(ppos)) : null,
    textWorldW:textWorldW, textWorldH:textWorldH, worldW:worldW, worldH:worldH,
    // 图层档位，供行轨道判断该行支持哪些效果。
    variant:variant, isTranslation:isTranslation
  };
  // 初始没有歌词进度时写入默认进度状态。
  updateLyricMeshProgress(group, null);
  return group;
}

// 更新单个歌词 mesh 的卡拉 OK 进度。
function updateLyricMeshProgress(mesh, progress) {
  // 没有歌词数据时跳过。
  if (!mesh || !mesh.userData || !mesh.userData.lyric) return;
  // progress 为 null 表示没有有效逐字进度。
  var hasProgress = progress != null && isFinite(progress);
  // 有效进度裁剪到 0..1，无效进度写 -1 让 shader 不显示已唱高亮。
  progress = hasProgress ? Math.max(0, Math.min(1, progress || 0)) : -1;
  // 读取歌词数据并写入 shader uniform。
  var d = mesh.userData.lyric;
  // 译文行和上下文行用的是没有 uProgress 的材质，不参与逐字高亮。
  if (!d.textMat || !d.textMat.uniforms || !d.textMat.uniforms.uProgress) return;
  d.textMat.uniforms.uProgress.value = progress;
  // 保存上一帧进度，用于样式重绘后恢复。
  mesh.userData.lastLyricProgress = hasProgress ? progress : 0;
  mesh.userData.hasLyricProgress = hasProgress;
}

// 显示一组舞台歌词行。entries 由 buildStageLyricRowEntries 生成，单行模式下长度为 1。
function showStageLine(entries, redrawOnly) {
  // 确保歌词分组已经创建。
  createLyricsParticles();
  if (!stageLyrics.group) return;
  // 空清单表示清空歌词。
  if (!entries || !entries.length) { clearStageLyrics(); return; }
  // 保存当前行清单，后续刷新样式时复用。
  stageLyrics.currentEntries = entries;
  // 交给行轨道做复用、新建和淘汰；当前主行 mesh 会被写回 stageLyrics.current。
  syncStageLyricRows(entries, redrawOnly);
}

// 当前歌词样式变更后重建整条轨道，并尽量保留原进度。
function refreshCurrentLyricStyle() {
  // 没有当前歌词时无需刷新。
  if (!stageLyrics || stageLyrics.currentIdx < 0) return;
  // 读取旧 mesh 中保存的歌词进度。
  var userData = (stageLyrics.current && stageLyrics.current.userData) || {};
  var progress = userData.hasLyricProgress ? (userData.lastLyricProgress || 0) : null;
  // 按当前行数与翻译模式重新生成行清单，避免沿用切换前那份。
  // redrawOnly=true 表示只重绘当前样式，不走淡出队列。
  showStageLine(buildStageLyricRowEntries(stageLyrics.currentIdx), true);
  // 恢复重建前的进度。
  updateLyricMeshProgress(stageLyrics.current, progress);
  // 给新 mesh 一个接近已入场状态的 age，避免样式切换时重新大幅淡入。
  if (stageLyrics.current && stageLyrics.current.userData) stageLyrics.current.userData.age = 0.48;
}

// 清空当前舞台歌词和所有淡出歌词。
function clearStageLyrics() {
  // 释放整条行轨道，其中包含当前主行 mesh，会一并把 stageLyrics.current 置空。
  clearStageLyricRows();
  // 重置歌词索引和行清单缓存。
  stageLyrics.currentIdx = -1;
  stageLyrics.currentEntries = null;
  // 释放淡出队列中的历史歌词。
  while (stageLyrics.outgoing.length) disposeLyricMesh(stageLyrics.outgoing.pop());
}

// 每帧更新舞台歌词的位置、朝向、透明度、辉光和粒子。
function updateStageLyrics3D(dt) {
  // 分组未创建时无需更新。
  if (!stageLyrics.group) return;
  // 未启用粒子歌词且没有可见歌词时跳过。
  if (!fx.particleLyrics && !stageLyrics.current && (!stageLyrics.outgoing || !stageLyrics.outgoing.length)) return;
  // 防止外部异常把缓存数值污染成 NaN。
  if (!isFinite(stageLyrics.highBloom)) stageLyrics.highBloom = 0;
  if (!isFinite(stageLyrics.beatGlow)) stageLyrics.beatGlow = 0;
  if (!isFinite(stageLyrics.glowFollowX)) stageLyrics.glowFollowX = 0;
  if (!isFinite(stageLyrics.glowFollowY)) stageLyrics.glowFollowY = 0;
  if (!isFinite(stageLyrics.glowFollowRoll)) stageLyrics.glowFollowRoll = 0;
  // 当前全局时间。
  var t = uniforms.uTime.value;
  // 歌词辉光强度，关闭时为 0。
  var lyricGlowStrength = fx.lyricGlow ? Math.min(0.85, Math.max(0, fx.lyricGlowStrength)) : 0;
  // 将用户辉光强度换算成内部驱动倍率。
  var glowDrive = Math.min(1.7, Math.max(0, lyricGlowStrength / 0.50));
  // 慢速呼吸项让辉光不完全静止。
  var glowBreath = lyricGlowStrength > 0 ? (0.5 + 0.5 * Math.sin(t * 1.05)) : 0;
  // 音乐能量和节拍共同驱动太阳辉光。
  var musicBloom = Math.max(lyricSunEnergy, beatPulse * 0.10);
  // 节拍跟随辉光只在对应开关开启时生效。
  var beatGlowRaw = fx.lyricGlowBeat && lyricGlowStrength > 0
    ? Math.max(beatPulse * 1.22, beatCam.punch * 0.86 + beatCam.radiusKick * 1.85)
    : 0;
  // 节拍辉光快速上升、慢速下降。
  stageLyrics.beatGlow += (beatGlowRaw - stageLyrics.beatGlow) * (beatGlowRaw > stageLyrics.beatGlow ? 0.32 : 0.10);
  if (!isFinite(stageLyrics.beatGlow)) stageLyrics.beatGlow = 0;
  // 骷髅预设下歌词辉光需要单独降低底噪并加强瞬态。
  var skullLyricPreset = !!(fx && fx.preset === SKULL_PRESET_INDEX);
  // 普通舞台太阳辉光目标。
  var solarBloom = lyricGlowStrength > 0 ? (0.18 + glowBreath * 0.16 + musicBloom * 0.90 + stageLyrics.beatGlow * 1.18 + Math.sin(t * 0.37 + 1.2) * 0.035) * glowDrive : 0;
  if (skullLyricPreset && lyricGlowStrength > 0) {
    // 骷髅预设使用更低常亮和更强的节拍/闪光响应。
    solarBloom = (0.035 + glowBreath * 0.030 + musicBloom * 0.11 + Math.pow(Math.max(0, stageLyrics.beatGlow), 1.26) * 1.45 + Math.pow(Math.max(0, skullBeatFlash || 0), 1.08) * 1.18) * glowDrive;
  }
  // 限制太阳辉光上限。
  solarBloom = Math.max(0, Math.min(1.45, solarBloom));
  // 高亮辉光按目标缓动。
  stageLyrics.highBloom += (solarBloom - stageLyrics.highBloom) * (solarBloom > stageLyrics.highBloom ? (skullLyricPreset ? 0.22 : 0.075) : (skullLyricPreset ? 0.070 : 0.050));
  if (!isFinite(stageLyrics.highBloom)) stageLyrics.highBloom = 0;
  // 更新歌词后方星河。
  updateLyricStarRiver(dt);
  // 计算辉光跟随相机节拍运动的驱动强度。
  var followDrive = fx.lyricGlowBeat && lyricGlowStrength > 0 ? Math.min(1.35, stageLyrics.beatGlow) : 0;
  var followXTarget = followDrive * (beatCam.thetaKick * 34 + beatCam.rollKick * 8);
  var followYTarget = followDrive * (beatCam.phiKick * 42 - beatCam.radiusKick * 0.48);
  var followRollTarget = followDrive * (beatCam.rollKick * 22 + beatCam.thetaKick * 10);
  stageLyrics.glowFollowX += (followXTarget - stageLyrics.glowFollowX) * 0.26;
  stageLyrics.glowFollowY += (followYTarget - stageLyrics.glowFollowY) * 0.24;
  stageLyrics.glowFollowRoll += (followRollTarget - stageLyrics.glowFollowRoll) * 0.22;
  stageLyrics.glowFollowX *= 0.92;
  stageLyrics.glowFollowY *= 0.92;
  stageLyrics.glowFollowRoll *= 0.90;
  // 读取用户歌词布局配置。
  var layoutScale = clampRange(Number(fx.lyricScale) || 1, 0.35, 1.65);
  var layoutX = clampRange(Number(fx.lyricOffsetX) || 0, -2.0, 2.0);
  var layoutY = clampRange(Number(fx.lyricOffsetY) || 0, -1.2, 1.35);
  var layoutZ = clampRange(Number(fx.lyricOffsetZ) || 0, -1.6, 1.6);
  var layoutTiltX = clampRange(Number(fx.lyricTiltX) || 0, -42, 42);
  var layoutTiltY = clampRange(Number(fx.lyricTiltY) || 0, -42, 42);
  // 骷髅预设下歌词可以贴近嘴部。
  var skullMouthLyrics = !!(camera && fx && fx.preset === SKULL_PRESET_INDEX && skullParticleGroup && skullParticleGroup.visible);
  // 歌单架二级详情是否打开。
  var shelfDetailOpen = !!(shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent());
  // 骷髅与普通预设下的歌单架详情分别处理。
  var skullShelfDetailOpen = !!(fx && fx.preset === SKULL_PRESET_INDEX && shelfDetailOpen);
  var normalShelfDetailOpen = !!(shelfDetailOpen && !skullShelfDetailOpen);
  // 歌单架详情打开时降低歌词渲染顺序，避免遮住内容。
  stageLyrics.group.renderOrder = shelfDetailOpen ? 24 : 38;
  // 歌单架详情打开时整体压低歌词亮度和辉光。
  var shelfDetailLyricProfile = shelfDetailOpen ? {
    opacity: skullShelfDetailOpen ? 0.30 : 0.38,
    readability: skullShelfDetailOpen ? 0.20 : 0.26,
    bloom: skullShelfDetailOpen ? 0.20 : 0.24,
    glowCap: skullShelfDetailOpen ? 0.050 : 0.070,
    outgoing: skullShelfDetailOpen ? 0.34 : 0.42,
    easeDown: 0.34
  } : {
    opacity: 0.96,
    readability: 0.86,
    bloom: 1,
    glowCap: 1.0,
    outgoing: 1,
    easeDown: 0.16
  };
  // 是否需要为歌单架避让舞台歌词。
  var shelfLyricAvoid = shouldAvoidStageLyricsForShelf();
  // 壁纸模式下是否使用相机锁定歌词。
  var wallpaperLyricLock = shouldUseWallpaperLyricCameraLock();
  // 壁纸和歌单架组合时需要进一步压暗并偏移歌词。
  var wallpaperShelfLyrics = wallpaperLyricLock && shouldDimWallpaperForShelf();
  if (wallpaperLyricLock) {
    // 壁纸锁定模式下歌词更靠近相机，同时给歌单架留出空间。
    layoutScale *= wallpaperShelfLyrics ? 0.60 : 0.84;
    layoutX = clampRange(layoutX + (wallpaperShelfLyrics ? -1.34 : 0), -2.0, 2.0);
    layoutY = clampRange(layoutY + (wallpaperShelfLyrics ? -0.04 : 0.08), -1.2, 1.35);
    layoutZ = clampRange(layoutZ + (wallpaperShelfLyrics ? 1.02 : 1.15), -1.6, 1.6);
  } else if (!skullMouthLyrics && shelfLyricAvoid && fx.lyricCameraLock) {
    // 普通相机锁定歌词遇到歌单架时向左缩小避让。
    layoutScale *= 0.72;
    layoutX = clampRange(layoutX - 1.36, -2.0, 2.0);
    layoutY = clampRange(layoutY + 0.06, -1.2, 1.35);
    layoutZ = clampRange(layoutZ + 0.72, -1.6, 1.6);
  } else if (!skullMouthLyrics && shouldOffsetLyricsForShelfDetail()) {
    // 歌单架详情打开时，非锁定歌词也需要偏移。
    layoutScale *= normalShelfDetailOpen ? 0.56 : 0.70;
    layoutX = clampRange(layoutX - (normalShelfDetailOpen ? 1.78 : 1.58), -2.0, 2.0);
    layoutY = clampRange(layoutY + (normalShelfDetailOpen ? 0.18 : 0.08), -1.2, 1.35);
    layoutZ = clampRange(layoutZ + 0.84, -1.6, 1.6);
  }
  if (skullMouthLyrics) {
    // 嘴部歌词更小，防止覆盖骷髅面部。
    layoutScale *= skullShelfDetailOpen ? 0.52 : (shelfLyricAvoid ? 0.58 : 0.66);
    if (shelfLyricAvoid && !skullShelfDetailOpen) {
      layoutX = clampRange(layoutX - 0.36, -2.0, 2.0);
      layoutY = clampRange(layoutY + 0.02, -1.2, 1.35);
      layoutZ = clampRange(layoutZ + 0.18, -1.6, 1.6);
    }
  }
  // 相机锁定模式下的基准距离。
  var lockBaseDistance = wallpaperShelfLyrics ? 5.58 : 4.85;
  // 用户 Z 偏移叠加到锁定距离。
  var lockDistance = lockBaseDistance + layoutZ;
  // 是否采用相机锁定歌词。
  var cameraLockedLyrics = (fx.lyricCameraLock || wallpaperLyricLock) && camera;
  // 骷髅回正过程中也需要边缘保护缩放。
  var skullLyricEdgeGuard = !!(fx && fx.preset === SKULL_PRESET_INDEX && (orbit.centerLocked || orbit.recentering));
  // 计算当前构图下的安全缩放。
  var lockFit = (cameraLockedLyrics || skullLyricEdgeGuard || skullMouthLyrics) ? lyricCameraLockFit(layoutScale, layoutX, layoutY, skullMouthLyrics ? Math.max(2.2, 4.4 + layoutZ) : lockDistance) : 1;
  if (skullMouthLyrics) lockFit = Math.min(lockFit, 1.12);
  if (!isFinite(stageLyrics.lockFitScale)) stageLyrics.lockFitScale = 1;
  // 安全缩放平滑变化，缩小时更快。
  stageLyrics.lockFitScale += (lockFit - stageLyrics.lockFitScale) * (lockFit < stageLyrics.lockFitScale ? 0.18 : 0.10);
  stageLyrics.group.scale.setScalar(layoutScale * stageLyrics.lockFitScale);
  if (skullMouthLyrics) {
    // 嘴部歌词完全跟随骷髅模型，不触发相机锁定 snap。
    stageLyrics.snapCameraLockFrames = 0;
    // 先更新骷髅矩阵，再把嘴部本地坐标转成世界坐标。
    skullParticleGroup.updateMatrixWorld(true);
    skullLyricMouthTarget.copy(skullLyricMouthLocal).applyMatrix4(skullParticleGroup.matrixWorld);
    skullParticleGroup.getWorldQuaternion(skullLyricMouthQuat);
    skullLyricMouthForward.set(0, 0, 1).applyQuaternion(skullLyricMouthQuat);
    skullLyricMouthTarget.addScaledVector(skullLyricMouthForward, 0.020);
    // 使用骷髅嘴部朝向作为歌词朝向基础。
    skullLyricReadableQuat.copy(skullLyricMouthQuat);
    setStageLyricViewBasisFromCameraOrQuaternion(skullLyricMouthQuat);
    lyricLayoutTarget.copy(skullLyricMouthTarget);
    applyStageLyricLayoutOffset(lyricLayoutTarget, layoutX, layoutY, layoutZ);
    stageLyricTargetQuaternion(skullLyricReadableQuat, layoutTiltX, layoutTiltY);
    stageLyrics.group.userData = stageLyrics.group.userData || {};
    if (!stageLyrics.group.userData.skullMouthLocked) {
      // 首次进入嘴部锁定时直接贴合，避免从旧位置飞过去。
      stageLyrics.group.position.copy(lyricLayoutTarget);
      stageLyrics.group.quaternion.copy(lyricTargetQuat);
      stageLyrics.group.userData.skullMouthLocked = true;
    } else {
      // 后续帧平滑跟随嘴部。
      stageLyrics.group.position.lerp(lyricLayoutTarget, 0.26);
      stageLyrics.group.quaternion.slerp(lyricTargetQuat, 0.30);
    }
  } else if (cameraLockedLyrics) {
    // 相机锁定歌词时解除嘴部锁定标记。
    if (stageLyrics.group.userData) stageLyrics.group.userData.skullMouthLocked = false;
    // 使用当前相机作为视图基准。
    setStageLyricViewBasisFromCameraOrQuaternion(null);
    // 基准点位于相机前方固定距离。
    lyricLayoutBase.copy(camera.position).addScaledVector(lyricCameraDir, lockBaseDistance);
    lyricCameraTarget.copy(lyricLayoutBase);
    applyStageLyricLayoutOffset(lyricCameraTarget, layoutX, layoutY, layoutZ);
    stageLyricTargetQuaternion(camera.quaternion, layoutTiltX, layoutTiltY);
    if (stageLyrics.snapCameraLockFrames > 0) {
      // snap 帧内直接贴合，常用于切换后立即稳定歌词位置。
      stageLyrics.group.position.copy(lyricCameraTarget);
      stageLyrics.group.quaternion.copy(lyricTargetQuat);
      stageLyrics.snapCameraLockFrames -= 1;
    } else {
      // 普通锁定使用缓动，壁纸模式稍快。
      var lockPosEase = wallpaperLyricLock ? (wallpaperShelfLyrics ? 0.42 : 0.34) : 0.24;
      var lockQuatEase = wallpaperLyricLock ? (wallpaperShelfLyrics ? 0.44 : 0.36) : 0.22;
      stageLyrics.group.position.lerp(lyricCameraTarget, lockPosEase);
      stageLyrics.group.quaternion.slerp(lyricTargetQuat, lockQuatEase);
    }
  } else {
    // 默认歌词跟随封面粒子平面。
    if (stageLyrics.group.userData) stageLyrics.group.userData.skullMouthLocked = false;
    stageLyrics.snapCameraLockFrames = 0;
    if (particles) {
      // 从主粒子对象读取封面世界位置和朝向。
      particles.updateMatrixWorld(true);
      particles.getWorldPosition(lyricCoverWorldPos);
      particles.getWorldQuaternion(lyricCoverWorldQuat);
    } else {
      // 主粒子不存在时退回世界原点和单位朝向。
      lyricCoverWorldPos.set(0, 0, 0);
      lyricCoverWorldQuat.identity();
    }
    // 使用封面朝向作为歌词视图基准。
    setStageLyricViewBasisFromCameraOrQuaternion(lyricCoverWorldQuat);
    lyricLayoutBase.copy(lyricCoverWorldPos);
    lyricLayoutTarget.copy(lyricLayoutBase);
    applyStageLyricLayoutOffset(lyricLayoutTarget, layoutX, layoutY, layoutZ);
    stageLyrics.group.position.copy(lyricLayoutTarget);
    stageLyricTargetQuaternion(lyricCoverWorldQuat, layoutTiltX, layoutTiltY);
    stageLyrics.group.quaternion.copy(lyricTargetQuat);
  }
  // 更新单个歌词 mesh 的入场/退场、透明度和子层状态。
  function tickMesh(mesh, isCurrent) {
    // 空 mesh 视为已结束。
    if (!mesh) return false;
    // age 驱动入场或退场曲线。
    mesh.userData.age += dt;
    // 当前歌词入场时间略长，淡出歌词退场更快。
    var a = Math.min(1, mesh.userData.age / (isCurrent ? 0.52 : 0.38));
    // smoothstep 曲线。
    a = a * a * (3 - 2 * a);
    // 歌词子层数据。
    var data = mesh.userData.lyric || {};
    // 淡出歌词的辉光跟随幅度降低。
    var followMix = isCurrent ? 1.0 : 0.64;
    var glowX = stageLyrics.glowFollowX * followMix;
    var glowY = stageLyrics.glowFollowY * followMix;
    var glowRoll = stageLyrics.glowFollowRoll * followMix;
    if (data.glow) {
      // 辉光层跟随节拍相机偏移，制造光晕滞后。
      data.glow.position.set(glowX * 0.14, glowY * 0.12, -0.006);
      data.glow.rotation.z = glowRoll * 0.30;
    }
    if (data.sun) {
      // 太阳辉光的跟随幅度更大，增强音乐冲击感。
      data.sun.position.set(glowX * 0.42, 0.02 + glowY * 0.34, -0.035);
      data.sun.rotation.z = glowRoll * 0.36;
    }
    if (data.sparks) {
      // 火花粒子也跟随辉光偏移。
      data.sparks.position.set(glowX * 0.24, glowY * 0.22, 0.010);
      data.sparks.rotation.z = glowRoll * 0.22;
    }
    // 当前 mesh 的文字透明度。
    var opacity = 0;
    if (isCurrent) {
      // 当前歌词按歌单架详情状态压暗。
      var shelfDetailLyricDim = shelfDetailLyricProfile.bloom;
      // 当前歌词目标透明度。
      var lyricOpacityTarget = shelfDetailLyricProfile.opacity;
      // 当前文字材质透明度。
      var currentOpacity = data.textMat ? data.textMat.uniforms.uOpacity.value : 0;
      // 详情打开且需要降低透明度时使用更快 ease。
      var opacityEase = shelfDetailOpen && currentOpacity > lyricOpacityTarget ? shelfDetailLyricProfile.easeDown : 0.16;
      opacity = clampRange(currentOpacity + (lyricOpacityTarget - currentOpacity) * opacityEase, 0, 1);
      if (data.textMat) data.textMat.uniforms.uOpacity.value = opacity;
      if (data.readabilityMat) {
        // 可读性描边透明度跟随文字透明度。
        var readabilityTarget = opacity * shelfDetailLyricProfile.readability;
        var readabilityEase = shelfDetailOpen && data.readabilityMat.opacity > readabilityTarget ? 0.28 : 0.16;
        data.readabilityMat.opacity += (readabilityTarget - data.readabilityMat.opacity) * readabilityEase;
      }
      if (data.textMat && data.textMat.uniforms.uSolar) {
        // 文字 shader 中的暖光强度。
        var solarTarget = stageLyrics.highBloom * shelfDetailLyricDim;
        var solarEase = shelfDetailOpen && data.textMat.uniforms.uSolar.value > solarTarget ? 0.26 : 0.12;
        data.textMat.uniforms.uSolar.value += (solarTarget - data.textMat.uniforms.uSolar.value) * solarEase;
      }
      // 当前暖光强度。
      var solar = stageLyrics.highBloom * shelfDetailLyricDim;
      // 颜色向暖光偏移的程度。
      var warmth = Math.max(0, Math.min(1, solar * 1.10));
      if (data.glowMat) {
        // 辉光层透明度受用户强度、音乐和详情压暗共同影响。
        var glowTarget = lyricGlowStrength > 0 ? Math.min(shelfDetailLyricProfile.glowCap, (0.075 + solar * 0.34 + stageLyrics.beatGlow * 0.16 * shelfDetailLyricDim) * Math.min(3.0, glowDrive)) : 0;
        data.glowMat.opacity += (glowTarget - data.glowMat.opacity) * (glowTarget > data.glowMat.opacity ? 0.095 : (shelfDetailOpen ? 0.20 : 0.055));
        data.glowMat.color.copy(lyricThreeColor(stageLyrics.palette.glowColor || stageLyrics.palette.secondary, '#9cffdf', 0.36)).lerp(lyricSunHotColor, warmth);
      }
      if (data.sparkMat) {
        // 火花只在开启粒子辉光且无详情遮挡时明显显示。
        var sparkTarget = lyricGlowStrength > 0 && fx.lyricGlowParticles && !shelfDetailOpen ? Math.min(0.42, (0.10 + solar * 0.14 + stageLyrics.beatGlow * 0.10) * Math.min(1.6, glowDrive)) : 0;
        // 平滑更新火花透明度和大小。
        var sparkOpacity = getLyricSparkOpacity(data);
        sparkOpacity += (sparkTarget - sparkOpacity) * (sparkTarget > sparkOpacity ? 0.13 : (shelfDetailOpen ? 0.22 : 0.075));
        setLyricSparkOpacity(data, sparkOpacity);
        var sparkSizeTarget = fx.lyricGlowParticles && !shelfDetailOpen ? (0.050 + solar * 0.016 + stageLyrics.beatGlow * 0.026 + bass * 0.008) : 0.035;
        setLyricSparkSize(data, getLyricSparkSize(data) + (sparkSizeTarget - getLyricSparkSize(data)) * 0.12);
        // 火花颜色在暖光和高亮色之间变化。
        var sparkColor = lyricSunHotColor.clone().lerp(lyricSunColor, 0.22 + solar * 0.18);
        setLyricSparkColor(data, sparkColor);
      }
      // 每句歌词有独立随机种子，控制漂浮节奏。
      var seed = mesh.userData.floatSeed || 0;
      if (data.sunMat) {
        // 太阳辉光透明度受音乐暖光驱动。
        var sunTarget = lyricGlowStrength > 0 && !shelfDetailOpen ? Math.min(0.88, (Math.pow(Math.min(1.35, solar), 1.08) * 0.28 + stageLyrics.beatGlow * 0.20) * Math.min(2.4, glowDrive)) : 0;
        data.sunMat.opacity += (sunTarget - data.sunMat.opacity) * (shelfDetailOpen ? 0.18 : 0.055);
        data.sunMat.color.copy(lyricSunColor).lerp(lyricSunHotColor, solar * 0.55);
      }
      if (data.sun) {
        // 太阳辉光大小随音乐呼吸。
        var sunPulse = solar;
        var beatScale = fx.lyricGlowBeat ? stageLyrics.beatGlow * 0.24 : 0;
        data.sun.scale.set(0.82 + sunPulse * 0.36 + beatScale + Math.sin(t * 1.6) * sunPulse * 0.018, 0.60 + sunPulse * 0.34 + beatScale * 0.72 + Math.cos(t * 1.25) * sunPulse * 0.020, 1);
        data.sun.rotation.z += Math.sin(t * 0.32 + seed) * 0.010 * sunPulse;
      }
      // 歌词整体的慢速呼吸缩放。
      var breathe = Math.sin(t * 0.92 + seed) * 0.050 + Math.sin(t * 0.41 + seed * 0.7) * 0.028;
      if (skullMouthLyrics) {
        // 嘴部歌词在骷髅本地空间中轻微上下浮动。
        var mouthMeshY = -0.070 + Math.sin(t * 0.50 + seed) * 0.018 + Math.sin(t * 1.12 + seed) * 0.006;
        var mouthMeshZ = 0.018 + Math.cos(t * 0.46 + seed) * 0.007;
        var mouthMeshScale = 1.08 + a * 0.040 + breathe * 0.12 + bass * 0.024 + beatPulse * 0.014;
        if (!mesh.userData.skullMouthMeshLocked) {
          // 第一次进入嘴部布局时直接设置位置。
          mesh.position.set(0, mouthMeshY, mouthMeshZ);
          mesh.userData.skullMouthMeshLocked = true;
        } else {
          // 后续帧平滑跟随。
          mesh.position.x += (0 - mesh.position.x) * 0.18;
          mesh.position.y += (mouthMeshY - mesh.position.y) * 0.16;
          mesh.position.z += (mouthMeshZ - mesh.position.z) * 0.18;
        }
        mesh.scale.setScalar(mouthMeshScale);
        mesh.rotation.z = Math.sin(t * 0.30 + seed) * 0.010;
      } else {
        // 普通舞台歌词在封面前方漂浮。
        mesh.userData.skullMouthMeshLocked = false;
        mesh.scale.setScalar(0.96 + a * 0.055 + breathe + bass * 0.038 + beatPulse * 0.014);
        mesh.position.y += ((0.18 + Math.sin(t * 0.55 + seed) * 0.055 + Math.sin(t * 1.35 + seed) * 0.014) - mesh.position.y) * 0.075;
        mesh.position.z += ((1.48 + Math.cos(t * 0.48 + seed) * 0.080) - mesh.position.z) * 0.080;
        mesh.rotation.z = Math.sin(t * 0.34 + seed) * 0.018;
      }
      // 根据开关或残留透明度决定火花可见性。
      if (data.sparks && data.sparkMat) data.sparks.visible = fx.lyricGlowParticles || getLyricSparkOpacity(data) > 0.015;
      if (data.sparks && data.basePositions) {
        // 更新火花粒子的位置扰动。
        var pos = data.sparks.geometry.attributes.position;
        // 当前火花位置数组和原始位置数组。
        var arr = pos.array, base = data.basePositions;
        data.sparks.rotation.z += ((fx.lyricGlowParticles ? 0.0009 : 0.00025) + stageLyrics.beatGlow * 0.0007) * (dt * 60);
        data.sparks.rotation.x = Math.sin(t * 0.12 + seed) * 0.012;
        for (var si = 0; si < arr.length / 3; si++) {
          // 单粒子的稳定随机相位。
          var s = si * 12.989 + seed;
          // 粒子节拍和呼吸幅度。
          var particleBeat = fx.lyricGlowParticles ? stageLyrics.beatGlow : 0;
          var dustBreath = fx.lyricGlowParticles ? (0.62 + 0.38 * Math.sin(t * (0.32 + (si % 7) * 0.025) + s)) : 0.18;
          var drift = fx.lyricGlowParticles ? 1 : 0.30;
          arr[si*3] = base[si*3] + Math.sin(t * (0.18 + (si % 5) * 0.025) + s) * (0.045 + bass * 0.030 + particleBeat * 0.052) * drift + Math.cos(t * 0.11 + s) * 0.018 * dustBreath;
          arr[si*3+1] = base[si*3+1] + Math.cos(t * (0.16 + (si % 6) * 0.024) + s) * (0.042 + mid * 0.026 + particleBeat * 0.046) * drift + Math.sin(t * 0.13 + s) * 0.016 * dustBreath;
          arr[si*3+2] = base[si*3+2] + Math.sin(t * (0.24 + (si % 4) * 0.035) + s) * (0.036 + particleBeat * 0.028) * drift;
        }
        pos.needsUpdate = true;
      }
      return true;
    }
    // 淡出歌词透明度随退场曲线降低。
    opacity = (1 - a) * 0.72 * shelfDetailLyricProfile.outgoing;
    if (data.textMat) data.textMat.uniforms.uOpacity.value = opacity;
    if (data.readabilityMat) data.readabilityMat.opacity = opacity * (shelfDetailOpen ? shelfDetailLyricProfile.readability : 0.58);
    if (data.textMat && data.textMat.uniforms.uSolar) data.textMat.uniforms.uSolar.value *= shelfDetailOpen ? 0.72 : 0.86;
    if (data.glowMat) data.glowMat.opacity = lyricGlowStrength > 0 ? (shelfDetailOpen ? Math.min(shelfDetailLyricProfile.glowCap * 0.40, opacity * 0.05 * lyricGlowStrength) : opacity * 0.08 * lyricGlowStrength) : 0;
    if (data.sparkMat) {
      // 淡出歌词的火花快速消散。
      var outgoingSpark = lyricGlowStrength > 0 && fx.lyricGlowParticles && !shelfDetailOpen ? Math.max(opacity * 0.24 * lyricGlowStrength, (1 - a) * 0.18 * lyricGlowStrength) : 0;
      setLyricSparkOpacity(data, outgoingSpark);
      setLyricSparkSize(data, 0.046 + (1 - a) * 0.020);
    }
    if (data.sunMat) data.sunMat.opacity = lyricGlowStrength > 0 && !shelfDetailOpen ? opacity * 0.08 * lyricGlowStrength : 0;
    // 淡出歌词向后上方轻移。
    mesh.position.z -= dt * 0.26;
    mesh.position.y += dt * 0.08;
    mesh.scale.setScalar(0.98 - a * 0.06);
    return a < 1;
  }
  // 更新当前歌词。
  tickMesh(stageLyrics.current, true);
  // 当前主行之外的上下文行和译文行由行轨道统一驱动，锚定在当前行的漂浮位置上。
  updateStageLyricRows(dt, {
    time: t,
    skullMouthLyrics: skullMouthLyrics,
    shelfDetailOpen: shelfDetailOpen,
    shelfDetailProfile: shelfDetailLyricProfile,
    lyricGlowStrength: lyricGlowStrength,
    glowDrive: glowDrive
  });
  // 逆序更新淡出队列，结束的 mesh 直接释放。
  for (var i = stageLyrics.outgoing.length - 1; i >= 0; i--) {
    if (!tickMesh(stageLyrics.outgoing[i], false)) {
      disposeLyricMesh(stageLyrics.outgoing[i]);
      stageLyrics.outgoing.splice(i, 1);
    }
  }
}

// 将宿主提供的逐字歌词时间数据归一化为内部格式。
function normalizeLyricCharacters(characters, timeScale) {
  // timeScale 为 ms 时需要除以 1000 转成秒。
  var scale = timeScale === 'ms' ? 1000 : 1;
  // offset 记录当前字符在整行文本中的起始位置。
  var offset = 0;
  // 输出逐字段数组。
  var output = [];
  (Array.isArray(characters) ? characters : []).forEach(function(character) {
    // 兼容 text/t 两种字段名。
    var text = String(character && (character.text != null ? character.text : character.t) || '');
    if (!text) return;
    // 兼容 startTime/endTime 和 s/e 字段名。
    var start = Number(character && (character.startTime != null ? character.startTime : character.s));
    var end = Number(character && (character.endTime != null ? character.endTime : character.e));
    if (!isFinite(start)) start = 0;
    if (!isFinite(end)) end = start;
    start = Math.max(0, start / scale);
    end = Math.max(start + 0.001, end / scale);
    // 当前片段覆盖的字符范围。
    var c0 = offset;
    offset += text.length;
    output.push({ text:text, t:start, d:Math.max(0.001, end - start), c0:c0, c1:offset });
  });
  return output;
}
// 读取歌词行中的有效逐字时间单元。
function lyricTimingUnits(line) {
  if (!line) return [];
  if (Array.isArray(line.characters) && line.characters.length > 1) return line.characters;
  return [];
}
// 判断歌词行是否有可用的逐字时间信息。
function hasValidLyricCharacters(line) {
  // 先取逐字时间单元。
  var units = lyricTimingUnits(line);
  // charCount 是整行字符总数，用于把字符位置映射到 0..1 进度。
  var count = line && Number(line.charCount) || 0;
  return units.length > 1 && count > 0 && units.some(function(unit){
    return unit && isFinite(unit.t) && isFinite(unit.d) && unit.d > 0 && unit.c1 > unit.c0;
  });
}
// 根据当前播放时间计算当前歌词行的卡拉 OK 高亮进度。
function getLyricLineProgress(line, nextLine, now) {
  // 没有逐字数据时返回 null，让 shader 不显示精确高亮。
  if (!line || !Array.isArray(line.characters) || line.characters.length <= 1) return null;
  if (!hasValidLyricCharacters(line)) return null;
  // 逐字时间单元。
  var units = lyricTimingUnits(line);
  // 轻微提前，让高亮视觉更贴近听感。
  now += 0.030;
  if (units.length && line.charCount > 0) {
    // lastP 记录已经完成到的最大进度。
    var lastP = 0;
    for (var i = 0; i < units.length; i++) {
      // 当前逐字段。
      var w = units[i];
      // 当前字段开始和结束时间。
      var ws = w.t;
      var we = w.t + Math.max(0.08, w.d || 0.24);
      if (now < ws) return lastP;
      // 当前字段内部进度。
      var local = now >= we ? 1 : (now - ws) / Math.max(0.08, we - ws);
      local = Math.max(0, Math.min(1, local));
      // 把字段内部进度映射到整行字符进度。
      var p = (w.c0 + (w.c1 - w.c0) * local) / line.charCount;
      lastP = Math.max(lastP, p);
      if (now < we) return lastP;
    }
    return 1;
  }
  return null;
}

// 根据播放时间同步舞台歌词行和逐字进度。
function tickLyricsParticles() {
  if (!fx.particleLyrics) {
    // 关闭舞台歌词时清理当前和淡出歌词。
    if (stageLyrics.current || (stageLyrics.rows && stageLyrics.rows.length) || (stageLyrics.outgoing && stageLyrics.outgoing.length)) clearStageLyrics();
    return;
  }
  if (!audio || !lyricsLines.length) {
    // 没有音频或歌词时，把整条轨道转入淡出。
    if (stageLyrics.current || (stageLyrics.rows && stageLyrics.rows.length)) {
      retireStageLyricRows();
      stageLyrics.currentIdx = -1;
      stageLyrics.currentEntries = null;
    }
    return;
  }
  // 当前歌词显示时间，只影响歌词行和逐字进度，不影响真实播放进度。
  var t = effectiveLyricPlaybackTime();
  // 基于校正后的歌词时间搜索当前歌词行（参考 EchoMusic-Lyrics-WinIsland 时间驱动模式）。
  var newIdx = -1;
  for (var i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].t <= t + 0.05) newIdx = i; else break;
  }
  if (newIdx < 0) {
    // 播放时间还没到第一句时清空舞台歌词。
    clearStageLyrics();
    return;
  }
  if (newIdx !== stageLyrics.currentIdx) {
    // 切换到新歌词行，按当前行数与翻译模式重新生成整条轨道的行清单。
    stageLyrics.currentIdx = newIdx;
    showStageLine(buildStageLyricRowEntries(newIdx));
  }
  if (stageLyrics.current) {
    // 根据当前行逐字信息更新 shader 进度。
    var curLine = lyricsLines[newIdx] || { t:t };
    var nextLine = lyricsLines[newIdx + 1];
    var progress = getLyricLineProgress(curLine, nextLine, t);
    updateLyricMeshProgress(stageLyrics.current, progress);
  }
}

// 销毁舞台歌词系统的所有 Three.js 对象。
function disposeLyricsParticles() {
  // 先清理当前歌词和淡出歌词。
  clearStageLyrics();
  if (stageLyrics.starRiver) {
    // 星河粒子有独立几何和材质，需要释放。
    if (stageLyrics.starRiver.parent) stageLyrics.starRiver.parent.remove(stageLyrics.starRiver);
    if (stageLyrics.starRiver.geometry) stageLyrics.starRiver.geometry.dispose();
    if (stageLyrics.starRiver.material) stageLyrics.starRiver.material.dispose();
    stageLyrics.starRiver = null;
  }
  if (stageLyrics.group) {
    // 移除歌词总分组。
    scene.remove(stageLyrics.group);
    stageLyrics.group = null;
  }
}

