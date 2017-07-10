var webpack = require('webpack');
var path = require('path');
var fs = require('fs');
var CopyWebpackPlugin = require('copy-webpack-plugin');
var StringReplacePlugin = require("string-replace-webpack-plugin");
var JavaScriptObfuscator = require('webpack-obfuscator');
// var WebpackJsObfuscator = require('webpack-js-obfuscator');

var chmod = require('chmod');

var nodeModules = {};
fs.readdirSync('node_modules')
  .filter(function(x) {
    return ['.bin'].indexOf(x) === -1;
  })
  .forEach(function(mod) {
    nodeModules[mod] = 'commonjs ' + mod;
  });

module.exports = {
  module: {
    rules: [
      // { test: /.*\.js$/,

      //       loader: StringReplacePlugin.replace({
      //           replacements: [
      //               {
      //                   pattern: /var.*CdifDevice.*\=.*require.*cdif-device\'\)\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*CdifError.*\=.*require.*cdif-error\'\)\.CdifError\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*DeviceError.*\=.*require.*cdif-error\'\)\.DeviceError\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*CdifUtil.*\=.*require.*cdif-util\'\)\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               }
      //           ]
      //       })
      // },
      { test: require.resolve("./lib/cdif-util.js"), loader: "expose-loader?CdifUtil" },
      { test: require.resolve("./lib/cdif-device.js"), loader: "expose-loader?CdifDevice"},
      { test: require.resolve("./lib/cdif-error.js"), loader: "expose-loader?DeviceError" }
    ]
  },
  entry: './framework.js',
  target: 'node',
  node: {
    __dirname: false
  },
  output: {
    path: path.join(__dirname, 'build'),
    filename: 'app.js'
  },
  externals: nodeModules,
  plugins: [
    new webpack.optimize.UglifyJsPlugin({
        compress: {
            warnings: false,
            drop_console: false
        }
    }),
    new JavaScriptObfuscator({
        rotateUnicodeArray: true,
        disableConsoleOutput: false
    }, []),
    // new WebpackJsObfuscator({}, []),
    new CopyWebpackPlugin([
        { from: 'wetty', to: 'wetty' },
        { from: 'package-dist.json', to: 'package.json' },
        { from: 'README.md', to: 'README.md' },
        { from: 'example', to: 'example' },
        { from: 'cdif-dist.sh', to: 'cdif', toType: 'file' }
    ])
  ]
}
