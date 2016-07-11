module.exports = {
  setOptions: function(argv) {
    this.allowDiscover = (argv.allowDiscover === true) ? true : false;
    this.heapDump      = (argv.heapDump      === true) ? true : false;
  }
};
