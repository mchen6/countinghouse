var cp = require('child_process');
var fs = require('fs');
var respawn = require('respawn');

module.exports = {
  c9instance: null,

  monitor: null,

  startCloud9: function(workingDir, bindAddr, dbUrl, callback) {
    //assume c9 installed under $HOME/cloud9 folder
    //temporarily workaround c9 file save permission issue
    fs.writeFileSync(workingDir + '/.npmignore', '.settings\n.c9revisions/', 'utf-8');

    if (this.monitor != null) {
      this.monitor.stop(function() {
        // this.monitor.start();

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



    // if (this.c9instance != null) {
    //   //terminate all old descendants
    //   process.kill(-this.c9instance.pid);
    //   // this.c9instance.kill('SIGTERM');
    //   this.c9instance = null;
    // }

    // var cmd = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/cloud9/bin/cloud9.sh';
    // if (!fs.existsSync(cmd)) {
    //   return callback(new Error('c9 launcher not found'));
    // }

    // this.c9instance = cp.spawn(cmd, ['-w', workingDir, '-l', bindAddr, '-b', dbUrl], {detached: true});
    // //uncomment this if we want to take a look to c9's stdout inside our IDE env
    // // this.c9instance = cp.spawn(cmd, ['-w', workingDir, '-l', bindAddr, '-b', dbUrl], {detached: true, stdio: [null, process.stdout, process.stderr]});

    // this.c9instance.on('error', function(err) {
    //   this.c9instance = null;
    //   return callback(new Error('spawn c9 instance failed'));
    // }.bind(this));

    // return callback(null);
  }
}