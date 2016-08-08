var express = require('express');
var router = express.Router();
var randtoken = require('rand-token');

// settings must be var because we inject second layer setting item on the fly
const fs = require('fs');
const Settings = JSON.parse(fs.readFileSync(__dirname + '/../bot/settings.json', 'utf8'));

/* GET home page. */
router.get('/', function (req, res, next) {
    var token = randtoken.generate(32)
    req.session.token = token;
    res.render('index', {
        token: token,
        character: req.bot.character,
        loopInterval: Settings.loopInterval
    });
});

module.exports = router;
