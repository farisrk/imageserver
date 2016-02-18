var express = require('express'),
    path = require('path'),
    fs = require('fs'),
    sys = require("sys"),
    os = require('os'),
    formidable = require('formidable'),
    hogan = require('hogan-express'),
    gm = require('gm'),
    util = require('util'),
    memwatch = require('memwatch'),
    toobusy = require('toobusy'),
    Utils = require('../anf-libs/libs/Utils'),
    Log = require('../anf-libs/libs/Logger'),
    AccessLog = require('../anf-libs/routers/AccessLog');
toobusy.maxLag(40);

var environment = (process.env.NODE_ENV || 'development');
var configFile = './config/' + environment + '.json';
require('../anf-libs/libs/Configuration').Configuration.init({
    config : [false, "Configuration file", "string", configFile],
    debug : [false, "Run in debug mode", "boolean", false],
    log : ["l", "Log file path", "string", "./logs"],
    port : ["p", "Listening port", "number", 9000]
}, main);

function main(options) {
if (options.debug) { // debug mode (dev)
    Log.add("debug", new Log.StdoutLog("DEBUG", Log.Colors.Green));
    Log.add("error", new Log.StdoutLog("ERROR", Log.Colors.Red));
} else {
    Log.init(Utils.path(__dirname, options.log), options.port, options.rotate);
    if (util.format) console.log = function(){ Log.debug(util.format.apply(util, arguments)) };
    else console.log = function(){ Log.debug.apply(Log, arguments) };

    process.on("uncaughtException", function(e) {
        var description = e.stack;
        Log.error("UNCAUGHT: " + sys.inspect(e) + "\nSTACK: " + description);
    });
}
// memmory watch handlers
memwatch.on('leak', function(info) {
    Log.error('memory leak notification:' + JSON.stringify(info));
});
memwatch.on('stats', function(data) {
    Log.debug('memory usage after GC:' + JSON.stringify(data));
});

var app = express();
app.set('views', path.join(__dirname, 'views'));
app.engine('html', hogan);
app.set('view engine', 'html');
app.use(express.static(path.join(__dirname, 'public')));
app.set('port', options.port);
app.set('host', options.host);
app.set('imageContainer', options.imageRepo);
app.set('uploadDir', options.uploadDir);
app.set('workingDir', options.workDir);

app.use(function(req, res, next) {
    // var isItBusy = toobusy();
    // Log.error('is it busy? ' + JSON.stringify(isItBusy))
    if (!toobusy()) return next();
    Log.error("server is busy!!!!");
    res.status(503).send("Server is busy")
});
app.use(AccessLog.router(AccessLog.format));

// app.use(function(req, res, next) {
//     console.log("incoming request: ", req.url);
//     next();
// });

require('./routes/im')(app, formidable, fs, os, gm, options);

Log.debug("Running environment: " + options.config.match(/config\/([a-z]+)\.json$/)[1]);
app.listen(options.port, function() {
    Log.debug('Server listening on port ' + options.port);
});

}
