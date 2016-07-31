var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var session = require('express-session')

var routes = require('./routes/index');

var bot = require('./bot/main');

var app = express();

// use secure cookies on production
if (app.get('env') === 'production') {
    app.set('trust proxy', 1) // trust first proxy
    sessionConfig.cookie.secure = true // serve secure cookies
}

// session
app.use(session({
    name: 'pokegoslave.sid',
    //store: new mongoStore(options),
    secret: 'MGVhNTI5Y2QtZDU0YS00MzJmLWE4YmQtMDM1MTE3ODI4NTg2',
    resave: false,
    saveUninitialized: false,
    cookie: { path: '/', httpOnly: true, secure: false, maxAge: null }
}))

// socket.io
// listen socket.io for notification on port 3100
var io = require('socket.io')(3100);

// handle socket.io connection. store the socket referenced by user id.
io.sockets.on('connection', function (socket) {
    socket.emit('character', { character: bot.character });
    socket.emit('barriers', { barriers: bot.generateBarrier() });
});


// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// uncomment after placing your favicon in /public
app.use(favicon(path.join(__dirname, 'public', 'icons/favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// preload request
app.use(function (req, res, next) {
    req.bot = bot;
    next();
});

// routes
app.use('/', routes);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function (err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

bot.io = io;
bot.start();

module.exports = app;
