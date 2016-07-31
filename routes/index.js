var express = require('express');
var router = express.Router();
var randtoken = require('rand-token');

/* GET home page. */
router.get('/', function (req, res, next) {
    var token = randtoken.generate(32)
    req.session.token = token;
    res.render('index', {
        token: token,
        character: req.bot.character
    });
});

module.exports = router;
