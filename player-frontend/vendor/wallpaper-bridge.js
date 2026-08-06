'use strict';

(function() {
  var CHILD_SOURCE = 'echo-player-frontend-child';
  var PARENT_SOURCE = 'echo-player-frontend-parent';
  var frame = null;
  var childReady = false;
  var pollingStarted = false;
  var pollTimers = [];
  var pollingLocks = {};
  var lastLyricsKey = '';

  function fetchJson(path, options) {
    return fetch(path, Object.assign({
      cache: 'no-store'
    }, options || {})).then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function postJson(path, payload) {
    return fetchJson(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload || {})
    });
  }

  function postToFrame(payload) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(Object.assign({}, payload, {
      source: PARENT_SOURCE
    }), '*');
  }

  function postPayload(type, payload) {
    postToFrame({
      type: type,
      payload: payload || {}
    });
  }

  function applyBootstrap(result) {
    if (!result || !result.ok) return;
    postPayload('echo-player-frontend:init', result.init || {});
    if (result.snapshot) postPayload('echo-player-frontend:snapshot', result.snapshot);
    if (result.lyrics) {
      lastLyricsKey = String(result.lyrics.key || '');
      postPayload('echo-player-frontend:lyrics', result.lyrics);
    }
    if (result.position) postPayload('echo-player-frontend:position', result.position);
    if (result.spectrum) postPayload('echo-player-frontend:spectrum', result.spectrum);
  }

  function refreshSnapshot() {
    return fetchJson('/api/snapshot').then(function(result) {
      if (result && result.ok) postPayload('echo-player-frontend:snapshot', result.payload);
    });
  }

  function refreshLyrics(force) {
    return fetchJson('/api/lyrics').then(function(result) {
      if (!result || !result.ok || !result.payload) return;
      var key = String(result.payload.key || '');
      if (!force && key && key === lastLyricsKey) return;
      lastLyricsKey = key;
      postPayload('echo-player-frontend:lyrics', result.payload);
    });
  }

  function refreshPosition(cause) {
    return fetchJson('/api/position').then(function(result) {
      if (!result || !result.ok || !result.payload) return;
      result.payload.cause = cause || result.payload.cause || 'tick';
      postPayload('echo-player-frontend:position', result.payload);
    });
  }

  function refreshAppearance() {
    return fetchJson('/api/appearance').then(function(result) {
      if (result && result.ok) postPayload('echo-player-frontend:appearance', result.payload);
    });
  }

  function refreshSpectrum() {
    return fetchJson('/api/spectrum').then(function(result) {
      if (result && result.ok) postPayload('echo-player-frontend:spectrum', result.payload);
    });
  }

  function refreshAll() {
    refreshSnapshot().catch(function(error) { console.warn('[壁纸桥接] 快照刷新失败', error); });
    refreshLyrics(true).catch(function(error) { console.warn('[壁纸桥接] 歌词刷新失败', error); });
    refreshAppearance().catch(function(error) { console.warn('[壁纸桥接] 外观刷新失败', error); });
    refreshPosition('init').catch(function(error) { console.warn('[壁纸桥接] 进度刷新失败', error); });
  }

  function schedulePoll(name, interval, task) {
    function run() {
      if (!childReady || pollingLocks[name]) return;
      pollingLocks[name] = true;
      Promise.resolve()
        .then(task)
        .catch(function(error) {
          console.warn('[壁纸桥接] 轮询失败: ' + name, error);
        })
        .then(function() {
          pollingLocks[name] = false;
        });
    }
    pollTimers.push(setInterval(run, interval));
    run();
  }

  function stopPolling() {
    pollTimers.forEach(function(timer) { clearInterval(timer); });
    pollTimers = [];
    pollingLocks = {};
    pollingStarted = false;
  }

  function startPolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    schedulePoll('snapshot', 5000, refreshSnapshot);
    schedulePoll('lyrics', 5000, function() { return refreshLyrics(false); });
    schedulePoll('position', 1000, function() { return refreshPosition('tick'); });
    schedulePoll('appearance', 10000, refreshAppearance);
    schedulePoll('spectrum', 220, refreshSpectrum);
  }

  function completeRequest(requestId, payload) {
    if (!requestId) return;
    postToFrame(Object.assign({}, payload || {}, {
      requestId: requestId
    }));
  }

  function handleStorageRequest(data) {
    postJson('/api/storage', {
      action: data.action,
      key: data.key,
      value: data.value
    }).then(function(result) {
      completeRequest(data.requestId, Object.assign({
        type: 'echo-player-frontend:storage-result'
      }, result || {}));
    }).catch(function(error) {
      completeRequest(data.requestId, {
        type: 'echo-player-frontend:storage-result',
        ok: false,
        error: error && error.message ? error.message : '存储请求失败'
      });
    });
  }

  function handleHostRequest(data) {
    var action = String(data && data.action || '');
    postJson('/api/host-action', {
      action: data.action,
      payload: data.payload || {}
    }).then(function(result) {
      completeRequest(data.requestId, {
        type: 'echo-player-frontend:host-request-result',
        ok: !!(result && result.ok !== false),
        result: result || { ok: false, error: '宿主动作返回为空' }
      });
      if (action === 'favorite' || action === 'unfavorite' || action === 'toggle-favorite' || action === 'playlist-add' || action === 'queue-add') {
        refreshSnapshot().catch(function() {});
      }
    }).catch(function(error) {
      completeRequest(data.requestId, {
        type: 'echo-player-frontend:host-request-result',
        ok: false,
        result: {
          ok: false,
          error: error && error.message ? error.message : '宿主动作失败'
        }
      });
    });
  }

  function handleBackgroundResolveRequest(data) {
    postJson('/api/background-resolve', {
      media: data.media || {}
    }).then(function(result) {
      completeRequest(data.requestId, {
        type: 'echo-player-frontend:background-resolve-result',
        ok: !!(result && result.ok),
        url: result && result.url,
        error: result && result.error
      });
    }).catch(function(error) {
      completeRequest(data.requestId, {
        type: 'echo-player-frontend:background-resolve-result',
        ok: false,
        error: error && error.message ? error.message : '背景媒体解析失败'
      });
    });
  }

  function handleBackgroundSelectRequest(data) {
    completeRequest(data.requestId, {
      type: 'echo-player-frontend:background-select-result',
      ok: false,
      canceled: true,
      error: '壁纸网页不支持打开主程序文件选择器'
    });
  }

  function isLockedCommand(data) {
    var command = String(data && data.command || '');
    return command === 'close' || command === 'mini-player' || command === 'window-control';
  }

  function handleCommand(data) {
    if (isLockedCommand(data)) {
      refreshPosition('locked').catch(function() {});
      return;
    }
    postJson('/api/command', data || {}).then(function() {
      refreshSnapshot().catch(function() {});
      refreshPosition('command').catch(function() {});
    }).catch(function(error) {
      console.warn('[壁纸桥接] 命令执行失败', error);
      refreshSnapshot().catch(function() {});
      refreshPosition('command').catch(function() {});
    });
  }

  function handleMessage(event) {
    var data = event && event.data;
    if (!data || data.source !== CHILD_SOURCE) return;
    if (data.type === 'echo-player-frontend:ready') {
      childReady = true;
      fetchJson('/api/bootstrap').then(function(result) {
        applyBootstrap(result);
        startPolling();
      }).catch(function(error) {
        console.warn('[壁纸桥接] 初始化失败', error);
      });
    } else if (data.type === 'echo-player-frontend:request-snapshot') {
      refreshAll();
    } else if (data.type === 'echo-player-frontend:command') {
      handleCommand(data);
    } else if (data.type === 'echo-player-frontend:storage') {
      handleStorageRequest(data);
    } else if (data.type === 'echo-player-frontend:host-request') {
      handleHostRequest(data);
    } else if (data.type === 'echo-player-frontend:background-resolve') {
      handleBackgroundResolveRequest(data);
    } else if (data.type === 'echo-player-frontend:background-select') {
      handleBackgroundSelectRequest(data);
    }
  }

  function start(src) {
    frame = document.getElementById('epf-wallpaper-frame');
    if (!frame) throw new Error('缺少壁纸 iframe');
    window.addEventListener('message', handleMessage);
    frame.src = src;
  }

  window.EchoPlayerFrontendWallpaperBridge = {
    start: start
  };
})();
