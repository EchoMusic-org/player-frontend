'use strict';

// 舞台歌词的预热缓存。
// 歌词行的到来时间是已知的，所以可以在当前行播放期间的空闲时段提前把下一行的 mesh 建好，
// 切行时直接取用，把 buildLyricMesh 那几十毫秒的 canvas 绘制挪出切行那一帧。
//
// 架构参考上游 Mineradio public/js/modules/02-visual/14-stage-lyrics-rendering.js 的
// stageLyricSingleLinePrewarm（容量 10、FIFO、预热后 6 行、分槽阶梯延迟），
// 这里简化为单队列 + 单缓存：本项目一次切行最多只需要 3 份 mesh，不需要分槽错开。
//
// 与 03b-lyric-row-track.js 的分工：
//   - 缓存键直接复用 stageLyricRowSignature，它已经包含 text/variant/glow/resolutionScale/
//     排版签名，样式一变签名就变，预热结果自然失效，不需要另造一套失效规则。
//   - syncStageLyricRows 在真正调 buildLyricMesh 之前先来这里取，取不到才走原同步路径。

// 预热缓存。items 按签名索引已建好但尚未挂进场景的 mesh，order 记录插入顺序用于 FIFO 淘汰。
var stageLyricPrewarmCache = { items: {}, order: [], max: 6 };
// 待构建队列，元素为 { signature, entry }。
var stageLyricPrewarmQueue = [];
// requestIdleCallback 句柄。
var stageLyricPrewarmIdle = 0;
// setTimeout 句柄，用于没有 requestIdleCallback 时的回退和推迟重排。
var stageLyricPrewarmTimer = 0;
// 上次补充预热对应的行号，保证同一行只补一次，不会每帧重复遍历排队。
var stageLyricPrewarmToppedUpIdx = -1;

// 是否有待处理的用户输入。有的话预热让路，避免和交互抢主线程。
function stageLyricPrewarmInputPending() {
  return !!(typeof navigator !== 'undefined' && navigator.scheduling &&
    typeof navigator.scheduling.isInputPending === 'function' && navigator.scheduling.isInputPending());
}

// 淘汰超出容量的最旧条目。
function trimStageLyricPrewarmCache() {
  while (stageLyricPrewarmCache.order.length > stageLyricPrewarmCache.max) {
    var oldest = stageLyricPrewarmCache.order.shift();
    var stale = stageLyricPrewarmCache.items[oldest];
    delete stageLyricPrewarmCache.items[oldest];
    if (stale) queueLyricMeshDispose(stale);
  }
}

// 存入一份预热好的 mesh。
function putStageLyricPrewarmMesh(signature, mesh) {
  if (!signature || !mesh) return;
  // 同签名已有缓存时保留旧的，新的直接释放，避免重复占显存。
  if (stageLyricPrewarmCache.items[signature]) { queueLyricMeshDispose(mesh); return; }
  stageLyricPrewarmCache.items[signature] = mesh;
  stageLyricPrewarmCache.order.push(signature);
  trimStageLyricPrewarmCache();
}

// 取用一份预热好的 mesh，取走后从缓存移除。取不到返回 null。
function takeStageLyricPrewarmMesh(signature) {
  if (!signature) return null;
  var mesh = stageLyricPrewarmCache.items[signature];
  if (!mesh) return null;
  delete stageLyricPrewarmCache.items[signature];
  var at = stageLyricPrewarmCache.order.indexOf(signature);
  if (at >= 0) stageLyricPrewarmCache.order.splice(at, 1);
  // 预热期间 group 是隐藏的，取用时恢复；三个子层仍由上传预算逐帧放行。
  mesh.visible = true;
  return mesh;
}

// 色板变化时刷新预热缓存里的 mesh。它们还没挂进场景，setStageLyricPalette 的
// 常规遍历覆盖不到；而色板只影响材质 uniform，刷一遍就能继续用，不必整批重建。
function applyStageLyricPaletteToPrewarm() {
  for (var i = 0; i < stageLyricPrewarmCache.order.length; i++) {
    var mesh = stageLyricPrewarmCache.items[stageLyricPrewarmCache.order[i]];
    if (mesh) applyLyricPaletteToMesh(mesh);
  }
}

// 清空预热缓存与队列。样式、色板、歌词或播放内容变化时必须调用，
// 否则会拿旧样式的 mesh 顶上去。
function clearStageLyricPrewarm() {
  // 已经是空的就直接返回。前奏期间（newIdx < 0）clearStageLyrics 是每帧调用的，
  // 没有这个早退就会每帧白白重建两个对象。
  if (!stageLyricPrewarmCache.order.length && !stageLyricPrewarmQueue.length &&
      !stageLyricPrewarmIdle && !stageLyricPrewarmTimer && stageLyricPrewarmToppedUpIdx < 0) return;
  for (var i = 0; i < stageLyricPrewarmCache.order.length; i++) {
    var mesh = stageLyricPrewarmCache.items[stageLyricPrewarmCache.order[i]];
    if (mesh) queueLyricMeshDispose(mesh);
  }
  stageLyricPrewarmCache.items = {};
  stageLyricPrewarmCache.order = [];
  stageLyricPrewarmQueue = [];
  stageLyricPrewarmToppedUpIdx = -1;
  if (stageLyricPrewarmIdle && typeof cancelIdleCallback === 'function') cancelIdleCallback(stageLyricPrewarmIdle);
  stageLyricPrewarmIdle = 0;
  if (stageLyricPrewarmTimer) clearTimeout(stageLyricPrewarmTimer);
  stageLyricPrewarmTimer = 0;
}

// 构建一份预热 mesh。
function buildStageLyricPrewarmMesh(job) {
  if (!job || !job.entry) return;
  // 排队期间样式可能已经变了，签名对不上说明这份预热已经没用，直接丢弃。
  var signature = stageLyricRowSignature(job.entry, stageLyricRowFontSignature());
  if (signature !== job.signature) return;
  if (stageLyricPrewarmCache.items[signature]) return;
  var mesh = buildLyricMesh(job.entry.text, {
    variant: job.entry.variant,
    glow: job.entry.glow,
    resolutionScale: job.entry.resolutionScale
  });
  if (!mesh) return;
  // 预热出来的 mesh 不挂进场景，隐藏待命。
  mesh.visible = false;
  putStageLyricPrewarmMesh(signature, mesh);
}

// 调度预热构建。每次回调只建一份，建完再排下一次，保证单次占用主线程的时间可控。
function scheduleStageLyricPrewarm(delay) {
  if (stageLyricPrewarmIdle || stageLyricPrewarmTimer) return;
  if (!stageLyricPrewarmQueue.length) return;
  if (delay > 0) {
    stageLyricPrewarmTimer = setTimeout(function () {
      stageLyricPrewarmTimer = 0;
      scheduleStageLyricPrewarm(0);
    }, delay);
    return;
  }
  var run = function (deadline) {
    stageLyricPrewarmIdle = 0;
    if (!stageLyricPrewarmQueue.length) return;
    // 用户正在操作时推迟，别和交互抢帧。
    if (stageLyricPrewarmInputPending()) { scheduleStageLyricPrewarm(72); return; }
    // 本次空闲不够建一行就等下一次，避免刚好卡在帧尾把这一帧撑爆。
    if (deadline && !deadline.didTimeout && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 6) {
      scheduleStageLyricPrewarm(24);
      return;
    }
    var job = stageLyricPrewarmQueue.shift();
    if (job) buildStageLyricPrewarmMesh(job);
    scheduleStageLyricPrewarm(0);
  };
  if (typeof requestIdleCallback === 'function') {
    stageLyricPrewarmIdle = requestIdleCallback(run, { timeout: 180 });
  } else {
    // 没有 requestIdleCallback 时退回定时器，语义上按「已超时」处理，直接建。
    stageLyricPrewarmTimer = setTimeout(function () {
      stageLyricPrewarmTimer = 0;
      run({ didTimeout: true, timeRemaining: function () { return 8; } });
    }, 18);
  }
}

// 某个签名是否已经在轨道上live。已经在用的行不需要预热。
function stageLyricPrewarmSignatureLive(signature) {
  var map = stageLyrics.rowMap;
  if (!map) return false;
  for (var key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    if (map[key] && map[key].signature === signature) return true;
  }
  return false;
}

// 某个签名是否已经在待构建队列里。
function stageLyricPrewarmQueued(signature) {
  for (var i = 0; i < stageLyricPrewarmQueue.length; i++) {
    if (stageLyricPrewarmQueue[i] && stageLyricPrewarmQueue[i].signature === signature) return true;
  }
  return false;
}

// 对外入口：按当前行号推算接下来需要哪些 mesh，把还没有的排进预热队列。
// 调用点在切行之后，以及当前行播放过半时（后者用于补上第一次没排完的部分）。
function requestStageLyricPrewarm() {
  if (!fx || !fx.particleLyrics) return;
  if (typeof lyricsLines === 'undefined' || !lyricsLines || !lyricsLines.length) return;
  var idx = Math.round(Number(stageLyrics.currentIdx));
  if (!isFinite(idx) || idx < 0) return;
  // 单行模式只需要下一行；多行模式切行时窗口两端都会变，多看一行才够。
  var lookahead = effectiveLyricDisplayOffsets().length > 1 ? 2 : 1;
  var fontSignature = stageLyricRowFontSignature();
  for (var step = 1; step <= lookahead; step++) {
    var next = idx + step;
    if (next >= lyricsLines.length) break;
    var entries = buildStageLyricRowEntries(next);
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var signature = stageLyricRowSignature(entry, fontSignature);
      // 已经在轨道上、已经缓存、已经排队的都不必再建。
      if (stageLyricPrewarmSignatureLive(signature)) continue;
      if (stageLyricPrewarmCache.items[signature]) continue;
      if (stageLyricPrewarmQueued(signature)) continue;
      stageLyricPrewarmQueue.push({ signature: signature, entry: entry });
    }
  }
  scheduleStageLyricPrewarm(0);
}

// 当前行播放过半时补一次预热，按行号去重，同一行只会真正执行一次。
function topUpStageLyricPrewarm() {
  var idx = Math.round(Number(stageLyrics.currentIdx));
  if (!isFinite(idx) || stageLyricPrewarmToppedUpIdx === idx) return;
  stageLyricPrewarmToppedUpIdx = idx;
  requestStageLyricPrewarm();
}
