var cp            = require('child_process');
var fs            = require('fs');
var respawn       = require('respawn');
var chokidar      = require('chokidar');
var LOG           = require('./logger');
var path          = require('path');
var isBinaryFile  = require('isbinaryfile').isBinaryFile;
var async         = require('async');

module.exports = {
  monitor:          null,
  nano:             null,
  apiDesignDB:      null,
  watcher:          null,
  watchedDir:       null,
  mm:               null,
  couchUpdateQueue: null,
  watchFSChange:    false,

  init: function(mm, dbUrl) {
    this.nano = require('nano')(dbUrl);
    this.apiDesignDB = this.nano.db.use('api-design');
    this.mm = mm;

    this.couchUpdateQueue = async.queue(function(task, cb) {
      if (this.watchFSChange === true) {
        this.apiDesignDB.atomic('api-design', 'updDevice', task.apiDesignID, {codeKey: task.codeKey, codeValue: task.codeValue}, function(e) {
          if (e) LOG.I('couchdb update fail on change: ' + e.message);
          this.mm.reloadModule(task.workingDir, function(errr) {
            if (errr) LOG.I('reload module fail on change: ' + errr.mesage);
            return cb();
          }.bind(this));
        }.bind(this));
      }
    }.bind(this), 1); // serialize couchdb update and reload module operations
  },

  startVSCode: function(workingDir, apiDesignID, callback) {
    var _this = this;

    //do not start vscode if apiDesignID is unknown because in this situation we are not under develop mode, this happens during in module upload and verify process
    if (apiDesignID == null) return callback(null);

    try {
      fs.accessSync(workingDir, fs.W_OK);
    } catch (e) {
      return callback(e);
    }

    if (this.monitor != null) {
      this.monitor.stop(function() {
        this.monitor = respawn(['/usr/bin/code-server', '--disable-telemetry', '--user-data-dir', '/root/cdif-workspace/.UserData', '--extensions-dir', '/root/cdif-workspace/.ExtensionData', workingDir], {
          name: 'vscodemonitor',      // set monitor name
          cwd: workingDir,
          maxRestarts: -1,        // how many restarts are allowed within 60s or -1 for infinite restarts
          sleep:1000,             // time to sleep between restarts,
          fork: false             // fork instead of spawn
        });

        this.monitor.on('crash', function() {
          return callback(new Error('spawn vscode instance failed'));
        });

        this.monitor.start(); // spawn and watch
        this.watchAndSaveFSChange(apiDesignID, workingDir);
        return callback(null);
      }.bind(this));
    } else {
      this.monitor = respawn(['/usr/bin/code-server', '--disable-telemetry', '--user-data-dir', '/root/cdif-workspace/.UserData', '--extensions-dir', '/root/cdif-workspace/.ExtensionData', workingDir], {
        name: 'vscodemonitor',      // set monitor name
        cwd: workingDir,
        maxRestarts: -1,        // how many restarts are allowed within 60s or -1 for infinite restarts
        sleep:1000,             // time to sleep between restarts,
        fork: false             // fork instead of spawn
      });

      this.monitor.on('crash', function() {
        return callback(new Error('spawn vscode instance failed'));
      });

      this.monitor.start(); // spawn and watch
      this.watchAndSaveFSChange(apiDesignID, workingDir);
      return callback(null);
    }
  },

  unwatchFSChange: function() {
    this.watchFSChange = false;
    if (this.watchedDir != null) this.watcher.unwatch(this.watchedDir);
  },

  watchAndSaveFSChange: function(apiDesignID, workingDir) {
    var watchOpts = {
      persistent: true,
      ignoreInitial: true,
      cwd: workingDir,
      usePolling: false,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      }
    };

    this.watcher = chokidar.watch(workingDir, watchOpts);
    this.watchedDir = workingDir;
    this.installWatcherEventHandler(apiDesignID, this.watcher, workingDir);
    this.watchFSChange = true;
  },

  installWatcherEventHandler: function(apiDesignID, watcher, workingDir) {
    var _this = this;

    watcher.on('add', function(codePath) {
      var slashedPath = codePath;
      if (codePath.includes('/')) {
        //indicates this file is in a subfolder, or else we don't append leading slash to it
        slashedPath = '/' + codePath;
      }

      var absolutePath = path.join(workingDir, codePath);

      //content here should always be text based even for binary files
      _this.readFileContentFromPath(absolutePath, function(err, data) {
        if (err) return LOG.I('read file content error: ' + err.message);
        if (data != null) {
          _this.couchUpdateQueue.push({codeKey: slashedPath, codeValue: data, workingDir: workingDir, apiDesignID: apiDesignID});
        }
      });
    });

    watcher.on('addDir', function(codePath) {
      //no need to process this event
    });

    watcher.on('change', function(codePath) {
      var slashedPath = codePath;
      if (codePath.includes('/')) {
        slashedPath = '/' + codePath;
      }

      var absolutePath = path.join(workingDir, codePath);

      //content here should always be text based even for binary files
      _this.readFileContentFromPath(absolutePath, function(err, data) {
        if (err) return LOG.I('read file content error: ' + err.message);
        if (data != null) {
          _this.couchUpdateQueue.push({codeKey: slashedPath, codeValue: data, workingDir: workingDir, apiDesignID: apiDesignID});
        }
      });
    });

    watcher.on('unlink', function(codePath) {
      var slashedPath = codePath;
      if (codePath.includes('/')) {
        //indicates this file is in a subfolder, or else we don't append leading slash to it
        slashedPath = '/' + codePath;
      }
      _this.couchUpdateQueue.push({codeKey: slashedPath, codeValue: null, workingDir: workingDir, apiDesignID: apiDesignID});
    });

    watcher.on('unlinkDir', function(codePath) {
      //no need to process this event
    });
  },

  readFileContentFromPath: function(filePath, callback) {
    isBinaryFile(filePath).then(function(res) {
      if (res) {
        fs.readFile(filePath, function(err, bufferContent) {
          if (err) return callback(err, null);
          return callback(null, 'BINARYCONTENT:' + bufferContent.toString('base64'));
        });
      } else {
        return fs.readFile(filePath, 'utf-8', function(err, content) {
          return callback(err, content);
        });
      }
    }).catch(function(err) {
      return callback(err);
    });
  }
}
