var webpack = require('webpack');
var path = require('path');
var fs = require('fs');
var CopyWebpackPlugin = require('copy-webpack-plugin');
var nodeExternals = require('webpack-node-externals');
var chmod = require('chmod');

var packageJson = JSON.parse(fs.readFileSync(__dirname + '/package.json').toString());
packageJson.bin = 'countinghouse';
delete packageJson.scripts;
packageJson.devDependencies = {};
packageJson.optionalDependencies = {};
packageJson.repository = '';
packageJson.main = 'app.js';

fs.writeFileSync('./package-dist.json', JSON.stringify(packageJson, null, 2), 'utf-8');


module.exports = {
  mode: 'production',
  module: {
    rules: [
      // { test: /.*\.js$/,

      //       loader: StringReplacePlugin.replace({
      //           replacements: [
      //               {
      //                   pattern: /var.*CHDevice.*\=.*require.*countinghouse-device\'\)\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*CHError.*\=.*require.*countinghouse-error\'\)\.CHError\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*DeviceError.*\=.*require.*countinghouse-error\'\)\.DeviceError\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*CHUtil.*\=.*require.*countinghouse-util\'\)\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               }
      //           ]
      //       })
      // },
      // { test: require.resolve("./lib/countinghouse-util.js"), loader: "expose-loader?CHUtil" },
      // { test: require.resolve("./lib/countinghouse-device.js"), loader: "expose-loader?CHDevice"},
      // { test: require.resolve("./lib/countinghouse-error.js"), loader: "expose-loader?DeviceError" }
    ]
  },
  entry: {
    'app':     path.join(__dirname, '/framework.js'),
    'sandbox': path.join(__dirname, '/lib/sandbox.js')
  },
  target: 'node',
  externals: [nodeExternals()],
  node: {
    __dirname: false
  },
  output: {
    path: path.join(__dirname, 'build'),
    filename: "[name].js"
  },
  plugins: [
    new CopyWebpackPlugin([
        { from: 'package-dist.json', to: 'package.json' },
//        { from: 'example', to: 'example' },
        { from: 'countinghouse-dist.sh', to: 'countinghouse', toType: 'file' }
    ])
  ]
}
