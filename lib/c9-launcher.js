var cp = require('child_process');
var fs = require('fs');
var respawn = require('respawn');

module.exports = {
  c9instance:  null,

  monitor:     null,
  nano:        null,
  apiDesignDB: null,

  startCloud9: function(workingDir, bindAddr, dbUrl, apiDesignID, callback) {
    if (this.nano == null)        this.nano = require('nano')(dbUrl);
    if (this.apiDesignDB == null) this.apiDesignDB = this.nano.db.use('api-design');

    this.apiDesignID  = apiDesignID;

    //assume c9 installed under $HOME/pylon folder
    //temporarily workaround c9 file save permission issue
    fs.writeFileSync(workingDir + '/.npmignore', '.settings\n.c9revisions/', 'utf8');

    //load .settings from api-design DB to working dir, then start monitor it after c9 is launched
    try {
      fs.accessSync(workingDir, fs.W_OK);
    } catch (e) {
      return callback(e);
    }



    this.apiDesignDB.get(this.apiDesignID, function(err, doc) {
      var settingsFile = workingDir + '/.settings';

      if (err == null) {
        if (doc.preference != null) {
          fs.writeFileSync(settingsFile, doc.preference, 'utf8');
          this.watchAndSavePreferenceChange(workingDir);
        }
      }

      if (this.monitor != null) {
        this.monitor.stop(function() {
          this.monitor = respawn(['./pylon.sh', '-w', workingDir, '-l', bindAddr, '-b', dbUrl], {
            name: 'c9monitor',      // set monitor name
            cwd: process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/pylon/bin/',
            maxRestarts: -1,        // how many restarts are allowed within 60s or -1 for infinite restarts
            sleep:1000,             // time to sleep between restarts,
            fork: false             // fork instead of spawn
          });

          this.monitor.on('crash', function() {
            return callback(new Error('spawn c9 instance failed'));
          });

          this.monitor.start(); // spawn and watch
          return callback(null);
        }.bind(this));
      } else {
        this.monitor = respawn(['./pylon.sh', '-w', workingDir, '-l', bindAddr, '-b', dbUrl], {
          name: 'c9monitor',      // set monitor name
          cwd: process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/pylon/bin/',
          maxRestarts: -1,        // how many restarts are allowed within 60s or -1 for infinite restarts
          sleep:1000,             // time to sleep between restarts,
          fork: false             // fork instead of spawn
        });

        this.monitor.on('crash', function() {
          return callback(new Error('spawn c9 instance failed'));
        });

        this.monitor.start(); // spawn and watch
        return callback(null);
      }
    }.bind(this));
  },


  watchAndSavePreferenceChange: function(workingDir) {
    fs.watch(workingDir, function(eventType, fileName) {
      //c9 store settings file to a temp file and rename it to .settings on every change
      //so we monitor rename event for .settings rather than change event for .settings
      if (eventType === 'rename' && fileName === '.settings') {
        var preference = fs.readFileSync(workingDir + '/.settings', 'utf8');

        //no need to check error
        this.apiDesignDB.atomic('api-design', 'updDevice', this.apiDesignID, {preference: preference}, function(err) {
          //display this in console window
          if (err) console.error('preference save error: ' + err);
        });
      }
    }.bind(this));
  }
}