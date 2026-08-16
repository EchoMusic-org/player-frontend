'use strict';

// 舞台歌词的多行轨道。
// 架构移植自 Mineradio public/js/modules/02-visual/12-lyrics-row-layers.js 与
// 14-stage-lyrics-rendering.js 的 entry 构建部分，公式照搬，但不移植上游的纹理质量
// 预算管理器、预热缓存和驻留轨道增量构建，纹理压力改用固定分辨率分档解决。
//
// 与 03-stage-lyrics.js 的分工：
//   - 当前主行 mesh 仍挂在 stageLyrics.current 上，位置、缩放和透明度由 tickMesh 独占驱动，
//     星河、色板、相机锁定和卡拉 OK 进度都继续走原有路径。
//   - 本模块只负责上下文主行与译文行：构建、复用、淘汰，以及每帧相对当前主行做定位与淡入淡出。

// 上下文行与译文行的画布分辨率倍率。当前主行保持 1，其余行降档换显存和切行开销。
var STAGE_LYRIC_CONTEXT_RESOLUTION = 0.5;

// 译文行专用材质。只有 uColor 和 uOpacity，没有 uProgress，天然不参与卡拉 OK 逐字高亮。
// gl_FrontFacing 分支与主行 shader 是同一手法，保证歌词翻到背面时文字不镜像。
function makeLyricBackfaceReadableMaterial(opts) {
  opts = opts || {};
  var color = opts.color && opts.color.isColor ? opts.color.clone() : new THREE.Color(opts.color == null ? 0xffffff : opts.color);
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: opts.map || null },
      uColor: { value: color },
      uOpacity: { value: opts.opacity == null ? 0 : clampRange(Number(opts.opacity) || 0, 0, 1) }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D uMap;',
      'uniform vec3 uColor;',
      'uniform float uOpacity;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);',
      '  vec4 tex = texture2D(uMap, uv);',
      '  if (tex.a < 0.01) discard;',
      '  gl_FragColor = vec4(uColor, tex.a * uOpacity);',
      '}'
    ].join('\n'),
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide
  });
}

// 主行之间的世界空间行距。
function lyricTrackLineStepWorld(mask, worldH) {
  mask = mask || {};
  var h = Math.max(1, Number(mask.height) || 384);
  var lineHeight = Number(mask.lineHeight) || Number(mask.fontSize) || 128;
  var step = worldH * (lineHeight / h);
  step *= clampRange(1 + (lyricContextSpreadValue() - 1) * 0.32, 0.86, 1.45);
  if (lyricTranslationLayoutActive()) step *= 1.06;
  return clampRange(step, 0.22, 0.94);
}

// 译文行相对所属主行的世界空间步长。
function lyricTranslationLineStepWorld(mask, worldH) {
  mask = mask || {};
  var h = Math.max(1, Number(mask.height) || 384);
  var lineHeight = Number(mask.lineHeight) || Number(mask.fontSize) || 128;
  var step = worldH * (lineHeight / h);
  if (lyricTranslationLayoutActive()) step *= 1.04;
  return clampRange(step, 0.20, 0.78);
}

// 读取一行的整体透明度。主行 shader 和译文行背面材质都用 uOpacity。
function getStageLyricRowOpacity(data) {
  if (!data || !data.textMat || !data.textMat.uniforms || !data.textMat.uniforms.uOpacity) return 0;
  return Number(data.textMat.uniforms.uOpacity.value) || 0;
}
// 写入一行的整体透明度，同时带动描边层和辉光层。
function setStageLyricRowOpacity(data, value, glowScale) {
  if (!data) return;
  value = clampRange(Number(value) || 0, 0, 1);
  if (data.textMat && data.textMat.uniforms && data.textMat.uniforms.uOpacity) data.textMat.uniforms.uOpacity.value = value;
  // 描边层跟随文字，稍弱一些避免上下文行发灰。
  if (data.readabilityMat) data.readabilityMat.opacity = value * 0.48;
  // 辉光层只有当前句译文和上下文主行才有。
  if (data.glowMat) data.glowMat.opacity = value * clampRange(Number(glowScale) || 0, 0, 1);
}

// 生成当前应该显示的行清单。
// 主行来自行数模式的偏移表，译文行按翻译模式插入，规则与上游一致：
// current 只给当前句，dual 给当前句和下一句，multi 给所有可见句。
function buildStageLyricRowEntries(lineIndex) {
  var idx = Math.round(Number(lineIndex));
  if (!isFinite(idx) || idx < 0) return [];
  if (typeof lyricsLines === 'undefined' || !lyricsLines || !lyricsLines.length) return [];
  // 当前生效的主行偏移表，骷髅嘴模式下已被收敛为单行。
  var offsets = effectiveLyricDisplayOffsets();
  var mode = normalizeLyricTranslationMode(fx && fx.lyricTranslationMode);
  // 骷髅嘴空间只放得下一行，译文同样要让位。
  if (stageLyricSkullMouthActive()) mode = 'off';
  var contextOpacity = lyricContextOpacityValue();
  var translationScale = lyricTranslationScaleValue();
  var translationOpacity = lyricTranslationOpacityValue();
  // 偏移表的最大跨度，用于计算边缘渐隐。
  var spanMax = 1;
  for (var s = 0; s < offsets.length; s++) spanMax = Math.max(spanMax, Math.abs(Math.round(Number(offsets[s]) || 0)));
  var entries = [];
  for (var i = 0; i < offsets.length; i++) {
    var off = Math.round(Number(offsets[i]) || 0);
    var n = idx + off;
    if (n < 0 || n >= lyricsLines.length) continue;
    var line = lyricsLines[n];
    var text = String((line && line.text) || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    var isCurrent = off === 0;
    var absOff = Math.abs(off);
    // 主行虚拟索引，译文行也要用来定位，这里算一次存起来，避免每帧重复求前缀和。
    var primaryVirtual = lyricPrimaryVirtualIndex(n);
    // 主行：越远越暗越小。
    var primaryAlpha = isCurrent ? 1 : clampRange(contextOpacity * (1 - Math.max(0, absOff - 1) * 0.14), 0.16, 0.92);
    entries.push({
      key: 'p:' + n,
      lineIndex: n,
      parentIndex: n,
      parentVirtualIndex: primaryVirtual,
      text: text,
      isTranslation: false,
      isCurrent: isCurrent,
      offset: off,
      edgeSpan: spanMax > 0 ? absOff / spanMax : 0,
      virtualIndex: primaryVirtual,
      alpha: primaryAlpha,
      scale: isCurrent ? 1 : clampRange(0.92 - absOff * 0.025, 0.76, 0.98),
      // 当前主行走完整五层高清，上下文主行降档。
      variant: isCurrent ? 'full' : 'context',
      // 上下文行不配辉光层。运行时它的透明度只有 0.08×alpha≈0.04，几乎看不见，
      // 却要付出一整个大面积 AdditiveBlending 透明四边形的填充成本——
      // 集显的填充率扛不住多行同时叠加，这是核显卡顿、独显流畅的主因之一。
      glow: false,
      resolutionScale: isCurrent ? 1 : STAGE_LYRIC_CONTEXT_RESOLUTION
    });
    if (mode === 'off') continue;
    // 译文可见范围：这里只决定「是否生成」，实际淡出由每帧的 parentFade 接管。
    var shouldTranslate = mode === 'multi' || (mode === 'current' && isCurrent) || (mode === 'dual' && (off === 0 || off === 1));
    if (!shouldTranslate) continue;
    var translation = lyricLineTranslationTextAt(n);
    if (!translation) continue;
    entries.push({
      key: 't:' + n,
      lineIndex: n,
      parentIndex: n,
      parentVirtualIndex: primaryVirtual,
      text: translation,
      isTranslation: true,
      isCurrent: isCurrent,
      offset: off,
      edgeSpan: spanMax > 0 ? absOff / spanMax : 0,
      virtualIndex: primaryVirtual + lyricTranslationVisualGapValue(),
      // 当前句译文比设定值再亮一点，其余句按主行亮度打折，公式同上游。
      alpha: isCurrent ? clampRange(translationOpacity + 0.08, 0.48, 1) : clampRange(primaryAlpha * 0.62, 0.24, 0.60),
      scale: isCurrent ? clampRange(translationScale * 1.08, 0.70, 1.12) : clampRange(translationScale * 0.92, 0.50, 0.96),
      variant: 'translation',
      // 译文行不配独立辉光层：它随 isCurrent 变化会让签名在每次切句时翻转，
      // 白白重建两行；译文本身字号小、透明度低，有无辉光几乎看不出差别。
      glow: false,
      resolutionScale: STAGE_LYRIC_CONTEXT_RESOLUTION
    });
  }
  return entries;
}

// 影响文字贴图的排版签名。字距、行高、字重和字体族任何一项变化都必须重建贴图，
// 否则改字体设置时行会被当成没变而复用旧贴图。
function stageLyricRowFontSignature() {
  return [
    lyricFontWeightValue(),
    Math.round(clampRange(Number(fx && fx.lyricLetterSpacing) || 0, -0.04, 0.18) * 1000),
    Math.round(lyricLineHeightFactor() * 1000),
    normalizeBridgeLyricFontFamily(typeof bridgeLyricFontFamily === 'undefined' ? '' : bridgeLyricFontFamily)
  ].join(',');
}

// 行的构建签名。文本、图层档位、分辨率或排版变化时必须重建，仅位置和透明度变化则可以复用。
function stageLyricRowSignature(entry, fontSignature) {
  return [entry.key, entry.variant, entry.glow ? 1 : 0, entry.resolutionScale, fontSignature, entry.text].join('|');
}

// 淡出队列上限。多行模式下一次大跨度跳转可能同时淘汰十几行，超出部分直接释放，
// 避免拖动进度条时淡出队列堆积。
var STAGE_LYRIC_MAX_OUTGOING = 6;

// 把一行的 mesh 转入淡出队列，交给 tickMesh 的淡出分支收尾。
function retireStageLyricRowMesh(mesh) {
  if (!mesh) return;
  if (!mesh.userData) mesh.userData = {};
  mesh.userData.state = 'out';
  mesh.userData.age = 0;
  stageLyrics.outgoing.push(mesh);
  while (stageLyrics.outgoing.length > STAGE_LYRIC_MAX_OUTGOING) {
    queueLyricMeshDispose(stageLyrics.outgoing.shift());
  }
}

// 把整条轨道转入淡出，用于没有音频或没有歌词时。
function retireStageLyricRows() {
  var rows = stageLyrics.rows;
  for (var i = 0; rows && i < rows.length; i++) {
    if (rows[i] && rows[i].mesh) retireStageLyricRowMesh(rows[i].mesh);
  }
  stageLyrics.rows = [];
  stageLyrics.rowMap = null;
  stageLyrics.current = null;
  stageLyrics.targetLineIndex = -1;
}

// 释放整条轨道。
function clearStageLyricRows() {
  var rows = stageLyrics.rows;
  for (var i = 0; rows && i < rows.length; i++) {
    if (rows[i] && rows[i].mesh) queueLyricMeshDispose(rows[i].mesh);
  }
  stageLyrics.rows = [];
  stageLyrics.rowMap = null;
  stageLyrics.current = null;
  stageLyrics.scrollOffset = 0;
  stageLyrics.targetLineIndex = -1;
  stageLyrics.targetVirtualIndex = 0;
  stageLyrics.nextVirtualIndex = 1;
}

// 按新的行清单同步轨道：签名不变的行原地复用，变化的行重建，离开窗口的行淘汰。
function syncStageLyricRows(entries, redrawOnly) {
  if (!stageLyrics.group) return;
  entries = entries || [];
  // 旧行按 key 建索引，便于复用。
  var previous = stageLyrics.rowMap || {};
  var nextMap = {};
  var nextRows = [];
  // 本次仍然需要的 key 集合。
  var kept = {};
  // 排版签名整批共用，算一次即可。
  var fontSignature = stageLyricRowFontSignature();
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var signature = stageLyricRowSignature(entry, fontSignature);
    var old = previous[entry.key];
    var row;
    if (old && old.signature === signature && old.mesh) {
      // 文本和图层档位都没变，直接复用，位置与透明度保持连续。
      row = old;
    } else {
      // 需要新建。旧行如果存在，说明是同一行换了档位（例如从上下文行变成当前行），
      // 直接销毁并把位置继承给新 mesh，避免出现两份同样的文字。
      // 优先取用 03c 预热好的 mesh，取不到才现场同步构建。
      var mesh = takeStageLyricPrewarmMesh(signature) || buildLyricMesh(entry.text, {
        variant: entry.variant,
        glow: entry.glow,
        resolutionScale: entry.resolutionScale
      });
      if (old && old.mesh) {
        mesh.position.copy(old.mesh.position);
        mesh.scale.copy(old.mesh.scale);
        // 继承旧行的透明度和入场进度，切换档位时不会闪一下。
        var oldData = old.mesh.userData ? old.mesh.userData.lyric : null;
        if (oldData) setStageLyricRowOpacity(mesh.userData.lyric, getStageLyricRowOpacity(oldData), entry.isCurrent ? 0.10 : 0.06);
        mesh.userData.age = old.mesh.userData && isFinite(old.mesh.userData.age) ? old.mesh.userData.age : 0;
        queueLyricMeshDispose(old.mesh);
        old.mesh = null;
      }
      stageLyrics.group.add(mesh);
      row = { mesh: mesh, signature: signature };
      // 换档位时继承旧行的动画中间量，否则新行对象会从目标位置直接开始，切句时上一句会瞬移。
      if (old) {
        row.shownOffsetY = old.shownOffsetY;
        row.shownScale = old.shownScale;
      }
    }
    row.key = entry.key;
    row.lineIndex = entry.lineIndex;
    row.parentIndex = entry.parentIndex;
    row.isTranslation = entry.isTranslation;
    row.isCurrent = entry.isCurrent;
    row.offset = entry.offset;
    row.edgeSpan = entry.edgeSpan;
    row.virtualIndex = entry.virtualIndex;
    row.parentVirtualIndex = entry.parentVirtualIndex;
    row.targetAlpha = entry.alpha;
    row.targetScale = entry.scale;
    row.variant = entry.variant;
    kept[entry.key] = true;
    nextMap[entry.key] = row;
    nextRows.push(row);
  }
  // 不在新清单里的行离开窗口：样式重绘时直接销毁，正常切句时进淡出队列。
  for (var key in previous) {
    if (!Object.prototype.hasOwnProperty.call(previous, key) || kept[key]) continue;
    var gone = previous[key];
    if (!gone || !gone.mesh) continue;
    if (redrawOnly) queueLyricMeshDispose(gone.mesh);
    else retireStageLyricRowMesh(gone.mesh);
  }
  stageLyrics.rows = nextRows;
  stageLyrics.rowMap = nextMap;
  // 当前主行写回 stageLyrics.current，星河、色板和卡拉 OK 进度继续沿用原路径。
  var current = null;
  for (var r = 0; r < nextRows.length; r++) {
    if (!nextRows[r].isTranslation && nextRows[r].isCurrent) { current = nextRows[r].mesh; break; }
  }
  stageLyrics.current = current;
  stageLyrics.targetLineIndex = stageLyrics.currentIdx;
  // 目标滚动相位和下一句的虚拟索引在这里算好，每帧不必重复求前缀和。
  stageLyrics.targetVirtualIndex = lyricPrimaryVirtualIndex(Math.max(0, stageLyrics.currentIdx));
  stageLyrics.nextVirtualIndex = lyricPrimaryVirtualIndex(Math.max(0, stageLyrics.currentIdx) + 1);
}

// 每帧更新上下文行与译文行。当前主行由 tickMesh 独占，这里不碰它的位置、缩放和透明度。
function updateStageLyricRows(dt, ctx) {
  var rows = stageLyrics.rows;
  if (!rows || !rows.length) return;
  ctx = ctx || {};
  // 帧率补偿：低帧率下动效时长保持一致。
  var frameScale = clampRange((Number(dt) || 0) * 60, 0.25, 3);
  var ease = 1 - Math.pow(1 - 0.16, frameScale);
  var trackEase = 1 - Math.pow(1 - 0.20, frameScale);
  // 槽位切换的缓动，与 tickMesh 里当前行纵向漂浮的 0.075 对齐，保证上下句和当前句同速。
  var slotEase = 1 - Math.pow(1 - 0.075, frameScale);

  // 轨道滚动相位向当前行的虚拟索引插值。目标值在同步行清单时已算好。
  var targetLine = Math.max(0, Number(stageLyrics.currentIdx) || 0);
  var targetIndex = isFinite(Number(stageLyrics.targetVirtualIndex))
    ? Number(stageLyrics.targetVirtualIndex)
    : lyricPrimaryVirtualIndex(targetLine);
  if (!isFinite(stageLyrics.scrollOffset)) stageLyrics.scrollOffset = targetIndex;
  // 切歌或大跨度跳转时直接吸附，避免长距离滚动。
  if (Math.abs(targetIndex - stageLyrics.scrollOffset) > 6) stageLyrics.scrollOffset = targetIndex;
  else stageLyrics.scrollOffset += (targetIndex - stageLyrics.scrollOffset) * trackEase;
  var scrollOffset = stageLyrics.scrollOffset;

  // 以当前主行为整块锚点，上下文行跟着它一起漂浮和压暗。
  var anchor = stageLyrics.current;
  var anchorData = anchor && anchor.userData ? anchor.userData.lyric : null;
  var baseX = anchor ? anchor.position.x : 0;
  var baseY = anchor ? anchor.position.y : 0.20;
  var baseZ = anchor ? anchor.position.z : 1.46;
  var baseScale = anchor && anchor.scale && isFinite(anchor.scale.x) ? anchor.scale.x : 0.96;
  var worldH = anchorData && anchorData.worldH ? anchorData.worldH : 1.14;
  var mask = anchorData ? anchorData.mask : null;
  var lineStep = lyricTrackLineStepWorld(mask, worldH);
  var transStep = lyricTranslationLineStepWorld(mask, worldH);
  var gap = lyricTranslationVisualGapValue();
  // 当前主行的实际透明度，让歌单架详情压暗、歌词淡入淡出等全局状态传导到所有行。
  var anchorOpacity = anchorData ? clampRange(getStageLyricRowOpacity(anchorData), 0, 1) : 1;
  var mode = normalizeLyricTranslationMode(fx && fx.lyricTranslationMode);
  var translationOpacity = lyricTranslationOpacityValue();
  var edgeFade = lyricEdgeFadeValue();
  // 当前行自身在滚动相位里的偏移，需要从每一行里减掉，保证当前行始终居中。
  var anchorOffsetY = -(targetIndex - scrollOffset) * lineStep;
  // 下一句主行的虚拟索引，dual 模式判定用。
  var nextVirtual = isFinite(Number(stageLyrics.nextVirtualIndex))
    ? Number(stageLyrics.nextVirtualIndex)
    : lyricPrimaryVirtualIndex(targetLine + 1);

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || !row.mesh) continue;
    var mesh = row.mesh;
    // 当前主行完全交给 tickMesh。
    if (mesh === anchor) continue;
    var data = mesh.userData ? mesh.userData.lyric : null;
    if (!data) continue;

    var rowVirtual = isFinite(Number(row.virtualIndex)) ? Number(row.virtualIndex) : Number(row.lineIndex) || 0;
    // 主行虚拟索引在同步行清单时已经算好，这里不再重复求前缀和。
    var parentVirtual = isFinite(Number(row.parentVirtualIndex)) ? Number(row.parentVirtualIndex) : rowVirtual;
    var delta = rowVirtual - scrollOffset;
    var parentDelta = parentVirtual - scrollOffset;
    var parentAbs = Math.abs(parentDelta);

    // 纵向偏移：主行按行步长，译文行锚在所属主行下方一个译文步长处（公式同上游）。
    var offsetY = row.isTranslation
      ? (-parentDelta * lineStep - gap * transStep)
      : (-delta * lineStep);
    offsetY -= anchorOffsetY;

    // 目标透明度。
    var alpha;
    if (row.isTranslation) {
      // 译文按与所属主行的距离淡出。
      var parentFade = clampRange((0.82 - parentAbs) / 0.34, 0, 1);
      parentFade = parentFade * parentFade * (3 - 2 * parentFade);
      if (mode === 'dual') {
        // 双行模式只点亮当前句和下一句的译文，其余硬性关掉。
        var currentParent = parentAbs < 0.001;
        var nextParent = Math.abs(parentVirtual - nextVirtual) < 0.001;
        parentFade = currentParent ? 1 : (nextParent ? 0.56 : 0);
      }
      alpha = mode === 'multi'
        ? clampRange(row.targetAlpha * (1 - parentFade) + translationOpacity * parentFade, 0.08, Math.max(0.58, translationOpacity))
        : clampRange(translationOpacity * parentFade, 0, translationOpacity);
    } else {
      alpha = clampRange(row.targetAlpha * (1 - Math.max(0, Math.abs(delta) - 0.25) * 0.070), 0.16, 0.92);
    }
    // 上下边缘渐隐，让最外侧的行自然消失而不是被硬切。
    if (edgeFade > 0.001 && row.edgeSpan > 0) {
      alpha *= clampRange(1 - edgeFade * row.edgeSpan, 0.05, 1);
    }
    // 跟随当前主行的全局透明度，歌单架详情打开时整块一起压暗。
    alpha *= anchorOpacity;

    // 透明度平滑过渡，行进出窗口时不会闪现。
    var shown = getStageLyricRowOpacity(data);
    shown += (alpha - shown) * ease;
    setStageLyricRowOpacity(data, shown, row.isTranslation ? (row.isCurrent ? 0.12 : 0.04) : 0.08);

    // 位置与缩放。槽位切换要平滑过渡，否则切句时上一句会从中间瞬移到上方，
    // 而当前句是靠 tickMesh 的插值平滑上移的，两者会不同步。
    // 只平滑「相对当前行的槽位偏移」，锚点自身的漂浮直接跟随，避免整块滞后。
    if (!isFinite(Number(row.shownOffsetY))) row.shownOffsetY = offsetY;
    else row.shownOffsetY += (offsetY - row.shownOffsetY) * slotEase;
    var targetScale = Number(row.targetScale) || 1;
    if (!isFinite(Number(row.shownScale))) row.shownScale = targetScale;
    else row.shownScale += (targetScale - row.shownScale) * slotEase;
    var depth = Math.min(3, Math.abs(delta));
    mesh.position.set(baseX, baseY + row.shownOffsetY, baseZ - 0.020 - depth * 0.012);
    mesh.scale.setScalar(baseScale * row.shownScale);
    mesh.rotation.z = anchor ? anchor.rotation.z * 0.60 : 0;
    // 上下文行和译文行不参与逐字高亮，进度维持默认值。
    if (data.textMat && data.textMat.uniforms && data.textMat.uniforms.uProgress) {
      data.textMat.uniforms.uProgress.value = -1;
    }
  }
}
