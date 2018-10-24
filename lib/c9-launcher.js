var cp = require('child_process');
var fs = require('fs');

module.exports = {
  c9instance: null,

  startCloud9: function(workingDir, bindAddr, dbUrl, callback) {
    //assume c9 installed under $HOME/cloud9 folder
    if (this.c9instance != null) {
      //terminate all old descendants
      process.kill(-this.c9instance.pid);
      // this.c9instance.kill('SIGTERM');
      this.c9instance = null;
    }

    var cmd = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/cloud9/bin/cloud9.sh';
    if (!fs.existsSync(cmd)) {
      return callback(new Error('c9 launcher not found'));
    }

    this.c9instance = cp.spawn(cmd, ['-w', workingDir, '-l', bindAddr, '-b', dbUrl], {detached: true});
    //uncomment this if we want to take a look to c9's stdout
    // this.c9instance = cp.spawn(cmd, ['-w', workingDir, '-l', bindAddr, '-b', dbUrl], {detached: true, stdio: [null, process.stdout, process.stderr]});

    this.c9instance.on('error', function(err) {
      this.c9instance = null;
      return callback(new Error('spawn c9 instance failed'));
    }.bind(this));

    return callback(null);
  }
}