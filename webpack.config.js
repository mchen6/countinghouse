var webpack = require('webpack');
var path = require('path');
var fs = require('fs');
var CopyWebpackPlugin = require('copy-webpack-plugin');
var JavaScriptObfuscator = require('webpack-obfuscator');
var nodeExternals = require('webpack-node-externals');
var UglifyJsPlugin = require('uglifyjs-webpack-plugin');
var chmod = require('chmod');

var packageJson = JSON.parse(fs.readFileSync(__dirname + '/package.json').toString());
packageJson.bin = 'cdif';
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
      // { test: require.resolve("./lib/cdif-util.js"), loader: "expose-loader?CdifUtil" },
      // { test: require.resolve("./lib/cdif-device.js"), loader: "expose-loader?CdifDevice"},
      // { test: require.resolve("./lib/cdif-error.js"), loader: "expose-loader?DeviceError" }
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
        { from: 'cdif-dist.sh', to: 'cdif', toType: 'file' }
    ])
  ]
}
