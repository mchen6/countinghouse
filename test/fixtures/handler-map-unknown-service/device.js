// api.json has greetService, not greetingService.
module.exports = {
  greetingService: {
    hello: (args, callback) => callback(null, {output: {text: 'hi'}})
  }
};
