var express = require('express');
var path = require('path');
var server = require('socket.io');
var pty = require('pty.js');
var fs = require('fs');

let globalsshuser = process.env.SSHUSER || '';
let sshhost = process.env.SSHHOST || 'localhost';
let sshport = process.env.SSHPOST || 22;
let sshauth = process.env.SSHAUTH || 'password';

// const opts = require('optimist')
//   .options({
//     sslkey: {
//       demand     : false,
//       description: 'path to SSL key',
//     },
//     sslcert: {
//       demand     : false,
//       description: 'path to SSL certificate',
//     },
//     sshhost: {
//       demand     : false,
//       description: 'ssh server host',
//     },
//     sshport: {
//       demand     : false,
//       description: 'ssh server port',
//     },
//     sshuser: {
//       demand     : false,
//       description: 'ssh user',
//     },
//     sshauth: {
//       demand     : false,
//       description: 'defaults to "password", you can use "publickey,password" instead',
//     },
//     port: {
//       demand     : false,
//       alias      : 'p',
//       description: 'wetty listen port',
//     },
//   })
//   .boolean('allow_discovery').argv;

// let runhttps = process.env.HTTPS || false;
// let sshhost = process.env.SSHHOST || 'localhost';
// let sshauth = process.env.SSHAUTH || 'password';
// let sshport = process.env.SSHPOST || 22;
// let port = process.env.PORT || 3000;

// if (opts.sshport) {
//   sshport = opts.sshport;
// }

// if (opts.sshhost) {
//   sshhost = opts.sshhost;
// }

// if (opts.sshauth) {
//   sshauth = opts.sshauth;
// }

// if (opts.sshuser) {
//   globalsshuser = opts.sshuser;
// }

// if (opts.port) {
//   port = opts.port;
// }

// if (opts.sslkey && opts.sslcert) {
//   runhttps = true;
//   opts['ssl'] = {};
//   opts.ssl['key'] = fs.readFileSync(path.resolve(opts.sslkey));
//   opts.ssl['cert'] = fs.readFileSync(path.resolve(opts.sslcert));
// }

// process.on('uncaughtException', e => {
//   console.error(`Error: ${e}`);
// });

module.exports = function(httpserv, app) {
  app.use(require('serve-favicon')(`${__dirname}/public/favicon.ico`));
  // For using wetty at /wetty on a vhost
  app.get('/wetty/ssh/:user', (req, res) => {
    res.sendfile(`${__dirname}/public/wetty/index.html`);
  });
  app.get('/wetty/', (req, res) => {
    res.sendfile(`${__dirname}/public/wetty/index.html`);
  });
  // For using wetty on a vhost by itself
  app.get('/ssh/:user', (req, res) => {
    res.sendfile(`${__dirname}/public/wetty/index.html`);
  });
  app.get('/', (req, res) => {
    res.sendfile(`${__dirname}/public/wetty/index.html`);
  });
  // For serving css and javascript
  app.use('/', express.static(path.join(__dirname, 'public')));

  const io = server(httpserv, { path: '/wetty/socket.io' });
  io.on('connection', socket => {
    let sshuser = '';
    const request = socket.request;
    console.log(`${new Date()} Connection accepted.`);
    const match = request.headers.referer.match('.+/ssh/.+$');
    if (match) {
      sshuser = `${match[0].split('/ssh/').pop()}@`;
    } else if (globalsshuser) {
      sshuser = `${globalsshuser}@`;
    }
    let term;
    if (process.getuid() === 0 && sshhost === 'localhost') {
      // this is the path when cdif running inside docker instance
      term = pty.spawn('/bin/login', ['-f', 'term'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
      });
    } else if (sshuser) {
      term = pty.spawn('ssh', [sshuser + sshhost, '-p', sshport, '-o', `PreferredAuthentications=${sshauth}`], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
      });
    } else {
      //this is the path when running in normal mode
      term = pty.spawn('ssh', [sshhost, '-p', sshport, '-o', `PreferredAuthentications=${sshauth}`], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
      });
    }

    console.log(`${new Date()} PID=${term.pid} STARTED on behalf of user=${sshuser}`);
    term.on('data', data => {
      socket.emit('output', data);
    });
    term.on('exit', code => {
      console.log(`${new Date()} PID=${term.pid} ENDED`);
      socket.emit('logout');
    });
    socket.on('resize', ({ col, row }) => {
      term.resize(col, row);
    });
    socket.on('input', data => {
      term.write(data);
    });
    socket.on('disconnect', () => {
      term.end();
    });
  });
}


