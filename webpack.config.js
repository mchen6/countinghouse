var webpack = require('webpack');
var path = require('path');
var fs = require('fs');
var CopyWebpackPlugin = require('copy-webpack-plugin');
var JavaScriptObfuscator = require('webpack-obfuscator');
var nodeExternals = require('webpack-node-externals');
var UglifyJsPlugin = require('uglifyjs-webpack-plugin');
var chmod = require('chmod');

var packageJson = JSON.parse(fs.readFileSync(__dirname + '/package.json').toString());
packageJson.bin = 'mcpforge';
delete packageJson.scripts;
packageJson.devDependencies = {};
packageJson.optionalDependencies = {};
packageJson.repository = '';
packageJson.main = 'app.js';

fs.writeFileSync('./package-dist.json', JSON.stringify(packageJson, null, 2), 'utf-8');


module.exports = {
  mode: 'production',
  optimization: {
    minimizer: [
      // new UglifyJsPlugin(
      //   {
      //     uglifyOptions: {
      //       warnings: false,
      //       compress: {
      //         drop_console: false
      //       }
      //     }
      //   }
      // )
    ]
  },
  module: {
    rules: [
      // { test: /.*\.js$/,

      //       loader: StringReplacePlugin.replace({
      //           replacements: [
      //               {
      //                   pattern: /var.*McpForgeDevice.*\=.*require.*mcpforge-device\'\)\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*McpForgeError.*\=.*require.*mcpforge-error\'\)\.McpForgeError\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*DeviceError.*\=.*require.*mcpforge-error\'\)\.DeviceError\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               },
      //               {
      //                   pattern: /var.*McpForgeUtil.*\=.*require.*mcpforge-util\'\)\;/ig,
      //                   replacement: function (match, p1, offset, string) {
      //                       return '';
      //                   }
      //               }
      //           ]
      //       })
      // },
      // { test: require.resolve("./lib/mcpforge-util.js"), loader: "expose-loader?McpForgeUtil" },
      // { test: require.resolve("./lib/mcpforge-device.js"), loader: "expose-loader?McpForgeDevice"},
      // { test: require.resolve("./lib/mcpforge-error.js"), loader: "expose-loader?DeviceError" }
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
    new JavaScriptObfuscator({
        simplify: false,
        rotateUnicodeArray: true,
        disableConsoleOutput: false
    }, []),
    new CopyWebpackPlugin([
        { from: 'package-dist.json', to: 'package.json' },
//        { from: 'example', to: 'example' },
        { from: 'mcpforge-dist.sh', to: 'mcpforge', toType: 'file' }
    ])
  ]
}
