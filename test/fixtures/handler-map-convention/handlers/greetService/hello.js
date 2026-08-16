// One file per action: handlers/<serviceShortName>/<actionName>.js
module.exports = (args, callback) => callback(null, {output: {text: `hello ${args.input.name}`}});
