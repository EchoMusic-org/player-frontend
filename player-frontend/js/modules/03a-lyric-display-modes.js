'use strict';

// 舞台歌词的行数模式与双语翻译模式。
// 公式移植自 Mineradio public/js/modules/02-visual/08-lyrics-display-modes.js，
// 差异：本项目译文挂在 lyricsLines[i].translation 上，没有独立的 lyricsTranslationLines 全局，
// 且不移植上游的歌词动画风格（lyricMotionStyle / lyricGlitch*）。

// 歌词行数模式白名单。
var STAGE_LYRIC_DISPLAY_MODES = { single: 1, dual: 1, triple: 1, cinema: 1, custom: 1 };
// 双语翻译模式白名单。
var STAGE_LYRIC_TRANSLATION_MODES = { off: 1, current: 1, dual: 1, multi: 1 };

// 归一化歌词行数模式，非法值退回单行。
function normalizeLyricDisplayMode(mode) {
  mode = String(mode || 'single');
  return STAGE_LYRIC_DISPLAY_MODES[mode] ? mode : 'single';
}
// 归一化双语翻译模式，非法值退回关闭。
function normalizeLyricTranslationMode(mode) {
  mode = String(mode || 'off');
  return STAGE_LYRIC_TRANSLATION_MODES[mode] ? mode : 'off';
}
// custom 模式下的自定义行数。
function lyricCustomLineCountValue() {
  var raw = fx && fx.lyricCustomLineCount != null ? Number(fx.lyricCustomLineCount) : fxDefaults.lyricCustomLineCount;
  if (!isFinite(raw)) raw = fxDefaults.lyricCustomLineCount;
  return clampRange(Math.round(raw), 1, 10);
}
// 各模式对应的可见行数。
function lyricDisplayLineCountForMode(mode) {
  mode = normalizeLyricDisplayMode(mode);
  if (mode === 'single') return 1;
  if (mode === 'dual') return 2;
  if (mode === 'triple') return 3;
  if (mode === 'cinema') return 5;
  return lyricCustomLineCountValue();
}
// 各模式相对当前行的行偏移列表，0 表示当前行。
function lyricDisplayOffsetsForMode(mode) {
  mode = normalizeLyricDisplayMode(mode);
  if (mode === 'single') return [0];
  if (mode === 'dual') return [0, 1];
  var count = lyricDisplayLineCountForMode(mode);
  // 当前行固定落在正中槽位，行数为偶数时偏上。
  var activeSlot = Math.floor(count / 2);
  var offsets = [];
  for (var i = 0; i < count; i++) offsets.push(i - activeSlot);
  return offsets;
}

// 骷髅预设把歌词摆进骷髅嘴里，空间极窄，多行会溢出安全区。
function stageLyricSkullMouthActive() {
  return !!(typeof camera !== 'undefined' && camera && fx && fx.preset === SKULL_PRESET_INDEX &&
    typeof skullParticleGroup !== 'undefined' && skullParticleGroup && skullParticleGroup.visible);
}
// 当前实际生效的行偏移列表，骷髅嘴模式下强制收敛为单行。
function effectiveLyricDisplayOffsets() {
  if (stageLyricSkullMouthActive()) return [0];
  return lyricDisplayOffsetsForMode(fx && fx.lyricDisplayMode);
}

// 上下句相对当前句的清晰度。
function lyricContextOpacityValue() {
  return clampRange(fx && fx.lyricContextOpacity == null ? fxDefaults.lyricContextOpacity : Number(fx && fx.lyricContextOpacity), 0.25, 1);
}
// 上下句纵向间距倍率。
function lyricContextSpreadValue() {
  return clampRange(fx && fx.lyricContextSpread == null ? fxDefaults.lyricContextSpread : Number(fx && fx.lyricContextSpread), 0.60, 2.40);
}
// 译文行与主行的原始间距参数。
function lyricTranslationGapValue() {
  return clampRange(fx && fx.lyricTranslationGap == null ? fxDefaults.lyricTranslationGap : Number(fx && fx.lyricTranslationGap), 0.28, 2.20);
}
// 译文行字号倍率。
function lyricTranslationScaleValue() {
  return clampRange(fx && fx.lyricTranslationScale == null ? fxDefaults.lyricTranslationScale : Number(fx && fx.lyricTranslationScale), 0.46, 1.12);
}
// 当前句译文透明度。
function lyricTranslationOpacityValue() {
  return clampRange(fx && fx.lyricTranslationOpacity == null ? fxDefaults.lyricTranslationOpacity : Number(fx && fx.lyricTranslationOpacity), 0.20, 1);
}
// 多行歌词上下边缘渐隐强度。
function lyricEdgeFadeValue() {
  return clampRange(fx && fx.lyricEdgeFade == null ? fxDefaults.lyricEdgeFade : Number(fx && fx.lyricEdgeFade), 0, 1);
}

// 译文布局是否生效，关闭翻译时整套译文槽位都不占空间。
function lyricTranslationLayoutActive() {
  return normalizeLyricTranslationMode(fx && fx.lyricTranslationMode) !== 'off';
}
// 译文行在虚拟索引空间里与主行的实际间距。
function lyricTranslationVisualGapValue() {
  var gap = lyricTranslationGapValue();
  var scale = lyricTranslationScaleValue();
  return clampRange(0.98 + (gap - 0.28) * 0.36 + Math.max(0, scale - 0.66) * 0.12, 0.92, 2.20);
}

// 归一化单条译文文本。
function normalizeLyricTranslationText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}
// 读取指定歌词行的译文。
function lyricLineTranslationTextAt(index) {
  if (typeof lyricsLines === 'undefined' || !lyricsLines) return '';
  var n = Math.round(Number(index) || 0);
  if (n < 0 || n >= lyricsLines.length) return '';
  var line = lyricsLines[n];
  return line ? normalizeLyricTranslationText(line.translation) : '';
}
// 指定行在当前模式下是否需要译文槽位。
function lyricLineHasTranslationAt(index) {
  if (!lyricTranslationLayoutActive()) return false;
  var n = Math.max(0, Math.round(Number(index) || 0));
  return !!lyricLineTranslationTextAt(n);
}

// 带译文时主行之间需要留出的槽位步长。
function lyricPrimarySlotStepValue() {
  if (!lyricTranslationLayoutActive()) return 1;
  return clampRange(lyricTranslationVisualGapValue() + 0.82 + lyricTranslationScaleValue() * 0.14, 1.78, 2.88);
}
// 单行到下一行的槽位步长，没有译文的行占位更紧凑。
function lyricLineSlotStepValue(index) {
  if (!lyricTranslationLayoutActive()) return 1;
  var n = Math.round(Number(index) || 0);
  // 本行有译文，或下一行有译文需要往上让位时，都要按完整槽位留空。
  var needsTranslationSlot = lyricLineHasTranslationAt(n) || (n >= 0 && lyricLineHasTranslationAt(n + 1));
  return needsTranslationSlot ? lyricPrimarySlotStepValue() : clampRange(1.04 + (lyricContextSpreadValue() - 1) * 0.10, 0.96, 1.24);
}

// 主行虚拟索引的前缀和缓存，避免每帧从头累加。
var lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
// 缓存签名，任何影响槽位步长的输入变化都会让缓存失效。
function lyricPrimaryVirtualPrefixKey() {
  var lines = typeof lyricsLines !== 'undefined' && lyricsLines ? lyricsLines : null;
  var first = lines && lines[0];
  var last = lines && lines.length ? lines[lines.length - 1] : null;
  return [
    lyricTranslationLayoutActive() ? 1 : 0,
    Math.round(lyricTranslationGapValue() * 1000),
    Math.round(lyricTranslationScaleValue() * 1000),
    Math.round(lyricContextSpreadValue() * 1000),
    lines ? lines.length : 0,
    first ? normalizeLyricTranslationText(first.translation).slice(0, 12) : '',
    last ? normalizeLyricTranslationText(last.translation).slice(0, 12) : ''
  ].join('|');
}
// 主行行号到虚拟索引的映射，译文开启时行距不再是等距的 1。
function lyricPrimaryVirtualIndex(index) {
  var n = Math.round(Number(index) || 0);
  if (!isFinite(n) || n === 0) return 0;
  if (!lyricTranslationLayoutActive()) return n;
  // 负索引只在越界预览时出现，按等距槽位估算即可。
  if (n < 0) return n * lyricPrimarySlotStepValue();
  var key = lyricPrimaryVirtualPrefixKey();
  if (!lyricPrimaryVirtualPrefixCache || lyricPrimaryVirtualPrefixCache.key !== key) {
    lyricPrimaryVirtualPrefixCache = { key: key, values: [0] };
  }
  var values = lyricPrimaryVirtualPrefixCache.values;
  for (var i = values.length; i <= n; i++) values[i] = values[i - 1] + lyricLineSlotStepValue(i - 1);
  return values[n] || 0;
}
// 译文行虚拟索引，永远落在所属主行下方一个视觉间距处。
function lyricTranslationVirtualIndex(parentIndex) {
  return lyricPrimaryVirtualIndex(parentIndex) + lyricTranslationVisualGapValue();
}
