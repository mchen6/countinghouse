const events      = require('events');
const util        = require('util');
const Session   = require('./session');
const request   = require('postman-request');
const options   = require('./cli-options');

// appKey and billingKey answer two different questions and 6.0.0 lets them
// differ: appKey is "may this call happen" (userAuth, device ownership),
// billingKey is "who pays for it". A composing module keeps its own identity
// for authorization -- so callers do not need grants to the modules it calls
// internally -- while per-hop charges land on the real outer caller. When
// billingKey is absent it falls back to appKey, which is exactly the
// pre-split behaviour of one key doing both jobs.
function ServiceClient(cdifInterface, isRemoteService, isRemoteThread, appKey, deviceID, serviceID, billingKey) {
  this.cdifInterface  = cdifInterface;
  this.isRemote       = isRemoteService;        // remote http service
  this.isRemoteThread = isRemoteThread;   // remote thread service
  this.appKey         = appKey;
  this.billingKey     = (billingKey != null) ? billingKey : appKey;
  this.deviceID       = deviceID;
  this.serviceID      = serviceID;
  this.invoke         = this.invoke.bind(this);
  this.deviceBaseUrl  = null;
}

util.inherits(ServiceClient, events.EventEmitter);

//TODO: add client.on('servicedown', function() {...}) support

// ServiceClient.prototype.invoke = function(actionName, args, callback) {
ServiceClient.prototype.invoke = function(opts, callback) {
  if (typeof(callback) !== 'function')      return;
  if (typeof(opts) !== 'object')            return callback(new Error('opts must be object'));
  if (opts.actionName == null)              return callback(new Error('must specify actionName'));
  if (typeof(opts.actionName) !== 'string') return callback(new Error('actionName must be string'));
  if (opts.input == null)                   return callback(new Error('must specify input argument'));

  if (this.isRemote === true) {
    const postOpts = {
      url: `${this.deviceBaseUrl}/invoke-action`,
      headers: {
        'X-CH-Key': this.appKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
      },
      method: 'POST',
      json: {
        serviceID:  this.serviceID,
        actionName: opts.actionName,
        input:      opts.input
      }
    };
    //TODO: add request timeout support
    request(postOpts, (error, response, body) => {
      if (error != null) {
        return callback(error, null);
      }
      if (response.statusCode > 200) {
        return callback(new Error(body.message), null);
      }
      //body contain parsed JSON data with output field in it
      return callback(null, body);
    });
  } else {
    const args = {input: opts.input};

    if (this.isRemoteThread === true) {
      const dm = this.cdifInterface.deviceManager;
      // docs/direct-peer-channels-design.md section 3: this is the only
      // branch point in the whole feature -- everything else (external
      // API/semantics of ServiceClient.invoke itself: callback signature,
      // error shape, timeout behavior/codes) stays identical either way.
      // Flag off (default): existing main-thread-routed path, unchanged.
      if (options.directPeerChannels === true) {
        return dm.invokeActionViaPeerChannel(this.appKey, this.billingKey, this.deviceID, this.serviceID, opts.actionName, args, callback);
      }
      return dm.sendActionInvokeMessageToParent(this.appKey, this.billingKey, this.deviceID, this.serviceID, opts.actionName, args, callback);
    }

    const userAuth  = require('./user-auth');

    userAuth(null, null, this.deviceID, this.appKey, this.serviceID, opts.actionName, callback, (err, session) => {
      if (err != null) return callback(err, null);

        //set localInput field so this call can be logged by redis
      session.localInput = args;
      this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, opts.actionName, args, null, session);
    });
  }
}

// Subscription to service events. **The event subsystem was removed in
// 5.0.0** (socket.io/WebSocket servers, the event-sub/event-unsub/wss routes,
// Subscriber/WsSubscriber -- see MIGRATION.md), so there is nothing for this
// to subscribe to and `callback` is never invoked.
//
// Kept as a no-op rather than deleted, deliberately: it is module-facing API,
// and deleting it would turn a silent no-op into a TypeError for any module
// that calls it. Its behaviour is unchanged from before 5.0.0 -- this method
// never delivered an event even when the subsystem existed, because
// `Subscriber.prototype.publish` was defined but called from nowhere and
// `subscribeEvent` registered no listener. A caller that was "working" against
// this was already receiving nothing.
//
// If event delivery is ever reinstated, MCP's own server-to-client
// notifications are the likely shape, not a second socket.io server; the
// authorization bar the old channel did meet is recorded in the event-channel
// row of docs/cross-cutting-matrix.md.
ServiceClient.prototype.subscribe = function(callback) {

}

module.exports = ServiceClient;