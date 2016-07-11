module.exports = {
  setOptions: function(argv) {
    this.allowDiscover = (argv.allowDiscover === true) ? true : false;
    this.doExplicitGC  = (argv.doExplicitGC  === true) ? true : false;
    this.dumpHeap      = (argv.dumpHeap      === true) ? true : false;
  }
};
