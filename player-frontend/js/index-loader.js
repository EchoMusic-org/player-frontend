'use strict';

(function loadMineradioIndexModules() {
  var moduleCacheBust = String(Date.now());
  var modulePaths = [
    // 行数与翻译模式的常量表必须先于 00-core-state.js 求值：
    // 后者在模块体里就会执行 var fx = Object.assign({}, fxDefaults, readSavedLyricLayout())，
    // 而 readSavedLyricLayout 会调用 normalizeLyricDisplayMode 读取这里的白名单。
    'js/modules/03a-lyric-display-modes.js',
    'js/modules/00-core-state.js',
    'js/modules/01-scene-camera-input.js',
    'js/modules/02-particle-systems.js',
    'js/modules/03-stage-lyrics.js',
    'js/modules/03b-lyric-row-track.js',
    'js/modules/03c-lyric-prewarm.js',
    'js/modules/04-visual-analysis-beat.js',
    'js/modules/05-playlist-shelf.js',
    'js/modules/06-api-search.js',
    'js/modules/07-audio-queue-lyrics.js',
    'js/modules/08-panels-files-controls.js',
    'js/modules/09-account-ui.js',
    'js/modules/10-device-bootstrap.js',
    'js/modules/11-main-loop-bridge.js',
  ];

  function readModule(filePath) {
    var request = new XMLHttpRequest();
    request.open('GET', filePath + (filePath.indexOf('?') >= 0 ? '&' : '?') + 'v=' + moduleCacheBust, false);
    request.send(null);
    if ((request.status < 200 || request.status >= 300) && request.status !== 0) {
      throw new Error('加载 Mineradio 模块失败: ' + filePath + ' (' + request.status + ')');
    }
    return request.responseText;
  }

  var script = document.createElement('script');
  script.text = modulePaths.map(readModule).join('\n') + '\n//# sourceURL=mineradio-index-modules.js\n';
  document.currentScript.parentNode.insertBefore(script, document.currentScript.nextSibling);
})();
