// `goodbye` is not in api.json -- the classic typo shape.
module.exports = {
  greetService: {
    hello:   (args, callback) => callback(null, {output: {text: 'hi'}}),
    goodbye: (args, callback) => callback(null, {output: {text: 'bye'}})
  }
};
