var ModuleManager = require('./module-manager');
var RouteManager = require('./lib/route-manager');
var argv = require('minimist')(process.argv.slice(1));

var allowDiscover = (argv.allowDiscover === true) ? true : false;

var mm = new ModuleManager(allowDiscover);
var routeManager = new RouteManager(mm, allowDiscover);


routeManager.installRoutes();
mm.loadModules();

// forever to restart on crash?
